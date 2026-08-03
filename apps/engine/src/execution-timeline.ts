import {
  classifyTransition,
  type ExecutionMode, type ExecutionTimelineState, type LatencyStage, type OrderSide,
  type Prob6, type QueueEstimateMethod, type Shares6, type TimeInForce,
} from "@b5p/domain";
import { newId } from "@b5p/domain/ids";
import type { BookState } from "@b5p/strategy";
import type { BufferedOrderAttempt, ExecutionPersistence } from "./execution-persistence";
import { logger } from "./log";

/**
 * Execution-quality timeline emitter (plan item 1b).
 *
 * Emits an ExecutionTimelineEvent at every state transition with both UTC ms
 * and the process monotonic clock, threading correlationId -> intentId ->
 * attemptId. All emission is synchronous in-memory buffering; persistence is
 * background-flushed via ExecutionPersistence and can never block or reorder
 * the trading hot path.
 *
 * Transition legality is enforced with the domain state machine:
 *  - ADVANCE   -> event recorded
 *  - DUPLICATE -> idempotent no-op (duplicate exchange ack et al.)
 *  - INVALID   -> logged, never applied
 */

export interface TimelineContext {
  correlationId: string;
  intentId: string; // pre-generated; exists before the order_intents row
  mode: ExecutionMode;
}

interface IntentTrack {
  ctx: TimelineContext;
  state: ExecutionTimelineState | null;
  attemptId: string | null;
  seq: number;
}

export class ExecutionTimeline {
  private tracks = new Map<string, IntentTrack>(); // intentId -> track
  private attempts = new Map<string, BufferedOrderAttempt>(); // attemptId -> buffered record
  private attemptIdByOrderId = new Map<string, string>();

  constructor(
    private readonly persistence: ExecutionPersistence,
    private readonly configVersion: () => number,
  ) {}

  begin(ctx: TimelineContext): void {
    if (!this.tracks.has(ctx.intentId)) {
      this.tracks.set(ctx.intentId, { ctx, state: null, attemptId: null, seq: 0 });
    }
  }

  stateOf(intentId: string): ExecutionTimelineState | null {
    return this.tracks.get(intentId)?.state ?? null;
  }

  /**
   * Attempt a state transition; returns true when applied (ADVANCE), false on
   * DUPLICATE (idempotent replay) or INVALID (logged).
   */
  transition(intentId: string, to: ExecutionTimelineState, opts?: {
    reason?: string;
    detail?: Record<string, unknown>;
    bookToken?: string | null;
    utcMs?: number;
  }): boolean {
    const t = this.tracks.get(intentId);
    if (!t) {
      logger.warn("timeline transition for unknown intent", { intentId, to });
      return false;
    }
    if (t.state !== null) {
      const cls = classifyTransition(t.state, to);
      if (cls === "DUPLICATE") return false;
      if (cls === "INVALID") {
        logger.error("invalid execution-timeline transition suppressed", { intentId, from: t.state, to, reason: opts?.reason });
        return false;
      }
    } else if (to !== "DECISION_SNAPSHOT") {
      logger.error("execution timeline must start at DECISION_SNAPSHOT", { intentId, to });
      return false;
    }
    t.state = to;
    t.seq++;
    const detail: Record<string, unknown> = { seq: t.seq, ...(opts?.detail ?? {}) };
    if (opts?.reason !== undefined) detail.reason = opts.reason;
    this.persistence.addEvent({
      id: newId(),
      correlationId: t.ctx.correlationId,
      intentId,
      attemptId: t.attemptId,
      state: to,
      tsMs: opts?.utcMs ?? Date.now(),
      monoNs: monotonicNs(),
      bookToken: opts?.bookToken ?? null,
      mode: t.ctx.mode,
      detail,
      configVersion: this.configVersion(),
    });
    const a = t.attemptId ? this.attempts.get(t.attemptId) : undefined;
    if (a) {
      a.status = to;
      a.updatedAtMs = opts?.utcMs ?? Date.now();
      this.persistence.upsertAttempt(a);
    }
    return true;
  }

  /** Capture the current L2 book; returns a token referencable by later rows. */
  captureBook(book: BookState | null, marketId: string): string | null {
    if (!book || book.receivedTsMs === 0) return null;
    const token = newId();
    this.persistence.addBookSnapshot({
      token,
      marketId,
      tokenId: book.tokenId,
      bids: book.sortedBids().map((l) => [l.price.toString(), l.size.toString()] as [string, string]),
      asks: book.sortedAsks().map((l) => [l.price.toString(), l.size.toString()] as [string, string]),
      sourceTsMs: book.sourceTsMs,
      receivedTsMs: book.receivedTsMs,
    });
    return token;
  }

  /** Create attempt #n under an intent. requestHash must cover the exact request payload. */
  beginAttempt(args: {
    intentId: string;
    attemptNumber: number;
    requestHash: string;
    tokenId: string;
    side: OrderSide;
    price6: Prob6;
    size6: Shares6;
    timeInForce: TimeInForce;
    postOnly: boolean;
    decisionBookToken: string | null;
    nowMs: number;
  }): string | null {
    const t = this.tracks.get(args.intentId);
    if (!t) return null;
    const attemptId = newId();
    const rec: BufferedOrderAttempt = {
      id: attemptId,
      correlationId: t.ctx.correlationId,
      intentId: args.intentId,
      attemptNumber: args.attemptNumber,
      requestHash: args.requestHash,
      tokenId: args.tokenId,
      side: args.side,
      price6: args.price6,
      size6: args.size6,
      remaining6: args.size6,
      timeInForce: args.timeInForce,
      postOnly: args.postOnly,
      status: t.state ?? "RISK_APPROVED",
      decisionBookToken: args.decisionBookToken,
      sendBookToken: null,
      ackBookToken: null,
      fillBookToken: null,
      createdAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
      configVersion: this.configVersion(),
    };
    t.attemptId = attemptId;
    this.attempts.set(attemptId, rec);
    this.persistence.upsertAttempt(rec);
    return attemptId;
  }

  bindOrder(orderId: string, attemptId: string): void {
    this.attemptIdByOrderId.set(orderId, attemptId);
  }

  attemptForOrder(orderId: string): string | null {
    return this.attemptIdByOrderId.get(orderId) ?? null;
  }

  intentForAttempt(attemptId: string): string | null {
    return this.attempts.get(attemptId)?.intentId ?? null;
  }

  attachSnapshot(attemptId: string, kind: "send" | "ack" | "fill", token: string | null): void {
    if (token === null) return;
    const a = this.attempts.get(attemptId);
    if (!a) return;
    if (kind === "send") a.sendBookToken = token;
    else if (kind === "ack") a.ackBookToken = token;
    else a.fillBookToken = token;
    this.persistence.upsertAttempt(a);
  }

  /** Reduce attempt remaining size on a (partial) fill. */
  recordAttemptFill(attemptId: string, shares6: Shares6, nowMs: number): void {
    const a = this.attempts.get(attemptId);
    if (!a) return;
    a.remaining6 = a.remaining6 > shares6 ? a.remaining6 - shares6 : 0n;
    a.updatedAtMs = nowMs;
    this.persistence.upsertAttempt(a);
  }

  latency(args: {
    correlationId: string;
    intentId: string | null;
    attemptId: string | null;
    stage: LatencyStage;
    durationUs: number;
    mode: ExecutionMode;
    nowMs: number;
  }): void {
    this.persistence.addLatency({
      id: newId(),
      correlationId: args.correlationId,
      intentId: args.intentId,
      attemptId: args.attemptId,
      stage: args.stage,
      durationUs: Math.max(0, Math.round(args.durationUs)),
      mode: args.mode,
      tsMs: args.nowMs,
      configVersion: this.configVersion(),
    });
  }

  queueEstimate(args: {
    correlationId: string;
    attemptId: string;
    tokenId: string;
    price6: Prob6;
    aheadShares6: Shares6;
    method: QueueEstimateMethod;
    nowMs: number;
  }): void {
    this.persistence.addQueueEstimate({
      id: newId(),
      correlationId: args.correlationId,
      attemptId: args.attemptId,
      tokenId: args.tokenId,
      price6: args.price6,
      aheadShares6: args.aheadShares6,
      method: args.method,
      tsMs: args.nowMs,
      configVersion: this.configVersion(),
    });
  }

  requestFlush(): void {
    this.persistence.requestFlush();
  }

  /** Drain everything (tests / shutdown). */
  async settle(): Promise<void> {
    await this.persistence.settle();
  }
}

export function monotonicNs(): bigint {
  return process.hrtime.bigint();
}

export function durationUs(startNs: bigint, endNs: bigint): number {
  return Number((endNs - startNs) / 1000n);
}
