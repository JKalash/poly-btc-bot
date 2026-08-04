import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PairGroupId } from "../src/contracts";
import {
  PairLedgerError,
  assertBalancedJournal,
  buyFillJournal,
  consumeInventoryFifo,
  createInventoryLot,
  flattenJournals,
  fundingJournal,
  inventoryHoldings,
  releaseCashReservationJournal,
  remainingInventoryLot,
  replayPairLedger,
  reserveCashJournal,
  sellRecoveryJournal,
  settlementCostJournal,
  validateJournalConservation,
  virtualMergeJournal,
  type JournalContext,
  type PairInventoryConsumption,
  type PairInventoryLot,
  type PairLedgerEntry,
} from "../src/ledger";

const GROUP = "group-ledger" as PairGroupId;
const OTHER_GROUP = "other-group" as PairGroupId;

function context(journalId: string, groupId: PairGroupId | null = GROUP): JournalContext {
  return {
    journalId,
    pairAccountId: "pair-account",
    groupId,
    causationEventId: groupId === null ? null : `event-${journalId}`,
    causationKind: journalId,
    occurredAtMs: 100,
    recordedAtMs: 101,
    metadata: { version: "v1" },
  };
}

function lot(overrides: Partial<PairInventoryLot> & Pick<PairInventoryLot, "lotId" | "tokenId" | "outcome">): PairInventoryLot {
  return createInventoryLot({
    groupId: GROUP,
    marketId: "market",
    sourceFillId: `fill-${overrides.lotId}`,
    grossShares6: 3n,
    netShares6: 3n,
    principalCost6: 10n,
    cashFee6: 2n,
    shareFee6: 0n,
    acquiredAtMs: 1,
    ...overrides,
  });
}

describe("BPAIR-040 immutable inventory lots", () => {
  it("validates the gross/net/share-fee equation and derives total cash cost", () => {
    const value = createInventoryLot({
      lotId: "lot",
      groupId: GROUP,
      marketId: "market",
      tokenId: "up",
      outcome: "UP",
      sourceFillId: "fill",
      grossShares6: 10n,
      netShares6: 9n,
      principalCost6: 6n,
      cashFee6: 2n,
      shareFee6: 1n,
      acquiredAtMs: 1,
    });
    expect(value.totalCashCost6).toBe(8n);
    expect(Object.isFrozen(value)).toBe(true);
    expect(() => createInventoryLot({ ...value, lotId: "bad", netShares6: 8n, totalCashCost6: undefined } as never)).toThrow(PairLedgerError);
  });

  it("consumes FIFO and assigns every cost residual to the final lot consumption", () => {
    const lots = [
      lot({ lotId: "a", tokenId: "up", outcome: "UP", acquiredAtMs: 1 }),
      lot({ lotId: "b", tokenId: "up", outcome: "UP", netShares6: 2n, grossShares6: 2n, principalCost6: 9n, cashFee6: 1n, acquiredAtMs: 2 }),
    ];
    const first = consumeInventoryFifo({
      lots,
      existingConsumptions: [],
      groupId: GROUP,
      tokenId: "up",
      shares6: 2n,
      eventId: "sell-1",
      consumptionKind: "SELL_RECOVERY",
      createdAtMs: 10,
    });
    expect(first).toMatchObject({ ok: true, allocatedPrincipalCost6: 6n, allocatedBuyCashFee6: 1n });
    if (!first.ok) return;
    const second = consumeInventoryFifo({
      lots,
      existingConsumptions: first.consumptions,
      groupId: GROUP,
      tokenId: "up",
      shares6: 2n,
      eventId: "sell-2",
      consumptionKind: "SELL_RECOVERY",
      createdAtMs: 11,
    });
    expect(second).toMatchObject({ ok: true, allocatedPrincipalCost6: 8n, allocatedBuyCashFee6: 1n });
    if (!second.ok) return;
    expect(second.consumptions.map(({ lotId, shares6 }) => [lotId, shares6])).toEqual([["a", 1n], ["b", 1n]]);

    const consumed = [...first.consumptions, ...second.consumptions];
    const final = consumeInventoryFifo({
      lots,
      existingConsumptions: consumed,
      groupId: GROUP,
      tokenId: "up",
      shares6: 1n,
      eventId: "sell-3",
      consumptionKind: "SELL_RECOVERY",
      createdAtMs: 12,
    });
    expect(final).toMatchObject({ ok: true, allocatedPrincipalCost6: 5n, allocatedBuyCashFee6: 1n });
    if (!final.ok) return;
    const all = [...consumed, ...final.consumptions];
    expect(lots.map((item) => remainingInventoryLot(item, all))).toEqual([
      { shares6: 0n, principalCost6: 0n, buyCashFee6: 0n },
      { shares6: 0n, principalCost6: 0n, buyCashFee6: 0n },
    ]);
    expect(all.reduce((sum, item) => sum + item.allocatedPrincipalCost6, 0n)).toBe(19n);
    expect(all.reduce((sum, item) => sum + item.allocatedBuyCashFee6, 0n)).toBe(3n);
  });

  it("never borrows inventory from another group and rejects over-consumption", () => {
    const own = lot({ lotId: "own", tokenId: "up", outcome: "UP", netShares6: 1n, grossShares6: 1n });
    const foreign = lot({ lotId: "foreign", tokenId: "up", outcome: "UP", groupId: OTHER_GROUP, netShares6: 100n, grossShares6: 100n });
    expect(consumeInventoryFifo({
      lots: [own, foreign], existingConsumptions: [], groupId: GROUP, tokenId: "up", shares6: 2n,
      eventId: "sell", consumptionKind: "SELL_RECOVERY", createdAtMs: 1,
    })).toEqual({ ok: false, code: "INSUFFICIENT_GROUP_INVENTORY", availableShares6: 1n, requestedShares6: 2n });
  });

  it("preserves lot shares and exact basis under randomized sequential consumption", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
      fc.bigInt({ min: 0n, max: 1_000_000_000_000n }),
      fc.bigInt({ min: 0n, max: 1_000_000_000_000n }),
      fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 1, maxLength: 20 }),
      (shares6, principal6, fee6, requestedChunks) => {
        const value = lot({ lotId: "property", tokenId: "up", outcome: "UP", grossShares6: shares6, netShares6: shares6, principalCost6: principal6, cashFee6: fee6 });
        let remaining6 = shares6;
        let prior: readonly PairInventoryConsumption[] = [];
        let event = 0;
        for (const raw of requestedChunks) {
          if (remaining6 === 0n) break;
          const amount6 = raw < remaining6 ? raw : remaining6;
          const result = consumeInventoryFifo({ lots: [value], existingConsumptions: prior, groupId: GROUP, tokenId: "up", shares6: amount6, eventId: `event-${event}`, consumptionKind: "SELL_RECOVERY", createdAtMs: event });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          prior = [...prior, ...result.consumptions];
          remaining6 -= amount6;
          event += 1;
        }
        if (remaining6 > 0n) {
          const result = consumeInventoryFifo({ lots: [value], existingConsumptions: prior, groupId: GROUP, tokenId: "up", shares6: remaining6, eventId: "final", consumptionKind: "RESOLUTION", createdAtMs: 99 });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          prior = [...prior, ...result.consumptions];
        }
        expect(prior.reduce((sum, item) => sum + item.shares6, 0n)).toBe(shares6);
        expect(prior.reduce((sum, item) => sum + item.allocatedPrincipalCost6, 0n)).toBe(principal6);
        expect(prior.reduce((sum, item) => sum + item.allocatedBuyCashFee6, 0n)).toBe(fee6);
      },
    ));
  });
});

describe("BPAIR-040 mandatory journal templates and conservation", () => {
  it("posts funding/reserve/release, buy, sell, merge, and standalone cost as balanced per-asset journals", () => {
    const journals = [
      fundingJournal(context("fund", null), 10_000_000n),
      reserveCashJournal(context("reserve"), 1_000_000n),
      releaseCashReservationJournal(context("release"), 1n),
      buyFillJournal({ context: context("buy"), tokenId: "up", outcome: "UP", principal6: 450_000n, cashFee6: 10n, grossShares6: 1_000_000n, shareFee6: 5n, netShares6: 999_995n, inventoryLotId: "lot", orderId: "order", fillId: "fill" }),
      sellRecoveryJournal({ context: context("sell"), tokenId: "up", outcome: "UP", grossProceeds6: 300_000n, cashFee6: 10n, netProceeds6: 299_990n, sharesSold6: 500_000n, allocatedPrincipalCost6: 200_000n, inventoryConsumptionId: "consumption", orderId: "sell-order", fillId: "sell-fill" }),
      virtualMergeJournal({ context: context("merge"), upTokenId: "up", downTokenId: "down", matchedShares6: 400_000n, allocatedUpPrincipalCost6: 180_000n, allocatedDownPrincipalCost6: 190_000n, settlementCost6: 5n, costSource: "RESERVED" }),
      settlementCostJournal(context("cost"), 7n, "AVAILABLE"),
    ];
    for (const item of journals) {
      expect(validateJournalConservation(item.entries)).toEqual([]);
      expect(() => assertBalancedJournal(item)).not.toThrow();
      expect(item.entries.map(({ lineNumber }) => lineNumber)).toEqual(item.entries.map((_, index) => index));
    }
  });

  it("keeps USDC and each token independent and detects a one-micro corruption", () => {
    const value = buyFillJournal({ context: context("buy-corrupt"), tokenId: "up", outcome: "UP", principal6: 10n, cashFee6: 1n, grossShares6: 20n, shareFee6: 2n, netShares6: 18n, inventoryLotId: "lot", orderId: "order", fillId: "fill" });
    const corrupt: PairLedgerEntry[] = value.entries.map((entry, index) => index === 0 ? { ...entry, amount6: entry.amount6 + 1n } : entry);
    expect(validateJournalConservation(corrupt)).toEqual([{ journalId: "buy-corrupt", assetId: "USDC", imbalance6: 1n }]);
    expect(() => assertBalancedJournal(corrupt)).toThrow(/UNBALANCED_JOURNAL/);
  });

  it("replays exact cash, token inventory, and realized P&L without double-posting buy fees", () => {
    const upLot = createInventoryLot({ lotId: "up-lot", groupId: GROUP, marketId: "market", tokenId: "up", outcome: "UP", sourceFillId: "up-fill", grossShares6: 1_000_000n, netShares6: 1_000_000n, principalCost6: 450_000n, cashFee6: 10_000n, shareFee6: 0n, acquiredAtMs: 1 });
    const downLot = createInventoryLot({ lotId: "down-lot", groupId: GROUP, marketId: "market", tokenId: "down", outcome: "DOWN", sourceFillId: "down-fill", grossShares6: 1_000_000n, netShares6: 1_000_000n, principalCost6: 450_000n, cashFee6: 10_000n, shareFee6: 0n, acquiredAtMs: 2 });
    const entries = flattenJournals([
      fundingJournal(context("fund-flow", null), 10_000_000n),
      reserveCashJournal(context("reserve-flow"), 1_000_000n),
      buyFillJournal({ context: context("up-buy"), tokenId: "up", outcome: "UP", principal6: upLot.principalCost6, cashFee6: upLot.cashFee6, grossShares6: upLot.grossShares6, shareFee6: 0n, netShares6: upLot.netShares6, inventoryLotId: upLot.lotId, orderId: "up-order", fillId: upLot.sourceFillId }),
      buyFillJournal({ context: context("down-buy"), tokenId: "down", outcome: "DOWN", principal6: downLot.principalCost6, cashFee6: downLot.cashFee6, grossShares6: downLot.grossShares6, shareFee6: 0n, netShares6: downLot.netShares6, inventoryLotId: downLot.lotId, orderId: "down-order", fillId: downLot.sourceFillId }),
      virtualMergeJournal({ context: context("merge-flow"), upTokenId: "up", downTokenId: "down", matchedShares6: 1_000_000n, allocatedUpPrincipalCost6: 450_000n, allocatedDownPrincipalCost6: 450_000n, settlementCost6: 5_000n, costSource: "RESERVED" }),
      releaseCashReservationJournal(context("release-flow"), 75_000n),
    ]);
    const projection = replayPairLedger(entries);
    expect(projection.tokenInventoryByAsset).toMatchObject({ up: 0n, down: 0n });
    expect(projection.cashReserved6).toBe(0n);
    expect(projection.accountCash6).toBe(10_075_000n);
    expect(projection.realizedRevenue6).toBe(1_000_000n);
    expect(projection.realizedExpense6).toBe(925_000n);
    expect(projection.terminalRealizedPnl6).toBe(75_000n);
    expect(inventoryHoldings([upLot, downLot], [], GROUP)).toEqual({ up: 1_000_000n, down: 1_000_000n });
  });

  it("conserves randomized exact BUY journals above Number safe range", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 1n, max: 10n ** 24n }),
      fc.bigInt({ min: 0n, max: 10n ** 24n }),
      fc.bigInt({ min: 0n, max: 10n ** 24n }),
      (gross6, principal6, cashFee6) => {
        const shareFee6 = gross6 / 7n;
        const value = buyFillJournal({ context: context(`property-${gross6}-${principal6}-${cashFee6}`), tokenId: "token", outcome: "UP", principal6, cashFee6, grossShares6: gross6, shareFee6, netShares6: gross6 - shareFee6, inventoryLotId: "lot", orderId: "order", fillId: "fill" });
        expect(validateJournalConservation(value.entries)).toEqual([]);
      },
    ));
  });
});
