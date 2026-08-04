import { canonicalObjectHash, type PairEventId, type PairGroupId } from "@b5p/pair-execution";

export type PairControlledEffectKind = "INITIAL" | "RECOVERY" | "MERGE";
export type PairControlledEffectState =
  | "PENDING"
  | "CLAIMED"
  | "SUCCEEDED"
  | "TERMINAL_REJECTED"
  | "OUTCOME_UNKNOWN"
  | "CANCELED_UNCLAIMED"
  | "EXPIRED_UNCLAIMED";

export interface PairControlledEffectSnapshot {
  readonly effectId: string;
  readonly kind: PairControlledEffectKind;
  readonly outcome?: "UP" | "DOWN";
  readonly state: PairControlledEffectState;
  readonly claimToken: string | null;
  readonly deadlineMs: number;
  readonly resultEvidenceId: string | null;
  readonly increasesExposure: boolean;
}

export interface PairControlGroupSnapshot {
  readonly groupId: string;
  readonly state: string;
  readonly haltedAtMs: number | null;
  readonly haltReason: string | null;
  readonly reservedCash6: bigint;
  readonly upHeldShares6: bigint;
  readonly downHeldShares6: bigint;
  readonly evidenceKeys: readonly string[];
  readonly effects: readonly PairControlledEffectSnapshot[];
}

export class PairHaltWatchdogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairHaltWatchdogError";
  }
}

export interface PairControlFact {
  readonly eventId: PairEventId;
  readonly groupId: PairGroupId;
  readonly causationId: string;
  readonly occurredAtMs: number;
  readonly type: "PAIR_HALTED" | "PAIR_RECONCILIATION_MISMATCH";
  readonly payload: { readonly reason: string } | { readonly diffCodes: readonly string[] };
}

export interface PairEffectControlUpdate {
  readonly effectId: string;
  readonly expectedState: "PENDING";
  readonly expectedClaimToken: null;
  readonly nextState: "CANCELED_UNCLAIMED" | "EXPIRED_UNCLAIMED";
  readonly reason: string;
  readonly updatedAtMs: number;
}

export type PairHaltPlan =
  | {
      readonly kind: "ALREADY_HALTED";
      readonly groupId: string;
      readonly originalHaltedAtMs: number;
      readonly originalReason: string;
      readonly pairGroupCreationAllowed: false;
      readonly exposureIncreasingEffectsAllowed: false;
      readonly effectUpdates: readonly [];
      readonly facts: readonly [];
      readonly newEffects: readonly [];
      readonly planHash: string;
    }
  | {
      readonly kind: "HALT_COMMIT_REQUIRED";
      readonly groupId: string;
      readonly haltedAtMs: number;
      readonly reason: string;
      readonly pairGroupCreationAllowed: false;
      readonly exposureIncreasingEffectsAllowed: false;
      readonly effectUpdates: readonly PairEffectControlUpdate[];
      readonly facts: readonly [PairControlFact];
      readonly newEffects: readonly [];
      readonly retained: Readonly<{
        reservedCash6: bigint;
        upHeldShares6: bigint;
        downHeldShares6: bigint;
        evidenceKeys: readonly string[];
      }>;
      readonly continuations: readonly ["INGEST_LATE_EVIDENCE", "APPLY_AUTHORITATIVE_RESOLUTION", "RECONCILE"];
      readonly planHash: string;
    };

export interface PairHaltCommitPort {
  commitHaltPlan(plan: PairHaltPlan): Promise<{ readonly kind: "COMMITTED" } | { readonly kind: "DUPLICATE"; readonly planHash: string }>;
}

function assertText(value: string, label: string): void {
  if (value.trim().length === 0) throw new PairHaltWatchdogError(`${label} must be non-empty`);
}

function assertTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new PairHaltWatchdogError(`${label} must be a non-negative safe integer`);
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${canonicalObjectHash(value).slice(0, 32)}`;
}

function checkedDeadline(startMs: number, timeoutMs: number): number {
  const deadline = startMs + timeoutMs;
  if (!Number.isSafeInteger(deadline)) throw new PairHaltWatchdogError("unknown timeout deadline exceeds safe integer range");
  return deadline;
}

function validateGroup(group: PairControlGroupSnapshot): void {
  assertText(group.groupId, "groupId");
  if (group.reservedCash6 < 0n || group.upHeldShares6 < 0n || group.downHeldShares6 < 0n) {
    throw new PairHaltWatchdogError("retained reservation and holdings must be non-negative");
  }
  const ids = new Set<string>();
  for (const effect of group.effects) {
    assertText(effect.effectId, "effectId");
    assertTime(effect.deadlineMs, "effect deadline");
    if (ids.has(effect.effectId)) throw new PairHaltWatchdogError(`duplicate effect snapshot ${effect.effectId}`);
    ids.add(effect.effectId);
    if (effect.state === "PENDING" && effect.claimToken !== null) {
      throw new PairHaltWatchdogError(`pending effect ${effect.effectId} cannot carry a claim token`);
    }
    if (effect.state === "CLAIMED" && effect.claimToken === null) {
      throw new PairHaltWatchdogError(`claimed effect ${effect.effectId} lacks a claim token`);
    }
  }
}

/** Orthogonal halt: preserve truth, cancel only compare-and-swap-safe rows. */
export function planPairHalt(input: {
  readonly group: PairControlGroupSnapshot;
  readonly nowMs: number;
  readonly reason: string;
}): PairHaltPlan {
  validateGroup(input.group);
  assertTime(input.nowMs, "halt time");
  assertText(input.reason, "halt reason");
  if (input.group.haltedAtMs !== null) {
    assertTime(input.group.haltedAtMs, "existing halt time");
    if (input.group.haltReason === null) throw new PairHaltWatchdogError("halted group is missing its durable reason");
    const material = {
      kind: "ALREADY_HALTED" as const,
      groupId: input.group.groupId,
      originalHaltedAtMs: input.group.haltedAtMs,
      originalReason: input.group.haltReason,
      pairGroupCreationAllowed: false as const,
      exposureIncreasingEffectsAllowed: false as const,
      effectUpdates: Object.freeze([]) as readonly [],
      facts: Object.freeze([]) as readonly [],
      newEffects: Object.freeze([]) as readonly [],
    };
    return Object.freeze({ ...material, planHash: canonicalObjectHash(material) });
  }
  const effectUpdates = Object.freeze(input.group.effects
    .filter((effect) => effect.state === "PENDING" && effect.claimToken === null)
    .sort((left, right) => left.effectId.localeCompare(right.effectId))
    .map((effect) => Object.freeze({
      effectId: effect.effectId,
      expectedState: "PENDING" as const,
      expectedClaimToken: null,
      nextState: "CANCELED_UNCLAIMED" as const,
      reason: `PAIR_HALTED:${input.reason}`,
      updatedAtMs: input.nowMs,
    })));
  const groupId = input.group.groupId as PairGroupId;
  const identity = { schemaVersion: 1, groupId, haltedAtMs: input.nowMs, reason: input.reason };
  const haltFact: PairControlFact = Object.freeze({
    eventId: stableId("pevt", identity) as PairEventId,
    groupId,
    causationId: stableId("pcause", identity),
    occurredAtMs: input.nowMs,
    type: "PAIR_HALTED",
    payload: Object.freeze({ reason: input.reason }),
  });
  const retained = Object.freeze({
    reservedCash6: input.group.reservedCash6,
    upHeldShares6: input.group.upHeldShares6,
    downHeldShares6: input.group.downHeldShares6,
    evidenceKeys: Object.freeze(input.group.evidenceKeys.slice()),
  });
  const material = {
    kind: "HALT_COMMIT_REQUIRED" as const,
    groupId: input.group.groupId,
    haltedAtMs: input.nowMs,
    reason: input.reason,
    pairGroupCreationAllowed: false as const,
    exposureIncreasingEffectsAllowed: false as const,
    effectUpdates,
    facts: Object.freeze([haltFact] as const),
    newEffects: Object.freeze([]) as readonly [],
    retained,
    continuations: Object.freeze(["INGEST_LATE_EVIDENCE", "APPLY_AUTHORITATIVE_RESOLUTION", "RECONCILE"] as const),
  };
  return Object.freeze({ ...material, planHash: canonicalObjectHash(material) });
}

export async function commitPairHalt(
  input: { readonly group: PairControlGroupSnapshot; readonly nowMs: number; readonly reason: string },
  store: PairHaltCommitPort,
): Promise<PairHaltPlan> {
  const plan = planPairHalt(input);
  if (plan.kind === "ALREADY_HALTED") return plan;
  const result = await store.commitHaltPlan(plan);
  if (result.kind === "DUPLICATE" && result.planHash !== plan.planHash) {
    throw new PairHaltWatchdogError("halt idempotency collision: stored plan hash differs");
  }
  return plan;
}

/** Expiry is strict after the inclusive dispatch deadline and only unclaimed. */
export function planUnclaimedEffectExpiry(input: {
  readonly effects: readonly PairControlledEffectSnapshot[];
  readonly nowMs: number;
}): readonly PairEffectControlUpdate[] {
  assertTime(input.nowMs, "expiry time");
  return Object.freeze(input.effects
    .filter((effect) => effect.state === "PENDING" && effect.claimToken === null && input.nowMs > effect.deadlineMs)
    .sort((left, right) => left.effectId.localeCompare(right.effectId))
    .map((effect) => Object.freeze({
      effectId: effect.effectId,
      expectedState: "PENDING" as const,
      expectedClaimToken: null,
      nextState: "EXPIRED_UNCLAIMED" as const,
      reason: "EFFECT_DEADLINE_EXCEEDED",
      updatedAtMs: input.nowMs,
    })));
}

export interface PairUnknownEffectSnapshot {
  readonly groupId: string;
  readonly effectId: string;
  readonly kind: PairControlledEffectKind;
  readonly unknownObservedAtMs: number;
  readonly resolvedEvidenceId: string | null;
  readonly alreadyManualReview: boolean;
  readonly reservedCash6: bigint;
  readonly upHeldShares6: bigint;
  readonly downHeldShares6: bigint;
}

export interface PairWatchdogEscalation {
  readonly groupId: string;
  readonly effectId: string;
  readonly kind: PairControlledEffectKind;
  readonly timeoutAtMs: number;
  readonly fact: PairControlFact;
  readonly retained: Readonly<{
    reservedCash6: bigint;
    upHeldShares6: bigint;
    downHeldShares6: bigint;
  }>;
  readonly newEffects: readonly [];
  readonly continuations: readonly ["INGEST_LATE_EVIDENCE", "APPLY_AUTHORITATIVE_RESOLUTION", "RECONCILE"];
}

export interface PairWatchdogHealth {
  readonly status: "HEALTHY" | "UNHEALTHY";
  readonly unresolvedEffectCount: number;
  readonly unresolvedGroupCount: number;
  readonly timedOutEffectCount: number;
  readonly manualReviewGroupCount: number;
  readonly paperSchedulingAllowed: boolean;
  readonly reasons: readonly {
    readonly code: "PAIR_EFFECT_OUTCOME_UNKNOWN" | "PAIR_MANUAL_REVIEW_REQUIRED";
    readonly count: number;
    readonly message: string;
  }[];
}

export interface PairWatchdogPlan {
  readonly checkedAtMs: number;
  readonly unknownResultTimeoutMs: number;
  readonly pending: readonly PairUnknownEffectSnapshot[];
  readonly escalations: readonly PairWatchdogEscalation[];
  readonly health: PairWatchdogHealth;
  readonly planHash: string;
}

/** Exact timeout watchdog for initial, recovery, and merge unknown effects. */
export function planPairUnknownWatchdog(input: {
  readonly nowMs: number;
  readonly unknownResultTimeoutMs: number;
  readonly effects: readonly PairUnknownEffectSnapshot[];
}): PairWatchdogPlan {
  assertTime(input.nowMs, "watchdog time");
  assertTime(input.unknownResultTimeoutMs, "unknown result timeout");
  const seen = new Set<string>();
  const unresolved: PairUnknownEffectSnapshot[] = [];
  const escalations: PairWatchdogEscalation[] = [];
  for (const effect of [...input.effects].sort((a, b) => `${a.groupId}:${a.effectId}`.localeCompare(`${b.groupId}:${b.effectId}`))) {
    assertText(effect.groupId, "unknown groupId");
    assertText(effect.effectId, "unknown effectId");
    assertTime(effect.unknownObservedAtMs, "unknown observed time");
    if (effect.reservedCash6 < 0n || effect.upHeldShares6 < 0n || effect.downHeldShares6 < 0n) {
      throw new PairHaltWatchdogError("unknown reservation and holdings must be non-negative");
    }
    const identityKey = `${effect.groupId}:${effect.effectId}`;
    if (seen.has(identityKey)) throw new PairHaltWatchdogError(`duplicate unknown effect ${identityKey}`);
    seen.add(identityKey);
    if (effect.resolvedEvidenceId !== null) continue;
    unresolved.push(effect);
    const timeoutAtMs = checkedDeadline(effect.unknownObservedAtMs, input.unknownResultTimeoutMs);
    if (effect.alreadyManualReview || input.nowMs < timeoutAtMs) continue;
    const diffCode = `UNKNOWN_RESULT_TIMEOUT:${effect.kind}:${effect.effectId}`;
    const groupId = effect.groupId as PairGroupId;
    const identity = { schemaVersion: 1, groupId, effectId: effect.effectId, timeoutAtMs, diffCode };
    const timeoutFact: PairControlFact = Object.freeze({
      eventId: stableId("pevt", identity) as PairEventId,
      groupId,
      causationId: stableId("pcause", identity),
      occurredAtMs: timeoutAtMs,
      type: "PAIR_RECONCILIATION_MISMATCH",
      payload: Object.freeze({ diffCodes: Object.freeze([diffCode]) }),
    });
    escalations.push(Object.freeze({
      groupId: effect.groupId,
      effectId: effect.effectId,
      kind: effect.kind,
      timeoutAtMs,
      fact: timeoutFact,
      retained: Object.freeze({
        reservedCash6: effect.reservedCash6,
        upHeldShares6: effect.upHeldShares6,
        downHeldShares6: effect.downHeldShares6,
      }),
      newEffects: Object.freeze([]) as readonly [],
      continuations: Object.freeze(["INGEST_LATE_EVIDENCE", "APPLY_AUTHORITATIVE_RESOLUTION", "RECONCILE"] as const),
    }));
  }
  const unresolvedGroups = new Set(unresolved.map((effect) => effect.groupId));
  const manualGroups = new Set(input.effects.filter((effect) => effect.alreadyManualReview).map((effect) => effect.groupId));
  for (const escalation of escalations) manualGroups.add(escalation.groupId);
  const reasons: PairWatchdogHealth["reasons"][number][] = [];
  if (unresolved.length > 0) reasons.push(Object.freeze({
    code: "PAIR_EFFECT_OUTCOME_UNKNOWN",
    count: unresolvedGroups.size,
    message: `${unresolvedGroups.size} group(s) have unresolved initial/recovery/merge evidence`,
  }));
  if (manualGroups.size > 0) reasons.push(Object.freeze({
    code: "PAIR_MANUAL_REVIEW_REQUIRED",
    count: manualGroups.size,
    message: `${manualGroups.size} group(s) require manual review after unresolved evidence timeout`,
  }));
  const health: PairWatchdogHealth = Object.freeze({
    status: reasons.length === 0 ? "HEALTHY" : "UNHEALTHY",
    unresolvedEffectCount: unresolved.length,
    unresolvedGroupCount: unresolvedGroups.size,
    timedOutEffectCount: escalations.length,
    manualReviewGroupCount: manualGroups.size,
    paperSchedulingAllowed: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
  const material = {
    checkedAtMs: input.nowMs,
    unknownResultTimeoutMs: input.unknownResultTimeoutMs,
    pending: Object.freeze(unresolved),
    escalations: Object.freeze(escalations),
    health,
  };
  return Object.freeze({ ...material, planHash: canonicalObjectHash(material) });
}

export type PairLateEvidencePlan =
  | { readonly kind: "DUPLICATE"; readonly evidenceKey: string; readonly newEffects: readonly [] }
  | {
      readonly kind: "INGEST_LATE_EVIDENCE";
      readonly evidenceKey: string;
      readonly groupId: string;
      readonly effectId: string;
      readonly preserveManualReviewUntilReconciled: true;
      readonly newEffects: readonly [];
      readonly continuations: readonly ["APPLY_EVIDENCE", "APPLY_AUTHORITATIVE_RESOLUTION", "RECONCILE"];
      readonly planHash: string;
    };

/** Late facts remain admissible after timeout; dedupe is by durable evidence key. */
export function planLateEvidenceAfterWatchdog(input: {
  readonly groupId: string;
  readonly effectId: string;
  readonly evidenceKey: string;
  readonly processedEvidenceKeys: readonly string[];
}): PairLateEvidencePlan {
  assertText(input.groupId, "groupId");
  assertText(input.effectId, "effectId");
  assertText(input.evidenceKey, "evidenceKey");
  if (input.processedEvidenceKeys.includes(input.evidenceKey)) {
    return Object.freeze({ kind: "DUPLICATE", evidenceKey: input.evidenceKey, newEffects: Object.freeze([]) as readonly [] });
  }
  const material = {
    kind: "INGEST_LATE_EVIDENCE" as const,
    evidenceKey: input.evidenceKey,
    groupId: input.groupId,
    effectId: input.effectId,
    preserveManualReviewUntilReconciled: true as const,
    newEffects: Object.freeze([]) as readonly [],
    continuations: Object.freeze(["APPLY_EVIDENCE", "APPLY_AUTHORITATIVE_RESOLUTION", "RECONCILE"] as const),
  };
  return Object.freeze({ ...material, planHash: canonicalObjectHash(material) });
}
