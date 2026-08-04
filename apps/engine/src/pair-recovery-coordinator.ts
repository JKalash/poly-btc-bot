import {
  calculateRecoveryAlternatives,
  canonicalObjectHash,
  effectIdempotencyKey,
  selectRecoveryAction,
  type PairBookCapture,
  type PairEventId,
  type PairGroupId,
  type PairOutcome,
  type PairRecoveryPolicy,
  type RecoveryAlternative,
  type RecoverySelection,
} from "@b5p/pair-execution";
import {
  encodePaperPairOutboxRequestPayload,
} from "./pair-outbox-dispatcher";
import {
  paperPairBookReference,
  paperPairVenueRequestHash,
  type PaperPairEffectEvidence,
  type PaperPairVenueRequest,
} from "./paper-pair-venue";
import type { PairEffectEnqueue } from "./pair-store";

export class PairRecoveryCoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairRecoveryCoordinatorError";
  }
}

export interface PairRecoveryExecutionTerms {
  readonly minimumOrderShares6: bigint;
  readonly shareLot6: bigint;
  readonly fee: { readonly ratePpm: bigint; readonly collection: "usdc" | "shares" };
}

export interface PairRecoveryPlanInput {
  readonly groupId: string;
  readonly actionSequence: number;
  readonly recoveryDecisionId: string;
  readonly recoveryRiskDecisionId: string;
  readonly capture: PairBookCapture;
  readonly residualEnteredAtMs: number;
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly policy: PairRecoveryPolicy;
  readonly recoveryAttempts: number;
  readonly maximumRecoveryAttempts: 0 | 1;
  readonly initialOutcomeUnknown: boolean;
  readonly halted: boolean;
  readonly booksEligible: boolean;
  readonly residualOutcome: PairOutcome;
  readonly residualShares6: bigint;
  readonly residualCostBasis6: bigint;
  readonly upHeldShares6: bigint;
  readonly downHeldShares6: bigint;
  readonly currentWorstCaseLoss6: bigint;
  readonly remainingCash6: bigint;
  readonly recoveryReserve6: bigint;
  readonly maximumLockedLoss6: bigint;
  readonly upTerms: PairRecoveryExecutionTerms;
  readonly downTerms: PairRecoveryExecutionTerms;
}

export type PairRecoveryLifecycleFact = Readonly<{
  eventId: PairEventId;
  groupId: PairGroupId;
  causationId: string;
  occurredAtMs: number;
} & (
  | { type: "PAIR_RECOVERY_ALTERNATIVES_CAPTURED"; payload: { readonly eligibleAttempt: boolean } }
  | { type: "PAIR_RECOVERY_SKIPPED"; payload: { readonly reason: string } }
  | { type: "PAIR_RECOVERY_EFFECT_ENQUEUED"; payload: { readonly effectId: string } }
)>;

export interface PairRecoveryActionPlan {
  readonly id: string;
  readonly groupId: string;
  readonly actionSequence: number;
  readonly actionKind: "RECOVERY_COMPLETE_MISSING_LEG" | "RECOVERY_LIQUIDATE_FILLED_LEG";
  readonly captureId: string;
  readonly decisionId: string;
  readonly riskDecisionId: string;
  readonly createdAtMs: number;
}

export interface PairRecoveryPlan {
  readonly schemaVersion: 1;
  readonly kind: "PAIR_RECOVERY_PLAN_V1";
  readonly groupId: string;
  readonly captureId: string;
  readonly captureHash: string;
  /** Always all three, in completion/liquidation/hold order. */
  readonly alternatives: readonly [RecoveryAlternative, RecoveryAlternative, RecoveryAlternative];
  readonly alternativesHash: string;
  readonly selection: RecoverySelection;
  readonly action: PairRecoveryActionPlan | null;
  readonly request: PaperPairVenueRequest | null;
  readonly effects: readonly [] | readonly [PairEffectEnqueue];
  readonly facts: readonly PairRecoveryLifecycleFact[];
  readonly planHash: string;
  /** Immutable source inventory used to classify terminal evidence. */
  readonly source: Readonly<{
    residualOutcome: PairOutcome;
    residualShares6: bigint;
    residualCostBasis6: bigint;
    upHeldShares6: bigint;
    downHeldShares6: bigint;
    currentWorstCaseLoss6: bigint;
  }>;
}

export type PairRecoveryCommitResult =
  | { readonly kind: "COMMITTED" }
  | { readonly kind: "DUPLICATE"; readonly planHash: string };

/** Must persist capture/alternatives/selection/facts and optional effect atomically. */
export interface PairRecoveryCommitPort {
  commitRecoveryPlan(plan: PairRecoveryPlan): Promise<PairRecoveryCommitResult>;
}

export type PairRecoveryCommitOutcome = Readonly<{
  kind: "RECOVERY_DECISION_COMMITTED";
  duplicate: boolean;
  plan: PairRecoveryPlan;
  committedEffects: readonly [] | readonly [PairEffectEnqueue];
}>;

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${canonicalObjectHash(value).slice(0, 32)}`;
}

function assertText(value: string, label: string): void {
  if (value.trim().length === 0) throw new PairRecoveryCoordinatorError(`${label} must be non-empty`);
}

function assertTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new PairRecoveryCoordinatorError(`${label} must be a non-negative safe integer`);
}

function bookLevels(capture: PairBookCapture, outcome: PairOutcome, side: "asks" | "bids") {
  const leg = outcome === "UP" ? capture.up : capture.down;
  return Object.freeze(leg[side].map((level) => Object.freeze({ price: level.price6, size: level.shares6 })));
}

function terms(input: PairRecoveryPlanInput, outcome: PairOutcome): PairRecoveryExecutionTerms {
  return outcome === "UP" ? input.upTerms : input.downTerms;
}

function fact(
  groupId: PairGroupId,
  occurredAtMs: number,
  type: PairRecoveryLifecycleFact["type"],
  payload: PairRecoveryLifecycleFact["payload"],
  ordinal: number,
): PairRecoveryLifecycleFact {
  const identity = { schemaVersion: 1, groupId, occurredAtMs, type, payload, ordinal };
  return Object.freeze({
    eventId: stableId("pevt", identity) as PairEventId,
    groupId,
    causationId: stableId("pcause", identity),
    occurredAtMs,
    type,
    payload,
  } as PairRecoveryLifecycleFact);
}

function requestForSelection(input: PairRecoveryPlanInput, selected: RecoveryAlternative, actionId: string): {
  readonly request: PaperPairVenueRequest;
  readonly effect: PairEffectEnqueue;
  readonly action: PairRecoveryActionPlan;
} {
  const complementOutcome: PairOutcome = input.residualOutcome === "UP" ? "DOWN" : "UP";
  const outcome = selected.kind === "COMPLETE_MISSING_LEG" ? complementOutcome : input.residualOutcome;
  const selectedTerms = terms(input, outcome);
  if (
    selected.kind === "HOLD_TO_RESOLUTION" || selected.actionQuantity6 <= 0n ||
    selected.actionQuantity6 > input.residualShares6 || selectedTerms.fee.collection !== "usdc" ||
    input.residualShares6 < selectedTerms.minimumOrderShares6 || input.residualShares6 % selectedTerms.shareLot6 !== 0n
  ) {
    throw new PairRecoveryCoordinatorError("selected recovery cannot produce a valid bounded paper request");
  }
  const effectId = stableId("peff", {
    schemaVersion: 1,
    groupId: input.groupId,
    actionSequence: input.actionSequence,
    effectOrdinal: 0,
    selectedKind: selected.kind,
    captureId: input.capture.captureId,
  });
  const clientOperationId = stableId("pord", { effectId, captureId: input.capture.captureId });
  const identitySeed = canonicalObjectHash({
    schemaVersion: 1,
    effectId,
    captureId: input.capture.captureId,
    selectedKind: selected.kind,
    residualOutcome: input.residualOutcome,
    residualShares6: input.residualShares6,
  });
  const idempotencyKey = effectIdempotencyKey({
    groupId: input.groupId as PairGroupId,
    actionKind: selected.kind,
    actionSequence: BigInt(input.actionSequence),
    effectOrdinal: 0,
    immutableRequestHash: identitySeed,
  });
  const levels = selected.kind === "COMPLETE_MISSING_LEG"
    ? bookLevels(input.capture, outcome, "asks")
    : bookLevels(input.capture, outcome, "bids");
  const lastLevel = levels[levels.length - 1];
  if (lastLevel === undefined || lastLevel.price <= 0n) throw new PairRecoveryCoordinatorError("selected recovery has no executable direct-book limit");
  const leg = selected.kind === "COMPLETE_MISSING_LEG"
    ? Object.freeze({
        outcome,
        tokenId: outcome === "UP" ? input.capture.up.tokenId : input.capture.down.tokenId,
        side: "BUY" as const,
        timeInForce: "FOK" as const,
        amountSemantics: "SHARES" as const,
        grossShares6: input.residualShares6,
        limitPrice6: lastLevel.price,
        maximumCashDebit6: -selected.incrementalCashDelta6,
        minimumOrderShares6: selectedTerms.minimumOrderShares6,
        shareLot6: selectedTerms.shareLot6,
        fee: selectedTerms.fee,
        bookRef: paperPairBookReference(input.capture, outcome),
      })
    : Object.freeze({
        outcome,
        tokenId: outcome === "UP" ? input.capture.up.tokenId : input.capture.down.tokenId,
        side: "SELL" as const,
        timeInForce: "FAK" as const,
        amountSemantics: "SHARES" as const,
        grossShares6: input.residualShares6,
        limitPrice6: lastLevel.price,
        availableShares6: input.residualShares6,
        minimumOrderShares6: selectedTerms.minimumOrderShares6,
        shareLot6: selectedTerms.shareLot6,
        fee: selectedTerms.fee,
        bookRef: paperPairBookReference(input.capture, outcome),
      });
  const withoutHash = {
    effectId,
    clientOperationId,
    idempotencyKey,
    operationKind: selected.kind === "COMPLETE_MISSING_LEG" ? "RECOVERY_BUY_FOK" as const : "RECOVERY_SELL_FAK" as const,
    capture: input.capture,
    leg,
  };
  const request: PaperPairVenueRequest = Object.freeze({ ...withoutHash, requestHash: paperPairVenueRequestHash(withoutHash) });
  const actionKind = selected.kind === "COMPLETE_MISSING_LEG"
    ? "RECOVERY_COMPLETE_MISSING_LEG" as const
    : "RECOVERY_LIQUIDATE_FILLED_LEG" as const;
  const action: PairRecoveryActionPlan = Object.freeze({
    id: actionId,
    groupId: input.groupId,
    actionSequence: input.actionSequence,
    actionKind,
    captureId: input.capture.captureId,
    decisionId: input.recoveryDecisionId,
    riskDecisionId: input.recoveryRiskDecisionId,
    createdAtMs: input.nowMs,
  });
  const effect: PairEffectEnqueue = Object.freeze({
    id: effectId,
    actionIntentId: actionId,
    actionKind,
    actionSequence: input.actionSequence,
    effectOrdinal: 0,
    idempotencyKey,
    clientOperationId,
    requestHash: request.requestHash,
    requestPayload: encodePaperPairOutboxRequestPayload(request),
    notBeforeMs: input.nowMs,
    deadlineMs: input.deadlineMs,
    createdAtMs: input.nowMs,
  });
  return Object.freeze({ request, effect, action });
}

/** Calculate and retain all alternatives before applying the closed policy. */
export function planPairRecovery(input: PairRecoveryPlanInput): PairRecoveryPlan {
  assertText(input.groupId, "groupId");
  assertText(input.recoveryDecisionId, "recoveryDecisionId");
  assertText(input.recoveryRiskDecisionId, "recoveryRiskDecisionId");
  assertTime(input.residualEnteredAtMs, "residualEnteredAtMs");
  assertTime(input.nowMs, "nowMs");
  assertTime(input.deadlineMs, "deadlineMs");
  if (!Number.isSafeInteger(input.actionSequence) || input.actionSequence <= 0) throw new PairRecoveryCoordinatorError("actionSequence must be a positive safe integer");
  if (!Number.isSafeInteger(input.recoveryAttempts) || input.recoveryAttempts < 0) throw new PairRecoveryCoordinatorError("recoveryAttempts must be a non-negative safe integer");
  if (input.residualShares6 <= 0n) throw new PairRecoveryCoordinatorError("residualShares6 must be positive");
  if (input.residualCostBasis6 < 0n || input.currentWorstCaseLoss6 < 0n || input.remainingCash6 < 0n || input.recoveryReserve6 < 0n || input.maximumLockedLoss6 < 0n) {
    throw new PairRecoveryCoordinatorError("recovery cash/risk inputs must be non-negative");
  }
  const groupId = input.groupId as PairGroupId;
  const captureIsProspective = input.capture.capturedAtMs > input.residualEnteredAtMs && input.capture.capturedAtMs <= input.nowMs;
  const complementOutcome: PairOutcome = input.residualOutcome === "UP" ? "DOWN" : "UP";
  const complementTerms = terms(input, complementOutcome);
  const liquidationTerms = terms(input, input.residualOutcome);
  const alternatives = calculateRecoveryAlternatives({
    bookCaptureId: input.capture.captureId,
    residualOutcome: input.residualOutcome,
    residualShares6: input.residualShares6,
    residualCostBasis6: input.residualCostBasis6,
    upHeldShares6: input.upHeldShares6,
    downHeldShares6: input.downHeldShares6,
    currentWorstCaseLoss6: input.currentWorstCaseLoss6,
    remainingCash6: input.remainingCash6,
    recoveryReserve6: input.recoveryReserve6,
    maximumLockedLoss6: input.maximumLockedLoss6,
    deadlineMs: input.deadlineMs,
    complement: {
      levels: bookLevels(input.capture, complementOutcome, "asks"),
      fee: complementTerms.fee,
      bookRef: paperPairBookReference(input.capture, complementOutcome),
    },
    liquidation: {
      levels: bookLevels(input.capture, input.residualOutcome, "bids"),
      fee: liquidationTerms.fee,
      bookRef: paperPairBookReference(input.capture, input.residualOutcome),
    },
    booksEligible: input.booksEligible && captureIsProspective,
  }) as readonly [RecoveryAlternative, RecoveryAlternative, RecoveryAlternative];
  let selection: RecoverySelection = selectRecoveryAction({
    policy: input.policy,
    alternatives,
    nowMs: input.nowMs,
    deadlineMs: input.deadlineMs,
    recoveryAttempts: input.recoveryAttempts,
    maximumRecoveryAttempts: input.maximumRecoveryAttempts,
    initialOutcomeUnknown: input.initialOutcomeUnknown,
    halted: input.halted,
  });
  if (selection.kind === "ACT") {
    const selectedTerms = terms(input, selection.alternative.kind === "COMPLETE_MISSING_LEG" ? complementOutcome : input.residualOutcome);
    if (
      selectedTerms.fee.collection !== "usdc" || input.residualShares6 < selectedTerms.minimumOrderShares6 ||
      selectedTerms.shareLot6 <= 0n || input.residualShares6 % selectedTerms.shareLot6 !== 0n
    ) {
      selection = Object.freeze({ kind: "SKIP", reason: "RECOVERY_REQUEST_CONSTRAINT_INVALID", policyVersion: selection.policyVersion });
    }
  }
  const alternativesHash = canonicalObjectHash(alternatives);
  const actionId = stableId("pact", {
    schemaVersion: 1,
    groupId,
    actionSequence: input.actionSequence,
    decisionId: input.recoveryDecisionId,
    captureId: input.capture.captureId,
    alternativesHash,
    selection,
  });
  let action: PairRecoveryActionPlan | null = null;
  let request: PaperPairVenueRequest | null = null;
  let effects: readonly [] | readonly [PairEffectEnqueue] = Object.freeze([]);
  const facts: PairRecoveryLifecycleFact[] = [fact(groupId, input.nowMs, "PAIR_RECOVERY_ALTERNATIVES_CAPTURED", Object.freeze({ eligibleAttempt: selection.kind === "ACT" }), 0)];
  if (selection.kind === "ACT") {
    const planned = requestForSelection(input, selection.alternative, actionId);
    action = planned.action;
    request = planned.request;
    effects = Object.freeze([planned.effect]);
    facts.push(fact(groupId, input.nowMs, "PAIR_RECOVERY_EFFECT_ENQUEUED", Object.freeze({ effectId: planned.effect.id }), 1));
  } else {
    facts.push(fact(groupId, input.nowMs, "PAIR_RECOVERY_SKIPPED", Object.freeze({ reason: selection.reason }), 1));
  }
  const source = Object.freeze({
    residualOutcome: input.residualOutcome,
    residualShares6: input.residualShares6,
    residualCostBasis6: input.residualCostBasis6,
    upHeldShares6: input.upHeldShares6,
    downHeldShares6: input.downHeldShares6,
    currentWorstCaseLoss6: input.currentWorstCaseLoss6,
  });
  const base = Object.freeze({
    schemaVersion: 1 as const,
    kind: "PAIR_RECOVERY_PLAN_V1" as const,
    groupId: input.groupId,
    captureId: input.capture.captureId,
    captureHash: input.capture.captureHash,
    alternatives,
    alternativesHash,
    selection,
    action,
    request,
    effects,
    facts: Object.freeze(facts),
    source,
  });
  return Object.freeze({ ...base, planHash: canonicalObjectHash(base) });
}

export async function commitPairRecovery(
  input: PairRecoveryPlanInput,
  store: PairRecoveryCommitPort,
): Promise<PairRecoveryCommitOutcome> {
  const plan = planPairRecovery(input);
  const result = await store.commitRecoveryPlan(plan);
  if (result.kind === "DUPLICATE" && result.planHash !== plan.planHash) {
    throw new PairRecoveryCoordinatorError("recovery decision idempotency collision: stored plan hash differs");
  }
  return Object.freeze({
    kind: "RECOVERY_DECISION_COMMITTED",
    duplicate: result.kind === "DUPLICATE",
    plan,
    committedEffects: plan.effects,
  });
}

export type PairRecoveryEvidenceOutcome =
  | { readonly kind: "RECOVERY_OUTCOME_UNKNOWN"; readonly upHeldShares6: bigint; readonly downHeldShares6: bigint }
  | { readonly kind: "PAIRED"; readonly upHeldShares6: bigint; readonly downHeldShares6: bigint; readonly cashDebit6: bigint }
  | { readonly kind: "FLAT"; readonly upHeldShares6: 0n; readonly downHeldShares6: 0n; readonly cashCredit6: bigint }
  | { readonly kind: "HOLD_REMAINDER"; readonly upHeldShares6: bigint; readonly downHeldShares6: bigint; readonly cashDebit6: bigint; readonly cashCredit6: bigint; readonly remainingResidualShares6: bigint }
  | { readonly kind: "MANUAL_REVIEW"; readonly breachCode: "RECOVERY_EVIDENCE_INVALID" };

function evidenceBinding(plan: PairRecoveryPlan, evidence: PaperPairEffectEvidence): void {
  const effect = plan.effects[0];
  const expectedState = evidence.result.kind === "FILLED" ? "FILLED"
    : evidence.result.kind === "NO_FILL" ? "NO_FILL"
      : evidence.result.kind === "REJECTED" ? "TERMINAL_REJECTED"
        : evidence.result.kind === "PARTIAL_CANCELED" ? "PARTIAL_CANCELED"
          : "OUTCOME_UNKNOWN";
  if (
    effect === undefined || plan.request === null || evidence.effectId !== effect.id ||
    evidence.clientOperationId !== effect.clientOperationId || evidence.idempotencyKey !== effect.idempotencyKey ||
    evidence.requestHash !== effect.requestHash || evidence.captureId !== plan.captureId ||
    evidence.operationKind !== plan.request.operationKind || evidence.state !== expectedState ||
    evidence.resultHash !== canonicalObjectHash(evidence.result)
  ) {
    throw new PairRecoveryCoordinatorError("recovery evidence does not bind to the committed immutable effect");
  }
}

function remainingBasis(plan: PairRecoveryPlan, remainingShares6: bigint): bigint {
  if (remainingShares6 === 0n) return 0n;
  return (plan.source.residualCostBasis6 * remainingShares6 + plan.source.residualShares6 - 1n) / plan.source.residualShares6;
}

/** One terminal/unknown recovery result; it never produces another effect. */
export function classifyRecoveryEvidence(plan: PairRecoveryPlan, evidence: PaperPairEffectEvidence): PairRecoveryEvidenceOutcome {
  evidenceBinding(plan, evidence);
  if (plan.selection.kind !== "ACT" || plan.request === null) throw new PairRecoveryCoordinatorError("a skipped recovery has no effect evidence");
  const source = plan.source;
  if (evidence.result.kind === "UNKNOWN") {
    return Object.freeze({ kind: "RECOVERY_OUTCOME_UNKNOWN", upHeldShares6: source.upHeldShares6, downHeldShares6: source.downHeldShares6 });
  }
  if (evidence.result.kind === "REJECTED" || evidence.result.kind === "NO_FILL") {
    return Object.freeze({
      kind: "HOLD_REMAINDER",
      upHeldShares6: source.upHeldShares6,
      downHeldShares6: source.downHeldShares6,
      cashDebit6: 0n,
      cashCredit6: 0n,
      remainingResidualShares6: source.residualShares6,
    });
  }
  const quote = evidence.result.quote;
  if (quote.filledGrossShares6 > source.residualShares6 || quote.filledGrossShares6 <= 0n) {
    return Object.freeze({ kind: "MANUAL_REVIEW", breachCode: "RECOVERY_EVIDENCE_INVALID" });
  }
  if (plan.selection.alternative.kind === "COMPLETE_MISSING_LEG") {
    if (evidence.result.kind !== "FILLED" || quote.filledGrossShares6 !== source.residualShares6 || quote.receivedNetShares6 !== source.residualShares6) {
      return Object.freeze({ kind: "MANUAL_REVIEW", breachCode: "RECOVERY_EVIDENCE_INVALID" });
    }
    const upHeldShares6 = source.upHeldShares6 + (source.residualOutcome === "DOWN" ? quote.receivedNetShares6 : 0n);
    const downHeldShares6 = source.downHeldShares6 + (source.residualOutcome === "UP" ? quote.receivedNetShares6 : 0n);
    if (upHeldShares6 !== downHeldShares6 || upHeldShares6 <= 0n) {
      return Object.freeze({ kind: "MANUAL_REVIEW", breachCode: "RECOVERY_EVIDENCE_INVALID" });
    }
    return Object.freeze({ kind: "PAIRED", upHeldShares6, downHeldShares6, cashDebit6: quote.principal6 + quote.feeCash6 });
  }
  const sold = quote.filledGrossShares6;
  const upHeldShares6 = source.upHeldShares6 - (source.residualOutcome === "UP" ? sold : 0n);
  const downHeldShares6 = source.downHeldShares6 - (source.residualOutcome === "DOWN" ? sold : 0n);
  if (upHeldShares6 < 0n || downHeldShares6 < 0n) return Object.freeze({ kind: "MANUAL_REVIEW", breachCode: "RECOVERY_EVIDENCE_INVALID" });
  const cashCredit6 = quote.principal6 - quote.feeCash6;
  if (upHeldShares6 === 0n && downHeldShares6 === 0n) {
    return Object.freeze({ kind: "FLAT", upHeldShares6: 0n, downHeldShares6: 0n, cashCredit6 });
  }
  const remainder = upHeldShares6 > downHeldShares6 ? upHeldShares6 - downHeldShares6 : downHeldShares6 - upHeldShares6;
  return Object.freeze({
    kind: "HOLD_REMAINDER",
    upHeldShares6,
    downHeldShares6,
    cashDebit6: 0n,
    cashCredit6,
    remainingResidualShares6: remainder,
  });
}

export type PairRecoveryEvidenceFact = Readonly<{
  eventId: PairEventId;
  groupId: PairGroupId;
  causationId: string;
  occurredAtMs: number;
} & (
  | { type: "PAIR_RECOVERY_OUTCOME_UNKNOWN"; payload: { readonly evidenceKey: string } }
  | { type: "PAIR_RECOVERY_RESULT_RECORDED"; payload: { readonly evidenceKey: string; readonly upHeldShares6: bigint; readonly downHeldShares6: bigint; readonly cashDebit6: bigint; readonly cashCredit6: bigint; readonly currentWorstCaseLoss6: bigint } }
)>;

export function recoveryEvidenceFacts(input: {
  readonly plan: PairRecoveryPlan;
  readonly evidence: PaperPairEffectEvidence;
  readonly occurredAtMs: number;
}): readonly PairRecoveryEvidenceFact[] {
  assertTime(input.occurredAtMs, "occurredAtMs");
  const outcome = classifyRecoveryEvidence(input.plan, input.evidence);
  if (outcome.kind === "MANUAL_REVIEW") return Object.freeze([]);
  const groupId = input.plan.groupId as PairGroupId;
  const evidenceKey = `paper-pair:${input.evidence.evidenceId}`;
  const type = outcome.kind === "RECOVERY_OUTCOME_UNKNOWN" ? "PAIR_RECOVERY_OUTCOME_UNKNOWN" as const : "PAIR_RECOVERY_RESULT_RECORDED" as const;
  const payload = outcome.kind === "RECOVERY_OUTCOME_UNKNOWN"
    ? Object.freeze({ evidenceKey })
    : Object.freeze({
        evidenceKey,
        upHeldShares6: outcome.upHeldShares6,
        downHeldShares6: outcome.downHeldShares6,
        cashDebit6: outcome.kind === "PAIRED" ? outcome.cashDebit6 : outcome.kind === "HOLD_REMAINDER" ? outcome.cashDebit6 : 0n,
        cashCredit6: outcome.kind === "FLAT" || outcome.kind === "HOLD_REMAINDER" ? outcome.cashCredit6 : 0n,
        currentWorstCaseLoss6: outcome.kind === "HOLD_REMAINDER" ? remainingBasis(input.plan, outcome.remainingResidualShares6) : 0n,
      });
  const identity = { schemaVersion: 1, groupId, evidenceKey, type, payload };
  return Object.freeze([Object.freeze({
    eventId: stableId("pevt", identity) as PairEventId,
    groupId,
    causationId: stableId("pcause", identity),
    occurredAtMs: input.occurredAtMs,
    type,
    payload,
  } as PairRecoveryEvidenceFact)]);
}
