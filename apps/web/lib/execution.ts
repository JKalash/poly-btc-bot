"use client";

/**
 * Shared response types + display constants for the Execution Lab and
 * Strategy Comparison pages. These mirror the read-only routes in
 * apps/api/src/server.ts. Every *6 field is a bigint micro-unit serialized as
 * a decimal string — keep it exact until the last formatting step.
 */

// ---------- execution timeline (mirrors @b5p/domain execution.ts) ----------

/** Canonical forward path used to order the signal-to-fill funnel. */
export const FUNNEL_ORDER = [
  "DECISION_SNAPSHOT",
  "INTENT_CREATED",
  "RISK_APPROVED",
  "SIGN_STARTED",
  "SENT",
  "EXCHANGE_ACK",
  "RESTING",
  "PARTIAL_FILL",
  "FILLED",
] as const;

/** Terminal / side states shown separately from the funnel path. */
export const SIDE_STATES = [
  "REJECTED",
  "CANCEL_REQUESTED",
  "CANCEL_CONFIRMED",
  "UNKNOWN_OUTCOME",
  "BALANCE_RECONCILED",
] as const;

/** Latency stages that form the cumulative send path (order matters). */
export const LATENCY_PATH_STAGES = ["SIGN", "SEND", "ACK"] as const;
/** Independent stages (not part of the cumulative send path). */
export const LATENCY_OTHER_STAGES = ["CANCEL", "BOOK_FEED"] as const;

/** markout_observations.horizon_ms values in display order. */
export const HORIZON_ORDER = ["250", "1000", "2000", "5000", "10000", "30000", "AT_RESOLUTION"] as const;
export const HORIZON_LABEL: Record<string, string> = {
  "250": "250ms", "1000": "1s", "2000": "2s", "5000": "5s",
  "10000": "10s", "30000": "30s", AT_RESOLUTION: "resolution",
};

export const PAPER_VARIANTS = ["OPTIMISTIC_TOUCH", "QUEUE_REPLAY", "CONSERVATIVE_STRESS"] as const;
export type PaperVariant = (typeof PAPER_VARIANTS)[number];
export const VARIANT_NOTES: Record<PaperVariant, string> = {
  OPTIMISTIC_TOUCH: "Fill assumed the moment the book touches our price. Upper bound — real queues fill later or never.",
  QUEUE_REPLAY: "Fill only after the simulated queue ahead of us is consumed. This is the default paper path (pnl_records).",
  CONSERVATIVE_STRESS: "Adverse assumptions: delayed fills, worst-case queue. Lower bound on paper performance.",
};

// ---------- API payloads ----------

export interface TimelineEventRow {
  id: string;
  state: string;
  tsMs: number;
  attemptId: string | null;
  detail: Record<string, unknown> | null;
}

export interface AttemptRow {
  id: string;
  attemptNumber: number;
  side: string;
  price6: string;
  size6: string;
  remaining6: string;
  timeInForce: string;
  postOnly: boolean;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface IntentTimeline {
  intentId: string;
  correlationId: string;
  mode: string;
  firstTsMs: number;
  lastTsMs: number;
  lastState: string;
  events: TimelineEventRow[];
  attempts: AttemptRow[];
}

export interface TimelinesPayload { intents: IntentTimeline[]; note?: string }

export interface FunnelPayload {
  /** Distinct intents that reached each state (an intent counts once per state). */
  states: Array<{ state: string; intents: number }>;
  totalIntents: number;
  note?: string;
}

export interface LatencyPayload {
  stages: Array<{ stage: string; n: number; p50Us: number; p90Us: number; p99Us: number; maxUs: number }>;
  note?: string;
}

export interface MarkoutPayload {
  horizons: Array<{ horizonMs: string; n: number; sumMarkout6: string; medianMarkout6: string | null; adverseCount: number }>;
  note?: string;
}

export interface PaperVariantRow {
  variant: string;
  decisions: number;
  filledCount: number;
  resolved: number;
  wins: number;
  net6: string;
  fees6: string;
  /** net + fees of resolved rows (assumes pnl6 is net of fees, like pnl_records.net6). */
  gross6: string;
  avgFillPrice6: string | null;
  maxDrawdown6: string;
  longestLossStreak: number;
}

export interface PaperVariantsPayload { variants: PaperVariantRow[]; note?: string }

export interface QueuePayload {
  methods: Array<{ method: string; n: number; avgAhead6: string | null; medianAhead6: string | null }>;
  counterfactuals: {
    n: number;
    wouldFill: number;
    reasons: Array<{ reason: string; n: number; wouldFill: number }>;
  };
  note?: string;
}

export interface FillQualityPayload {
  orders: { total: number; full: number; partial: number; none: number };
  quoted: { avgQuoted6: string | null; avgFilled6: string | null; slippagePerShare6: string | null };
  makerTaker: { makerFills: number; takerFills: number; makerShares6: string; takerShares6: string };
  cancelRaces: { requested: number; lostToFill: number };
  note?: string;
}

export interface PromotionEvidenceSummary {
  brier: number | null;
  logLoss: number | null;
  ece: number | null;
  n: number | null;
  folds: number | null;
  purged: boolean | null;
  netEvPerCost: { mean: number; ciLo: number; ciHi: number; n: number } | null;
  frictions: { feesIncluded: boolean; spreadIncluded: boolean; latencyIncluded: boolean; adverseSelectionIncluded: boolean } | null;
}

export interface StrategyRow {
  strategyVersion: string;
  candidates: { total: number; approved: number };
  orders: { placed: number; filled: number };
  fills: { count: number; shares6: string; avgPrice6: string | null; slippagePerShare6: string | null };
  outcomes: {
    resolved: number;
    wins: number;
    net6: string;
    gross6: string;
    fees6: string;
    maxDrawdown6: string;
    longestLossStreak: number;
    /** Realized per-trade net CI (normal approx), micro-USDC. Null when resolved < 2. */
    ci6: { lo: string; hi: string } | null;
  } | null;
  /** Avg 30s post-fill markout, micro-price per share (negative = adverse). */
  adverse: { n: number; avgMarkout30s6: string } | null;
  evidence: PromotionEvidenceSummary | null;
  calibration: { method: string; brier: number; logLoss: number; ece: number; n: number } | null;
  promotion: {
    status: "PROMOTED" | "NOT_PROMOTED" | "NO_DECISION";
    reasons: string[];
    mode: string | null;
    decidedAtMs: number | null;
    active: boolean;
  };
}

export interface FillSelectionCost {
  signalConditionedValue6: string;
  fillConditionedValue6: string;
  cost6: string;
  signalSampleCount: number;
  fillSampleCount: number;
  windowStartMs: number;
  windowEndMs: number;
}

export interface StrategyComparisonPayload {
  strategies: StrategyRow[];
  /** Portfolio-level (not per-strategy): latest signal-vs-fill conditioning window. */
  fillSelectionCost: FillSelectionCost | null;
  notes?: string[];
}

// ---------- formatting (edge only) ----------

/** Signed micro-USDC → "+1.23" / "-0.45". */
export const signed6 = (v: string | null | undefined, dp = 2): string => {
  if (v === null || v === undefined) return "—";
  const n = Number(v) / 1e6;
  return `${n > 0 ? "+" : ""}${n.toFixed(dp)}`;
};

/** Micro-price (0..1e6) → cents-of-probability, e.g. "42.1¢". */
export const cents6 = (v: string | null | undefined, dp = 1): string => {
  if (v === null || v === undefined) return "—";
  return `${((Number(v) / 1e6) * 100).toFixed(dp)}¢`;
};

/** Signed micro-price per share → signed cents, e.g. "-0.32¢". */
export const signedCents6 = (v: string | null | undefined, dp = 2): string => {
  if (v === null || v === undefined) return "—";
  const c = (Number(v) / 1e6) * 100;
  return `${c > 0 ? "+" : ""}${c.toFixed(dp)}¢`;
};

export const pct = (num: number, den: number, dp = 1): string =>
  den > 0 ? `${((num / den) * 100).toFixed(dp)}%` : "—";

export const usFmt = (us: number): string =>
  us >= 1_000_000 ? `${(us / 1_000_000).toFixed(2)}s` : us >= 1000 ? `${(us / 1000).toFixed(1)}ms` : `${Math.round(us)}µs`;

export const shortId = (id: string): string => (id.length > 10 ? `${id.slice(0, 8)}…` : id);
