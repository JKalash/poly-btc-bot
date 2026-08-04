import { mulDiv, type BookLevel, type Shares6, type Usdc6 } from "@b5p/domain";
import type { PairBookReference, PairOutcome, PairRecoveryPolicy } from "./contracts";
import { quoteDirectBuy, quoteDirectSell, type QuoteFeeSnapshot } from "./quote";

export type RecoveryAlternativeKind = "COMPLETE_MISSING_LEG" | "LIQUIDATE_FILLED_LEG" | "HOLD_TO_RESOLUTION";

export interface RecoveryBookInput {
  readonly levels: readonly Readonly<BookLevel>[];
  readonly fee: QuoteFeeSnapshot;
  readonly bookRef: PairBookReference;
}

export interface RecoveryAlternativesInput {
  readonly bookCaptureId: string;
  readonly residualOutcome: PairOutcome;
  readonly residualShares6: Shares6;
  readonly residualCostBasis6: Usdc6;
  readonly upHeldShares6: Shares6;
  readonly downHeldShares6: Shares6;
  readonly currentWorstCaseLoss6: Usdc6;
  readonly remainingCash6: Usdc6;
  readonly recoveryReserve6: Usdc6;
  readonly maximumLockedLoss6: Usdc6;
  readonly deadlineMs: number;
  readonly complement: RecoveryBookInput;
  readonly liquidation: RecoveryBookInput;
  readonly booksEligible: boolean;
}

export interface RecoveryAlternative {
  readonly kind: RecoveryAlternativeKind;
  readonly eligible: boolean;
  readonly rejectionCodes: readonly string[];
  readonly bookCaptureId: string;
  readonly actionQuantity6: Shares6;
  /** Positive is cash received; negative is cash spent. */
  readonly incrementalCashDelta6: bigint;
  readonly resultingUpShares6: Shares6;
  readonly resultingDownShares6: Shares6;
  readonly resultingMatchedShares6: Shares6;
  readonly resultingResidualShares6: Shares6;
  readonly lockedOrWorstCasePnl6: bigint;
  readonly maximumAdditionalLoss6: Usdc6;
  readonly deadlineMs: number;
  readonly executableMark6: Usdc6 | null;
}

export interface RecoverySelectionInput {
  readonly policy: PairRecoveryPolicy;
  readonly alternatives: readonly RecoveryAlternative[];
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly recoveryAttempts: number;
  readonly maximumRecoveryAttempts: 0 | 1;
  readonly initialOutcomeUnknown: boolean;
  readonly halted: boolean;
}

export type RecoverySelection =
  | { readonly kind: "SKIP"; readonly reason: string; readonly policyVersion: string }
  | { readonly kind: "ACT"; readonly alternative: RecoveryAlternative; readonly policyVersion: string };

const min = (a: bigint, b: bigint): bigint => a < b ? a : b;
const lossOf = (pnl: bigint): bigint => pnl < 0n ? -pnl : 0n;

function holdings(input: RecoveryAlternativesInput, complementAdded: bigint, residualSold: bigint) {
  const up = input.upHeldShares6
    + (input.residualOutcome === "DOWN" ? complementAdded : 0n)
    - (input.residualOutcome === "UP" ? residualSold : 0n);
  const down = input.downHeldShares6
    + (input.residualOutcome === "UP" ? complementAdded : 0n)
    - (input.residualOutcome === "DOWN" ? residualSold : 0n);
  const matched = min(up, down);
  return { up, down, matched, residual: up > down ? up - down : down - up };
}

export function calculateRecoveryAlternatives(input: RecoveryAlternativesInput): readonly RecoveryAlternative[] {
  if (input.residualShares6 <= 0n || input.residualCostBasis6 < 0n) throw new RangeError("recovery requires positive residual shares and non-negative basis");
  const cashCap = min(input.remainingCash6, input.recoveryReserve6);
  const completeQuote = quoteDirectBuy({
    levels: input.complement.levels, requestedShares6: input.residualShares6,
    cashCap6: cashCap, fee: input.complement.fee, timeInForce: "FOK", bookRef: input.complement.bookRef,
  });
  const completeReasons: string[] = [];
  let completeQuantity = 0n;
  let completeDebit = 0n;
  let completePnl = -input.residualCostBasis6;
  if (!input.booksEligible) completeReasons.push("RECOVERY_BOOK_INELIGIBLE");
  if (!completeQuote.ok) completeReasons.push(completeQuote.reason);
  else if (!completeQuote.quote.fullyExecutable) completeReasons.push("INSUFFICIENT_COMPLEMENT_DEPTH_OR_CASH");
  else {
    completeQuantity = completeQuote.quote.filledGrossShares6;
    completeDebit = completeQuote.quote.principal6 + completeQuote.quote.feeCash6;
    if (completeQuote.quote.receivedNetShares6 !== input.residualShares6) completeReasons.push("COMPLEMENT_NET_SHARE_MISMATCH");
    completePnl = input.residualShares6 - input.residualCostBasis6 - completeDebit;
    if (lossOf(completePnl) > input.maximumLockedLoss6) completeReasons.push("LOCKED_COMPLETION_LOSS_EXCEEDED");
    if (lossOf(completePnl) > input.currentWorstCaseLoss6) completeReasons.push("RECOVERY_INCREASES_WORST_LOSS");
  }
  const completeHoldings = holdings(input, completeQuote.ok ? completeQuote.quote.receivedNetShares6 : 0n, 0n);
  const completeLoss = lossOf(completePnl);
  const complete: RecoveryAlternative = Object.freeze({
    kind: "COMPLETE_MISSING_LEG", eligible: completeReasons.length === 0,
    rejectionCodes: Object.freeze(completeReasons), bookCaptureId: input.bookCaptureId,
    actionQuantity6: completeQuantity, incrementalCashDelta6: -completeDebit,
    resultingUpShares6: completeHoldings.up, resultingDownShares6: completeHoldings.down,
    resultingMatchedShares6: completeHoldings.matched, resultingResidualShares6: completeHoldings.residual,
    lockedOrWorstCasePnl6: completePnl,
    maximumAdditionalLoss6: completeLoss > input.currentWorstCaseLoss6 ? completeLoss - input.currentWorstCaseLoss6 : 0n,
    deadlineMs: input.deadlineMs, executableMark6: null,
  });

  const sellQuote = quoteDirectSell({
    levels: input.liquidation.levels, requestedShares6: input.residualShares6,
    availableShares6: input.residualShares6, fee: input.liquidation.fee,
    timeInForce: "FAK", bookRef: input.liquidation.bookRef,
  });
  const liquidationReasons: string[] = [];
  let sold = 0n;
  let proceeds = 0n;
  let liquidationWorstPnl = -input.residualCostBasis6;
  if (!input.booksEligible) liquidationReasons.push("RECOVERY_BOOK_INELIGIBLE");
  if (!sellQuote.ok) liquidationReasons.push(sellQuote.reason);
  else {
    sold = sellQuote.quote.filledGrossShares6;
    proceeds = sellQuote.quote.principal6 - sellQuote.quote.feeCash6;
    if (sold === 0n) liquidationReasons.push("NO_EXECUTABLE_LIQUIDATION_DEPTH");
    const allocatedBasis = sold === 0n ? 0n : mulDiv(input.residualCostBasis6, sold, input.residualShares6, "ceil");
    const remainingBasis = input.residualCostBasis6 - allocatedBasis;
    liquidationWorstPnl = proceeds - allocatedBasis - remainingBasis;
    if (lossOf(liquidationWorstPnl) > input.maximumLockedLoss6) liquidationReasons.push("LIQUIDATION_LOSS_ENVELOPE_EXCEEDED");
  }
  const liquidationHoldings = holdings(input, 0n, sold);
  const liquidationLoss = lossOf(liquidationWorstPnl);
  const liquidation: RecoveryAlternative = Object.freeze({
    kind: "LIQUIDATE_FILLED_LEG", eligible: liquidationReasons.length === 0,
    rejectionCodes: Object.freeze(liquidationReasons), bookCaptureId: input.bookCaptureId,
    actionQuantity6: sold, incrementalCashDelta6: proceeds,
    resultingUpShares6: liquidationHoldings.up, resultingDownShares6: liquidationHoldings.down,
    resultingMatchedShares6: liquidationHoldings.matched, resultingResidualShares6: liquidationHoldings.residual,
    lockedOrWorstCasePnl6: liquidationWorstPnl,
    maximumAdditionalLoss6: liquidationLoss > input.currentWorstCaseLoss6 ? liquidationLoss - input.currentWorstCaseLoss6 : 0n,
    deadlineMs: input.deadlineMs, executableMark6: proceeds,
  });

  const holdMark = sellQuote.ok ? sellQuote.quote.principal6 - sellQuote.quote.feeCash6 : null;
  const holdHoldings = holdings(input, 0n, 0n);
  const hold: RecoveryAlternative = Object.freeze({
    kind: "HOLD_TO_RESOLUTION", eligible: true, rejectionCodes: Object.freeze([]),
    bookCaptureId: input.bookCaptureId, actionQuantity6: 0n, incrementalCashDelta6: 0n,
    resultingUpShares6: holdHoldings.up, resultingDownShares6: holdHoldings.down,
    resultingMatchedShares6: holdHoldings.matched, resultingResidualShares6: holdHoldings.residual,
    lockedOrWorstCasePnl6: -input.residualCostBasis6,
    maximumAdditionalLoss6: input.residualCostBasis6 > input.currentWorstCaseLoss6 ? input.residualCostBasis6 - input.currentWorstCaseLoss6 : 0n,
    deadlineMs: input.deadlineMs, executableMark6: holdMark,
  });
  return Object.freeze([complete, liquidation, hold]);
}

export function selectRecoveryAction(input: RecoverySelectionInput): RecoverySelection {
  const version = input.policy === "PAPER_MINIMIZE_WORST_LOSS" ? "minimize_worst_loss_v1" : "recovery_policy_v1";
  if (input.policy === "NO_AUTO_RECOVERY") return Object.freeze({ kind: "SKIP", reason: "NO_AUTO_RECOVERY", policyVersion: version });
  if (input.halted) return Object.freeze({ kind: "SKIP", reason: "ENGINE_HALTED", policyVersion: version });
  if (input.initialOutcomeUnknown) return Object.freeze({ kind: "SKIP", reason: "INITIAL_OUTCOME_UNKNOWN", policyVersion: version });
  if (input.nowMs > input.deadlineMs) return Object.freeze({ kind: "SKIP", reason: "RECOVERY_DEADLINE_EXCEEDED", policyVersion: version });
  if (input.maximumRecoveryAttempts !== 1 || input.recoveryAttempts >= input.maximumRecoveryAttempts) {
    return Object.freeze({ kind: "SKIP", reason: "RECOVERY_ATTEMPT_LIMIT", policyVersion: version });
  }
  const eligible = input.alternatives.filter((alternative) => alternative.eligible);
  const named = input.policy === "PAPER_COMPLETE_MISSING_LEG"
    ? eligible.find((a) => a.kind === "COMPLETE_MISSING_LEG")
    : input.policy === "PAPER_LIQUIDATE_FILLED_LEG"
      ? eligible.find((a) => a.kind === "LIQUIDATE_FILLED_LEG")
      : undefined;
  if (input.policy !== "PAPER_MINIMIZE_WORST_LOSS") {
    return named === undefined
      ? Object.freeze({ kind: "SKIP", reason: "POLICY_ALTERNATIVE_INELIGIBLE", policyVersion: version })
      : Object.freeze({ kind: "ACT", alternative: named, policyVersion: version });
  }
  const ranked = eligible.slice().sort((a, b) => {
    if (a.lockedOrWorstCasePnl6 !== b.lockedOrWorstCasePnl6) return a.lockedOrWorstCasePnl6 > b.lockedOrWorstCasePnl6 ? -1 : 1;
    const aSpend = a.incrementalCashDelta6 < 0n ? -a.incrementalCashDelta6 : 0n;
    const bSpend = b.incrementalCashDelta6 < 0n ? -b.incrementalCashDelta6 : 0n;
    if (aSpend !== bSpend) return aSpend < bSpend ? -1 : 1;
    if (a.resultingResidualShares6 !== b.resultingResidualShares6) return a.resultingResidualShares6 < b.resultingResidualShares6 ? -1 : 1;
    if (a.kind === "HOLD_TO_RESOLUTION") return -1;
    if (b.kind === "HOLD_TO_RESOLUTION") return 1;
    return a.kind.localeCompare(b.kind);
  });
  const selected = ranked[0];
  return selected === undefined || selected.kind === "HOLD_TO_RESOLUTION"
    ? Object.freeze({ kind: "SKIP", reason: "HOLD_MINIMIZES_WORST_LOSS", policyVersion: version })
    : Object.freeze({ kind: "ACT", alternative: selected, policyVersion: version });
}
