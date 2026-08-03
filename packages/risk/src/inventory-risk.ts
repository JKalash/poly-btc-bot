import {
  fmtProb, fmtShares, fmtUsdc, isLegOpen, isRiskFree, mulDiv, PPM, ppm, shares, usdc,
  type CtfOperation, type Mode, type PairedCycleState, type PairedLeg,
  type PairedQuoteCycle, type Ppm, type Shares6, type Usdc6,
} from "@b5p/domain";

/**
 * Phase 3 — inventory / market-making risk (paired quote cycles, CTF ops).
 *
 * Pure, deterministic evaluation in the exact style of evaluate.ts: the caller
 * assembles a complete, derived-fact context; this module returns EVERY failing
 * reason, never just the first. There is no sizing output here by construction:
 * this module can only REJECT — it can never authorize exposure, so no path
 * through it can exceed the absolute caps enforced by computeSizing().
 *
 * Every code below is a HARD reject. The live-arm acknowledgement bypasses
 * exactly the two governance gates inside governanceForMode() and nothing else;
 * none of these codes can be cleared by arming, by construction (the override
 * exists only inside governanceForMode and only produces those two booleans).
 *
 * The paired-cycle facts come from the @b5p/domain inventory model
 * (PairedQuoteCycle / PairedLeg state machines, the isRiskFree predicate,
 * CtfOperation, and Rebate/LiquidityReward accruals realized only at PAID);
 * deriveCycleFacts() below maps those records onto this context.
 */

export type InventoryRejectionCode =
  | "PAIRED_LIVE_NOT_ALLOWED"
  | "RISK_FREE_LABEL_WITH_OPEN_LEG"
  | "ONE_LEG_DURATION_EXCEEDED"
  | "UNHEDGED_EXPOSURE_EXCEEDED"
  | "REWARD_REQUIRED_FOR_POSITIVE_EV"
  | "PENDING_CTF_VALUE_EXCEEDED"
  | "INTENT_ATTEMPTS_EXHAUSTED"
  | "CANCEL_UNCERTAINTY_TIMEOUT"
  | "OUTCOME_INVENTORY_EXCEEDED"
  | "GROSS_PAIRED_INVENTORY_EXCEEDED"
  | "OPERATIONAL_LOSS_STOP"
  | "SOURCE_CLAIM_ALLOCATION_EXCEEDED";

export interface InventoryRejection {
  code: InventoryRejectionCode;
  message: string;
}

/**
 * ALL inventory codes are hard rejects: non-overridable, never cleared by the
 * live-arm governance bypass. Exported so tests can assert the full set.
 */
export const INVENTORY_HARD_REJECT_CODES: ReadonlySet<InventoryRejectionCode> = new Set<InventoryRejectionCode>([
  "PAIRED_LIVE_NOT_ALLOWED",
  "RISK_FREE_LABEL_WITH_OPEN_LEG",
  "ONE_LEG_DURATION_EXCEEDED",
  "UNHEDGED_EXPOSURE_EXCEEDED",
  "REWARD_REQUIRED_FOR_POSITIVE_EV",
  "PENDING_CTF_VALUE_EXCEEDED",
  "INTENT_ATTEMPTS_EXHAUSTED",
  "CANCEL_UNCERTAINTY_TIMEOUT",
  "OUTCOME_INVENTORY_EXCEEDED",
  "GROSS_PAIRED_INVENTORY_EXCEEDED",
  "OPERATIONAL_LOSS_STOP",
  "SOURCE_CLAIM_ALLOCATION_EXCEEDED",
]);

/** Config-shaped limits (see config-requests for the requested keys/defaults). */
export interface InventoryRiskLimits {
  /**
   * Paired/CTF market-making flow live-eligibility. Research-only by policy:
   * false in every shipped default, and the requested config key is a
   * z.literal(false) so no configuration can flip it in this release.
   */
  livePairedAllowed: boolean;
  /** Max unhedged paired-cycle exposure as a fraction of bankroll (ppm). */
  maxUnhedgedRiskFractionPpm: Ppm;
  /** Max time one leg may stay open before hedge/cancel MUST have resolved. */
  maxOneLegDurationMs: number;
  /** Max order attempts per intent (reconcile-before-retry discipline). */
  maxAttemptsPerIntent: number;
  /** Max time a cancel may remain in an unknown/unconfirmed state. */
  maxCancelUncertaintyMs: number;
  /** Max total value of pending (unreconciled) CTF split/merge/redeem ops. */
  maxPendingCtfValue6: Usdc6;
  /** Max inventory per outcome side (micro-shares; 1 share ≤ 1 USDC worst case). */
  maxOutcomeInventory6: Shares6;
  /** Max gross paired inventory, UP + DOWN (micro-shares). */
  maxGrossPairedInventory6: Shares6;
  /** Max daily operational + reconciliation loss (micro-USDC) before halting. */
  maxDailyOperationalLoss6: Usdc6;
  /** Max capital allocated to SOURCE_REPRODUCTION strategies (fraction of bankroll, ppm). */
  maxSourceClaimAllocationPpm: Ppm;
}

/**
 * Defaults mirror the refinement brief's inventory_research config example
 * (one-leg 2s, unhedged 1% of bankroll, one attempt per intent) plus
 * conservative values for the remaining caps. Config keys are requested — not
 * created — by this package; see the Phase-3 config request document.
 */
export const DEFAULT_INVENTORY_RISK_LIMITS: InventoryRiskLimits = {
  livePairedAllowed: false,
  maxUnhedgedRiskFractionPpm: ppm("0.01"),
  maxOneLegDurationMs: 2_000,
  maxAttemptsPerIntent: 1,
  maxCancelUncertaintyMs: 2_000,
  maxPendingCtfValue6: usdc("50"),
  maxOutcomeInventory6: shares("200"),
  maxGrossPairedInventory6: shares("400"),
  maxDailyOperationalLoss6: usdc("20"),
  maxSourceClaimAllocationPpm: ppm("0.05"),
};

/**
 * Derived-fact context, assembled by the caller from PairedQuoteCycle,
 * PairedLeg, CtfOperation and accrual records. Same philosophy as RiskContext:
 * facts in, verdict out, no I/O, no clocks.
 */
export interface InventoryRiskContext {
  limits: InventoryRiskLimits;
  /** Mode of the paired/CTF flow being evaluated ("live" is policy-blocked). */
  mode: Mode;
  /** Current reconciled bankroll (micro-USDC) — denominates fraction caps. */
  bankroll6: Usdc6;

  // paired-cycle facts (derive with deriveCycleFacts() from domain records)
  /** PairedQuoteCycle state (R10 machine), e.g. "QUOTING_BOTH". */
  cycleState: PairedCycleState;
  /** What the strategy/UI CLAIMS about this flow. */
  labeledRiskFree: boolean;
  /** Output of the domain isRiskFree(cycle, legs) predicate. */
  computedRiskFree: boolean;
  /** Any leg not closed (domain isLegOpen: not HEDGED/CANCELED/SETTLED). Symmetric resting quotes count as open. */
  hasOpenLeg: boolean;
  /** One-sided net fills exist (leg PARTIAL_LEG/UNHEDGED, or cycle ONE_LEG_FILLED/HEDGE_OR_CANCEL) — directional exposure. */
  hasUnhedgedFills: boolean;
  /** How long the one-sided exposure has been open; null when hasUnhedgedFills is false. Unknown while exposed = reject. */
  oneLegOpenMs: number | null;
  /** Worst-case unhedged exposure of the cycle right now (micro-USDC). */
  unhedgedExposure6: Usdc6;

  // execution facts
  /** Order attempts ALREADY made for this intent (this evaluation asks for one more). */
  attemptsForIntent: number;
  /** Age of an unconfirmed cancel (ms); null when no cancel is in flight. */
  cancelUncertaintyMs: number | null;
  /** Total value of pending, unreconciled CTF operations (micro-USDC). */
  pendingCtfValue6: Usdc6;

  // inventory facts (micro-shares), including what this decision would add
  upInventory6: Shares6;
  downInventory6: Shares6;

  // loss / allocation facts
  /** Realized operational + reconciliation loss today (positive = loss, micro-USDC). */
  dailyOperationalLoss6: Usdc6;
  /** True when this decision allocates capital to a SOURCE_REPRODUCTION strategy. */
  isSourceReproductionStrategy: boolean;
  /** Total capital allocated to SOURCE_REPRODUCTION strategies including this request (micro-USDC). */
  sourceClaimAllocation6: Usdc6;

  // EV decomposition (per-cost, ppm). Rebate/LiquidityReward accruals carry a
  // discriminated AccrualStatus: realized:true is unrepresentable off PAID.
  /**
   * Pre-trade EV per cost counting ONLY realized incentive totals (accruals
   * with realized:true, i.e. state PAID); null when not computed.
   */
  evExcludingUnpaidIncentivesPpm: Ppm | null;
  /** Pre-trade EV per cost INCLUDING projected unpaid rebates/rewards; null when not computed. */
  evIncludingUnpaidIncentivesPpm: Ppm | null;
}

export interface InventoryRiskVerdict {
  approved: boolean;
  reasons: InventoryRejection[];
}

const r = (code: InventoryRejectionCode, message: string): InventoryRejection => ({ code, message });

/**
 * Evaluate every inventory/market-making gate; returns ALL failing reasons.
 * Rejection-only: this function cannot enlarge any stake or exposure that
 * evaluate.ts/computeSizing would otherwise authorize.
 */
export function evaluateInventoryRisk(ctx: InventoryRiskContext): InventoryRiskVerdict {
  const reasons: InventoryRejection[] = [];
  const L = ctx.limits;

  // HARD: paired/CTF market-making flow is paper/shadow research by policy.
  // Not a governance gate — arming cannot clear it.
  if (ctx.mode === "live" && !L.livePairedAllowed) {
    reasons.push(r("PAIRED_LIVE_NOT_ALLOWED",
      "Paired/CTF market-making flow is not live-eligible in this release (research-only by policy)."));
  }

  // (a) HARD: a split-sell / buy-both flow may never be labeled or computed
  // risk-free while a leg is open. "Risk-free" is earned at RECONCILED, not claimed.
  if ((ctx.labeledRiskFree || ctx.computedRiskFree) && ctx.hasOpenLeg) {
    reasons.push(r("RISK_FREE_LABEL_WITH_OPEN_LEG",
      `Flow is ${ctx.labeledRiskFree ? "labeled" : "computed"} risk-free while a leg is open (state ${ctx.cycleState}); one-leg exposure is directional risk.`));
  }

  // (b) HARD: one-sided fills open beyond the duration budget (unknown duration while exposed = exceeded).
  if (ctx.hasUnhedgedFills && (ctx.oneLegOpenMs === null || ctx.oneLegOpenMs > L.maxOneLegDurationMs)) {
    reasons.push(r("ONE_LEG_DURATION_EXCEEDED",
      `One leg exposed for ${ctx.oneLegOpenMs ?? "unknown"}ms exceeds the ${L.maxOneLegDurationMs}ms budget; hedge or cancel must already have resolved.`));
  }

  // (b) HARD: one-leg / unhedged exposure beyond its loss budget.
  const unhedgedBudget6 = mulDiv(ctx.bankroll6 > 0n ? ctx.bankroll6 : 0n, L.maxUnhedgedRiskFractionPpm, PPM, "floor");
  if (ctx.unhedgedExposure6 > unhedgedBudget6) {
    reasons.push(r("UNHEDGED_EXPOSURE_EXCEEDED",
      `Unhedged paired exposure ${fmtUsdc(ctx.unhedgedExposure6)} USDC exceeds the budget ${fmtUsdc(unhedgedBudget6)} USDC (${fmtProb(L.maxUnhedgedRiskFractionPpm)} of bankroll).`));
  }

  // (c) HARD: EV that is only positive WITH unpaid rebates/rewards is not positive EV.
  // Accruals are realized only at PAID; pre-trade EV must stand without them.
  const evWith = ctx.evIncludingUnpaidIncentivesPpm;
  const evWithout = ctx.evExcludingUnpaidIncentivesPpm;
  if (evWith !== null && evWith > 0n && (evWithout === null || evWithout <= 0n)) {
    reasons.push(r("REWARD_REQUIRED_FOR_POSITIVE_EV",
      `Pre-trade EV is positive only when unpaid rebates/rewards are counted (with: ${fmtProb(evWith)}, without: ${evWithout === null ? "not computed" : fmtProb(evWithout)}). Rebate not included until paid.`));
  }

  // (d) HARD: pending CTF (split/merge/redeem) value above cap.
  if (ctx.pendingCtfValue6 > L.maxPendingCtfValue6) {
    reasons.push(r("PENDING_CTF_VALUE_EXCEEDED",
      `Pending CTF operation value ${fmtUsdc(ctx.pendingCtfValue6)} USDC exceeds the ${fmtUsdc(L.maxPendingCtfValue6)} USDC cap; reconcile before adding more.`));
  }

  // Cap: attempts per intent (this evaluation requests attempt N+1).
  if (ctx.attemptsForIntent >= L.maxAttemptsPerIntent) {
    reasons.push(r("INTENT_ATTEMPTS_EXHAUSTED",
      `Intent already has ${ctx.attemptsForIntent} attempt(s); limit is ${L.maxAttemptsPerIntent}. Reconcile before any further attempt.`));
  }

  // Cap: cancel uncertainty duration.
  if (ctx.cancelUncertaintyMs !== null && ctx.cancelUncertaintyMs > L.maxCancelUncertaintyMs) {
    reasons.push(r("CANCEL_UNCERTAINTY_TIMEOUT",
      `A cancel has been unconfirmed for ${ctx.cancelUncertaintyMs}ms (limit ${L.maxCancelUncertaintyMs}ms); order state must reconcile first.`));
  }

  // Cap: per-outcome inventory.
  if (ctx.upInventory6 > L.maxOutcomeInventory6 || ctx.downInventory6 > L.maxOutcomeInventory6) {
    const side = ctx.upInventory6 > L.maxOutcomeInventory6 && ctx.downInventory6 > L.maxOutcomeInventory6
      ? "UP and DOWN" : ctx.upInventory6 > L.maxOutcomeInventory6 ? "UP" : "DOWN";
    reasons.push(r("OUTCOME_INVENTORY_EXCEEDED",
      `${side} inventory (UP ${fmtShares(ctx.upInventory6)}, DOWN ${fmtShares(ctx.downInventory6)} shares) exceeds the per-outcome cap ${fmtShares(L.maxOutcomeInventory6)} shares.`));
  }

  // Cap: gross paired inventory.
  const gross6 = ctx.upInventory6 + ctx.downInventory6;
  if (gross6 > L.maxGrossPairedInventory6) {
    reasons.push(r("GROSS_PAIRED_INVENTORY_EXCEEDED",
      `Gross paired inventory ${fmtShares(gross6)} shares exceeds the cap ${fmtShares(L.maxGrossPairedInventory6)} shares.`));
  }

  // Cap: daily operational/reconciliation loss stop (>= like the drawdown stops).
  if (ctx.dailyOperationalLoss6 >= L.maxDailyOperationalLoss6) {
    reasons.push(r("OPERATIONAL_LOSS_STOP",
      `Daily operational/reconciliation loss ${fmtUsdc(ctx.dailyOperationalLoss6)} USDC reached the ${fmtUsdc(L.maxDailyOperationalLoss6)} USDC stop. Manual review required.`));
  }

  // Cap: capital allocated to SOURCE_REPRODUCTION strategies.
  if (ctx.isSourceReproductionStrategy) {
    const allocBudget6 = mulDiv(ctx.bankroll6 > 0n ? ctx.bankroll6 : 0n, L.maxSourceClaimAllocationPpm, PPM, "floor");
    if (ctx.sourceClaimAllocation6 > allocBudget6) {
      reasons.push(r("SOURCE_CLAIM_ALLOCATION_EXCEEDED",
        `Source-reproduction allocation ${fmtUsdc(ctx.sourceClaimAllocation6)} USDC exceeds the budget ${fmtUsdc(allocBudget6)} USDC (${fmtProb(L.maxSourceClaimAllocationPpm)} of bankroll). Source claims are not verified edges.`));
    }
  }

  return { approved: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------------ *
 * Adapter from the @b5p/domain inventory records to the paired-cycle slice
 * of InventoryRiskContext. Pure; nowMs is passed in, never read from a clock.
 * ------------------------------------------------------------------------ */

export interface PairedCycleFacts {
  cycleState: PairedCycleState;
  computedRiskFree: boolean;
  hasOpenLeg: boolean;
  hasUnhedgedFills: boolean;
  oneLegOpenMs: number | null;
  unhedgedExposure6: Usdc6;
}

/** Cycle states that are themselves one-sided directional exposure. */
const UNHEDGED_CYCLE_STATES: ReadonlySet<PairedCycleState> = new Set<PairedCycleState>([
  "ONE_LEG_FILLED", "HEDGE_OR_CANCEL",
]);

/** Leg states carrying net fills without a matched sibling/hedge. */
const UNHEDGED_LEG_STATES: ReadonlySet<PairedLeg["state"]> = new Set<PairedLeg["state"]>([
  "PARTIAL_LEG", "UNHEDGED",
]);

/**
 * Derive the risk facts from a cycle and ALL of its legs (same requirement as
 * the domain isRiskFree predicate — never pass a subset of legs).
 *
 *  - hasOpenLeg uses domain isLegOpen (symmetric resting quotes ARE open, so a
 *    QUOTING_BOTH cycle can never be presented as risk-free).
 *  - hasUnhedgedFills is the stricter directional fact that drives the
 *    one-leg duration and unhedged-exposure budgets.
 *  - oneLegOpenMs: the WORST of (a) the cycle's accumulated unhedgedDurationMs
 *    (the designed budget input) and (b) the age of the earliest known
 *    unhedged timestamp (leg unhedgedStartedAtMs, else cycle
 *    oneLegFilledAtMs); null while exposed means unknown, which
 *    evaluateInventoryRisk treats as exceeded.
 *  - unhedgedExposure6 is the cycle's planned worst-case failure-path loss
 *    while exposed (conservative by construction), 0 otherwise.
 */
export function deriveCycleFacts(
  cycle: Pick<PairedQuoteCycle, "state" | "worstCaseLoss6" | "oneLegFilledAtMs" | "unhedgedDurationMs">,
  legs: readonly Pick<PairedLeg, "state" | "unhedgedStartedAtMs">[],
  nowMs: number,
): PairedCycleFacts {
  const hasUnhedgedFills =
    UNHEDGED_CYCLE_STATES.has(cycle.state) || legs.some((l) => UNHEDGED_LEG_STATES.has(l.state));

  let oneLegOpenMs: number | null = null;
  if (hasUnhedgedFills) {
    const candidates: number[] = [];
    if (cycle.unhedgedDurationMs !== null) candidates.push(cycle.unhedgedDurationMs);
    const stamps = legs
      .map((l) => l.unhedgedStartedAtMs)
      .filter((t): t is number => t !== null);
    if (cycle.oneLegFilledAtMs !== null) stamps.push(cycle.oneLegFilledAtMs);
    if (stamps.length > 0) candidates.push(Math.max(0, nowMs - Math.min(...stamps)));
    if (candidates.length > 0) oneLegOpenMs = Math.max(...candidates);
  }

  return {
    cycleState: cycle.state,
    computedRiskFree: isRiskFree(cycle, legs),
    hasOpenLeg: legs.some((l) => isLegOpen(l)),
    hasUnhedgedFills,
    oneLegOpenMs,
    unhedgedExposure6: hasUnhedgedFills ? cycle.worstCaseLoss6 : 0n,
  };
}

/**
 * Value of CTF operations that are pending or of uncertain outcome, for the
 * maxPendingCtfValue6 cap. One micro paired-unit corresponds to one micro-USDC
 * of collateral (split: 1 USDC <-> 1 Up + 1 Down), so pending paired units map
 * 1:1 onto micro-USDC.
 *
 *  - PLANNED / SUBMITTED: full requested amount is pending.
 *  - PARTIALLY_CONFIRMED: the unconfirmed remainder is pending.
 *  - UNKNOWN: the FULL requested amount counts (outcome ambiguous — the
 *    conservative reading is that all of it is still at risk until on-chain
 *    reconciliation resolves it).
 *  - CONFIRMED / FAILED: nothing pending.
 */
export function derivePendingCtfValue6(
  ops: readonly Pick<CtfOperation, "state" | "requestedAmount6" | "confirmedAmount6">[],
): Usdc6 {
  let pending6 = 0n;
  for (const op of ops) {
    switch (op.state) {
      case "PLANNED":
      case "SUBMITTED":
      case "UNKNOWN":
        pending6 += op.requestedAmount6;
        break;
      case "PARTIALLY_CONFIRMED": {
        const remainder = op.requestedAmount6 - (op.confirmedAmount6 ?? 0n);
        if (remainder > 0n) pending6 += remainder;
        break;
      }
      case "CONFIRMED":
      case "FAILED":
        break;
    }
  }
  return pending6;
}
