import { describe, expect, it } from "vitest";
import {
  PAIR_SCENARIO_FAULT_FIXTURES,
  PairResearchScenarioError,
  pairResearchScenarioMatrixHash,
  parsePairResearchScenario,
  planPairResearchScenarioMatrix,
  verifyPairResearchScenarioMatrix,
} from "../src/pair-research-scenario";

const plan = () => planPairResearchScenarioMatrix({
  measuredProcessingP95Ms: 333,
  modeledVirtualMergeDelayMs: 800,
  modeledVirtualMergeCost6: "900719925474099312345",
});

describe("pair research scenarios", () => {
  it("parses a strict immutable scenario and verifies its complete hash", () => {
    const baseline = plan().scenarios[0]!;
    const parsed = parsePairResearchScenario({ ...baseline });

    expect(parsed).toEqual(baseline);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => parsePairResearchScenario({ ...baseline, activationLatencyMs: 351 })).toThrow(/scenarioHash mismatch/);
    expect(() => parsePairResearchScenario({ ...baseline, hiddenLiveFlag: true })).toThrow(PairResearchScenarioError);
    expect(() => parsePairResearchScenario({
      ...baseline,
      scenarioHash: undefined,
      modeledSettlementCost6: 1,
    })).toThrow(/exact unsigned decimal/);
  });

  it("plans a deterministic declared one-factor matrix with every required comparison", () => {
    const first = plan();
    const second = plan();

    expect(first).toEqual(second);
    expect(first.matrixHash).toBe(second.matrixHash);
    expect(first.scenarios).toHaveLength(28);
    expect(new Set(first.scenarios.map(({ scenarioHash }) => scenarioHash)).size).toBe(28);
    expect(first.samplingDesign).toMatchObject({
      kind: "ANCHORED_ONE_FACTOR",
      baselineCellId: "baseline",
      derivedActivationLatency: { measuredP95Ms: 333, valueMs: 666 },
    });
    expect(first.samplingDesign.declaration).toContain("do not construct an opaque Cartesian product");

    const baseline = first.scenarios.find(({ designCellId }) => designCellId === "baseline")!;
    expect(baseline).toMatchObject({
      activationLatencyMs: 350,
      dispatchModel: "PARALLEL",
      interLegDelayMs: 0,
      displayedDepthBps: "10000",
      priceStressTicksPerLeg: 0,
      settlementModel: "HOLD_TO_RESOLUTION",
      faultFixture: "BOTH_FILL",
    });
    expect(new Set(first.scenarios.map(({ activationLatencyMs }) => activationLatencyMs))).toEqual(
      new Set([0, 100, 250, 350, 500, 666, 1000]),
    );
    for (const dispatchModel of ["UP_THEN_DOWN", "DOWN_THEN_UP"] as const) {
      expect(first.scenarios.filter((scenario) => scenario.dispatchModel === dispatchModel).map(({ interLegDelayMs }) => interLegDelayMs)).toEqual([25, 50, 100, 250]);
    }
    expect(new Set(first.scenarios.map(({ displayedDepthBps }) => displayedDepthBps))).toEqual(new Set(["10000", "7500", "5000", "2500"]));
    expect(new Set(first.scenarios.map(({ priceStressTicksPerLeg }) => priceStressTicksPerLeg))).toEqual(new Set([0, 1, 2]));
    expect(new Set(first.scenarios.map(({ settlementModel }) => settlementModel))).toEqual(new Set([
      "HOLD_TO_RESOLUTION", "PAPER_VIRTUAL_MERGE", "PAPER_VIRTUAL_MERGE_FAILURE_THEN_RESOLUTION",
    ]));
    expect(new Set(first.scenarios.map(({ faultFixture }) => faultFixture))).toEqual(new Set(PAIR_SCENARIO_FAULT_FIXTURES));
    expect(verifyPairResearchScenarioMatrix(first)).toEqual(first);
  });

  it("changes matrix identity when calibrated inputs change and rejects tampering", () => {
    const first = plan();
    const differentP95 = planPairResearchScenarioMatrix({
      measuredProcessingP95Ms: 334,
      modeledVirtualMergeDelayMs: 800,
      modeledVirtualMergeCost6: 900719925474099312345n,
    });
    expect(first.matrixHash).not.toBe(differentP95.matrixHash);
    expect(() => verifyPairResearchScenarioMatrix({ ...first, matrixHash: "0".repeat(64) })).toThrow(/matrixHash mismatch/);
    const missingBaselineMaterial = { ...first, scenarios: first.scenarios.slice(1) };
    const missingBaseline = {
      ...missingBaselineMaterial,
      matrixHash: pairResearchScenarioMatrixHash(missingBaselineMaterial),
    };
    expect(() => verifyPairResearchScenarioMatrix(missingBaseline)).toThrow(/required declared sampling design/);
  });
});
