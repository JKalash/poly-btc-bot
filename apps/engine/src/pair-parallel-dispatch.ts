import {
  canonicalObjectHash,
  effectIdempotencyKey,
  pairClientOrderId,
  pairLegId,
  type PairEventId,
  type PairGroupId,
  type PairLegId,
  type PairOutcome,
} from "@b5p/pair-execution";
import type { PairActivationResult } from "./pair-activation";
import {
  encodePaperPairOutboxRequestPayload,
} from "./pair-outbox-dispatcher";
import {
  paperPairVenueRequestHash,
  type PaperPairEffectEvidence,
  type PaperPairLegRequest,
  type PaperPairVenueRequest,
} from "./paper-pair-venue";
import type { PairEffectEnqueue } from "./pair-store";

const INITIAL_PARALLEL_ACTION = "INITIAL_PARALLEL" as const;

export class PairParallelDispatchPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairParallelDispatchPlanError";
  }
}

export interface PairParallelDispatchPlanInput {
  readonly activation: PairActivationResult;
  readonly groupId: string;
  readonly actionSequence: number;
  readonly expectedEventSequence: number;
  readonly activationDecisionId: string;
  readonly activationRiskDecisionId: string;
  readonly shareLot6: bigint;
  readonly notBeforeMs: number;
  readonly deadlineMs: number;
  readonly createdAtMs: number;
}

export interface PairParallelActionIntentPlan {
  readonly id: string;
  readonly groupId: string;
  readonly actionSequence: number;
  readonly actionKind: typeof INITIAL_PARALLEL_ACTION;
  readonly captureId: string;
  readonly decisionId: string;
  readonly riskDecisionId: string;
  readonly createdAtMs: number;
}

export type PairParallelLifecycleFact = Readonly<{
  eventId: PairEventId;
  groupId: PairGroupId;
  causationId: string;
  occurredAtMs: number;
} & (
  | { type: "PAIR_ACTIVATION_APPROVED"; payload: Readonly<Record<string, never>> }
  | { type: "PAIR_LEG_PLANNED"; payload: { readonly outcome: PairOutcome; readonly requestedGrossShares6: bigint } }
  | { type: "PAIR_LEG_EFFECT_ENQUEUED"; payload: { readonly outcome: PairOutcome; readonly effectId: string } }
)>;

export interface PairParallelLegDispatchPlan {
  readonly outcome: PairOutcome;
  readonly ordinal: 0 | 1;
  readonly legId: PairLegId;
  readonly request: PaperPairVenueRequest;
  readonly effect: PairEffectEnqueue;
}

export interface PairParallelInitialDispatchPlan {
  readonly schemaVersion: 1;
  readonly kind: "PAIR_INITIAL_PARALLEL_ACTION_V1";
  readonly groupId: string;
  readonly action: PairParallelActionIntentPlan;
  readonly facts: readonly [
    PairParallelLifecycleFact,
    PairParallelLifecycleFact,
    PairParallelLifecycleFact,
    PairParallelLifecycleFact,
    PairParallelLifecycleFact,
  ];
  readonly legs: readonly [PairParallelLegDispatchPlan, PairParallelLegDispatchPlan];
  readonly effects: readonly [PairEffectEnqueue, PairEffectEnqueue];
  readonly planHash: string;
}

export type PairParallelCommitResult =
  | { readonly kind: "COMMITTED" }
  | { readonly kind: "DUPLICATE"; readonly planHash: string };

/** Facade-owned transaction: action, all facts, and both effects commit once. */
export interface PairParallelDispatchCommitPort {
  commitInitialParallel(plan: PairParallelInitialDispatchPlan): Promise<PairParallelCommitResult>;
}

export type PairParallelDispatchCommitOutcome = Readonly<{
  kind: "READY_TO_DISPATCH";
  duplicate: boolean;
  plan: PairParallelInitialDispatchPlan;
  /** Returned only after the one atomic commit confirms both rows. */
  committedEffects: readonly [PairEffectEnqueue, PairEffectEnqueue];
}>;

function assertText(value: string, label: string): void {
  if (value.trim().length === 0) throw new PairParallelDispatchPlanError(`${label} must be non-empty`);
}

function assertTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new PairParallelDispatchPlanError(`${label} must be a non-negative safe integer`);
}

function stableId(prefix: string, input: unknown): string {
  return `${prefix}_${canonicalObjectHash(input).slice(0, 32)}`;
}

function stableFact(
  groupId: PairGroupId,
  type: PairParallelLifecycleFact["type"],
  payload: PairParallelLifecycleFact["payload"],
  occurredAtMs: number,
  ordinal: number,
): PairParallelLifecycleFact {
  const identity = { schemaVersion: 1, groupId, type, payload, occurredAtMs, ordinal };
  return Object.freeze({
    eventId: stableId("pevt", identity) as PairEventId,
    groupId,
    type,
    causationId: stableId("pcause", identity),
    occurredAtMs,
    payload,
  } as PairParallelLifecycleFact);
}

function legRequest(input: {
  readonly outcome: PairOutcome;
  readonly effectId: string;
  readonly clientOperationId: string;
  readonly idempotencyKey: string;
  readonly activation: Extract<PairActivationResult, { readonly kind: "APPROVED" }>;
  readonly shareLot6: bigint;
}): PaperPairVenueRequest {
  const data = input.activation.data;
  const capture = data.activationCapture!;
  const quote = data.quote!;
  const terms = data.currentTerms!;
  const quotedLeg = input.outcome === "UP" ? quote.up : quote.down;
  const tokenTerms = input.outcome === "UP" ? terms.up : terms.down;
  if (
    quotedLeg.outcome !== input.outcome || quotedLeg.orderSide !== "BUY" || !quotedLeg.fullyExecutable ||
    quotedLeg.requestedGrossShares6 !== data.selectedGrossShares6 || quotedLeg.filledGrossShares6 !== data.selectedGrossShares6 ||
    quotedLeg.worstPrice6 === null || tokenTerms.outcome !== input.outcome || tokenTerms.tokenId !== quotedLeg.tokenId ||
    tokenTerms.fee.convention !== "USDC"
  ) {
    throw new PairParallelDispatchPlanError(`${input.outcome} activation leg is not an exact executable USDC-fee FOK plan`);
  }
  const leg: PaperPairLegRequest = Object.freeze({
    outcome: input.outcome,
    tokenId: quotedLeg.tokenId,
    side: "BUY",
    timeInForce: "FOK",
    amountSemantics: "SHARES",
    grossShares6: quotedLeg.requestedGrossShares6,
    limitPrice6: quotedLeg.worstPrice6,
    maximumCashDebit6: quotedLeg.principal6 + quotedLeg.feeCash6,
    minimumOrderShares6: tokenTerms.constraints.minimumOrderShares6,
    shareLot6: input.shareLot6,
    fee: Object.freeze({ ratePpm: tokenTerms.fee.tokenFeeRatePpm, collection: "usdc" }),
    bookRef: quotedLeg.bookRef,
  });
  const withoutHash = {
    effectId: input.effectId,
    clientOperationId: input.clientOperationId,
    idempotencyKey: input.idempotencyKey,
    operationKind: "INITIAL_FOK" as const,
    capture,
    leg,
  };
  return Object.freeze({ ...withoutHash, requestHash: paperPairVenueRequestHash(withoutHash) });
}

function planLeg(input: {
  readonly outcome: PairOutcome;
  readonly ordinal: 0 | 1;
  readonly groupId: PairGroupId;
  readonly actionIntentId: string;
  readonly actionSequence: number;
  readonly activation: Extract<PairActivationResult, { readonly kind: "APPROVED" }>;
  readonly shareLot6: bigint;
  readonly notBeforeMs: number;
  readonly deadlineMs: number;
  readonly createdAtMs: number;
}): PairParallelLegDispatchPlan {
  const legId = pairLegId(input.groupId, input.outcome);
  const effectId = stableId("peff", {
    schemaVersion: 1,
    groupId: input.groupId,
    actionSequence: input.actionSequence,
    effectOrdinal: input.ordinal,
    outcome: input.outcome,
  });
  const clientOperationId = pairClientOrderId(legId, input.actionSequence);
  const identitySeed = canonicalObjectHash({
    schemaVersion: 1,
    groupId: input.groupId,
    actionKind: INITIAL_PARALLEL_ACTION,
    actionSequence: input.actionSequence,
    effectOrdinal: input.ordinal,
    outcome: input.outcome,
    captureId: input.activation.data.activationCapture!.captureId,
  });
  // The pure helper's final argument is intentionally an immutable identity
  // seed here. The complete venue request hash is bound immediately afterward.
  const idempotencyKey = effectIdempotencyKey({
    groupId: input.groupId,
    actionKind: INITIAL_PARALLEL_ACTION,
    actionSequence: BigInt(input.actionSequence),
    effectOrdinal: input.ordinal,
    immutableRequestHash: identitySeed,
  });
  const request = legRequest({
    outcome: input.outcome,
    effectId,
    clientOperationId,
    idempotencyKey,
    activation: input.activation,
    shareLot6: input.shareLot6,
  });
  const effect: PairEffectEnqueue = Object.freeze({
    id: effectId,
    actionIntentId: input.actionIntentId,
    actionKind: `INITIAL_FOK_${input.outcome}`,
    actionSequence: input.actionSequence,
    effectOrdinal: input.ordinal,
    idempotencyKey,
    clientOperationId,
    requestHash: request.requestHash,
    requestPayload: encodePaperPairOutboxRequestPayload(request),
    notBeforeMs: input.notBeforeMs,
    deadlineMs: input.deadlineMs,
    createdAtMs: input.createdAtMs,
  });
  return Object.freeze({ outcome: input.outcome, ordinal: input.ordinal, legId, request, effect });
}

/** Build the indivisible UP-ordinal-0/DOWN-ordinal-1 initial action. */
export function planParallelInitialDispatch(input: PairParallelDispatchPlanInput): PairParallelInitialDispatchPlan {
  assertText(input.groupId, "groupId");
  assertText(input.activationDecisionId, "activationDecisionId");
  assertText(input.activationRiskDecisionId, "activationRiskDecisionId");
  assertTime(input.notBeforeMs, "notBeforeMs");
  assertTime(input.deadlineMs, "deadlineMs");
  assertTime(input.createdAtMs, "createdAtMs");
  if (!Number.isSafeInteger(input.actionSequence) || input.actionSequence <= 0) throw new PairParallelDispatchPlanError("actionSequence must be a positive safe integer");
  if (!Number.isSafeInteger(input.expectedEventSequence) || input.expectedEventSequence < 0) throw new PairParallelDispatchPlanError("expectedEventSequence must be a non-negative safe integer");
  if (input.deadlineMs < input.notBeforeMs) throw new PairParallelDispatchPlanError("effect deadline precedes not-before time");
  if (input.shareLot6 <= 0n) throw new PairParallelDispatchPlanError("shareLot6 must be positive");
  if (input.activation.kind !== "APPROVED") throw new PairParallelDispatchPlanError("parallel dispatch requires an approved activation");
  const data = input.activation.data;
  if (
    data.groupId !== input.groupId || data.activationCapture === null || data.currentTerms === null ||
    data.quote === null || data.selectedGrossShares6 === null || data.selectedGrossShares6 <= 0n ||
    data.riskDecision.kind !== "APPROVED" || data.gateResult.kind !== "APPROVED"
  ) {
    throw new PairParallelDispatchPlanError("approved activation is missing immutable capture, quote, terms, risk, or group identity");
  }
  const groupId = input.groupId as PairGroupId;
  const actionId = stableId("pact", {
    schemaVersion: 1,
    groupId,
    actionSequence: input.actionSequence,
    actionKind: INITIAL_PARALLEL_ACTION,
    captureId: data.activationCapture.captureId,
    decisionId: input.activationDecisionId,
    riskDecisionId: input.activationRiskDecisionId,
  });
  const action = Object.freeze({
    id: actionId,
    groupId: input.groupId,
    actionSequence: input.actionSequence,
    actionKind: INITIAL_PARALLEL_ACTION,
    captureId: data.activationCapture.captureId,
    decisionId: input.activationDecisionId,
    riskDecisionId: input.activationRiskDecisionId,
    createdAtMs: input.createdAtMs,
  });
  const up = planLeg({ ...input, outcome: "UP", ordinal: 0, groupId, actionIntentId: actionId, activation: input.activation });
  const down = planLeg({ ...input, outcome: "DOWN", ordinal: 1, groupId, actionIntentId: actionId, activation: input.activation });
  const facts = Object.freeze([
    stableFact(groupId, "PAIR_ACTIVATION_APPROVED", Object.freeze({}), input.createdAtMs, input.expectedEventSequence + 1),
    stableFact(groupId, "PAIR_LEG_PLANNED", Object.freeze({ outcome: "UP" as const, requestedGrossShares6: data.selectedGrossShares6 }), input.createdAtMs, input.expectedEventSequence + 2),
    stableFact(groupId, "PAIR_LEG_PLANNED", Object.freeze({ outcome: "DOWN" as const, requestedGrossShares6: data.selectedGrossShares6 }), input.createdAtMs, input.expectedEventSequence + 3),
    stableFact(groupId, "PAIR_LEG_EFFECT_ENQUEUED", Object.freeze({ outcome: "UP" as const, effectId: up.effect.id }), input.createdAtMs, input.expectedEventSequence + 4),
    stableFact(groupId, "PAIR_LEG_EFFECT_ENQUEUED", Object.freeze({ outcome: "DOWN" as const, effectId: down.effect.id }), input.createdAtMs, input.expectedEventSequence + 5),
  ] as const);
  const base = Object.freeze({
    schemaVersion: 1 as const,
    kind: "PAIR_INITIAL_PARALLEL_ACTION_V1" as const,
    groupId: input.groupId,
    action,
    facts,
    legs: Object.freeze([up, down] as const),
    effects: Object.freeze([up.effect, down.effect] as const),
  });
  return Object.freeze({ ...base, planHash: canonicalObjectHash(base) });
}

/** Commit once; neither child is returned to a dispatcher before that commit. */
export async function commitParallelInitialDispatch(
  input: PairParallelDispatchPlanInput,
  store: PairParallelDispatchCommitPort,
): Promise<PairParallelDispatchCommitOutcome> {
  const plan = planParallelInitialDispatch(input);
  const committed = await store.commitInitialParallel(plan);
  if (committed.kind === "DUPLICATE" && committed.planHash !== plan.planHash) {
    throw new PairParallelDispatchPlanError("parallel action idempotency collision: stored plan hash differs");
  }
  return Object.freeze({
    kind: "READY_TO_DISPATCH",
    duplicate: committed.kind === "DUPLICATE",
    plan,
    committedEffects: plan.effects,
  });
}

export type PairInitialLegClassification =
  | { readonly kind: "FILLED"; readonly grossShares6: bigint; readonly netShares6: bigint; readonly cashDebit6: bigint }
  | { readonly kind: "ZERO_FILL"; readonly terminalKind: "NO_FILL" | "REJECTED" }
  | { readonly kind: "UNKNOWN" }
  | { readonly kind: "FOK_PARTIAL_INVARIANT_BREACH"; readonly grossShares6: bigint; readonly netShares6: bigint; readonly cashDebit6: bigint };

export function classifyParallelLegEvidence(
  leg: PairParallelLegDispatchPlan,
  evidence: PaperPairEffectEvidence,
): PairInitialLegClassification {
  if (
    evidence.effectId !== leg.effect.id || evidence.clientOperationId !== leg.effect.clientOperationId ||
    evidence.idempotencyKey !== leg.effect.idempotencyKey || evidence.requestHash !== leg.effect.requestHash ||
    evidence.captureId !== leg.request.capture.captureId || evidence.operationKind !== "INITIAL_FOK"
  ) {
    throw new PairParallelDispatchPlanError(`${leg.outcome} evidence does not bind to its immutable effect`);
  }
  const expectedState = evidence.result.kind === "FILLED" ? "FILLED"
    : evidence.result.kind === "NO_FILL" ? "NO_FILL"
      : evidence.result.kind === "REJECTED" ? "TERMINAL_REJECTED"
        : evidence.result.kind === "PARTIAL_CANCELED" ? "PARTIAL_CANCELED"
          : "OUTCOME_UNKNOWN";
  if (evidence.state !== expectedState || evidence.resultHash !== canonicalObjectHash(evidence.result)) {
    throw new PairParallelDispatchPlanError(`${leg.outcome} evidence state/hash is malformed`);
  }
  if (evidence.result.kind === "UNKNOWN") return Object.freeze({ kind: "UNKNOWN" });
  if (evidence.result.kind === "NO_FILL") return Object.freeze({ kind: "ZERO_FILL", terminalKind: "NO_FILL" });
  if (evidence.result.kind === "REJECTED") return Object.freeze({ kind: "ZERO_FILL", terminalKind: "REJECTED" });
  const quote = evidence.result.quote;
  const value = {
    grossShares6: quote.filledGrossShares6,
    netShares6: quote.receivedNetShares6,
    cashDebit6: quote.principal6 + quote.feeCash6,
  };
  if (
    evidence.result.kind === "PARTIAL_CANCELED" || quote.filledGrossShares6 !== leg.request.leg.grossShares6 ||
    quote.filledGrossShares6 <= 0n
  ) {
    return Object.freeze({ kind: "FOK_PARTIAL_INVARIANT_BREACH", ...value });
  }
  return Object.freeze({ kind: "FILLED", ...value });
}

export type PairParallelInitialOutcome =
  | { readonly kind: "AWAITING_SIBLING"; readonly retainedEffectId: string; readonly siblingAction: "RETAIN_COMMITTED_EFFECT" }
  | { readonly kind: "OUTCOME_UNKNOWN"; readonly siblingAction: "RETAIN_COMMITTED_EFFECT" | "NONE" }
  | { readonly kind: "MANUAL_REVIEW"; readonly breachCode: "INITIAL_FOK_NOT_ALL_OR_ZERO" }
  | { readonly kind: "NO_INITIAL_FILL" }
  | { readonly kind: "PAIRED"; readonly matchedShares6: bigint }
  | { readonly kind: "RESIDUAL"; readonly upHeldShares6: bigint; readonly downHeldShares6: bigint };

/** Pure aggregate classification; ordinary first results never cancel/classify the sibling. */
export function classifyParallelInitialOutcome(input: {
  readonly plan: PairParallelInitialDispatchPlan;
  readonly up: PairInitialLegClassification | null;
  readonly down: PairInitialLegClassification | null;
}): PairParallelInitialOutcome {
  if (input.up?.kind === "FOK_PARTIAL_INVARIANT_BREACH" || input.down?.kind === "FOK_PARTIAL_INVARIANT_BREACH") {
    return Object.freeze({ kind: "MANUAL_REVIEW", breachCode: "INITIAL_FOK_NOT_ALL_OR_ZERO" });
  }
  if (input.up?.kind === "UNKNOWN" || input.down?.kind === "UNKNOWN") {
    return Object.freeze({
      kind: "OUTCOME_UNKNOWN",
      siblingAction: input.up === null || input.down === null ? "RETAIN_COMMITTED_EFFECT" : "NONE",
    });
  }
  if (input.up === null || input.down === null) {
    const sibling = input.up === null ? input.plan.legs[0] : input.plan.legs[1];
    return Object.freeze({ kind: "AWAITING_SIBLING", retainedEffectId: sibling.effect.id, siblingAction: "RETAIN_COMMITTED_EFFECT" });
  }
  const upHeldShares6 = input.up.kind === "FILLED" ? input.up.netShares6 : 0n;
  const downHeldShares6 = input.down.kind === "FILLED" ? input.down.netShares6 : 0n;
  if (upHeldShares6 === 0n && downHeldShares6 === 0n) return Object.freeze({ kind: "NO_INITIAL_FILL" });
  if (upHeldShares6 === downHeldShares6) return Object.freeze({ kind: "PAIRED", matchedShares6: upHeldShares6 });
  return Object.freeze({ kind: "RESIDUAL", upHeldShares6, downHeldShares6 });
}

export type PairInitialEvidenceFact = Readonly<{
  eventId: PairEventId;
  groupId: PairGroupId;
  causationId: string;
  occurredAtMs: number;
} & (
  | { type: "PAIR_LEG_RESULT_RECORDED"; payload: { readonly outcome: PairOutcome; readonly evidenceKey: string; readonly result: "FILLED" | "NO_FILL" | "REJECTED"; readonly filledGrossShares6: bigint } }
  | { type: "PAIR_FILL_RECORDED"; payload: { readonly outcome: PairOutcome; readonly evidenceKey: string; readonly grossShares6: bigint; readonly netShares6: bigint; readonly cashDebit6: bigint } }
  | { type: "PAIR_LEG_OUTCOME_UNKNOWN"; payload: { readonly outcome: PairOutcome; readonly evidenceKey: string } }
)>;

/** Deterministic reducer facts for one independently arriving leg result. */
export function parallelInitialEvidenceFacts(input: {
  readonly plan: PairParallelInitialDispatchPlan;
  readonly outcome: PairOutcome;
  readonly evidence: PaperPairEffectEvidence;
  readonly occurredAtMs: number;
}): readonly PairInitialEvidenceFact[] {
  assertTime(input.occurredAtMs, "occurredAtMs");
  const leg = input.outcome === "UP" ? input.plan.legs[0] : input.plan.legs[1];
  const classified = classifyParallelLegEvidence(leg, input.evidence);
  const base = {
    groupId: input.plan.groupId as PairGroupId,
    outcome: input.outcome,
    evidenceKey: `paper-pair:${input.evidence.evidenceId}`,
    occurredAtMs: input.occurredAtMs,
  };
  const fact = (type: PairInitialEvidenceFact["type"], payload: PairInitialEvidenceFact["payload"], ordinal: number): PairInitialEvidenceFact => {
    const identity = { schemaVersion: 1, evidenceId: input.evidence.evidenceId, type, payload, ordinal };
    return Object.freeze({
      eventId: stableId("pevt", identity) as PairEventId,
      groupId: base.groupId,
      causationId: stableId("pcause", identity),
      occurredAtMs: input.occurredAtMs,
      type,
      payload,
    } as PairInitialEvidenceFact);
  };
  if (classified.kind === "UNKNOWN") {
    return Object.freeze([fact("PAIR_LEG_OUTCOME_UNKNOWN", Object.freeze({ outcome: input.outcome, evidenceKey: base.evidenceKey }), 0)]);
  }
  if (classified.kind === "ZERO_FILL") {
    return Object.freeze([fact("PAIR_LEG_RESULT_RECORDED", Object.freeze({
      outcome: input.outcome,
      evidenceKey: base.evidenceKey,
      result: classified.terminalKind,
      filledGrossShares6: 0n,
    }), 0)]);
  }
  // A PARTIAL_CANCELED initial FOK is intentionally represented as a FILLED
  // result with a non-requested quantity. The reducer records the external
  // fact, trips INITIAL_FOK_NOT_ALL_OR_ZERO, and enters MANUAL_REVIEW.
  return Object.freeze([
    fact("PAIR_LEG_RESULT_RECORDED", Object.freeze({
      outcome: input.outcome,
      evidenceKey: base.evidenceKey,
      result: "FILLED",
      filledGrossShares6: classified.grossShares6,
    }), 0),
    ...(classified.kind === "FILLED" ? [fact("PAIR_FILL_RECORDED", Object.freeze({
      outcome: input.outcome,
      evidenceKey: `${base.evidenceKey}:fill`,
      grossShares6: classified.grossShares6,
      netShares6: classified.netShares6,
      cashDebit6: classified.cashDebit6,
    }), 1)] : []),
  ]);
}
