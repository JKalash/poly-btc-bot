import {
  applyCapChain, breakEvenTaker, fractionalKelly, fullKellyMaker, fullKellyTaker,
  makerEdgeSatisfied, mulDiv, ONE, PPM, stakeFromFraction, takerEdgeSatisfied,
  type BankrollState, type CapResult, type ExecutionStyle, type FeeSchedule,
  type Mode, type Ppm, type Prob6, type RiskLimits, type Usdc6,
} from "@b5p/domain";

/**
 * Pure, deterministic risk evaluation. Receives the complete decision context,
 * returns APPROVE/REJECT with every failing reason (not just the first) so the
 * dashboard can answer "what would have to change?".
 */

export type RejectionCode =
  | "ENGINE_NOT_ARMED"
  | "CHAINLINK_STALE"
  | "BOOK_STALE"
  | "CLOCK_DRIFT_EXCEEDED"
  | "PRICE_TO_BEAT_UNKNOWN"
  | "PRICE_TO_BEAT_MISMATCH"
  | "RULES_UNVERIFIED"
  | "FEE_SCHEDULE_UNKNOWN"
  | "BANKROLL_UNRECONCILED"
  | "STAKE_EXCEEDS_CAP"
  | "SESSION_LOSS_STOP"
  | "DAILY_LOSS_STOP"
  | "CONSECUTIVE_LOSS_STOP"
  | "CONCURRENCY_LIMIT"
  | "PRICE_ABOVE_CEILING"
  | "PAST_ENTRY_CUTOFF"
  | "INSUFFICIENT_EDGE"
  | "SPREAD_TOO_WIDE"
  | "IMPACT_TOO_HIGH"
  | "POST_ONLY_WOULD_CROSS"
  | "DATA_QUALITY_LOW"
  | "MODEL_NOT_APPROVED"
  | "STRATEGY_UNVALIDATED"
  | "COOLING_OFF_ACTIVE"
  | "DUPLICATE_IDEMPOTENCY_KEY"
  | "TAKER_NOT_PERMITTED"
  | "STAKE_BELOW_MINIMUM"
  | "NO_EXECUTABLE_SIZE";

export interface Rejection {
  code: RejectionCode;
  message: string;
}

export interface RiskContext {
  mode: Mode;
  engineArmedForMode: boolean;
  limits: RiskLimits;
  profileName: string;
  bankroll: BankrollState;

  // data health
  chainlinkAgeMs: number | null;
  chainlinkMaxAgeMs: number;
  bookAgeMs: number | null;
  bookMaxAgeMs: number;
  clockSkewMs: number | null;
  clockMaxDriftMs: number;
  priceToBeatKnown: boolean;
  priceToBeatConsistent: boolean;
  rulesVerified: boolean;
  feeScheduleKnown: boolean;
  dataQualityScore: number; // 0..1
  minDataQuality: number;

  // order intent
  style: ExecutionStyle;
  takerPermittedByStrategy: boolean;
  price: Prob6;
  bestBidSameSide: Prob6 | null;
  bestAskSameSide: Prob6 | null;
  spread: Prob6 | null;
  estimatedImpact: Prob6 | null;
  secondsRemaining: number;

  // probabilities (conservative — never point estimates)
  conservativeProbability: Prob6;
  feeSchedule: Pick<FeeSchedule, "ratePpm" | "collection">;

  // model/strategy governance
  modelApprovedForMode: boolean;
  strategyValidatedForMode: boolean;
  coolingOffUntilMs: number | null;
  nowMs: number;
  idempotencyKeyIsDuplicate: boolean;

  // sizing request
  requestedStakeFractionPpm: Ppm | null; // null -> use base/kelly
  minOrderStake6: Usdc6;
}

export interface SizingResult {
  stake6: Usdc6;
  fractionPpm: Ppm;
  capResult: CapResult;
  kellyFullPpm: Ppm;
  kellyFractionalPpm: Ppm;
}

export interface RiskVerdict {
  approved: boolean;
  reasons: Rejection[];
  sizing: SizingResult | null;
}

const r = (code: RejectionCode, message: string): Rejection => ({ code, message });

export function computeSizing(ctx: RiskContext): SizingResult {
  const { limits, bankroll } = ctx;
  const kellyFull =
    ctx.style === "maker_post_only"
      ? fullKellyMaker(ctx.conservativeProbability, ctx.price)
      : fullKellyTaker(ctx.conservativeProbability, ctx.price, ctx.feeSchedule);
  const kellyFrac = fractionalKelly(kellyFull, limits.kellyMultiplierPpm);

  // Requested fraction: explicit request, else min(base, fractional kelly).
  // Kelly can only shrink below base — never inflate above profile base sizing.
  const base = limits.baseRiskFractionPpm;
  const requested = ctx.requestedStakeFractionPpm ?? (kellyFrac < base ? kellyFrac : base);

  const sessionLossSoFar = ctx.bankroll.sessionPeak - ctx.bankroll.bankroll;
  const sessionBudget6 = stakeFromFraction(bankroll.sessionPeak, limits.sessionLossLimitPpm) - sessionLossSoFar;
  const dailyLossSoFar = ctx.bankroll.dailyPeak - ctx.bankroll.bankroll;
  const dailyBudget6 = stakeFromFraction(bankroll.dailyPeak, limits.dailyLossLimitPpm) - dailyLossSoFar;

  const toFraction = (amount6: Usdc6): Ppm =>
    bankroll.bankroll > 0n ? mulDiv(amount6 < 0n ? 0n : amount6, PPM, bankroll.bankroll, "floor") : 0n;

  const capResult = applyCapChain(requested, [
    { name: "profile_max_per_market", capPpm: limits.maxRiskFractionPpm },
    { name: "session_remaining_budget", capPpm: toFraction(sessionBudget6) },
    { name: "daily_remaining_budget", capPpm: toFraction(dailyBudget6) },
    { name: "available_balance", capPpm: toFraction(bankroll.bankroll - bankroll.openExposure) },
  ]);

  return {
    stake6: stakeFromFraction(bankroll.bankroll, capResult.finalPpm),
    fractionPpm: capResult.finalPpm,
    capResult,
    kellyFullPpm: kellyFull,
    kellyFractionalPpm: kellyFrac,
  };
}

export function evaluateOrderRisk(ctx: RiskContext): RiskVerdict {
  const reasons: Rejection[] = [];
  const L = ctx.limits;

  if (!ctx.engineArmedForMode) {
    reasons.push(r("ENGINE_NOT_ARMED", `Engine is not armed for ${ctx.mode} order flow.`));
  }
  if (ctx.mode === "live" && !L.liveAllowed) {
    reasons.push(r("ENGINE_NOT_ARMED", `Profile ${ctx.profileName} does not permit live trading.`));
  }
  if (ctx.chainlinkAgeMs === null || ctx.chainlinkAgeMs > ctx.chainlinkMaxAgeMs) {
    reasons.push(r("CHAINLINK_STALE", `Authoritative Chainlink feed is stale (age ${ctx.chainlinkAgeMs ?? "unknown"}ms > ${ctx.chainlinkMaxAgeMs}ms).`));
  }
  if (ctx.bookAgeMs === null || ctx.bookAgeMs > ctx.bookMaxAgeMs) {
    reasons.push(r("BOOK_STALE", `Order book is stale (age ${ctx.bookAgeMs ?? "unknown"}ms > ${ctx.bookMaxAgeMs}ms).`));
  }
  if (ctx.clockSkewMs === null || Math.abs(ctx.clockSkewMs) > ctx.clockMaxDriftMs) {
    reasons.push(r("CLOCK_DRIFT_EXCEEDED", `System clock drift ${ctx.clockSkewMs ?? "unknown"}ms exceeds tolerance ${ctx.clockMaxDriftMs}ms.`));
  }
  if (!ctx.priceToBeatKnown) {
    reasons.push(r("PRICE_TO_BEAT_UNKNOWN", "The Chainlink price-to-beat was not captured; this decision cannot be audited."));
  } else if (!ctx.priceToBeatConsistent) {
    reasons.push(r("PRICE_TO_BEAT_MISMATCH", "Official price-to-beat representations disagree beyond tolerance."));
  }
  if (!ctx.rulesVerified) {
    reasons.push(r("RULES_UNVERIFIED", "Market rules/resolution source have not been verified to name the Chainlink stream."));
  }
  if (!ctx.feeScheduleKnown) {
    reasons.push(r("FEE_SCHEDULE_UNKNOWN", "The market's fee schedule is unknown; refusing to price a trade."));
  }
  if (!ctx.bankroll.reconciled) {
    reasons.push(r("BANKROLL_UNRECONCILED", "Bankroll reconciliation is incomplete."));
  }
  if (ctx.bankroll.openPositions >= L.maxOpenPositions) {
    reasons.push(r("CONCURRENCY_LIMIT", `Already ${ctx.bankroll.openPositions} open position(s); limit is ${L.maxOpenPositions}.`));
  }
  if (ctx.bankroll.consecutiveLosses >= L.consecutiveLossLimit) {
    reasons.push(r("CONSECUTIVE_LOSS_STOP", `Consecutive-loss stop reached (${ctx.bankroll.consecutiveLosses}/${L.consecutiveLossLimit}). Manual re-arm required.`));
  }

  const sessionLoss = ctx.bankroll.sessionPeak - ctx.bankroll.bankroll;
  if (ctx.bankroll.sessionPeak > 0n && sessionLoss * PPM >= L.sessionLossLimitPpm * ctx.bankroll.sessionPeak) {
    reasons.push(r("SESSION_LOSS_STOP", "Session loss stop reached."));
  }
  const dailyLoss = ctx.bankroll.dailyPeak - ctx.bankroll.bankroll;
  if (ctx.bankroll.dailyPeak > 0n && dailyLoss * PPM >= L.dailyLossLimitPpm * ctx.bankroll.dailyPeak) {
    reasons.push(r("DAILY_LOSS_STOP", "Daily loss stop reached."));
  }

  const ceiling = ctx.mode === "live" ? L.livePriceCeiling : ONE;
  if (ctx.price > ceiling) {
    reasons.push(r("PRICE_ABOVE_CEILING", `Requested price exceeds the configured ceiling for ${ctx.mode}.`));
  }
  const cutoff = ctx.mode === "live" || ctx.mode === "shadow" ? L.liveEntryCutoffSeconds : L.paperEntryCutoffSeconds;
  if (ctx.secondsRemaining < cutoff) {
    reasons.push(r("PAST_ENTRY_CUTOFF", `Only ${ctx.secondsRemaining}s remaining; entries are cut off under ${cutoff}s.`));
  }

  if (ctx.style !== "maker_post_only" && !ctx.takerPermittedByStrategy) {
    reasons.push(r("TAKER_NOT_PERMITTED", "Taker execution is not permitted by the active strategy/config."));
  }

  const edgeOk =
    ctx.style === "maker_post_only"
      ? makerEdgeSatisfied(ctx.conservativeProbability, ctx.price, L.minConservativeEdgePpm)
      : takerEdgeSatisfied(ctx.conservativeProbability, ctx.price, ctx.feeSchedule, L.minConservativeEdgePpm);
  if (!edgeOk) {
    const be = ctx.style === "maker_post_only" ? ctx.price : breakEvenTaker(ctx.price, ctx.feeSchedule);
    reasons.push(r("INSUFFICIENT_EDGE",
      `No verified edge: conservative probability does not exceed effective break-even (${fmtP(be)}) plus minimum edge.`));
  }

  if (ctx.spread === null || ctx.spread > L.maxSpread) {
    reasons.push(r("SPREAD_TOO_WIDE", `Spread ${ctx.spread === null ? "unknown" : fmtP(ctx.spread)} exceeds tolerance ${fmtP(L.maxSpread)}.`));
  }
  if (ctx.estimatedImpact !== null && ctx.estimatedImpact > L.maxPriceImpact) {
    reasons.push(r("IMPACT_TOO_HIGH", `Estimated impact ${fmtP(ctx.estimatedImpact)} exceeds tolerance ${fmtP(L.maxPriceImpact)}.`));
  }
  if (ctx.style === "maker_post_only" && ctx.bestAskSameSide !== null && ctx.price >= ctx.bestAskSameSide) {
    reasons.push(r("POST_ONLY_WOULD_CROSS", "Post-only maker order would cross the book; rejected safely (never converted to taker)."));
  }
  if (ctx.dataQualityScore < ctx.minDataQuality) {
    reasons.push(r("DATA_QUALITY_LOW", `Data-quality score ${ctx.dataQualityScore.toFixed(2)} below threshold ${ctx.minDataQuality.toFixed(2)}.`));
  }
  if (!ctx.modelApprovedForMode) {
    reasons.push(r("MODEL_NOT_APPROVED", `Model version is not approved for ${ctx.mode} use.`));
  }
  if (!ctx.strategyValidatedForMode) {
    reasons.push(r("STRATEGY_UNVALIDATED", `Strategy lacks required validation for ${ctx.mode} (walk-forward / shadow requirements).`));
  }
  if (ctx.coolingOffUntilMs !== null && ctx.nowMs < ctx.coolingOffUntilMs) {
    reasons.push(r("COOLING_OFF_ACTIVE", "Operator cooling-off timer is active."));
  }
  if (ctx.idempotencyKeyIsDuplicate) {
    reasons.push(r("DUPLICATE_IDEMPOTENCY_KEY", "Duplicate decision/order idempotency key."));
  }

  const sizing = computeSizing(ctx);
  if (ctx.requestedStakeFractionPpm !== null && ctx.requestedStakeFractionPpm > L.maxRiskFractionPpm) {
    reasons.push(r("STAKE_EXCEEDS_CAP",
      `Requested stake fraction ${fmtP(ctx.requestedStakeFractionPpm)} exceeds the profile cap ${fmtP(L.maxRiskFractionPpm)}.`));
  }
  if (reasons.length === 0 && sizing.stake6 < ctx.minOrderStake6) {
    reasons.push(r("STAKE_BELOW_MINIMUM", "Capped stake is below the market's minimum order size."));
  }
  if (reasons.length === 0 && sizing.stake6 <= 0n) {
    reasons.push(r("NO_EXECUTABLE_SIZE", "No executable size remains after applying caps."));
  }

  return { approved: reasons.length === 0, reasons, sizing };
}

function fmtP(v: bigint): string {
  const s = (Number(v) / 1_000_000).toFixed(4);
  return s.replace(/0+$/, "").replace(/\.$/, "");
}
