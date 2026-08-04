import type { BookLevel } from "@b5p/domain";
import {
  buildCandidateFrontier,
  buildPairCapture,
  canonicalObjectHash,
  composePairQuote,
  evaluatePairRisk,
  finalizePairQuote,
  pairSizeObjectiveV1,
  quoteDepthStressGrid,
  quoteDirectBuy,
  quoteTickStress,
  type PairBookCapture,
  type PairMarketContext,
  type PairPolicySnapshot,
  type PairPortfolioSnapshot,
  type PairQuote,
  type PairRejection,
  type PairRejectionCode,
  type PairRiskDecision,
  type PairTokenTerms,
  type PairTokenTermsProvider,
} from "@b5p/pair-execution";
import { canonicalBookHash, type ImmutableBookView } from "@b5p/strategy";

/** Exact causal boundary committed with an activation decision. */
export interface PairActivationCutoff {
  readonly receiveSequence: bigint;
  readonly dataCutoffEventId: string | null;
  readonly dataCutoffEnvelopeId: string | null;
}

/**
 * A complete paired state reconstructed by a durable event reader. Both legs
 * must describe the state after `completedReceiveSequence`, never a later
 * state. The activation module validates this boundary again before use.
 */
export interface PairActivationBookSelection {
  readonly completedReceiveSequence: bigint;
  readonly up: ImmutableBookView;
  readonly down: ImmutableBookView;
}

export interface PairActivationBookSource {
  latestCompleteAtOrBefore(input: {
    readonly marketId: string;
    readonly upTokenId: string;
    readonly downTokenId: string;
    readonly dispatchedAtMs: number;
    readonly cutoffReceiveSequence: bigint;
  }): Promise<PairActivationBookSelection | null>;
}

/** Term changes may only be accepted when the caller represents a wholly new decision. */
export type PairActivationDecisionRepresentation =
  | { readonly kind: "REVALIDATE_SIGNAL" }
  | { readonly kind: "NEW_ACTIVATION_DECISION"; readonly decisionId: string };

export interface PairSignalActivationAuthority {
  readonly signalCaptureId: string;
  readonly signalCaptureHash: string;
  readonly signalQuoteHash: string;
  readonly approvedGrossShares6: bigint;
  readonly policyHash: string;
  readonly rulesHash: string;
  readonly permitExpiresAtMs: number;
}

export type PairActivationCode =
  | PairRejectionCode
  | "ACTIVATION_CAUSALITY_VIOLATION"
  | "ACTIVATION_SIGNAL_LIMIT_INVALID"
  | "ACTIVATION_POLICY_CHANGED"
  | "ACTIVATION_RULES_CHANGED"
  | "ACTIVATION_PERMIT_EXPIRED"
  | "ACTIVATION_RISK_REJECTED";

export interface PairActivationReason {
  readonly code: PairActivationCode;
  readonly description: string;
}

export interface PairActivationTermChange {
  readonly outcome: "UP" | "DOWN";
  readonly kind: "FEE" | "CONSTRAINT";
  readonly previousSnapshotId: string;
  readonly currentSnapshotId: string;
}

export interface PairActivationGateResult {
  readonly kind: "APPROVED" | "REJECTED";
  readonly reasons: readonly PairActivationReason[];
}

/** Immutable result payload suitable for the caller's atomic persistence transaction. */
export interface PairActivationDecisionData {
  readonly schemaVersion: 1;
  readonly kind: "complete_set_pair_activation_v1";
  readonly groupId: string;
  readonly scheduledDueMs: number;
  readonly actualDispatchMs: number;
  readonly cutoff: PairActivationCutoff;
  readonly decisionRepresentation: PairActivationDecisionRepresentation;
  readonly signalAuthority: PairSignalActivationAuthority;
  readonly activationCapture: PairBookCapture | null;
  readonly currentTerms: { readonly up: PairTokenTerms; readonly down: PairTokenTerms } | null;
  readonly termChanges: readonly PairActivationTermChange[];
  readonly selectedGrossShares6: bigint | null;
  readonly quote: PairQuote | null;
  readonly riskDecision: PairRiskDecision;
  readonly gateResult: PairActivationGateResult;
}

export type PairActivationResult =
  | { readonly kind: "APPROVED"; readonly data: PairActivationDecisionData }
  | { readonly kind: "REJECTED"; readonly data: PairActivationDecisionData };

export interface RequotePairActivationInput {
  readonly groupId: string;
  readonly scheduledDueMs: number;
  readonly actualDispatchMs: number;
  readonly activationCaptureSequence: bigint;
  readonly cutoff: PairActivationCutoff;
  /** Current market flags plus the token terms captured by the signal decision. */
  readonly market: PairMarketContext;
  readonly signalAuthority: PairSignalActivationAuthority;
  readonly decisionRepresentation: PairActivationDecisionRepresentation;
  readonly policy: PairPolicySnapshot;
  /** A current activation-risk view scoped so this scheduled group is not counted twice. */
  readonly portfolioForRisk: PairPortfolioSnapshot;
  readonly engineHalted: boolean;
  readonly activationPermitId: string;
  readonly bookSource: PairActivationBookSource;
  readonly termsProvider: PairTokenTermsProvider;
}

const freezeReason = (code: PairActivationCode, description: string): PairActivationReason =>
  Object.freeze({ code, description });

function rejectedDecision(
  input: RequotePairActivationInput,
  reasons: readonly PairActivationReason[],
  partial: {
    readonly capture?: PairBookCapture | null;
    readonly terms?: { readonly up: PairTokenTerms; readonly down: PairTokenTerms } | null;
    readonly changes?: readonly PairActivationTermChange[];
    readonly quote?: PairQuote | null;
    readonly risk?: PairRiskDecision;
  } = {},
): PairActivationResult {
  const frozenReasons = Object.freeze(reasons.slice());
  return Object.freeze({
    kind: "REJECTED",
    data: Object.freeze({
      schemaVersion: 1,
      kind: "complete_set_pair_activation_v1",
      groupId: input.groupId,
      scheduledDueMs: input.scheduledDueMs,
      actualDispatchMs: input.actualDispatchMs,
      cutoff: Object.freeze({ ...input.cutoff }),
      decisionRepresentation: Object.freeze({ ...input.decisionRepresentation }),
      signalAuthority: Object.freeze({ ...input.signalAuthority }),
      activationCapture: partial.capture ?? null,
      currentTerms: partial.terms ?? null,
      termChanges: Object.freeze((partial.changes ?? []).slice()),
      selectedGrossShares6: partial.quote?.pairGrossShares6 ?? null,
      quote: partial.quote ?? null,
      riskDecision: partial.risk ?? Object.freeze({
        kind: "REJECTED",
        reasons: Object.freeze(frozenReasons.map((entry) => Object.freeze({
          code: isPairRejectionCode(entry.code) ? entry.code : "ACTIVATION_QUOTE_FAILED",
          description: entry.description,
        }))),
      }),
      gateResult: Object.freeze({ kind: "REJECTED", reasons: frozenReasons }),
    }),
  });
}

// Local activation-only codes intentionally do not leak into the pure package's
// ordinary PairRejection union used by persisted risk decisions.
function isPairRejectionCode(code: PairActivationCode): code is PairRejectionCode {
  return code !== "ACTIVATION_CAUSALITY_VIOLATION"
    && code !== "ACTIVATION_SIGNAL_LIMIT_INVALID"
    && code !== "ACTIVATION_POLICY_CHANGED"
    && code !== "ACTIVATION_RULES_CHANGED"
    && code !== "ACTIVATION_PERMIT_EXPIRED"
    && code !== "ACTIVATION_RISK_REJECTED";
}

function termChanges(signal: PairMarketContext, current: { up: PairTokenTerms; down: PairTokenTerms }): readonly PairActivationTermChange[] {
  const changes: PairActivationTermChange[] = [];
  for (const outcome of ["UP", "DOWN"] as const) {
    const before = outcome === "UP" ? signal.up : signal.down;
    const after = outcome === "UP" ? current.up : current.down;
    const feeChanged = before.fee.snapshotId !== after.fee.snapshotId
      || before.fee.canonicalHash !== after.fee.canonicalHash
      || before.fee.tokenFeeRatePpm !== after.fee.tokenFeeRatePpm
      || before.fee.convention !== after.fee.convention
      || before.fee.conventionResolverVersion !== after.fee.conventionResolverVersion;
    const constraintChanged = before.constraints.snapshotId !== after.constraints.snapshotId
      || before.constraints.canonicalHash !== after.constraints.canonicalHash
      || before.constraints.tickSize6 !== after.constraints.tickSize6
      || before.constraints.minimumOrderShares6 !== after.constraints.minimumOrderShares6;
    if (feeChanged) changes.push(Object.freeze({
      outcome, kind: "FEE", previousSnapshotId: before.fee.snapshotId, currentSnapshotId: after.fee.snapshotId,
    }));
    if (constraintChanged) changes.push(Object.freeze({
      outcome, kind: "CONSTRAINT", previousSnapshotId: before.constraints.snapshotId, currentSnapshotId: after.constraints.snapshotId,
    }));
  }
  return Object.freeze(changes);
}

function bookLevels(levels: PairBookCapture["up"]["asks"]): readonly BookLevel[] {
  return Object.freeze(levels.map((level) => Object.freeze({ price: level.price6, size: level.shares6 })));
}

function categoricalReasons(input: RequotePairActivationInput): PairActivationReason[] {
  const reasons: PairActivationReason[] = [];
  if (input.engineHalted) reasons.push(freezeReason("ENGINE_HALTED", "engine halt is active at activation dispatch"));
  if (input.policy.policyHash !== input.signalAuthority.policyHash) reasons.push(freezeReason("ACTIVATION_POLICY_CHANGED", "policy hash changed after the signal decision"));
  if (input.market.rulesHash !== input.signalAuthority.rulesHash) reasons.push(freezeReason("ACTIVATION_RULES_CHANGED", "market rules hash changed after the signal decision"));
  if (input.actualDispatchMs > input.signalAuthority.permitExpiresAtMs) reasons.push(freezeReason("ACTIVATION_PERMIT_EXPIRED", "signal risk permit expired before activation dispatch"));
  if (!input.market.acceptingOrders) reasons.push(freezeReason("MARKET_NOT_ACCEPTING_ORDERS", "market is not accepting orders at activation"));
  if (!input.market.rulesVerified) reasons.push(freezeReason("RULES_UNVERIFIED", "market rules are not verified at activation"));
  if (!input.market.invalidOrVoidPolicyVerified) reasons.push(freezeReason("VOID_POLICY_UNVERIFIED", "invalid/void policy is not verified at activation"));
  if (input.market.negRisk) reasons.push(freezeReason("NEG_RISK_UNSUPPORTED", "negative-risk market structure is unsupported"));
  if (input.market.marketStructure !== "BINARY_EXHAUSTIVE_MUTUALLY_EXCLUSIVE") reasons.push(freezeReason("MARKET_STRUCTURE_UNSUPPORTED", "market is not verified binary/exhaustive/mutually-exclusive"));
  if (input.market.resolutionSource !== "CHAINLINK") reasons.push(freezeReason("RESOLUTION_SOURCE_UNSUPPORTED", "resolution source is unsupported"));
  if (typeof input.signalAuthority.approvedGrossShares6 !== "bigint" || input.signalAuthority.approvedGrossShares6 <= 0n) {
    reasons.push(freezeReason("ACTIVATION_SIGNAL_LIMIT_INVALID", "signal-approved gross quantity must be positive"));
  }
  return reasons;
}

interface ApprovedCandidate {
  readonly quote: PairQuote;
  readonly risk: Extract<PairRiskDecision, { readonly kind: "APPROVED" }>;
}

interface RejectedCandidate {
  readonly quote: PairQuote;
  readonly risk: Extract<PairRiskDecision, { readonly kind: "REJECTED" }>;
}

function compareCandidateQuotes(left: PairQuote, right: PairQuote): number {
  return pairSizeObjectiveV1(
    { quote: left, oneTickWorseNetPnl6: left.oneTickWorse.kind === "EXECUTABLE" ? left.oneTickWorse.netPnl6 : -(1n << 255n) },
    { quote: right, oneTickWorseNetPnl6: right.oneTickWorse.kind === "EXECUTABLE" ? right.oneTickWorse.netPnl6 : -(1n << 255n) },
  );
}

/**
 * Pure-orchestration activation requote. It reads immutable evidence and
 * returns decision data only; it never creates orders, venue effects, or
 * persistence mutations itself.
 */
export async function requotePairActivation(input: RequotePairActivationInput): Promise<PairActivationResult> {
  const early = categoricalReasons(input);
  if (early.length > 0) return rejectedDecision(input, early);

  const selection = await input.bookSource.latestCompleteAtOrBefore({
    marketId: input.market.marketId,
    upTokenId: input.market.up.tokenId,
    downTokenId: input.market.down.tokenId,
    dispatchedAtMs: input.actualDispatchMs,
    cutoffReceiveSequence: input.cutoff.receiveSequence,
  });
  if (selection === null) {
    return rejectedDecision(input, [freezeReason("ACTIVATION_DATA_UNAVAILABLE", "no complete pair book exists at or before the activation cutoff")]);
  }
  if (
    selection.completedReceiveSequence > input.cutoff.receiveSequence
    || selection.up.receivedTsMs > input.actualDispatchMs
    || selection.down.receivedTsMs > input.actualDispatchMs
  ) {
    return rejectedDecision(input, [freezeReason("ACTIVATION_CAUSALITY_VIOLATION", "book source returned evidence after the activation causal boundary")]);
  }

  const captureResult = buildPairCapture({
    marketId: input.market.marketId,
    conditionId: input.market.conditionId,
    expectedUpTokenId: input.market.up.tokenId,
    expectedDownTokenId: input.market.down.tokenId,
    capturedAtMs: input.actualDispatchMs,
    captureSequence: input.activationCaptureSequence,
    mode: "paper",
    policy: input.policy,
    up: selection.up,
    down: selection.down,
  });
  if (captureResult.kind === "REJECTED") {
    return rejectedDecision(input, captureResult.reasons.map((entry) => freezeReason(entry.code, entry.description)));
  }
  const capture = captureResult.capture;

  const termsResult = await input.termsProvider.currentTerms({
    marketId: input.market.marketId,
    conditionId: input.market.conditionId,
    upTokenId: input.market.up.tokenId,
    downTokenId: input.market.down.tokenId,
    asOfMs: input.actualDispatchMs,
  });
  if (termsResult.kind === "REJECTED") {
    return rejectedDecision(input, [freezeReason(termsResult.code, termsResult.detail)], { capture });
  }
  const terms = Object.freeze({ up: termsResult.up, down: termsResult.down });
  const termIdentityReasons: PairActivationReason[] = [];
  for (const [label, expected, current] of [
    ["UP", input.market.up.tokenId, terms.up],
    ["DOWN", input.market.down.tokenId, terms.down],
  ] as const) {
    if (current.outcome !== label || current.tokenId !== expected || current.fee.tokenId !== expected) {
      termIdentityReasons.push(freezeReason("FEE_SNAPSHOT_TOKEN_MISMATCH", `${label} fee terms do not match token ${expected}`));
    }
    if (current.outcome !== label || current.tokenId !== expected || current.constraints.tokenId !== expected) {
      termIdentityReasons.push(freezeReason("CONSTRAINT_SNAPSHOT_TOKEN_MISMATCH", `${label} constraint terms do not match token ${expected}`));
    }
  }
  if (termIdentityReasons.length > 0) return rejectedDecision(input, termIdentityReasons, { capture, terms });
  const changes = termChanges(input.market, terms);
  const representsNewDecision = input.decisionRepresentation.kind === "NEW_ACTIVATION_DECISION"
    && input.decisionRepresentation.decisionId.trim().length > 0;
  if (changes.length > 0 && !representsNewDecision) {
    const reasons = changes.map((change) => freezeReason(
      change.kind === "FEE" ? "ACTIVATION_FEE_CHANGED" : "ACTIVATION_CONSTRAINT_CHANGED",
      `${change.outcome} ${change.kind.toLowerCase()} snapshot changed from ${change.previousSnapshotId} to ${change.currentSnapshotId}`,
    ));
    return rejectedDecision(input, reasons, { capture, terms, changes });
  }
  if (terms.up.fee.convention !== "USDC" || terms.down.fee.convention !== "USDC") {
    return rejectedDecision(input, [freezeReason("UNSUPPORTED_PAPER_FEE_COLLECTION", "pair paper activation requires USDC-collected fees on both legs")], { capture, terms, changes });
  }

  const maximumPairShares6 = input.policy.maximumPairShares6 === null
    || input.signalAuthority.approvedGrossShares6 < input.policy.maximumPairShares6
    ? input.signalAuthority.approvedGrossShares6
    : input.policy.maximumPairShares6;
  const frontier = buildCandidateFrontier({
    upAsks: bookLevels(capture.up.asks),
    downAsks: bookLevels(capture.down.asks),
    pairShareLot6: input.policy.pairShareLot6,
    upMinimumOrderShares6: terms.up.constraints.minimumOrderShares6,
    downMinimumOrderShares6: terms.down.constraints.minimumOrderShares6,
    maximumPairShares6,
  });
  if (!frontier.ok || frontier.candidates6.length === 0) {
    return rejectedDecision(input, [freezeReason("ACTIVATION_QUOTE_FAILED", frontier.ok ? "no executable activation quantity exists at or below the signal-approved quantity" : frontier.detail)], { capture, terms, changes });
  }

  const upLevels = bookLevels(capture.up.asks);
  const downLevels = bookLevels(capture.down.asks);
  const upBookRef = Object.freeze({
    tokenId: capture.up.tokenId, bookVersion: capture.up.bookVersion, connectionEpoch: capture.up.connectionEpoch,
    sourceEventId: capture.up.sourceEventId, contentHash: canonicalBookHash(selection.up),
  });
  const downBookRef = Object.freeze({
    tokenId: capture.down.tokenId, bookVersion: capture.down.bookVersion, connectionEpoch: capture.down.connectionEpoch,
    sourceEventId: capture.down.sourceEventId, contentHash: canonicalBookHash(selection.down),
  });
  const upFee = Object.freeze({ ratePpm: terms.up.fee.tokenFeeRatePpm, collection: terms.up.fee.convention.toLowerCase() });
  const downFee = Object.freeze({ ratePpm: terms.down.fee.tokenFeeRatePpm, collection: terms.down.fee.convention.toLowerCase() });

  const approved: ApprovedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  const safelyKnownRiskReasons = new Map<string, PairRejection>();
  for (const pairGrossShares6 of frontier.candidates6) {
    // Defense in depth: no source/frontier defect may enlarge signal authority.
    if (pairGrossShares6 > input.signalAuthority.approvedGrossShares6) continue;
    const up = quoteDirectBuy({ levels: upLevels, requestedShares6: pairGrossShares6, fee: upFee, timeInForce: "FOK", bookRef: upBookRef });
    const down = quoteDirectBuy({ levels: downLevels, requestedShares6: pairGrossShares6, fee: downFee, timeInForce: "FOK", bookRef: downBookRef });
    if (!up.ok || !down.ok || !up.quote.fullyExecutable || !down.quote.fullyExecutable) continue;
    const composed = composePairQuote({
      captureId: capture.captureId,
      pairGrossShares6,
      up: { outcome: "UP", tokenId: terms.up.tokenId, quote: up.quote },
      down: { outcome: "DOWN", tokenId: terms.down.tokenId, quote: down.quote },
      modeledNonrefundableSettlementCost6: input.policy.modeledSettlementCost6,
      settlementCashReserve6: input.policy.settlementCashReserve6,
      recoveryCashReserve6: input.policy.recoveryReserve6,
      operationalRiskHaircut6: input.policy.operationalRiskHaircut6,
    });
    if (!composed.ok || composed.quote.grossWalkEdge6 <= 0n) continue;
    const stressInput = {
      captureId: capture.captureId,
      pairGrossShares6,
      up: { tokenId: terms.up.tokenId, levels: upLevels, tickSize6: terms.up.constraints.tickSize6, fee: upFee, bookRef: upBookRef },
      down: { tokenId: terms.down.tokenId, levels: downLevels, tickSize6: terms.down.constraints.tickSize6, fee: downFee, bookRef: downBookRef },
      modeledNonrefundableSettlementCost6: input.policy.modeledSettlementCost6,
      settlementCashReserve6: input.policy.settlementCashReserve6,
      recoveryCashReserve6: input.policy.recoveryReserve6,
      operationalRiskHaircut6: input.policy.operationalRiskHaircut6,
    } as const;
    const oneTickWorse = quoteTickStress(stressInput, 1);
    const twoTicksWorse = quoteTickStress(stressInput, 2);
    const depthStress = quoteDepthStressGrid(stressInput, input.policy.depthStressFractionsPpm);
    const quote = finalizePairQuote({ captureId: capture.captureId, economics: composed.quote, oneTickWorse, twoTicksWorse, depthStress });
    const risk = evaluatePairRisk({
      marketId: input.market.marketId,
      quoteHash: quote.quoteHash,
      quote,
      oneTickWorse,
      twoTicksWorse,
      portfolio: input.portfolioForRisk,
      policy: input.policy,
      nowMs: input.actualDispatchMs,
      permitId: input.activationPermitId,
      secondsRemaining: Math.floor((input.market.endsAtMs - input.actualDispatchMs) / 1_000),
      termsHealthy: true,
    });
    if (risk.kind === "APPROVED") approved.push(Object.freeze({ quote, risk }));
    else {
      rejected.push(Object.freeze({ quote, risk }));
      for (const entry of risk.reasons) safelyKnownRiskReasons.set(`${entry.code}:${entry.description}`, entry);
    }
  }

  if (approved.length === 0) {
    const riskReasons = [...safelyKnownRiskReasons.values()];
    rejected.sort((left, right) => compareCandidateQuotes(left.quote, right.quote));
    const bestRejected = rejected[0];
    return rejectedDecision(input, riskReasons.length > 0
      ? [freezeReason("ACTIVATION_RISK_REJECTED", "no activation quantity passed all exact risk and stress gates"), ...riskReasons.map((entry) => freezeReason(entry.code, entry.description))]
      : [freezeReason("ACTIVATION_QUOTE_FAILED", "no activation quantity passed exact quote and stress gates")], {
        capture, terms, changes, quote: bestRejected?.quote, risk: bestRejected?.risk,
      });
  }
  approved.sort((left, right) => compareCandidateQuotes(left.quote, right.quote));
  const selected = approved[0]!;
  const data: PairActivationDecisionData = Object.freeze({
    schemaVersion: 1,
    kind: "complete_set_pair_activation_v1",
    groupId: input.groupId,
    scheduledDueMs: input.scheduledDueMs,
    actualDispatchMs: input.actualDispatchMs,
    cutoff: Object.freeze({ ...input.cutoff }),
    decisionRepresentation: Object.freeze({ ...input.decisionRepresentation }),
    signalAuthority: Object.freeze({ ...input.signalAuthority }),
    activationCapture: capture,
    currentTerms: terms,
    termChanges: changes,
    selectedGrossShares6: selected.quote.pairGrossShares6,
    quote: selected.quote,
    riskDecision: selected.risk,
    gateResult: Object.freeze({ kind: "APPROVED", reasons: Object.freeze([]) }),
  });
  // Hashing here is a serializability tripwire: decision data contains only
  // immutable deterministic evidence and no adapter/effect handles.
  canonicalObjectHash(data);
  return Object.freeze({ kind: "APPROVED", data });
}
