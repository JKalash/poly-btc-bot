import {
  canonicalPairDatasetJson,
  pairDatasetContentHash,
  pairDatasetObjectHash,
} from "./pair-dataset-manifest";
import type { PairMarketReplayResult, PairReplayBookView, PairReplayOutputRecord } from "./pair-market-replay";
import {
  verifyPairResearchScenarioMatrix,
  type PairResearchScenario,
  type PairResearchScenarioMatrix,
  type PairScenarioFaultFixture,
} from "./pair-research-scenario";

export type PairScenarioLegResult = "FILL" | "REJECT" | "UNKNOWN";
export type PairScenarioRecoveryFault = "NONE" | "COMPLEMENT_UNAVAILABLE" | "SELL_PARTIAL";

export interface PairScenarioFaultScript {
  readonly fixture: PairScenarioFaultFixture;
  readonly up: PairScenarioLegResult;
  readonly down: PairScenarioLegResult;
  readonly recovery: PairScenarioRecoveryFault;
}

export interface PairScenarioDispatchAction {
  readonly outcome: "UP" | "DOWN";
  readonly scheduledDueMs: number;
  readonly actionSequence: 0 | 1;
}

export interface PairScenarioSettlementPlan {
  readonly model: PairResearchScenario["settlementModel"];
  readonly virtualMergeDueMs: number | null;
  readonly modeledSettlementCost6: bigint;
  readonly resolutionAfterFailure: boolean;
}

export interface PairScenarioCausalReplay {
  readonly datasetHash: string;
  readonly outputHash: string;
  readonly records: readonly PairReplayOutputRecord[];
  readonly finalBooks: readonly PairReplayBookView[];
}

export type PairScenarioExactValue = null | boolean | string | number | bigint
  | readonly PairScenarioExactValue[] | { readonly [key: string]: PairScenarioExactValue };

export interface PairScenarioEvaluationContext {
  readonly runNamespace: string;
  readonly accountNamespace: string;
  readonly scenarioRunId: string;
  readonly scenarioAccountId: string;
  readonly scenario: PairResearchScenario;
  readonly faultScript: PairScenarioFaultScript;
  readonly replay: PairScenarioCausalReplay;
}

export interface PairScenarioRunRecord {
  readonly scenarioRunId: string;
  readonly scenarioAccountId: string;
  readonly scenarioHash: string;
  readonly result: PairScenarioExactValue;
  readonly resultHash: string;
}

export interface PairScenarioMatrixRunResult {
  readonly runNamespace: string;
  readonly accountNamespace: string;
  readonly datasetHash: string;
  readonly replayOutputHash: string;
  readonly matrixHash: string;
  readonly scenarioRuns: readonly PairScenarioRunRecord[];
  readonly canonicalOutput: string;
  readonly outputHash: string;
}

export class PairScenarioRunnerError extends Error {}

function safeTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new PairScenarioRunnerError(`${label} must be a non-negative safe integer`);
}

function addTime(left: number, right: number, label: string): number {
  safeTime(left, label);
  safeTime(right, label);
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new PairScenarioRunnerError(`${label} exceeds safe integer range`);
  return result;
}

function identity(value: string, label: string): string {
  if (value.trim().length === 0) throw new PairScenarioRunnerError(`${label} must be non-empty`);
  return value;
}

function immutableExact(value: unknown, at = "$", seen = new Set<object>()): PairScenarioExactValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new PairScenarioRunnerError(`${at} number must be a safe integer`);
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new PairScenarioRunnerError(`${at} contains a cycle`);
    seen.add(value);
    const result = Object.freeze(value.map((item, index) => immutableExact(item, `${at}[${index}]`, seen)));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new PairScenarioRunnerError(`${at} contains a cycle`);
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new PairScenarioRunnerError(`${at} must contain plain exact-value objects only`);
    }
    seen.add(value);
    const result: Record<string, PairScenarioExactValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new PairScenarioRunnerError(`${at}.${key} must not be undefined`);
      result[key] = immutableExact(item, `${at}.${key}`, seen);
    }
    seen.delete(value);
    return Object.freeze(result);
  }
  throw new PairScenarioRunnerError(`${at} contains unsupported ${typeof value}`);
}

export function pairScenarioFaultScript(fixture: PairScenarioFaultFixture): PairScenarioFaultScript {
  const scripts: Record<PairScenarioFaultFixture, Omit<PairScenarioFaultScript, "fixture">> = {
    BOTH_FILL: { up: "FILL", down: "FILL", recovery: "NONE" },
    BOTH_REJECT: { up: "REJECT", down: "REJECT", recovery: "NONE" },
    UP_FILL_DOWN_REJECT: { up: "FILL", down: "REJECT", recovery: "NONE" },
    DOWN_FILL_UP_REJECT: { up: "REJECT", down: "FILL", recovery: "NONE" },
    ONE_OUTCOME_UNKNOWN: { up: "UNKNOWN", down: "FILL", recovery: "NONE" },
    RECOVERY_COMPLEMENT_UNAVAILABLE: { up: "FILL", down: "REJECT", recovery: "COMPLEMENT_UNAVAILABLE" },
    RECOVERY_SELL_PARTIAL: { up: "FILL", down: "REJECT", recovery: "SELL_PARTIAL" },
  };
  const script = scripts[fixture];
  if (script === undefined) throw new PairScenarioRunnerError(`unsupported fault fixture: ${fixture}`);
  return Object.freeze({ fixture, ...script });
}

export function planPairScenarioDispatch(scenario: PairResearchScenario, activationDueMs: number): readonly PairScenarioDispatchAction[] {
  safeTime(activationDueMs, "activationDueMs");
  if (scenario.dispatchModel === "PARALLEL") {
    return Object.freeze([
      Object.freeze({ outcome: "UP" as const, scheduledDueMs: activationDueMs, actionSequence: 0 as const }),
      Object.freeze({ outcome: "DOWN" as const, scheduledDueMs: activationDueMs, actionSequence: 1 as const }),
    ]);
  }
  const first = scenario.dispatchModel === "UP_THEN_DOWN" ? "UP" : "DOWN";
  const second = first === "UP" ? "DOWN" : "UP";
  return Object.freeze([
    Object.freeze({ outcome: first, scheduledDueMs: activationDueMs, actionSequence: 0 as const }),
    Object.freeze({ outcome: second, scheduledDueMs: addTime(activationDueMs, scenario.interLegDelayMs, "serial complement due time"), actionSequence: 1 as const }),
  ]);
}

export function planPairScenarioSettlement(scenario: PairResearchScenario, pairedAtMs: number): PairScenarioSettlementPlan {
  safeTime(pairedAtMs, "pairedAtMs");
  const hold = scenario.settlementModel === "HOLD_TO_RESOLUTION";
  return Object.freeze({
    model: scenario.settlementModel,
    virtualMergeDueMs: hold ? null : addTime(pairedAtMs, scenario.modeledSettlementDelayMs, "virtual merge due time"),
    modeledSettlementCost6: BigInt(scenario.modeledSettlementCost6),
    resolutionAfterFailure: scenario.settlementModel === "PAPER_VIRTUAL_MERGE_FAILURE_THEN_RESOLUTION",
  });
}

export function pairScenarioSurvivingShares6(shares6: bigint, displayedDepthBps: PairResearchScenario["displayedDepthBps"]): bigint {
  if (shares6 < 0n) throw new PairScenarioRunnerError("shares6 must be non-negative");
  return shares6 * BigInt(displayedDepthBps) / 10_000n;
}

export function pairScenarioStressedBuyPrice6(price6: bigint, tickSize6: bigint, ticks: PairResearchScenario["priceStressTicksPerLeg"]): bigint {
  if (price6 <= 0n || tickSize6 <= 0n) throw new PairScenarioRunnerError("price6 and tickSize6 must be positive");
  return price6 + tickSize6 * BigInt(ticks);
}

function validateReplay(replay: PairMarketReplayResult): PairScenarioCausalReplay {
  const material = {
    datasetHash: replay.datasetHash,
    clockModelVersion: replay.clockModelVersion,
    tieRuleVersion: replay.tieRuleVersion,
    records: replay.records,
    finalBooks: replay.finalBooks,
  } as const;
  if (canonicalPairDatasetJson(material) !== replay.canonicalOutput
    || pairDatasetObjectHash(material) !== replay.outputHash
    || pairDatasetContentHash(replay.canonicalOutput) !== replay.outputHash) {
    throw new PairScenarioRunnerError("causal replay output/hash mismatch");
  }
  return immutableExact({
    datasetHash: replay.datasetHash,
    outputHash: replay.outputHash,
    records: replay.records,
    finalBooks: replay.finalBooks,
  }) as unknown as PairScenarioCausalReplay;
}

export async function runPairResearchScenarioMatrix(input: {
  readonly runId: string;
  readonly sourceAccountId: string;
  readonly matrix: PairResearchScenarioMatrix;
  readonly replay: PairMarketReplayResult;
  readonly evaluate: (context: PairScenarioEvaluationContext) => PairScenarioExactValue | Promise<PairScenarioExactValue>;
}): Promise<PairScenarioMatrixRunResult> {
  identity(input.runId, "runId");
  identity(input.sourceAccountId, "sourceAccountId");
  const matrix = verifyPairResearchScenarioMatrix(input.matrix);
  const replay = validateReplay(input.replay);
  const runNamespace = `pair-research-run-${pairDatasetObjectHash({ runId: input.runId, datasetHash: replay.datasetHash, matrixHash: matrix.matrixHash }).slice(0, 32)}`;
  const accountNamespace = `pair-research-account-${pairDatasetObjectHash({ runNamespace, sourceAccountId: input.sourceAccountId }).slice(0, 32)}`;
  const scenarioRuns: PairScenarioRunRecord[] = [];
  for (const scenario of matrix.scenarios) {
    const scenarioRunId = `pair-scenario-run-${pairDatasetObjectHash({ runNamespace, scenarioHash: scenario.scenarioHash }).slice(0, 32)}`;
    const scenarioAccountId = `pair-scenario-account-${pairDatasetObjectHash({ accountNamespace, scenarioHash: scenario.scenarioHash }).slice(0, 32)}`;
    const context: PairScenarioEvaluationContext = Object.freeze({
      runNamespace,
      accountNamespace,
      scenarioRunId,
      scenarioAccountId,
      scenario,
      faultScript: pairScenarioFaultScript(scenario.faultFixture),
      replay,
    });
    const result = immutableExact(await input.evaluate(context), `scenario[${scenario.designCellId}].result`);
    scenarioRuns.push(Object.freeze({
      scenarioRunId,
      scenarioAccountId,
      scenarioHash: scenario.scenarioHash,
      result,
      resultHash: pairDatasetObjectHash(result),
    }));
  }
  const material = Object.freeze({
    runNamespace,
    accountNamespace,
    datasetHash: replay.datasetHash,
    replayOutputHash: replay.outputHash,
    matrixHash: matrix.matrixHash,
    scenarioRuns: Object.freeze(scenarioRuns),
  });
  const canonicalOutput = canonicalPairDatasetJson(material);
  return Object.freeze({ ...material, canonicalOutput, outputHash: pairDatasetContentHash(canonicalOutput) });
}
