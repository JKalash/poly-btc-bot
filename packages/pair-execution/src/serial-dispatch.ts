import type {
  PairCaptureId,
  PairDispatchModel,
  PairGroupId,
  PairLegId,
  PairObservationId,
  PairOutcome,
} from "./contracts";
import { canonicalObjectHash, immutableRequestHash } from "./hashes";
import { effectIdempotencyKey, pairClientOrderId, pairLegId } from "./ids";

export type SerialDispatchModel = Exclude<PairDispatchModel, "PARALLEL">;
export type SerialZeroFillResult = "NO_FILL" | "REJECTED" | "CANCELED";

export interface SerialEffectIntent {
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly actionId: string;
  readonly decisionId: string;
  readonly clientOrderId: string;
  readonly legId: PairLegId;
  readonly outcome: PairOutcome;
  readonly actionKind: "SERIAL_FIRST_FOK" | "SERIAL_COMPLEMENT_FOK";
  readonly permitId: string | null;
  readonly captureId: PairCaptureId;
  readonly quoteHash: string;
  readonly requestedGrossShares6: bigint;
  readonly effectOrdinal: 0;
  readonly increasesExposure: true;
}

export interface SerialActivationPlan {
  readonly kind: "SERIAL_ACTIVATION_READY";
  readonly groupId: PairGroupId;
  readonly dispatchModel: SerialDispatchModel;
  readonly observationId: PairObservationId;
  readonly activationDecisionId: string;
  readonly activationCaptureId: PairCaptureId;
  readonly activationQuoteHash: string;
  readonly actionSequence: number;
  readonly targetGrossShares6: bigint;
  readonly firstOutcome: PairOutcome;
  readonly complementOutcome: PairOutcome;
  readonly firstLegId: PairLegId;
  readonly complementLegId: PairLegId;
  readonly effects: readonly [SerialEffectIntent];
  readonly complement: { readonly state: "PLANNED"; readonly effectId: null; readonly decisionId: null };
  readonly planHash: string;
}

export interface PlanSerialActivationInput {
  readonly groupId: PairGroupId;
  readonly dispatchModel: SerialDispatchModel;
  readonly observationId: PairObservationId;
  readonly activationDecisionId: string;
  readonly activationCaptureId: PairCaptureId;
  readonly activationQuoteHash: string;
  readonly actionSequence: number;
  readonly targetGrossShares6: bigint;
}

export type SerialInitialResultEvidence =
  | {
      readonly kind: "FILLED";
      readonly evidenceKey: string;
      readonly actualDispatchAtMs: number;
      readonly filledGrossShares6: bigint;
      readonly receivedNetShares6: bigint;
      readonly cashDebit6: bigint;
    }
  | {
      readonly kind: SerialZeroFillResult;
      readonly evidenceKey: string;
      readonly actualDispatchAtMs: number;
      readonly filledGrossShares6: 0n;
    }
  | { readonly kind: "UNKNOWN"; readonly evidenceKey: string; readonly actualDispatchAtMs: number };

export interface SerialComplementScheduled {
  readonly kind: "SERIAL_COMPLEMENT_SCHEDULED";
  readonly activation: SerialActivationPlan;
  readonly firstEvidenceKey: string;
  readonly firstActualDispatchAtMs: number;
  readonly firstFilledGrossShares6: bigint;
  readonly firstReceivedNetShares6: bigint;
  readonly firstCashDebit6: bigint;
  readonly complementDueAtMs: number;
  readonly complementOutcome: PairOutcome;
}

export type SerialInitialResult =
  | SerialComplementScheduled
  | {
      readonly kind: "SERIAL_NO_INITIAL_FILL";
      readonly groupId: PairGroupId;
      readonly firstOutcome: PairOutcome;
      readonly complementOutcome: PairOutcome;
      readonly complementState: "SKIPPED";
      readonly reason: SerialZeroFillResult;
      readonly effects: readonly [];
    }
  | {
      readonly kind: "SERIAL_BLOCKED_UNKNOWN";
      readonly groupId: PairGroupId;
      readonly unknownOutcome: PairOutcome;
      readonly blockedOutcome: PairOutcome;
      readonly evidenceKey: string;
      readonly effects: readonly [];
    }
  | { readonly kind: "INVARIANT_BREACH"; readonly code: string; readonly description: string };

export interface SerialAsOfQuote {
  readonly captureId: PairCaptureId;
  readonly captureCapturedAtMs: number;
  readonly causalCutoffMs: number;
  readonly quoteCaptureId: PairCaptureId;
  readonly quoteHash: string;
}

export type SerialComplementDecision =
  | {
      readonly kind: "APPROVED";
      readonly permitId: string;
      readonly requestedGrossShares6: bigint;
      readonly asOf: SerialAsOfQuote;
    }
  | { readonly kind: "REJECTED"; readonly reasonCodes: readonly string[]; readonly asOf: SerialAsOfQuote };

export interface PlanSerialComplementInput {
  readonly scheduled: SerialComplementScheduled;
  readonly decisionAtMs: number;
  readonly actionSequence: number;
  readonly decision: SerialComplementDecision;
}

export type SerialComplementPlan =
  | {
      readonly kind: "SERIAL_COMPLEMENT_READY";
      readonly groupId: PairGroupId;
      readonly outcome: PairOutcome;
      readonly decisionId: string;
      readonly actionSequence: number;
      readonly decisionAtMs: number;
      readonly decisionCaptureId: PairCaptureId;
      readonly decisionQuoteHash: string;
      readonly causalCutoffMs: number;
      readonly effects: readonly [SerialEffectIntent];
      readonly planHash: string;
    }
  | {
      readonly kind: "SERIAL_RESIDUAL";
      readonly groupId: PairGroupId;
      readonly residualOutcome: PairOutcome;
      readonly skippedOutcome: PairOutcome;
      readonly decisionId: string;
      readonly decisionAtMs: number;
      readonly decisionCaptureId: PairCaptureId;
      readonly decisionQuoteHash: string;
      readonly causalCutoffMs: number;
      readonly reasonCodes: readonly string[];
      readonly effects: readonly [];
    };

export type SerialComplementResultEvidence =
  | {
      readonly kind: "FILLED";
      readonly evidenceKey: string;
      readonly filledGrossShares6: bigint;
      readonly receivedNetShares6: bigint;
      readonly cashDebit6: bigint;
    }
  | { readonly kind: SerialZeroFillResult; readonly evidenceKey: string; readonly filledGrossShares6: 0n }
  | { readonly kind: "UNKNOWN"; readonly evidenceKey: string };

export type SerialComplementResult =
  | {
      readonly kind: "SERIAL_PAIRED";
      readonly groupId: PairGroupId;
      readonly firstOutcome: PairOutcome;
      readonly complementOutcome: PairOutcome;
      readonly evidenceKey: string;
    }
  | {
      readonly kind: "SERIAL_RESIDUAL";
      readonly groupId: PairGroupId;
      readonly residualOutcome: PairOutcome;
      readonly failedOutcome: PairOutcome;
      readonly reason: SerialZeroFillResult;
      readonly evidenceKey: string;
    }
  | {
      readonly kind: "SERIAL_BLOCKED_UNKNOWN";
      readonly groupId: PairGroupId;
      readonly unknownOutcome: PairOutcome;
      readonly evidenceKey: string;
    }
  | { readonly kind: "INVARIANT_BREACH"; readonly code: string; readonly description: string };

function assertIdentity(value: string, label: string): void {
  if (value.length === 0) throw new TypeError(`${label} must not be empty`);
}

function assertSafeTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
}

function assertActionSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("actionSequence must be a non-negative safe integer");
}

function outcomes(model: SerialDispatchModel): readonly [PairOutcome, PairOutcome] {
  return model === "UP_THEN_DOWN" ? ["UP", "DOWN"] : ["DOWN", "UP"];
}

function serialId(prefix: string, value: unknown): string {
  return `${prefix}_${canonicalObjectHash(value).slice(0, 32)}`;
}

function effectIntent(input: {
  readonly groupId: PairGroupId;
  readonly outcome: PairOutcome;
  readonly decisionId: string;
  readonly actionSequence: number;
  readonly captureId: PairCaptureId;
  readonly quoteHash: string;
  readonly requestedGrossShares6: bigint;
  readonly actionKind: "SERIAL_FIRST_FOK" | "SERIAL_COMPLEMENT_FOK";
  readonly permitId: string | null;
}): SerialEffectIntent {
  const legId = pairLegId(input.groupId, input.outcome);
  const actionId = serialId("pact", {
    groupId: input.groupId,
    decisionId: input.decisionId,
    actionSequence: input.actionSequence,
    outcome: input.outcome,
    actionKind: input.actionKind,
    permitId: input.permitId,
  });
  const request = {
    groupId: input.groupId,
    legId,
    outcome: input.outcome,
    decisionId: input.decisionId,
    actionId,
    actionSequence: input.actionSequence,
    captureId: input.captureId,
    quoteHash: input.quoteHash,
    requestedGrossShares6: input.requestedGrossShares6,
    effectOrdinal: 0,
  } as const;
  const requestHash = immutableRequestHash(request);
  const idempotencyKey = effectIdempotencyKey({
    groupId: input.groupId,
    actionKind: input.actionKind,
    actionSequence: BigInt(input.actionSequence),
    effectOrdinal: 0,
    immutableRequestHash: requestHash,
  });
  return Object.freeze({
    effectId: serialId("peff", { idempotencyKey, requestHash }),
    idempotencyKey,
    requestHash,
    actionId,
    decisionId: input.decisionId,
    clientOrderId: pairClientOrderId(legId, input.actionSequence),
    legId,
    outcome: input.outcome,
    actionKind: input.actionKind,
    permitId: input.permitId,
    captureId: input.captureId,
    quoteHash: input.quoteHash,
    requestedGrossShares6: input.requestedGrossShares6,
    effectOrdinal: 0,
    increasesExposure: true,
  });
}

export function planSerialActivation(input: PlanSerialActivationInput): SerialActivationPlan {
  assertIdentity(input.groupId, "groupId");
  assertIdentity(input.observationId, "observationId");
  assertIdentity(input.activationDecisionId, "activationDecisionId");
  assertIdentity(input.activationCaptureId, "activationCaptureId");
  assertIdentity(input.activationQuoteHash, "activationQuoteHash");
  if (input.dispatchModel !== "UP_THEN_DOWN" && input.dispatchModel !== "DOWN_THEN_UP") {
    throw new TypeError("serial activation requires a serial dispatch model");
  }
  assertActionSequence(input.actionSequence);
  if (input.targetGrossShares6 <= 0n) throw new RangeError("targetGrossShares6 must be positive");
  const [firstOutcome, complementOutcome] = outcomes(input.dispatchModel);
  const effect = effectIntent({
    groupId: input.groupId,
    outcome: firstOutcome,
    decisionId: input.activationDecisionId,
    actionSequence: input.actionSequence,
    captureId: input.activationCaptureId,
    quoteHash: input.activationQuoteHash,
    requestedGrossShares6: input.targetGrossShares6,
    actionKind: "SERIAL_FIRST_FOK",
    permitId: null,
  });
  const material = {
    groupId: input.groupId,
    dispatchModel: input.dispatchModel,
    observationId: input.observationId,
    activationDecisionId: input.activationDecisionId,
    activationCaptureId: input.activationCaptureId,
    activationQuoteHash: input.activationQuoteHash,
    actionSequence: input.actionSequence,
    targetGrossShares6: input.targetGrossShares6,
    firstOutcome,
    complementOutcome,
    firstLegId: effect.legId,
    complementLegId: pairLegId(input.groupId, complementOutcome),
    effects: Object.freeze([effect]) as readonly [SerialEffectIntent],
    complement: Object.freeze({ state: "PLANNED", effectId: null, decisionId: null } as const),
  };
  return Object.freeze({ kind: "SERIAL_ACTIVATION_READY", ...material, planHash: canonicalObjectHash(material) });
}

export function applySerialInitialResult(
  activation: SerialActivationPlan,
  result: SerialInitialResultEvidence,
  interLegDelayMs: number,
): SerialInitialResult {
  assertSafeTime(result.actualDispatchAtMs, "actualDispatchAtMs");
  assertSafeTime(interLegDelayMs, "interLegDelayMs");
  assertIdentity(result.evidenceKey, "evidenceKey");
  if (result.kind === "UNKNOWN") {
    return Object.freeze({
      kind: "SERIAL_BLOCKED_UNKNOWN",
      groupId: activation.groupId,
      unknownOutcome: activation.firstOutcome,
      blockedOutcome: activation.complementOutcome,
      evidenceKey: result.evidenceKey,
      effects: [] as const,
    });
  }
  if (result.kind !== "FILLED") {
    if (result.filledGrossShares6 !== 0n) {
      return { kind: "INVARIANT_BREACH", code: "INITIAL_FOK_NOT_ALL_OR_ZERO", description: "zero-fill terminal result reported shares" };
    }
    return Object.freeze({
      kind: "SERIAL_NO_INITIAL_FILL",
      groupId: activation.groupId,
      firstOutcome: activation.firstOutcome,
      complementOutcome: activation.complementOutcome,
      complementState: "SKIPPED",
      reason: result.kind,
      effects: [] as const,
    });
  }
  if (
    result.filledGrossShares6 !== activation.targetGrossShares6 ||
    result.receivedNetShares6 <= 0n ||
    result.receivedNetShares6 > result.filledGrossShares6 ||
    result.cashDebit6 < 0n
  ) {
    return { kind: "INVARIANT_BREACH", code: "INITIAL_FOK_NOT_ALL_OR_ZERO", description: "filled first leg violates the immutable FOK request" };
  }
  const complementDueAtMs = result.actualDispatchAtMs + interLegDelayMs;
  if (!Number.isSafeInteger(complementDueAtMs)) throw new RangeError("serial complement due time exceeds safe integer range");
  return Object.freeze({
    kind: "SERIAL_COMPLEMENT_SCHEDULED",
    activation,
    firstEvidenceKey: result.evidenceKey,
    firstActualDispatchAtMs: result.actualDispatchAtMs,
    firstFilledGrossShares6: result.filledGrossShares6,
    firstReceivedNetShares6: result.receivedNetShares6,
    firstCashDebit6: result.cashDebit6,
    complementDueAtMs,
    complementOutcome: activation.complementOutcome,
  });
}

function validateAsOf(scheduled: SerialComplementScheduled, decisionAtMs: number, asOf: SerialAsOfQuote): void {
  assertSafeTime(decisionAtMs, "decisionAtMs");
  assertSafeTime(asOf.captureCapturedAtMs, "captureCapturedAtMs");
  assertSafeTime(asOf.causalCutoffMs, "causalCutoffMs");
  if (decisionAtMs < scheduled.complementDueAtMs) throw new RangeError("serial complement decision precedes its durable due time");
  if (asOf.causalCutoffMs > decisionAtMs || asOf.captureCapturedAtMs > asOf.causalCutoffMs) {
    throw new RangeError("serial complement capture is not causally as-of the decision cutoff");
  }
  if (asOf.captureId === scheduled.activation.activationCaptureId) {
    throw new TypeError("serial complement requires a new capture identity");
  }
  if (asOf.quoteCaptureId !== asOf.captureId) throw new TypeError("serial complement quote is bound to a different capture");
  assertIdentity(asOf.quoteHash, "quoteHash");
}

export function planSerialComplement(input: PlanSerialComplementInput): SerialComplementPlan {
  assertActionSequence(input.actionSequence);
  validateAsOf(input.scheduled, input.decisionAtMs, input.decision.asOf);
  const decisionId = serialId("pdec", {
    groupId: input.scheduled.activation.groupId,
    firstEvidenceKey: input.scheduled.firstEvidenceKey,
    dueAtMs: input.scheduled.complementDueAtMs,
    decisionAtMs: input.decisionAtMs,
    captureId: input.decision.asOf.captureId,
    quoteHash: input.decision.asOf.quoteHash,
    outcome: input.scheduled.complementOutcome,
    actionSequence: input.actionSequence,
  });
  if (input.decision.kind === "REJECTED") {
    if (input.decision.reasonCodes.length === 0) throw new TypeError("rejected complement decision requires reasons");
    return Object.freeze({
      kind: "SERIAL_RESIDUAL",
      groupId: input.scheduled.activation.groupId,
      residualOutcome: input.scheduled.activation.firstOutcome,
      skippedOutcome: input.scheduled.complementOutcome,
      decisionId,
      decisionAtMs: input.decisionAtMs,
      decisionCaptureId: input.decision.asOf.captureId,
      decisionQuoteHash: input.decision.asOf.quoteHash,
      causalCutoffMs: input.decision.asOf.causalCutoffMs,
      reasonCodes: Object.freeze([...input.decision.reasonCodes]),
      effects: [] as const,
    });
  }
  assertIdentity(input.decision.permitId, "permitId");
  if (
    input.decision.requestedGrossShares6 <= 0n ||
    input.decision.requestedGrossShares6 > input.scheduled.firstFilledGrossShares6
  ) {
    throw new RangeError("serial complement quantity must be positive and cannot resize upward");
  }
  const effect = effectIntent({
    groupId: input.scheduled.activation.groupId,
    outcome: input.scheduled.complementOutcome,
    decisionId,
    actionSequence: input.actionSequence,
    captureId: input.decision.asOf.captureId,
    quoteHash: input.decision.asOf.quoteHash,
    requestedGrossShares6: input.decision.requestedGrossShares6,
    actionKind: "SERIAL_COMPLEMENT_FOK",
    permitId: input.decision.permitId,
  });
  const material = {
    groupId: input.scheduled.activation.groupId,
    outcome: input.scheduled.complementOutcome,
    decisionId,
    actionSequence: input.actionSequence,
    decisionAtMs: input.decisionAtMs,
    decisionCaptureId: input.decision.asOf.captureId,
    decisionQuoteHash: input.decision.asOf.quoteHash,
    causalCutoffMs: input.decision.asOf.causalCutoffMs,
    effects: Object.freeze([effect]) as readonly [SerialEffectIntent],
  };
  return Object.freeze({ kind: "SERIAL_COMPLEMENT_READY", ...material, planHash: canonicalObjectHash(material) });
}

export function applySerialComplementResult(
  scheduled: SerialComplementScheduled,
  plan: Extract<SerialComplementPlan, { readonly kind: "SERIAL_COMPLEMENT_READY" }>,
  result: SerialComplementResultEvidence,
): SerialComplementResult {
  assertIdentity(result.evidenceKey, "evidenceKey");
  if (plan.groupId !== scheduled.activation.groupId || plan.outcome !== scheduled.complementOutcome) {
    throw new TypeError("serial complement plan does not belong to the scheduled group/outcome");
  }
  if (result.kind === "UNKNOWN") {
    return Object.freeze({
      kind: "SERIAL_BLOCKED_UNKNOWN",
      groupId: plan.groupId,
      unknownOutcome: plan.outcome,
      evidenceKey: result.evidenceKey,
    });
  }
  if (result.kind !== "FILLED") {
    if (result.filledGrossShares6 !== 0n) {
      return { kind: "INVARIANT_BREACH", code: "INITIAL_FOK_NOT_ALL_OR_ZERO", description: "zero-fill complement result reported shares" };
    }
    return Object.freeze({
      kind: "SERIAL_RESIDUAL",
      groupId: plan.groupId,
      residualOutcome: scheduled.activation.firstOutcome,
      failedOutcome: plan.outcome,
      reason: result.kind,
      evidenceKey: result.evidenceKey,
    });
  }
  const requested = plan.effects[0].requestedGrossShares6;
  if (
    result.filledGrossShares6 !== requested ||
    result.receivedNetShares6 <= 0n ||
    result.receivedNetShares6 > result.filledGrossShares6 ||
    result.cashDebit6 < 0n
  ) {
    return { kind: "INVARIANT_BREACH", code: "INITIAL_FOK_NOT_ALL_OR_ZERO", description: "filled complement violates the immutable FOK request" };
  }
  return Object.freeze({
    kind: "SERIAL_PAIRED",
    groupId: plan.groupId,
    firstOutcome: scheduled.activation.firstOutcome,
    complementOutcome: plan.outcome,
    evidenceKey: result.evidenceKey,
  });
}
