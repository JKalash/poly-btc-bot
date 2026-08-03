import {
  assertValidAccrualTransition, isRealizedAccrual, paidAccrualStatus, unrealizedAccrualStatus,
  type LiquidityRewardAccrual, type Ppm, type RebateAccrual, type Shares6,
  type UnrealizedAccrualState, type Usdc6,
} from "@b5p/domain";
import { newId } from "@b5p/domain/ids";

/**
 * Rebate + liquidity-reward accrual tracking (refinement brief, "Maker
 * incentives"): the two programs have distinct eligibility formulas and are
 * tracked in SEPARATE ledgers over Agent I's domain types
 * (@b5p/domain inventory.ts: RebateAccrual / LiquidityRewardAccrual, whose
 * `realized: true` is structurally impossible outside state PAID). Amounts
 * move EXPECTED -> ACCRUED -> PENDING -> PAID (DISPUTED recoverable) and are
 * REALIZED only at PAID.
 *
 * Pre-trade EV guarantee (two layers):
 *  1. TYPE-LEVEL: `buildPreTradeEv`'s only incentive slot takes the branded
 *     `RealizedIncome`, whose sole constructor is `realizedIncome()` — which
 *     reads exclusively PAID entries. Raw ledger totals / ad-hoc objects do
 *     not compile into the slot.
 *  2. RUNTIME: a forged object without the module-private brand is refused
 *     with UnrealizedAccrualError, and with the default options the credit
 *     term is ZERO even for genuinely realized income
 *     (`rebates_in_pretrade_ev: false` / `rewards_in_pretrade_ev: false`).
 *
 * Hot-path safe: pure in-memory bookkeeping; rows are emitted to an injected
 * sink (buffered writer) and never awaited here.
 */

export class AccrualError extends Error {}
export class UnrealizedAccrualError extends AccrualError {}

export interface AccrualTotals {
  expected6: Usdc6;
  accrued6: Usdc6;
  pending6: Usdc6;
  paid6: Usdc6;
  disputed6: Usdc6;
}

type AnyAccrual = RebateAccrual | LiquidityRewardAccrual;

abstract class AccrualLedgerBase<E extends AnyAccrual> {
  protected entries = new Map<string, E>();

  protected constructor(
    private readonly sink: ((e: E) => void) | null,
    protected readonly configVersion: () => number,
  ) {}

  protected insert(e: E): string {
    if (e.amount6 < 0n) throw new AccrualError("accrual amounts are non-negative");
    this.entries.set(e.id, e);
    this.emit(e);
    return e.id;
  }

  /** EXPECTED -> ACCRUED (basis executed, e.g. maker fill); may revise the amount. */
  markAccrued(id: string, amount6: Usdc6, nowMs: number): void {
    this.advance(id, "ACCRUED", nowMs, amount6);
  }

  /** ACCRUED -> PENDING (cycle reconciled; awaiting the program's payment run). */
  markPending(id: string, nowMs: number): void {
    this.advance(id, "PENDING", nowMs);
  }

  /**
   * PENDING -> PAID: the ONLY way an accrual becomes realized. Must be driven
   * by an observed, reconciled payment — the paired-cycle simulator never
   * calls this on its own. Double payment of one entry is refused; PAID is
   * terminal (nothing can leave it, so nothing is realized twice).
   */
  recordPayment(id: string, paid6: Usdc6, nowMs: number): void {
    const e = this.get(id);
    if (e.state === "PAID") throw new AccrualError(`accrual ${id} already PAID; no double realization`);
    assertValidAccrualTransition(e.state, "PAID"); // only PENDING may pay out
    if (paid6 < 0n) throw new AccrualError("accrual amounts are non-negative");
    const next = { ...e, ...paidAccrualStatus(paid6, nowMs), amount6: paid6, updatedAtMs: nowMs } as E;
    this.entries.set(id, next);
    this.emit(next);
  }

  /** Any pre-PAID state -> DISPUTED (also voids expectations that never executed). */
  dispute(id: string, nowMs: number): void {
    this.advance(id, "DISPUTED", nowMs);
  }

  entry(id: string): Readonly<E> {
    return this.get(id);
  }

  all(): ReadonlyArray<Readonly<E>> {
    return [...this.entries.values()];
  }

  totals(): AccrualTotals {
    const t: AccrualTotals = { expected6: 0n, accrued6: 0n, pending6: 0n, paid6: 0n, disputed6: 0n };
    for (const e of this.entries.values()) {
      if (e.state === "EXPECTED") t.expected6 += e.amount6;
      else if (e.state === "ACCRUED") t.accrued6 += e.amount6;
      else if (e.state === "PENDING") t.pending6 += e.amount6;
      else if (e.state === "PAID") t.paid6 += e.paidAmount6;
      else t.disputed6 += e.amount6;
    }
    return t;
  }

  /** Realized total: PAID entries ONLY — verified per entry via the domain guard. */
  realizedTotal6(): Usdc6 {
    let total = 0n;
    for (const e of this.entries.values()) {
      if (!isRealizedAccrual(e)) continue; // unpaid accruals are NEVER realized
      total += e.paidAmount6;
    }
    return total;
  }

  size(): number {
    return this.entries.size;
  }

  protected advance(id: string, to: UnrealizedAccrualState, nowMs: number, amount6?: Usdc6, patch?: Partial<E>): void {
    const e = this.get(id);
    assertValidAccrualTransition(e.state, to);
    if (amount6 !== undefined && amount6 < 0n) throw new AccrualError("accrual amounts are non-negative");
    const next = {
      ...e,
      ...unrealizedAccrualStatus(to),
      ...(amount6 !== undefined ? { amount6 } : {}),
      ...(patch ?? {}),
      updatedAtMs: nowMs,
    } as E;
    this.entries.set(id, next);
    this.emit(next);
  }

  protected get(id: string): E {
    const e = this.entries.get(id);
    if (!e) throw new AccrualError(`unknown accrual entry ${id}`);
    return e;
  }

  protected emit(e: E): void {
    try {
      this.sink?.({ ...e });
    } catch {
      /* the persistence sink must never affect ledger state */
    }
  }
}

/** Maker-rebate ledger (funded from taker fees, paid on executed maker liquidity). */
export class RebateLedger extends AccrualLedgerBase<RebateAccrual> {
  constructor(sink: ((e: RebateAccrual) => void) | null, configVersion: () => number) {
    super(sink, configVersion);
  }

  expect(args: {
    correlationId: string;
    marketId: string;
    cycleId?: string | null;
    fillId?: string | null;
    basisShares6?: Shares6 | null;
    basisNotional6?: Usdc6 | null;
    amount6: Usdc6;
    programVersion: string;
    nowMs: number;
  }): string {
    return this.insert({
      id: newId(),
      correlationId: args.correlationId,
      program: "MAKER_REBATE",
      programVersion: args.programVersion,
      marketId: args.marketId,
      cycleId: args.cycleId ?? null,
      fillId: args.fillId ?? null,
      basisShares6: args.basisShares6 ?? null,
      basisNotional6: args.basisNotional6 ?? null,
      amount6: args.amount6,
      createdAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
      configVersion: this.configVersion(),
      ...unrealizedAccrualStatus("EXPECTED"),
    });
  }

  entriesForCycle(cycleId: string): ReadonlyArray<Readonly<RebateAccrual>> {
    return this.all().filter((e) => e.cycleId === cycleId);
  }

  /** PAID-only total attributable to one cycle (reconciled-cycle P&L view). */
  paidForCycle6(cycleId: string): Usdc6 {
    let total = 0n;
    for (const e of this.all()) {
      if (e.cycleId === cycleId && isRealizedAccrual(e)) total += e.paidAmount6;
    }
    return total;
  }
}

/** Liquidity-reward ledger (competitive resting quotes near midpoint; epoch-scored). Separate program, separate rules. */
export class LiquidityRewardLedger extends AccrualLedgerBase<LiquidityRewardAccrual> {
  constructor(sink: ((e: LiquidityRewardAccrual) => void) | null, configVersion: () => number) {
    super(sink, configVersion);
  }

  expect(args: {
    correlationId: string;
    marketId?: string | null;
    epochKey: string;
    amount6: Usdc6;
    programVersion: string;
    scoreDetail?: Record<string, unknown> | null;
    nowMs: number;
  }): string {
    return this.insert({
      id: newId(),
      correlationId: args.correlationId,
      program: "LIQUIDITY_REWARD",
      programVersion: args.programVersion,
      marketId: args.marketId ?? null,
      epochKey: args.epochKey,
      qualifyingUptimeMs: null,
      scoreDetail: args.scoreDetail ?? null,
      amount6: args.amount6,
      createdAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
      configVersion: this.configVersion(),
      ...unrealizedAccrualStatus("EXPECTED"),
    });
  }

  /** EXPECTED -> ACCRUED with the qualifying two-sided uptime that earned it. */
  accrueUptime(id: string, amount6: Usdc6, qualifyingUptimeMs: number, nowMs: number): void {
    this.advance(id, "ACCRUED", nowMs, amount6, { qualifyingUptimeMs });
  }

  /** Accumulate additional qualifying uptime onto an already-ACCRUED entry (state unchanged). */
  addQualifiedUptime(id: string, additionalAmount6: Usdc6, additionalUptimeMs: number, nowMs: number): void {
    const e = this.get(id);
    if (e.state !== "ACCRUED") throw new AccrualError(`addQualifiedUptime requires ACCRUED; entry ${id} is ${e.state}`);
    if (additionalAmount6 < 0n) throw new AccrualError("accrual amounts are non-negative");
    const next: LiquidityRewardAccrual = {
      ...e,
      amount6: e.amount6 + additionalAmount6,
      qualifyingUptimeMs: (e.qualifyingUptimeMs ?? 0) + additionalUptimeMs,
      updatedAtMs: nowMs,
    };
    this.entries.set(id, next);
    this.emit(next);
  }
}

/** Rebate EXPECTED-bookkeeping estimate: notional × feeRate × programShare. Never EV. */
export function expectedRebate6(makerNotional6: Usdc6, feeRatePpm: Ppm, rebateSharePpm: Ppm): Usdc6 {
  const fee6 = (makerNotional6 * feeRatePpm) / 1_000_000n;
  return (fee6 * rebateSharePpm) / 1_000_000n;
}

// ---------------------------------------------------------------------------
// Realized-only EV inputs
// ---------------------------------------------------------------------------

/** Module-private brand: `RealizedIncome` cannot be constructed outside this file. */
const REALIZED_BRAND = Symbol("realized-paid-only");

export interface RealizedIncome {
  readonly paidRebates6: Usdc6;
  readonly paidRewards6: Usdc6;
  /** Present only on values built by `realizedIncome()`. */
  readonly [REALIZED_BRAND]: true;
}

/** PAID-only rebate total for a ledger. */
export function realizedRebates(ledger: RebateLedger): Usdc6 {
  return ledger.realizedTotal6();
}

/** PAID-only liquidity-reward total for a ledger. */
export function realizedRewards(ledger: LiquidityRewardLedger): Usdc6 {
  return ledger.realizedTotal6();
}

/**
 * The ONLY constructor of `RealizedIncome`. Reads exclusively PAID entries
 * (each verified via the domain's `isRealizedAccrual` guard) — there is no
 * parameter that could widen this to unpaid amounts.
 */
export function realizedIncome(rebates: RebateLedger, rewards: LiquidityRewardLedger): RealizedIncome {
  return {
    paidRebates6: rebates.realizedTotal6(),
    paidRewards6: rewards.realizedTotal6(),
    [REALIZED_BRAND]: true,
  };
}

export interface PreTradeEvInputs {
  /** Gross pair edge for the cycle (µUSDC): e.g. (Σ quotes − 1) × pairSize. */
  grossEdge6: Usdc6;
  /** All gas expected across split/merge/redeem for the cycle (µUSDC). */
  gas6: Usdc6;
  /** Expected taker/operational fees (µUSDC); pure maker legs are 0. */
  fees6: Usdc6;
  /** Reserve charged for the one-leg failure path (µUSDC, ≥ 0). */
  oneLegRiskReserve6: Usdc6;
  /**
   * Incentive credit slot. Type-level guarantee: ONLY the branded
   * `RealizedIncome` (PAID-only, built by `realizedIncome()`) or null fits
   * here — raw ledger totals or ad-hoc objects will not compile.
   */
  incentives: RealizedIncome | null;
}

export interface PreTradeEv {
  ev6: Usdc6;
  incentiveCredit6: Usdc6;
}

/**
 * Pre-trade EV for a paired cycle. Refuses (at runtime) any incentive object
 * that was not built by `realizedIncome()`, so unpaid accruals cannot leak in
 * even through type assertions. With `creditRealizedIncentives` false (the
 * default, matching `rebates_in_pretrade_ev: false` / `rewards_in_pretrade_ev:
 * false`) the incentive term is ZERO regardless of input.
 */
export function buildPreTradeEv(inputs: PreTradeEvInputs, opts: { creditRealizedIncentives?: boolean } = {}): PreTradeEv {
  if (inputs.incentives !== null && (inputs.incentives as unknown as Record<symbol, unknown>)[REALIZED_BRAND] !== true) {
    throw new UnrealizedAccrualError(
      "pre-trade EV rejected: incentive input is not a realized (PAID-only) total built by realizedIncome()",
    );
  }
  const credit = opts.creditRealizedIncentives === true && inputs.incentives !== null
    ? inputs.incentives.paidRebates6 + inputs.incentives.paidRewards6
    : 0n;
  return {
    ev6: inputs.grossEdge6 - inputs.gas6 - inputs.fees6 - inputs.oneLegRiskReserve6 + credit,
    incentiveCredit6: credit,
  };
}
