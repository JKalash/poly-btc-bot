import { ONE, type ExecutionStyle, type Mode, type OutcomeSide, type Prob6 } from "@b5p/domain";
import type { FeatureSet } from "./features";
import { chainlinkDirection } from "./features";
import { evaluateGates, type GateCheck, type GateConfig, type StrategyDecision } from "./gates";
import { MODELS, conservativeProbabilityForSide } from "./models";

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

export const STRATEGY_PRESETS: Record<string, StrategyPreset> = {
  [bookDistancePreset.version]: bookDistancePreset,
  [lateSnipePreset.version]: lateSnipePreset,
};

export function presetAllowsMode(preset: StrategyPreset, mode: Mode): boolean {
  return preset.allowedModes.includes(mode);
}

export { ONE as PROB_ONE };
