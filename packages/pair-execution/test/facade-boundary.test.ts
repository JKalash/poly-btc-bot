import { describe, expect, it, vi } from "vitest";
import { createPairExecution, PairExecutionConfigurationError } from "../src/create-pair-execution";
import type {
  ConsiderPairCommand,
  PairCapabilityAuthority,
  PairCommittedEffect,
  PairExecutionDependencies,
  PairGroupId,
  PairGroupView,
  PairObservationId,
  PairQuote,
  PairReconcileSummary,
  PairRiskDecision,
  PairSchedulePlan,
} from "../src/contracts";

const observationId = "pobs_test" as PairObservationId;
const groupId = "pgrp_test" as PairGroupId;
const quote = { quoteHash: "quote_hash" } as PairQuote;
const approval = {
  kind: "APPROVED",
  permitId: "permit",
  maximumReservedCash6: 100n,
} as Extract<PairRiskDecision, { readonly kind: "APPROVED" }>;
const plan = {
  groupId,
  observationId,
  marketId: "market",
  activateAtMs: 1_100,
  quoteHash: "quote_hash",
  permitId: "permit",
  reservedCash6: 100n,
  planHash: "plan_hash",
} as PairSchedulePlan;
const reconciliation: PairReconcileSummary = {
  inspectedGroupCount: 1,
  healthyGroupCount: 1,
  repairedGroupCount: 0,
  pendingGroupCount: 0,
  manualReviewGroupCount: 0,
};

function authority(overrides: Partial<PairCapabilityAuthority> = {}): PairCapabilityAuthority {
  const observerEnabled = overrides.observerEnabled ?? true;
  const paperSchedulingEnabled = overrides.paperSchedulingEnabled ?? true;
  const configVersion = overrides.configVersion ?? 1;
  return {
    observerEnabled,
    paperSchedulingEnabled,
    liveExecutionAvailable: false,
    configVersion,
    policy: {
      observerEnabled,
      paperSchedulingEnabled,
      liveExecutionAvailable: false,
      configVersion,
      policyHash: "policy_hash",
      depthStressFractionsPpm: [250_000n, 500_000n, 750_000n],
      hardRiskConstant: {
        name: "ABSOLUTE_MAX_RISK_FRACTION",
        valuePpm: 100_000n,
        sourceVersion: "test",
      },
    },
    ...overrides,
  } as PairCapabilityAuthority;
}

function command(intent: ConsiderPairCommand["intent"] = "OBSERVE_ONLY", healthy = true): ConsiderPairCommand {
  return {
    intent,
    nowMs: 1_000,
    correlationId: "correlation",
    trigger: { kind: "CLOB_ENVELOPE", envelopeId: "envelope" },
    market: { marketId: "market" },
    capture: { captureId: "pcap_test" },
    portfolio: { healthy },
  } as ConsiderPairCommand;
}

function dependencies(order: string[] = []): PairExecutionDependencies {
  return {
    economics: {
      evaluate: vi.fn(async () => {
        order.push("economics");
        return { kind: "ELIGIBLE", quote } as const;
      }),
    },
    observations: {
      record: vi.fn(async () => {
        order.push("observation");
        return { kind: "RECORDED", observationId } as const;
      }),
    },
    account: {
      approveSchedule: vi.fn(async () => {
        order.push("account");
        return { kind: "APPROVED", approval } as const;
      }),
    },
    activation: {
      prepareSchedule: vi.fn(async () => {
        order.push("prepare-schedule");
        return { kind: "READY", plan } as const;
      }),
      prepareDueWork: vi.fn(async ({ work }) => {
        order.push(`prepare-due:${work.workId}`);
        return {
          kind: "READY",
          plan: {
            workId: work.workId,
            groupId: work.groupId,
            expectedStateVersion: work.stateVersion,
            increasesExposure: false,
            planHash: `plan:${work.workId}`,
            payload: {},
          },
        } as const;
      }),
    },
    store: {
      commitSchedule: vi.fn(async () => {
        order.push("commit-schedule");
        return { kind: "COMMITTED" } as const;
      }),
      listDueWork: vi.fn(async () => {
        order.push("list-due");
        return [];
      }),
      commitDuePlan: vi.fn(async (duePlan) => {
        order.push(`commit-due:${duePlan.workId}`);
        return { kind: "COMMITTED", effects: [] } as const;
      }),
      commitHalt: vi.fn(async () => {
        order.push("commit-halt");
        return { haltedGroupCount: 1, alreadyHaltedGroupCount: 0, effects: [] };
      }),
      getGroup: vi.fn(async () => null),
      listActiveGroups: vi.fn(async () => []),
    },
    effects: {
      dispatchCommitted: vi.fn(async (effects: readonly PairCommittedEffect[]) => {
        order.push(`dispatch:${effects.map((item) => item.effectId).join(",")}`);
      }),
      ingestAvailableEvidence: vi.fn(async () => {
        order.push("ingest-evidence");
        return 0;
      }),
    },
    reconciliation: {
      reconcile: vi.fn(async () => {
        order.push("reconcile");
        return reconciliation;
      }),
    },
  };
}

describe("pair facade construction boundary", () => {
  it("fails closed on an incomplete dependency set", () => {
    expect(() => createPairExecution({} as PairExecutionDependencies, authority())).toThrow(PairExecutionConfigurationError);
  });

  it("rejects capability and policy disagreement", () => {
    const invalid = authority();
    const mismatched = { ...invalid, policy: { ...invalid.policy, paperSchedulingEnabled: false } };
    expect(() => createPairExecution(dependencies(), mismatched)).toThrow("authority and policy paper capability differ");
  });

  it("snapshots authority so caller mutation cannot grant or revoke capability", async () => {
    const source = authority();
    const facade = createPairExecution(dependencies(), source);
    (source as { paperSchedulingEnabled: boolean }).paperSchedulingEnabled = false;
    const result = await facade.consider(command("SCHEDULE_PAPER_IF_AUTHORIZED"));
    expect(result.kind).toBe("PAPER_SCHEDULED");
  });
});

describe("pair facade consider boundary", () => {
  it("persists an eligible observer result without touching account, activation, store, or effects", async () => {
    const deps = dependencies();
    const result = await createPairExecution(deps, authority()).consider(command());
    expect(result).toEqual({ kind: "OBSERVED_ELIGIBLE", observationId, quote });
    expect(deps.account.approveSchedule).not.toHaveBeenCalled();
    expect(deps.activation.prepareSchedule).not.toHaveBeenCalled();
    expect(deps.store.commitSchedule).not.toHaveBeenCalled();
    expect(deps.effects.dispatchCommitted).not.toHaveBeenCalled();
  });

  it("returns a business rejection when paper authority or account health is absent", async () => {
    const disabledDeps = dependencies();
    const disabled = await createPairExecution(disabledDeps, authority({ paperSchedulingEnabled: false })).consider(
      command("SCHEDULE_PAPER_IF_AUTHORIZED"),
    );
    expect(disabled.kind).toBe("OBSERVED_REJECTED");
    if (disabled.kind === "OBSERVED_REJECTED") expect(disabled.reasons.map((item) => item.code)).toEqual(["PAPER_EXECUTION_DISABLED"]);
    expect(disabledDeps.account.approveSchedule).not.toHaveBeenCalled();

    const unhealthyDeps = dependencies();
    const unhealthy = await createPairExecution(unhealthyDeps, authority()).consider(
      command("SCHEDULE_PAPER_IF_AUTHORIZED", false),
    );
    expect(unhealthy.kind).toBe("OBSERVED_REJECTED");
    if (unhealthy.kind === "OBSERVED_REJECTED") expect(unhealthy.reasons.map((item) => item.code)).toEqual(["PORTFOLIO_UNRECONCILED"]);
    expect(unhealthyDeps.account.approveSchedule).not.toHaveBeenCalled();
  });

  it("schedules only after observation, account approval, activation planning, and durable commit", async () => {
    const order: string[] = [];
    const deps = dependencies(order);
    const result = await createPairExecution(deps, authority()).consider(command("SCHEDULE_PAPER_IF_AUTHORIZED"));
    expect(result).toEqual({
      kind: "PAPER_SCHEDULED",
      observationId,
      groupId,
      quote,
      activateAtMs: 1_100,
    });
    expect(order).toEqual(["economics", "observation", "account", "prepare-schedule", "commit-schedule"]);
    expect(deps.effects.dispatchCommitted).not.toHaveBeenCalled();
  });

  it("surfaces infrastructure faults instead of converting them to business rejection", async () => {
    const deps = dependencies();
    vi.mocked(deps.store.commitSchedule).mockRejectedValueOnce(new Error("store unavailable"));
    await expect(
      createPairExecution(deps, authority()).consider(command("SCHEDULE_PAPER_IF_AUTHORIZED")),
    ).rejects.toThrow("store unavailable");
  });
});

describe("pair facade durable work boundary", () => {
  it("commits every due plan before dispatch and dispatches only committed effects", async () => {
    const order: string[] = [];
    const deps = dependencies(order);
    const effect: PairCommittedEffect = { effectId: "effect-1", groupId, kind: "PAPER_FOK", increasesExposure: true };
    vi.mocked(deps.store.listDueWork).mockResolvedValueOnce([
      { workId: "work-1", groupId, kind: "ACTIVATION", dueAtMs: 2_000, halted: false, stateVersion: 2 },
    ]);
    vi.mocked(deps.store.commitDuePlan).mockImplementationOnce(async () => {
      order.push("commit-due:work-1");
      return { kind: "COMMITTED", effects: [effect] };
    });
    const summary = await createPairExecution(deps, authority()).advance(2_000);
    expect(order).toEqual([
      "ingest-evidence",
      "prepare-due:work-1",
      "commit-due:work-1",
      "dispatch:effect-1",
    ]);
    expect(summary).toMatchObject({ committedWorkCount: 1, dispatchedEffectCount: 1 });
  });

  it("does not dispatch when the durable commit fails", async () => {
    const deps = dependencies();
    vi.mocked(deps.store.listDueWork).mockResolvedValueOnce([
      { workId: "work-1", groupId, kind: "ACTIVATION", dueAtMs: 2_000, halted: false, stateVersion: 2 },
    ]);
    vi.mocked(deps.store.commitDuePlan).mockRejectedValueOnce(new Error("commit failed"));
    await expect(createPairExecution(deps, authority()).advance(2_000)).rejects.toThrow("commit failed");
    expect(deps.effects.dispatchCommitted).not.toHaveBeenCalled();
  });

  it("skips exposure-increasing plans for halted groups while still ingesting late evidence", async () => {
    const deps = dependencies();
    vi.mocked(deps.effects.ingestAvailableEvidence).mockResolvedValueOnce(2);
    vi.mocked(deps.store.listDueWork).mockResolvedValueOnce([
      { workId: "work-1", groupId, kind: "RECOVERY", dueAtMs: 2_000, halted: true, stateVersion: 2 },
    ]);
    vi.mocked(deps.activation.prepareDueWork).mockResolvedValueOnce({
      kind: "READY",
      plan: {
        workId: "work-1",
        groupId,
        expectedStateVersion: 2,
        increasesExposure: true,
        planHash: "unsafe",
        payload: {},
      },
    });
    const summary = await createPairExecution(deps, authority()).advance(2_000);
    expect(summary).toMatchObject({ ingestedEvidenceCount: 2, skippedHaltedExposureCount: 1 });
    expect(deps.store.commitDuePlan).not.toHaveBeenCalled();
    expect(deps.effects.dispatchCommitted).not.toHaveBeenCalled();
  });
});

describe("pair facade halt, reconciliation, and reads", () => {
  it("commits halt before cancellation dispatch, then ingests late evidence and reconciles", async () => {
    const order: string[] = [];
    const deps = dependencies(order);
    vi.mocked(deps.store.commitHalt).mockImplementationOnce(async () => {
      order.push("commit-halt");
      return {
        haltedGroupCount: 1,
        alreadyHaltedGroupCount: 0,
        effects: [{ effectId: "cancel-1", groupId, kind: "CANCEL_UNCLAIMED", increasesExposure: false }],
      };
    });
    vi.mocked(deps.effects.ingestAvailableEvidence).mockImplementationOnce(async () => {
      order.push("ingest-evidence");
      return 3;
    });
    const summary = await createPairExecution(deps, authority()).halt({
      nowMs: 3_000,
      correlationId: "halt",
      reason: "operator halt",
    });
    expect(order).toEqual(["commit-halt", "dispatch:cancel-1", "ingest-evidence", "reconcile"]);
    expect(summary).toMatchObject({ dispatchedCancellationCount: 1, ingestedEvidenceCount: 3, reconciliation });
  });

  it("refuses an exposure-increasing effect returned by a halt commit", async () => {
    const deps = dependencies();
    vi.mocked(deps.store.commitHalt).mockResolvedValueOnce({
      haltedGroupCount: 1,
      alreadyHaltedGroupCount: 0,
      effects: [{ effectId: "unsafe", groupId, kind: "BUY", increasesExposure: true }],
    });
    await expect(createPairExecution(deps, authority()).halt({
      nowMs: 3_000,
      correlationId: "halt",
      reason: "operator halt",
    })).rejects.toThrow("exposure-increasing effect unsafe");
    expect(deps.effects.dispatchCommitted).not.toHaveBeenCalled();
  });

  it("delegates reconciliation and read methods without exposing mutable internals", async () => {
    const deps = dependencies();
    const view = { groupId, marketId: "market", state: "SCHEDULED" } as PairGroupView;
    vi.mocked(deps.store.getGroup).mockResolvedValueOnce(view);
    vi.mocked(deps.store.listActiveGroups).mockResolvedValueOnce([view]);
    const facade = createPairExecution(deps, authority());
    await expect(facade.reconcile(4_000)).resolves.toEqual(reconciliation);
    await expect(facade.getGroup(groupId)).resolves.toEqual(view);
    await expect(facade.listActiveGroups()).resolves.toEqual([view]);
  });
});
