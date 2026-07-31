import type { Ppm, Prob6, Shares6, Usdc6 } from "./fixed";

export type OutcomeSide = "UP" | "DOWN";
export type OrderSide = "BUY" | "SELL";
export type Mode = "observe" | "paper" | "shadow" | "live";
export type ExecutionStyle = "maker_post_only" | "taker_fok" | "taker_fak";
export type TimeInForce = "GTC" | "GTD" | "FOK" | "FAK";

export type OrderStatus =
  | "PENDING" | "LIVE" | "PARTIAL" | "MATCHED" | "DELAYED"
  | "CANCELED" | "REJECTED" | "EXPIRED" | "RESOLVED";

export type ExitPolicy =
  | "hold_to_resolution"
  | "threshold_cross_invalidation"
  | "probability_vs_bid_exit"
  | "time_based_exit";

export interface MarketRef {
  marketId: string;        // internal id (= gamma market id)
  eventId: string;
  conditionId: string;
  slug: string;
  upTokenId: string;
  downTokenId: string;
  startEpoch: number;      // market window start (unix sec, 300-aligned)
  endEpoch: number;        // window end
}

export interface BookLevel {
  price: Prob6;
  size: Shares6;
}

export interface BookSnapshot {
  tokenId: string;
  bids: BookLevel[];  // sorted best (highest) first
  asks: BookLevel[];  // sorted best (lowest) first
  sourceTsMs: number;
  receivedTsMs: number;
  hash?: string;
}

export interface ReferenceTick {
  source: "chainlink" | "binance";
  symbol: string;
  value: number;              // display/feature value
  fullAccuracyValue?: string; // exact 18-dec string when provided
  sourceTsMs: number;
  receivedTsMs: number;
}

export interface ProbabilityEstimate {
  modelVersion: string;
  probability: Prob6;
  lowerBound: Prob6;
  upperBound: Prob6;
  calibrationBucket: string;
  uncertainty: number;
  dataQualityPenalty: number;
  featureAttributions: Record<string, number>;
  approvedForLive: boolean;
}

export interface FeeScheduleInfo {
  ratePpm: Ppm;
  takerOnly: boolean;
  rebateRatePpm: Ppm;
  collection: "usdc" | "shares";
  source: "market" | "default";
  feeType?: string;
}

/**
 * The immutable decision snapshot. Persisted BEFORE any simulated/shadow/live
 * order exists. Everything needed to reconstruct the decision must be here.
 */
export interface DecisionSnapshotData {
  decisionId: string;
  correlationId: string;
  mode: Mode;
  createdAtMs: number;
  market: MarketRef;
  rulesHash: string;
  resolutionSource: string;
  secondsRemaining: number;
  priceToBeat: { value: string; source: string; capturedAtMs: number } | null;
  chainlink: { value: string; sourceTsMs: number; ageMs: number } | null;
  binance: { value: string; sourceTsMs: number; ageMs: number } | null;
  distance: { usd: number; bps: number; z: number | null } | null;
  volatility: Record<string, number>;
  thresholdCrossings: { count120s: number; lastCrossAgoS: number | null };
  book: {
    up: { bestBid: string | null; bestAsk: string | null; spread: string | null; depthTop5: string; ageMs: number };
    down: { bestBid: string | null; bestAsk: string | null; spread: string | null; depthTop5: string; ageMs: number };
    microprice: number | null;
    imbalance: number | null;
  } | null;
  feeSchedule: { ratePpm: string; collection: string; rebateRatePpm: string; takerOnly: boolean };
  intent: {
    side: OutcomeSide;
    orderSide: OrderSide;
    style: ExecutionStyle;
    timeInForce: TimeInForce;
    price: string;
    sharesRequested: string;
    stake: string;
    maxLoss: string;
    exitPolicy: ExitPolicy;
  } | null;
  model: {
    version: string;
    probability: string;
    lowerBound: string;
    upperBound: string;
    conservative: string;
    uncertainty: number;
    dataQualityPenalty: number;
    attributions: Record<string, number>;
  } | null;
  marketProbability: string | null;
  effectiveBreakEven: string | null;
  evPerCostRaw: number | null;
  evPerCostAfterFriction: number | null;
  risk: {
    profile: string;
    limits: Record<string, string>;
    bankroll: string;
    stakeFraction: string;
    approved: boolean;
    reasons: Array<{ code: string; message: string }>;
    capChain: Array<{ name: string; capPpm: string }>;
    bindingCap: string | null;
  };
  targetReturnDisplay: { targetPpm: string; requiredStakeFraction: string; violatesCap: boolean } | null;
  feedHealth: Record<string, { ageMs: number | null; healthy: boolean }>;
  clockSkewMs: number | null;
  configVersion: number;
  engineVersion: string;
}

export interface RiskLimits {
  baseRiskFractionPpm: Ppm;
  maxRiskFractionPpm: Ppm;
  sessionLossLimitPpm: Ppm;
  dailyLossLimitPpm: Ppm;
  consecutiveLossLimit: number;
  maxOpenPositions: number;
  kellyMultiplierPpm: Ppm;
  livePriceCeiling: Prob6;
  liveEntryCutoffSeconds: number;
  paperEntryCutoffSeconds: number;
  minConservativeEdgePpm: Ppm;
  minExpectedValuePerCostPpm: Ppm;
  maxSpread: Prob6;
  maxPriceImpact: Prob6;
  liveAllowed: boolean;
}

export interface BankrollState {
  bankroll: Usdc6;
  sessionPeak: Usdc6;
  dailyPeak: Usdc6;
  sessionRealized: Usdc6;
  dailyRealized: Usdc6;
  consecutiveLosses: number;
  openPositions: number;
  openExposure: Usdc6;
  reconciled: boolean;
}
