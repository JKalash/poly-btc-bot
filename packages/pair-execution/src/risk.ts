import { mulDiv, PPM, type Shares6, type Usdc6 } from "@b5p/domain";
import type {
  PairPolicySnapshot,
  PairPortfolioSnapshot,
  PairQuoteEconomics,
  PairRejection,
  PairRejectionCode,
  PairRiskDecision,
  PairStressResult,
} from "./contracts";

const ABSOLUTE_MAX_RISK_FRACTION_PPM = 100_000n;

export interface AggregatePairRiskStateInput {
  readonly upHeldShares6: Shares6;
  readonly downHeldShares6: Shares6;
  readonly netCashDebit6: Usdc6;
  readonly pendingNonrefundableCosts6: Usdc6;
  readonly previousPeakWorstCaseLoss6?: Usdc6;
}

export interface AggregatePairRiskState {
  readonly matchedShares6: Shares6;
  readonly residualShares6: Shares6;
  readonly currentWorstCaseLoss6: Usdc6;
  readonly peakWorstCaseLoss6: Usdc6;
}

/** Exact post-event §14.1 risk state; no displayed-liquidity or recovery credit. */
export function aggregatePairRisk(input: AggregatePairRiskStateInput): AggregatePairRiskState {
  const matchedShares6 = input.upHeldShares6 < input.downHeldShares6 ? input.upHeldShares6 : input.downHeldShares6;
  const residualShares6 = input.upHeldShares6 > input.downHeldShares6
    ? input.upHeldShares6 - input.downHeldShares6
    : input.downHeldShares6 - input.upHeldShares6;
  const rawLoss = input.netCashDebit6 + input.pendingNonrefundableCosts6 - matchedShares6;
  const currentWorstCaseLoss6 = rawLoss > 0n ? rawLoss : 0n;
  const previous = input.previousPeakWorstCaseLoss6 ?? 0n;
  return Object.freeze({
    matchedShares6,
    residualShares6,
    currentWorstCaseLoss6,
    peakWorstCaseLoss6: previous > currentWorstCaseLoss6 ? previous : currentWorstCaseLoss6,
  });
}

export interface EvaluatePairRiskInput {
  readonly marketId: string;
  readonly quoteHash: string;
  readonly quote: PairQuoteEconomics;
  readonly oneTickWorse: PairStressResult;
  readonly twoTicksWorse: PairStressResult;
  readonly portfolio: PairPortfolioSnapshot;
  readonly policy: PairPolicySnapshot;
  readonly nowMs: number;
  readonly permitId: string;
  readonly secondsRemaining?: number;
  readonly termsHealthy?: boolean;
  readonly hasResidualPairInventory?: boolean;
}

function rejection(code: PairRejectionCode, description: string): PairRejection {
  return Object.freeze({ code, description });
}

function fraction(bankroll: Usdc6, ppm: bigint): bigint {
  return mulDiv(bankroll, ppm, PPM, "floor");
}

/**
 * Pure pretrade aggregate risk gate (§14). Quantity is derived only from
 * executable depth, exact economics, cash, and bounded residual exposure.
 */
export function evaluatePairRisk(input: EvaluatePairRiskInput): PairRiskDecision {
  const reasons: PairRejection[] = [];
  const { portfolio, policy, quote } = input;
  const add = (code: PairRejectionCode, description: string): void => { reasons.push(rejection(code, description)); };

  if (!policy.paperSchedulingEnabled) add("PAPER_EXECUTION_DISABLED", "pair paper scheduling is disabled by policy");
  if (portfolio.globalAppMode === "live" || portfolio.directionalLiveArmed) {
    add("MODE_UNSUPPORTED", "pair paper scheduling is isolated from live/armed directional operation");
  }
  if (!portfolio.healthy || input.termsHealthy === false) add("PORTFOLIO_UNRECONCILED", "pair portfolio or token terms health is degraded");
  if (input.secondsRemaining !== undefined && input.secondsRemaining <= policy.entryCutoffSeconds) {
    add("ENTRY_CUTOFF_REACHED", "market has reached the configured entry cutoff");
  }
  if (portfolio.activeDirectionalMarketIds.includes(input.marketId)) add("DIRECTIONAL_ORDER_CONFLICT", "directional order is active for this market");
  if (portfolio.openDirectionalMarketIds.includes(input.marketId)) add("DIRECTIONAL_POSITION_CONFLICT", "directional position is open for this market");
  if (portfolio.activePairMarketIds.includes(input.marketId) || input.hasResidualPairInventory === true) {
    add("ACTIVE_PAIR_CONFLICT", "an active pair or residual pair inventory already owns this market");
  }
  if (portfolio.activePairGroupCount >= policy.maximumActivePairGroups) add("ACTIVE_PAIR_CONFLICT", "maximum active pair groups reached");

  const hardPpm = policy.hardRiskConstant.valuePpm < ABSOLUTE_MAX_RISK_FRACTION_PPM
    ? policy.hardRiskConstant.valuePpm
    : ABSOLUTE_MAX_RISK_FRACTION_PPM;
  const absoluteCashCap6 = fraction(portfolio.referenceBankroll6, hardPpm);
  const configuredCashCap6 = fraction(portfolio.referenceBankroll6, policy.maximumCashFractionPpm);
  const aggregateCashCap6 = fraction(portfolio.referenceBankroll6, policy.maximumAggregateReservedFractionPpm);
  if (quote.reservedCash6 > absoluteCashCap6 || quote.reservedCash6 > configuredCashCap6) {
    add("AGGREGATE_CASH_CAP_EXCEEDED", "whole-group reservation exceeds the configured or absolute cash cap");
  }
  if (portfolio.pairCashReserved6 + quote.reservedCash6 > aggregateCashCap6) {
    add("AGGREGATE_CASH_CAP_EXCEEDED", "portfolio-wide pair reservation cap would be exceeded");
  }
  if (quote.reservedCash6 > portfolio.sharedCapAvailable6 || quote.reservedCash6 > portfolio.pairCashAvailable6) {
    add("AVAILABLE_CASH_INSUFFICIENT", "available pair/shared cash is below the aggregate reservation");
  }

  const residualCap6 = fraction(portfolio.referenceBankroll6, policy.maximumResidualLossFractionPpm);
  const aggregateResidualCap6 = fraction(portfolio.referenceBankroll6, policy.maximumAggregateResidualLossFractionPpm);
  if (quote.worstSingleLegLoss6 > residualCap6) add("RESIDUAL_LOSS_CAP_EXCEEDED", "one-leg worst loss exceeds its cap");
  if (portfolio.aggregatePairWorstCaseLoss6 + quote.worstSingleLegLoss6 > aggregateResidualCap6) {
    add("RESIDUAL_LOSS_CAP_EXCEEDED", "portfolio-wide pair residual-loss cap would be exceeded");
  }

  if (quote.netPnl6 < policy.minimumNetPnl6) add("NET_PNL_BELOW_MINIMUM", "exact net P&L is below the policy minimum");
  if (quote.netReturnPpm < policy.minimumNetReturnPpm) add("NET_RETURN_BELOW_MINIMUM", "floor-rounded net return is below the policy minimum");
  if (policy.requireOneTickStressPositive && (input.oneTickWorse.kind !== "EXECUTABLE" || input.oneTickWorse.netPnl6 <= 0n)) {
    add("ONE_TICK_STRESS_FAILED", "one-tick-worse quote is unavailable or nonpositive");
  }
  if (policy.requireTwoTickStressPositive && (input.twoTicksWorse.kind !== "EXECUTABLE" || input.twoTicksWorse.netPnl6 <= 0n)) {
    add("TWO_TICK_STRESS_FAILED", "two-ticks-worse quote is unavailable or nonpositive");
  }

  const dailyLoss6 = portfolio.pairDailyRealizedPnl6 < 0n ? -portfolio.pairDailyRealizedPnl6 : 0n;
  const dailyCap6 = fraction(portfolio.referenceBankroll6, policy.maximumPairDailyLossFractionPpm);
  const sessionDrawdown6 = portfolio.pairSessionPeakCash6 > portfolio.pairAccountCashBalance6
    ? portfolio.pairSessionPeakCash6 - portfolio.pairAccountCashBalance6
    : 0n;
  const drawdownCap6 = fraction(portfolio.referenceBankroll6, policy.maximumPairSessionDrawdownFractionPpm);
  if (dailyLoss6 >= dailyCap6 || sessionDrawdown6 >= drawdownCap6) {
    add("PORTFOLIO_UNRECONCILED", "pair daily-loss or session-drawdown stop is active");
  }

  if (reasons.length > 0) return Object.freeze({ kind: "REJECTED", reasons: Object.freeze(reasons) });
  const upCashDebit6 = quote.up.principal6 + quote.up.feeCash6;
  const downCashDebit6 = quote.down.principal6 + quote.down.feeCash6;
  const maximumComplementCashDebit6 = upCashDebit6 > downCashDebit6 ? upCashDebit6 : downCashDebit6;
  return Object.freeze({
    kind: "APPROVED",
    permitId: input.permitId,
    approvedQuoteHash: input.quoteHash,
    policyHash: policy.policyHash,
    portfolioHash: portfolio.hash,
    maximumReservedCash6: quote.reservedCash6,
    maximumResidualLoss6: residualCap6,
    upOnlyWorstLoss6: quote.upOnlyWorstLoss6,
    downOnlyWorstLoss6: quote.downOnlyWorstLoss6,
    maximumLockedLossAfterCompletion6: residualCap6,
    maximumComplementCashDebit6,
    issuedAtMs: input.nowMs,
    expiresAtMs: input.nowMs + policy.activationQuoteTtlMs,
  });
}
