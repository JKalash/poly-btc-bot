/**
 * CTF / inventory market-making spine (refinement brief R10 + R12).
 *
 * Paper/shadow only. Models split-sell and buy-both-and-merge as a paired
 * quote CYCLE state machine — never as a single "risk-free" trade. The brief's
 * hard lesson: only one quote fills, the other token reprices, the bot is
 * directionally exposed; merging is impossible without equal paired inventory.
 * A cycle may be REPORTED risk-free only when both legs and the merge/settle
 * state are fully reconciled — see `isRiskFree`.
 *
 * Conventions (see ./fixed): all money/shares/prob values are bigint
 * micro-units, never floats (doubles appear only for pure statistics, e.g.
 * feed-basis estimates). All *Ms fields are UTC unix epoch milliseconds.
 * Every persisted record carries a stable id + correlationId + configVersion.
 */

import type { Prob6, Shares6, Usdc6 } from "./fixed";
import type { ExecutionMode } from "./execution";
import type { OrderSide, OutcomeSide } from "./types";

// ---------------------------------------------------------------------------
// Paired-cycle state machine (R10)
// ---------------------------------------------------------------------------

/**
 * Cycle states. The first ten are the brief's required main path verbatim;
 * the last five are the brief's cycle-level side states. The brief's remaining
 * two side states (PARTIAL_LEG, UNHEDGED) are leg-shaped and live in
 * PAIRED_LEG_STATES below.
 */
export const PAIRED_CYCLE_STATES = [
  // R10 main path
  "PLANNED",             // cycle intent exists; nothing sent, nothing owned
  "INVENTORY_PREFLIGHT", // check collateral, allowances, existing paired inventory
  "SPLIT_PENDING",       // CTF split submitted, not yet confirmed
  "INVENTORY_READY",     // paired Up+Down inventory (or collateral for buy-both) confirmed
  "QUOTING_BOTH",        // both legs quoted (post-only), zero net fills so far
  "ONE_LEG_FILLED",      // exactly one leg has net fills — DIRECTIONAL EXPOSURE
  "HEDGE_OR_CANCEL",     // actively resolving one-leg exposure (hedge, dump, or cancel+hold)
  "BOTH_LEGS_FILLED",    // both legs have matched net fills — pair complete
  "MERGE_OR_SETTLE",     // deciding/performing wind-down: merge, redeem, or hold to settlement
  "RECONCILED",          // terminal: balances, fills, CTF ops and accrual states all reconciled
  // R10 side states (cycle-level)
  "ALLOWANCE_BLOCKED",     // split/merge blocked on token/collateral allowance
  "MERGE_PENDING",         // CTF merge submitted, not yet confirmed
  "REWARD_PENDING",        // trading legs done; a rebate/reward accrual is still unpaid
  "HALTED",                // operator/risk halt mid-cycle; exposure must be resolved explicitly
  "FAILED_RECONCILIATION", // believed state and exchange/on-chain truth disagree
] as const;
export type PairedCycleState = (typeof PAIRED_CYCLE_STATES)[number];

/**
 * Legal forward transitions. Anything not listed is invalid.
 *  - INVENTORY_PREFLIGHT -> INVENTORY_READY is the inventory-reuse path (no
 *    split needed when paired inventory already exists).
 *  - QUOTING_BOTH -> INVENTORY_READY is a clean abort: both quotes canceled
 *    with zero net fills; inventory intact.
 *  - ONE_LEG_FILLED can NEVER shortcut to MERGE_OR_SETTLE or RECONCILED: the
 *    only exits are HEDGE_OR_CANCEL, BOTH_LEGS_FILLED (sibling fill), or
 *    HALTED — and HALTED only exits via HEDGE_OR_CANCEL or an explicit
 *    FAILED_RECONCILIATION. Every clean path to RECONCILED from an open leg
 *    passes through hedge/completion (tested by graph search).
 *  - FAILED_RECONCILIATION -> RECONCILED is manual operator repair only.
 *  - PLANNED -> RECONCILED is the trivial abandon path (nothing ever done).
 */
export const PAIRED_CYCLE_TRANSITIONS: Record<PairedCycleState, readonly PairedCycleState[]> = {
  PLANNED: ["INVENTORY_PREFLIGHT", "RECONCILED", "HALTED"],
  INVENTORY_PREFLIGHT: ["SPLIT_PENDING", "INVENTORY_READY", "ALLOWANCE_BLOCKED", "HALTED"],
  SPLIT_PENDING: ["INVENTORY_READY", "ALLOWANCE_BLOCKED", "FAILED_RECONCILIATION", "HALTED"],
  INVENTORY_READY: ["QUOTING_BOTH", "MERGE_OR_SETTLE", "HALTED"],
  QUOTING_BOTH: ["ONE_LEG_FILLED", "BOTH_LEGS_FILLED", "INVENTORY_READY", "HALTED"],
  ONE_LEG_FILLED: ["HEDGE_OR_CANCEL", "BOTH_LEGS_FILLED", "HALTED"],
  HEDGE_OR_CANCEL: ["BOTH_LEGS_FILLED", "MERGE_OR_SETTLE", "FAILED_RECONCILIATION", "HALTED"],
  BOTH_LEGS_FILLED: ["MERGE_OR_SETTLE", "HALTED"],
  MERGE_OR_SETTLE: ["MERGE_PENDING", "REWARD_PENDING", "RECONCILED", "ALLOWANCE_BLOCKED", "FAILED_RECONCILIATION", "HALTED"],
  MERGE_PENDING: ["MERGE_OR_SETTLE", "REWARD_PENDING", "RECONCILED", "FAILED_RECONCILIATION", "HALTED"],
  REWARD_PENDING: ["RECONCILED", "FAILED_RECONCILIATION"],
  ALLOWANCE_BLOCKED: ["INVENTORY_PREFLIGHT", "MERGE_OR_SETTLE", "HALTED"],
  HALTED: ["HEDGE_OR_CANCEL", "FAILED_RECONCILIATION"],
  FAILED_RECONCILIATION: ["RECONCILED"],
  RECONCILED: [],
};

export function isValidCycleTransition(from: PairedCycleState, to: PairedCycleState): boolean {
  return (PAIRED_CYCLE_TRANSITIONS[from] ?? []).includes(to);
}

export function assertValidCycleTransition(from: PairedCycleState, to: PairedCycleState): void {
  if (!isValidCycleTransition(from, to)) {
    throw new Error(`illegal paired-cycle transition ${from} -> ${to}`);
  }
}

/** Terminal cycle state: nothing may follow. RECONCILED is the sole terminal. */
export function isTerminalCycleState(s: PairedCycleState): boolean {
  return PAIRED_CYCLE_TRANSITIONS[s].length === 0;
}

// ---------------------------------------------------------------------------
// Per-leg state machine (R10 side states PARTIAL_LEG + UNHEDGED live here)
// ---------------------------------------------------------------------------

export const PAIRED_LEG_STATES = [
  "PLANNED",     // intended quote, not yet posted
  "QUOTED",      // resting post-only quote, zero net fill
  "PARTIAL_LEG", // partially filled (brief side state) — net fill > 0, remainder resting or canceled
  "UNHEDGED",    // net fill with NO offsetting sibling fill/hedge — open directional exposure (brief side state)
  "HEDGED",      // exposure closed: sibling leg matched or a hedge action completed
  "CANCELED",    // canceled with ZERO net fill (a partially filled leg can never become CANCELED)
  "SETTLED",     // held to market resolution and settled
] as const;
export type PairedLegState = (typeof PAIRED_LEG_STATES)[number];

/**
 * Legal forward transitions.
 *  - QUOTED -> UNHEDGED: full fill while the sibling leg is not matched.
 *  - QUOTED -> HEDGED: fill that simultaneously completes the pair.
 *  - PARTIAL_LEG -> PARTIAL_LEG: subsequent partials are a legal advance.
 *  - PARTIAL_LEG has NO path to CANCELED: net fill cannot vanish; canceling
 *    the remainder leaves UNHEDGED (or HEDGED) inventory.
 */
export const PAIRED_LEG_TRANSITIONS: Record<PairedLegState, readonly PairedLegState[]> = {
  PLANNED: ["QUOTED", "CANCELED"],
  QUOTED: ["PARTIAL_LEG", "UNHEDGED", "HEDGED", "CANCELED"],
  PARTIAL_LEG: ["PARTIAL_LEG", "UNHEDGED", "HEDGED"],
  UNHEDGED: ["HEDGED", "SETTLED"],
  HEDGED: ["SETTLED"], // pair carried to resolution instead of merged
  CANCELED: [],
  SETTLED: [],
};

export function isValidLegTransition(from: PairedLegState, to: PairedLegState): boolean {
  return (PAIRED_LEG_TRANSITIONS[from] ?? []).includes(to);
}

export function assertValidLegTransition(from: PairedLegState, to: PairedLegState): void {
  if (!isValidLegTransition(from, to)) {
    throw new Error(`illegal paired-leg transition ${from} -> ${to}`);
  }
}

/** Closed leg states: no resting order and no unhedged exposure remains. */
export const CLOSED_LEG_STATES: ReadonlySet<PairedLegState> = new Set(["HEDGED", "CANCELED", "SETTLED"]);

/**
 * A leg is OPEN when it is not in a closed state. Note PLANNED counts as open:
 * a cycle with an intended-but-unposted quote is not complete, so it can never
 * be reported risk-free either.
 */
export function isLegOpen(leg: Pick<PairedLeg, "state">): boolean {
  return !CLOSED_LEG_STATES.has(leg.state);
}

// ---------------------------------------------------------------------------
// Cycle records
// ---------------------------------------------------------------------------

export const PAIRED_CYCLE_KINDS = ["SPLIT_SELL", "BUY_BOTH_MERGE"] as const;
export type PairedCycleKind = (typeof PAIRED_CYCLE_KINDS)[number];

/**
 * One paired maker cycle. Legs live in their own rows (paired_legs) keyed by
 * cycleId; economics fields stay null until knowable (no bigint defaults —
 * writers must supply explicit values).
 */
export interface PairedQuoteCycle {
  id: string;
  correlationId: string;
  marketId: string;
  mode: ExecutionMode; // paper/shadow only by policy; risk gates keep LIVE out
  kind: PairedCycleKind;
  state: PairedCycleState;
  /** Planned Up+Down quote sum: > 1e6 for split-sell, < 1e6 for buy-both-merge. */
  targetPairPrice6: Prob6;
  collateralCommitted6: Usdc6;
  /** Planned worst-case loss of the cycle's failure path (risk gate input). */
  worstCaseLoss6: Usdc6;
  /** ctf_operations id once a split/merge op exists; plain refs, set after op insert. */
  splitOperationId: string | null;
  mergeOperationId: string | null;
  oneLegFilledAtMs: number | null;
  hedgeCompletedAtMs: number | null;
  /** Total time any leg spent unhedged (maximum_one_leg_seconds budget input). */
  unhedgedDurationMs: number | null;
  /** Gross spread captured by the two legs; null until both legs closed. */
  spreadCaptured6: Usdc6 | null;
  fees6: Usdc6 | null;
  /** Trading P&L only — NEVER includes rebate/reward accruals until they are PAID. */
  realizedPnl6: Usdc6 | null;
  createdAtMs: number;
  updatedAtMs: number;
  reconciledAtMs: number | null;
  configVersion: number;
}

/** One side of a paired cycle (one quoted token). */
export interface PairedLeg {
  id: string;
  correlationId: string;
  cycleId: string;
  marketId: string;
  tokenId: string;
  outcomeSide: OutcomeSide;
  /** SELL for split-sell legs, BUY for buy-both-merge legs. */
  orderSide: OrderSide;
  state: PairedLegState;
  price6: Prob6;
  size6: Shares6;
  /** Net filled so far; writers supply 0n explicitly (no bigint defaults). */
  filledShares6: Shares6;
  avgFillPrice6: Prob6 | null;
  feeUsdc6: Usdc6 | null;
  /** order_attempts id when execution ran through the order machinery; null in shadow (nothing sent). */
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

/**
 * THE risk-free predicate (brief: "Split/sell cannot be labeled risk-free
 * while one leg is open"). Pure. A cycle may be reported risk-free ONLY when:
 *  - the cycle itself reached RECONCILED (sole terminal state — implies all
 *    CTF operations confirmed and balances reconciled; MERGE_PENDING,
 *    REWARD_PENDING etc. are distinct states and fail this check), AND
 *  - every provided leg is closed (HEDGED / CANCELED / SETTLED).
 * Callers MUST pass all legs belonging to the cycle; there is no default.
 */
export function isRiskFree(cycle: Pick<PairedQuoteCycle, "state">, legs: readonly Pick<PairedLeg, "state">[]): boolean {
  if (cycle.state !== "RECONCILED") return false;
  return legs.every((leg) => !isLegOpen(leg));
}

// ---------------------------------------------------------------------------
// CTF operations (split / merge / redeem) with gas, latency + partial modeling
// ---------------------------------------------------------------------------

/** REDEEM is additive beyond the task's SPLIT/MERGE: the MERGE_OR_SETTLE settle path redeems winning tokens post-resolution. */
export const CTF_OPERATION_KINDS = ["SPLIT", "MERGE", "REDEEM"] as const;
export type CtfOperationKind = (typeof CTF_OPERATION_KINDS)[number];

export const CTF_OPERATION_STATES = [
  "PLANNED",             // op intent exists; preflight not passed
  "SUBMITTED",           // transaction/relayer request in flight
  "CONFIRMED",           // fully confirmed on-chain for requestedAmount6
  "PARTIALLY_CONFIRMED", // confirmed for less than requestedAmount6 (partial modeling)
  "FAILED",              // preflight refusal (allowance/balance) or on-chain revert
  "UNKNOWN",             // outcome ambiguous — MUST reconcile on-chain before anything else
] as const;
export type CtfOperationState = (typeof CTF_OPERATION_STATES)[number];

export const CTF_OPERATION_TRANSITIONS: Record<CtfOperationState, readonly CtfOperationState[]> = {
  PLANNED: ["SUBMITTED", "FAILED"],
  SUBMITTED: ["CONFIRMED", "PARTIALLY_CONFIRMED", "FAILED", "UNKNOWN"],
  PARTIALLY_CONFIRMED: ["CONFIRMED", "FAILED", "UNKNOWN"],
  UNKNOWN: ["CONFIRMED", "PARTIALLY_CONFIRMED", "FAILED"], // resolved ONLY by on-chain reconciliation
  CONFIRMED: [],
  FAILED: [],
};

export function isValidCtfTransition(from: CtfOperationState, to: CtfOperationState): boolean {
  return (CTF_OPERATION_TRANSITIONS[from] ?? []).includes(to);
}

export function assertValidCtfTransition(from: CtfOperationState, to: CtfOperationState): void {
  if (!isValidCtfTransition(from, to)) {
    throw new Error(`illegal CTF operation transition ${from} -> ${to}`);
  }
}

/**
 * One CTF operation. Amounts are micro paired-units: for SPLIT,
 * requestedAmount6 collateral becomes that many Up+Down micro-share pairs;
 * MERGE/REDEEM the reverse. Latency is measured from the persisted
 * createdAt/submittedAt/confirmedAt stamps; gas is modeled per-op.
 */
export interface CtfOperation {
  id: string;
  correlationId: string;
  /** Owning cycle when part of a paired cycle; null for standalone inventory ops. */
  cycleId: string | null;
  marketId: string;
  conditionId: string;
  kind: CtfOperationKind;
  state: CtfOperationState;
  mode: ExecutionMode;
  requestedAmount6: Shares6;
  /** Actually confirmed amount (partial modeling); null until any confirmation. */
  confirmedAmount6: Shares6 | null;
  /** Signed micro-USDC collateral effect: negative for SPLIT, positive for MERGE/REDEEM. Null until confirmed. */
  collateralDelta6: Usdc6 | null;
  /** Gas modeling: pre-submit estimate and post-confirm actual, in micro-USDC. */
  estGasUsdc6: Usdc6 | null;
  actualGasUsdc6: Usdc6 | null;
  /** True when routed through a relayer (gas paid indirectly). */
  relayed: boolean;
  txHash: string | null;
  failureReason: string | null;
  createdAtMs: number;
  submittedAtMs: number | null;
  confirmedAtMs: number | null;
  updatedAtMs: number;
  configVersion: number;
}

// ---------------------------------------------------------------------------
// Hedge actions (the HEDGE_OR_CANCEL resolutions)
// ---------------------------------------------------------------------------

export const HEDGE_ACTION_KINDS = [
  "COMPLETE_PAIR_TAKER",     // cross the spread to buy/sell the missing leg — completes the pair
  "DUMP_SURVIVOR_TAKER",     // cross the spread to exit the filled leg — pays spread and possibly taker fee
  "CANCEL_REMAINING_QUOTE",  // cancel the unfilled quote; filled inventory remains (UNHEDGED until settled/hedged)
  "HOLD_TO_RESOLUTION",      // deliberate decision to carry the exposure to settlement
] as const;
export type HedgeActionKind = (typeof HEDGE_ACTION_KINDS)[number];

export const HEDGE_ACTION_STATES = ["PLANNED", "EXECUTING", "DONE", "FAILED"] as const;
export type HedgeActionState = (typeof HEDGE_ACTION_STATES)[number];

export const HEDGE_ACTION_TRANSITIONS: Record<HedgeActionState, readonly HedgeActionState[]> = {
  PLANNED: ["EXECUTING", "DONE", "FAILED"], // CANCEL/HOLD kinds may complete without an executing phase
  EXECUTING: ["DONE", "FAILED"],
  DONE: [],
  FAILED: [],
};

export function isValidHedgeTransition(from: HedgeActionState, to: HedgeActionState): boolean {
  return (HEDGE_ACTION_TRANSITIONS[from] ?? []).includes(to);
}

export interface HedgeAction {
  id: string;
  correlationId: string;
  cycleId: string;
  /** The leg whose exposure is being resolved; null when acting at cycle level. */
  legId: string | null;
  marketId: string;
  tokenId: string | null;
  kind: HedgeActionKind;
  state: HedgeActionState;
  mode: ExecutionMode;
  targetShares6: Shares6;
  executedShares6: Shares6 | null;
  /** Estimated cost at decision time (spread + fee + impact), micro-USDC. */
  expectedCost6: Usdc6 | null;
  actualCost6: Usdc6 | null;
  feeUsdc6: Usdc6 | null;
  /** order_attempts id when the hedge ran through the order machinery. */
  attemptId: string | null;
  /** How long the leg had been unhedged when this action was decided. */
  unhedgedDurationMs: number | null;
  decidedAtMs: number;
  executedAtMs: number | null;
  updatedAtMs: number;
  configVersion: number;
}

// ---------------------------------------------------------------------------
// Inventory lots + snapshots
// ---------------------------------------------------------------------------

export const INVENTORY_LOT_SOURCES = ["SPLIT", "FILL", "HEDGE", "TRANSFER_IN"] as const;
export type InventoryLotSource = (typeof INVENTORY_LOT_SOURCES)[number];

/**
 * One acquisition lot of outcome tokens with exact cost basis.
 * remainingShares6 === 0n means fully consumed (no separate status flag).
 */
export interface InventoryLot {
  id: string;
  correlationId: string;
  /** Owning cycle when acquired inside a paired cycle. */
  cycleId: string | null;
  marketId: string;
  tokenId: string;
  outcomeSide: OutcomeSide;
  source: InventoryLotSource;
  /** Provenance ref: ctf_operations id, order_fills id, or tx hash. */
  sourceRef: string | null;
  mode: ExecutionMode;
  acquiredShares6: Shares6;
  remainingShares6: Shares6;
  /** Total micro-USDC cost attributed to the lot (split collateral share, fill cost, hedge cost). */
  costBasis6: Usdc6;
  acquiredAtMs: number;
  consumedAtMs: number | null;
  configVersion: number;
}

/**
 * Point-in-time per-market inventory snapshot: believed vs exchange vs
 * on-chain, paired vs unpaired (Inventory Lab contract).
 */
export interface InventorySnapshot {
  id: string;
  correlationId: string;
  marketId: string;
  mode: ExecutionMode;
  /** Believed net inventory. */
  upShares6: Shares6;
  downShares6: Shares6;
  /** Matched Up/Down pairs (mergeable amount). */
  pairedShares6: Shares6;
  unpairedUpShares6: Shares6;
  unpairedDownShares6: Shares6;
  /** Locked in open sell quotes (balance/allowance race modeling). */
  reservedUpShares6: Shares6;
  reservedDownShares6: Shares6;
  /** Free collateral attributed to this market's cycles; null when not tracked. */
  collateralFree6: Usdc6 | null;
  /** Exchange-reported balances at snapshot time; null when not queried. */
  exchangeUpShares6: Shares6 | null;
  exchangeDownShares6: Shares6 | null;
  /** On-chain balances at snapshot time; null when not queried. */
  onchainUpShares6: Shares6 | null;
  onchainDownShares6: Shares6 | null;
  /** True only when believed == exchange == on-chain for every queried figure. */
  reconciled: boolean;
  /** Structured mismatch detail when reconciled is false. */
  divergence: Record<string, unknown> | null;
  tsMs: number;
  configVersion: number;
}

// ---------------------------------------------------------------------------
// Rebate + liquidity-reward accruals — SEPARATE programs, SEPARATE types.
// The brief forbids merging their eligibility or accounting. `realized` is
// structurally true ONLY at PAID (discriminated union — a non-PAID status
// cannot even represent realized:true).
// ---------------------------------------------------------------------------

export const ACCRUAL_STATES = ["EXPECTED", "ACCRUED", "PENDING", "PAID", "DISPUTED"] as const;
export type AccrualState = (typeof ACCRUAL_STATES)[number];

/**
 * EXPECTED -> ACCRUED -> PENDING -> PAID, with DISPUTED reachable from every
 * non-terminal state. PAID is terminal and reachable ONLY from PENDING —
 * a dispute must re-enter the pipeline (DISPUTED -> ACCRUED/PENDING) before
 * payment. No estimated amount can ever jump straight to PAID.
 */
export const ACCRUAL_TRANSITIONS: Record<AccrualState, readonly AccrualState[]> = {
  EXPECTED: ["ACCRUED", "DISPUTED"],
  ACCRUED: ["PENDING", "DISPUTED"],
  PENDING: ["PAID", "DISPUTED"],
  DISPUTED: ["ACCRUED", "PENDING"],
  PAID: [],
};

export function isValidAccrualTransition(from: AccrualState, to: AccrualState): boolean {
  return (ACCRUAL_TRANSITIONS[from] ?? []).includes(to);
}

export function assertValidAccrualTransition(from: AccrualState, to: AccrualState): void {
  if (!isValidAccrualTransition(from, to)) {
    throw new Error(`illegal accrual transition ${from} -> ${to}`);
  }
}

export function isTerminalAccrualState(s: AccrualState): boolean {
  return ACCRUAL_TRANSITIONS[s].length === 0;
}

export type UnrealizedAccrualState = Exclude<AccrualState, "PAID">;

/** Non-PAID: realized is the literal false; paid fields are structurally null. */
export interface AccrualStatusUnrealized {
  state: UnrealizedAccrualState;
  realized: false;
  paidAmount6: null;
  paidAtMs: null;
}

/** PAID: realized is the literal true; the paid amount/time are required. */
export interface AccrualStatusPaid {
  state: "PAID";
  realized: true;
  paidAmount6: Usdc6;
  paidAtMs: number;
}

export type AccrualStatus = AccrualStatusUnrealized | AccrualStatusPaid;

export function unrealizedAccrualStatus(state: UnrealizedAccrualState): AccrualStatusUnrealized {
  if ((state as AccrualState) === "PAID") throw new Error("PAID is not an unrealized accrual state");
  return { state, realized: false, paidAmount6: null, paidAtMs: null };
}

export function paidAccrualStatus(paidAmount6: Usdc6, paidAtMs: number): AccrualStatusPaid {
  return { state: "PAID", realized: true, paidAmount6, paidAtMs };
}

/** True iff the accrual may be added to realized P&L. Realized <=> PAID, always. */
export function isRealizedAccrual(s: AccrualStatus): s is AccrualStatusPaid {
  return s.state === "PAID" && s.realized === true;
}

/**
 * Runtime shape check for rows loaded from the database (where the union is
 * flattened into columns). Rejects realized:true outside PAID, realized:false
 * at PAID, and paid fields present/absent inconsistently.
 */
export function isConsistentAccrualStatus(s: {
  state: AccrualState; realized: boolean; paidAmount6: Usdc6 | null; paidAtMs: number | null;
}): s is AccrualStatus {
  if (s.state === "PAID") {
    return s.realized === true && s.paidAmount6 !== null && s.paidAtMs !== null;
  }
  return s.realized === false && s.paidAmount6 === null && s.paidAtMs === null;
}

/** Maker-rebate accrual (funded from taker fees, paid on executed maker liquidity). */
export interface RebateAccrualBase {
  id: string;
  correlationId: string;
  /** Literal discriminant: rebates and liquidity rewards can never be merged. */
  program: "MAKER_REBATE";
  /** Versioned program rules the accrual was computed under. */
  programVersion: string;
  marketId: string;
  /** Owning cycle when the rebate is attributable to a paired cycle. */
  cycleId: string | null;
  /** order_fills id the rebate accrues on; unique per fill when set. */
  fillId: string | null;
  /** Maker size the accrual is computed from. */
  basisShares6: Shares6 | null;
  basisNotional6: Usdc6 | null;
  /** Current best-estimate amount (micro-USDC). NOT realized P&L until PAID. */
  amount6: Usdc6;
  createdAtMs: number;
  updatedAtMs: number;
  configVersion: number;
}
export type RebateAccrual = RebateAccrualBase & AccrualStatus;

/** Liquidity-reward accrual (competitive resting quotes near the midpoint; epoch-scored). */
export interface LiquidityRewardAccrualBase {
  id: string;
  correlationId: string;
  /** Literal discriminant: rebates and liquidity rewards can never be merged. */
  program: "LIQUIDITY_REWARD";
  programVersion: string;
  /** Null for epoch-level rewards not attributable to a single market. */
  marketId: string | null;
  /** Reward epoch key (e.g. "2026-08-03" or program epoch id). */
  epochKey: string;
  /** Time the quotes qualified within the epoch, when known. */
  qualifyingUptimeMs: number | null;
  /** Program scoring detail (spread/size/midpoint proximity inputs). */
  scoreDetail: Record<string, unknown> | null;
  /** Current best-estimate amount (micro-USDC). NOT realized P&L until PAID. */
  amount6: Usdc6;
  createdAtMs: number;
  updatedAtMs: number;
  configVersion: number;
}
export type LiquidityRewardAccrual = LiquidityRewardAccrualBase & AccrualStatus;

// ---------------------------------------------------------------------------
// Wallet research (R12)
// ---------------------------------------------------------------------------

/**
 * One reconstructed wallet-economics snapshot over an observation interval.
 * Separates trading P&L from capital flows and incentive income; carries an
 * evidence label because whale claims are unverified anecdotes until
 * reconstructed (brief: survivorship bias is acknowledged by the source).
 */
export interface WalletResearchSnapshot {
  id: string;
  correlationId: string;
  walletAddress: string;
  /** Linked proxy/funder wallet when identified. */
  funderWallet: string | null;
  observationStartMs: number;
  observationEndMs: number;
  /** True only when the interval is complete (no gaps in the reconstruction). */
  completeInterval: boolean;
  tradesCount: number;
  splitsCount: number;
  mergesCount: number;
  redeemsCount: number;
  transfersCount: number;
  deposits6: Usdc6;
  withdrawals6: Usdc6;
  transfersIn6: Usdc6;
  transfersOut6: Usdc6;
  /** Reconstructed trading P&L — null when not yet separable from flows. */
  tradingPnl6: Usdc6 | null;
  /** PAID incentives only; never estimated accruals. */
  rebatesPaid6: Usdc6 | null;
  rewardsPaid6: Usdc6 | null;
  openPositionsValue6: Usdc6 | null;
  inventoryCostBasis6: Usdc6 | null;
  timeWeightedCapital6: Usdc6 | null;
  /** P&L attribution breakdown (directional / spread / CTF ops / incentives / scale). */
  attribution: Record<string, unknown> | null;
  /** Uncertainty from unavailable off-chain data — REQUIRED honesty channel. */
  dataGaps: Record<string, unknown> | null;
  /** EvidenceLabel string, e.g. SOURCE_CLAIM_UNVERIFIED | INTERNAL_HYPOTHESIS | REPRODUCED_MATCH. */
  evidenceLabel: string;
  /** Data source(s) of the reconstruction, e.g. "polygonscan+clob". */
  source: string;
  capturedAtMs: number;
  configVersion: number;
}

// ---------------------------------------------------------------------------
// Feed basis + boundary observations (R1 + Chainlink boundary capture)
// ---------------------------------------------------------------------------

/**
 * Rolling cross-feed basis estimate (e.g. Binance minus Chainlink), estimated
 * CAUSALLY from data at or before tsMs only. Values are pure statistics in
 * ppm doubles — they never touch money math. Any lag signal must exceed this
 * structural basis before it can be called a signal at all (brief R1: the ETH
 * 0.12% offset with a 0.10% gate fired structurally and faked a +$456 edge).
 */
export interface FeedBasisEstimate {
  id: string;
  correlationId: string;
  /** Asset symbol, e.g. "BTCUSD". */
  symbol: string;
  /** Feed measured (e.g. "binance"). */
  baseSource: string;
  /** Reference feed subtracted (e.g. "chainlink"). */
  refSource: string;
  windowStartMs: number;
  windowEndMs: number;
  sampleCount: number;
  /** base-minus-ref level in parts-per-million of the ref price. */
  meanPpm: number;
  medianPpm: number | null;
  stdPpm: number;
  madPpm: number | null;
  /** Estimated local clock offset between the feeds' source timestamps, ms. */
  clockOffsetMs: number | null;
  /** Estimated lead (+) / lag (-) of baseSource vs refSource, ms. */
  leadLagMs: number | null;
  /** Volatility/liquidity regime tag when classified. */
  regime: string | null;
  /** Estimator version, e.g. "rolling_robust_v1". */
  method: string;
  /** As-of time; the estimate uses ONLY data at or before this instant. */
  tsMs: number;
  configVersion: number;
}

export const BOUNDARY_KINDS = ["OPEN", "CLOSE"] as const;
export type BoundaryKind = (typeof BOUNDARY_KINDS)[number];

/**
 * One captured Chainlink boundary observation: the first authoritative tick at
 * or after a 300s-aligned window boundary (OPEN = strike / price-to-beat,
 * CLOSE = resolution value). Exact decimal preserved as text; cross-checked
 * against the official price-to-beat representation when available. If capture
 * started late, firstAtOrAfterBoundary MUST be false — a reconstructed strike
 * is never authoritative (brief: Binance never decides settlement).
 */
export interface BoundaryPriceObservation {
  id: string;
  correlationId: string;
  /** Gamma market id when known; boundary capture may precede market discovery. */
  marketId: string | null;
  symbol: string;
  boundaryKind: BoundaryKind;
  /** The boundary itself (unix seconds, 300-aligned). */
  boundaryEpoch: number;
  /** Exact decimal string as delivered by the feed. */
  valueText: string;
  /** Display/feature value only — never for resolution math. */
  valueFloat: number;
  /** e.g. "rtds_chainlink". */
  source: string;
  sourceTsMs: number;
  receivedTsMs: number;
  /** Feed sequence/round metadata when provided. */
  sequence: string | null;
  /** True only when this is genuinely the first tick at/after the boundary observed live. */
  firstAtOrAfterBoundary: boolean;
  /** Official price-to-beat cross-check, when available. */
  officialValueText: string | null;
  matchesOfficial: boolean | null;
  configVersion: number;
}
