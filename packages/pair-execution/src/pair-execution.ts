import type {
  ConsiderPairCommand,
  ConsiderPairResult,
  HaltPairsCommand,
  PairAdvanceSummary,
  PairCapabilityAuthority,
  PairCommittedEffect,
  PairExecution,
  PairExecutionDependencies,
  PairGroupId,
  PairGroupView,
  PairHaltSummary,
  PairObservationId,
  PairQuote,
  PairRejection,
  PairReconcileSummary,
} from "./contracts";

const rejection = (code: PairRejection["code"], description: string): PairRejection => ({ code, description });

function assertTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
}

function assertNonExposureEffects(effects: readonly PairCommittedEffect[], context: string): void {
  const unsafe = effects.find((effect) => effect.increasesExposure);
  if (unsafe !== undefined) {
    throw new Error(`${context} returned exposure-increasing effect ${unsafe.effectId}`);
  }
}

function rejectedObservation(
  observationId: PairObservationId,
  quote: PairQuote | null,
  reasons: readonly PairRejection[],
): ConsiderPairResult {
  return { kind: "OBSERVED_REJECTED", observationId, quote, reasons };
}

export function constructPairExecution(
  deps: PairExecutionDependencies,
  authority: PairCapabilityAuthority,
): PairExecution {
  return {
    async consider(command: ConsiderPairCommand): Promise<ConsiderPairResult> {
      assertTime(command.nowMs, "command.nowMs");
      if (!authority.observerEnabled) {
        return {
          kind: "NO_OBSERVATION",
          reasons: [rejection("PAIR_FEATURE_DISABLED", "pair observation is disabled by capability authority")],
        };
      }

      const evaluation = await deps.economics.evaluate({ command, authority });
      if (evaluation.kind === "NO_OBSERVATION") return evaluation;

      const observation = await deps.observations.record({ command, evaluation, authority });
      if (observation.kind === "DUPLICATE") {
        return {
          kind: "DUPLICATE",
          idempotencyKey: observation.idempotencyKey,
          existingObservationId: observation.existingObservationId,
          existingGroupId: observation.existingGroupId,
        };
      }
      if (evaluation.kind === "REJECTED") {
        return rejectedObservation(observation.observationId, evaluation.quote, evaluation.reasons);
      }
      if (command.intent === "OBSERVE_ONLY") {
        return { kind: "OBSERVED_ELIGIBLE", observationId: observation.observationId, quote: evaluation.quote };
      }
      if (!authority.paperSchedulingEnabled) {
        return rejectedObservation(observation.observationId, evaluation.quote, [
          rejection("PAPER_EXECUTION_DISABLED", "paper scheduling is disabled by capability authority"),
        ]);
      }
      if (!command.portfolio.healthy) {
        return rejectedObservation(observation.observationId, evaluation.quote, [
          rejection("PORTFOLIO_UNRECONCILED", "pair account is not healthy and reconciled"),
        ]);
      }

      const accountDecision = await deps.account.approveSchedule({ command, quote: evaluation.quote, authority });
      if (accountDecision.kind === "REJECTED") {
        return rejectedObservation(observation.observationId, evaluation.quote, accountDecision.reasons);
      }
      const preparation = await deps.activation.prepareSchedule({
        command,
        observationId: observation.observationId,
        quote: evaluation.quote,
        approval: accountDecision.approval,
        authority,
      });
      if (preparation.kind === "REJECTED") {
        return rejectedObservation(observation.observationId, evaluation.quote, preparation.reasons);
      }

      const committed = await deps.store.commitSchedule({ plan: preparation.plan, command, quote: evaluation.quote });
      if (committed.kind === "DUPLICATE") {
        return {
          kind: "DUPLICATE",
          idempotencyKey: committed.idempotencyKey,
          existingObservationId: committed.existingObservationId,
          existingGroupId: committed.existingGroupId,
        };
      }
      return {
        kind: "PAPER_SCHEDULED",
        observationId: observation.observationId,
        groupId: preparation.plan.groupId,
        quote: evaluation.quote,
        activateAtMs: preparation.plan.activateAtMs,
      };
    },

    async advance(nowMs: number): Promise<PairAdvanceSummary> {
      assertTime(nowMs, "nowMs");
      const ingestedEvidenceCount = await deps.effects.ingestAvailableEvidence(nowMs);
      const dueWork = await deps.store.listDueWork(nowMs);
      let committedWorkCount = 0;
      let skippedHaltedExposureCount = 0;
      let dispatchedEffectCount = 0;

      for (const work of dueWork) {
        const preparation = await deps.activation.prepareDueWork({ work, nowMs, authority });
        if (preparation.kind === "NO_ACTION") continue;
        if (work.halted && preparation.plan.increasesExposure) {
          skippedHaltedExposureCount += 1;
          continue;
        }
        const committed = await deps.store.commitDuePlan(preparation.plan, nowMs);
        if (committed.kind === "STALE") continue;
        committedWorkCount += 1;
        if (work.halted) assertNonExposureEffects(committed.effects, `halted due work ${work.workId}`);
        if (committed.effects.length > 0) {
          await deps.effects.dispatchCommitted(committed.effects, nowMs);
          dispatchedEffectCount += committed.effects.length;
        }
      }
      return {
        dueWorkCount: dueWork.length,
        committedWorkCount,
        skippedHaltedExposureCount,
        dispatchedEffectCount,
        ingestedEvidenceCount,
      };
    },

    async reconcile(nowMs: number): Promise<PairReconcileSummary> {
      assertTime(nowMs, "nowMs");
      return deps.reconciliation.reconcile(nowMs);
    },

    async halt(command: HaltPairsCommand): Promise<PairHaltSummary> {
      assertTime(command.nowMs, "command.nowMs");
      if (command.reason.trim().length === 0) throw new TypeError("halt reason must not be empty");
      const committed = await deps.store.commitHalt(command);
      assertNonExposureEffects(committed.effects, "halt commit");
      if (committed.effects.length > 0) {
        await deps.effects.dispatchCommitted(committed.effects, command.nowMs);
      }
      const ingestedEvidenceCount = await deps.effects.ingestAvailableEvidence(command.nowMs);
      const reconciliation = await deps.reconciliation.reconcile(command.nowMs);
      return {
        haltedGroupCount: committed.haltedGroupCount,
        alreadyHaltedGroupCount: committed.alreadyHaltedGroupCount,
        dispatchedCancellationCount: committed.effects.length,
        ingestedEvidenceCount,
        reconciliation,
      };
    },

    getGroup(groupId: string): Promise<PairGroupView | null> {
      if (groupId.trim().length === 0) throw new TypeError("groupId must not be empty");
      return deps.store.getGroup(groupId as PairGroupId);
    },

    listActiveGroups(): Promise<readonly PairGroupView[]> {
      return deps.store.listActiveGroups();
    },
  };
}
