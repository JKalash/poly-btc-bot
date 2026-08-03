import type { OutcomeSide, Prob6 } from "@b5p/domain";
import { ONE } from "@b5p/domain";
import type { FeatureSet } from "./features";
import { chainlinkDirection } from "./features";
import type { ProbabilityEstimate } from "@b5p/domain";
import { conservativeProbabilityForSide } from "./models";

/**
 * Strategy gate checklist. Every check is recorded pass/fail with a value so
 * the Signal Inspector can render "what would have to change".
 * The gates produce CANDIDATES; the risk engine separately approves/rejects.
 */

export interface GateCheck {
  name: string;
  pass: boolean;
  value: string;
  requirement: string;
}

export interface StrategyDecision {
  candidate: boolean;
  side: OutcomeSide | null;
  checks: GateCheck[];
  desiredMakerPrice6: Prob6 | null;
  conservativeProbability6: Prob6 | null;
  /**
   * Optional: the probability estimate behind the decision. Research presets
   * attach it so approvedForLive:false is auditable on the decision itself,
   * not only inside the model registry.
   */
  estimate?: ProbabilityEstimate | null;
}

export interface GateConfig {
  strategyVersion: string;
  candidateSecondsRemainingMin: number;
  candidateSecondsRemainingMax: number;
  minConservativeEdge: number;   // display-level precheck; exact check in risk
  maxSpread: number;
  minDepthShares: number;
  minAbsDistanceZ: number;
  priceImprovementTicks: number;
  tickSize6: Prob6;
  minuteBucketStandaloneSignal: false; // spec: minute buckets are never standalone signals
}

export function evaluateGates(f: FeatureSet, est: ProbabilityEstimate | null, cfg: GateConfig): StrategyDecision {
  const checks: GateCheck[] = [];
  const push = (name: string, pass: boolean, value: string, requirement: string) => {
    checks.push({ name, pass, value, requirement });
    return pass;
  };

  let ok = true;
  ok = push("warmup", f.warmedUp, f.warmedUp ? "warm" : "warming", "2-minute reference buffer complete") && ok;
  ok = push(
    "candidate_window",
    f.secondsRemaining >= cfg.candidateSecondsRemainingMin && f.secondsRemaining <= cfg.candidateSecondsRemainingMax,
    `${f.secondsRemaining}s remaining`,
    `${cfg.candidateSecondsRemainingMin}-${cfg.candidateSecondsRemainingMax}s window`,
  ) && ok;
  ok = push("model_available", est !== null, est?.modelVersion ?? "none", "probability model produced an estimate") && ok;

  const dir = chainlinkDirection(f);
  ok = push("chainlink_direction", dir !== null, dir ?? "unknown", "authoritative Chainlink distance known") && ok;

  // model direction must agree with Chainlink direction (Binance may confirm, never override)
  let side: OutcomeSide | null = null;
  if (est && dir) {
    const modelDir: OutcomeSide = est.probability >= ONE / 2n ? "UP" : "DOWN";
    const agree = modelDir === dir;
    ok = push("direction_agreement", agree, `model=${modelDir} chainlink=${dir}`, "model direction matches Chainlink direction") && ok;
    side = agree ? dir : null;
  } else {
    ok = false;
  }

  ok = push(
    "distance_significance",
    f.distanceZ !== null && Math.abs(f.distanceZ) >= cfg.minAbsDistanceZ,
    f.distanceZ === null ? "unknown" : f.distanceZ.toFixed(2),
    `|distance_z| >= ${cfg.minAbsDistanceZ}`,
  ) && ok;

  ok = push(
    "spread",
    f.upSpread !== null && f.upSpread <= cfg.maxSpread,
    f.upSpread === null ? "unknown" : f.upSpread.toFixed(3),
    `spread <= ${cfg.maxSpread}`,
  ) && ok;

  const depth = side === "DOWN" ? f.upDepthBidTop5 : f.upDepthAskTop5;
  ok = push(
    "book_depth",
    depth !== null && depth >= cfg.minDepthShares,
    depth === null ? "unknown" : `${Math.round(depth)} shares`,
    `top-5 depth >= ${cfg.minDepthShares} shares`,
  ) && ok;

  // spec guard: minute-of-hour bucket is NEVER a standalone entry authorization
  push("minute_bucket_not_standalone", true, f.closingMinuteBucket, "informational only; never authorizes entry");

  let desiredMakerPrice6: Prob6 | null = null;
  let conservative6: Prob6 | null = null;
  if (ok && est && side) {
    conservative6 = conservativeProbabilityForSide(est, side);
    // Maker price for the chosen side's token: improve on the best bid of that
    // token by N ticks, but stay strictly below the ask (post-only).
    const bestBid6 = side === "UP" ? asProb6(f.upBestBid) : asProb6(f.downBestBid);
    const bestAsk6 = side === "UP" ? asProb6(f.upBestAsk) : asProb6(f.downBestAsk);
    if (bestBid6 !== null && bestAsk6 !== null) {
      const improved = bestBid6 + cfg.tickSize6 * BigInt(cfg.priceImprovementTicks);
      desiredMakerPrice6 = improved < bestAsk6 ? improved : bestBid6;
      if (desiredMakerPrice6 >= bestAsk6) desiredMakerPrice6 = null; // cannot rest without crossing
    }
    push(
      "maker_price_available",
      desiredMakerPrice6 !== null,
      desiredMakerPrice6 === null ? "would cross" : (Number(desiredMakerPrice6) / 1e6).toFixed(3),
      "post-only price strictly below best ask",
    );
    if (desiredMakerPrice6 === null) ok = false;
  }

  return { candidate: ok && side !== null, side, checks, desiredMakerPrice6, conservativeProbability6: conservative6 };
}

function asProb6(v: number | null): Prob6 | null {
  return v === null ? null : BigInt(Math.round(v * 1_000_000));
}
