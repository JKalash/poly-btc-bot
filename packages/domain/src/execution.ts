/**
 * Execution-quality timeline (refinement plan item 1b).
 *
 * Every real or simulated order attempt is tracked as an ordered timeline of
 * states with monotonic + wall-clock timestamps and book-snapshot provenance,
 * so that latency, queue position, adverse selection (markouts) and paper-fill
 * realism can all be measured after the fact.
 *
 * Conventions (see ./fixed): all money/shares/prob values are bigint
 * micro-units, never floats. All *Ms fields are UTC unix epoch milliseconds.
 * Every persisted record carries a stable id + correlationId + configVersion.
 */

import type { Prob6, Shares6, Usdc6 } from "./fixed";
import type { OrderSide, TimeInForce } from "./types";

/** Execution mode of the attempt. Distinct from engine Mode ("observe"|...): timeline rows exist only for simulated or real orders. */
export type ExecutionMode = "PAPER" | "SHADOW" | "LIVE";

// ---------------------------------------------------------------------------
// Timeline state machine
// ---------------------------------------------------------------------------

export const EXECUTION_TIMELINE_STATES = [
  "DECISION_SNAPSHOT", // immutable decision snapshot persisted (pre-intent)
  "INTENT_CREATED",    // order intent persisted with idempotency key
  "RISK_APPROVED",     // risk engine approved the intent
  "SIGN_STARTED",      // local signing began (local failure => REJECTED, safe)
  "SENT",              // request handed to transport — the risky boundary
  "EXCHANGE_ACK",      // exchange acknowledged the order
  "RESTING",           // confirmed resting on the book (maker)
  "PARTIAL_FILL",      // one or more partial fills observed
  "FILLED",            // fully filled
  "REJECTED",          // safe no-fill: risk reject, sign failure, exchange reject, INCLUDING post-only-crossing safe no-fill
  "CANCEL_REQUESTED",  // cancel sent (fills can still race the cancel)
  "CANCEL_CONFIRMED",  // exchange confirmed cancel of remaining size
  "UNKNOWN_OUTCOME",   // ack/cancel/fill outcome unknown (timeout, disconnect) — MUST reconcile before any retry
  "BALANCE_RECONCILED",// balances/positions reconciled against exchange truth (terminal)
] as const;
export type ExecutionTimelineState = (typeof EXECUTION_TIMELINE_STATES)[number];

/**
 * Legal forward transitions. Anything not listed is invalid.
 *  - REJECTED covers every safe no-fill path, including a post-only order that
 *    would have crossed the book (exchange rejects, nothing rests, no fill).
 *  - UNKNOWN_OUTCOME may ONLY be followed by BALANCE_RECONCILED: after an
 *    ambiguous outcome the engine must reconcile balances before any retry;
 *    a retry is a NEW attempt whose timeline starts at DECISION_SNAPSHOT /
 *    INTENT_CREATED — never a transition out of a terminal state.
 *  - PARTIAL_FILL -> PARTIAL_FILL is a legal advance (subsequent partials).
 */
export const EXECUTION_TIMELINE_TRANSITIONS: Record<ExecutionTimelineState, readonly ExecutionTimelineState[]> = {
  DECISION_SNAPSHOT: ["INTENT_CREATED"],
  INTENT_CREATED: ["RISK_APPROVED", "REJECTED"],
  RISK_APPROVED: ["SIGN_STARTED", "REJECTED"],
  SIGN_STARTED: ["SENT", "REJECTED"],
  SENT: ["EXCHANGE_ACK", "REJECTED", "UNKNOWN_OUTCOME"],
  EXCHANGE_ACK: ["RESTING", "PARTIAL_FILL", "FILLED", "REJECTED", "CANCEL_REQUESTED", "UNKNOWN_OUTCOME"],
  RESTING: ["PARTIAL_FILL", "FILLED", "CANCEL_REQUESTED", "CANCEL_CONFIRMED", "UNKNOWN_OUTCOME"],
  PARTIAL_FILL: ["PARTIAL_FILL", "FILLED", "CANCEL_REQUESTED", "CANCEL_CONFIRMED", "UNKNOWN_OUTCOME"],
  FILLED: ["BALANCE_RECONCILED"],
  REJECTED: ["BALANCE_RECONCILED"],
  CANCEL_REQUESTED: ["CANCEL_CONFIRMED", "PARTIAL_FILL", "FILLED", "UNKNOWN_OUTCOME"],
  CANCEL_CONFIRMED: ["BALANCE_RECONCILED"],
  UNKNOWN_OUTCOME: ["BALANCE_RECONCILED"],
  BALANCE_RECONCILED: [],
};

/** Pure transition validator. */
export function isValidTransition(from: ExecutionTimelineState, to: ExecutionTimelineState): boolean {
  return (EXECUTION_TIMELINE_TRANSITIONS[from] ?? []).includes(to);
}

export function assertValidTransition(from: ExecutionTimelineState, to: ExecutionTimelineState): void {
  if (!isValidTransition(from, to)) {
    throw new Error(`illegal execution-timeline transition ${from} -> ${to}`);
  }
}

/** Terminal state: nothing may follow. */
export function isTerminalTimelineState(s: ExecutionTimelineState): boolean {
  return EXECUTION_TIMELINE_TRANSITIONS[s].length === 0;
}

/**
 * States for which an exact same-state replay (duplicate websocket ack,
 * re-delivered RESTING confirmation) must be treated as an idempotent no-op
 * rather than an error. PARTIAL_FILL is deliberately absent here: a repeated
 * PARTIAL_FILL is a legal ADVANCE (a new partial); true duplicates of the same
 * partial must be deduplicated by event id upstream.
 */
export const IDEMPOTENT_REPLAY_STATES: ReadonlySet<ExecutionTimelineState> = new Set([
  "EXCHANGE_ACK", "RESTING",
]);

export function isIdempotentReplay(from: ExecutionTimelineState, to: ExecutionTimelineState): boolean {
  return from === to && IDEMPOTENT_REPLAY_STATES.has(from);
}

export type TransitionClass = "ADVANCE" | "DUPLICATE" | "INVALID";

/**
 * Classify an incoming state observation against the current state:
 *  - ADVANCE: legal forward transition (apply it)
 *  - DUPLICATE: idempotent replay of the current state (ignore it)
 *  - INVALID: anything else (log + alarm; never applied)
 */
export function classifyTransition(from: ExecutionTimelineState, to: ExecutionTimelineState): TransitionClass {
  if (isValidTransition(from, to)) return "ADVANCE";
  if (isIdempotentReplay(from, to)) return "DUPLICATE";
  return "INVALID";
}

// ---------------------------------------------------------------------------
// Timeline records
// ---------------------------------------------------------------------------

/**
 * One event on the execution timeline. Persisted append-only; the event id is
 * stable so duplicate deliveries upsert instead of double-count.
 * bookSnapshotId references orderbook_snapshots.id (bigserial) when a book
 * snapshot was captured at this instant.
 */
export interface ExecutionTimelineEvent {
  id: string;
  correlationId: string;
  /** Pre-generated intent id; present from DECISION_SNAPSHOT on, before the intent row itself exists. */
  intentId: string;
  attemptId: string | null;
  state: ExecutionTimelineState;
  tsMs: number;
  /** Monotonic clock (process-local, nanoseconds) for intra-process latency math; null when unavailable. */
  monoNs: bigint | null;
  bookSnapshotId: bigint | null;
  mode: ExecutionMode;
  detail: Record<string, unknown> | null;
  configVersion: number;
}

/**
 * One concrete order attempt under an intent. attemptNumber starts at 1;
 * a retry after UNKNOWN_OUTCOME + BALANCE_RECONCILED is a new attempt.
 * The four book-snapshot refs capture the book at decision, send, ack and
 * (final) fill so slippage/queue analysis can replay exactly what was seen.
 */
export interface OrderAttempt {
  id: string;
  correlationId: string;
  intentId: string;
  attemptNumber: number;
  /** Hash of the exact signed request payload (idempotence + audit). */
  requestHash: string;
  tokenId: string;
  side: OrderSide;
  price6: Prob6;
  size6: Shares6;
  /** Remaining unfilled size in micro-shares. */
  remaining6: Shares6;
  timeInForce: TimeInForce;
  postOnly: boolean;
  /** Latest ExecutionTimelineState of this attempt. */
  status: ExecutionTimelineState;
  decisionBookSnapshotId: bigint | null;
  sendBookSnapshotId: bigint | null;
  ackBookSnapshotId: bigint | null;
  fillBookSnapshotId: bigint | null;
  createdAtMs: number;
  updatedAtMs: number;
  configVersion: number;
}

// ---------------------------------------------------------------------------
// Latency / queue / counterfactual / markout measurements
// ---------------------------------------------------------------------------

export const LATENCY_STAGES = ["SIGN", "SEND", "ACK", "CANCEL", "BOOK_FEED"] as const;
export type LatencyStage = (typeof LATENCY_STAGES)[number];

/** One measured latency duration for a pipeline stage, in microseconds. */
export interface LatencySample {
  id: string;
  correlationId: string;
  intentId: string | null;
  attemptId: string | null;
  stage: LatencyStage;
  durationUs: number;
  mode: ExecutionMode;
  tsMs: number;
  configVersion: number;
}

export const QUEUE_ESTIMATE_METHODS = [
  "BOOK_DELTA_FIFO",         // FIFO replay of level deltas since order rested
  "TRADE_TAPE_REPLAY",       // trades at our level decrement queue ahead
  "FULL_LEVEL_CONSERVATIVE", // assume entire visible level is ahead of us
] as const;
export type QueueEstimateMethod = (typeof QUEUE_ESTIMATE_METHODS)[number];

/** Estimated shares ahead of our resting order at its price level. */
export interface QueueEstimate {
  id: string;
  correlationId: string;
  attemptId: string;
  tokenId: string;
  price6: Prob6;
  aheadShares6: Shares6;
  method: QueueEstimateMethod;
  tsMs: number;
  configVersion: number;
}

/**
 * A would-be maker fill that did NOT happen (order never placed, rejected, or
 * canceled first). `evidence` holds the book/trade refs supporting the claim
 * (e.g. trade tape prints through our would-be price).
 */
export interface FillCounterfactual {
  id: string;
  correlationId: string;
  decisionId: string;
  marketId: string;
  tokenId: string;
  price6: Prob6;
  size6: Shares6;
  wouldFill: boolean;
  reason: string;
  evidence: Record<string, unknown>;
  tsMs: number;
  configVersion: number;
}

export const MARKOUT_HORIZONS_MS = [250, 1000, 2000, 5000, 10000, 30000] as const;
export type MarkoutHorizon = (typeof MARKOUT_HORIZONS_MS)[number] | "AT_RESOLUTION";

/**
 * Post-fill markout: mid-price drift after our fill, side-adjusted so that
 * positive markout6 = the market moved in our favor after filling (we were NOT
 * adversely selected). markout6 = (midAtHorizon6 - midAtFill6) for BUY,
 * negated for SELL. Signed micro-prob units.
 */
export interface MarkoutObservation {
  id: string;
  correlationId: string;
  attemptId: string | null;
  /** order_fills id when tied to a specific fill; null for attempt-level markouts. */
  fillId: string | null;
  marketId: string;
  tokenId: string;
  side: OrderSide;
  horizonMs: MarkoutHorizon;
  midAtFill6: Prob6;
  midAtHorizon6: Prob6;
  markout6: bigint;
  tsMs: number;
  configVersion: number;
}

// ---------------------------------------------------------------------------
// Paper-fill variants + fill-selection cost
// ---------------------------------------------------------------------------

/**
 * Paper fill-simulation variants stored side-by-side per decision.
 * NOTE: existing pnl_records semantics are UNCHANGED — they remain the
 * QUEUE_REPLAY paper path. Variants land additionally in paper_variant_results.
 */
export const PAPER_FILL_VARIANTS = ["OPTIMISTIC_TOUCH", "QUEUE_REPLAY", "CONSERVATIVE_STRESS"] as const;
export type PaperFillVariant = (typeof PAPER_FILL_VARIANTS)[number];

/** Result of simulating one decision under one paper-fill variant. */
export interface PaperVariantResult {
  id: string;
  correlationId: string;
  decisionId: string;
  marketId: string;
  variant: PaperFillVariant;
  filled: boolean;
  /** 0n when not filled. */
  fillPrice6: Prob6;
  /** 0n when not filled. */
  fillSize6: Shares6;
  fee6: Usdc6;
  /** Null until resolution settles the variant's position. */
  pnl6: Usdc6 | null;
  detail: Record<string, unknown> | null;
  tsMs: number;
  configVersion: number;
}

/**
 * Fill-selection (adverse-selection) cost over a window:
 * signalConditionedValue6 = mean settled value per unit stake conditioned on
 * signal firing (all signals, filled or not); fillConditionedValue6 = same but
 * conditioned on actually filling. cost6 = signalConditionedValue6 -
 * fillConditionedValue6 (positive = fills are adversely selected). Signed
 * micro-USDC units.
 */
export interface FillSelectionCostRecord {
  id: string;
  correlationId: string;
  /** Null = aggregate across all markets in the window. */
  marketId: string | null;
  signalConditionedValue6: bigint;
  fillConditionedValue6: bigint;
  cost6: bigint;
  signalSampleCount: number;
  fillSampleCount: number;
  windowStartMs: number;
  windowEndMs: number;
  tsMs: number;
  configVersion: number;
}
