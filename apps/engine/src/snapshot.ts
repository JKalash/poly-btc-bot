import type { AppConfig } from "@b5p/config";
import {
  breakEvenTaker, fmtProb, fmtShares, fmtUsdc, lossErasesWins, makerEvPerCost,
  takerEvPerCost, targetReturnStakeFraction, toNumber, type DecisionSnapshotData,
  type ExecutionStyle, type ExitPolicy, type MarketRef, type Mode, type OutcomeSide,
  type Ppm, type Prob6, type ProbabilityEstimate, type Shares6, type Usdc6,
} from "@b5p/domain";
import type { RiskVerdict } from "@b5p/risk";
import type { FeatureSet, StrategyDecision } from "@b5p/strategy";

export const ENGINE_VERSION = "b5p-engine/0.1.0";

/** Assemble the immutable decision snapshot. Everything here is JSON-safe strings/numbers. */
export function buildDecisionSnapshot(args: {
  decisionId: string;
  correlationId: string;
  mode: Mode;
  nowMs: number;
  market: MarketRef;
  rulesHash: string;
  resolutionSource: string;
  priceToBeat: { text: string; capturedAtMs: number; source: string } | null;
  features: FeatureSet;
  gate: StrategyDecision;
  estimate: ProbabilityEstimate | null;
  conservative6: Prob6 | null;
  side: OutcomeSide;
  style: ExecutionStyle;
  price6: Prob6;
  shares6: Shares6;
  stake6: Usdc6;
  bankroll6: Usdc6;
  feeRatePpm: Ppm;
  feeRebatePpm: Ppm;
  feeCollection: "usdc" | "shares";
  verdict: RiskVerdict;
  modelCalibrated: boolean;
  profileName: string;
  limits: Record<string, string>;
  cfg: AppConfig;
  configVersion: number;
  clockSkewMs: number | null;
  exitPolicy: string;
  feedHealth: Record<string, { ageMs: number | null; healthy: boolean }>;
}): DecisionSnapshotData {
  const f = args.features;
  const sched = { ratePpm: args.feeRatePpm, collection: args.feeCollection };
  const isMaker = args.style === "maker_post_only";
  const be = isMaker ? args.price6 : breakEvenTaker(args.price6, sched);
  const q = args.conservative6;
  const evRaw = q === null ? null : isMaker ? makerEvPerCost(q, args.price6) : takerEvPerCost(q, args.price6, sched);
  const stakeFraction = args.bankroll6 > 0n ? Number(args.stake6) / Number(args.bankroll6) : 0;
  const target = targetReturnStakeFraction(10_000n, args.price6); // 1% display

  return {
    decisionId: args.decisionId,
    correlationId: args.correlationId,
    mode: args.mode,
    createdAtMs: args.nowMs,
    market: args.market,
    rulesHash: args.rulesHash,
    resolutionSource: args.resolutionSource,
    secondsRemaining: f.secondsRemaining,
    priceToBeat: args.priceToBeat
      ? { value: args.priceToBeat.text, source: args.priceToBeat.source, capturedAtMs: args.priceToBeat.capturedAtMs }
      : null,
    chainlink: f.chainlinkNow !== null
      ? { value: String(f.chainlinkNow), sourceTsMs: f.tsMs - (f.chainlinkAgeMs ?? 0), ageMs: f.chainlinkAgeMs ?? -1 }
      : null,
    binance: f.binanceNow !== null
      ? { value: String(f.binanceNow), sourceTsMs: f.tsMs - (f.binanceAgeMs ?? 0), ageMs: f.binanceAgeMs ?? -1 }
      : null,
    distance: f.distanceUsd !== null
      ? { usd: f.distanceUsd, bps: f.distanceBps ?? 0, z: f.distanceZ }
      : null,
    volatility: {
      ...Object.fromEntries(Object.entries(f.realizedVolBps).map(([k, v]) => [`realized_${k}`, v ?? -1])),
      ewmaBpsPerSqrtSec: f.ewmaVolBpsPerSqrtSec ?? -1,
      estRemainingMoveStdBps: f.estRemainingMoveStdBps ?? -1,
    },
    thresholdCrossings: {
      count120s: f.crossings120s,
      lastCrossAgoS: f.lastCrossAgoMs === null ? null : Math.round(f.lastCrossAgoMs / 1000),
    },
    book: {
      up: {
        bestBid: f.upBestBid?.toFixed(3) ?? null,
        bestAsk: f.upBestAsk?.toFixed(3) ?? null,
        spread: f.upSpread?.toFixed(3) ?? null,
        depthTop5: `${Math.round(f.upDepthBidTop5 ?? 0)}/${Math.round(f.upDepthAskTop5 ?? 0)}`,
        ageMs: f.bookAgeMs ?? -1,
      },
      down: {
        bestBid: f.downBestBid?.toFixed(3) ?? null,
        bestAsk: f.downBestAsk?.toFixed(3) ?? null,
        spread: f.downBestBid !== null && f.downBestAsk !== null ? (f.downBestAsk - f.downBestBid).toFixed(3) : null,
        depthTop5: "-",
        ageMs: f.bookAgeMs ?? -1,
      },
      microprice: f.upMicroprice,
      imbalance: f.upImbalanceTop5,
    },
    feeSchedule: {
      ratePpm: args.feeRatePpm.toString(),
      collection: args.feeCollection,
      rebateRatePpm: args.feeRebatePpm.toString(),
      takerOnly: true,
    },
    intent: {
      side: args.side,
      orderSide: "BUY",
      style: args.style,
      timeInForce: isMaker ? "GTD" : "FAK",
      price: fmtProb(args.price6),
      sharesRequested: fmtShares(args.shares6),
      stake: fmtUsdc(args.stake6),
      maxLoss: fmtUsdc(args.stake6),
      exitPolicy: args.exitPolicy as ExitPolicy,
    },
    model: args.estimate
      ? {
          version: args.estimate.modelVersion,
          probability: fmtProb(args.estimate.probability),
          lowerBound: fmtProb(args.estimate.lowerBound),
          upperBound: fmtProb(args.estimate.upperBound),
          conservative: q === null ? "0" : fmtProb(q),
          uncertainty: args.estimate.uncertainty,
          dataQualityPenalty: args.estimate.dataQualityPenalty,
          attributions: args.estimate.featureAttributions,
          calibrated: args.modelCalibrated,
          calibrationRequired: args.cfg.strategy.calibration_required,
        }
      : null,
    marketProbability: f.upMid === null ? null : f.upMid.toFixed(4),
    effectiveBreakEven: fmtProb(be),
    evPerCostRaw: evRaw,
    evPerCostAfterFriction: evRaw, // friction already inside conservative q + fee-adjusted BE
    risk: {
      profile: args.profileName,
      limits: args.limits,
      bankroll: fmtUsdc(args.bankroll6),
      stakeFraction: stakeFraction.toFixed(6),
      approved: args.verdict.approved,
      reasons: args.verdict.reasons.map((r) => ({ code: r.code, message: r.message })),
      capChain: (args.verdict.sizing?.capResult.caps ?? []).map((c) => ({ name: c.name, capPpm: c.capPpm.toString() })),
      bindingCap: args.verdict.sizing?.capResult.binding ?? null,
    },
    targetReturnDisplay: {
      targetPpm: "10000",
      requiredStakeFraction: toNumber(target).toFixed(4),
      violatesCap: target > (args.verdict.sizing?.capResult.caps.find((c) => c.name === "profile_max_per_market")?.capPpm ?? 100_000n),
    },
    feedHealth: args.feedHealth,
    clockSkewMs: args.clockSkewMs,
    configVersion: args.configVersion,
    engineVersion: ENGINE_VERSION,
  };
}

/** Human line used in UX copy: "A loss at this price erases approximately N wins." */
export function lossErasesWinsLine(price6: Prob6): string {
  const n = lossErasesWins(price6);
  return `A loss at ${fmtProb(price6)} erases approximately ${Number.isFinite(n) ? n.toFixed(1) : "∞"} wins of equal stake.`;
}
