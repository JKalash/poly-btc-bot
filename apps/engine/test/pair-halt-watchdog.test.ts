import { describe, expect, it, vi } from "vitest";
import {
  PairHaltWatchdogError,
  commitPairHalt,
  planLateEvidenceAfterWatchdog,
  planPairHalt,
  planPairUnknownWatchdog,
  planUnclaimedEffectExpiry,
  type PairControlGroupSnapshot,
  type PairControlledEffectSnapshot,
  type PairUnknownEffectSnapshot,
} from "../src/pair-halt-watchdog";

const now = 1_800_000_000_000;

function effect(overrides: Partial<PairControlledEffectSnapshot> = {}): PairControlledEffectSnapshot {
  return {
    effectId: "pending",
    kind: "INITIAL",
    outcome: "UP",
    state: "PENDING",
    claimToken: null,
    deadlineMs: now + 100,
    resultEvidenceId: null,
    increasesExposure: true,
    ...overrides,
  };
}

function group(overrides: Partial<PairControlGroupSnapshot> = {}): PairControlGroupSnapshot {
  return {
    groupId: "group",
    state: "SUBMITTING",
    haltedAtMs: null,
    haltReason: null,
    reservedCash6: 2_000_000n,
    upHeldShares6: 1_000_000n,
    downHeldShares6: 0n,
    evidenceKeys: ["evidence-before-halt"],
    effects: [
      effect(),
      effect({ effectId: "claimed", kind: "RECOVERY", state: "CLAIMED", claimToken: "worker", deadlineMs: now + 200 }),
      effect({ effectId: "unknown", kind: "MERGE", state: "OUTCOME_UNKNOWN", claimToken: "old-worker", resultEvidenceId: "unknown-evidence", increasesExposure: false }),
      effect({ effectId: "terminal", state: "SUCCEEDED", resultEvidenceId: "terminal-evidence" }),
    ],
    ...overrides,
  };
}

function unknown(overrides: Partial<PairUnknownEffectSnapshot> = {}): PairUnknownEffectSnapshot {
  return {
    groupId: "group-initial",
    effectId: "effect-initial",
    kind: "INITIAL",
    unknownObservedAtMs: now,
    resolvedEvidenceId: null,
    alreadyManualReview: false,
    reservedCash6: 2_000_000n,
    upHeldShares6: 1_000_000n,
    downHeldShares6: 0n,
    ...overrides,
  };
}

describe("orthogonal pair halt planning", () => {
  it("cancels only unclaimed rows and preserves claims, inventory, reservations, and evidence", () => {
    const plan = planPairHalt({ group: group(), nowMs: now, reason: "operator halt" });
    expect(plan.kind).toBe("HALT_COMMIT_REQUIRED");
    if (plan.kind !== "HALT_COMMIT_REQUIRED") return;
    expect(plan).toMatchObject({ pairGroupCreationAllowed: false, exposureIncreasingEffectsAllowed: false });
    expect(plan.effectUpdates).toEqual([{
      effectId: "pending", expectedState: "PENDING", expectedClaimToken: null,
      nextState: "CANCELED_UNCLAIMED", reason: "PAIR_HALTED:operator halt", updatedAtMs: now,
    }]);
    expect(plan.newEffects).toEqual([]);
    expect(plan.facts).toMatchObject([{ type: "PAIR_HALTED", payload: { reason: "operator halt" } }]);
    expect(plan.retained).toEqual({
      reservedCash6: 2_000_000n,
      upHeldShares6: 1_000_000n,
      downHeldShares6: 0n,
      evidenceKeys: ["evidence-before-halt"],
    });
    expect(plan.continuations).toEqual(["INGEST_LATE_EVIDENCE", "APPLY_AUTHORITATIVE_RESOLUTION", "RECONCILE"]);
    expect(plan.facts.some((entry) => entry.type.includes("RECOVERY"))).toBe(false);
  });

  it("is deterministic across restart and retains the first durable halt reason", async () => {
    const first = planPairHalt({ group: group(), nowMs: now, reason: "operator halt" });
    expect(planPairHalt({ group: group(), nowMs: now, reason: "operator halt" })).toEqual(first);
    const commitHaltPlan = vi.fn(async () => ({ kind: "COMMITTED" as const }));
    await commitPairHalt({ group: group(), nowMs: now, reason: "operator halt" }, { commitHaltPlan });
    expect(commitHaltPlan).toHaveBeenCalledTimes(1);

    const repeated = await commitPairHalt({
      group: group({ haltedAtMs: now, haltReason: "operator halt" }),
      nowMs: now + 100,
      reason: "later reason must not replace first",
    }, { commitHaltPlan });
    expect(repeated).toMatchObject({ kind: "ALREADY_HALTED", originalHaltedAtMs: now, originalReason: "operator halt" });
    expect(commitHaltPlan).toHaveBeenCalledTimes(1);

    await expect(commitPairHalt({ group: group(), nowMs: now, reason: "operator halt" }, {
      commitHaltPlan: async () => ({ kind: "DUPLICATE", planHash: "different" }),
    })).rejects.toBeInstanceOf(PairHaltWatchdogError);
  });

  it("expires effects only after the inclusive deadline and only while provably unclaimed", () => {
    const effects = [
      effect({ effectId: "due", deadlineMs: now }),
      effect({ effectId: "claimed", state: "CLAIMED", claimToken: "worker", deadlineMs: now - 1 }),
      effect({ effectId: "terminal", state: "SUCCEEDED", deadlineMs: now - 1 }),
    ];
    expect(planUnclaimedEffectExpiry({ effects, nowMs: now })).toEqual([]);
    expect(planUnclaimedEffectExpiry({ effects, nowMs: now + 1 })).toEqual([{
      effectId: "due", expectedState: "PENDING", expectedClaimToken: null,
      nextState: "EXPIRED_UNCLAIMED", reason: "EFFECT_DEADLINE_EXCEEDED", updatedAtMs: now + 1,
    }]);
  });
});

describe("unknown-result watchdog", () => {
  it("escalates initial, recovery, and merge uncertainty only at the exact configured timeout", () => {
    const effects = [
      unknown(),
      unknown({ groupId: "group-recovery", effectId: "effect-recovery", kind: "RECOVERY", upHeldShares6: 400_000n }),
      unknown({ groupId: "group-merge", effectId: "effect-merge", kind: "MERGE", upHeldShares6: 1_000_000n, downHeldShares6: 1_000_000n }),
    ];
    const before = planPairUnknownWatchdog({ nowMs: now + 999, unknownResultTimeoutMs: 1_000, effects });
    expect(before.escalations).toEqual([]);
    expect(before.health).toMatchObject({
      status: "UNHEALTHY", unresolvedEffectCount: 3, unresolvedGroupCount: 3,
      timedOutEffectCount: 0, manualReviewGroupCount: 0, paperSchedulingAllowed: false,
    });

    const exact = planPairUnknownWatchdog({ nowMs: now + 1_000, unknownResultTimeoutMs: 1_000, effects });
    expect(exact.escalations).toHaveLength(3);
    expect(exact.escalations.map((entry) => entry.kind)).toEqual(["INITIAL", "MERGE", "RECOVERY"]);
    expect(exact.escalations.every((entry) => entry.timeoutAtMs === now + 1_000)).toBe(true);
    expect(exact.escalations.every((entry) => entry.fact.type === "PAIR_RECONCILIATION_MISMATCH")).toBe(true);
    expect(exact.escalations.every((entry) => entry.newEffects.length === 0)).toBe(true);
    expect(exact.health).toMatchObject({ timedOutEffectCount: 3, manualReviewGroupCount: 3 });
    expect(planPairUnknownWatchdog({ nowMs: now + 1_000, unknownResultTimeoutMs: 1_000, effects })).toEqual(exact);
  });

  it("retains reservation/exposure on timeout and excludes effects resolved by late durable evidence", () => {
    const unresolved = unknown({ reservedCash6: 9_000_000n, upHeldShares6: 3_000_000n, downHeldShares6: 1_000_000n });
    const resolved = unknown({ groupId: "resolved", effectId: "resolved-effect", resolvedEvidenceId: "late-terminal" });
    const plan = planPairUnknownWatchdog({ nowMs: now + 1_000, unknownResultTimeoutMs: 1_000, effects: [unresolved, resolved] });
    expect(plan.pending).toEqual([unresolved]);
    expect(plan.escalations[0]?.retained).toEqual({ reservedCash6: 9_000_000n, upHeldShares6: 3_000_000n, downHeldShares6: 1_000_000n });
    expect(plan.escalations[0]?.continuations).toEqual(["INGEST_LATE_EVIDENCE", "APPLY_AUTHORITATIVE_RESOLUTION", "RECONCILE"]);
    expect(plan.health.reasons.map((reason) => [reason.code, reason.count])).toEqual([
      ["PAIR_EFFECT_OUTCOME_UNKNOWN", 1], ["PAIR_MANUAL_REVIEW_REQUIRED", 1],
    ]);
  });

  it("accepts late evidence after manual review idempotently without creating recovery or other effects", () => {
    const first = planLateEvidenceAfterWatchdog({
      groupId: "group", effectId: "effect", evidenceKey: "paper-pair:late", processedEvidenceKeys: [],
    });
    expect(first).toMatchObject({
      kind: "INGEST_LATE_EVIDENCE", preserveManualReviewUntilReconciled: true, newEffects: [],
      continuations: ["APPLY_EVIDENCE", "APPLY_AUTHORITATIVE_RESOLUTION", "RECONCILE"],
    });
    expect(planLateEvidenceAfterWatchdog({
      groupId: "group", effectId: "effect", evidenceKey: "paper-pair:late", processedEvidenceKeys: [],
    })).toEqual(first);
    expect(planLateEvidenceAfterWatchdog({
      groupId: "group", effectId: "effect", evidenceKey: "paper-pair:late", processedEvidenceKeys: ["paper-pair:late"],
    })).toEqual({ kind: "DUPLICATE", evidenceKey: "paper-pair:late", newEffects: [] });
  });
});
