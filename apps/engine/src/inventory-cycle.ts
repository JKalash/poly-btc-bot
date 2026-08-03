import type { AppConfig } from "@b5p/config";
import {
  assertValidCtfTransition, assertValidCycleTransition, assertValidLegTransition, isRiskFree,
  mulDiv, takerFeeUsdc, usdc,
  type CtfOperation, type ExecutionMode, type HedgeAction, type HedgeActionKind, type OutcomeSide,
  type PairedCycleKind, type PairedCycleState, type PairedLeg, type PairedQuoteCycle,
  type Ppm, type Prob6, type Shares6, type Usdc6,
} from "@b5p/domain";
import { newId } from "@b5p/domain/ids";
import {
  DEFAULT_INVENTORY_RISK_LIMITS, deriveCycleFacts, derivePendingCtfValue6, evaluateInventoryRisk,
  type InventoryRejection, type InventoryRiskContext, type InventoryRiskLimits,
} from "@b5p/risk";
import type { BookState } from "@b5p/strategy";
import {
  buildPreTradeEv, expectedRebate6, realizedIncome, type LiquidityRewardLedger, type RebateLedger,
} from "./accruals";
import type { InventorySink } from "./inventory-persistence";
import { SeededRng } from "./paper-variants";
import { logger } from "./log";

/**
 * R10 paired-cycle inventory/CTF market-making SIMULATION — PAPER/SHADOW ONLY.
 *
 * Drives split-sell and buy-both-and-merge cycles through Agent I's state
 * machines (@b5p/domain inventory.ts) against live book data (paper) or
 * observed-only (shadow). Models:
 *  - CTF split/merge/redeem with gas, latency and split-failure probability;
 *  - post-only quoting of both legs (maker, zero fee);
 *  - one-leg-filled directional risk with an unhedged-duration budget,
 *    opportunity decay on the survivor, and the brief's hedge-or-cancel rule;
 *  - merge/settle wind-down and full reconciliation with exact bigint P&L
 *    (split/merge/redeem gas AND taker fees always accounted in cycle P&L);
 *  - rebate/liquidity-reward accrual hooks (SEPARATE ledgers; amounts are
 *    realized only at PAID and the pre-trade EV builder cannot read unpaid
 *    accruals — see ./accruals).
 *
 * Risk gating (Agent K, @b5p/risk evaluateInventoryRisk): evaluated before
 * every exposure-creating mutation —
 *  - cycle activation (split submission / collateral commitment, still PLANNED:
 *    a rejection abandons the cycle before anything exists),
 *  - quote placement (before QUOTING_BOTH),
 *  - merge submission (pending-CTF-value cap; a rejection DEFERS the merge and
 *    retries next step rather than stranding inventory),
 *  - the hedge decision (codes are recorded; exposure-inherent codes cannot
 *    block resolving that same exposure — they force the conservative CANCEL
 *    branch instead of a new taker order).
 * All rejection codes are surfaced through `onRiskRejection` (the engine
 * persists them to audit_events) and kept in the cycle history.
 *
 * Determinism: all randomness (split failure, quote-fill hazard) comes from a
 * SeededRng keyed by the cycle correlationId (paper-variants.ts pattern);
 * NO Math.random anywhere. Same seeds + same books + same step cadence =>
 * identical cycles.
 *
 * There is NO live path: the constructor hard-refuses any mode but
 * paper/shadow, and the only "live adapter" surface in this phase is the
 * DisabledLiveMarketMakingAdapter below, which refuses every call — mirroring
 * DisabledLiveAdapter in @b5p/polymarket.
 */

// ---------------------------------------------------------------------------
// Disabled live adapter stub (hard refusal, DisabledLiveAdapter pattern)
// ---------------------------------------------------------------------------

export const LIVE_MM_REFUSAL =
  "LIVE MARKET-MAKING IS DISABLED: R10 paired cycles are PAPER/SHADOW-ONLY in this phase. " +
  "No live MM adapter or signing path exists. See 2026-07-31-001-initial-refinement.md (R10).";

export interface LiveMmRefusal {
  accepted: false;
  reason: string;
}

/** Every method hard-refuses. There is deliberately no other implementation. */
export class DisabledLiveMarketMakingAdapter {
  readonly kind = "live_mm_disabled" as const;
  async submitQuote(): Promise<LiveMmRefusal> {
    return { accepted: false, reason: LIVE_MM_REFUSAL };
  }
  async cancelQuote(): Promise<LiveMmRefusal> {
    return { accepted: false, reason: LIVE_MM_REFUSAL };
  }
  async splitCollateral(): Promise<LiveMmRefusal> {
    return { accepted: false, reason: LIVE_MM_REFUSAL };
  }
  async mergePairs(): Promise<LiveMmRefusal> {
    return { accepted: false, reason: LIVE_MM_REFUSAL };
  }
  async redeemPositions(): Promise<LiveMmRefusal> {
    return { accepted: false, reason: LIVE_MM_REFUSAL };
  }
}

// ---------------------------------------------------------------------------
// Config (cfg.inventory_research?.* with hardcoded defaults; see
// scratchpad/config-requests-J.md for the requested schema keys)
// ---------------------------------------------------------------------------

export interface ResolvedInventoryResearchConfig {
  /** Master switch — OFF by default; the engine never steps the simulator when false. */
  enabled: boolean;
  /** Structurally false: no config value can enable live paired cycles. */
  liveAllowed: false;
  maxOneLegSeconds: number;
  /** ppm of committed collateral allowed as one-leg loss budget. */
  maxUnhedgedRiskFractionPpm: bigint;
  /** Minimum pre-trade EV per paired share (µUSDC/share) after gas + reserve. */
  minCycleEdge6: Prob6;
  pairSizeShares6: Shares6;
  splitGasUsdc6: Usdc6;
  mergeGasUsdc6: Usdc6;
  redeemGasUsdc6: Usdc6;
  splitLatencyMs: number;
  mergeLatencyMs: number;
  splitFailureFraction: number;
  /** Poisson-style per-second fill hazard for a resting post-only quote. */
  quoteFillHazardPerSec: number;
  /** Adverse drift against the survivor while unhedged, bps of price per second. */
  opportunityDecayBpsPerSec: number;
  hedgePolicy: "auto" | "hedge" | "cancel";
  maxCyclesPerMarket: number;
  maxOpenCycles: number;
  minSecondsRemaining: number;
  /** Structurally false: unpaid accruals can never enter pre-trade EV. */
  rebatesInPretradeEv: false;
  rewardsInPretradeEv: false;
  /** Liquidity-reward EXPECTED bookkeeping rate while quoting two-sided. */
  rewardPerSecondUsdc6: Usdc6;
  /** Keys the resolver refused to honor (safety clamps). */
  clamped: string[];
}

export const DEFAULT_INVENTORY_RESEARCH: Omit<ResolvedInventoryResearchConfig, "clamped"> = {
  enabled: false, // OFF by default — the research loop must be opted into
  liveAllowed: false,
  maxOneLegSeconds: 2, // brief: maximum_one_leg_seconds: 2
  maxUnhedgedRiskFractionPpm: 10_000n, // brief: maximum_unhedged_risk_fraction 0.01
  minCycleEdge6: usdc("0.005"),
  pairSizeShares6: usdc("10"), // 10 paired shares (µshares == µUSDC at 1.00)
  splitGasUsdc6: usdc("0.02"),
  mergeGasUsdc6: usdc("0.02"),
  redeemGasUsdc6: usdc("0.02"),
  splitLatencyMs: 2000,
  mergeLatencyMs: 2000,
  splitFailureFraction: 0.02,
  quoteFillHazardPerSec: 0.02,
  opportunityDecayBpsPerSec: 5,
  hedgePolicy: "auto",
  maxCyclesPerMarket: 1,
  maxOpenCycles: 2,
  minSecondsRemaining: 60,
  rebatesInPretradeEv: false,
  rewardsInPretradeEv: false,
  rewardPerSecondUsdc6: usdc("0.0001"),
};

interface RawInventoryResearchConfig {
  enabled?: boolean;
  live_allowed?: boolean;
  max_one_leg_seconds?: number;
  max_unhedged_risk_fraction?: string;
  min_cycle_edge?: string;
  pair_size_shares?: string;
  split_gas_usdc?: string;
  merge_gas_usdc?: string;
  redeem_gas_usdc?: string;
  split_latency_ms?: number;
  merge_latency_ms?: number;
  split_failure_fraction?: string;
  quote_fill_hazard_per_sec?: string;
  opportunity_decay_bps_per_sec?: number;
  hedge_policy?: string;
  max_cycles_per_market?: number;
  max_open_cycles?: number;
  min_seconds_remaining?: number;
  rebates_in_pretrade_ev?: boolean;
  rewards_in_pretrade_ev?: boolean;
  reward_per_second_usdc?: string;
}

/** Merge config-schema keys (when present) over hardcoded defaults, clamping
 * every unsafe request: live_allowed and *_in_pretrade_ev can NEVER become true. */
export function resolveInventoryResearchConfig(cfg: AppConfig): ResolvedInventoryResearchConfig {
  const raw = (cfg as { inventory_research?: RawInventoryResearchConfig }).inventory_research;
  const d = DEFAULT_INVENTORY_RESEARCH;
  const clamped: string[] = [];
  if (raw?.live_allowed === true) clamped.push("live_allowed");
  if (raw?.rebates_in_pretrade_ev === true) clamped.push("rebates_in_pretrade_ev");
  if (raw?.rewards_in_pretrade_ev === true) clamped.push("rewards_in_pretrade_ev");
  const frac = (s: string | undefined, fallback: number): number => {
    if (s === undefined) return fallback;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
  };
  const money = (s: string | undefined, fallback: Usdc6): Usdc6 => {
    if (s === undefined) return fallback;
    try {
      const v = usdc(s);
      return v >= 0n ? v : fallback;
    } catch {
      return fallback;
    }
  };
  const posInt = (n: number | undefined, fallback: number): number =>
    n !== undefined && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  return {
    enabled: raw?.enabled === true,
    liveAllowed: false,
    maxOneLegSeconds: posInt(raw?.max_one_leg_seconds, d.maxOneLegSeconds),
    maxUnhedgedRiskFractionPpm: BigInt(Math.round(frac(raw?.max_unhedged_risk_fraction, Number(d.maxUnhedgedRiskFractionPpm) / 1e6) * 1e6)),
    minCycleEdge6: money(raw?.min_cycle_edge, d.minCycleEdge6),
    pairSizeShares6: money(raw?.pair_size_shares, d.pairSizeShares6),
    splitGasUsdc6: money(raw?.split_gas_usdc, d.splitGasUsdc6),
    mergeGasUsdc6: money(raw?.merge_gas_usdc, d.mergeGasUsdc6),
    redeemGasUsdc6: money(raw?.redeem_gas_usdc, d.redeemGasUsdc6),
    splitLatencyMs: posInt(raw?.split_latency_ms, d.splitLatencyMs),
    mergeLatencyMs: posInt(raw?.merge_latency_ms, d.mergeLatencyMs),
    splitFailureFraction: frac(raw?.split_failure_fraction, d.splitFailureFraction),
    quoteFillHazardPerSec: raw?.quote_fill_hazard_per_sec !== undefined
      ? Math.max(0, Number(raw.quote_fill_hazard_per_sec) || 0)
      : d.quoteFillHazardPerSec,
    opportunityDecayBpsPerSec: posInt(raw?.opportunity_decay_bps_per_sec, d.opportunityDecayBpsPerSec),
    hedgePolicy: raw?.hedge_policy === "hedge" || raw?.hedge_policy === "cancel" ? raw.hedge_policy : d.hedgePolicy,
    maxCyclesPerMarket: posInt(raw?.max_cycles_per_market, d.maxCyclesPerMarket),
    maxOpenCycles: posInt(raw?.max_open_cycles, d.maxOpenCycles),
    minSecondsRemaining: posInt(raw?.min_seconds_remaining, d.minSecondsRemaining),
    rebatesInPretradeEv: false,
    rewardsInPretradeEv: false,
    rewardPerSecondUsdc6: money(raw?.reward_per_second_usdc, d.rewardPerSecondUsdc6),
    clamped,
  };
}

// ---------------------------------------------------------------------------
// Hedge-or-cancel decision (pure, per the brief's one-leg rules)
// ---------------------------------------------------------------------------

export interface HedgeOrCancelInputs {
  kind: PairedCycleKind;
  policy: "auto" | "hedge" | "cancel";
  exposureShares6: Shares6;
  /** The sibling leg's planned quote price (what the plan assumed). */
  siblingQuote6: Prob6;
  /** Executable price NOW on the sibling instrument (split-sell: best bid on
   * the unsold token; buy-both: best ask on the missing token), already
   * decay-adjusted. Null = no executable liquidity. */
  executableNow6: Prob6 | null;
  takerFeeRatePpm: Ppm;
  /** One-leg loss budget (µUSDC): maxUnhedgedRiskFraction × committed collateral. */
  lossBudget6: Usdc6;
}

export interface HedgeOrCancelDecision {
  action: "HEDGE" | "CANCEL_AND_SETTLE";
  hedgeKind: HedgeActionKind;
  estimatedCost6: Usdc6;
  reason: string;
}

export function decideHedgeOrCancel(i: HedgeOrCancelInputs): HedgeOrCancelDecision {
  const hedgeKind: HedgeActionKind = i.kind === "SPLIT_SELL" ? "DUMP_SURVIVOR_TAKER" : "COMPLETE_PAIR_TAKER";
  if (i.executableNow6 === null || i.executableNow6 <= 0n) {
    return {
      action: "CANCEL_AND_SETTLE", hedgeKind: "CANCEL_REMAINING_QUOTE", estimatedCost6: 0n,
      reason: "no executable liquidity on the sibling side; cancel quote and hold to settlement",
    };
  }
  // Cost vs plan: split-sell planned to RECEIVE siblingQuote and gets the
  // executable bid minus a taker fee; buy-both planned to PAY siblingQuote and
  // pays the executable ask plus a taker fee.
  const slip6 = i.kind === "SPLIT_SELL"
    ? (i.siblingQuote6 > i.executableNow6 ? i.siblingQuote6 - i.executableNow6 : 0n)
    : (i.executableNow6 > i.siblingQuote6 ? i.executableNow6 - i.siblingQuote6 : 0n);
  const fee6 = takerFeeUsdc(i.exposureShares6, i.executableNow6, i.takerFeeRatePpm);
  const estimatedCost6 = mulDiv(i.exposureShares6, slip6, 1_000_000n, "ceil") + fee6;
  if (i.policy === "cancel") {
    return { action: "CANCEL_AND_SETTLE", hedgeKind: "CANCEL_REMAINING_QUOTE", estimatedCost6, reason: "hedge_policy=cancel" };
  }
  if (i.policy === "hedge") {
    return { action: "HEDGE", hedgeKind, estimatedCost6, reason: "hedge_policy=hedge" };
  }
  return estimatedCost6 <= i.lossBudget6
    ? { action: "HEDGE", hedgeKind, estimatedCost6, reason: `auto: hedge cost ${estimatedCost6} within one-leg budget ${i.lossBudget6}` }
    : {
        action: "CANCEL_AND_SETTLE", hedgeKind: "CANCEL_REMAINING_QUOTE", estimatedCost6,
        reason: `auto: hedge cost ${estimatedCost6} exceeds one-leg budget ${i.lossBudget6}; cancel and hold to settlement`,
      };
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export interface CycleMarketCtx {
  marketId: string;
  conditionId: string;
  slug: string;
  upTokenId: string;
  downTokenId: string;
  endEpoch: number;
  /** Absolute ms after which quoting must stop (market cancel cutoff). */
  cutoffMs: number;
  tickSize6: Prob6;
  feeRatePpm: Ppm;
  /** Rebate program share of taker fees (EXPECTED bookkeeping only). */
  rebateSharePpm: Ppm;
  maxBookAgeMs: number;
}

export interface CycleRiskRejection {
  cycleId: string;
  marketId: string;
  phase: "activate" | "quote" | "hedge" | "merge";
  codes: string[];
  reasons: InventoryRejection[];
  tsMs: number;
}

interface SimLot {
  id: string;
  tokenId: string;
  outcomeSide: OutcomeSide;
  source: "SPLIT" | "FILL" | "HEDGE";
  sourceRef: string | null;
  acquiredShares6: Shares6;
  remainingShares6: Shares6;
  costBasis6: Usdc6;
  acquiredAtMs: number;
  consumedAtMs: number | null;
}

interface SimCycle {
  row: PairedQuoteCycle;
  legs: [PairedLeg, PairedLeg]; // [0]=UP, [1]=DOWN
  ctx: CycleMarketCtx;
  rng: SeededRng;
  history: Array<{ state: PairedCycleState; tsMs: number; reason: string }>;
  splitOp: CtfOperation | null;
  mergeOp: CtfOperation | null;
  lots: SimLot[];
  outlay6: Usdc6;
  proceeds6: Usdc6;
  gas6: Usdc6;
  fees6: Usdc6;
  /** ev-per-cost of the plan (ppm), realized-incentive-free by construction. */
  planEvPerCostPpm: Ppm;
  rebateEntryByLeg: [string | null, string | null];
  bothQuotedSinceMs: number | null;
  quotingUptimeMs: number;
  pendingOpCompleteAtMs: number | null;
  lastStepMs: number;
  /** Cycle wants a merge submitted the next time the pending-CTF cap allows. */
  wantsMerge: boolean;
  mergeReason: string;
  /** Leg index carrying open exposure on the cancel-and-settle path. */
  exposedLegIndex: number | null;
  heldTokenSide: OutcomeSide | null;
  hadMakerFill: boolean;
  done: boolean;
}

export interface CycleView {
  row: Readonly<PairedQuoteCycle>;
  legs: ReadonlyArray<Readonly<PairedLeg>>;
  history: ReadonlyArray<{ state: PairedCycleState; tsMs: number; reason: string }>;
  riskFree: boolean;
}

export class PairedCycleSimulator {
  readonly execMode: ExecutionMode;
  private cyclesById = new Map<string, SimCycle>();
  /** Per-market+epoch liquidity-reward entry ids (unique program/epoch/market). */
  private rewardEntryByEpoch = new Map<string, string>();
  /** Cumulative simulated operational loss (failed CTF ops' gas etc.). */
  private operationalLoss6: Usdc6 = 0n;

  constructor(private readonly args: {
    mode: "paper" | "shadow";
    sink: InventorySink;
    books: (tokenId: string) => BookState | null;
    cfg: () => ResolvedInventoryResearchConfig;
    configVersion: () => number;
    rebates: RebateLedger;
    rewards: LiquidityRewardLedger;
    /** Reconciled bankroll (denominates Agent K's fraction caps). */
    bankroll6?: () => Usdc6;
    /** Agent K risk limits; defaults to DEFAULT_INVENTORY_RISK_LIMITS. */
    riskLimits?: () => InventoryRiskLimits;
    /** Rejection codes surfaced here are persisted by the engine (audit_events). */
    onRiskRejection?: (rej: CycleRiskRejection) => void;
    idFactory?: () => string;
  }) {
    // MODE GUARD: the simulator is unreachable in live mode by construction.
    if (args.mode !== "paper" && args.mode !== "shadow") {
      throw new Error(
        `PairedCycleSimulator refuses mode "${String(args.mode)}": R10 paired cycles are PAPER/SHADOW-ONLY ` +
        "(no live market-making adapter exists in this phase)",
      );
    }
    this.execMode = args.mode === "paper" ? "PAPER" : "SHADOW";
  }

  private id(): string {
    return this.args.idFactory ? this.args.idFactory() : newId();
  }

  // ------------------------------------------------------------ planning ----

  /**
   * Evaluate the pair economics for the active market and plan a cycle when
   * the pre-trade EV (gross edge − gas − one-leg reserve, ZERO incentive
   * credit) clears the configured minimum. Returns the cycle id, or null.
   */
  consider(ctx: CycleMarketCtx, nowMs: number, correlationId?: string): string | null {
    const cfg = this.args.cfg();
    if (!cfg.enabled) return null;
    let openTotal = 0;
    let marketCount = 0;
    for (const c of this.cyclesById.values()) {
      if (!c.done) openTotal++;
      if (c.row.marketId === ctx.marketId) marketCount++;
    }
    if (openTotal >= cfg.maxOpenCycles) return null;
    if (marketCount >= cfg.maxCyclesPerMarket) return null;
    if (nowMs >= ctx.cutoffMs) return null;
    if (ctx.endEpoch * 1000 - nowMs < cfg.minSecondsRemaining * 1000) return null;

    const upBook = this.args.books(ctx.upTokenId);
    const downBook = this.args.books(ctx.downTokenId);
    if (!upBook || !downBook) return null;
    const upAge = upBook.ageMs(nowMs);
    const downAge = downBook.ageMs(nowMs);
    if (upAge === null || downAge === null || upAge > ctx.maxBookAgeMs || downAge > ctx.maxBookAgeMs) return null;
    const upBid = upBook.bestBid();
    const upAsk = upBook.bestAsk();
    const downBid = downBook.bestBid();
    const downAsk = downBook.bestAsk();
    if (upBid === null || upAsk === null || downBid === null || downAsk === null) return null;

    // Join the touch on both sides (post-only: sell at ask / buy at bid).
    const sellEdge6 = upAsk + downAsk - 1_000_000n;
    const buyEdge6 = 1_000_000n - (upBid + downBid);
    let kind: PairedCycleKind;
    let upPrice6: Prob6;
    let downPrice6: Prob6;
    let edge6: Prob6;
    if (sellEdge6 >= buyEdge6 && sellEdge6 > 0n) {
      kind = "SPLIT_SELL";
      upPrice6 = upAsk;
      downPrice6 = downAsk;
      edge6 = sellEdge6;
    } else if (buyEdge6 > 0n) {
      kind = "BUY_BOTH_MERGE";
      upPrice6 = upBid;
      downPrice6 = downBid;
      edge6 = buyEdge6;
    } else {
      return null;
    }

    const pairSize6 = cfg.pairSizeShares6;
    const collateral6: Usdc6 = kind === "SPLIT_SELL"
      ? pairSize6 // 1.00 per paired share
      : mulDiv(pairSize6, upPrice6 + downPrice6, 1_000_000n, "ceil");
    const gas6 = kind === "SPLIT_SELL" ? cfg.splitGasUsdc6 : cfg.mergeGasUsdc6;
    const worstGas6 = kind === "SPLIT_SELL" ? cfg.splitGasUsdc6 + cfg.mergeGasUsdc6 : cfg.mergeGasUsdc6;
    const grossEdge6 = mulDiv(pairSize6, edge6, 1_000_000n, "floor");
    const oneLegRiskReserve6 = mulDiv(collateral6, cfg.maxUnhedgedRiskFractionPpm, 1_000_000n, "ceil");
    // Pre-trade EV: the incentive slot only accepts realized (PAID-only)
    // totals, and under rebates/rewards_in_pretrade_ev=false the credit is 0.
    const ev = buildPreTradeEv({
      grossEdge6,
      gas6,
      fees6: 0n, // both legs post-only maker
      oneLegRiskReserve6,
      incentives: realizedIncome(this.args.rebates, this.args.rewards),
    }, { creditRealizedIncentives: cfg.rebatesInPretradeEv && cfg.rewardsInPretradeEv });
    const minEv6 = mulDiv(pairSize6, cfg.minCycleEdge6, 1_000_000n, "ceil");
    if (ev.ev6 < minEv6) return null;

    const corr = correlationId ?? newId();
    const nowVersion = this.args.configVersion();
    const cycleId = this.id();
    const row: PairedQuoteCycle = {
      id: cycleId,
      correlationId: corr,
      marketId: ctx.marketId,
      mode: this.execMode,
      kind,
      state: "PLANNED",
      targetPairPrice6: upPrice6 + downPrice6,
      collateralCommitted6: collateral6,
      worstCaseLoss6: collateral6 + worstGas6,
      splitOperationId: null,
      mergeOperationId: null,
      oneLegFilledAtMs: null,
      hedgeCompletedAtMs: null,
      unhedgedDurationMs: null,
      spreadCaptured6: null,
      fees6: null,
      realizedPnl6: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      reconciledAtMs: null,
      configVersion: nowVersion,
    };
    const mkLeg = (side: OutcomeSide, tokenId: string, price6: Prob6): PairedLeg => ({
      id: this.id(),
      correlationId: corr,
      cycleId,
      marketId: ctx.marketId,
      tokenId,
      outcomeSide: side,
      orderSide: kind === "SPLIT_SELL" ? "SELL" : "BUY",
      state: "PLANNED",
      price6,
      size6: pairSize6,
      filledShares6: 0n,
      avgFillPrice6: null,
      feeUsdc6: null,
      attemptId: null, // simulation: nothing is ever sent
      quotedAtMs: null,
      firstFillAtMs: null,
      unhedgedStartedAtMs: null,
      hedgedAtMs: null,
      closedAtMs: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      configVersion: nowVersion,
    });
    const c: SimCycle = {
      row,
      legs: [mkLeg("UP", ctx.upTokenId, upPrice6), mkLeg("DOWN", ctx.downTokenId, downPrice6)],
      ctx,
      rng: new SeededRng(corr),
      history: [{ state: "PLANNED", tsMs: nowMs, reason: `planned ${kind} edge=${edge6} ev=${ev.ev6}` }],
      splitOp: null,
      mergeOp: null,
      lots: [],
      outlay6: 0n,
      proceeds6: 0n,
      gas6: 0n,
      fees6: 0n,
      planEvPerCostPpm: collateral6 > 0n ? mulDiv(ev.ev6, 1_000_000n, collateral6, "floor") : 0n,
      rebateEntryByLeg: [null, null],
      bothQuotedSinceMs: null,
      quotingUptimeMs: 0,
      pendingOpCompleteAtMs: null,
      lastStepMs: nowMs,
      wantsMerge: false,
      mergeReason: "",
      exposedLegIndex: null,
      heldTokenSide: null,
      hadMakerFill: false,
      done: false,
    };
    this.cyclesById.set(cycleId, c);
    this.args.sink.upsertCycle({ ...row });
    for (const leg of c.legs) this.args.sink.upsertLeg({ ...leg });
    return cycleId;
  }

  // ----------------------------------------------------------- main loop ----

  step(nowMs: number): void {
    for (const c of this.cyclesById.values()) {
      if (c.done) continue;
      this.advance(c, nowMs);
      c.lastStepMs = nowMs;
    }
  }

  /** Market resolved: settle held exposure, wind down any straggler cycles. */
  onResolution(marketId: string, outcome: OutcomeSide, nowMs: number): void {
    for (const c of this.cyclesById.values()) {
      if (c.done || c.row.marketId !== marketId) continue;
      if (c.row.state === "QUOTING_BOTH" || c.row.state === "ONE_LEG_FILLED") {
        this.handleCutoff(c, nowMs, "market resolved while quoting");
      }
      if (c.row.state === "PLANNED" || c.row.state === "INVENTORY_PREFLIGHT") {
        if (c.row.state === "INVENTORY_PREFLIGHT") this.transitionCycle(c, "INVENTORY_READY", "resolution reached before split", nowMs);
        else {
          this.transitionCycle(c, "RECONCILED", "abandoned at resolution (nothing done)", nowMs);
          this.finishRow(c, nowMs);
          continue;
        }
      }
      if (c.row.state === "SPLIT_PENDING") this.settleSplit(c, nowMs);
      if (c.done) continue;
      if (c.row.state === "MERGE_PENDING") {
        this.completeMerge(c, nowMs); // force merge completion at resolution
        continue;
      }
      if (c.row.state === "INVENTORY_READY") this.abortFromInventoryReady(c, nowMs);
      if (c.done) continue;
      if (c.row.state === "MERGE_OR_SETTLE") {
        if (c.wantsMerge) {
          this.trySubmitMerge(c, nowMs, true);
          // trySubmitMerge mutates row.state; re-read past TS's narrowing
          if ((c.row.state as PairedCycleState) === "MERGE_PENDING") this.completeMerge(c, nowMs);
        } else {
          this.settleAtResolution(c, outcome, nowMs);
        }
      }
    }
  }

  /**
   * Public fill hook: apply a full maker fill to a QUOTED leg. Used by tests
   * and available for future trade-tape wiring; the internal hazard model
   * calls the same path. Returns false when the leg cannot fill.
   */
  simulateLegFill(cycleId: string, legIndex: 0 | 1, nowMs: number): boolean {
    const c = this.cyclesById.get(cycleId);
    if (!c || c.done) return false;
    if (c.row.state !== "QUOTING_BOTH" && c.row.state !== "ONE_LEG_FILLED") return false;
    const leg = c.legs[legIndex];
    if (leg.state !== "QUOTED") return false;
    this.makerFill(c, legIndex, nowMs);
    // makerFill mutates row.state; re-read past TS's narrowing
    if ((c.row.state as PairedCycleState) === "BOTH_LEGS_FILLED") this.windDown(c, nowMs);
    return true;
  }

  // ------------------------------------------------------------- queries ----

  cycleView(id: string): CycleView | null {
    const c = this.cyclesById.get(id);
    if (!c) return null;
    return {
      row: c.row,
      legs: c.legs,
      history: c.history,
      riskFree: isRiskFree(c.row, c.legs),
    };
  }

  cycles(): CycleView[] {
    return [...this.cyclesById.keys()].map((id) => this.cycleView(id)!);
  }

  summary(): Record<string, unknown> {
    let open = 0;
    let reconciled = 0;
    let failed = 0;
    let riskFree = 0;
    let oneLegOpen = 0;
    let realizedPnl6 = 0n;
    let gas6 = 0n;
    let fees6 = 0n;
    for (const c of this.cyclesById.values()) {
      if (!c.done) open++;
      if (c.row.state === "RECONCILED") reconciled++;
      if (c.row.state === "FAILED_RECONCILIATION") failed++;
      if (isRiskFree(c.row, c.legs)) riskFree++;
      if (c.legs.some((l) => l.state === "UNHEDGED" || l.state === "PARTIAL_LEG")) oneLegOpen++;
      realizedPnl6 += c.row.realizedPnl6 ?? 0n;
      gas6 += c.gas6;
      fees6 += c.fees6;
    }
    return {
      mode: this.execMode,
      openCycles: open,
      reconciledCycles: reconciled,
      failedCycles: failed,
      riskFreeCycles: riskFree, // ONLY the domain isRiskFree() counts here
      oneLegOpen,
      tradingPnl6: realizedPnl6,
      gasPaid6: gas6,
      feesPaid6: fees6,
      operationalLoss6: this.operationalLoss6,
      rebates: this.args.rebates.totals(),
      rewards: this.args.rewards.totals(),
      realizedRebates6: this.args.rebates.realizedTotal6(),
      realizedRewards6: this.args.rewards.realizedTotal6(),
      note: "one-leg exposure is directional risk; rebates/rewards are not included until PAID",
    };
  }

  // -------------------------------------------------- Agent K risk gating ----

  /** Believed inventory across all simulated cycles (µshares by side). */
  private inventoryTotals(): { up6: Shares6; down6: Shares6 } {
    let up6 = 0n;
    let down6 = 0n;
    for (const c of this.cyclesById.values()) {
      for (const lot of c.lots) {
        if (lot.outcomeSide === "UP") up6 += lot.remainingShares6;
        else down6 += lot.remainingShares6;
      }
    }
    return { up6, down6 };
  }

  private pendingCtfOps(): Array<Pick<CtfOperation, "state" | "requestedAmount6" | "confirmedAmount6">> {
    const ops: Array<Pick<CtfOperation, "state" | "requestedAmount6" | "confirmedAmount6">> = [];
    for (const c of this.cyclesById.values()) {
      if (c.splitOp) ops.push(c.splitOp);
      if (c.mergeOp) ops.push(c.mergeOp);
    }
    return ops;
  }

  /**
   * Agent K's evaluateInventoryRisk over the cycle's derived facts plus
   * simulator-wide inventory/CTF totals. `addUp6`/`addDown6`/`addPendingCtf6`
   * describe what the requested action would add.
   */
  private riskCheck(c: SimCycle, nowMs: number, phase: CycleRiskRejection["phase"], add: {
    up6?: Shares6; down6?: Shares6; pendingCtf6?: Usdc6;
  }): InventoryRejection[] {
    const facts = deriveCycleFacts(c.row, c.legs, nowMs);
    const inv = this.inventoryTotals();
    const limits = this.args.riskLimits?.() ?? DEFAULT_INVENTORY_RISK_LIMITS;
    const ctx: InventoryRiskContext = {
      limits,
      mode: this.args.mode,
      bankroll6: this.args.bankroll6?.() ?? 0n,
      cycleState: facts.cycleState,
      labeledRiskFree: false, // this module NEVER labels a cycle risk-free
      computedRiskFree: facts.computedRiskFree,
      hasOpenLeg: facts.hasOpenLeg,
      hasUnhedgedFills: facts.hasUnhedgedFills,
      oneLegOpenMs: facts.oneLegOpenMs,
      unhedgedExposure6: facts.unhedgedExposure6,
      attemptsForIntent: 0, // one simulated attempt per leg; never retried
      cancelUncertaintyMs: null, // simulated cancels confirm synchronously
      pendingCtfValue6: derivePendingCtfValue6(this.pendingCtfOps()) + (add.pendingCtf6 ?? 0n),
      upInventory6: inv.up6 + (add.up6 ?? 0n),
      downInventory6: inv.down6 + (add.down6 ?? 0n),
      dailyOperationalLoss6: this.operationalLoss6,
      isSourceReproductionStrategy: false, // R10 internal hypothesis, not a source-claim allocation
      sourceClaimAllocation6: 0n,
      evExcludingUnpaidIncentivesPpm: c.planEvPerCostPpm,
      evIncludingUnpaidIncentivesPpm: null, // never computed WITH unpaid incentives
    };
    const verdict = evaluateInventoryRisk(ctx);
    if (!verdict.approved) {
      const codes = verdict.reasons.map((x) => x.code);
      c.history.push({ state: c.row.state, tsMs: nowMs, reason: `risk rejected at ${phase}: ${codes.join(",")}` });
      try {
        this.args.onRiskRejection?.({
          cycleId: c.row.id, marketId: c.row.marketId, phase, codes, reasons: verdict.reasons, tsMs: nowMs,
        });
      } catch {
        /* rejection reporting must never break the loop */
      }
    }
    return verdict.reasons;
  }

  // ----------------------------------------------------------- internals ----

  private advance(c: SimCycle, nowMs: number): void {
    switch (c.row.state) {
      case "PLANNED": {
        // Exposure-creating activation: risk-gate BEFORE committing anything.
        const add = c.row.kind === "SPLIT_SELL"
          ? { up6: c.legs[0].size6, down6: c.legs[1].size6, pendingCtf6: c.row.collateralCommitted6 }
          : { up6: c.legs[0].size6, down6: c.legs[1].size6 };
        const rejections = this.riskCheck(c, nowMs, "activate", add);
        if (rejections.length > 0) {
          this.transitionCycle(c, "RECONCILED",
            `abandoned before activation: risk rejected [${rejections.map((x) => x.code).join(",")}]`, nowMs);
          this.finalizeEconomics(c, nowMs);
          this.finishRow(c, nowMs);
          return;
        }
        this.transitionCycle(c, "INVENTORY_PREFLIGHT", "simulated preflight: collateral + allowances OK", nowMs);
        if (c.row.kind === "SPLIT_SELL") {
          this.submitSplit(c, nowMs);
        } else {
          this.transitionCycle(c, "INVENTORY_READY", "no split needed (buy-both); collateral reserved", nowMs);
          this.startQuoting(c, nowMs);
        }
        return;
      }
      case "SPLIT_PENDING": {
        if (c.pendingOpCompleteAtMs !== null && nowMs >= c.pendingOpCompleteAtMs) this.settleSplit(c, nowMs);
        return;
      }
      case "QUOTING_BOTH":
      case "ONE_LEG_FILLED": {
        if (nowMs >= c.ctx.cutoffMs) {
          this.handleCutoff(c, nowMs, "market cutoff reached");
          return;
        }
        this.quoteFillDraws(c, nowMs);
        if ((c.row.state as PairedCycleState) === "BOTH_LEGS_FILLED") {
          this.windDown(c, nowMs);
          return;
        }
        if ((c.row.state as PairedCycleState) === "ONE_LEG_FILLED" && c.row.oneLegFilledAtMs !== null) {
          const unhedgedMs = nowMs - c.row.oneLegFilledAtMs;
          c.row.unhedgedDurationMs = unhedgedMs;
          c.row.updatedAtMs = nowMs;
          this.args.sink.upsertCycle({ ...c.row });
          const cfg = this.args.cfg();
          if (unhedgedMs >= cfg.maxOneLegSeconds * 1000) {
            this.enterHedgeOrCancel(c, nowMs, `one-leg duration ${unhedgedMs}ms exceeded budget ${cfg.maxOneLegSeconds * 1000}ms`);
          }
        }
        return;
      }
      case "MERGE_PENDING": {
        if (c.pendingOpCompleteAtMs !== null && nowMs >= c.pendingOpCompleteAtMs) this.completeMerge(c, nowMs);
        return;
      }
      case "BOTH_LEGS_FILLED": {
        this.windDown(c, nowMs);
        return;
      }
      case "MERGE_OR_SETTLE": {
        // Deferred merge (pending-CTF cap): retry each step until allowed.
        if (c.wantsMerge && c.mergeOp === null) this.trySubmitMerge(c, nowMs, false);
        return;
      }
      default:
        return; // terminals / settle-wait do nothing per step
    }
  }

  private submitSplit(c: SimCycle, nowMs: number): void {
    const cfg = this.args.cfg();
    const op: CtfOperation = {
      id: this.id(),
      correlationId: c.row.correlationId,
      cycleId: c.row.id,
      marketId: c.row.marketId,
      conditionId: c.ctx.conditionId,
      kind: "SPLIT",
      state: "PLANNED",
      mode: this.execMode,
      requestedAmount6: c.row.collateralCommitted6,
      confirmedAmount6: null,
      collateralDelta6: null,
      estGasUsdc6: cfg.splitGasUsdc6,
      actualGasUsdc6: null,
      relayed: true,
      txHash: null,
      failureReason: null,
      createdAtMs: nowMs,
      submittedAtMs: null,
      confirmedAtMs: null,
      updatedAtMs: nowMs,
      configVersion: this.args.configVersion(),
    };
    this.transitionCtf(op, "SUBMITTED", nowMs);
    op.submittedAtMs = nowMs;
    c.splitOp = op;
    c.row.splitOperationId = op.id;
    c.pendingOpCompleteAtMs = nowMs + cfg.splitLatencyMs;
    this.args.sink.upsertCtfOperation({ ...op });
    this.transitionCycle(c, "SPLIT_PENDING", `split submitted (latency ${cfg.splitLatencyMs}ms, est gas ${cfg.splitGasUsdc6})`, nowMs);
  }

  private settleSplit(c: SimCycle, nowMs: number): void {
    const cfg = this.args.cfg();
    const op = c.splitOp!;
    c.pendingOpCompleteAtMs = null;
    const failed = c.rng.next() < cfg.splitFailureFraction;
    if (failed) {
      this.transitionCtf(op, "FAILED", nowMs);
      op.failureReason = "simulated split revert (relayer/tx failure)";
      op.actualGasUsdc6 = cfg.splitGasUsdc6; // gas burned even on revert
      c.gas6 += cfg.splitGasUsdc6;
      this.operationalLoss6 += cfg.splitGasUsdc6;
      this.args.sink.upsertCtfOperation({ ...op });
      // Believed state disagreed with chain truth until this reconciliation.
      this.transitionCycle(c, "FAILED_RECONCILIATION", "split reverted; no inventory created (gas lost)", nowMs);
      for (const [i, leg] of c.legs.entries()) {
        this.transitionLeg(c, i, "CANCELED", nowMs);
        leg.closedAtMs = nowMs;
        this.args.sink.upsertLeg({ ...leg });
      }
      this.finalizeEconomics(c, nowMs);
      this.transitionCycle(c, "RECONCILED", "simulated revert reconciled: collateral returned, gas lost", nowMs);
      this.finishRow(c, nowMs);
      return;
    }
    this.transitionCtf(op, "CONFIRMED", nowMs);
    op.confirmedAtMs = nowMs;
    op.confirmedAmount6 = c.row.collateralCommitted6;
    op.collateralDelta6 = -c.row.collateralCommitted6;
    op.actualGasUsdc6 = cfg.splitGasUsdc6;
    this.args.sink.upsertCtfOperation({ ...op });
    c.gas6 += cfg.splitGasUsdc6;
    c.outlay6 += c.row.collateralCommitted6;
    if (this.args.mode === "paper") {
      // split creates a full pair; cost basis split half/half (odd µ to UP)
      const half = c.row.collateralCommitted6 / 2n;
      this.addLot(c, c.ctx.upTokenId, "UP", "SPLIT", op.id, c.row.collateralCommitted6 - half, nowMs);
      this.addLot(c, c.ctx.downTokenId, "DOWN", "SPLIT", op.id, half, nowMs);
      this.emitSnapshot(c, nowMs);
    }
    this.transitionCycle(c, "INVENTORY_READY", "split confirmed; paired inventory ready", nowMs);
    this.startQuoting(c, nowMs);
  }

  private startQuoting(c: SimCycle, nowMs: number): void {
    // Risk gate at quote placement (resting quotes are open legs / future exposure).
    const rejections = this.riskCheck(c, nowMs, "quote", {});
    // Post-only sanity: a SELL at/below best bid (or BUY at/above best ask)
    // would cross — reject the quote pair safely, never convert to taker.
    const upBook = this.args.books(c.ctx.upTokenId);
    const downBook = this.args.books(c.ctx.downTokenId);
    const crosses = (leg: PairedLeg, book: BookState | null): boolean => {
      if (!book) return true;
      if (leg.orderSide === "SELL") {
        const bid = book.bestBid();
        return bid !== null && leg.price6 <= bid;
      }
      const ask = book.bestAsk();
      return ask !== null && leg.price6 >= ask;
    };
    if (rejections.length > 0 || crosses(c.legs[0], upBook) || crosses(c.legs[1], downBook)) {
      const why = rejections.length > 0
        ? `risk rejected [${rejections.map((x) => x.code).join(",")}]`
        : "post-only would cross at placement; rejected safely";
      this.transitionCycle(c, "QUOTING_BOTH", "quote placement attempted", nowMs);
      for (const [i, leg] of c.legs.entries()) {
        this.transitionLeg(c, i, "CANCELED", nowMs);
        leg.closedAtMs = nowMs;
        this.args.sink.upsertLeg({ ...leg });
      }
      this.transitionCycle(c, "INVENTORY_READY", `quotes not placed: ${why}`, nowMs);
      this.abortFromInventoryReady(c, nowMs);
      return;
    }
    for (const [i, leg] of c.legs.entries()) {
      this.transitionLeg(c, i, "QUOTED", nowMs);
      leg.quotedAtMs = nowMs;
      this.args.sink.upsertLeg({ ...leg });
      // rebate EXPECTED bookkeeping on the quoted maker notional (never EV)
      const notional6 = mulDiv(leg.size6, leg.price6, 1_000_000n, "ceil");
      c.rebateEntryByLeg[i] = this.args.rebates.expect({
        correlationId: c.row.correlationId,
        marketId: c.row.marketId,
        cycleId: c.row.id,
        basisShares6: leg.size6,
        basisNotional6: notional6,
        amount6: expectedRebate6(notional6, c.ctx.feeRatePpm, c.ctx.rebateSharePpm),
        programVersion: "maker_rebates_docs_2026_snapshot",
        nowMs,
      });
    }
    c.bothQuotedSinceMs = nowMs;
    this.ensureRewardEntry(c, nowMs);
    this.transitionCycle(c, "QUOTING_BOTH", "both legs quoted post-only at the touch", nowMs);
  }

  private quoteFillDraws(c: SimCycle, nowMs: number): void {
    const cfg = this.args.cfg();
    const dtMs = Math.max(0, nowMs - c.lastStepMs);
    if (dtMs === 0) return;
    const p = 1 - Math.exp(-cfg.quoteFillHazardPerSec * (dtMs / 1000));
    for (const i of [0, 1] as const) {
      if (c.legs[i].state !== "QUOTED") continue;
      if (c.rng.next() < p) {
        this.makerFill(c, i, nowMs);
        if (c.row.state === "BOTH_LEGS_FILLED") return;
      }
    }
  }

  private makerFill(c: SimCycle, i: 0 | 1, nowMs: number): void {
    const leg = c.legs[i];
    const sib = c.legs[i === 0 ? 1 : 0];
    this.endQuotingUptime(c, nowMs);
    leg.filledShares6 = leg.size6;
    leg.avgFillPrice6 = leg.price6;
    leg.firstFillAtMs = nowMs;
    leg.feeUsdc6 = 0n; // maker pays no fee
    c.hadMakerFill = true;
    const notional6 = mulDiv(leg.size6, leg.price6, 1_000_000n, "ceil");
    if (leg.orderSide === "SELL") {
      c.proceeds6 += mulDiv(leg.size6, leg.price6, 1_000_000n, "floor");
      this.consumeLots(c, leg.tokenId, nowMs);
    } else {
      c.outlay6 += notional6;
      if (this.args.mode === "paper") this.addLot(c, leg.tokenId, leg.outcomeSide, "FILL", leg.id, notional6, nowMs);
    }
    const rebateId = c.rebateEntryByLeg[i];
    if (rebateId) {
      this.args.rebates.markAccrued(rebateId, expectedRebate6(notional6, c.ctx.feeRatePpm, c.ctx.rebateSharePpm), nowMs);
    }
    if (sib.state === "UNHEDGED") {
      // this fill completes the pair
      this.transitionLeg(c, i, "HEDGED", nowMs);
      leg.hedgedAtMs = nowMs;
      leg.closedAtMs = nowMs;
      this.transitionLeg(c, i === 0 ? 1 : 0, "HEDGED", nowMs);
      sib.hedgedAtMs = nowMs;
      sib.closedAtMs = nowMs;
      this.args.sink.upsertLeg({ ...leg });
      this.args.sink.upsertLeg({ ...sib });
      if (c.row.oneLegFilledAtMs !== null) c.row.unhedgedDurationMs = nowMs - c.row.oneLegFilledAtMs;
      c.row.hedgeCompletedAtMs = nowMs;
      this.transitionCycle(c, "BOTH_LEGS_FILLED", "sibling leg filled naturally; pair complete", nowMs);
    } else {
      this.transitionLeg(c, i, "UNHEDGED", nowMs);
      leg.unhedgedStartedAtMs = nowMs;
      this.args.sink.upsertLeg({ ...leg });
      c.row.oneLegFilledAtMs = nowMs;
      c.row.unhedgedDurationMs = 0;
      this.transitionCycle(c, "ONE_LEG_FILLED", `${leg.outcomeSide} leg filled; DIRECTIONAL EXPOSURE open`, nowMs);
      if (this.args.mode === "paper") this.emitSnapshot(c, nowMs);
    }
  }

  private enterHedgeOrCancel(c: SimCycle, nowMs: number, why: string): void {
    const cfg = this.args.cfg();
    this.transitionCycle(c, "HEDGE_OR_CANCEL", why, nowMs);
    const filledIdx = c.legs[0].state === "UNHEDGED" ? 0 : 1;
    const sibIdx = filledIdx === 0 ? 1 : 0;
    const filled = c.legs[filledIdx];
    const sib = c.legs[sibIdx];
    const unhedgedMs = c.row.oneLegFilledAtMs !== null ? nowMs - c.row.oneLegFilledAtMs : 0;
    c.row.unhedgedDurationMs = unhedgedMs;

    // Executable now on the sibling instrument, with adverse opportunity decay
    // (being filled is information; the survivor reprices against us).
    const sibBook = this.args.books(sib.tokenId);
    const base = c.row.kind === "SPLIT_SELL" ? sibBook?.bestBid() ?? null : sibBook?.bestAsk() ?? null;
    let executable: Prob6 | null = null;
    if (base !== null) {
      const decayUnits = BigInt(Math.round(cfg.opportunityDecayBpsPerSec * (unhedgedMs / 1000)));
      const decay6 = mulDiv(base, decayUnits, 10_000n, "ceil");
      const adjusted = c.row.kind === "SPLIT_SELL" ? base - decay6 : base + decay6;
      executable = adjusted < c.ctx.tickSize6 ? c.ctx.tickSize6 : adjusted > 999_999n ? 999_999n : adjusted;
    }
    const lossBudget6 = mulDiv(c.row.collateralCommitted6, cfg.maxUnhedgedRiskFractionPpm, 1_000_000n, "ceil");
    let decision = decideHedgeOrCancel({
      kind: c.row.kind,
      policy: cfg.hedgePolicy,
      exposureShares6: sib.size6,
      siblingQuote6: sib.price6,
      executableNow6: executable,
      takerFeeRatePpm: c.ctx.feeRatePpm,
      lossBudget6,
    });

    // Agent K risk gate at the hedge decision. Codes are always recorded;
    // exposure-inherent codes (the one-leg duration/exposure that triggered
    // this very decision) cannot veto resolving it — but any OTHER cap
    // (inventory, pending CTF, operational-loss stop, live-policy) forces the
    // conservative CANCEL branch instead of a new taker order.
    const hedgeAdds = decision.action === "HEDGE" && c.row.kind === "BUY_BOTH_MERGE"
      ? (sib.outcomeSide === "UP" ? { up6: sib.size6 } : { down6: sib.size6 })
      : {};
    const rejections = this.riskCheck(c, nowMs, "hedge", hedgeAdds);
    const nonInherent = rejections.filter((x) =>
      x.code !== "ONE_LEG_DURATION_EXCEEDED" && x.code !== "UNHEDGED_EXPOSURE_EXCEEDED"
      && x.code !== "RISK_FREE_LABEL_WITH_OPEN_LEG");
    if (decision.action === "HEDGE" && nonInherent.length > 0) {
      decision = {
        action: "CANCEL_AND_SETTLE",
        hedgeKind: "CANCEL_REMAINING_QUOTE",
        estimatedCost6: decision.estimatedCost6,
        reason: `risk rejected hedge [${nonInherent.map((x) => x.code).join(",")}]; forced cancel branch`,
      };
    }

    if (decision.action === "HEDGE" && executable !== null) {
      // Cross the spread on the sibling instrument (taker): completes/flattens the pair.
      const fee6 = takerFeeUsdc(sib.size6, executable, c.ctx.feeRatePpm);
      const sibNotional6 = mulDiv(sib.size6, executable, 1_000_000n, sib.orderSide === "SELL" ? "floor" : "ceil");
      if (sib.orderSide === "SELL") {
        c.proceeds6 += sibNotional6;
        this.consumeLots(c, sib.tokenId, nowMs);
      } else {
        c.outlay6 += sibNotional6;
        if (this.args.mode === "paper") this.addLot(c, sib.tokenId, sib.outcomeSide, "HEDGE", sib.id, sibNotional6, nowMs);
      }
      c.fees6 += fee6;
      sib.filledShares6 = sib.size6;
      sib.avgFillPrice6 = executable;
      sib.feeUsdc6 = fee6;
      this.transitionLeg(c, sibIdx, "HEDGED", nowMs);
      sib.hedgedAtMs = nowMs;
      sib.closedAtMs = nowMs;
      this.transitionLeg(c, filledIdx, "HEDGED", nowMs);
      filled.hedgedAtMs = nowMs;
      filled.closedAtMs = nowMs;
      this.args.sink.upsertLeg({ ...sib });
      this.args.sink.upsertLeg({ ...filled });
      // taker execution earns no rebate: void the sibling's EXPECTED entry
      const sibRebate = c.rebateEntryByLeg[sibIdx];
      if (sibRebate) this.args.rebates.dispute(sibRebate, nowMs);
      const slip6 = c.row.kind === "SPLIT_SELL"
        ? (sib.price6 > executable ? sib.price6 - executable : 0n)
        : (executable > sib.price6 ? executable - sib.price6 : 0n);
      this.recordHedgeAction(c, {
        legId: filled.id, tokenId: sib.tokenId, kind: decision.hedgeKind, state: "DONE",
        targetShares6: sib.size6, executedShares6: sib.size6,
        expectedCost6: decision.estimatedCost6,
        actualCost6: mulDiv(sib.size6, slip6, 1_000_000n, "ceil") + fee6,
        feeUsdc6: fee6, unhedgedDurationMs: unhedgedMs, nowMs,
      });
      c.row.hedgeCompletedAtMs = nowMs;
      this.transitionCycle(c, "BOTH_LEGS_FILLED", `hedged via ${decision.hedgeKind}: ${decision.reason}`, nowMs);
      this.windDown(c, nowMs);
      return;
    }

    // CANCEL_AND_SETTLE: cancel the unfilled quote, hold exposure to settlement.
    this.transitionLeg(c, sibIdx, "CANCELED", nowMs);
    sib.closedAtMs = nowMs;
    this.args.sink.upsertLeg({ ...sib });
    const sibRebate = c.rebateEntryByLeg[sibIdx];
    if (sibRebate) this.args.rebates.dispute(sibRebate, nowMs); // quote never executed
    this.recordHedgeAction(c, {
      legId: sib.id, tokenId: sib.tokenId, kind: "CANCEL_REMAINING_QUOTE", state: "DONE",
      targetShares6: sib.size6, executedShares6: 0n,
      expectedCost6: decision.estimatedCost6, actualCost6: 0n, feeUsdc6: null,
      unhedgedDurationMs: unhedgedMs, nowMs,
    });
    this.recordHedgeAction(c, {
      legId: filled.id,
      tokenId: c.row.kind === "SPLIT_SELL" ? sib.tokenId : filled.tokenId,
      kind: "HOLD_TO_RESOLUTION", state: "DONE",
      targetShares6: filled.size6, executedShares6: null,
      expectedCost6: null, actualCost6: null, feeUsdc6: null,
      unhedgedDurationMs: unhedgedMs, nowMs,
    });
    c.exposedLegIndex = filledIdx;
    // split-sell: we still HOLD the sibling's token (unsold half of the pair);
    // buy-both: we hold the token we bought.
    c.heldTokenSide = c.row.kind === "SPLIT_SELL" ? sib.outcomeSide : filled.outcomeSide;
    this.transitionCycle(c, "MERGE_OR_SETTLE", `holding ${c.heldTokenSide} exposure to settlement: ${decision.reason}`, nowMs);
  }

  private handleCutoff(c: SimCycle, nowMs: number, why: string): void {
    if (c.row.state === "ONE_LEG_FILLED") {
      this.enterHedgeOrCancel(c, nowMs, `${why} with one leg filled`);
      return;
    }
    // Zero net fills: clean abort back to INVENTORY_READY, then wind down.
    this.endQuotingUptime(c, nowMs);
    for (const [i, leg] of c.legs.entries()) {
      if (leg.state !== "QUOTED") continue;
      this.transitionLeg(c, i, "CANCELED", nowMs);
      leg.closedAtMs = nowMs;
      this.args.sink.upsertLeg({ ...leg });
      const rebateId = c.rebateEntryByLeg[i];
      if (rebateId) this.args.rebates.dispute(rebateId, nowMs); // never executed
    }
    this.transitionCycle(c, "INVENTORY_READY", `${why}: quotes canceled with zero net fills`, nowMs);
    this.abortFromInventoryReady(c, nowMs);
  }

  private abortFromInventoryReady(c: SimCycle, nowMs: number): void {
    this.transitionCycle(c, "MERGE_OR_SETTLE", "winding down unused inventory", nowMs);
    const holdsPair = this.remainingIn(c, c.ctx.upTokenId) > 0n || this.args.mode === "shadow";
    if (c.row.kind === "SPLIT_SELL" && c.splitOp?.state === "CONFIRMED" && holdsPair) {
      c.wantsMerge = true;
      c.mergeReason = this.args.mode === "shadow"
        ? "shadow: modeled merge-back of untouched pair"
        : "merging untouched pair back to collateral";
      this.trySubmitMerge(c, nowMs, false);
      return;
    }
    this.finalizeAfterTrading(c, nowMs, "nothing held; no CTF op needed");
  }

  /** Risk-gated merge submission; on rejection the merge is DEFERRED (retried
   * next step) — never abandoned, because merging only reduces risk. */
  private trySubmitMerge(c: SimCycle, nowMs: number, force: boolean): void {
    const amount6 = c.row.kind === "SPLIT_SELL" ? c.row.collateralCommitted6 : c.legs[0].size6;
    if (!force) {
      const rejections = this.riskCheck(c, nowMs, "merge", { pendingCtf6: amount6 });
      const blocking = rejections.filter((x) => x.code === "PENDING_CTF_VALUE_EXCEEDED");
      if (blocking.length > 0) return; // deferred; advance() retries
    }
    this.submitMerge(c, nowMs, c.mergeReason || "merging pair to collateral");
  }

  private submitMerge(c: SimCycle, nowMs: number, why: string): void {
    const cfg = this.args.cfg();
    const op: CtfOperation = {
      id: this.id(),
      correlationId: c.row.correlationId,
      cycleId: c.row.id,
      marketId: c.row.marketId,
      conditionId: c.ctx.conditionId,
      kind: "MERGE",
      state: "PLANNED",
      mode: this.execMode,
      requestedAmount6: c.row.kind === "SPLIT_SELL" ? c.row.collateralCommitted6 : c.legs[0].size6,
      confirmedAmount6: null,
      collateralDelta6: null,
      estGasUsdc6: cfg.mergeGasUsdc6,
      actualGasUsdc6: null,
      relayed: true,
      txHash: null,
      failureReason: null,
      createdAtMs: nowMs,
      submittedAtMs: null,
      confirmedAtMs: null,
      updatedAtMs: nowMs,
      configVersion: this.args.configVersion(),
    };
    this.transitionCtf(op, "SUBMITTED", nowMs);
    op.submittedAtMs = nowMs;
    c.mergeOp = op;
    c.row.mergeOperationId = op.id;
    c.pendingOpCompleteAtMs = nowMs + cfg.mergeLatencyMs;
    c.wantsMerge = false;
    this.args.sink.upsertCtfOperation({ ...op });
    this.transitionCycle(c, "MERGE_PENDING", why, nowMs);
  }

  private completeMerge(c: SimCycle, nowMs: number): void {
    const cfg = this.args.cfg();
    const op = c.mergeOp!;
    c.pendingOpCompleteAtMs = null;
    this.transitionCtf(op, "CONFIRMED", nowMs);
    op.confirmedAtMs = nowMs;
    op.confirmedAmount6 = op.requestedAmount6;
    op.collateralDelta6 = op.requestedAmount6;
    op.actualGasUsdc6 = cfg.mergeGasUsdc6;
    this.args.sink.upsertCtfOperation({ ...op });
    c.gas6 += cfg.mergeGasUsdc6;
    c.proceeds6 += op.requestedAmount6; // the pair merges back to 1.00 collateral
    this.consumeLots(c, c.ctx.upTokenId, nowMs);
    this.consumeLots(c, c.ctx.downTokenId, nowMs);
    if (this.args.mode === "paper") this.emitSnapshot(c, nowMs);
    this.finalizeAfterTrading(c, nowMs, "merge confirmed");
  }

  private windDown(c: SimCycle, nowMs: number): void {
    this.transitionCycle(c, "MERGE_OR_SETTLE", "pair complete; deciding wind-down", nowMs);
    if (c.row.kind === "BUY_BOTH_MERGE") {
      c.wantsMerge = true;
      c.mergeReason = "merging acquired pair to collateral";
      this.trySubmitMerge(c, nowMs, false);
      return;
    }
    // split-sell with both legs disposed: nothing left to merge or settle
    this.finalizeAfterTrading(c, nowMs, "both tokens disposed; nothing held");
  }

  private settleAtResolution(c: SimCycle, outcome: OutcomeSide, nowMs: number): void {
    const cfg = this.args.cfg();
    if (c.exposedLegIndex !== null && c.heldTokenSide !== null) {
      const filled = c.legs[c.exposedLegIndex]!;
      const heldTokenId = c.heldTokenSide === "UP" ? c.ctx.upTokenId : c.ctx.downTokenId;
      const won = outcome === c.heldTokenSide;
      if (won) {
        const op: CtfOperation = {
          id: this.id(),
          correlationId: c.row.correlationId,
          cycleId: c.row.id,
          marketId: c.row.marketId,
          conditionId: c.ctx.conditionId,
          kind: "REDEEM",
          state: "PLANNED",
          mode: this.execMode,
          requestedAmount6: filled.size6,
          confirmedAmount6: null,
          collateralDelta6: null,
          estGasUsdc6: cfg.redeemGasUsdc6,
          actualGasUsdc6: null,
          relayed: true,
          txHash: null,
          failureReason: null,
          createdAtMs: nowMs,
          submittedAtMs: null,
          confirmedAtMs: null,
          updatedAtMs: nowMs,
          configVersion: this.args.configVersion(),
        };
        this.transitionCtf(op, "SUBMITTED", nowMs);
        op.submittedAtMs = nowMs;
        this.transitionCtf(op, "CONFIRMED", nowMs);
        op.confirmedAtMs = nowMs;
        op.confirmedAmount6 = filled.size6;
        op.collateralDelta6 = filled.size6;
        op.actualGasUsdc6 = cfg.redeemGasUsdc6;
        this.args.sink.upsertCtfOperation({ ...op });
        c.gas6 += cfg.redeemGasUsdc6;
        c.proceeds6 += filled.size6; // winning token redeems at 1.00
      }
      this.consumeLots(c, heldTokenId, nowMs);
      this.transitionLeg(c, c.exposedLegIndex, "SETTLED", nowMs);
      filled.closedAtMs = nowMs;
      this.args.sink.upsertLeg({ ...filled });
      if (this.args.mode === "paper") this.emitSnapshot(c, nowMs);
      this.finalizeAfterTrading(c, nowMs, `settled at resolution: held ${c.heldTokenSide} ${won ? "WON" : "LOST"}`);
      return;
    }
    this.finalizeAfterTrading(c, nowMs, "settled at resolution (nothing held)");
  }

  /** Terminal accounting + accrual wrap-up. Enters via MERGE_OR_SETTLE or MERGE_PENDING. */
  private finalizeAfterTrading(c: SimCycle, nowMs: number, why: string): void {
    // Executed maker rebates advance ACCRUED -> PENDING (awaiting the
    // program's payment run); NOTHING here can mark them PAID.
    for (const id of c.rebateEntryByLeg) {
      if (!id) continue;
      const e = this.args.rebates.entry(id);
      if (e.state === "ACCRUED") this.args.rebates.markPending(id, nowMs);
    }
    this.finalizeEconomics(c, nowMs);
    if (c.row.realizedPnl6 !== null && c.row.realizedPnl6 < 0n && c.exposedLegIndex !== null) {
      // one-leg settle losses count toward the operational-loss stop
      this.operationalLoss6 += -c.row.realizedPnl6;
    }
    const unpaidAccruals = this.args.rebates.entriesForCycle(c.row.id)
      .some((e) => e.state === "ACCRUED" || e.state === "PENDING") || c.quotingUptimeMs > 0;
    if (unpaidAccruals) {
      this.transitionCycle(c, "REWARD_PENDING", "trading reconciled; rebate/reward accruals remain UNPAID (not realized)", nowMs);
    }
    this.transitionCycle(c, "RECONCILED", `${why}; balances and fills reconciled`, nowMs);
    this.finishRow(c, nowMs);
  }

  private finalizeEconomics(c: SimCycle, nowMs: number): void {
    c.row.spreadCaptured6 = c.proceeds6 - c.outlay6;
    c.row.fees6 = c.fees6;
    // Cycle P&L: trading economics MINUS gas AND fees. Unpaid accruals never appear.
    c.row.realizedPnl6 = c.proceeds6 - c.outlay6 - c.fees6 - c.gas6;
    c.row.updatedAtMs = nowMs;
    this.args.sink.upsertCycle({ ...c.row });
  }

  private finishRow(c: SimCycle, nowMs: number): void {
    c.row.reconciledAtMs = nowMs;
    c.row.updatedAtMs = nowMs;
    c.done = true;
    this.args.sink.upsertCycle({ ...c.row });
    if (this.args.mode === "paper") this.emitSnapshot(c, nowMs);
  }

  // ---- liquidity-reward uptime (separate program; EXPECTED/ACCRUED only) ----

  private ensureRewardEntry(c: SimCycle, nowMs: number): void {
    const epochKey = new Date(nowMs).toISOString().slice(0, 10);
    const key = `${c.row.marketId}:${epochKey}`;
    if (this.rewardEntryByEpoch.has(key)) return;
    const id = this.args.rewards.expect({
      correlationId: c.row.correlationId,
      marketId: c.row.marketId,
      epochKey,
      amount6: 0n,
      programVersion: "liquidity_rewards_docs_2026_snapshot",
      scoreDetail: { note: "simulated two-sided uptime accrual", cycleIds: [c.row.id] },
      nowMs,
    });
    this.rewardEntryByEpoch.set(key, id);
  }

  private endQuotingUptime(c: SimCycle, nowMs: number): void {
    if (c.bothQuotedSinceMs === null) return;
    const dt = Math.max(0, nowMs - c.bothQuotedSinceMs);
    c.bothQuotedSinceMs = null;
    if (dt === 0) return;
    c.quotingUptimeMs += dt;
    const epochKey = new Date(nowMs).toISOString().slice(0, 10);
    const id = this.rewardEntryByEpoch.get(`${c.row.marketId}:${epochKey}`);
    if (!id) return;
    const cfg = this.args.cfg();
    const add6 = mulDiv(cfg.rewardPerSecondUsdc6, BigInt(dt), 1000n, "floor");
    try {
      const e = this.args.rewards.entry(id);
      if (e.state === "EXPECTED") {
        this.args.rewards.accrueUptime(id, add6, dt, nowMs);
      } else if (e.state === "ACCRUED") {
        this.args.rewards.addQualifiedUptime(id, add6, dt, nowMs);
      }
    } catch (err) {
      logger.warn("liquidity reward uptime accrual failed", { error: String(err) });
    }
  }

  // ------------------------------------------------------------- helpers ----

  private transitionCycle(c: SimCycle, to: PairedCycleState, reason: string, nowMs: number): void {
    assertValidCycleTransition(c.row.state, to);
    c.row.state = to;
    c.row.updatedAtMs = nowMs;
    c.history.push({ state: to, tsMs: nowMs, reason });
    this.args.sink.upsertCycle({ ...c.row });
  }

  private transitionLeg(c: SimCycle, i: number, to: PairedLeg["state"], nowMs: number): void {
    const leg = c.legs[i]!;
    assertValidLegTransition(leg.state, to);
    leg.state = to;
    leg.updatedAtMs = nowMs;
  }

  private transitionCtf(op: CtfOperation, to: CtfOperation["state"], nowMs: number): void {
    assertValidCtfTransition(op.state, to);
    op.state = to;
    op.updatedAtMs = nowMs;
  }

  private recordHedgeAction(c: SimCycle, a: {
    legId: string; tokenId: string | null; kind: HedgeActionKind; state: HedgeAction["state"];
    targetShares6: Shares6; executedShares6: Shares6 | null;
    expectedCost6: Usdc6 | null; actualCost6: Usdc6 | null; feeUsdc6: Usdc6 | null;
    unhedgedDurationMs: number; nowMs: number;
  }): void {
    this.args.sink.upsertHedgeAction({
      id: this.id(),
      correlationId: c.row.correlationId,
      cycleId: c.row.id,
      legId: a.legId,
      marketId: c.row.marketId,
      tokenId: a.tokenId,
      kind: a.kind,
      state: a.state,
      mode: this.execMode,
      targetShares6: a.targetShares6,
      executedShares6: a.executedShares6,
      expectedCost6: a.expectedCost6,
      actualCost6: a.actualCost6,
      feeUsdc6: a.feeUsdc6,
      attemptId: null,
      unhedgedDurationMs: a.unhedgedDurationMs,
      decidedAtMs: a.nowMs,
      executedAtMs: a.state === "DONE" ? a.nowMs : null,
      updatedAtMs: a.nowMs,
      configVersion: this.args.configVersion(),
    });
  }

  private addLot(c: SimCycle, tokenId: string, side: OutcomeSide, source: SimLot["source"], sourceRef: string | null, costBasis6: Usdc6, nowMs: number): void {
    const shares6 = c.legs[0].size6;
    const lot: SimLot = {
      id: this.id(), tokenId, outcomeSide: side, source, sourceRef,
      acquiredShares6: shares6, remainingShares6: shares6, costBasis6,
      acquiredAtMs: nowMs, consumedAtMs: null,
    };
    c.lots.push(lot);
    this.persistLot(c, lot);
  }

  private consumeLots(c: SimCycle, tokenId: string, nowMs: number): void {
    for (const lot of c.lots) {
      if (lot.tokenId !== tokenId || lot.remainingShares6 === 0n) continue;
      lot.remainingShares6 = 0n;
      lot.consumedAtMs = nowMs;
      this.persistLot(c, lot);
    }
  }

  private remainingIn(c: SimCycle, tokenId: string): Shares6 {
    let total = 0n;
    for (const lot of c.lots) {
      if (lot.tokenId === tokenId) total += lot.remainingShares6;
    }
    return total;
  }

  private persistLot(c: SimCycle, lot: SimLot): void {
    this.args.sink.upsertLot({
      id: lot.id,
      correlationId: c.row.correlationId,
      cycleId: c.row.id,
      marketId: c.row.marketId,
      tokenId: lot.tokenId,
      outcomeSide: lot.outcomeSide,
      source: lot.source,
      sourceRef: lot.sourceRef,
      mode: this.execMode,
      acquiredShares6: lot.acquiredShares6,
      remainingShares6: lot.remainingShares6,
      costBasis6: lot.costBasis6,
      acquiredAtMs: lot.acquiredAtMs,
      consumedAtMs: lot.consumedAtMs,
      configVersion: this.args.configVersion(),
    });
  }

  private emitSnapshot(c: SimCycle, nowMs: number): void {
    let up6 = 0n;
    let down6 = 0n;
    for (const lot of c.lots) {
      if (lot.outcomeSide === "UP") up6 += lot.remainingShares6;
      else down6 += lot.remainingShares6;
    }
    const paired6 = up6 < down6 ? up6 : down6;
    let reservedUp6 = 0n;
    let reservedDown6 = 0n;
    for (const leg of c.legs) {
      if (leg.state !== "QUOTED" || leg.orderSide !== "SELL") continue;
      if (leg.outcomeSide === "UP") reservedUp6 += leg.size6;
      else reservedDown6 += leg.size6;
    }
    this.args.sink.addSnapshot({
      id: this.id(),
      correlationId: c.row.correlationId,
      marketId: c.row.marketId,
      mode: this.execMode,
      upShares6: up6,
      downShares6: down6,
      pairedShares6: paired6,
      unpairedUpShares6: up6 - paired6,
      unpairedDownShares6: down6 - paired6,
      reservedUpShares6: reservedUp6,
      reservedDownShares6: reservedDown6,
      collateralFree6: null,
      exchangeUpShares6: null,
      exchangeDownShares6: null,
      onchainUpShares6: null,
      onchainDownShares6: null,
      reconciled: true, // believed-only snapshot; nothing external queried
      divergence: null,
      tsMs: nowMs,
      configVersion: this.args.configVersion(),
    });
  }
}
