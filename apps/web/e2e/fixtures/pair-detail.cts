import type {
  PairGroupDetail, PairGroupEvent, PairReconciliation,
} from "../../lib/pair-detail";

const huge = "9007199254740993123456";

export const baseGroup: PairGroupDetail = {
  id: "pair-group-fixture",
  marketId: "btc-updown-5m-1700000000",
  conditionId: "condition-fixture",
  observationId: "observation-fixture",
  episodeId: "episode-fixture",
  pairAccountId: "paper-account-fixture",
  signalDecisionId: "signal-decision-fixture",
  signalRiskDecisionId: "signal-risk-fixture",
  activationDecisionId: "activation-decision-fixture",
  activationRiskDecisionId: "activation-risk-fixture",
  strategyVersion: "complete_set_pair_v0_RESEARCH_ONLY",
  mode: "paper",
  route: "DIRECT_BOOK",
  dispatchModel: "PARALLEL",
  settlementPolicy: "VIRTUAL_MERGE",
  recoveryPolicy: "NO_AUTO_RECOVERY",
  idempotencyKey: "pair-fixture-idempotency",
  requestHash: "sha256:immutable-fixture",
  signalCaptureId: "capture-signal",
  activationCaptureId: "capture-activation",
  secondLegCaptureId: "capture-second-leg",
  state: "RECONCILED_SETTLED",
  stateVersion: 12,
  targetGrossShares6: huge,
  approvedCashCap6: "9200000000000000000000",
  approvedResidualLoss6: "1000000",
  reservedCash6: "0",
  cashDebits6: "8917127262041483192217",
  cashCredits6: "9017199254740993123456",
  cashFees6: "2000000",
  settlementCosts6: "500000",
  upHeldShares6: "0",
  downHeldShares6: "0",
  matchedShares6: huge,
  residualSide: null,
  residualShares6: "0",
  currentWorstCaseLoss6: "0",
  peakWorstCaseLoss6: "1000000",
  signalNetPnl6: "12000000",
  activationNetPnl6: "11000000",
  realizedPairPnl6: "100071992699509931239",
  realizedRecoveryPnl6: "0",
  unrealizedResidualMark6: null,
  oneTickWorsePnl6: "9000000",
  twoTicksWorsePnl6: "7000000",
  stressResultsJson: { gate: "PASSED", oneTickWorsePnl6: "9000000", twoTicksWorsePnl6: "7000000" },
  activateAtMs: 1_700_000_001_000,
  nextActionAtMs: null,
  recoveryDeadlineMs: null,
  recoveryAttempts: 0,
  reconciliationStatus: "HEALTHY",
  lastReconciledAtMs: 1_700_000_010_000,
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_010_000,
  closedAtMs: 1_700_000_009_000,
  actions: [
    { id: "activation-action", actionKind: "INITIAL_ACTIVATION", actionSequence: 1, captureId: "capture-activation" },
    { id: "settlement-action", actionKind: "VIRTUAL_MERGE_SETTLEMENT", actionSequence: 2, captureId: "capture-activation" },
  ],
  effects: [
    { id: "up-effect", actionKind: "INITIAL_ACTIVATION", actionSequence: 1, effectOrdinal: 0, state: "APPLIED", resultEvidenceId: "up-evidence", requestPayload: { outcome: "UP", price6: "490000", requestedGrossShares6: huge } },
    { id: "down-effect", actionKind: "INITIAL_ACTIVATION", actionSequence: 1, effectOrdinal: 1, state: "APPLIED", resultEvidenceId: "down-evidence", requestPayload: { outcome: "DOWN", price6: "500000", requestedGrossShares6: huge } },
  ],
  evidence: [
    { id: "up-evidence", effectId: "up-effect", evidenceKey: "venue:up-fill", evidenceKind: "FILL", processingResult: "FILLED", receivedTsMs: 1_700_000_002_000, payload: { outcome: "UP", grossShares6: huge, netShares6: huge, price6: "490000", cashFee6: "1000000" } },
    { id: "down-evidence", effectId: "down-effect", evidenceKey: "venue:down-fill", evidenceKind: "FILL", processingResult: "FILLED", receivedTsMs: 1_700_000_002_100, payload: { outcome: "DOWN", grossShares6: huge, netShares6: huge, price6: "500000", cashFee6: "1000000" } },
  ],
  inventoryLots: [
    { id: "up-lot", outcome: "UP", sourceFillId: "up-fill", grossShares6: huge, netShares6: huge, principalCost6: "4413527634823086630493", cashFee6: "1000000", shareFee6: "0" },
    { id: "down-lot", outcome: "DOWN", sourceFillId: "down-fill", grossShares6: huge, netShares6: huge, principalCost6: "4503599627218396561724", cashFee6: "1000000", shareFee6: "0" },
  ],
  inventoryConsumptions: [
    { id: "consume-up", lotId: "up-lot", eventId: "event-settlement", consumptionKind: "VIRTUAL_MERGE", shares6: huge, allocatedPrincipalCost6: "4413527634823086630493", allocatedBuyCashFee6: "1000000" },
  ],
  ledgerEntries: [
    { id: "ledger-1", journalId: "journal-fill", lineNumber: 1, account: "PAIR_CASH", assetId: "USDC", amount6: "-8917127262041483192217", eventId: "event-fill" },
    { id: "ledger-2", journalId: "journal-fill", lineNumber: 2, account: "PAIR_INVENTORY", assetId: "UP", amount6: huge, eventId: "event-fill" },
  ],
};

export const baseEvents: readonly PairGroupEvent[] = [
  { id: "event-reconcile", sequence: 8, eventType: "PAIR_RECONCILIATION_COMPLETED", causationId: "recon-1", correlationId: "correlation-fixture", payload: { status: "HEALTHY" }, occurredAtMs: 1_700_000_010_000, recordedAtMs: 1_700_000_010_001 },
  { id: "event-created", sequence: 1, eventType: "PAIR_GROUP_CREATED", causationId: "observation-fixture", correlationId: "correlation-fixture", payload: { captureId: "capture-signal", netPnl6: "12000000" }, occurredAtMs: 1_700_000_000_000, recordedAtMs: 1_700_000_000_001 },
  { id: "event-reserved", sequence: 2, eventType: "PAIR_CASH_RESERVED", causationId: "risk-fixture", correlationId: "correlation-fixture", payload: { reservedCash6: "9200000000000000000000" }, occurredAtMs: 1_700_000_000_100, recordedAtMs: 1_700_000_000_101 },
  { id: "event-activation", sequence: 3, eventType: "PAIR_ACTIVATION_CAPTURED", causationId: "activation-action", correlationId: "correlation-fixture", payload: { scheduledDueMs: 1_700_000_001_000, actualDispatchAtMs: 1_700_000_001_025, evidenceId: "capture-activation", netPnl6: "11000000" }, occurredAtMs: 1_700_000_001_025, recordedAtMs: 1_700_000_001_026 },
  { id: "event-up-fill", sequence: 4, eventType: "PAIR_FILL_RECORDED", causationId: "up-evidence", correlationId: "correlation-fixture", payload: { outcome: "UP", evidenceKey: "venue:up-fill", grossShares6: huge, cashDebit6: "4413527634823086630493" }, occurredAtMs: 1_700_000_002_000, recordedAtMs: 1_700_000_002_001 },
  { id: "event-down-fill", sequence: 5, eventType: "PAIR_FILL_RECORDED", causationId: "down-evidence", correlationId: "correlation-fixture", payload: { outcome: "DOWN", evidenceKey: "venue:down-fill", grossShares6: huge, cashDebit6: "4503599627218396561724" }, occurredAtMs: 1_700_000_002_100, recordedAtMs: 1_700_000_002_101 },
  { id: "event-inventory", sequence: 6, eventType: "PAIR_INVENTORY_PAIRED", causationId: "event-down-fill", correlationId: "correlation-fixture", payload: { matchedShares6: huge, residualShares6: "0" }, occurredAtMs: 1_700_000_002_200, recordedAtMs: 1_700_000_002_201 },
  { id: "event-settlement", sequence: 7, eventType: "PAIR_VIRTUAL_MERGE_CONFIRMED", causationId: "settlement-action", correlationId: "correlation-fixture", payload: { matchedShares6: huge, realizedPairPnl6: "100071992699509931239" }, occurredAtMs: 1_700_000_009_000, recordedAtMs: 1_700_000_009_001 },
];

export const healthyReconciliation: PairReconciliation = {
  id: "reconciliation-fixture",
  cause: "TERMINAL_GROUP",
  status: "HEALTHY",
  startedAtMs: 1_700_000_009_900,
  completedAtMs: 1_700_000_010_000,
  checkedEventSequence: 8,
  projectionRebuilt: false,
  summary: { ledgerBalanced: true },
  diffs: [],
};

export function fixture(name: "both-filled" | "residual" | "unknown" | "recovery-partial" | "merge-resolution" | "mismatch") {
  if (name === "residual") return {
    group: { ...baseGroup, state: "RESIDUAL", reconciliationStatus: "PENDING", upHeldShares6: huge, downHeldShares6: "0", matchedShares6: "0", residualSide: "UP", residualShares6: huge, currentWorstCaseLoss6: "-1000000", realizedPairPnl6: null, unrealizedResidualMark6: "123456789012345678901", reservedCash6: "5000000", closedAtMs: null },
    events: [...baseEvents.slice(0, 4), { id: "event-residual", sequence: 5, eventType: "PAIR_RESIDUAL_CLASSIFIED", correlationId: "correlation-fixture", payload: { outcome: "UP", residualShares6: huge, currentWorstCaseLoss6: "-1000000" }, occurredAtMs: 1_700_000_002_200 }],
    reconciliations: [],
  };
  if (name === "unknown") return {
    group: { ...baseGroup, state: "OUTCOME_UNKNOWN", reconciliationStatus: "PENDING", downHeldShares6: "0", matchedShares6: "0", realizedPairPnl6: null, closedAtMs: null, effects: [baseGroup.effects![0]!, { ...baseGroup.effects![1]!, state: "UNKNOWN", lastErrorCode: "VENUE_TIMEOUT" }], evidence: [baseGroup.evidence![0]!, { ...baseGroup.evidence![1]!, processingResult: "OUTCOME_UNKNOWN", evidenceKind: "AMBIGUOUS_RESULT" }] },
    events: [...baseEvents.slice(0, 4), { id: "event-unknown", sequence: 5, eventType: "PAIR_LEG_OUTCOME_UNKNOWN", correlationId: "correlation-fixture", payload: { outcome: "DOWN", evidenceKey: "venue:down-fill" }, occurredAtMs: 1_700_000_002_200 }],
    reconciliations: [],
  };
  if (name === "recovery-partial") return {
    group: { ...baseGroup, state: "RESIDUAL", reconciliationStatus: "PENDING", residualSide: "DOWN", residualShares6: "4500000", downHeldShares6: "4500000", matchedShares6: "8999999999999999", currentWorstCaseLoss6: "-4500000", realizedPairPnl6: null, recoveryAttempts: 1, recoveryDeadlineMs: 1_700_000_020_000, actions: [...baseGroup.actions!, { id: "recovery-action", actionKind: "RECOVERY_LIQUIDATE_FILLED_LEG", actionSequence: 2, chosenReason: "MINIMIZE_WORST_LOSS", alternatives: ["COMPLETE_MISSING_LEG", "LIQUIDATE_FILLED_LEG", "NO_ACTION"] }] },
    events: [...baseEvents.slice(0, 4), { id: "event-recovery", sequence: 5, eventType: "PAIR_RECOVERY_PARTIAL", correlationId: "correlation-fixture", payload: { outcome: "DOWN", requestedShares6: "9000000", filledShares6: "4500000", residualShares6: "4500000" }, occurredAtMs: 1_700_000_003_000 }],
    reconciliations: [],
  };
  if (name === "merge-resolution") return {
    group: { ...baseGroup, settlementPolicy: "VIRTUAL_MERGE_THEN_RESOLUTION", state: "RECONCILED_SETTLED" },
    events: [...baseEvents.filter((event) => event.sequence <= 6), { id: "event-merge-failed", sequence: 7, eventType: "PAIR_VIRTUAL_MERGE_FAILED", correlationId: "correlation-fixture", payload: { errorCode: "MERGE_CONSTRAINT", matchedShares6: huge }, occurredAtMs: 1_700_000_008_000 }, { id: "event-resolution", sequence: 8, eventType: "PAIR_RESOLUTION_APPLIED", correlationId: "correlation-fixture", payload: { outcome: "UP", payout6: huge, realizedPairPnl6: "100071992699509931239" }, occurredAtMs: 1_700_000_009_000 }],
    reconciliations: [healthyReconciliation],
  };
  if (name === "mismatch") return {
    group: { ...baseGroup, state: "MANUAL_REVIEW", reconciliationStatus: "MISMATCH", closedAtMs: null },
    events: [...baseEvents, { id: "event-mismatch", sequence: 9, eventType: "PAIR_RECONCILIATION_MISMATCH", correlationId: "correlation-fixture", payload: { diffCode: "LEDGER_BALANCE_MISMATCH", amount6: huge }, occurredAtMs: 1_700_000_011_000 }],
    reconciliations: [{ ...healthyReconciliation, status: "MISMATCH", diffs: [{ id: "diff-fixture", severity: "CRITICAL", code: "LEDGER_BALANCE_MISMATCH", expectedJson: { amount6: "0" }, actualJson: { amount6: huge }, autoRepairable: false, repairedAtMs: null }] }],
  };
  return { group: baseGroup, events: baseEvents, reconciliations: [healthyReconciliation] };
}

export { huge };
