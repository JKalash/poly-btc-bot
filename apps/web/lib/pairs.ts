export interface PairCapability {
  observerEnabled: boolean;
  paperExecutionEnabled: boolean;
  liveExecutionAvailable: false;
  strategyVersion: string;
}

export interface PairHealth {
  status: "HEALTHY" | "DEGRADED";
  paperSchedulingAllowed: boolean;
  pairAccountMismatchCount: number;
  groupMismatchCount: number;
  unknownOutcomeGroupCount: number;
  manualReviewGroupCount: number;
  pendingEffectCount: number;
  lastReconciledAtMs: number | null;
  runtime: Readonly<Record<string, unknown>> | null;
}

export interface PairSummary {
  capability: PairCapability;
  health: PairHealth;
  current: {
    openEpisodes: number;
    activeGroups: number;
    residualGroups: number;
    unknownOutcomeGroups: number;
    manualReviewGroups: number;
    pairCashAvailable6: string;
    pairCashReserved6: string;
  };
  trailing24h: {
    evaluatedEnvelopes: string;
    episodes: number;
    grossDislocations: string;
    feePositiveObservations: string;
    activationSurvivors: number;
    paperGroups: number;
    pairedGroups: number;
    residualGroups: number;
    realizedPnl6: string;
  };
}

export interface PairPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PairEpisode {
  id: string;
  marketId: string;
  strategyVersion: string;
  state: string;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  closedAtMs?: number | null;
  closeReason?: string | null;
  minimumAskSum6?: string | null;
  maximumSignalNetPnl6?: string | null;
  maximumActivationNetPnl6?: string | null;
  envelopeCount: string;
  eligibleEnvelopeCount: string;
  scheduledGroupCount: number;
}

export interface PairGroup {
  id: string;
  marketId: string;
  state: string;
  dispatchModel: string;
  recoveryPolicy: string;
  reservedCash6: string;
  upHeldShares6: string;
  downHeldShares6: string;
  matchedShares6: string;
  residualSide?: string | null;
  residualShares6: string;
  currentWorstCaseLoss6: string;
  signalNetPnl6: string;
  activationNetPnl6?: string | null;
  realizedPairPnl6?: string | null;
  reconciliationStatus: string;
  createdAtMs: number;
}

export interface PairResearchRun {
  id: string;
  status: string;
  strategyVersion: string;
  marketCount: number;
  eventCount: string;
  episodeCount: number;
  summaryJson?: unknown;
  promotionVerdict?: string | null;
  startedAtMs: number;
  completedAtMs?: number | null;
}

const EXACT_INTEGER = /^-?(0|[1-9][0-9]*)$/;

export function isExactInteger(value: string): boolean {
  return EXACT_INTEGER.test(value);
}

function grouped(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Formats a base-10 integer without ever passing it through IEEE-754 Number. */
export function formatExactInteger(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (!isExactInteger(value)) return "invalid exact value";
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  return `${negative ? "−" : ""}${grouped(digits)}`;
}

/** Formats an integer with six implied decimal places, preserving all six places. */
export function formatExact6(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (!isExactInteger(value)) return "invalid exact value";
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const padded = unsigned.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6);
  return `${negative ? "−" : ""}${grouped(whole)}.${fraction}`;
}

export function sumExact(values: ReadonlyArray<string | null | undefined>): string {
  let total = 0n;
  for (const value of values) {
    if (value !== null && value !== undefined && isExactInteger(value)) total += BigInt(value);
  }
  return total.toString(10);
}

export function exactTone(value: string | null | undefined): "good" | "critical" | undefined {
  if (value === null || value === undefined || !isExactInteger(value)) return undefined;
  const exact = BigInt(value);
  return exact > 0n ? "good" : exact < 0n ? "critical" : undefined;
}

export function durationLabel(startMs: number, endMs: number): string {
  const elapsed = Math.max(0, endMs - startMs);
  if (elapsed < 1_000) return `${elapsed}ms`;
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

export interface ScenarioResult {
  label: string;
  latency: string;
  dispatch: string;
  depth: string;
  sampleCount: string;
  estimate6: string | null;
  confidenceLow6: string | null;
  confidenceHigh6: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textField(object: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  }
  return null;
}

function exactField(object: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && isExactInteger(value)) return value;
  }
  return null;
}

/**
 * Research summary JSON is intentionally versioned and opaque at the API edge.
 * This adapter recognizes the stable display fields while retaining a safe empty
 * state for older manifests.
 */
export function scenarioResults(summary: unknown): ScenarioResult[] {
  const root = record(summary);
  if (!root) return [];
  const source = [root.scenarios, root.scenarioResults, root.comparisons].find(Array.isArray);
  if (!Array.isArray(source)) return [];
  return source.flatMap((item, index) => {
    const row = record(item);
    if (!row) return [];
    const dimensions = record(row.scenario) ?? record(row.dimensions) ?? row;
    const interval = record(row.confidenceInterval) ?? record(row.ci) ?? {};
    return [{
      label: textField(row, "label", "name", "scenarioId") ?? `Scenario ${index + 1}`,
      latency: textField(dimensions, "latency", "latencyMs", "activationDelayMs") ?? "—",
      dispatch: textField(dimensions, "dispatch", "dispatchModel") ?? "—",
      depth: textField(dimensions, "depth", "depthMode", "depthLevels") ?? "—",
      sampleCount: textField(row, "sampleCount", "samples", "episodeCount") ?? "—",
      estimate6: exactField(row, "estimate6", "netPnl6", "meanNetPnl6"),
      confidenceLow6: exactField(interval, "low6", "lower6", "lo6") ?? exactField(row, "confidenceLow6", "ciLow6"),
      confidenceHigh6: exactField(interval, "high6", "upper6", "hi6") ?? exactField(row, "confidenceHigh6", "ciHigh6"),
    }];
  });
}

export function runtimeValue(runtime: Readonly<Record<string, unknown>> | null, ...path: string[]): unknown {
  let current: unknown = runtime;
  for (const part of path) {
    const object = record(current);
    if (!object) return undefined;
    current = object[part];
  }
  return current;
}
