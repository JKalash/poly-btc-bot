import { describe, expect, it } from "vitest";
import { canonicalPairDatasetJson, pairDatasetObjectHash } from "../src/pair-dataset-manifest";
import type { PairMarketReplayResult } from "../src/pair-market-replay";
import { planPairResearchScenarioMatrix } from "../src/pair-research-scenario";
import {
  PairScenarioRunnerError,
  pairScenarioFaultScript,
  pairScenarioStressedBuyPrice6,
  pairScenarioSurvivingShares6,
  planPairScenarioDispatch,
  planPairScenarioSettlement,
  runPairResearchScenarioMatrix,
} from "../src/pair-scenario-runner";

function matrix() {
  return planPairResearchScenarioMatrix({
    measuredProcessingP95Ms: 400,
    modeledVirtualMergeDelayMs: 750,
    modeledVirtualMergeCost6: "123456789012345678901",
  });
}

function replay(): PairMarketReplayResult {
  const material = Object.freeze({
    datasetHash: "d".repeat(64),
    clockModelVersion: "pair_replay_clock_v1" as const,
    tieRuleVersion: "pair_replay_tie_v1" as const,
    records: Object.freeze([]),
    finalBooks: Object.freeze([]),
  });
  return Object.freeze({
    ...material,
    canonicalOutput: canonicalPairDatasetJson(material),
    outputHash: pairDatasetObjectHash(material),
  });
}

describe("pair scenario helpers", () => {
  it("maps every named non-atomic fixture without randomness", () => {
    expect(pairScenarioFaultScript("BOTH_FILL")).toEqual({ fixture: "BOTH_FILL", up: "FILL", down: "FILL", recovery: "NONE" });
    expect(pairScenarioFaultScript("ONE_OUTCOME_UNKNOWN")).toMatchObject({ up: "UNKNOWN", down: "FILL" });
    expect(pairScenarioFaultScript("RECOVERY_COMPLEMENT_UNAVAILABLE")).toMatchObject({ up: "FILL", down: "REJECT", recovery: "COMPLEMENT_UNAVAILABLE" });
    expect(pairScenarioFaultScript("RECOVERY_SELL_PARTIAL")).toMatchObject({ recovery: "SELL_PARTIAL" });
  });

  it("plans dispatch and settlement timings using exact scenario values", () => {
    const scenarios = matrix().scenarios;
    const parallel = scenarios.find(({ designCellId }) => designCellId === "baseline")!;
    const serial = scenarios.find(({ designCellId }) => designCellId === "dispatch_up_then_down_100ms")!;
    const merge = scenarios.find(({ designCellId }) => designCellId === "settlement_virtual_merge")!;
    const failedMerge = scenarios.find(({ designCellId }) => designCellId === "settlement_virtual_merge_failure")!;

    expect(planPairScenarioDispatch(parallel, 1_000)).toEqual([
      { outcome: "UP", scheduledDueMs: 1_000, actionSequence: 0 },
      { outcome: "DOWN", scheduledDueMs: 1_000, actionSequence: 1 },
    ]);
    expect(planPairScenarioDispatch(serial, 1_000)).toEqual([
      { outcome: "UP", scheduledDueMs: 1_000, actionSequence: 0 },
      { outcome: "DOWN", scheduledDueMs: 1_100, actionSequence: 1 },
    ]);
    expect(planPairScenarioSettlement(merge, 2_000)).toMatchObject({
      virtualMergeDueMs: 2_750,
      modeledSettlementCost6: 123456789012345678901n,
      resolutionAfterFailure: false,
    });
    expect(planPairScenarioSettlement(failedMerge, 2_000).resolutionAfterFailure).toBe(true);
  });

  it("applies depth survival and tick stress entirely in bigint arithmetic", () => {
    expect(pairScenarioSurvivingShares6(900719925474099312345n, "7500")).toBe(675539944105574484258n);
    expect(pairScenarioSurvivingShares6(3n, "7500")).toBe(2n);
    expect(pairScenarioStressedBuyPrice6(450000n, 1000n, 2)).toBe(452000n);
  });
});

describe("pair scenario matrix runner", () => {
  it("runs deterministically from causal replay output with isolated account namespaces", async () => {
    const planned = matrix();
    const seenReplayKeys: string[][] = [];
    const run = (sourceAccountId = "paper-source") => runPairResearchScenarioMatrix({
      runId: "research-run-1",
      sourceAccountId,
      matrix: planned,
      replay: replay(),
      evaluate(context) {
        seenReplayKeys.push(Object.keys(context.replay).sort());
        return {
          scenarioHash: context.scenario.scenarioHash,
          causalRecordCount: BigInt(context.replay.records.length),
          exactPnl6: -900719925474099312345n,
          upResult: context.faultScript.up,
          downResult: context.faultScript.down,
        };
      },
    });
    const first = await run();
    const second = await run();

    expect(first.canonicalOutput).toBe(second.canonicalOutput);
    expect(first.outputHash).toBe(second.outputHash);
    expect(first.scenarioRuns).toHaveLength(28);
    expect(new Set(first.scenarioRuns.map(({ scenarioRunId }) => scenarioRunId)).size).toBe(28);
    expect(new Set(first.scenarioRuns.map(({ scenarioAccountId }) => scenarioAccountId)).size).toBe(28);
    expect(first.canonicalOutput).toContain("-900719925474099312345");
    expect(seenReplayKeys.every((keys) => keys.join(",") === "datasetHash,finalBooks,outputHash,records")).toBe(true);
    const otherAccount = await run("different-paper-source");
    expect(otherAccount.runNamespace).toBe(first.runNamespace);
    expect(otherAccount.accountNamespace).not.toBe(first.accountNamespace);
    expect(otherAccount.scenarioRuns[0]!.scenarioAccountId).not.toBe(first.scenarioRuns[0]!.scenarioAccountId);
  });

  it("rejects replay tampering and non-exact evaluator output", async () => {
    const planned = matrix();
    const validReplay = replay();
    await expect(runPairResearchScenarioMatrix({
      runId: "run",
      sourceAccountId: "account",
      matrix: planned,
      replay: { ...validReplay, outputHash: "0".repeat(64) },
      evaluate: () => ({}),
    })).rejects.toThrow(/replay output\/hash mismatch/);
    await expect(runPairResearchScenarioMatrix({
      runId: "run",
      sourceAccountId: "account",
      matrix: planned,
      replay: validReplay,
      evaluate: () => ({ imprecise: 0.5 }) as never,
    })).rejects.toBeInstanceOf(PairScenarioRunnerError);
  });
});
