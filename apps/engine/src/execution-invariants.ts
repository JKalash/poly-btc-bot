import type { Shares6 } from "@b5p/domain";

/**
 * Execution invariants for the order path (paper + live), enforced per intent:
 *
 *  1. ONE in-flight mutation (submit/replace/cancel) per intent at a time.
 *  2. Remaining-size-aware retries: no attempt may be authorized for more than
 *     the approved remaining size (approved shares minus everything filled).
 *  3. NO retry after UNKNOWN_OUTCOME until balances are reconciled.
 *  4. No new attempt past the entry cutoff.
 *  5. Duplicate exchange acks are idempotent by requestHash/attemptId: the
 *     second delivery must never create additional exposure.
 *
 * Pure in-memory logic — no I/O — so it is trivially hot-path safe and
 * property-testable.
 */

export type GuardRefusal =
  | "UNKNOWN_OUTCOME_UNRECONCILED"
  | "MUTATION_IN_FLIGHT"
  | "EXCEEDS_REMAINING"
  | "PAST_ENTRY_CUTOFF"
  | "NON_POSITIVE_SIZE";

export interface GuardResult {
  ok: boolean;
  refusal?: GuardRefusal;
  detail?: string;
}

export class IntentExecutionGuard {
  readonly intentId: string;
  readonly decisionId: string;
  readonly correlationId: string;
  /** Total shares the risk engine approved for this intent (micro-shares). */
  readonly approvedShares6: Shares6;
  /** Entry cutoff: no attempt may start at/after this timestamp. */
  readonly entryCutoffMs: number;

  private filled6: Shares6 = 0n;
  private inFlightAttemptId: string | null = null;
  private unknownOutcome = false;
  private seenAckKeys = new Set<string>();
  attemptCount = 0;

  constructor(args: {
    intentId: string;
    decisionId: string;
    correlationId: string;
    approvedShares6: Shares6;
    entryCutoffMs: number;
  }) {
    this.intentId = args.intentId;
    this.decisionId = args.decisionId;
    this.correlationId = args.correlationId;
    this.approvedShares6 = args.approvedShares6;
    this.entryCutoffMs = args.entryCutoffMs;
  }

  remaining6(): Shares6 {
    const r = this.approvedShares6 - this.filled6;
    return r > 0n ? r : 0n;
  }

  totalFilled6(): Shares6 {
    return this.filled6;
  }

  get hasUnknownOutcome(): boolean {
    return this.unknownOutcome;
  }

  /**
   * Authorize a new order attempt of `size6` at `nowMs`. Enforces invariants
   * 2, 3 and 4. Does NOT take the mutation lock — call beginMutation next.
   */
  authorizeAttempt(size6: Shares6, nowMs: number): GuardResult {
    if (this.unknownOutcome) {
      return { ok: false, refusal: "UNKNOWN_OUTCOME_UNRECONCILED", detail: "retries blocked until BALANCE_RECONCILED" };
    }
    if (nowMs >= this.entryCutoffMs) {
      return { ok: false, refusal: "PAST_ENTRY_CUTOFF", detail: `now=${nowMs} cutoff=${this.entryCutoffMs}` };
    }
    if (size6 <= 0n) return { ok: false, refusal: "NON_POSITIVE_SIZE" };
    if (size6 > this.remaining6()) {
      return { ok: false, refusal: "EXCEEDS_REMAINING", detail: `requested=${size6} remaining=${this.remaining6()}` };
    }
    this.attemptCount++;
    return { ok: true };
  }

  /** Invariant 1: one in-flight mutation per intent. */
  beginMutation(attemptId: string): GuardResult {
    if (this.unknownOutcome) {
      return { ok: false, refusal: "UNKNOWN_OUTCOME_UNRECONCILED" };
    }
    if (this.inFlightAttemptId !== null && this.inFlightAttemptId !== attemptId) {
      return { ok: false, refusal: "MUTATION_IN_FLIGHT", detail: this.inFlightAttemptId };
    }
    this.inFlightAttemptId = attemptId;
    return { ok: true };
  }

  endMutation(attemptId: string): void {
    if (this.inFlightAttemptId === attemptId) this.inFlightAttemptId = null;
  }

  /**
   * Invariant 5: register an exchange ack (or fill delivery) by its
   * requestHash/attemptId key. Returns true the FIRST time only; duplicate
   * deliveries return false and must not create exposure.
   */
  registerAck(key: string): boolean {
    if (this.seenAckKeys.has(key)) return false;
    this.seenAckKeys.add(key);
    return true;
  }

  /**
   * Record a fill against the approved total. Returns the shares actually
   * accepted (clamped so cumulative fills never exceed the approved size);
   * a non-zero clamp indicates an upstream accounting bug and is surfaced
   * by the caller.
   */
  recordFill(shares6: Shares6): { accepted6: Shares6; clamped: boolean } {
    const room = this.remaining6();
    const accepted = shares6 > room ? room : shares6;
    this.filled6 += accepted;
    return { accepted6: accepted, clamped: accepted !== shares6 };
  }

  /** Invariant 3: mark the outcome unknown — blocks all mutations/attempts. */
  markUnknownOutcome(): void {
    this.unknownOutcome = true;
    this.inFlightAttemptId = null;
  }

  /** Balance reconciliation observed — retries (new attempts) allowed again. */
  markBalanceReconciled(): void {
    this.unknownOutcome = false;
  }
}

/** Registry of per-intent guards, keyed by intentId. */
export class ExecutionGuardRegistry {
  private guards = new Map<string, IntentExecutionGuard>();

  create(args: ConstructorParameters<typeof IntentExecutionGuard>[0]): IntentExecutionGuard {
    const g = new IntentExecutionGuard(args);
    this.guards.set(args.intentId, g);
    if (this.guards.size > 512) {
      const first = this.guards.keys().next();
      if (!first.done) this.guards.delete(first.value);
    }
    return g;
  }

  get(intentId: string): IntentExecutionGuard | null {
    return this.guards.get(intentId) ?? null;
  }

  /** All guards currently blocked on UNKNOWN_OUTCOME. */
  unreconciled(): IntentExecutionGuard[] {
    return [...this.guards.values()].filter((g) => g.hasUnknownOutcome);
  }
}
