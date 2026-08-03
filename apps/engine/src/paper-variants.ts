import {
  mulDiv, takerFeeUsdc,
  type OutcomeSide, type PaperFillVariant, type Ppm, type Prob6, type Shares6, type Usdc6,
} from "@b5p/domain";
import { newId, sha256Hex } from "@b5p/domain/ids";
import type { StressParams } from "./execution-constants";
import type { ExecutionPersistence } from "./execution-persistence";
import type { PaperOrderRecord } from "./paper";

/**
 * Three-variant paper fill simulation (plan item 1c).
 *
 * The canonical paper path (PaperExecutor -> Accounting -> pnl_records) is
 * UNCHANGED and is, by definition, the QUEUE_REPLAY variant: this engine
 * mirrors its actual fills verbatim, which makes the QUEUE_REPLAY variant
 * bit-identical to today's results by construction. The other two variants
 * are pure shadow simulations that never touch orders/positions/pnl:
 *
 *  - OPTIMISTIC_TOUCH: the maker order fills fully at its price the moment it
 *    activates at the touch (no queue, no waiting for prints). Takers fill as
 *    queue replay (taker fills are already immediate).
 *  - CONSERVATIVE_STRESS: strictly degraded queue replay — extra activation
 *    latency, each fill independently missed with a configured probability,
 *    surviving fills repriced one tick worse, failed cancels charged as an
 *    adverse-selection penalty on the remaining notional (cost only — the
 *    stress variant can never fill MORE or BETTER than queue replay).
 *
 * Determinism: all randomness comes from a hash-seeded PRNG keyed by the
 * decision's correlationId (no Math.random anywhere), so replays of the same
 * event stream produce identical results.
 */

/** Deterministic PRNG: sha256(seed) -> mulberry32. */
export class SeededRng {
  private state: number;

  constructor(seed: string) {
    this.state = Number.parseInt(sha256Hex(seed).slice(0, 8), 16) >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

interface VariantFillState {
  filled6: Shares6;
  cost6: Usdc6;
  fees6: Usdc6;
}

interface VariantDecisionState {
  decisionId: string;
  correlationId: string;
  marketId: string;
  tokenId: string;
  orderId: string;
  outcomeSide: OutcomeSide;
  style: PaperOrderRecord["style"];
  price6: Prob6;
  shares6: Shares6;
  stakeCap6: Usdc6;
  tickSize6: Prob6;
  feeRatePpm: Ppm;
  feeCollection: "usdc" | "shares";
  activateAtMs: number;
  opt: VariantFillState & { done: boolean };
  qr: VariantFillState;
  stress: VariantFillState & { penalty6: Usdc6; missedFills: number; canceledAtMs: number | null; cancelFailed: boolean };
  rng: SeededRng;
  finished: boolean;
}

interface ResolvedSample {
  marketId: string;
  /** Micro-USDC of settled net value per 1 USDC staked, minus 1e6 (0 = break-even). */
  signalValuePerStake6: bigint | null;
  fillValuePerStake6: bigint | null;
}

export class PaperVariantEngine {
  private states = new Map<string, VariantDecisionState>(); // orderId -> state
  private byMarket = new Map<string, string[]>(); // marketId -> orderIds
  private samples: ResolvedSample[] = [];
  private windowStartMs: number | null = null;

  constructor(
    private readonly persistence: ExecutionPersistence,
    private readonly stress: () => StressParams,
    private readonly configVersion: () => number,
  ) {}

  /** Register the canonical paper order the moment it is submitted. */
  onOrderSubmitted(o: PaperOrderRecord, ctx: {
    correlationId: string;
    tickSize6: Prob6;
    feeRatePpm: Ppm;
    feeCollection: "usdc" | "shares";
  }): void {
    const st: VariantDecisionState = {
      decisionId: o.decisionId,
      correlationId: ctx.correlationId,
      marketId: o.marketId,
      tokenId: o.tokenId,
      orderId: o.id,
      outcomeSide: o.outcomeSide,
      style: o.style,
      price6: o.price6,
      shares6: o.shares6,
      stakeCap6: o.stakeCap6,
      tickSize6: ctx.tickSize6,
      feeRatePpm: ctx.feeRatePpm,
      feeCollection: ctx.feeCollection,
      activateAtMs: o.activateAtMs,
      opt: { filled6: 0n, cost6: 0n, fees6: 0n, done: false },
      qr: { filled6: 0n, cost6: 0n, fees6: 0n },
      stress: { filled6: 0n, cost6: 0n, fees6: 0n, penalty6: 0n, missedFills: 0, canceledAtMs: null, cancelFailed: false },
      rng: new SeededRng(ctx.correlationId),
      finished: false,
    };
    this.states.set(o.id, st);
    const ids = this.byMarket.get(o.marketId) ?? [];
    ids.push(o.id);
    this.byMarket.set(o.marketId, ids);
  }

  /** Maker activation at the touch: OPTIMISTIC_TOUCH fills fully, immediately. */
  onOrderActivated(orderId: string, nowMs: number): void {
    const st = this.states.get(orderId);
    if (!st || st.opt.done) return;
    if (st.style === "maker_post_only") {
      this.fillVariant(st.opt, st.shares6, st.price6, 0n, st.stakeCap6); // maker pays no fee
      st.opt.done = true;
      void nowMs;
    }
    // takers: optimistic mirrors queue replay (fills are immediate either way)
  }

  /** Mirror an ACTUAL fill from the canonical executor (queue replay truth). */
  onActualFill(o: PaperOrderRecord, shares6: Shares6, price6: Prob6, fee6: Usdc6, tsMs: number): void {
    const st = this.states.get(o.id);
    if (!st) return;
    // QUEUE_REPLAY: verbatim mirror — bit-identical to the canonical path.
    st.qr.filled6 += shares6;
    st.qr.cost6 += mulDiv(shares6, price6, 1_000_000n, "ceil");
    st.qr.fees6 += fee6;

    // takers under OPTIMISTIC_TOUCH mirror queue replay
    if (st.style !== "maker_post_only" && !st.opt.done) {
      this.fillVariant(st.opt, shares6, price6, fee6, st.stakeCap6);
    }

    // CONSERVATIVE_STRESS: strictly degraded subset of queue-replay fills
    const p = this.stress();
    const stressActive = tsMs >= st.activateAtMs + p.extraLatencyMs
      && (st.stress.canceledAtMs === null || tsMs < st.stress.canceledAtMs);
    const missed = st.rng.next() < p.missedFillFraction;
    if (!stressActive || missed) {
      if (stressActive && missed) st.stress.missedFills++;
      return;
    }
    const worse6 = clampProb(price6 + BigInt(p.tickDisadvantageTicks) * st.tickSize6);
    const fee = st.style === "maker_post_only" || st.feeCollection !== "usdc"
      ? 0n
      : takerFeeUsdc(shares6, worse6, st.feeRatePpm);
    this.fillVariant(st.stress, shares6, worse6, fee, st.stakeCap6);
  }

  /** Canonical order finished (cancel/expiry/reject/full fill). */
  onOrderFinished(orderId: string, status: PaperOrderRecord["status"], nowMs: number): void {
    const st = this.states.get(orderId);
    if (!st || st.finished) return;
    st.finished = true;
    if (status === "CANCELED" || status === "EXPIRED") {
      const p = this.stress();
      st.stress.canceledAtMs = nowMs;
      const remaining = st.shares6 - st.stress.filled6;
      if (remaining > 0n && st.rng.next() < p.cancelFailFraction) {
        // Failed cancel charged as adverse-selection cost on the remaining
        // notional. Cost-only: no shares are granted, so the stress variant
        // can never out-fill queue replay.
        st.stress.cancelFailed = true;
        const notional6 = mulDiv(remaining, st.price6, 1_000_000n, "ceil");
        st.stress.penalty6 += mulDiv(notional6, BigInt(p.adverseMarkoutPenaltyBps), 10_000n, "ceil");
      }
    }
    if (status === "REJECTED") {
      st.opt.done = true; // never placed -> optimistic cannot fill either
    }
  }

  /**
   * Market resolved: persist the three variant results per decision plus the
   * per-window fill-selection cost samples. QUEUE_REPLAY results equal the
   * canonical pnl path by construction.
   */
  onResolution(marketId: string, outcome: OutcomeSide, nowMs: number): void {
    const orderIds = this.byMarket.get(marketId);
    if (!orderIds) return;
    this.byMarket.delete(marketId);
    const p = this.stress();
    for (const orderId of orderIds) {
      const st = this.states.get(orderId);
      if (!st) continue;
      this.states.delete(orderId);
      const won = st.outcomeSide === outcome;
      const results: Array<{ variant: PaperFillVariant; s: VariantFillState; penalty6: Usdc6; detail: Record<string, unknown> | null }> = [
        { variant: "OPTIMISTIC_TOUCH", s: st.opt, penalty6: 0n, detail: null },
        { variant: "QUEUE_REPLAY", s: st.qr, penalty6: 0n, detail: null },
        {
          variant: "CONSERVATIVE_STRESS", s: st.stress, penalty6: st.stress.penalty6,
          detail: {
            missedFills: st.stress.missedFills,
            cancelFailed: st.stress.cancelFailed,
            penalty6: st.stress.penalty6.toString(),
            params: {
              extraLatencyMs: p.extraLatencyMs,
              tickDisadvantageTicks: p.tickDisadvantageTicks,
              missedFillFraction: p.missedFillFraction,
              cancelFailFraction: p.cancelFailFraction,
              adverseMarkoutPenaltyBps: p.adverseMarkoutPenaltyBps,
            },
          },
        },
      ];
      for (const r of results) {
        const payout6: Usdc6 = won ? r.s.filled6 : 0n;
        const pnl6 = payout6 - r.s.cost6 - r.s.fees6 - r.penalty6;
        this.persistence.addVariantResult({
          id: newId(),
          correlationId: st.correlationId,
          decisionId: st.decisionId,
          marketId,
          variant: r.variant,
          filled: r.s.filled6 > 0n,
          fillPrice6: r.s.filled6 > 0n ? mulDiv(r.s.cost6, 1_000_000n, r.s.filled6, "half-even") : 0n,
          fillSize6: r.s.filled6,
          fee6: r.s.fees6,
          pnl6,
          detail: r.detail,
          tsMs: nowMs,
          configVersion: this.configVersion(),
        });
      }
      this.recordSelectionSample(st, won);
    }
  }

  /**
   * fill_selection_cost = signal_conditioned_value − fill_conditioned_value.
   * Values are mean settled net value per unit stake (micro-USDC per USDC),
   * signal-conditioned over every resolved decision (filled or not, at the
   * intended price/size) and fill-conditioned over actual QUEUE_REPLAY fills.
   */
  private recordSelectionSample(st: VariantDecisionState, won: boolean): void {
    if (this.windowStartMs === null) this.windowStartMs = Date.now();
    const intendedCost6 = mulDiv(st.shares6, st.price6, 1_000_000n, "ceil");
    const signal = intendedCost6 > 0n
      ? mulDiv((won ? st.shares6 : 0n) - intendedCost6, 1_000_000n, intendedCost6, "half-even")
      : null;
    const fillCost6 = st.qr.cost6 + st.qr.fees6;
    const fill = fillCost6 > 0n
      ? mulDiv((won ? st.qr.filled6 : 0n) - fillCost6, 1_000_000n, fillCost6, "half-even")
      : null;
    this.samples.push({ marketId: st.marketId, signalValuePerStake6: signal, fillValuePerStake6: fill });
  }

  /** Flush the accumulated resolution batch into one fill_selection_cost record. */
  flushSelectionCost(nowMs: number): boolean {
    if (this.samples.length === 0) return false;
    const batch = this.samples.splice(0);
    const signals = batch.map((s) => s.signalValuePerStake6).filter((v): v is bigint => v !== null);
    const fills = batch.map((s) => s.fillValuePerStake6).filter((v): v is bigint => v !== null);
    if (signals.length === 0) { this.windowStartMs = null; return false; }
    const signalMean = mean(signals);
    const fillMean = fills.length > 0 ? mean(fills) : 0n;
    const markets = new Set(batch.map((s) => s.marketId));
    this.persistence.addSelectionCost({
      id: newId(),
      correlationId: newId(),
      marketId: markets.size === 1 ? [...markets][0]! : null,
      signalConditionedValue6: signalMean,
      fillConditionedValue6: fillMean,
      cost6: signalMean - fillMean,
      signalSampleCount: signals.length,
      fillSampleCount: fills.length,
      windowStartMs: this.windowStartMs ?? nowMs,
      windowEndMs: nowMs,
      tsMs: nowMs,
      configVersion: this.configVersion(),
    });
    this.windowStartMs = null;
    return true;
  }

  /** Fill a shadow variant, honoring the approved stake cap exactly like the canonical path. */
  private fillVariant(v: VariantFillState, shares6: Shares6, price6: Prob6, fee6: Usdc6, stakeCap6: Usdc6): void {
    let take = shares6;
    let cost = mulDiv(take, price6, 1_000_000n, "ceil");
    let fee = fee6;
    if (v.cost6 + v.fees6 + cost + fee > stakeCap6) {
      // shrink to the cap (0.01-share steps, mirroring the canonical guard)
      const budget = stakeCap6 - v.cost6 - v.fees6;
      take = mulDiv(budget, 1_000_000n, price6, "floor");
      for (let guard = 0; guard < 200 && take > 0n; guard++) {
        cost = mulDiv(take, price6, 1_000_000n, "ceil");
        fee = fee6 > 0n ? mulDiv(fee6, take, shares6, "ceil") : 0n;
        if (cost + fee <= budget) break;
        take -= 10_000n;
      }
      if (take <= 0n) return;
    }
    v.filled6 += take;
    v.cost6 += cost;
    v.fees6 += fee;
  }
}

function clampProb(p: Prob6): Prob6 {
  return p > 999_999n ? 999_999n : p;
}

function mean(vals: bigint[]): bigint {
  const sum = vals.reduce((s, v) => s + v, 0n);
  return sum / BigInt(vals.length);
}
