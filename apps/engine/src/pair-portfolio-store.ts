import { schema, type DbHandle } from "@b5p/db";
import {
  canonicalObjectHash,
  type PairPortfolioSnapshot,
} from "@b5p/pair-execution";
import { and, eq, inArray, isNull } from "drizzle-orm";

const ACTIVE_GROUP_STATES = [
  "SCHEDULED", "ACTIVATING", "ACTIVATION_REJECTED", "SUBMITTING", "OUTCOME_UNKNOWN",
  "NO_INITIAL_FILL", "PAIRED", "RESIDUAL", "RECOVERY_PENDING", "RECOVERING",
  "RECOVERY_OUTCOME_UNKNOWN", "AWAITING_SETTLEMENT", "MERGE_PENDING",
  "MERGE_OUTCOME_UNKNOWN", "AWAITING_RESOLUTION", "RECONCILING", "MANUAL_REVIEW",
] as const;

const SETTLEMENT_RESERVATION_STATES = [
  "AWAITING_SETTLEMENT", "MERGE_PENDING", "MERGE_OUTCOME_UNKNOWN", "AWAITING_RESOLUTION",
] as const;

const ACTIVE_DIRECTIONAL_ORDER_STATES = ["PENDING", "LIVE", "PARTIAL"] as const;

export interface PairPortfolioSnapshotInput {
  readonly accountId: string;
  readonly referenceBankroll6: bigint;
  readonly directionalFreeCash6: bigint;
  readonly globalAppMode: PairPortfolioSnapshot["globalAppMode"];
  readonly directionalLiveArmed: boolean;
  readonly asOfMs: number;
}

export class PairPortfolioSnapshotError extends Error {
  override readonly name = "PairPortfolioSnapshotError";
}

function assertInput(input: PairPortfolioSnapshotInput): void {
  if (input.accountId.trim().length === 0) throw new PairPortfolioSnapshotError("accountId must not be empty");
  if (input.referenceBankroll6 <= 0n) throw new PairPortfolioSnapshotError("reference bankroll must be positive");
  if (input.directionalFreeCash6 < 0n) throw new PairPortfolioSnapshotError("directional free cash must be non-negative");
  if (!Number.isSafeInteger(input.asOfMs) || input.asOfMs < 0) {
    throw new PairPortfolioSnapshotError("asOfMs must be a non-negative safe integer");
  }
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function minimum(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Exact, read-only portfolio adapter for pair risk evaluation. It composes the
 * isolated counterfactual pair account with directional order/position facts;
 * it never mutates either accounting system.
 */
export class PairPortfolioStore {
  constructor(private readonly handle: DbHandle) {}

  async snapshot(input: PairPortfolioSnapshotInput): Promise<PairPortfolioSnapshot> {
    assertInput(input);
    const [accountRows, groups, directionalOrders, directionalPositions] = await Promise.all([
      this.handle.db.select().from(schema.pairPaperAccounts)
        .where(eq(schema.pairPaperAccounts.id, input.accountId)).limit(1),
      this.handle.db.select({
        marketId: schema.pairOrderGroups.marketId,
        state: schema.pairOrderGroups.state,
        reservedCash6: schema.pairOrderGroups.reservedCash6,
      }).from(schema.pairOrderGroups).where(and(
        eq(schema.pairOrderGroups.pairAccountId, input.accountId),
        inArray(schema.pairOrderGroups.state, [...ACTIVE_GROUP_STATES]),
      )),
      this.handle.db.select({ marketId: schema.orders.marketId }).from(schema.orders).where(and(
        isNull(schema.orders.pairGroupId),
        inArray(schema.orders.status, [...ACTIVE_DIRECTIONAL_ORDER_STATES]),
      )),
      this.handle.db.select({ marketId: schema.positions.marketId }).from(schema.positions)
        .where(eq(schema.positions.status, "OPEN")),
    ]);
    const account = accountRows[0];
    if (account === undefined) throw new PairPortfolioSnapshotError(`pair account ${input.accountId} is unavailable`);

    const pendingSettlementReserved6 = groups
      .filter(({ state }) => (SETTLEMENT_RESERVATION_STATES as readonly string[]).includes(state))
      .reduce((sum, { reservedCash6 }) => sum + reservedCash6, 0n);
    const activePairMarketIds = sortedUnique(groups.map(({ marketId }) => marketId));
    const activeDirectionalMarketIds = sortedUnique(directionalOrders.map(({ marketId }) => marketId));
    const openDirectionalMarketIds = sortedUnique(directionalPositions.map(({ marketId }) => marketId));
    const healthy = account.reconciliationStatus === "HEALTHY" && account.lastReconciledAtMs !== null;
    const reconciledAtMs = account.lastReconciledAtMs ?? input.asOfMs;
    const material = Object.freeze({
      accountId: account.id,
      accountStateVersion: account.stateVersion,
      accountEventSequence: account.eventSequence,
      referenceBankroll6: input.referenceBankroll6,
      pairAccountCashBalance6: account.cashAvailable6 + account.cashReserved6,
      pairCashReserved6: account.cashReserved6,
      pairPendingSettlementReserved6: pendingSettlementReserved6,
      pairCashAvailable6: account.cashAvailable6,
      directionalFreeCash6: input.directionalFreeCash6,
      sharedCapAvailable6: minimum(account.cashAvailable6, input.directionalFreeCash6),
      globalAppMode: input.globalAppMode,
      directionalLiveArmed: input.directionalLiveArmed,
      activePairGroupCount: groups.length,
      aggregatePairWorstCaseLoss6: account.aggregateWorstCaseLoss6,
      pairDailyRealizedPnl6: account.dailyRealizedPnl6,
      pairSessionPeakCash6: account.peakCash6,
      activeDirectionalMarketIds,
      openDirectionalMarketIds,
      activePairMarketIds,
      reconciledAtMs,
      healthy,
    });
    const hash = canonicalObjectHash(material);
    return Object.freeze({
      snapshotId: `pair-portfolio:${account.id}:${account.stateVersion}:${hash.slice(0, 16)}`,
      ...material,
      hash,
    });
  }
}
