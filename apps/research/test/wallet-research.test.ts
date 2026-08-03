import { makeDb, walletResearchSnapshots } from "@b5p/db";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { workspaceRoot } from "../src/repro/common";
import {
  analyzeWallet, parseWalletActivityJson, walletSnapshotId,
  type WalletActivityInput,
} from "../src/wallet-research";
import { persistWalletResearchSnapshot } from "../src/wallet-research-persist";

/**
 * R12 wallet-research pipeline tests — committed synthetic fixtures only, no
 * network anywhere. The core claims under test:
 *  - the honest split (trading P&L / paid incentives / unrealized mark /
 *    unlabeled flows) is computed EXACTLY in bigint;
 *  - paid incentives NEVER leak into trading P&L;
 *  - incomplete records surface as explicit dataGaps, never silent drops;
 *  - persistence is idempotent via the content-addressed id;
 *  - the pipeline observes public claims (SOURCE_CLAIM_UNVERIFIED / DATA_GATED),
 *    it never claims to have verified or reproduced one.
 */

const fixturesDir = path.join(workspaceRoot(), "apps", "research", "fixtures");
const NOW = 1_770_100_000_000;
const OPTS = { nowMs: NOW, configVersion: 1 };

function loadFixture(name: string): WalletActivityInput {
  return parseWalletActivityJson(JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")));
}
const fixture1 = () => loadFixture("wallet-synthetic.json");
const fixture2 = () => loadFixture("wallet-synthetic-genuine.json");

describe("wallet research: honest vs naive split (fixture 1: reward-funded 'whale')", () => {
  it("computes the split exactly in bigint micro-USDC", () => {
    const a = analyzeWallet(fixture1(), OPTS);
    expect(a.tradingPnl6).toBe(-25_420_000n);            // -25.42 USDC, fees included
    expect(a.feesPaid6).toBe(7_420_000n);                // 3 + 2.82 + 1.60
    expect(a.snapshot.rewardsPaid6).toBe(180_000_000n);
    expect(a.snapshot.rebatesPaid6).toBe(45_000_000n);
    expect(a.incentiveIncome6).toBe(225_000_000n);
    expect(a.snapshot.inventoryCostBasis6).toBe(160_000_000n); // 400 shares @ 0.40
    expect(a.snapshot.openPositionsValue6).toBe(280_000_000n); // marked 0.70
    expect(a.unrealizedAtMark6).toBe(120_000_000n);
    expect(a.unlabeledTransferNet6).toBe(50_000_000n);
    expect(a.naiveApparentProfit6).toBe(369_580_000n);   // +369.58 USDC "profit"
    // flows
    expect(a.snapshot.deposits6).toBe(1_000_000_000n);
    expect(a.snapshot.withdrawals6).toBe(100_000_000n);
    expect(a.snapshot.transfersIn6).toBe(50_000_000n);
    expect(a.snapshot.transfersOut6).toBe(0n);
    expect(a.snapshot.tradesCount).toBe(3);
    expect(a.snapshot.splitsCount).toBe(1);
    expect(a.snapshot.mergesCount).toBe(1);
  });

  it("detects the naive-vs-honest divergence: naive looks profitable, trading P&L is negative", () => {
    const a = analyzeWallet(fixture1(), OPTS);
    expect(a.naiveApparentProfit6!).toBeGreaterThan(0n);
    expect(a.tradingPnl6).toBeLessThan(0n);
    // the entire apparent edge is incentives + mark + unlabeled inflow
    expect(a.incentiveIncome6 + a.unrealizedAtMark6! + a.unlabeledTransferNet6)
      .toBe(a.naiveApparentProfit6! - a.tradingPnl6);
  });

  it("naive identity holds exactly against independent cash accounting", () => {
    const a = analyzeWallet(fixture1(), OPTS);
    // cash delta computed record-by-record inside the analyzer; the naive
    // observer view is cash delta + inventory at mark - LABELED external flows
    // (deposit 1000 in, withdrawal 100 out; the 50 transfer is unlabeled).
    const labeledExternalNetIn6 = 1_000_000_000n - 100_000_000n;
    expect(a.cashDelta6).toBe(989_580_000n);
    expect(a.cashDelta6 + a.snapshot.openPositionsValue6! - labeledExternalNetIn6)
      .toBe(a.naiveApparentProfit6!);
  });

  it("split+merge round trip is P&L-neutral and counted, never dropped", () => {
    const base = fixture1();
    const withoutCtf = { ...base, records: base.records.filter((r) => r.kind !== "SPLIT" && r.kind !== "MERGE") };
    const a = analyzeWallet(base, OPTS);
    const b = analyzeWallet(withoutCtf, OPTS);
    expect(a.tradingPnl6).toBe(b.tradingPnl6);
    expect(a.snapshot.splitsCount).toBe(1);
    expect(b.snapshot.splitsCount).toBe(0);
  });

  it("is labeled as an observation of an unverified claim, never a reproduction", () => {
    const a = analyzeWallet(fixture1(), OPTS);
    expect(a.snapshot.evidenceLabel).toBe("SOURCE_CLAIM_UNVERIFIED");
    expect(a.snapshot.evidenceLabel).not.toMatch(/REPRODUCED/);
    expect(a.snapshot.completeInterval).toBe(false); // gaps present + history not asserted complete
    const attribution = a.snapshot.attribution as Record<string, unknown>;
    expect(attribution.naiveApparentProfit6).toBe("369580000");
    expect(attribution.tradingPnl6).toBe("-25420000");
    expect((attribution.claimProvenance as Record<string, unknown>).claimSource).toContain("synthetic construction");
  });
});

describe("wallet research: incentives never count as trading P&L", () => {
  it("removing all reward/rebate records leaves trading P&L bit-identical", () => {
    const base = fixture1();
    const noIncentives = {
      ...base,
      records: base.records.filter((r) => r.kind !== "REWARD_PAID" && r.kind !== "REBATE_PAID"),
    };
    const a = analyzeWallet(base, OPTS);
    const b = analyzeWallet(noIncentives, OPTS);
    expect(b.tradingPnl6).toBe(a.tradingPnl6);
    expect(b.incentiveIncome6).toBe(0n);
    expect(b.snapshot.rewardsPaid6).toBe(0n);
    expect(b.snapshot.rebatesPaid6).toBe(0n);
    // naive apparent profit drops by exactly the paid incentives
    expect(a.naiveApparentProfit6! - b.naiveApparentProfit6!).toBe(225_000_000n);
  });
});

describe("wallet research: fixture 2 (genuinely profitable) for contrast", () => {
  it("positive trading P&L, no incentives, no gaps, honest == naive", () => {
    const a = analyzeWallet(fixture2(), OPTS);
    expect(a.tradingPnl6).toBe(298_000_000n); // 500 payout - 200 basis - 2 fee
    expect(a.incentiveIncome6).toBe(0n);
    expect(a.unrealizedAtMark6).toBe(0n);     // no open inventory
    expect(a.unlabeledTransferNet6).toBe(0n);
    expect(a.naiveApparentProfit6).toBe(a.tradingPnl6);
    expect(a.snapshot.dataGaps).toBeNull();
    expect(a.snapshot.completeInterval).toBe(true);
    expect(a.snapshot.evidenceLabel).toBe("SOURCE_CLAIM_UNVERIFIED");
    expect(a.snapshot.redeemsCount).toBe(1);
  });
});

describe("wallet research: dataGaps are explicit, never silent", () => {
  it("fixture 1 carries unlabeled-transfer and unknown-counterparty gaps", () => {
    const a = analyzeWallet(fixture1(), OPTS);
    const gaps = a.snapshot.dataGaps as Record<string, unknown>;
    expect(gaps).not.toBeNull();
    const unlabeled = gaps.unlabeledTransfers as Array<Record<string, unknown>>;
    expect(unlabeled).toHaveLength(1);
    expect(unlabeled[0]!.amount6).toBe("50000000");
    expect(unlabeled[0]!.direction).toBe("IN");
    expect(gaps.unknownCounterparties).toHaveLength(1);
    expect(gaps.historyCompletenessUnasserted).toBeTruthy();
  });

  it("a missing price mark gates the snapshot: value null, gap named, DATA_GATED", () => {
    const base = fixture1();
    const a = analyzeWallet({ ...base, marks: {} }, OPTS);
    expect(a.snapshot.openPositionsValue6).toBeNull();
    expect(a.unrealizedAtMark6).toBeNull();
    expect(a.naiveApparentProfit6).toBeNull(); // cannot be honestly computed without marks
    expect(a.snapshot.inventoryCostBasis6).toBe(160_000_000n); // basis still exact
    const gaps = a.snapshot.dataGaps as Record<string, unknown>;
    const missing = gaps.missingPriceMarks as Array<Record<string, unknown>>;
    expect(missing.map((m) => m.tokenId)).toEqual(["T-YES-2"]);
    expect(a.snapshot.evidenceLabel).toBe("DATA_GATED");
  });

  it("selling shares never held is recorded as a position underflow and gates the snapshot", () => {
    const base = fixture2();
    const a = analyzeWallet({
      ...base,
      historyComplete: false,
      records: [
        { kind: "TRADE", tsMs: base.observationStartMs + 1, marketId: "MX", tokenId: "T-GHOST", side: "SELL", shares6: 100_000_000n, price6: 500_000n, fee6: 0n, role: null },
        ...base.records,
      ],
    }, OPTS);
    const gaps = a.snapshot.dataGaps as Record<string, unknown>;
    const underflows = gaps.positionUnderflows as Array<Record<string, unknown>>;
    expect(underflows).toHaveLength(1);
    expect(underflows[0]!.tokenId).toBe("T-GHOST");
    expect(underflows[0]!.missingShares6).toBe("100000000");
    expect(a.snapshot.evidenceLabel).toBe("DATA_GATED");
    expect(a.snapshot.completeInterval).toBe(false);
  });

  it("records outside the observation window are processed AND flagged", () => {
    const base = fixture2();
    const a = analyzeWallet({
      ...base,
      records: [...base.records, { kind: "DEPOSIT", tsMs: base.observationEndMs + 1000, amount6: 5_000_000n }],
    }, OPTS);
    expect(a.snapshot.deposits6).toBe(505_000_000n); // still counted
    const gaps = a.snapshot.dataGaps as Record<string, unknown>;
    expect(gaps.outOfWindowRecords).toHaveLength(1);
  });
});

describe("wallet research: determinism and content-addressed ids", () => {
  it("same input => same id and identical economics; changed records => different id", () => {
    const a = analyzeWallet(fixture1(), OPTS);
    const b = analyzeWallet(fixture1(), OPTS);
    expect(a.snapshot.id).toBe(b.snapshot.id);
    expect(a.snapshot.id).toMatch(/^wrs-[0-9a-f]{16}$/);
    expect(a.tradingPnl6).toBe(b.tradingPnl6);

    const mutated = fixture1();
    mutated.records = mutated.records.filter((r) => r.kind !== "REWARD_PAID");
    expect(walletSnapshotId(mutated, 1)).not.toBe(a.snapshot.id);
    expect(walletSnapshotId(fixture1(), 2)).not.toBe(a.snapshot.id); // configVersion is part of the address
  });

  it("record order in the file does not change the analysis (timestamp-sorted)", () => {
    const base = fixture1();
    const reversed = { ...base, records: [...base.records].reverse() };
    const a = analyzeWallet(base, OPTS);
    const b = analyzeWallet(reversed, OPTS);
    expect(b.tradingPnl6).toBe(a.tradingPnl6);
    expect(b.naiveApparentProfit6).toBe(a.naiveApparentProfit6);
  });
});

describe("wallet research: idempotent persistence (in-memory PGlite, no network)", () => {
  it("persists once, re-persists the same row, and round-trips the bigint split", async () => {
    const a = analyzeWallet(fixture1(), OPTS);
    const handle = await makeDb({ pgliteDir: "memory://wallet-research-test", databaseUrl: undefined });
    try {
      await handle.migrate();
      const p1 = await persistWalletResearchSnapshot(handle, a.snapshot);
      // re-analysis mints a fresh correlationId but the SAME content-addressed id
      const p2 = await persistWalletResearchSnapshot(handle, analyzeWallet(fixture1(), OPTS).snapshot);
      expect(p2.id).toBe(p1.id);

      const rows = await handle.db.select().from(walletResearchSnapshots);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.id).toBe(a.snapshot.id);
      expect(row.tradingPnl6).toBe(-25_420_000n);
      expect(row.rewardsPaid6).toBe(180_000_000n);
      expect(row.rebatesPaid6).toBe(45_000_000n);
      expect(row.openPositionsValue6).toBe(280_000_000n);
      expect(row.inventoryCostBasis6).toBe(160_000_000n);
      expect(row.evidenceLabel).toBe("SOURCE_CLAIM_UNVERIFIED");
      expect(row.completeInterval).toBe(false);
      expect((row.attribution as Record<string, unknown>).naiveApparentProfit6).toBe("369580000");
      expect((row.dataGaps as Record<string, unknown>).unlabeledTransfers).toHaveLength(1);
      expect(row.correlationId).toBe(a.snapshot.correlationId); // first insert wins; never rewritten
    } finally {
      await handle.close();
    }
  });
});
