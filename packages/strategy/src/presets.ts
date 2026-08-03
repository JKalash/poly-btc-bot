import { ONE, clampProb, type ExecutionStyle, type Mode, type OutcomeSide, type Prob6, type ProbabilityEstimate } from "@b5p/domain";
import type { FeatureSet } from "./features";
import { chainlinkDirection } from "./features";
import { evaluateGates, type GateCheck, type GateConfig, type StrategyDecision } from "./gates";
import { MODELS, calibrationBucket, conservativeProbabilityForSide } from "./models";

/**
 * Strategy preset registry. A preset binds a probability model, an execution
 * style, gate parameters, and — critically — the modes it may run in.
 * The late-snipe preset (gist integration) is restricted to observe/paper/
 * shadow until a dedicated walk-forward test passes; that restriction is code,
 * not configuration.
 */

export interface LateSnipeParams {
  snipeSecondsRemainingMin: number;
  snipeSecondsRemainingMax: number;
  minConfidence: number;
  maxPrice: number; // executable ask ceiling, e.g. 0.97
}

/**
 * Prior-window run state for the extended-move fade. Supplied by the engine
 * from RESOLVED prior windows only — the preset never infers a run from the
 * current window's tape, and it fails closed when the field is absent.
 */
export interface ExtendedMoveFadePriorRun {
  /** Consecutive immediately-preceding 5m windows that resolved in `direction`. */
  blocks: number;
  direction: OutcomeSide;
  /** Signed cumulative % move across the run; null when not measured (never fabricated). */
  cumulativeMovePct: number | null;
}

export interface ExtendedMoveFadeParams {
  minRunBlocks: number;
  minRunMovePct: number;
  maxEntryPrice: number;
  entrySecondsRemainingMin: number;
}

/** Context block for extended_move_fade_v1. Params may TIGHTEN the brief's floors, never loosen them (clamped in code). */
export type ExtendedMoveFadeContext = Partial<ExtendedMoveFadeParams> & {
  priorRun?: ExtendedMoveFadePriorRun | null;
};

export interface PresetContext {
  candidateSecondsRemainingMin: number;
  candidateSecondsRemainingMax: number;
  maxSpread: number;
  minDepthShares: number;
  minAbsDistanceZ: number;
  priceImprovementTicks: number;
  tickSize6: Prob6;
  probabilityModelKey: string;
  lateSnipe: LateSnipeParams;
  /** Optional: extended-move fade research inputs (absent → that preset produces no candidates). */
  extendedMoveFade?: ExtendedMoveFadeContext;
}

export interface StrategyPreset {
  version: string;
  displayName: string;
  allowedModes: readonly Mode[];
  style: ExecutionStyle;
  description: string;
  evaluate(f: FeatureSet, ctx: PresetContext): StrategyDecision;
}

const bookDistancePreset: StrategyPreset = {
  version: "book_distance_v1",
  displayName: "Maker value / book distance",
  allowedModes: ["observe", "paper", "shadow", "live"] as const,
  style: "maker_post_only",
  description:
    "Maker-first preset: post-only price improvement when the calibratable distance/volatility picture agrees with the Chainlink direction. Live use still requires a calibrated, approved model (none ships with this build).",
  evaluate(f, ctx) {
    const model = MODELS[ctx.probabilityModelKey] ?? MODELS.book_baseline!;
    const est = model.estimate(f);
    const cfg: GateConfig = {
      strategyVersion: this.version,
      candidateSecondsRemainingMin: ctx.candidateSecondsRemainingMin,
      candidateSecondsRemainingMax: ctx.candidateSecondsRemainingMax,
      minConservativeEdge: 0.02,
      maxSpread: ctx.maxSpread,
      minDepthShares: ctx.minDepthShares,
      minAbsDistanceZ: ctx.minAbsDistanceZ,
      priceImprovementTicks: ctx.priceImprovementTicks,
      tickSize6: ctx.tickSize6,
      minuteBucketStandaloneSignal: false,
    };
    return evaluateGates(f, est, cfg);
  },
};

/**
 * Late-snipe composite preset (gist integration). Enters late (default
 * 5-30s remaining) as a simulated taker when the composite score is
 * confident AND Chainlink confirms direction. This is the spec's
 * "late favorite" risk pattern — hence paper/shadow only, with the
 * "one loss erases N wins" arithmetic surfaced on every decision.
 */
const lateSnipePreset: StrategyPreset = {
  version: "late_snipe_composite_v1",
  displayName: "Late snipe (composite, PAPER/SHADOW ONLY)",
  allowedModes: ["observe", "paper", "shadow"] as const,
  style: "taker_fak",
  description:
    "Adapted from the operator's PolymarketBot gist: T-10s style entries driven by a 7-indicator Binance composite, with Chainlink confirmation required. Never live-eligible until a dedicated walk-forward test passes.",
  evaluate(f, ctx): StrategyDecision {
    const checks: GateCheck[] = [];
    const push = (name: string, pass: boolean, value: string, requirement: string) => {
      checks.push({ name, pass, value, requirement });
      return pass;
    };
    const P = ctx.lateSnipe;
    let ok = true;
    ok = push("warmup", f.warmedUp, f.warmedUp ? "warm" : "warming", "2-minute reference buffer complete") && ok;
    ok = push(
      "snipe_window",
      f.secondsRemaining >= P.snipeSecondsRemainingMin && f.secondsRemaining <= P.snipeSecondsRemainingMax,
      `${f.secondsRemaining}s remaining`,
      `${P.snipeSecondsRemainingMin}-${P.snipeSecondsRemainingMax}s window`,
    ) && ok;

    const ind = f.indicators;
    ok = push("indicators_available", ind !== null, ind ? ind.weightsVersion : "none", "Binance candle indicators computed") && ok;

    const est = MODELS.binance_composite!.estimate(f);
    ok = push("model_available", est !== null, est?.modelVersion ?? "none", "composite model produced an estimate") && ok;

    let side: OutcomeSide | null = null;
    if (ind && est) {
      ok = push(
        "composite_confidence",
        ind.confidence >= P.minConfidence,
        ind.confidence.toFixed(3),
        `confidence >= ${P.minConfidence}`,
      ) && ok;
      const dir = chainlinkDirection(f);
      const agree = ind.direction !== null && dir !== null && ind.direction === dir;
      ok = push(
        "chainlink_confirmation",
        agree,
        `composite=${ind.direction ?? "flat"} chainlink=${dir ?? "unknown"}`,
        "Binance composite may confirm but never override Chainlink",
      ) && ok;
      side = agree ? dir : null;
    } else {
      push("composite_confidence", false, "unavailable", `confidence >= ${P.minConfidence}`);
      push("chainlink_confirmation", false, "unavailable", "Binance composite may confirm but never override Chainlink");
      ok = false;
    }

    // executable taker price for the chosen side
    let desiredPrice6: Prob6 | null = null;
    if (side) {
      const ask = side === "UP" ? f.upBestAsk : f.downBestAsk;
      const priceOk = ask !== null && ask <= P.maxPrice;
      ok = push(
        "executable_price",
        priceOk,
        ask === null ? "no ask" : ask.toFixed(3),
        `ask <= ${P.maxPrice} (taker break-even rises above the price by the fee wedge)`,
      ) && ok;
      if (priceOk && ask !== null) desiredPrice6 = BigInt(Math.round(ask * 1_000_000));
    }

    push(
      "late_favorite_warning",
      true,
      side && desiredPrice6 !== null ? `a loss at ${(Number(desiredPrice6) / 1e6).toFixed(2)} erases ~${erasesWins(desiredPrice6)} wins` : "n/a",
      "informational: late high-price entries carry extreme asymmetric risk",
    );

    const conservative6 = est && side ? conservativeProbabilityForSide(est, side) : null;
    return { candidate: ok && side !== null && desiredPrice6 !== null, side, checks, desiredMakerPrice6: desiredPrice6, conservativeProbability6: conservative6 };
  },
};

function erasesWins(p6: Prob6): number {
  const p = Number(p6) / 1e6;
  return p >= 1 ? Infinity : Math.round((p / (1 - p)) * 10) / 10;
}

/*
 * ---------------------------------------------------------------------------
 * Extended-move fade (R8). All citations are line numbers in
 * 2026-07-31-001-initial-refinement.fable at the repo root.
 * ---------------------------------------------------------------------------
 */

/**
 * Run length that defines an "extended move": 4 consecutive same-direction
 * 5-minute windows = the source's "strong 20-minute run" (line 455); the
 * brief's YAML fixes `minimum_run_blocks: 4` (line 1431).
 */
export const FADE_MIN_RUN_BLOCKS = 4;

/**
 * Magnitude that makes a run "strong". The brief's only quantified strong-run
 * definition is R2's "run length at least 4 plus at least 0.8%" (line 943);
 * R8 itself gives no number, so this floor is adopted from R2 and flagged as
 * a reproduction parameter to be swept ("move magnitude", line 1046).
 */
export const FADE_MIN_RUN_MOVE_PCT = 0.8;

/**
 * Hard maker-price ceiling for the fade side. The source frames the edge as
 * "approximately a four-point paper edge at a 0.50 zero-fee maker price"
 * (line 464) — paying above 0.50 abandons the claim being reproduced, so the
 * preset never rests above it (forged contexts are clamped back down).
 */
export const FADE_MAX_ENTRY_PRICE = 0.5;

/**
 * Entry window: the claim is about the direction of the NEXT full window
 * after the run (line 455), so entries are restricted to the first 60s of
 * the 300s window (secondsRemaining >= 240). Entering later reproduces a
 * different statistic. R8 lists entry-time interactions as research (R5).
 */
export const FADE_ENTRY_SECONDS_REMAINING_MIN = 240;

/** Claimed yearly reversal rates after a strong 20-minute run (lines 457-462). SOURCE CLAIMS, not calibration. */
export const FADE_CLAIMED_REVERSAL_RATE_BY_YEAR: Readonly<Record<number, number>> = {
  2023: 0.538,
  2024: 0.516,
  2025: 0.545,
  2026: 0.546,
};

/** Simple mean of the four claimed yearly rates (lines 459-462). Uncalibrated point estimate only. */
export const FADE_POOLED_REVERSAL_RATE = 0.536;

/** 2024's 51.6% (line 460) — "a required stability warning, not a row to omit" (line 471). */
export const FADE_WEAKEST_YEAR_RATE = 0.516;

/** Half the 2023-2026 year-to-year range ((54.6% - 51.6%) / 2): cross-year instability term. */
export const FADE_YEAR_SPREAD_UNCERTAINTY = 0.015;

/**
 * Uncalibrated penalty, matching the distance/vol heuristic's convention in
 * models.ts. The source "explicitly stating that real maker fills and adverse
 * selection were not proven" (line 464) — so the band must stay wide.
 */
export const FADE_UNCALIBRATED_PENALTY = 0.05;

export const FADE_MODEL_VERSION = "extended_move_fade_v1_UNCALIBRATED";

/**
 * Probability estimate for the fade hypothesis, expressed for the UP token
 * (the registry convention). The point estimate is the pooled SOURCE CLAIM,
 * and the total uncertainty (0.065) deliberately pushes the conservative
 * bound BELOW the 0.50 coin flip: with year-spread + uncalibrated penalties,
 * the fade shows no conservative edge until real fill-conditioned
 * reproduction data replaces the claim (R8, line 1055).
 *
 * approvedForLive is HARD-CODED false — same wiring as every other research
 * model estimate in models.ts. No caller input reaches it.
 */
export function extendedMoveFadeEstimate(
  f: FeatureSet,
  fadeSide: OutcomeSide,
  run?: ExtendedMoveFadePriorRun | null,
): ProbabilityEstimate {
  const pUp = fadeSide === "UP" ? FADE_POOLED_REVERSAL_RATE : 1 - FADE_POOLED_REVERSAL_RATE;
  const uncertainty = FADE_YEAR_SPREAD_UNCERTAINTY + FADE_UNCALIBRATED_PENALTY;
  return {
    modelVersion: FADE_MODEL_VERSION,
    probability: fadeProb6(pUp),
    lowerBound: fadeProb6(pUp - uncertainty),
    upperBound: fadeProb6(pUp + uncertainty),
    calibrationBucket: calibrationBucket(f),
    uncertainty,
    dataQualityPenalty: 1 - f.dataQualityScore,
    featureAttributions: {
      priorRunBlocks: run?.blocks ?? 0,
      priorRunDirection: run ? (run.direction === "UP" ? 1 : -1) : 0,
      priorRunCumulativeMovePct: run?.cumulativeMovePct ?? 0,
      pooledClaimedReversalRate: FADE_POOLED_REVERSAL_RATE,
      weakestYearReversalRate: FADE_WEAKEST_YEAR_RATE,
    },
    // Never live: source claim, not a calibration (lines 464, 468-469, 1055, 1531).
    approvedForLive: false,
  };
}

function fadeProb6(x: number): Prob6 {
  return clampProb(BigInt(Math.round(x * 1_000_000)));
}

/**
 * Extended-move fade preset (R8, lines 1039-1055; hypothesis lines 453-471).
 * After >= 4 consecutive same-direction 5-minute windows (a strong 20-minute
 * run, >= 0.8% cumulative), fade the run: post-only maker on the OPPOSITE
 * side at <= 0.50, hold to resolution (the claimed statistic is the next
 * window's resolution direction). "Implement `extended_move_fade_v1` as a
 * disabled research hypothesis. It is not live-eligible." (lines 468-469) —
 * enforced here in code via allowedModes, and again in @b5p/config's
 * SOURCE_REPRODUCTION_STRATEGIES live rejection.
 */
const extendedMoveFadePreset: StrategyPreset = {
  version: "extended_move_fade_v1",
  displayName: "Extended-move fade (RESEARCH, PAPER/SHADOW ONLY)",
  allowedModes: ["observe", "paper", "shadow"] as const,
  style: "maker_post_only",
  description:
    "Fade a strong 20-minute run (>=4 same-direction 5m windows, >=0.8%) as a post-only maker at <=0.50 on the opposite side. Claimed yearly reversal rates 53.8/51.6/54.5/54.6% are SOURCE CLAIMS — uncalibrated, fills/adverse selection unproven. Never live-eligible; promotion beyond shadow requires fill-conditioned positive conservative net EV (R8).",
  evaluate(f, ctx): StrategyDecision {
    const checks: GateCheck[] = [];
    const push = (name: string, pass: boolean, value: string, requirement: string) => {
      checks.push({ name, pass, value, requirement });
      return pass;
    };

    // Context params may tighten the brief's floors but never loosen them —
    // a forged/mistyped context is clamped back to the cited parameters.
    const xc = ctx.extendedMoveFade;
    const minRunBlocks = Math.max(FADE_MIN_RUN_BLOCKS, Number(xc?.minRunBlocks ?? FADE_MIN_RUN_BLOCKS) || FADE_MIN_RUN_BLOCKS);
    const minRunMovePct = Math.max(FADE_MIN_RUN_MOVE_PCT, Number(xc?.minRunMovePct ?? FADE_MIN_RUN_MOVE_PCT) || FADE_MIN_RUN_MOVE_PCT);
    const rawMaxEntry = Number(xc?.maxEntryPrice ?? FADE_MAX_ENTRY_PRICE);
    const maxEntryPrice = rawMaxEntry > 0 && rawMaxEntry <= FADE_MAX_ENTRY_PRICE ? rawMaxEntry : FADE_MAX_ENTRY_PRICE;
    const entryMinSecs = Math.max(FADE_ENTRY_SECONDS_REMAINING_MIN, Number(xc?.entrySecondsRemainingMin ?? FADE_ENTRY_SECONDS_REMAINING_MIN) || FADE_ENTRY_SECONDS_REMAINING_MIN);

    let ok = true;
    ok = push("warmup", f.warmedUp, f.warmedUp ? "warm" : "warming", "2-minute reference buffer complete") && ok;
    ok = push(
      "entry_window",
      f.secondsRemaining >= entryMinSecs,
      `${f.secondsRemaining}s remaining`,
      `enter within the first ${300 - entryMinSecs}s of the window; the claim is next-window reversal (brief line 455)`,
    ) && ok;

    const run = xc?.priorRun ?? null;
    ok = push(
      "prior_run_available",
      run !== null,
      run ? `${run.blocks} blocks ${run.direction}` : "unavailable",
      "engine must supply the RESOLVED prior-window run; never inferred from the current window",
    ) && ok;

    let side: OutcomeSide | null = null;
    if (run) {
      ok = push(
        "run_length",
        run.blocks >= minRunBlocks,
        `${run.blocks} blocks`,
        `>= ${minRunBlocks} consecutive same-direction 5m windows (strong 20-minute run, brief lines 455, 1431)`,
      ) && ok;
      ok = push(
        "run_magnitude",
        run.cumulativeMovePct !== null && Math.abs(run.cumulativeMovePct) >= minRunMovePct,
        run.cumulativeMovePct === null ? "unknown" : `${run.cumulativeMovePct.toFixed(2)}%`,
        `|cumulative move| >= ${minRunMovePct}% (strong-run magnitude from R2, brief line 943; unknown never passes)`,
      ) && ok;
      side = run.direction === "UP" ? "DOWN" : "UP"; // fade = oppose the run
    } else {
      push("run_length", false, "unavailable", `>= ${minRunBlocks} consecutive same-direction 5m windows (brief lines 455, 1431)`);
      push("run_magnitude", false, "unavailable", `|cumulative move| >= ${minRunMovePct}% (brief line 943)`);
      ok = false;
    }

    ok = push(
      "spread",
      f.upSpread !== null && f.upSpread <= ctx.maxSpread,
      f.upSpread === null ? "unknown" : f.upSpread.toFixed(3),
      `spread <= ${ctx.maxSpread}`,
    ) && ok;

    const depth = side === "DOWN" ? f.upDepthBidTop5 : f.upDepthAskTop5;
    ok = push(
      "book_depth",
      depth !== null && depth >= ctx.minDepthShares,
      depth === null ? "unknown" : `${Math.round(depth)} shares`,
      `top-5 depth >= ${ctx.minDepthShares} shares`,
    ) && ok;

    // Post-only maker price on the fade side, hard-capped at the claim price.
    let desiredPrice6: Prob6 | null = null;
    if (side) {
      const bid = side === "UP" ? f.upBestBid : f.downBestBid;
      const ask = side === "UP" ? f.upBestAsk : f.downBestAsk;
      if (bid !== null && ask !== null) {
        const bid6 = BigInt(Math.round(bid * 1_000_000));
        const ask6 = BigInt(Math.round(ask * 1_000_000));
        const cap6 = BigInt(Math.round(maxEntryPrice * 1_000_000));
        let want = bid6 + ctx.tickSize6 * BigInt(ctx.priceImprovementTicks);
        if (want > cap6) want = cap6;
        if (want >= ask6) want = bid6 < cap6 ? bid6 : cap6; // join bid (or sit at the cap) rather than cross
        if (want > 0n && want < ask6 && want <= cap6) desiredPrice6 = want;
      }
      ok = push(
        "maker_price_within_claim",
        desiredPrice6 !== null,
        desiredPrice6 === null ? (bid === null || ask === null ? "no book" : "cannot rest") : (Number(desiredPrice6) / 1e6).toFixed(3),
        `post-only at <= ${maxEntryPrice.toFixed(2)} — the claimed four-point edge exists only at a 0.50 zero-fee maker price (brief line 464)`,
      ) && ok;
    } else {
      push("maker_price_within_claim", false, "no side", `post-only at <= ${maxEntryPrice.toFixed(2)} (brief line 464)`);
      ok = false;
    }

    push(
      "stability_warning_2024",
      true,
      `2024 claimed rate ${(FADE_WEAKEST_YEAR_RATE * 100).toFixed(1)}% (weakest year)`,
      "informational: the weak 2024 rate is a required stability warning, not a row to omit (brief line 471)",
    );
    push(
      "adverse_selection_unproven",
      true,
      "maker fills & adverse selection unproven (source's own admission)",
      "informational: promotion beyond shadow requires positive conservative net EV after adverse-selection penalties (brief lines 464, 1055)",
    );
    push(
      "research_only_not_live",
      true,
      "allowedModes=observe/paper/shadow",
      "extended-move fade remains non-live until fill-conditioned validation passes (brief lines 468-469, 1531); enforced by presetAllowsMode",
    );

    const est = side ? extendedMoveFadeEstimate(f, side, run) : null;
    const conservative6 = est && side ? conservativeProbabilityForSide(est, side) : null;
    return {
      candidate: ok && side !== null && desiredPrice6 !== null,
      side,
      checks,
      desiredMakerPrice6: desiredPrice6,
      conservativeProbability6: conservative6,
      estimate: est,
    };
  },
};

export const STRATEGY_PRESETS: Record<string, StrategyPreset> = {
  [bookDistancePreset.version]: bookDistancePreset,
  [lateSnipePreset.version]: lateSnipePreset,
  [extendedMoveFadePreset.version]: extendedMoveFadePreset,
};

export function presetAllowsMode(preset: StrategyPreset, mode: Mode): boolean {
  return preset.allowedModes.includes(mode);
}

export { ONE as PROB_ONE };
