import { describe, expect, it } from "vitest";
import { usdc } from "@b5p/domain";
import type { LiquidityRewardAccrual, RebateAccrual } from "@b5p/domain";
import {
  AccrualError, LiquidityRewardLedger, RebateLedger, UnrealizedAccrualError,
  buildPreTradeEv, expectedRebate6, realizedIncome, realizedRebates, realizedRewards,
  type PreTradeEvInputs, type RealizedIncome,
} from "../src/accruals";

/**
 * Phase 3 (R10): rebate + liquidity-reward accrual ledgers.
 *
 * Core guarantees under test:
 *  - EXPECTED -> ACCRUED -> PENDING -> PAID lifecycle with DISPUTED branches;
 *    no shortcut to PAID, no double realization.
 *  - realizedRebates()/realizedRewards() count ONLY PAID entries.
 *  - Pre-trade EV cannot read unpaid accruals: the incentive slot only admits
 *    the branded RealizedIncome (compile-time, see @ts-expect-error below) and
 *    forged objects are refused at runtime.
 *  - The two programs stay in SEPARATE ledgers.
 */

const NOW = 1_785_500_000_000;

function rebateLedger(sunk?: RebateAccrual[]): RebateLedger {
  return new RebateLedger(sunk ? (e) => sunk.push(e) : null, () => 7);
}

function rewardLedger(sunk?: LiquidityRewardAccrual[]): LiquidityRewardLedger {
  return new LiquidityRewardLedger(sunk ? (e) => sunk.push(e) : null, () => 7);
}

function expectRebate(l: RebateLedger, amount = usdc("0.10")): string {
  return l.expect({
    correlationId: "corr-1", marketId: "m1", cycleId: "cyc-1",
    basisShares6: usdc("10"), basisNotional6: usdc("5.30"),
    amount6: amount, programVersion: "maker_rebates_test_v1", nowMs: NOW,
  });
}

describe("accrual lifecycle (EXPECTED -> ACCRUED -> PENDING -> PAID / DISPUTED)", () => {
  it("walks the legal path and realizes ONLY at PAID", () => {
    const l = rebateLedger();
    const id = expectRebate(l);
    expect(l.entry(id).state).toBe("EXPECTED");
    expect(l.entry(id).realized).toBe(false);
    expect(realizedRebates(l)).toBe(0n);

    l.markAccrued(id, usdc("0.12"), NOW + 1);
    expect(l.entry(id).state).toBe("ACCRUED");
    expect(realizedRebates(l)).toBe(0n); // accrued is NOT realized

    l.markPending(id, NOW + 2);
    expect(l.entry(id).state).toBe("PENDING");
    expect(realizedRebates(l)).toBe(0n); // pending is NOT realized

    l.recordPayment(id, usdc("0.11"), NOW + 3);
    const paid = l.entry(id);
    expect(paid.state).toBe("PAID");
    expect(paid.realized).toBe(true);
    expect(paid.paidAmount6).toBe(usdc("0.11"));
    expect(paid.paidAtMs).toBe(NOW + 3);
    expect(realizedRebates(l)).toBe(usdc("0.11")); // paid amount, not estimate
    expect(l.paidForCycle6("cyc-1")).toBe(usdc("0.11"));
  });

  it("refuses every shortcut to PAID and every double realization", () => {
    const l = rebateLedger();
    const id = expectRebate(l);
    // EXPECTED -> PAID: illegal (payment only from PENDING)
    expect(() => l.recordPayment(id, usdc("0.10"), NOW)).toThrow(/illegal accrual transition/);
    // EXPECTED -> PENDING: illegal (must accrue first)
    expect(() => l.markPending(id, NOW)).toThrow(/illegal accrual transition/);
    l.markAccrued(id, usdc("0.10"), NOW);
    expect(() => l.recordPayment(id, usdc("0.10"), NOW)).toThrow(/illegal accrual transition/);
    l.markPending(id, NOW);
    l.recordPayment(id, usdc("0.10"), NOW);
    // PAID is terminal: nothing leaves it, nothing pays twice
    expect(() => l.recordPayment(id, usdc("0.10"), NOW)).toThrow(/already PAID/);
    expect(() => l.dispute(id, NOW)).toThrow(/illegal accrual transition/);
    expect(realizedRebates(l)).toBe(usdc("0.10")); // realized exactly once
  });

  it("DISPUTED voids the amount from every non-disputed total; disputed entries cannot be paid", () => {
    const l = rebateLedger();
    const id = expectRebate(l);
    l.dispute(id, NOW);
    expect(l.entry(id).state).toBe("DISPUTED");
    const t = l.totals();
    expect(t.expected6).toBe(0n);
    expect(t.disputed6).toBe(usdc("0.10"));
    expect(() => l.recordPayment(id, usdc("0.10"), NOW)).toThrow(/illegal accrual transition/);
    expect(realizedRebates(l)).toBe(0n);
  });

  it("persists every mutation through the sink with the flattened realized/paid columns consistent", () => {
    const rows: RebateAccrual[] = [];
    const l = rebateLedger(rows);
    const id = expectRebate(l);
    l.markAccrued(id, usdc("0.10"), NOW);
    l.markPending(id, NOW);
    l.recordPayment(id, usdc("0.10"), NOW);
    expect(rows.length).toBe(4);
    for (const row of rows) {
      // schema invariant: realized === (state = 'PAID'), paid fields null until PAID
      expect(row.realized).toBe(row.state === "PAID");
      if (row.state !== "PAID") {
        expect(row.paidAmount6).toBeNull();
        expect(row.paidAtMs).toBeNull();
      } else {
        expect(row.paidAmount6).not.toBeNull();
      }
    }
  });
});

describe("separate programs, separate ledgers", () => {
  it("rebates and liquidity rewards never mix", () => {
    const rb = rebateLedger();
    const rw = rewardLedger();
    expectRebate(rb);
    const rwId = rw.expect({
      correlationId: "corr-1", marketId: "m1", epochKey: "2026-08-03",
      amount6: 0n, programVersion: "liquidity_rewards_test_v1", nowMs: NOW,
    });
    rw.accrueUptime(rwId, usdc("0.02"), 30_000, NOW + 1);
    expect(rb.size()).toBe(1);
    expect(rw.size()).toBe(1);
    expect(rb.totals().accrued6).toBe(0n); // reward accrual did not leak into rebates
    expect(rw.totals().accrued6).toBe(usdc("0.02"));
    expect(rb.all()[0]!.program).toBe("MAKER_REBATE");
    expect(rw.all()[0]!.program).toBe("LIQUIDITY_REWARD");
  });

  it("reward uptime revisions accumulate only while ACCRUED and never touch realized totals", () => {
    const rw = rewardLedger();
    const id = rw.expect({
      correlationId: "corr-1", marketId: "m1", epochKey: "2026-08-03",
      amount6: 0n, programVersion: "liquidity_rewards_test_v1", nowMs: NOW,
    });
    expect(() => rw.addQualifiedUptime(id, usdc("0.01"), 1000, NOW)).toThrow(AccrualError); // EXPECTED: must accrue first
    rw.accrueUptime(id, usdc("0.01"), 10_000, NOW);
    rw.addQualifiedUptime(id, usdc("0.02"), 20_000, NOW + 1);
    const e = rw.entry(id);
    expect(e.amount6).toBe(usdc("0.03"));
    expect(e.qualifyingUptimeMs).toBe(30_000);
    rw.markPending(id, NOW + 2);
    expect(() => rw.addQualifiedUptime(id, usdc("0.01"), 1000, NOW + 3)).toThrow(AccrualError);
    expect(realizedRewards(rw)).toBe(0n);
  });
});

describe("pre-trade EV cannot read unpaid accruals", () => {
  const baseInputs = {
    grossEdge6: usdc("0.30"),
    gas6: usdc("0.02"),
    fees6: 0n,
    oneLegRiskReserve6: usdc("0.10"),
  };

  it("realizedIncome() is zero while anything short of PAID exists", () => {
    const rb = rebateLedger();
    const rw = rewardLedger();
    const id = expectRebate(rb, usdc("5.00")); // large unpaid rebate
    rb.markAccrued(id, usdc("5.00"), NOW);
    rb.markPending(id, NOW);
    const income = realizedIncome(rb, rw);
    expect(income.paidRebates6).toBe(0n);
    expect(income.paidRewards6).toBe(0n);
    // even when the caller explicitly asks for incentive credit, unpaid = 0
    const ev = buildPreTradeEv({ ...baseInputs, incentives: income }, { creditRealizedIncentives: true });
    expect(ev.incentiveCredit6).toBe(0n);
    expect(ev.ev6).toBe(usdc("0.30") - usdc("0.02") - usdc("0.10"));
  });

  it("default options credit ZERO incentives even for genuinely PAID income (rebates_in_pretrade_ev=false)", () => {
    const rb = rebateLedger();
    const rw = rewardLedger();
    const id = expectRebate(rb);
    rb.markAccrued(id, usdc("0.10"), NOW);
    rb.markPending(id, NOW);
    rb.recordPayment(id, usdc("0.10"), NOW);
    const income = realizedIncome(rb, rw);
    expect(income.paidRebates6).toBe(usdc("0.10"));
    const evDefault = buildPreTradeEv({ ...baseInputs, incentives: income });
    expect(evDefault.incentiveCredit6).toBe(0n); // never in pre-trade EV by default
    const evOptIn = buildPreTradeEv({ ...baseInputs, incentives: income }, { creditRealizedIncentives: true });
    expect(evOptIn.incentiveCredit6).toBe(usdc("0.10")); // PAID-only, explicit opt-in
  });

  it("REFUSES forged incentive objects that bypass the type system", () => {
    const forged = { paidRebates6: usdc("99"), paidRewards6: 0n } as unknown as RealizedIncome;
    expect(() => buildPreTradeEv({ ...baseInputs, incentives: forged })).toThrow(UnrealizedAccrualError);
  });

  it("COMPILE-TIME: raw totals do not fit the incentive slot", () => {
    // @ts-expect-error — an ad-hoc object is not RealizedIncome (module-private brand missing);
    // the only constructor is realizedIncome(), which reads PAID entries exclusively.
    const bad: PreTradeEvInputs = { ...baseInputs, incentives: { paidRebates6: 1n, paidRewards6: 0n } };
    void bad;
    // and the ledgers' internal totals are equally unusable directly:
    const rb = rebateLedger();
    // @ts-expect-error — a bigint total is not RealizedIncome either
    const alsoBad: PreTradeEvInputs = { ...baseInputs, incentives: rb.totals().pending6 };
    void alsoBad;
    expect(true).toBe(true);
  });

  it("expectedRebate6 is bookkeeping only: notional x feeRate x programShare", () => {
    // 5.30 notional, 7% fee rate, 20% program share -> 0.0742
    expect(expectedRebate6(usdc("5.30"), 70_000n, 200_000n)).toBe(usdc("0.0742"));
  });
});
