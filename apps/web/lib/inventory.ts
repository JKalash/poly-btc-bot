"use client";

/**
 * Shared response types + display metadata for the Inventory Lab page. These
 * mirror the read-only /api/inventory/* routes in apps/api/src/server.ts and
 * the R10 state machines in packages/domain/src/inventory.ts. Every *6 field
 * is a bigint micro-unit serialized as a decimal string — keep it exact until
 * the last formatting step.
 *
 * The page's hard rules (refinement brief):
 *  - A split position is not risk-free while a leg is open. Only the API's
 *    `riskFree` flag (domain isRiskFree: RECONCILED + all legs closed) may
 *    ever be rendered as risk-free.
 *  - Rewards are revenue only when paid. The two accrual ledgers are separate
 *    programs and are never merged; unpaid accruals never count toward EV.
 */

// ---------- R10 state machine display order (mirrors @b5p/domain inventory) ----------

/** The brief's required ten-state main path, in machine order. */
export const CYCLE_MAIN_PATH = [
  "PLANNED",
  "INVENTORY_PREFLIGHT",
  "SPLIT_PENDING",
  "INVENTORY_READY",
  "QUOTING_BOTH",
  "ONE_LEG_FILLED",
  "HEDGE_OR_CANCEL",
  "BOTH_LEGS_FILLED",
  "MERGE_OR_SETTLE",
  "RECONCILED",
] as const;

/** Cycle-level side states (the brief's remaining two, PARTIAL_LEG and UNHEDGED, are leg states). */
export const CYCLE_SIDE_STATES = [
  "ALLOWANCE_BLOCKED",
  "MERGE_PENDING",
  "REWARD_PENDING",
  "HALTED",
  "FAILED_RECONCILIATION",
] as const;

export const LEG_STATES = ["PLANNED", "QUOTED", "PARTIAL_LEG", "UNHEDGED", "HEDGED", "CANCELED", "SETTLED"] as const;
/** The brief's leg-shaped side states — open directional exposure lives here. */
export const LEG_SIDE_STATES = ["PARTIAL_LEG", "UNHEDGED"] as const;

/** Leg states with no resting order and no unhedged exposure remaining. */
export const CLOSED_LEG_STATES: ReadonlySet<string> = new Set(["HEDGED", "CANCELED", "SETTLED"]);

export const ACCRUAL_STATE_ORDER = ["EXPECTED", "ACCRUED", "PENDING", "PAID", "DISPUTED"] as const;

export const CTF_OP_KINDS = ["SPLIT", "MERGE", "REDEEM"] as const;

/** States that mean a cycle currently carries (or is resolving) one-leg directional exposure. */
export const EXPOSED_CYCLE_STATES: ReadonlySet<string> = new Set(["ONE_LEG_FILLED", "HEDGE_OR_CANCEL", "HALTED"]);

// ---------- badge tones (status colors carry state, never color alone) ----------

export const CYCLE_STATE_CLS: Record<string, string> = {
  RECONCILED: "bg-good/15 text-good border-good/40",
  ONE_LEG_FILLED: "bg-warning/15 text-warning border-warning/50",
  HEDGE_OR_CANCEL: "bg-warning/15 text-warning border-warning/50",
  HALTED: "bg-critical/15 text-critical border-critical/50",
  FAILED_RECONCILIATION: "bg-critical/15 text-critical border-critical/50",
  ALLOWANCE_BLOCKED: "bg-serious/15 text-serious border-serious/50",
};

export const LEG_STATE_CLS: Record<string, string> = {
  UNHEDGED: "bg-critical/15 text-critical border-critical/50",
  PARTIAL_LEG: "bg-warning/15 text-warning border-warning/50",
  HEDGED: "bg-good/15 text-good border-good/40",
  SETTLED: "bg-good/15 text-good border-good/40",
};

export const ACCRUAL_STATE_CLS: Record<string, string> = {
  PAID: "bg-good/15 text-good border-good/40",
  DISPUTED: "bg-serious/20 text-serious border-serious/60",
  PENDING: "bg-up/15 text-up border-up/40",
};

export const OP_STATE_CLS: Record<string, string> = {
  CONFIRMED: "bg-good/15 text-good border-good/40",
  PARTIALLY_CONFIRMED: "bg-warning/15 text-warning border-warning/50",
  FAILED: "bg-critical/15 text-critical border-critical/50",
  UNKNOWN: "bg-critical/25 text-critical border-critical/70",
};

// ---------- API payloads ----------

export interface CycleLegRow {
  id: string;
  correlationId: string;
  cycleId: string;
  marketId: string;
  tokenId: string;
  outcomeSide: string;
  orderSide: string;
  state: string;
  price6: string;
  size6: string;
  filledShares6: string;
  avgFillPrice6: string | null;
  feeUsdc6: string | null;
  attemptId: string | null;
  quotedAtMs: number | null;
  firstFillAtMs: number | null;
  unhedgedStartedAtMs: number | null;
  hedgedAtMs: number | null;
  closedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  configVersion: number;
}

export interface HedgeActionRow {
  id: string;
  correlationId: string;
  cycleId: string;
  legId: string | null;
  marketId: string;
  tokenId: string | null;
  kind: string;
  state: string;
  mode: string;
  targetShares6: string;
  executedShares6: string | null;
  expectedCost6: string | null;
  actualCost6: string | null;
  feeUsdc6: string | null;
  attemptId: string | null;
  unhedgedDurationMs: number | null;
  decidedAtMs: number;
  executedAtMs: number | null;
  updatedAtMs: number;
  configVersion: number;
}

export interface CtfOperationRow {
  id: string;
  correlationId: string;
  cycleId: string | null;
  marketId: string;
  conditionId: string;
  kind: string;
  state: string;
  mode: string;
  requestedAmount6: string;
  confirmedAmount6: string | null;
  collateralDelta6: string | null;
  estGasUsdc6: string | null;
  actualGasUsdc6: string | null;
  relayed: boolean;
  txHash: string | null;
  failureReason: string | null;
  createdAtMs: number;
  submittedAtMs: number | null;
  confirmedAtMs: number | null;
  updatedAtMs: number;
  configVersion: number;
}

export interface CycleRow {
  id: string;
  correlationId: string;
  marketId: string;
  mode: string;
  kind: string;
  state: string;
  targetPairPrice6: string;
  collateralCommitted6: string;
  worstCaseLoss6: string;
  splitOperationId: string | null;
  mergeOperationId: string | null;
  oneLegFilledAtMs: number | null;
  hedgeCompletedAtMs: number | null;
  unhedgedDurationMs: number | null;
  spreadCaptured6: string | null;
  fees6: string | null;
  realizedPnl6: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  reconciledAtMs: number | null;
  configVersion: number;
  /** Domain isRiskFree: RECONCILED + every leg closed. NOTHING else is risk-free. */
  riskFree: boolean;
  legs: CycleLegRow[];
  hedgeActions: HedgeActionRow[];
  ctfOperations: CtfOperationRow[];
}

export interface CyclesPayload {
  cycles: CycleRow[];
  states: string[];
  legStates: string[];
  notes: string[];
  note?: string;
}

export interface SummaryPayload {
  cycles: {
    total: number;
    byState: Array<{ state: string; n: number }>;
    /** Cycles that EVER had exactly one leg filled (incidence, not current state). */
    oneLegFilled: number;
    hedgeCompleted: number;
  };
  legs: { byState: Array<{ state: string; n: number }> };
  hedges: { byKind: Array<{ kind: string; n: number; done: number; failed: number }> };
  operations: {
    byKind: Array<{
      kind: string; n: number; confirmed: number; partiallyConfirmed: number;
      failed: number; unknown: number; estGas6: string; actualGas6: string;
    }>;
    unknownOutcomes: number;
    estGas6: string;
    actualGas6: string;
    recent: CtfOperationRow[];
  };
  worstCaseLoss: {
    open: { n: number; sum6: string; max6: string };
    all: { n: number; sum6: string; max6: string };
  };
  unhedged: { n: number; maxMs: number | null; avgMs: number | null; overCapCount: number; capMs: number };
  notes: string[];
  note?: string;
}

export interface AccrualLedger {
  program: "MAKER_REBATE" | "LIQUIDITY_REWARD";
  byState: Array<{ state: string; n: number; amount6: string }>;
  /** PAID rows only; paid6 sums paid_amount6, never the amount6 estimate. */
  realized: { n: number; paid6: string };
  /** Non-PAID rows; estimates only — never revenue, never EV. */
  unrealized: { n: number; amount6: string };
  /** Rows violating the realized ⇔ PAID invariant (should always be 0). */
  inconsistentRows: number;
}

export interface AccrualsPayload {
  makerRebate: AccrualLedger;
  liquidityReward: AccrualLedger;
  states: string[];
  notes: string[];
  note?: string;
}

export interface SnapshotRow {
  id: string;
  correlationId: string;
  marketId: string;
  mode: string;
  upShares6: string;
  downShares6: string;
  pairedShares6: string;
  unpairedUpShares6: string;
  unpairedDownShares6: string;
  reservedUpShares6: string;
  reservedDownShares6: string;
  collateralFree6: string | null;
  exchangeUpShares6: string | null;
  exchangeDownShares6: string | null;
  onchainUpShares6: string | null;
  onchainDownShares6: string | null;
  reconciled: boolean;
  divergence: Record<string, unknown> | null;
  tsMs: number;
  configVersion: number;
}

export interface SnapshotsPayload {
  snapshots: SnapshotRow[];
  totals: { n: number; mismatches: number };
  note?: string;
}

export interface BasisPair {
  symbol: string;
  baseSource: string;
  refSource: string;
  estimates: number;
  samples: number;
  meanPpmAvg: number;
  meanPpmMin: number;
  meanPpmMax: number;
  stdPpmAvg: number;
  latest: {
    meanPpm: number;
    medianPpm: number | null;
    stdPpm: number;
    madPpm: number | null;
    clockOffsetMs: number | null;
    leadLagMs: number | null;
    regime: string | null;
    method: string;
    sampleCount: number;
    windowStartMs: number;
    windowEndMs: number;
    tsMs: number;
  };
}

export interface BoundaryObservationRow {
  id: string;
  correlationId: string;
  marketId: string | null;
  symbol: string;
  boundaryKind: string;
  boundaryEpoch: number;
  valueText: string;
  valueFloat: number;
  source: string;
  sourceTsMs: number;
  receivedTsMs: number;
  sequence: string | null;
  firstAtOrAfterBoundary: boolean;
  officialValueText: string | null;
  matchesOfficial: boolean | null;
  configVersion: number;
}

export interface BasisPayload {
  basis: { pairs: BasisPair[] };
  boundary: {
    byKind: Array<{ kind: string; n: number; matched: number; mismatched: number; unchecked: number; late: number }>;
    totals: { n: number; matched: number; mismatched: number; unchecked: number; lateCaptures: number };
    recent: BoundaryObservationRow[];
  };
  notes: string[];
  note?: string;
}

// ---------- shared copy ----------

export const SIM_OFF_NOTE =
  "Inventory simulation is off by default; paper/shadow only — no live market-making adapter exists.";

// ---------- formatting (edge only) ----------

/** Milliseconds → compact display, e.g. "742ms" / "2.4s". */
export const msFmt = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined) return "—";
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
};

/** Signed ppm double → "+123.4 ppm". */
export const ppmFmt = (v: number | null | undefined, dp = 1): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(dp)} ppm`;
};

/** Epoch seconds → UTC time string. */
export const epochFmt = (epochSec: number): string =>
  new Date(epochSec * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
