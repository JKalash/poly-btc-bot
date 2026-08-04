import type { PairGroupId, PairLedgerEntryId, PairOutcome } from "./contracts";

/**
 * Internal pair-account journal and immutable inventory primitives (spec §17).
 * This module is deliberately not re-exported by the package barrel.
 */
export const PAIR_LEDGER_ACCOUNTS = [
  "ASSET_CASH_AVAILABLE",
  "ASSET_CASH_RESERVED",
  "ASSET_INVENTORY_COST_UP",
  "ASSET_INVENTORY_COST_DOWN",
  "ASSET_TOKEN_INVENTORY",
  "EQUITY_CAPITAL_SOURCE",
  "EXPENSE_TRADING_FEE",
  "EXPENSE_SETTLEMENT_COST",
  "EXPENSE_REALIZED_COST_BASIS",
  "EXPENSE_SHARE_FEE",
  "REVENUE_RECOVERY_SALE",
  "REVENUE_VIRTUAL_MERGE",
  "REVENUE_RESOLUTION",
  "CLEARING_TOKEN_ACQUISITION",
  "CLEARING_TOKEN_DISPOSAL",
] as const;

export type PairLedgerAccount = (typeof PAIR_LEDGER_ACCOUNTS)[number];
export type PairInventoryConsumptionKind = "SELL_RECOVERY" | "VIRTUAL_MERGE" | "RESOLUTION";

export interface PairInventoryLot {
  readonly lotId: string;
  readonly groupId: PairGroupId;
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: PairOutcome;
  readonly sourceFillId: string;
  readonly grossShares6: bigint;
  readonly netShares6: bigint;
  readonly principalCost6: bigint;
  readonly cashFee6: bigint;
  readonly shareFee6: bigint;
  readonly totalCashCost6: bigint;
  readonly acquiredAtMs: number;
}

export interface PairInventoryConsumption {
  readonly consumptionId: string;
  readonly lotId: string;
  readonly groupId: PairGroupId;
  readonly eventId: string;
  readonly consumptionKind: PairInventoryConsumptionKind;
  readonly shares6: bigint;
  readonly allocatedPrincipalCost6: bigint;
  /** Analytical only: the historical buy fee is not posted a second time. */
  readonly allocatedBuyCashFee6: bigint;
  readonly createdAtMs: number;
}

export interface PairLedgerEntry {
  readonly entryId: PairLedgerEntryId;
  readonly journalId: string;
  readonly lineNumber: number;
  readonly pairAccountId: string;
  readonly groupId: PairGroupId | null;
  readonly causationEventId: string | null;
  readonly causationKind: string;
  readonly account: PairLedgerAccount;
  readonly assetId: string;
  readonly amount6: bigint;
  readonly inventoryLotId: string | null;
  readonly inventoryConsumptionId: string | null;
  readonly orderId: string | null;
  readonly fillId: string | null;
  readonly occurredAtMs: number;
  readonly recordedAtMs: number;
  readonly schemaVersion: 1;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface PairLedgerJournal {
  readonly journalId: string;
  readonly entries: readonly PairLedgerEntry[];
}

export interface JournalContext {
  readonly journalId: string;
  readonly pairAccountId: string;
  readonly groupId: PairGroupId | null;
  readonly causationEventId: string | null;
  readonly causationKind: string;
  readonly occurredAtMs: number;
  readonly recordedAtMs: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

interface LineInput {
  readonly account: PairLedgerAccount;
  readonly assetId: string;
  readonly amount6: bigint;
  readonly inventoryLotId?: string | null;
  readonly inventoryConsumptionId?: string | null;
  readonly orderId?: string | null;
  readonly fillId?: string | null;
}

export interface PairLedgerConservationViolation {
  readonly journalId: string;
  readonly assetId: string;
  readonly imbalance6: bigint;
}

export class PairLedgerError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "PairLedgerError";
  }
}

function requireNonNegative(name: string, value: bigint): void {
  if (value < 0n) throw new PairLedgerError("NEGATIVE_AMOUNT", `${name} must be non-negative`);
}

function requirePositive(name: string, value: bigint): void {
  if (value <= 0n) throw new PairLedgerError("NON_POSITIVE_AMOUNT", `${name} must be positive`);
}

function journal(context: JournalContext, lines: readonly LineInput[]): PairLedgerJournal {
  if (context.journalId.length === 0) throw new PairLedgerError("JOURNAL_ID_EMPTY", "journal id must be non-empty");
  const entries = lines.map((line, index): PairLedgerEntry => ({
    entryId: `${context.journalId}:${index}` as PairLedgerEntryId,
    journalId: context.journalId,
    lineNumber: index,
    pairAccountId: context.pairAccountId,
    groupId: context.groupId,
    causationEventId: context.causationEventId,
    causationKind: context.causationKind,
    account: line.account,
    assetId: line.assetId,
    amount6: line.amount6,
    inventoryLotId: line.inventoryLotId ?? null,
    inventoryConsumptionId: line.inventoryConsumptionId ?? null,
    orderId: line.orderId ?? null,
    fillId: line.fillId ?? null,
    occurredAtMs: context.occurredAtMs,
    recordedAtMs: context.recordedAtMs,
    schemaVersion: 1,
    metadata: Object.freeze({ ...(context.metadata ?? {}) }),
  }));
  const result = { journalId: context.journalId, entries } as const;
  assertBalancedJournal(result);
  return result;
}

export function createInventoryLot(input: Omit<PairInventoryLot, "totalCashCost6">): PairInventoryLot {
  requirePositive("grossShares6", input.grossShares6);
  requireNonNegative("netShares6", input.netShares6);
  requireNonNegative("principalCost6", input.principalCost6);
  requireNonNegative("cashFee6", input.cashFee6);
  requireNonNegative("shareFee6", input.shareFee6);
  if (input.netShares6 + input.shareFee6 !== input.grossShares6) {
    throw new PairLedgerError("LOT_SHARE_EQUATION_INVALID", "net shares plus share fee must equal gross shares");
  }
  return Object.freeze({ ...input, totalCashCost6: input.principalCost6 + input.cashFee6 });
}

function consumptionTotals(consumptions: readonly PairInventoryConsumption[]): Map<string, {
  shares6: bigint; principal6: bigint; fee6: bigint;
}> {
  const totals = new Map<string, { shares6: bigint; principal6: bigint; fee6: bigint }>();
  for (const item of consumptions) {
    requirePositive("consumption shares6", item.shares6);
    requireNonNegative("allocated principal", item.allocatedPrincipalCost6);
    requireNonNegative("allocated buy cash fee", item.allocatedBuyCashFee6);
    const prior = totals.get(item.lotId) ?? { shares6: 0n, principal6: 0n, fee6: 0n };
    totals.set(item.lotId, {
      shares6: prior.shares6 + item.shares6,
      principal6: prior.principal6 + item.allocatedPrincipalCost6,
      fee6: prior.fee6 + item.allocatedBuyCashFee6,
    });
  }
  return totals;
}

export function remainingInventoryLot(
  lot: PairInventoryLot,
  consumptions: readonly PairInventoryConsumption[],
): { readonly shares6: bigint; readonly principalCost6: bigint; readonly buyCashFee6: bigint } {
  const totals = consumptionTotals(consumptions.filter((item) => item.lotId === lot.lotId)).get(lot.lotId)
    ?? { shares6: 0n, principal6: 0n, fee6: 0n };
  const remaining = {
    shares6: lot.netShares6 - totals.shares6,
    principalCost6: lot.principalCost6 - totals.principal6,
    buyCashFee6: lot.cashFee6 - totals.fee6,
  };
  if (remaining.shares6 < 0n) throw new PairLedgerError("LOT_OVERCONSUMED", `lot ${lot.lotId} shares are over-consumed`);
  if (remaining.principalCost6 < 0n || remaining.buyCashFee6 < 0n) {
    throw new PairLedgerError("LOT_BASIS_OVERALLOCATED", `lot ${lot.lotId} basis is over-allocated`);
  }
  return remaining;
}

export interface ConsumeInventoryFifoInput {
  readonly lots: readonly PairInventoryLot[];
  readonly existingConsumptions: readonly PairInventoryConsumption[];
  readonly groupId: PairGroupId;
  readonly tokenId: string;
  readonly shares6: bigint;
  readonly eventId: string;
  readonly consumptionKind: PairInventoryConsumptionKind;
  readonly createdAtMs: number;
  readonly consumptionId?: (lot: PairInventoryLot, ordinal: number) => string;
}

export type ConsumeInventoryFifoResult =
  | { readonly ok: true; readonly consumptions: readonly PairInventoryConsumption[]; readonly allocatedPrincipalCost6: bigint; readonly allocatedBuyCashFee6: bigint }
  | { readonly ok: false; readonly code: "INSUFFICIENT_GROUP_INVENTORY"; readonly availableShares6: bigint; readonly requestedShares6: bigint };

/** Consume only this group's token lots, ordered by acquisition time then lot id. */
export function consumeInventoryFifo(input: ConsumeInventoryFifoInput): ConsumeInventoryFifoResult {
  requirePositive("shares6", input.shares6);
  const candidates = input.lots
    .filter((lot) => lot.groupId === input.groupId && lot.tokenId === input.tokenId)
    .slice()
    .sort((a, b) => a.acquiredAtMs - b.acquiredAtMs || a.lotId.localeCompare(b.lotId));
  const remainingByLot = candidates.map((lot) => ({ lot, remaining: remainingInventoryLot(lot, input.existingConsumptions) }));
  const availableShares6 = remainingByLot.reduce((sum, item) => sum + item.remaining.shares6, 0n);
  if (availableShares6 < input.shares6) {
    return { ok: false, code: "INSUFFICIENT_GROUP_INVENTORY", availableShares6, requestedShares6: input.shares6 };
  }

  let needed6 = input.shares6;
  const appended: PairInventoryConsumption[] = [];
  for (const { lot, remaining } of remainingByLot) {
    if (needed6 === 0n) break;
    if (remaining.shares6 === 0n) continue;
    const shares6 = needed6 < remaining.shares6 ? needed6 : remaining.shares6;
    // Assign the exact residual basis on the final consumption of a lot.
    const finalConsumption = shares6 === remaining.shares6;
    const allocatedPrincipalCost6 = finalConsumption
      ? remaining.principalCost6
      : lot.principalCost6 * shares6 / lot.netShares6;
    const allocatedBuyCashFee6 = finalConsumption
      ? remaining.buyCashFee6
      : lot.cashFee6 * shares6 / lot.netShares6;
    const ordinal = appended.length;
    appended.push(Object.freeze({
      consumptionId: input.consumptionId?.(lot, ordinal)
        ?? `${input.eventId}:${lot.lotId}:${input.consumptionKind}`,
      lotId: lot.lotId,
      groupId: input.groupId,
      eventId: input.eventId,
      consumptionKind: input.consumptionKind,
      shares6,
      allocatedPrincipalCost6,
      allocatedBuyCashFee6,
      createdAtMs: input.createdAtMs,
    }));
    needed6 -= shares6;
  }
  return {
    ok: true,
    consumptions: appended,
    allocatedPrincipalCost6: appended.reduce((sum, item) => sum + item.allocatedPrincipalCost6, 0n),
    allocatedBuyCashFee6: appended.reduce((sum, item) => sum + item.allocatedBuyCashFee6, 0n),
  };
}

export function inventoryHoldings(
  lots: readonly PairInventoryLot[],
  consumptions: readonly PairInventoryConsumption[],
  groupId?: PairGroupId,
): Readonly<Record<string, bigint>> {
  const result: Record<string, bigint> = {};
  for (const lot of lots) {
    if (groupId !== undefined && lot.groupId !== groupId) continue;
    result[lot.tokenId] = (result[lot.tokenId] ?? 0n) + remainingInventoryLot(lot, consumptions).shares6;
  }
  return result;
}

export function fundingJournal(context: JournalContext, amount6: bigint): PairLedgerJournal {
  requirePositive("funding amount6", amount6);
  return journal(context, [
    { account: "ASSET_CASH_AVAILABLE", assetId: "USDC", amount6 },
    { account: "EQUITY_CAPITAL_SOURCE", assetId: "USDC", amount6: -amount6 },
  ]);
}

export function reserveCashJournal(context: JournalContext, amount6: bigint): PairLedgerJournal {
  requirePositive("reservation amount6", amount6);
  return journal(context, [
    { account: "ASSET_CASH_AVAILABLE", assetId: "USDC", amount6: -amount6 },
    { account: "ASSET_CASH_RESERVED", assetId: "USDC", amount6 },
  ]);
}

export function releaseCashReservationJournal(context: JournalContext, amount6: bigint): PairLedgerJournal {
  requirePositive("release amount6", amount6);
  return journal(context, [
    { account: "ASSET_CASH_RESERVED", assetId: "USDC", amount6: -amount6 },
    { account: "ASSET_CASH_AVAILABLE", assetId: "USDC", amount6 },
  ]);
}

export interface BuyFillJournalInput {
  readonly context: JournalContext;
  readonly tokenId: string;
  readonly outcome: PairOutcome;
  readonly principal6: bigint;
  readonly cashFee6: bigint;
  readonly grossShares6: bigint;
  readonly shareFee6: bigint;
  readonly netShares6: bigint;
  readonly inventoryLotId: string;
  readonly orderId: string;
  readonly fillId: string;
}

export function buyFillJournal(input: BuyFillJournalInput): PairLedgerJournal {
  requirePositive("grossShares6", input.grossShares6);
  requireNonNegative("principal6", input.principal6);
  requireNonNegative("cashFee6", input.cashFee6);
  requireNonNegative("shareFee6", input.shareFee6);
  requireNonNegative("netShares6", input.netShares6);
  if (input.netShares6 + input.shareFee6 !== input.grossShares6) {
    throw new PairLedgerError("BUY_SHARE_EQUATION_INVALID", "net shares plus share fee must equal gross shares");
  }
  const refs = { inventoryLotId: input.inventoryLotId, orderId: input.orderId, fillId: input.fillId };
  return journal(input.context, [
    { account: "ASSET_CASH_RESERVED", assetId: "USDC", amount6: -(input.principal6 + input.cashFee6), ...refs },
    { account: input.outcome === "UP" ? "ASSET_INVENTORY_COST_UP" : "ASSET_INVENTORY_COST_DOWN", assetId: "USDC", amount6: input.principal6, ...refs },
    { account: "EXPENSE_TRADING_FEE", assetId: "USDC", amount6: input.cashFee6, ...refs },
    { account: "ASSET_TOKEN_INVENTORY", assetId: input.tokenId, amount6: input.netShares6, ...refs },
    { account: "EXPENSE_SHARE_FEE", assetId: input.tokenId, amount6: input.shareFee6, ...refs },
    { account: "CLEARING_TOKEN_ACQUISITION", assetId: input.tokenId, amount6: -input.grossShares6, ...refs },
  ]);
}

export interface SellRecoveryJournalInput {
  readonly context: JournalContext;
  readonly tokenId: string;
  readonly outcome: PairOutcome;
  readonly grossProceeds6: bigint;
  readonly cashFee6: bigint;
  readonly netProceeds6: bigint;
  readonly sharesSold6: bigint;
  readonly allocatedPrincipalCost6: bigint;
  readonly inventoryConsumptionId: string | null;
  readonly orderId: string;
  readonly fillId: string;
}

export function sellRecoveryJournal(input: SellRecoveryJournalInput): PairLedgerJournal {
  requirePositive("sharesSold6", input.sharesSold6);
  requireNonNegative("grossProceeds6", input.grossProceeds6);
  requireNonNegative("cashFee6", input.cashFee6);
  requireNonNegative("allocatedPrincipalCost6", input.allocatedPrincipalCost6);
  if (input.netProceeds6 !== input.grossProceeds6 - input.cashFee6 || input.netProceeds6 < 0n) {
    throw new PairLedgerError("SELL_CASH_EQUATION_INVALID", "net proceeds must equal gross proceeds minus cash fee");
  }
  const refs = { inventoryConsumptionId: input.inventoryConsumptionId, orderId: input.orderId, fillId: input.fillId };
  return journal(input.context, [
    { account: "ASSET_TOKEN_INVENTORY", assetId: input.tokenId, amount6: -input.sharesSold6, ...refs },
    { account: "CLEARING_TOKEN_DISPOSAL", assetId: input.tokenId, amount6: input.sharesSold6, ...refs },
    { account: "ASSET_CASH_AVAILABLE", assetId: "USDC", amount6: input.netProceeds6, ...refs },
    { account: "EXPENSE_TRADING_FEE", assetId: "USDC", amount6: input.cashFee6, ...refs },
    { account: "REVENUE_RECOVERY_SALE", assetId: "USDC", amount6: -input.grossProceeds6, ...refs },
    { account: input.outcome === "UP" ? "ASSET_INVENTORY_COST_UP" : "ASSET_INVENTORY_COST_DOWN", assetId: "USDC", amount6: -input.allocatedPrincipalCost6, ...refs },
    { account: "EXPENSE_REALIZED_COST_BASIS", assetId: "USDC", amount6: input.allocatedPrincipalCost6, ...refs },
  ]);
}

export interface VirtualMergeJournalInput {
  readonly context: JournalContext;
  readonly upTokenId: string;
  readonly downTokenId: string;
  readonly matchedShares6: bigint;
  readonly allocatedUpPrincipalCost6: bigint;
  readonly allocatedDownPrincipalCost6: bigint;
  readonly settlementCost6: bigint;
  readonly costSource: "AVAILABLE" | "RESERVED";
}

export function virtualMergeJournal(input: VirtualMergeJournalInput): PairLedgerJournal {
  requirePositive("matchedShares6", input.matchedShares6);
  requireNonNegative("allocatedUpPrincipalCost6", input.allocatedUpPrincipalCost6);
  requireNonNegative("allocatedDownPrincipalCost6", input.allocatedDownPrincipalCost6);
  requireNonNegative("settlementCost6", input.settlementCost6);
  if (input.costSource === "AVAILABLE" && input.settlementCost6 > input.matchedShares6) {
    throw new PairLedgerError("MERGE_COST_EXCEEDS_PAYOUT", "available-cash merge credit cannot be negative");
  }
  const cashLines: readonly LineInput[] = input.costSource === "RESERVED"
    ? [
        { account: "ASSET_CASH_RESERVED", assetId: "USDC", amount6: -input.settlementCost6 },
        { account: "ASSET_CASH_AVAILABLE", assetId: "USDC", amount6: input.matchedShares6 },
      ]
    : [{ account: "ASSET_CASH_AVAILABLE", assetId: "USDC", amount6: input.matchedShares6 - input.settlementCost6 }];
  return journal(input.context, [
    { account: "ASSET_TOKEN_INVENTORY", assetId: input.upTokenId, amount6: -input.matchedShares6 },
    { account: "CLEARING_TOKEN_DISPOSAL", assetId: input.upTokenId, amount6: input.matchedShares6 },
    { account: "ASSET_TOKEN_INVENTORY", assetId: input.downTokenId, amount6: -input.matchedShares6 },
    { account: "CLEARING_TOKEN_DISPOSAL", assetId: input.downTokenId, amount6: input.matchedShares6 },
    ...cashLines,
    { account: "REVENUE_VIRTUAL_MERGE", assetId: "USDC", amount6: -input.matchedShares6 },
    { account: "EXPENSE_SETTLEMENT_COST", assetId: "USDC", amount6: input.settlementCost6 },
    { account: "ASSET_INVENTORY_COST_UP", assetId: "USDC", amount6: -input.allocatedUpPrincipalCost6 },
    { account: "ASSET_INVENTORY_COST_DOWN", assetId: "USDC", amount6: -input.allocatedDownPrincipalCost6 },
    { account: "EXPENSE_REALIZED_COST_BASIS", assetId: "USDC", amount6: input.allocatedUpPrincipalCost6 + input.allocatedDownPrincipalCost6 },
  ]);
}

export interface ResolutionJournalInput {
  readonly context: JournalContext;
  readonly winner: PairOutcome;
  readonly upTokenId: string;
  readonly downTokenId: string;
  readonly upShares6: bigint;
  readonly downShares6: bigint;
  readonly allocatedUpPrincipalCost6: bigint;
  readonly allocatedDownPrincipalCost6: bigint;
}

export function resolutionJournal(input: ResolutionJournalInput): PairLedgerJournal {
  requireNonNegative("upShares6", input.upShares6);
  requireNonNegative("downShares6", input.downShares6);
  if (input.upShares6 + input.downShares6 <= 0n) throw new PairLedgerError("NO_INVENTORY_TO_RESOLVE", "resolution requires remaining inventory");
  requireNonNegative("allocatedUpPrincipalCost6", input.allocatedUpPrincipalCost6);
  requireNonNegative("allocatedDownPrincipalCost6", input.allocatedDownPrincipalCost6);
  const payout6 = input.winner === "UP" ? input.upShares6 : input.downShares6;
  return journal(input.context, [
    { account: "ASSET_TOKEN_INVENTORY", assetId: input.upTokenId, amount6: -input.upShares6 },
    { account: "CLEARING_TOKEN_DISPOSAL", assetId: input.upTokenId, amount6: input.upShares6 },
    { account: "ASSET_TOKEN_INVENTORY", assetId: input.downTokenId, amount6: -input.downShares6 },
    { account: "CLEARING_TOKEN_DISPOSAL", assetId: input.downTokenId, amount6: input.downShares6 },
    { account: "ASSET_CASH_AVAILABLE", assetId: "USDC", amount6: payout6 },
    { account: "REVENUE_RESOLUTION", assetId: "USDC", amount6: -payout6 },
    { account: "ASSET_INVENTORY_COST_UP", assetId: "USDC", amount6: -input.allocatedUpPrincipalCost6 },
    { account: "ASSET_INVENTORY_COST_DOWN", assetId: "USDC", amount6: -input.allocatedDownPrincipalCost6 },
    { account: "EXPENSE_REALIZED_COST_BASIS", assetId: "USDC", amount6: input.allocatedUpPrincipalCost6 + input.allocatedDownPrincipalCost6 },
  ]);
}

export function settlementCostJournal(
  context: JournalContext,
  amount6: bigint,
  source: "AVAILABLE" | "RESERVED",
): PairLedgerJournal {
  requirePositive("settlement cost amount6", amount6);
  return journal(context, [
    { account: source === "RESERVED" ? "ASSET_CASH_RESERVED" : "ASSET_CASH_AVAILABLE", assetId: "USDC", amount6: -amount6 },
    { account: "EXPENSE_SETTLEMENT_COST", assetId: "USDC", amount6 },
  ]);
}

export function validateJournalConservation(entries: readonly PairLedgerEntry[]): readonly PairLedgerConservationViolation[] {
  const sums = new Map<string, { journalId: string; assetId: string; amount6: bigint }>();
  for (const entry of entries) {
    const key = `${entry.journalId}\u0000${entry.assetId}`;
    const prior = sums.get(key);
    sums.set(key, {
      journalId: entry.journalId,
      assetId: entry.assetId,
      amount6: (prior?.amount6 ?? 0n) + entry.amount6,
    });
  }
  return [...sums.values()]
    .filter(({ amount6 }) => amount6 !== 0n)
    .map(({ journalId, assetId, amount6 }) => ({ journalId, assetId, imbalance6: amount6 }));
}

export function assertBalancedJournal(value: PairLedgerJournal | readonly PairLedgerEntry[]): void {
  const entries: readonly PairLedgerEntry[] = "journalId" in value ? value.entries : value;
  const violations = validateJournalConservation(entries);
  if (violations.length > 0) {
    const detail = violations.map((item) => `${item.journalId}/${item.assetId}=${item.imbalance6}`).join(", ");
    throw new PairLedgerError("UNBALANCED_JOURNAL", detail);
  }
}

export interface PairLedgerProjection {
  readonly balances: Readonly<Record<string, bigint>>;
  readonly cashAvailable6: bigint;
  readonly cashReserved6: bigint;
  readonly accountCash6: bigint;
  readonly tokenInventoryByAsset: Readonly<Record<string, bigint>>;
  readonly realizedRevenue6: bigint;
  readonly realizedExpense6: bigint;
  readonly terminalRealizedPnl6: bigint;
}

export function ledgerBalanceKey(assetId: string, account: PairLedgerAccount): string {
  return `${assetId}:${account}`;
}

export function replayPairLedger(entries: readonly PairLedgerEntry[]): PairLedgerProjection {
  assertBalancedJournal(entries);
  const balances: Record<string, bigint> = {};
  for (const entry of entries) {
    const key = ledgerBalanceKey(entry.assetId, entry.account);
    balances[key] = (balances[key] ?? 0n) + entry.amount6;
  }
  const balance = (assetId: string, account: PairLedgerAccount): bigint => balances[ledgerBalanceKey(assetId, account)] ?? 0n;
  const cashAvailable6 = balance("USDC", "ASSET_CASH_AVAILABLE");
  const cashReserved6 = balance("USDC", "ASSET_CASH_RESERVED");
  const realizedRevenue6 = -(
    balance("USDC", "REVENUE_RECOVERY_SALE")
    + balance("USDC", "REVENUE_VIRTUAL_MERGE")
    + balance("USDC", "REVENUE_RESOLUTION")
  );
  const realizedExpense6 = balance("USDC", "EXPENSE_TRADING_FEE")
    + balance("USDC", "EXPENSE_SETTLEMENT_COST")
    + balance("USDC", "EXPENSE_REALIZED_COST_BASIS");
  const tokenInventoryByAsset: Record<string, bigint> = {};
  for (const entry of entries) {
    if (entry.account === "ASSET_TOKEN_INVENTORY") {
      tokenInventoryByAsset[entry.assetId] = (tokenInventoryByAsset[entry.assetId] ?? 0n) + entry.amount6;
    }
  }
  return {
    balances,
    cashAvailable6,
    cashReserved6,
    accountCash6: cashAvailable6 + cashReserved6,
    tokenInventoryByAsset,
    realizedRevenue6,
    realizedExpense6,
    terminalRealizedPnl6: realizedRevenue6 - realizedExpense6,
  };
}

export function flattenJournals(journals: readonly PairLedgerJournal[]): readonly PairLedgerEntry[] {
  return journals.flatMap(({ entries }) => entries);
}
