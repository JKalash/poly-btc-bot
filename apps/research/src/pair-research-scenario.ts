import { pairDatasetObjectHash } from "./pair-dataset-manifest";

export const PAIR_SCENARIO_VERSION = "pair_research_scenario_v1" as const;
export const PAIR_SCENARIO_MATRIX_VERSION = "pair_research_matrix_v1" as const;
export const PAIR_SCENARIO_SAMPLING_DESIGN_VERSION = "anchored_one_factor_v1" as const;

export type PairScenarioDispatchModel = "PARALLEL" | "UP_THEN_DOWN" | "DOWN_THEN_UP";
export type PairScenarioDisplayedDepthBps = "10000" | "7500" | "5000" | "2500";
export type PairScenarioPriceStressTicks = 0 | 1 | 2;
export type PairScenarioSettlementModel =
  | "HOLD_TO_RESOLUTION"
  | "PAPER_VIRTUAL_MERGE"
  | "PAPER_VIRTUAL_MERGE_FAILURE_THEN_RESOLUTION";
export type PairScenarioFaultFixture =
  | "BOTH_FILL"
  | "BOTH_REJECT"
  | "UP_FILL_DOWN_REJECT"
  | "DOWN_FILL_UP_REJECT"
  | "ONE_OUTCOME_UNKNOWN"
  | "RECOVERY_COMPLEMENT_UNAVAILABLE"
  | "RECOVERY_SELL_PARTIAL";

export interface PairResearchScenario {
  readonly scenarioVersion: typeof PAIR_SCENARIO_VERSION;
  readonly designCellId: string;
  readonly activationLatencyMs: number;
  readonly dispatchModel: PairScenarioDispatchModel;
  readonly interLegDelayMs: 0 | 25 | 50 | 100 | 250;
  readonly displayedDepthBps: PairScenarioDisplayedDepthBps;
  readonly priceStressTicksPerLeg: PairScenarioPriceStressTicks;
  readonly settlementModel: PairScenarioSettlementModel;
  readonly modeledSettlementDelayMs: number;
  readonly modeledSettlementCost6: string;
  readonly faultFixture: PairScenarioFaultFixture;
  readonly scenarioHash: string;
}

export interface PairScenarioSamplingDesign {
  readonly samplingDesignVersion: typeof PAIR_SCENARIO_SAMPLING_DESIGN_VERSION;
  readonly kind: "ANCHORED_ONE_FACTOR";
  readonly baselineCellId: "baseline";
  readonly declaration: "Vary one required dimension from the baseline; do not construct an opaque Cartesian product.";
  readonly fixedActivationLatenciesMs: readonly [0, 100, 250, 350, 500, 1000];
  readonly derivedActivationLatency: Readonly<{ readonly formula: "2_X_MEASURED_PROCESSING_P95_MS"; readonly measuredP95Ms: number; readonly valueMs: number }>;
  readonly dispatchModels: readonly ["PARALLEL", "UP_THEN_DOWN", "DOWN_THEN_UP"];
  readonly serialDelaysMs: readonly [25, 50, 100, 250];
  readonly displayedDepthBps: readonly ["10000", "7500", "5000", "2500"];
  readonly priceStressTicksPerLeg: readonly [0, 1, 2];
  readonly settlementModels: readonly ["HOLD_TO_RESOLUTION", "PAPER_VIRTUAL_MERGE", "PAPER_VIRTUAL_MERGE_FAILURE_THEN_RESOLUTION"];
  readonly faultFixtures: readonly PairScenarioFaultFixture[];
}

export interface PairResearchScenarioMatrix {
  readonly matrixVersion: typeof PAIR_SCENARIO_MATRIX_VERSION;
  readonly samplingDesign: PairScenarioSamplingDesign;
  readonly scenarios: readonly PairResearchScenario[];
  readonly matrixHash: string;
}

export class PairResearchScenarioError extends Error {}

const DISPATCH_MODELS = new Set<PairScenarioDispatchModel>(["PARALLEL", "UP_THEN_DOWN", "DOWN_THEN_UP"]);
const DEPTH_BPS = new Set<PairScenarioDisplayedDepthBps>(["10000", "7500", "5000", "2500"]);
const STRESS_TICKS = new Set<PairScenarioPriceStressTicks>([0, 1, 2]);
const SETTLEMENT_MODELS = new Set<PairScenarioSettlementModel>([
  "HOLD_TO_RESOLUTION",
  "PAPER_VIRTUAL_MERGE",
  "PAPER_VIRTUAL_MERGE_FAILURE_THEN_RESOLUTION",
]);
export const PAIR_SCENARIO_FAULT_FIXTURES = Object.freeze([
  "BOTH_FILL",
  "BOTH_REJECT",
  "UP_FILL_DOWN_REJECT",
  "DOWN_FILL_UP_REJECT",
  "ONE_OUTCOME_UNKNOWN",
  "RECOVERY_COMPLEMENT_UNAVAILABLE",
  "RECOVERY_SELL_PARTIAL",
] as const satisfies readonly PairScenarioFaultFixture[]);
const FAULT_FIXTURES = new Set<PairScenarioFaultFixture>(PAIR_SCENARIO_FAULT_FIXTURES);
const SERIAL_DELAYS = new Set([25, 50, 100, 250]);
const DECIMAL = /^(?:0|[1-9]\d*)$/;
const HASH = /^[0-9a-f]{64}$/;
const CELL_ID = /^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new PairResearchScenarioError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PairResearchScenarioError(`${label} fields must be exactly: ${expected.join(", ")}`);
  }
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PairResearchScenarioError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function canonicalDecimal(value: unknown, label: string): string {
  const text = typeof value === "bigint" ? value.toString(10) : value;
  if (typeof text !== "string" || !DECIMAL.test(text)) {
    throw new PairResearchScenarioError(`${label} must be an exact unsigned decimal string or bigint`);
  }
  return text;
}

function scenarioMaterial(scenario: Omit<PairResearchScenario, "scenarioHash">): unknown {
  return scenario;
}

export function pairResearchScenarioHash(scenario: Omit<PairResearchScenario, "scenarioHash">): string {
  return pairDatasetObjectHash(scenarioMaterial(scenario));
}

export function parsePairResearchScenario(value: unknown): PairResearchScenario {
  const input = record(value, "scenario");
  const hasHash = Object.hasOwn(input, "scenarioHash");
  exactKeys(input, [
    "scenarioVersion", "designCellId", "activationLatencyMs", "dispatchModel", "interLegDelayMs",
    "displayedDepthBps", "priceStressTicksPerLeg", "settlementModel", "modeledSettlementDelayMs",
    "modeledSettlementCost6", "faultFixture", ...(hasHash ? ["scenarioHash"] : []),
  ], "scenario");
  if (input.scenarioVersion !== PAIR_SCENARIO_VERSION) throw new PairResearchScenarioError("unsupported scenarioVersion");
  if (typeof input.designCellId !== "string" || !CELL_ID.test(input.designCellId)) throw new PairResearchScenarioError("designCellId is invalid");
  if (!DISPATCH_MODELS.has(input.dispatchModel as PairScenarioDispatchModel)) throw new PairResearchScenarioError("dispatchModel is invalid");
  const dispatchModel = input.dispatchModel as PairScenarioDispatchModel;
  const delay = safeInteger(input.interLegDelayMs, "interLegDelayMs");
  if ((dispatchModel === "PARALLEL" && delay !== 0) || (dispatchModel !== "PARALLEL" && !SERIAL_DELAYS.has(delay))) {
    throw new PairResearchScenarioError("interLegDelayMs is incompatible with dispatchModel");
  }
  if (!DEPTH_BPS.has(input.displayedDepthBps as PairScenarioDisplayedDepthBps)) throw new PairResearchScenarioError("displayedDepthBps is invalid");
  if (!STRESS_TICKS.has(input.priceStressTicksPerLeg as PairScenarioPriceStressTicks)) throw new PairResearchScenarioError("priceStressTicksPerLeg is invalid");
  if (!SETTLEMENT_MODELS.has(input.settlementModel as PairScenarioSettlementModel)) throw new PairResearchScenarioError("settlementModel is invalid");
  if (!FAULT_FIXTURES.has(input.faultFixture as PairScenarioFaultFixture)) throw new PairResearchScenarioError("faultFixture is invalid");
  const settlementModel = input.settlementModel as PairScenarioSettlementModel;
  const settlementDelay = safeInteger(input.modeledSettlementDelayMs, "modeledSettlementDelayMs");
  const settlementCost = canonicalDecimal(input.modeledSettlementCost6, "modeledSettlementCost6");
  if (settlementModel === "HOLD_TO_RESOLUTION" && (settlementDelay !== 0 || settlementCost !== "0")) {
    throw new PairResearchScenarioError("hold-to-resolution cannot declare virtual-merge delay or cost");
  }
  const material = Object.freeze({
    scenarioVersion: PAIR_SCENARIO_VERSION,
    designCellId: input.designCellId,
    activationLatencyMs: safeInteger(input.activationLatencyMs, "activationLatencyMs"),
    dispatchModel,
    interLegDelayMs: delay as 0 | 25 | 50 | 100 | 250,
    displayedDepthBps: input.displayedDepthBps as PairScenarioDisplayedDepthBps,
    priceStressTicksPerLeg: input.priceStressTicksPerLeg as PairScenarioPriceStressTicks,
    settlementModel,
    modeledSettlementDelayMs: settlementDelay,
    modeledSettlementCost6: settlementCost,
    faultFixture: input.faultFixture as PairScenarioFaultFixture,
  });
  const scenarioHash = pairResearchScenarioHash(material);
  if (hasHash && (typeof input.scenarioHash !== "string" || !HASH.test(input.scenarioHash) || input.scenarioHash !== scenarioHash)) {
    throw new PairResearchScenarioError("scenarioHash mismatch");
  }
  return Object.freeze({ ...material, scenarioHash });
}

function matrixMaterial(matrix: Omit<PairResearchScenarioMatrix, "matrixHash">): unknown {
  return {
    matrixVersion: matrix.matrixVersion,
    samplingDesign: matrix.samplingDesign,
    scenarioHashes: matrix.scenarios.map(({ scenarioHash }) => scenarioHash),
  };
}

export function pairResearchScenarioMatrixHash(matrix: Omit<PairResearchScenarioMatrix, "matrixHash">): string {
  return pairDatasetObjectHash(matrixMaterial(matrix));
}

export function verifyPairResearchScenarioMatrix(matrix: PairResearchScenarioMatrix): PairResearchScenarioMatrix {
  if (matrix.matrixVersion !== PAIR_SCENARIO_MATRIX_VERSION) throw new PairResearchScenarioError("unsupported matrixVersion");
  const parsed = matrix.scenarios.map((scenario) => parsePairResearchScenario(scenario));
  if (new Set(parsed.map(({ scenarioHash }) => scenarioHash)).size !== parsed.length) throw new PairResearchScenarioError("duplicate scenario hash");
  const material = { matrixVersion: matrix.matrixVersion, samplingDesign: matrix.samplingDesign, scenarios: parsed } as const;
  if (typeof matrix.matrixHash !== "string" || !HASH.test(matrix.matrixHash) || pairResearchScenarioMatrixHash(material) !== matrix.matrixHash) {
    throw new PairResearchScenarioError("matrixHash mismatch");
  }
  const design = record(matrix.samplingDesign, "samplingDesign");
  if (design.samplingDesignVersion !== PAIR_SCENARIO_SAMPLING_DESIGN_VERSION || design.kind !== "ANCHORED_ONE_FACTOR") {
    throw new PairResearchScenarioError("unsupported sampling design");
  }
  const derived = record(design.derivedActivationLatency, "samplingDesign.derivedActivationLatency");
  const measuredProcessingP95Ms = safeInteger(derived.measuredP95Ms, "samplingDesign.derivedActivationLatency.measuredP95Ms");
  const merge = parsed.find(({ designCellId }) => designCellId === "settlement_virtual_merge");
  const failedMerge = parsed.find(({ designCellId }) => designCellId === "settlement_virtual_merge_failure");
  if (merge === undefined || failedMerge === undefined
    || merge.modeledSettlementDelayMs !== failedMerge.modeledSettlementDelayMs
    || merge.modeledSettlementCost6 !== failedMerge.modeledSettlementCost6) {
    throw new PairResearchScenarioError("matrix settlement comparison cells are missing or inconsistent");
  }
  const expected = planPairResearchScenarioMatrix({
    measuredProcessingP95Ms,
    modeledVirtualMergeDelayMs: merge.modeledSettlementDelayMs,
    modeledVirtualMergeCost6: merge.modeledSettlementCost6,
  });
  if (expected.matrixHash !== matrix.matrixHash) {
    throw new PairResearchScenarioError("matrix does not match the required declared sampling design");
  }
  return expected;
}

export function planPairResearchScenarioMatrix(input: {
  readonly measuredProcessingP95Ms: number;
  readonly modeledVirtualMergeDelayMs: number;
  readonly modeledVirtualMergeCost6: string | bigint;
}): PairResearchScenarioMatrix {
  const measuredP95Ms = safeInteger(input.measuredProcessingP95Ms, "measuredProcessingP95Ms");
  if (measuredP95Ms > Math.floor(Number.MAX_SAFE_INTEGER / 2)) throw new PairResearchScenarioError("2x measured p95 exceeds safe integer range");
  const derivedLatencyMs = measuredP95Ms * 2;
  const mergeDelayMs = safeInteger(input.modeledVirtualMergeDelayMs, "modeledVirtualMergeDelayMs");
  const mergeCost6 = canonicalDecimal(input.modeledVirtualMergeCost6, "modeledVirtualMergeCost6");
  const base: Omit<PairResearchScenario, "scenarioHash" | "designCellId"> = {
    scenarioVersion: PAIR_SCENARIO_VERSION,
    activationLatencyMs: 350,
    dispatchModel: "PARALLEL" as const,
    interLegDelayMs: 0 as const,
    displayedDepthBps: "10000" as const,
    priceStressTicksPerLeg: 0 as const,
    settlementModel: "HOLD_TO_RESOLUTION" as const,
    modeledSettlementDelayMs: 0,
    modeledSettlementCost6: "0",
    faultFixture: "BOTH_FILL" as const,
  };
  const scenarios: PairResearchScenario[] = [];
  const add = (designCellId: string, overrides: Partial<typeof base>): void => {
    scenarios.push(parsePairResearchScenario({ ...base, ...overrides, designCellId }));
  };
  add("baseline", {});
  for (const latency of [0, 100, 250, 500, 1000] as const) add(`latency_${latency}ms`, { activationLatencyMs: latency });
  add("latency_2x_p95", { activationLatencyMs: derivedLatencyMs });
  for (const dispatchModel of ["UP_THEN_DOWN", "DOWN_THEN_UP"] as const) {
    for (const interLegDelayMs of [25, 50, 100, 250] as const) {
      add(`dispatch_${dispatchModel.toLowerCase()}_${interLegDelayMs}ms`, { dispatchModel, interLegDelayMs });
    }
  }
  for (const displayedDepthBps of ["7500", "5000", "2500"] as const) add(`depth_${displayedDepthBps}bps`, { displayedDepthBps });
  for (const priceStressTicksPerLeg of [1, 2] as const) add(`stress_${priceStressTicksPerLeg}tick`, { priceStressTicksPerLeg });
  add("settlement_virtual_merge", {
    settlementModel: "PAPER_VIRTUAL_MERGE", modeledSettlementDelayMs: mergeDelayMs, modeledSettlementCost6: mergeCost6,
  });
  add("settlement_virtual_merge_failure", {
    settlementModel: "PAPER_VIRTUAL_MERGE_FAILURE_THEN_RESOLUTION", modeledSettlementDelayMs: mergeDelayMs, modeledSettlementCost6: mergeCost6,
  });
  for (const faultFixture of PAIR_SCENARIO_FAULT_FIXTURES.slice(1)) add(`fault_${faultFixture.toLowerCase()}`, { faultFixture });

  const samplingDesign: PairScenarioSamplingDesign = Object.freeze({
    samplingDesignVersion: PAIR_SCENARIO_SAMPLING_DESIGN_VERSION,
    kind: "ANCHORED_ONE_FACTOR",
    baselineCellId: "baseline",
    declaration: "Vary one required dimension from the baseline; do not construct an opaque Cartesian product.",
    fixedActivationLatenciesMs: Object.freeze([0, 100, 250, 350, 500, 1000] as const),
    derivedActivationLatency: Object.freeze({ formula: "2_X_MEASURED_PROCESSING_P95_MS", measuredP95Ms, valueMs: derivedLatencyMs }),
    dispatchModels: Object.freeze(["PARALLEL", "UP_THEN_DOWN", "DOWN_THEN_UP"] as const),
    serialDelaysMs: Object.freeze([25, 50, 100, 250] as const),
    displayedDepthBps: Object.freeze(["10000", "7500", "5000", "2500"] as const),
    priceStressTicksPerLeg: Object.freeze([0, 1, 2] as const),
    settlementModels: Object.freeze(["HOLD_TO_RESOLUTION", "PAPER_VIRTUAL_MERGE", "PAPER_VIRTUAL_MERGE_FAILURE_THEN_RESOLUTION"] as const),
    faultFixtures: PAIR_SCENARIO_FAULT_FIXTURES,
  });
  const material = Object.freeze({
    matrixVersion: PAIR_SCENARIO_MATRIX_VERSION,
    samplingDesign,
    scenarios: Object.freeze(scenarios),
  });
  return Object.freeze({ ...material, matrixHash: pairResearchScenarioMatrixHash(material) });
}
