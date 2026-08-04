import { describe, expect, it } from "vitest";
import type { PairBookReference } from "../src/contracts";
import { calculateRecoveryAlternatives, selectRecoveryAction, type RecoveryAlternativesInput } from "../src/recovery";

const ref = (tokenId: string): PairBookReference => ({ tokenId, bookVersion: 1n, connectionEpoch: "e", sourceEventId: "s", contentHash: `h-${tokenId}` });
const base = (overrides: Partial<RecoveryAlternativesInput> = {}): RecoveryAlternativesInput => ({
  bookCaptureId: "capture", residualOutcome: "UP", residualShares6: 1_000_000n,
  residualCostBasis6: 600_000n, upHeldShares6: 1_000_000n, downHeldShares6: 0n,
  currentWorstCaseLoss6: 600_000n, remainingCash6: 1_000_000n, recoveryReserve6: 1_000_000n,
  maximumLockedLoss6: 600_000n, deadlineMs: 2_000,
  complement: { levels: [{ price: 390_000n, size: 1_000_000n }], fee: { ratePpm: 0n, collection: "usdc" }, bookRef: ref("down") },
  liquidation: { levels: [{ price: 550_000n, size: 1_000_000n }], fee: { ratePpm: 0n, collection: "usdc" }, bookRef: ref("up") },
  booksEligible: true, ...overrides,
});

describe("residual recovery", () => {
  it("calculates completion, direct-bid liquidation, and hold alternatives", () => {
    const [complete, liquidate, hold] = calculateRecoveryAlternatives(base());
    expect(complete).toMatchObject({ kind: "COMPLETE_MISSING_LEG", eligible: true, actionQuantity6: 1_000_000n, incrementalCashDelta6: -390_000n, resultingMatchedShares6: 1_000_000n, resultingResidualShares6: 0n, lockedOrWorstCasePnl6: 10_000n });
    expect(liquidate).toMatchObject({ kind: "LIQUIDATE_FILLED_LEG", eligible: true, actionQuantity6: 1_000_000n, incrementalCashDelta6: 550_000n, resultingResidualShares6: 0n, lockedOrWorstCasePnl6: -50_000n });
    expect(hold).toMatchObject({ kind: "HOLD_TO_RESOLUTION", lockedOrWorstCasePnl6: -600_000n, executableMark6: 550_000n });
  });

  it("allows bounded partial FAK liquidation and never calls the unsold remainder flat", () => {
    const liquidate = calculateRecoveryAlternatives(base({ liquidation: { levels: [{ price: 550_000n, size: 400_000n }], fee: { ratePpm: 0n, collection: "usdc" }, bookRef: ref("up") } }))[1]!;
    expect(liquidate).toMatchObject({ eligible: true, actionQuantity6: 400_000n, resultingResidualShares6: 600_000n, incrementalCashDelta6: 220_000n, lockedOrWorstCasePnl6: -380_000n });
  });

  it("rejects insufficient/cap-bound complement and stale recovery books", () => {
    const alternatives = calculateRecoveryAlternatives(base({ recoveryReserve6: 100_000n, booksEligible: false }));
    expect(alternatives[0]).toMatchObject({ eligible: false, rejectionCodes: expect.arrayContaining(["RECOVERY_BOOK_INELIGIBLE", "INSUFFICIENT_COMPLEMENT_DEPTH_OR_CASH"]) });
    expect(alternatives[1]).toMatchObject({ eligible: false, rejectionCodes: expect.arrayContaining(["RECOVERY_BOOK_INELIGIBLE"]) });
    expect(alternatives[2]!.eligible).toBe(true);
  });

  it("rejects share-fee completion that does not produce equal net holdings", () => {
    const complete = calculateRecoveryAlternatives(base({ complement: { levels: [{ price: 390_000n, size: 1_000_000n }], fee: { ratePpm: 70_000n, collection: "shares" }, bookRef: ref("down") } }))[0]!;
    expect(complete).toMatchObject({ eligible: false, rejectionCodes: expect.arrayContaining(["COMPLEMENT_NET_SHARE_MISMATCH"]) });
  });

  it("default policy always takes zero action", () => {
    const alternatives = calculateRecoveryAlternatives(base());
    expect(selectRecoveryAction({ policy: "NO_AUTO_RECOVERY", alternatives, nowMs: 1_000, deadlineMs: 2_000, recoveryAttempts: 0, maximumRecoveryAttempts: 0, initialOutcomeUnknown: false, halted: false })).toEqual({ kind: "SKIP", reason: "NO_AUTO_RECOVERY", policyVersion: "recovery_policy_v1" });
  });

  it("enforces unknown, halt, exact deadline, and one-attempt hard restrictions", () => {
    const alternatives = calculateRecoveryAlternatives(base());
    const request = { policy: "PAPER_COMPLETE_MISSING_LEG" as const, alternatives, nowMs: 2_000, deadlineMs: 2_000, recoveryAttempts: 0, maximumRecoveryAttempts: 1 as const, initialOutcomeUnknown: false, halted: false };
    expect(selectRecoveryAction(request).kind).toBe("ACT");
    expect(selectRecoveryAction({ ...request, nowMs: 2_001 })).toMatchObject({ kind: "SKIP", reason: "RECOVERY_DEADLINE_EXCEEDED" });
    expect(selectRecoveryAction({ ...request, initialOutcomeUnknown: true })).toMatchObject({ kind: "SKIP", reason: "INITIAL_OUTCOME_UNKNOWN" });
    expect(selectRecoveryAction({ ...request, halted: true })).toMatchObject({ kind: "SKIP", reason: "ENGINE_HALTED" });
    expect(selectRecoveryAction({ ...request, recoveryAttempts: 1 })).toMatchObject({ kind: "SKIP", reason: "RECOVERY_ATTEMPT_LIMIT" });
  });

  it("selects policies deterministically and minimize-worst-loss prefers less loss", () => {
    const alternatives = calculateRecoveryAlternatives(base());
    const request = { alternatives, nowMs: 1_000, deadlineMs: 2_000, recoveryAttempts: 0, maximumRecoveryAttempts: 1 as const, initialOutcomeUnknown: false, halted: false };
    expect(selectRecoveryAction({ ...request, policy: "PAPER_COMPLETE_MISSING_LEG" })).toMatchObject({ kind: "ACT", alternative: { kind: "COMPLETE_MISSING_LEG" } });
    expect(selectRecoveryAction({ ...request, policy: "PAPER_LIQUIDATE_FILLED_LEG" })).toMatchObject({ kind: "ACT", alternative: { kind: "LIQUIDATE_FILLED_LEG" } });
    expect(selectRecoveryAction({ ...request, policy: "PAPER_MINIMIZE_WORST_LOSS" })).toMatchObject({ kind: "ACT", alternative: { kind: "COMPLETE_MISSING_LEG" }, policyVersion: "minimize_worst_loss_v1" });
  });

  it("uses no future resolution input", () => {
    expect(Object.keys(base())).not.toContain("resolution");
  });
});
