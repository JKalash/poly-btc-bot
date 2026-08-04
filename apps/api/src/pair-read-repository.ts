import { schema, type DbHandle } from "@b5p/db";
import { and, count, desc, eq, gt, gte, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const ACTIVE_GROUP_STATES = [
  "SCHEDULED", "ACTIVATING", "ACTIVATION_REJECTED", "SUBMITTING", "OUTCOME_UNKNOWN",
  "NO_INITIAL_FILL", "PAIRED", "RESIDUAL", "RECOVERY_PENDING", "RECOVERING",
  "RECOVERY_OUTCOME_UNKNOWN", "AWAITING_SETTLEMENT", "MERGE_PENDING",
  "MERGE_OUTCOME_UNKNOWN", "AWAITING_RESOLUTION", "RECONCILING", "MANUAL_REVIEW",
] as const;
const GROUP_STATES = [...ACTIVE_GROUP_STATES, "RECONCILED_FLAT", "RECONCILED_SETTLED"] as const;
const DISPATCH_MODELS = ["PARALLEL", "UP_THEN_DOWN", "DOWN_THEN_UP"] as const;
const RECOVERY_POLICIES = [
  "NO_AUTO_RECOVERY", "PAPER_COMPLETE_MISSING_LEG", "PAPER_LIQUIDATE_FILLED_LEG", "PAPER_MINIMIZE_WORST_LOSS",
] as const;
const RECONCILIATION_STATUSES = ["NOT_STARTED", "PENDING", "HEALTHY", "MISMATCH"] as const;
const EPISODE_STATES = ["OPEN", "CLOSED"] as const;
const RESEARCH_STATUSES = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"] as const;

export class PairReadModelValidationError extends Error {
  readonly code = "PAIR_READ_FILTER_INVALID" as const;
  override readonly name = "PairReadModelValidationError";
}

export interface PairReadCapability {
  readonly observerEnabled: boolean;
  readonly paperExecutionEnabled: boolean;
  readonly liveExecutionAvailable: false;
  readonly strategyVersion: string;
}

export interface PairReadRepositoryOptions {
  readonly capability: PairReadCapability;
  readonly runtimeHealth?: () => Readonly<Record<string, unknown>>;
  readonly onQuery?: (name: string) => void;
}

export interface PairPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}

export interface PairReadHealth {
  readonly status: "HEALTHY" | "DEGRADED";
  readonly paperSchedulingAllowed: boolean;
  readonly pairAccountMismatchCount: number;
  readonly groupMismatchCount: number;
  readonly unknownOutcomeGroupCount: number;
  readonly manualReviewGroupCount: number;
  readonly pendingEffectCount: number;
  readonly lastReconciledAtMs: number | null;
  readonly runtime: Readonly<Record<string, unknown>> | null;
}

export interface PairSummaryResponse {
  readonly capability: PairReadCapability;
  readonly health: PairReadHealth;
  readonly current: {
    readonly openEpisodes: number;
    readonly activeGroups: number;
    readonly residualGroups: number;
    readonly unknownOutcomeGroups: number;
    readonly manualReviewGroups: number;
    readonly pairCashAvailable6: string;
    readonly pairCashReserved6: string;
  };
  readonly trailing24h: {
    readonly evaluatedEnvelopes: string;
    readonly episodes: number;
    readonly grossDislocations: string;
    readonly feePositiveObservations: string;
    readonly activationSurvivors: number;
    readonly paperGroups: number;
    readonly pairedGroups: number;
    readonly residualGroups: number;
    readonly realizedPnl6: string;
  };
}

type ExactReadRow = Readonly<Record<string, unknown>>;

interface Cursor { readonly tsMs: number; readonly id: string }
interface NormalizedQuery {
  readonly limit: number;
  readonly cursor: Cursor | null;
  readonly marketId: string | null;
  readonly state: string | null;
  readonly primaryRejectionCode: string | null;
  readonly dispatchModel: string | null;
  readonly recoveryPolicy: string | null;
  readonly reconciliationStatus: string | null;
  readonly fromMs: number | null;
  readonly toMs: number | null;
  readonly minimumNetPnl6: bigint | null;
  readonly hasResidual: boolean | null;
  readonly status: string | null;
}

function exact(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(exact);
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, exact(item)])));
  }
  return value;
}

function exactRow<Row extends Record<string, unknown>>(row: Row): ExactReadRow {
  return exact(row) as ExactReadRow;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ tsMs: String(cursor.tsMs), id: cursor.id }), "utf8").toString("base64url");
}

export function decodePairReadCursor(value: string): Cursor {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new PairReadModelValidationError("cursor is not valid base64url");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new PairReadModelValidationError("cursor is not valid encoded JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PairReadModelValidationError("cursor payload must be an object");
  }
  const object = parsed as Record<string, unknown>;
  if (Object.keys(object).sort().join(",") !== "id,tsMs" || typeof object.id !== "string" || object.id.length === 0 ||
    typeof object.tsMs !== "string" || !/^(0|[1-9][0-9]*)$/.test(object.tsMs)) {
    throw new PairReadModelValidationError("cursor payload fields are invalid");
  }
  const tsMs = Number(object.tsMs);
  if (!Number.isSafeInteger(tsMs)) throw new PairReadModelValidationError("cursor timestamp is outside the safe range");
  return { tsMs, id: object.id };
}

function scalar(query: Readonly<Record<string, unknown>>, key: string): unknown {
  const value = query[key];
  if (Array.isArray(value)) throw new PairReadModelValidationError(`${key} must occur once`);
  return value;
}

function optionalString(query: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = scalar(query, key);
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0) throw new PairReadModelValidationError(`${key} must be a non-empty string`);
  return value;
}

function optionalTime(query: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = scalar(query, key);
  if (value === undefined) return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new PairReadModelValidationError(`${key} must be a non-negative safe integer`);
  return parsed;
}

function optionalEnum(query: Readonly<Record<string, unknown>>, key: string, values: readonly string[]): string | null {
  const value = optionalString(query, key);
  if (value !== null && !values.includes(value)) throw new PairReadModelValidationError(`${key} is not a supported value`);
  return value;
}

function normalizeQuery(query: Readonly<Record<string, unknown>>, allowed: readonly string[]): NormalizedQuery {
  const extras = Object.keys(query).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new PairReadModelValidationError(`unsupported filters: ${extras.sort().join(",")}`);
  const rawLimit = scalar(query, "limit");
  const limit = rawLimit === undefined ? DEFAULT_LIMIT
    : typeof rawLimit === "number" ? rawLimit
      : typeof rawLimit === "string" && /^[1-9][0-9]*$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new PairReadModelValidationError(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  const cursorText = optionalString(query, "cursor");
  const fromMs = optionalTime(query, "from_ms");
  const toMs = optionalTime(query, "to_ms");
  if (fromMs !== null && toMs !== null && fromMs > toMs) throw new PairReadModelValidationError("from_ms must not exceed to_ms");
  const minimum = optionalString(query, "minimum_net_pnl6");
  if (minimum !== null && !/^-?(0|[1-9][0-9]*)$/.test(minimum)) throw new PairReadModelValidationError("minimum_net_pnl6 must be an exact decimal integer");
  const residual = scalar(query, "has_residual");
  const hasResidual = residual === undefined ? null
    : residual === true || residual === "true" ? true
      : residual === false || residual === "false" ? false
        : (() => { throw new PairReadModelValidationError("has_residual must be true or false"); })();
  return {
    limit,
    cursor: cursorText === null ? null : decodePairReadCursor(cursorText),
    marketId: optionalString(query, "market_id"),
    state: optionalString(query, "state"),
    primaryRejectionCode: optionalString(query, "primary_rejection_code"),
    dispatchModel: optionalString(query, "dispatch_model"),
    recoveryPolicy: optionalString(query, "recovery_policy"),
    reconciliationStatus: optionalString(query, "reconciliation_status"),
    fromMs,
    toMs,
    minimumNetPnl6: minimum === null ? null : BigInt(minimum),
    hasResidual,
    status: optionalString(query, "status"),
  };
}

function cursorCondition(timestamp: Parameters<typeof lt>[0], id: Parameters<typeof lt>[0], cursor: Cursor | null): SQL | undefined {
  if (cursor === null) return undefined;
  return or(lt(timestamp, cursor.tsMs), and(eq(timestamp, cursor.tsMs), lt(id, cursor.id)));
}

function page<Row extends Record<string, unknown>>(
  rows: readonly Row[],
  limit: number,
  timestamp: (row: Row) => number,
  id: (row: Row) => string,
): PairPage<ExactReadRow> {
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  const last = selected[selected.length - 1];
  return {
    items: selected.map(exactRow),
    nextCursor: hasMore && last !== undefined ? encodeCursor({ tsMs: timestamp(last), id: id(last) }) : null,
  };
}

function textTotal(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return "0";
}

export class PairReadModelRepository {
  constructor(private readonly handle: DbHandle, private readonly options: PairReadRepositoryOptions) {}

  private trace(name: string): void { this.options.onQuery?.(name); }

  async getHealth(): Promise<PairReadHealth> {
    this.trace("health");
    const [accounts, groups, effects, reconciled] = await Promise.all([
      this.handle.db.select({ value: count() }).from(schema.pairPaperAccounts)
        .where(sql`${schema.pairPaperAccounts.reconciliationStatus} <> 'HEALTHY'`),
      this.handle.db.select({ state: schema.pairOrderGroups.state, reconciliationStatus: schema.pairOrderGroups.reconciliationStatus, value: count() })
        .from(schema.pairOrderGroups).groupBy(schema.pairOrderGroups.state, schema.pairOrderGroups.reconciliationStatus),
      this.handle.db.select({ value: count() }).from(schema.pairEffectOutbox)
        .where(inArray(schema.pairEffectOutbox.state, ["PENDING", "CLAIMED", "UNKNOWN"])),
      this.handle.db.select({ last: sql<number | null>`max(${schema.pairReconciliations.completedAtMs})` }).from(schema.pairReconciliations),
    ]);
    const groupMismatchCount = groups.filter((row) => row.reconciliationStatus === "MISMATCH").reduce((sum, row) => sum + row.value, 0);
    const unknownOutcomeGroupCount = groups.filter((row) => row.state.includes("UNKNOWN")).reduce((sum, row) => sum + row.value, 0);
    const manualReviewGroupCount = groups.filter((row) => row.state === "MANUAL_REVIEW").reduce((sum, row) => sum + row.value, 0);
    const pairAccountMismatchCount = accounts[0]?.value ?? 0;
    const pendingEffectCount = effects[0]?.value ?? 0;
    const degraded = pairAccountMismatchCount > 0 || groupMismatchCount > 0 || unknownOutcomeGroupCount > 0 || manualReviewGroupCount > 0;
    return {
      status: degraded ? "DEGRADED" : "HEALTHY",
      paperSchedulingAllowed: !degraded && this.options.capability.paperExecutionEnabled,
      pairAccountMismatchCount,
      groupMismatchCount,
      unknownOutcomeGroupCount,
      manualReviewGroupCount,
      pendingEffectCount,
      lastReconciledAtMs: reconciled[0]?.last ?? null,
      runtime: this.options.runtimeHealth?.() ?? null,
    };
  }

  async getSummary(nowMs: number): Promise<PairSummaryResponse> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new PairReadModelValidationError("nowMs must be a non-negative safe integer");
    const cutoff = Math.max(0, nowMs - 86_400_000);
    this.trace("summary");
    const [health, openEpisodes, stateCounts, accounts, buckets, episodes24, groups24] = await Promise.all([
      this.getHealth(),
      this.handle.db.select({ value: count() }).from(schema.pairOpportunityEpisodes).where(eq(schema.pairOpportunityEpisodes.state, "OPEN")),
      this.handle.db.select({ state: schema.pairOrderGroups.state, value: count() }).from(schema.pairOrderGroups).groupBy(schema.pairOrderGroups.state),
      this.handle.db.select({
        available: sql<string>`coalesce(sum(${schema.pairPaperAccounts.cashAvailable6}), 0)::text`,
        reserved: sql<string>`coalesce(sum(${schema.pairPaperAccounts.cashReserved6}), 0)::text`,
      }).from(schema.pairPaperAccounts).where(sql`${schema.pairPaperAccounts.closedAtMs} is null`),
      this.handle.db.select({
        evaluated: sql<string>`coalesce(sum(${schema.pairObserverBucketStats.evaluatedCaptures}), 0)::text`,
        gross: sql<string>`coalesce(sum(${schema.pairObserverBucketStats.grossDislocations}), 0)::text`,
        feePositive: sql<string>`coalesce(sum(${schema.pairObserverBucketStats.feePositive}), 0)::text`,
      }).from(schema.pairObserverBucketStats).where(gte(schema.pairObserverBucketStats.bucketStartMs, cutoff)),
      this.handle.db.select({ value: count() }).from(schema.pairOpportunityEpisodes).where(gte(schema.pairOpportunityEpisodes.firstObservedAtMs, cutoff)),
      this.handle.db.select({
        total: count(),
        activation: sql<number>`count(*) filter (where ${schema.pairOrderGroups.activationNetPnl6} is not null)::int`,
        paired: sql<number>`count(*) filter (where ${schema.pairOrderGroups.state} in ('PAIRED','AWAITING_SETTLEMENT','MERGE_PENDING','RECONCILED_SETTLED'))::int`,
        residual: sql<number>`count(*) filter (where ${schema.pairOrderGroups.residualShares6} > 0)::int`,
        realized: sql<string>`coalesce(sum(${schema.pairOrderGroups.realizedPairPnl6}), 0)::text`,
      }).from(schema.pairOrderGroups).where(gte(schema.pairOrderGroups.createdAtMs, cutoff)),
    ]);
    const stateCount = (states: readonly string[]) => stateCounts.filter((row) => states.includes(row.state)).reduce((sum, row) => sum + row.value, 0);
    return {
      capability: this.options.capability,
      health,
      current: {
        openEpisodes: openEpisodes[0]?.value ?? 0,
        activeGroups: stateCount(ACTIVE_GROUP_STATES),
        residualGroups: stateCount(["RESIDUAL", "RECOVERY_PENDING", "RECOVERING", "AWAITING_RESOLUTION"]),
        unknownOutcomeGroups: stateCounts.filter((row) => row.state.includes("UNKNOWN")).reduce((sum, row) => sum + row.value, 0),
        manualReviewGroups: stateCount(["MANUAL_REVIEW"]),
        pairCashAvailable6: textTotal(accounts[0]?.available),
        pairCashReserved6: textTotal(accounts[0]?.reserved),
      },
      trailing24h: {
        evaluatedEnvelopes: textTotal(buckets[0]?.evaluated),
        episodes: episodes24[0]?.value ?? 0,
        grossDislocations: textTotal(buckets[0]?.gross),
        feePositiveObservations: textTotal(buckets[0]?.feePositive),
        activationSurvivors: groups24[0]?.activation ?? 0,
        paperGroups: groups24[0]?.total ?? 0,
        pairedGroups: groups24[0]?.paired ?? 0,
        residualGroups: groups24[0]?.residual ?? 0,
        realizedPnl6: textTotal(groups24[0]?.realized),
      },
    };
  }

  async listEpisodes(query: Readonly<Record<string, unknown>> = {}): Promise<PairPage<ExactReadRow>> {
    const q = normalizeQuery(query, ["market_id", "state", "from_ms", "to_ms", "limit", "cursor"]);
    if (q.state !== null && !EPISODE_STATES.includes(q.state as never)) throw new PairReadModelValidationError("state is not a supported episode state");
    const where = and(
      q.marketId === null ? undefined : eq(schema.pairOpportunityEpisodes.marketId, q.marketId),
      q.state === null ? undefined : eq(schema.pairOpportunityEpisodes.state, q.state),
      q.fromMs === null ? undefined : gte(schema.pairOpportunityEpisodes.firstObservedAtMs, q.fromMs),
      q.toMs === null ? undefined : lte(schema.pairOpportunityEpisodes.firstObservedAtMs, q.toMs),
      cursorCondition(schema.pairOpportunityEpisodes.firstObservedAtMs, schema.pairOpportunityEpisodes.id, q.cursor),
    );
    this.trace("episodes.list");
    const rows = await this.handle.db.select().from(schema.pairOpportunityEpisodes).where(where)
      .orderBy(desc(schema.pairOpportunityEpisodes.firstObservedAtMs), desc(schema.pairOpportunityEpisodes.id)).limit(q.limit + 1);
    return page(rows, q.limit, (row) => row.firstObservedAtMs, (row) => row.id);
  }

  async getEpisode(id: string): Promise<ExactReadRow | null> {
    assertReadId(id);
    this.trace("episodes.detail");
    const rows = await this.handle.db.select().from(schema.pairOpportunityEpisodes).where(eq(schema.pairOpportunityEpisodes.id, id)).limit(1);
    if (rows[0] === undefined) return null;
    const [observations, groups] = await Promise.all([
      this.handle.db.select().from(schema.pairOpportunityObservations).where(eq(schema.pairOpportunityObservations.episodeId, id))
        .orderBy(desc(schema.pairOpportunityObservations.observedAtMs), desc(schema.pairOpportunityObservations.id)),
      this.handle.db.select().from(schema.pairOrderGroups).where(eq(schema.pairOrderGroups.episodeId, id))
        .orderBy(desc(schema.pairOrderGroups.createdAtMs), desc(schema.pairOrderGroups.id)),
    ]);
    return exactRow({ ...rows[0], observations, groups });
  }

  async listObservations(query: Readonly<Record<string, unknown>> = {}): Promise<PairPage<ExactReadRow>> {
    const q = normalizeQuery(query, ["market_id", "primary_rejection_code", "from_ms", "to_ms", "minimum_net_pnl6", "limit", "cursor"]);
    const where = and(
      q.marketId === null ? undefined : eq(schema.pairOpportunityObservations.marketId, q.marketId),
      q.primaryRejectionCode === null ? undefined : eq(schema.pairOpportunityObservations.primaryRejectionCode, q.primaryRejectionCode),
      q.fromMs === null ? undefined : gte(schema.pairOpportunityObservations.observedAtMs, q.fromMs),
      q.toMs === null ? undefined : lte(schema.pairOpportunityObservations.observedAtMs, q.toMs),
      q.minimumNetPnl6 === null ? undefined : gte(schema.pairOpportunityObservations.netPreLatencyPnl6, q.minimumNetPnl6),
      cursorCondition(schema.pairOpportunityObservations.observedAtMs, schema.pairOpportunityObservations.id, q.cursor),
    );
    this.trace("observations.list");
    const rows = await this.handle.db.select().from(schema.pairOpportunityObservations).where(where)
      .orderBy(desc(schema.pairOpportunityObservations.observedAtMs), desc(schema.pairOpportunityObservations.id)).limit(q.limit + 1);
    return page(rows, q.limit, (row) => row.observedAtMs, (row) => row.id);
  }

  async getObservation(id: string): Promise<ExactReadRow | null> {
    assertReadId(id);
    this.trace("observations.detail");
    const rows = await this.handle.db.select().from(schema.pairOpportunityObservations).where(eq(schema.pairOpportunityObservations.id, id)).limit(1);
    if (rows[0] === undefined) return null;
    const captures = await this.handle.db.select().from(schema.pairBookCaptures).where(eq(schema.pairBookCaptures.id, rows[0].captureId)).limit(1);
    return exactRow({ ...rows[0], capture: captures[0] ?? null });
  }

  async listGroups(query: Readonly<Record<string, unknown>> = {}): Promise<PairPage<ExactReadRow>> {
    const q = normalizeQuery(query, ["market_id", "state", "dispatch_model", "recovery_policy", "from_ms", "to_ms", "has_residual", "reconciliation_status", "limit", "cursor"]);
    if (q.state !== null && !GROUP_STATES.includes(q.state as never)) throw new PairReadModelValidationError("state is not a supported group state");
    if (q.dispatchModel !== null && !DISPATCH_MODELS.includes(q.dispatchModel as never)) throw new PairReadModelValidationError("dispatch_model is unsupported");
    if (q.recoveryPolicy !== null && !RECOVERY_POLICIES.includes(q.recoveryPolicy as never)) throw new PairReadModelValidationError("recovery_policy is unsupported");
    if (q.reconciliationStatus !== null && !RECONCILIATION_STATUSES.includes(q.reconciliationStatus as never)) throw new PairReadModelValidationError("reconciliation_status is unsupported");
    const where = and(
      q.marketId === null ? undefined : eq(schema.pairOrderGroups.marketId, q.marketId),
      q.state === null ? undefined : eq(schema.pairOrderGroups.state, q.state),
      q.dispatchModel === null ? undefined : eq(schema.pairOrderGroups.dispatchModel, q.dispatchModel),
      q.recoveryPolicy === null ? undefined : eq(schema.pairOrderGroups.recoveryPolicy, q.recoveryPolicy),
      q.reconciliationStatus === null ? undefined : eq(schema.pairOrderGroups.reconciliationStatus, q.reconciliationStatus),
      q.hasResidual === null ? undefined : q.hasResidual ? gt(schema.pairOrderGroups.residualShares6, 0n) : eq(schema.pairOrderGroups.residualShares6, 0n),
      q.fromMs === null ? undefined : gte(schema.pairOrderGroups.createdAtMs, q.fromMs),
      q.toMs === null ? undefined : lte(schema.pairOrderGroups.createdAtMs, q.toMs),
      cursorCondition(schema.pairOrderGroups.createdAtMs, schema.pairOrderGroups.id, q.cursor),
    );
    this.trace("groups.list");
    const rows = await this.handle.db.select().from(schema.pairOrderGroups).where(where)
      .orderBy(desc(schema.pairOrderGroups.createdAtMs), desc(schema.pairOrderGroups.id)).limit(q.limit + 1);
    return page(rows, q.limit, (row) => row.createdAtMs, (row) => row.id);
  }

  async getGroup(id: string): Promise<ExactReadRow | null> {
    assertReadId(id);
    this.trace("groups.detail");
    const groups = await this.handle.db.select().from(schema.pairOrderGroups).where(eq(schema.pairOrderGroups.id, id)).limit(1);
    if (groups[0] === undefined) return null;
    this.trace("groups.children.batch");
    const [actions, effects, lots, consumptions, ledger, evidence] = await Promise.all([
      this.handle.db.select().from(schema.pairActionIntents).where(eq(schema.pairActionIntents.groupId, id)).orderBy(schema.pairActionIntents.actionSequence),
      this.handle.db.select().from(schema.pairEffectOutbox).where(eq(schema.pairEffectOutbox.groupId, id)).orderBy(schema.pairEffectOutbox.actionSequence, schema.pairEffectOutbox.effectOrdinal),
      this.handle.db.select().from(schema.pairInventoryLots).where(eq(schema.pairInventoryLots.groupId, id)).orderBy(schema.pairInventoryLots.acquiredAtMs, schema.pairInventoryLots.id),
      this.handle.db.select().from(schema.pairInventoryConsumptions).where(eq(schema.pairInventoryConsumptions.groupId, id)).orderBy(schema.pairInventoryConsumptions.createdAtMs, schema.pairInventoryConsumptions.id),
      this.handle.db.select().from(schema.pairLedgerEntries).where(eq(schema.pairLedgerEntries.groupId, id)).orderBy(schema.pairLedgerEntries.occurredAtMs, schema.pairLedgerEntries.journalId, schema.pairLedgerEntries.lineNumber),
      this.handle.db.select().from(schema.pairInboxEvidence).where(eq(schema.pairInboxEvidence.groupId, id)).orderBy(schema.pairInboxEvidence.receivedTsMs, schema.pairInboxEvidence.id),
    ]);
    return exactRow({ ...groups[0], actions, effects, inventoryLots: lots, inventoryConsumptions: consumptions, ledgerEntries: ledger, evidence });
  }

  async listGroupEvents(groupId: string, query: Readonly<Record<string, unknown>> = {}): Promise<PairPage<ExactReadRow>> {
    assertReadId(groupId);
    const q = normalizeQuery(query, ["from_ms", "to_ms", "limit", "cursor"]);
    const where = and(
      eq(schema.pairGroupEvents.groupId, groupId),
      q.fromMs === null ? undefined : gte(schema.pairGroupEvents.occurredAtMs, q.fromMs),
      q.toMs === null ? undefined : lte(schema.pairGroupEvents.occurredAtMs, q.toMs),
      cursorCondition(schema.pairGroupEvents.occurredAtMs, schema.pairGroupEvents.id, q.cursor),
    );
    this.trace("groups.events");
    const rows = await this.handle.db.select().from(schema.pairGroupEvents).where(where)
      .orderBy(desc(schema.pairGroupEvents.occurredAtMs), desc(schema.pairGroupEvents.id)).limit(q.limit + 1);
    return page(rows, q.limit, (row) => row.occurredAtMs, (row) => row.id);
  }

  async listGroupReconciliations(groupId: string, query: Readonly<Record<string, unknown>> = {}): Promise<PairPage<ExactReadRow>> {
    assertReadId(groupId);
    const q = normalizeQuery(query, ["from_ms", "to_ms", "limit", "cursor"]);
    this.trace("groups.reconciliations");
    const rows = await this.handle.db.select().from(schema.pairReconciliations).where(and(
      eq(schema.pairReconciliations.groupId, groupId),
      q.fromMs === null ? undefined : gte(schema.pairReconciliations.startedAtMs, q.fromMs),
      q.toMs === null ? undefined : lte(schema.pairReconciliations.startedAtMs, q.toMs),
      cursorCondition(schema.pairReconciliations.startedAtMs, schema.pairReconciliations.id, q.cursor),
    )).orderBy(desc(schema.pairReconciliations.startedAtMs), desc(schema.pairReconciliations.id)).limit(q.limit + 1);
    const selected = rows.slice(0, q.limit);
    const ids = selected.map((row) => row.id);
    this.trace("groups.reconciliation-diffs.batch");
    const diffs = ids.length === 0 ? [] : await this.handle.db.select().from(schema.pairReconciliationDiffs)
      .where(inArray(schema.pairReconciliationDiffs.reconciliationId, ids))
      .orderBy(schema.pairReconciliationDiffs.reconciliationId, schema.pairReconciliationDiffs.createdAtMs, schema.pairReconciliationDiffs.id);
    const byRun = new Map<string, typeof diffs>();
    for (const diff of diffs) byRun.set(diff.reconciliationId, [...(byRun.get(diff.reconciliationId) ?? []), diff]);
    const joined = selected.map((row) => ({ ...row, diffs: byRun.get(row.id) ?? [] }));
    const hasMore = rows.length > q.limit;
    const last = joined[joined.length - 1];
    return {
      items: joined.map(exactRow),
      nextCursor: hasMore && last !== undefined ? encodeCursor({ tsMs: last.startedAtMs, id: last.id }) : null,
    };
  }

  async listResearchRuns(query: Readonly<Record<string, unknown>> = {}): Promise<PairPage<ExactReadRow>> {
    const q = normalizeQuery(query, ["status", "from_ms", "to_ms", "limit", "cursor"]);
    if (q.status !== null && !RESEARCH_STATUSES.includes(q.status as never)) throw new PairReadModelValidationError("status is unsupported");
    this.trace("research-runs.list");
    const rows = await this.handle.db.select().from(schema.pairResearchRuns).where(and(
      q.status === null ? undefined : eq(schema.pairResearchRuns.status, q.status),
      q.fromMs === null ? undefined : gte(schema.pairResearchRuns.startedAtMs, q.fromMs),
      q.toMs === null ? undefined : lte(schema.pairResearchRuns.startedAtMs, q.toMs),
      cursorCondition(schema.pairResearchRuns.startedAtMs, schema.pairResearchRuns.id, q.cursor),
    )).orderBy(desc(schema.pairResearchRuns.startedAtMs), desc(schema.pairResearchRuns.id)).limit(q.limit + 1);
    return page(rows, q.limit, (row) => row.startedAtMs, (row) => row.id);
  }

  async getResearchRun(id: string): Promise<ExactReadRow | null> {
    assertReadId(id);
    this.trace("research-runs.detail");
    const rows = await this.handle.db.select().from(schema.pairResearchRuns).where(eq(schema.pairResearchRuns.id, id)).limit(1);
    if (rows[0] === undefined) return null;
    this.trace("research-runs.children.batch");
    const [scenarios, artifacts] = await Promise.all([
      this.handle.db.select().from(schema.pairResearchScenarios).where(eq(schema.pairResearchScenarios.runId, id))
        .orderBy(desc(schema.pairResearchScenarios.startedAtMs), desc(schema.pairResearchScenarios.id)),
      this.handle.db.select().from(schema.pairResearchArtifacts).where(eq(schema.pairResearchArtifacts.runId, id))
        .orderBy(schema.pairResearchArtifacts.artifactKind, schema.pairResearchArtifacts.id),
    ]);
    return exactRow({ ...rows[0], scenarios, artifacts });
  }
}

function assertReadId(id: string): void {
  if (id.trim().length === 0) throw new PairReadModelValidationError("id must not be empty");
}
