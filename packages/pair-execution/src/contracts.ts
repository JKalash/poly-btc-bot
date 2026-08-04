import type { Ppm, Prob6, Shares6, Usdc6 } from "@b5p/domain";

declare const pairBrand: unique symbol;
export type BrandedId<Name extends string> = string & { readonly [pairBrand]: Name };
export type PairCaptureId = BrandedId<"PairCaptureId">;
export type PairObservationId = BrandedId<"PairObservationId">;
export type PairGroupId = BrandedId<"PairGroupId">;
export type PairLegId = BrandedId<"PairLegId">;
export type PairEventId = BrandedId<"PairEventId">;
export type PairLedgerEntryId = BrandedId<"PairLedgerEntryId">;

export type PairOutcome = "UP" | "DOWN";
export type PairOrderSide = "BUY" | "SELL";
export type PairRunMode = "observe" | "paper";
export type PairRoute = "DIRECT_BUY_BOTH";
export type PairDispatchModel = "PARALLEL" | "UP_THEN_DOWN" | "DOWN_THEN_UP";
export type PairSettlementPolicy = "HOLD_TO_RESOLUTION" | "PAPER_VIRTUAL_MERGE";
export type PairRecoveryPolicy =
  | "NO_AUTO_RECOVERY"
  | "PAPER_COMPLETE_MISSING_LEG"
  | "PAPER_LIQUIDATE_FILLED_LEG"
  | "PAPER_MINIMIZE_WORST_LOSS";

export interface PairBookLevel { readonly price6: Prob6; readonly shares6: Shares6 }
export type PairBookIntegrity = "VERIFIED_SNAPSHOT" | "SEQUENCED_CONTIGUOUS" | "HASH_CHAIN_VERIFIED" | "UNSEQUENCED_AFTER_SNAPSHOT";

export interface ImmutablePairBookLeg {
  readonly outcome: PairOutcome;
  readonly tokenId: string;
  readonly bookVersion: bigint;
  readonly connectionEpoch: string;
  readonly sourceTsMs: number;
  readonly receivedTsMs: number;
  readonly exchangeHash: string | null;
  readonly sourceEventId: string;
  readonly integrity: PairBookIntegrity;
  readonly bids: readonly PairBookLevel[];
  readonly asks: readonly PairBookLevel[];
}

export interface PairBookCapture {
  readonly captureId: PairCaptureId;
  readonly marketId: string;
  readonly conditionId: string;
  readonly capturedAtMs: number;
  readonly captureSequence: bigint;
  readonly up: ImmutablePairBookLeg;
  readonly down: ImmutablePairBookLeg;
  readonly sourceSkewMs: number;
  readonly receiveSkewMs: number;
  readonly captureHash: string;
}

export interface PairConstraintSnapshot {
  readonly snapshotId: string; readonly tokenId: string; readonly tickSize6: Prob6;
  readonly minimumOrderShares6: Shares6; readonly effectiveAtMs: number; readonly fetchedAtMs: number;
  readonly source: string; readonly canonicalHash: string;
}
export interface PairFeeSnapshot {
  readonly snapshotId: string; readonly tokenId: string; readonly tokenFeeRatePpm: Ppm;
  readonly convention: "USDC" | "SHARES" | "UNKNOWN"; readonly conventionResolverVersion: string;
  readonly effectiveAtMs: number; readonly fetchedAtMs: number; readonly source: string; readonly canonicalHash: string;
}
export interface PairTokenTerms {
  readonly outcome: PairOutcome; readonly tokenId: string;
  readonly constraints: PairConstraintSnapshot; readonly fee: PairFeeSnapshot;
}
export interface PairMarketContext {
  readonly marketId: string; readonly conditionId: string; readonly slug: string;
  readonly up: PairTokenTerms; readonly down: PairTokenTerms; readonly startsAtMs: number; readonly endsAtMs: number;
  readonly acceptingOrders: boolean; readonly negRisk: boolean;
  readonly marketStructure: "BINARY_EXHAUSTIVE_MUTUALLY_EXCLUSIVE";
  readonly invalidOrVoidPolicyVerified: boolean; readonly rulesVerified: boolean; readonly rulesHash: string;
  readonly resolutionSource: "CHAINLINK"; readonly secondsRemaining: number; readonly configVersion: number;
}

export type PairTokenTermsRejectCode =
  | "TERMS_TRANSPORT_FAILURE" | "FEE_SNAPSHOT_MISSING" | "FEE_SNAPSHOT_MALFORMED"
  | "FEE_SNAPSHOT_TOKEN_MISMATCH" | "FEE_SNAPSHOT_STALE" | "FEE_CONVENTION_UNKNOWN"
  | "CONSTRAINT_SNAPSHOT_MISSING" | "CONSTRAINT_SNAPSHOT_MALFORMED"
  | "CONSTRAINT_SNAPSHOT_TOKEN_MISMATCH" | "CONSTRAINT_SNAPSHOT_STALE";
export type PairTokenTermsResult =
  | { readonly kind: "READY"; readonly up: PairTokenTerms; readonly down: PairTokenTerms }
  | { readonly kind: "REJECTED"; readonly code: PairTokenTermsRejectCode; readonly detail: string };
export interface PairTokenTermsProvider {
  currentTerms(input: { readonly marketId: string; readonly conditionId: string; readonly upTokenId: string; readonly downTokenId: string; readonly asOfMs: number }): Promise<PairTokenTermsResult>;
}
export interface PairFeeConventionResolver {
  readonly version: string;
  resolve(input: { readonly tokenId: string; readonly rawFeeRate: string; readonly rawVenueMetadata: Readonly<Record<string, string>> }):
    | { readonly kind: "RESOLVED"; readonly convention: "USDC" | "SHARES" }
    | { readonly kind: "UNKNOWN"; readonly reason: string };
}

export interface PairBookReference {
  readonly tokenId: string; readonly bookVersion: bigint; readonly connectionEpoch: string;
  readonly sourceEventId: string; readonly contentHash: string;
}
export interface PairLevelFill {
  readonly price6: Prob6; readonly grossShares6: Shares6; readonly cashPrincipal6: Usdc6;
  readonly feeCash6: Usdc6; readonly feeShares6: Shares6; readonly netShares6: Shares6;
}
export interface PairLegQuote {
  readonly outcome: PairOutcome; readonly tokenId: string; readonly orderSide: PairOrderSide;
  readonly requestedGrossShares6: Shares6; readonly filledGrossShares6: Shares6;
  readonly receivedNetShares6: Shares6; readonly unfilledGrossShares6: Shares6; readonly levels: readonly PairLevelFill[];
  readonly principal6: Usdc6; readonly feeCash6: Usdc6; readonly feeShares6: Shares6;
  readonly worstPrice6: Prob6 | null; readonly averagePrice6: Prob6 | null;
  readonly fullyExecutable: boolean; readonly bookRef: PairBookReference;
}

/** Economics shared by base, tick-stressed, and depth-stressed pair quotes. */
export interface PairQuoteEconomics {
  readonly pairGrossShares6: Shares6;
  readonly mergeableNetShares6: Shares6;
  readonly up: PairLegQuote;
  readonly down: PairLegQuote;
  readonly grossPrincipal6: Usdc6;
  readonly totalFeeCash6: Usdc6;
  readonly modeledNonrefundableSettlementCost6: Usdc6;
  readonly settlementCashReserve6: Usdc6;
  readonly recoveryCashReserve6: Usdc6;
  readonly operationalRiskHaircut6: Usdc6;
  readonly reservedCash6: Usdc6;
  readonly guaranteedPayout6: Usdc6;
  readonly grossWalkEdge6: bigint;
  readonly netPnl6: bigint;
  readonly netReturnPpm: bigint;
  readonly upOnlyWorstLoss6: Usdc6;
  readonly downOnlyWorstLoss6: Usdc6;
  readonly worstSingleLegLoss6: Usdc6;
  readonly residualUpShares6: Shares6;
  readonly residualDownShares6: Shares6;
}

export type PairStressRejectCode = "TICK_SIZE_INVALID" | "INSUFFICIENT_UP_DEPTH" | "INSUFFICIENT_DOWN_DEPTH";
export type PairStressResult =
  | ({ readonly kind: "EXECUTABLE"; readonly ticksWorse: 1 | 2 } & PairQuoteEconomics)
  | { readonly kind: "REJECTED"; readonly ticksWorse: 1 | 2; readonly code: PairStressRejectCode; readonly description: string };
export type PairDepthStressResult =
  | ({ readonly kind: "EXECUTABLE"; readonly depthFractionPpm: Ppm } & PairQuoteEconomics)
  | { readonly kind: "REJECTED"; readonly depthFractionPpm: Ppm; readonly code: "INSUFFICIENT_UP_DEPTH" | "INSUFFICIENT_DOWN_DEPTH"; readonly description: string };

export interface PairQuote extends PairQuoteEconomics {
  readonly quoteSchemaVersion: 1;
  readonly route: "DIRECT_BUY_BOTH";
  readonly captureId: PairCaptureId;
  readonly oneTickWorse: PairStressResult;
  readonly twoTicksWorse: PairStressResult;
  readonly depthStress: readonly PairDepthStressResult[];
  readonly objectiveVersion: "pair_size_objective_v1";
  readonly quoteHash: string;
}

export interface PairPortfolioSnapshot {
  readonly snapshotId: string;
  readonly referenceBankroll6: Usdc6;
  readonly pairAccountCashBalance6: Usdc6;
  readonly pairCashReserved6: Usdc6;
  readonly pairPendingSettlementReserved6: Usdc6;
  readonly pairCashAvailable6: Usdc6;
  readonly directionalFreeCash6: Usdc6;
  readonly sharedCapAvailable6: Usdc6;
  readonly globalAppMode: "observe" | "paper" | "shadow" | "live";
  readonly directionalLiveArmed: boolean;
  readonly activePairGroupCount: number;
  readonly aggregatePairWorstCaseLoss6: Usdc6;
  readonly pairDailyRealizedPnl6: bigint;
  readonly pairSessionPeakCash6: Usdc6;
  readonly activeDirectionalMarketIds: readonly string[];
  readonly openDirectionalMarketIds: readonly string[];
  readonly activePairMarketIds: readonly string[];
  readonly reconciledAtMs: number;
  readonly healthy: boolean;
  readonly hash: string;
}

export type PairRiskDecision =
  | {
      readonly kind: "APPROVED"; readonly permitId: string; readonly approvedQuoteHash: string;
      readonly policyHash: string; readonly portfolioHash: string;
      readonly maximumReservedCash6: Usdc6; readonly maximumResidualLoss6: Usdc6;
      readonly upOnlyWorstLoss6: Usdc6; readonly downOnlyWorstLoss6: Usdc6;
      readonly maximumLockedLossAfterCompletion6: Usdc6; readonly maximumComplementCashDebit6: Usdc6;
      readonly issuedAtMs: number; readonly expiresAtMs: number;
    }
  | { readonly kind: "REJECTED"; readonly reasons: readonly PairRejection[] };

export type PairRejectionCode =
  | "PAIR_FEATURE_DISABLED" | "PAPER_EXECUTION_DISABLED" | "MODE_UNSUPPORTED"
  | "MARKET_NOT_ACCEPTING_ORDERS" | "RULES_UNVERIFIED" | "RESOLUTION_SOURCE_UNSUPPORTED"
  | "NEG_RISK_UNSUPPORTED" | "MARKET_STRUCTURE_UNSUPPORTED" | "VOID_POLICY_UNVERIFIED" | "ENTRY_CUTOFF_REACHED"
  | "UP_BOOK_MISSING" | "DOWN_BOOK_MISSING" | "UP_BOOK_STALE" | "DOWN_BOOK_STALE"
  | "BOOK_SOURCE_TIMESTAMP_MISSING" | "BOOK_SOURCE_TIMESTAMP_TOO_FAR_FUTURE" | "BOOK_SOURCE_STALE"
  | "BOOK_RECEIVE_TIMESTAMP_TOO_FAR_FUTURE" | "BOOK_RECEIVE_STALE" | "BOOK_SOURCE_SKEW" | "BOOK_RECEIVE_SKEW"
  | "BOOK_INVALID_AFTER_RECONNECT" | "BOOK_GAP_SUSPECTED" | "BOOK_CONTINUITY_UNVERIFIED" | "BOOK_EMPTY_ASKS"
  | "CAPTURE_HASH_INVALID" | PairTokenTermsRejectCode | "UNSUPPORTED_PAPER_FEE_COLLECTION"
  | "UNSUPPORTED_SELL_FEE_COLLECTION" | "TICK_SIZE_INVALID" | "MINIMUM_ORDER_NOT_MET" | "NO_EXECUTABLE_SIZE"
  | "INSUFFICIENT_UP_DEPTH" | "INSUFFICIENT_DOWN_DEPTH" | "GROSS_EDGE_NON_POSITIVE"
  | "NET_PNL_BELOW_MINIMUM" | "NET_RETURN_BELOW_MINIMUM" | "ONE_TICK_STRESS_FAILED" | "TWO_TICK_STRESS_FAILED"
  | "AGGREGATE_CASH_CAP_EXCEEDED" | "RESIDUAL_LOSS_CAP_EXCEEDED" | "AVAILABLE_CASH_INSUFFICIENT"
  | "PORTFOLIO_UNRECONCILED" | "DIRECTIONAL_ORDER_CONFLICT" | "DIRECTIONAL_POSITION_CONFLICT"
  | "ACTIVE_PAIR_CONFLICT" | "DUPLICATE_OBSERVATION" | "ACTIVATION_DATA_UNAVAILABLE"
  | "ACTIVATION_QUOTE_FAILED" | "ACTIVATION_FEE_CHANGED" | "ACTIVATION_CONSTRAINT_CHANGED" | "ENGINE_HALTED";
export interface PairRejection { readonly code: PairRejectionCode; readonly description: string }

export interface PairPolicySnapshot {
  readonly strategyVersion: "complete_set_pair_v0_RESEARCH_ONLY"; readonly route: PairRoute;
  readonly observerEnabled: boolean; readonly paperSchedulingEnabled: boolean; readonly liveExecutionAvailable: false;
  readonly dispatchModel: PairDispatchModel; readonly activationLatencyMs: number; readonly interLegDelayMs: number;
  readonly activationQuoteTtlMs: number; readonly settlementPolicy: PairSettlementPolicy;
  readonly modeledSettlementDelayMs: number; readonly modeledSettlementCost6: Usdc6; readonly settlementCashReserve6: Usdc6;
  readonly recoveryPolicy: PairRecoveryPolicy; readonly maximumRecoveryAttempts: 0 | 1;
  readonly recoveryDeadlineMs: number; readonly recoveryReserve6: Usdc6;
  readonly maximumBookAgeMs: number; readonly maximumSourceSkewMs: number; readonly maximumReceiveSkewMs: number;
  readonly maximumFutureTimestampMs: number; readonly maximumFeeSnapshotAgeMs: number; readonly maximumConstraintSnapshotAgeMs: number;
  readonly minimumNetPnl6: Usdc6; readonly minimumNetReturnPpm: bigint; readonly operationalRiskHaircut6: Usdc6;
  readonly maximumCashFractionPpm: Ppm; readonly maximumResidualLossFractionPpm: Ppm;
  readonly maximumAggregateReservedFractionPpm: Ppm; readonly maximumAggregateResidualLossFractionPpm: Ppm;
  readonly maximumPairDailyLossFractionPpm: Ppm; readonly maximumPairSessionDrawdownFractionPpm: Ppm;
  readonly maximumActivePairGroups: number; readonly pairShareLot6: Shares6; readonly maximumPairShares6: Shares6 | null;
  readonly requireOneTickStressPositive: boolean; readonly requireTwoTickStressPositive: boolean;
  readonly depthStressFractionsPpm: readonly [Ppm, Ppm, Ppm]; readonly entryCutoffSeconds: number;
  readonly episodeCooloffMs: number; readonly negativeControlSamplePpm: Ppm; readonly unknownResultTimeoutMs: number;
  readonly hardRiskConstant: { readonly name: "ABSOLUTE_MAX_RISK_FRACTION"; readonly valuePpm: Ppm; readonly sourceVersion: string };
  readonly configVersion: number; readonly policyHash: string;
}

export interface PairCapabilityAuthority {
  readonly observerEnabled: boolean; readonly paperSchedulingEnabled: boolean;
  readonly liveExecutionAvailable: false; readonly configVersion: number; readonly policy: PairPolicySnapshot;
}

export interface ConsiderPairCommand {
  readonly intent: "OBSERVE_ONLY" | "SCHEDULE_PAPER_IF_AUTHORIZED";
  readonly nowMs: number;
  readonly correlationId: string;
  readonly trigger:
    | { readonly kind: "CLOB_ENVELOPE"; readonly envelopeId: string }
    | { readonly kind: "FALLBACK_TIMER"; readonly timerId: string }
    | { readonly kind: "REPLAY_EVENT"; readonly eventId: string };
  readonly market: PairMarketContext;
  readonly capture: PairBookCapture;
  readonly portfolio: PairPortfolioSnapshot;
}

export type ConsiderPairResult =
  | { readonly kind: "NO_OBSERVATION"; readonly reasons: readonly PairRejection[] }
  | {
      readonly kind: "OBSERVED_REJECTED";
      readonly observationId: PairObservationId;
      readonly quote: PairQuote | null;
      readonly reasons: readonly PairRejection[];
    }
  | { readonly kind: "OBSERVED_ELIGIBLE"; readonly observationId: PairObservationId; readonly quote: PairQuote }
  | {
      readonly kind: "PAPER_SCHEDULED";
      readonly observationId: PairObservationId;
      readonly groupId: PairGroupId;
      readonly quote: PairQuote;
      readonly activateAtMs: number;
    }
  | {
      readonly kind: "DUPLICATE";
      readonly idempotencyKey: string;
      readonly existingObservationId: PairObservationId;
      readonly existingGroupId: PairGroupId | null;
    };

export interface HaltPairsCommand {
  readonly nowMs: number;
  readonly correlationId: string;
  readonly reason: string;
  readonly groupIds?: readonly PairGroupId[];
}

export interface PairCommittedEffect {
  readonly effectId: string;
  readonly groupId: PairGroupId;
  readonly kind: string;
  /** Halted groups may only dispatch intents that cannot add exposure. */
  readonly increasesExposure: boolean;
}

export interface PairGroupView {
  readonly groupId: PairGroupId;
  readonly marketId: string;
  readonly state: string;
  readonly halted: boolean;
  readonly activateAtMs: number | null;
  readonly nextActionAtMs: number | null;
  readonly reservedCash6: Usdc6;
  readonly upHeldShares6: Shares6;
  readonly downHeldShares6: Shares6;
  readonly reconciliationStatus: "NOT_STARTED" | "PENDING" | "HEALTHY" | "MISMATCH";
  readonly stateVersion: number;
}

export interface PairAdvanceSummary {
  readonly dueWorkCount: number;
  readonly committedWorkCount: number;
  readonly skippedHaltedExposureCount: number;
  readonly dispatchedEffectCount: number;
  readonly ingestedEvidenceCount: number;
}

export interface PairReconcileSummary {
  readonly inspectedGroupCount: number;
  readonly healthyGroupCount: number;
  readonly repairedGroupCount: number;
  readonly pendingGroupCount: number;
  readonly manualReviewGroupCount: number;
}

export interface PairHaltSummary {
  readonly haltedGroupCount: number;
  readonly alreadyHaltedGroupCount: number;
  readonly dispatchedCancellationCount: number;
  readonly ingestedEvidenceCount: number;
  readonly reconciliation: PairReconcileSummary;
}

export type PairEconomicsEvaluation =
  | { readonly kind: "NO_OBSERVATION"; readonly reasons: readonly PairRejection[] }
  | { readonly kind: "REJECTED"; readonly quote: PairQuote | null; readonly reasons: readonly PairRejection[] }
  | { readonly kind: "ELIGIBLE"; readonly quote: PairQuote };

export interface PairEconomicsPort {
  evaluate(input: {
    readonly command: ConsiderPairCommand;
    readonly authority: PairCapabilityAuthority;
  }): Promise<PairEconomicsEvaluation>;
}

export type PairObservationRecordResult =
  | { readonly kind: "RECORDED"; readonly observationId: PairObservationId }
  | {
      readonly kind: "DUPLICATE";
      readonly idempotencyKey: string;
      readonly existingObservationId: PairObservationId;
      readonly existingGroupId: PairGroupId | null;
    };

export interface PairObservationPort {
  record(input: {
    readonly command: ConsiderPairCommand;
    readonly evaluation: Exclude<PairEconomicsEvaluation, { readonly kind: "NO_OBSERVATION" }>;
    readonly authority: PairCapabilityAuthority;
  }): Promise<PairObservationRecordResult>;
}

export type PairAccountScheduleDecision =
  | { readonly kind: "APPROVED"; readonly approval: Extract<PairRiskDecision, { readonly kind: "APPROVED" }> }
  | { readonly kind: "REJECTED"; readonly reasons: readonly PairRejection[] };

export interface PairAccountPort {
  approveSchedule(input: {
    readonly command: ConsiderPairCommand;
    readonly quote: PairQuote;
    readonly authority: PairCapabilityAuthority;
  }): Promise<PairAccountScheduleDecision>;
}

export interface PairSchedulePlan {
  readonly groupId: PairGroupId;
  readonly observationId: PairObservationId;
  readonly marketId: string;
  readonly activateAtMs: number;
  readonly quoteHash: string;
  readonly permitId: string;
  readonly reservedCash6: Usdc6;
  readonly planHash: string;
}

export type PairSchedulePreparation =
  | { readonly kind: "READY"; readonly plan: PairSchedulePlan }
  | { readonly kind: "REJECTED"; readonly reasons: readonly PairRejection[] };

export interface PairDueWork {
  readonly workId: string;
  readonly groupId: PairGroupId;
  readonly kind: "ACTIVATION" | "LEG" | "RECOVERY" | "SETTLEMENT" | "TIMEOUT";
  readonly dueAtMs: number;
  readonly halted: boolean;
  readonly stateVersion: number;
}

export interface PairDuePlan {
  readonly workId: string;
  readonly groupId: PairGroupId;
  readonly expectedStateVersion: number;
  readonly increasesExposure: boolean;
  readonly planHash: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type PairDuePreparation =
  | { readonly kind: "READY"; readonly plan: PairDuePlan }
  | { readonly kind: "NO_ACTION"; readonly reason: string };

export interface PairActivationPort {
  prepareSchedule(input: {
    readonly command: ConsiderPairCommand;
    readonly observationId: PairObservationId;
    readonly quote: PairQuote;
    readonly approval: Extract<PairRiskDecision, { readonly kind: "APPROVED" }>;
    readonly authority: PairCapabilityAuthority;
  }): Promise<PairSchedulePreparation>;
  prepareDueWork(input: {
    readonly work: PairDueWork;
    readonly nowMs: number;
    readonly authority: PairCapabilityAuthority;
  }): Promise<PairDuePreparation>;
}

export type PairScheduleCommitResult =
  | { readonly kind: "COMMITTED" }
  | {
      readonly kind: "DUPLICATE";
      readonly idempotencyKey: string;
      readonly existingObservationId: PairObservationId;
      readonly existingGroupId: PairGroupId;
    };

export interface PairAdvanceCommitResult {
  readonly kind: "COMMITTED" | "STALE";
  readonly effects: readonly PairCommittedEffect[];
}

export interface PairHaltCommitResult {
  readonly haltedGroupCount: number;
  readonly alreadyHaltedGroupCount: number;
  readonly effects: readonly PairCommittedEffect[];
}

export interface PairStorePort {
  commitSchedule(input: {
    readonly plan: PairSchedulePlan;
    readonly command: ConsiderPairCommand;
    readonly quote: PairQuote;
  }): Promise<PairScheduleCommitResult>;
  listDueWork(nowMs: number): Promise<readonly PairDueWork[]>;
  commitDuePlan(plan: PairDuePlan, nowMs: number): Promise<PairAdvanceCommitResult>;
  commitHalt(command: HaltPairsCommand): Promise<PairHaltCommitResult>;
  getGroup(groupId: PairGroupId): Promise<PairGroupView | null>;
  listActiveGroups(): Promise<readonly PairGroupView[]>;
}

export interface PairEffectPort {
  /** The caller passes only effect intents returned by a successful store commit. */
  dispatchCommitted(effects: readonly PairCommittedEffect[], nowMs: number): Promise<void>;
  ingestAvailableEvidence(nowMs: number): Promise<number>;
}

export interface PairReconciliationPort {
  reconcile(nowMs: number): Promise<PairReconcileSummary>;
}

export interface PairExecutionDependencies {
  readonly economics: PairEconomicsPort;
  readonly observations: PairObservationPort;
  readonly account: PairAccountPort;
  readonly activation: PairActivationPort;
  readonly store: PairStorePort;
  readonly effects: PairEffectPort;
  readonly reconciliation: PairReconciliationPort;
}

export interface PairExecution {
  consider(command: ConsiderPairCommand): Promise<ConsiderPairResult>;
  advance(nowMs: number): Promise<PairAdvanceSummary>;
  reconcile(nowMs: number): Promise<PairReconcileSummary>;
  halt(command: HaltPairsCommand): Promise<PairHaltSummary>;
  getGroup(groupId: string): Promise<PairGroupView | null>;
  listActiveGroups(): Promise<readonly PairGroupView[]>;
}
