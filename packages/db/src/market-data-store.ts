import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Db } from "./client";
import { marketTradeTicks, orderbookEvents, orderbookSnapshots } from "./schema";

export const MARKET_DATA_EVENT_KINDS = [
  "SNAPSHOT",
  "DELTA",
  "TRADE",
  "CONNECTION_RESET",
  "ENVELOPE_BOUNDARY",
] as const;

export type MarketDataEventKind = (typeof MARKET_DATA_EVENT_KINDS)[number];
export type SourceTimestampKind = "SOURCE" | "RECEIVE_FALLBACK";
export type CanonicalBookIntegrity =
  | "VERIFIED_SNAPSHOT"
  | "UNSEQUENCED_AFTER_SNAPSHOT"
  | "INVALID_AFTER_RECONNECT";

export interface PersistedBookLevel {
  readonly price6: string;
  readonly size6: string;
}

export interface MarketDataEventInput {
  readonly marketId: string;
  readonly tokenId: string | null;
  readonly eventKind: MarketDataEventKind;
  readonly connectionEpoch: string;
  readonly envelopeId: string;
  readonly sequenceInEnvelope: number;
  readonly sourceEventId?: string | null;
  readonly sourceTsMs: number | null;
  readonly sourceTimestampKind: SourceTimestampKind;
  readonly receivedTsMs: number;
  readonly exchangeHash?: string | null;
  /** Normalized JSON payload. Exact integer quantities must be decimal strings. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Optional producer hash. When supplied it must match the store's canonical hash. */
  readonly payloadHash?: string;
  readonly createdAtMs: number;
}

export interface PersistedMarketDataEvent extends MarketDataEventInput {
  readonly id: bigint;
  readonly sourceEventId: string | null;
  readonly exchangeHash: string | null;
  readonly payloadHash: string;
}

export interface CanonicalPersistedBook {
  readonly marketId: string;
  readonly tokenId: string;
  readonly connectionEpoch: string;
  readonly bookVersion: bigint;
  readonly bids: readonly PersistedBookLevel[];
  readonly asks: readonly PersistedBookLevel[];
  /** Null is preserved when the venue supplied no source timestamp. */
  readonly sourceTsMs: number | null;
  readonly receivedTsMs: number;
  readonly sourceTimestampKind: SourceTimestampKind;
  readonly integrity: CanonicalBookIntegrity;
  readonly lastEventId: bigint;
}

export interface ReconstructionResult {
  readonly book: CanonicalPersistedBook | null;
  readonly checkpointId: bigint | null;
  readonly appliedEventIds: readonly bigint[];
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const DECIMAL = /^(?:0|[1-9]\d*)$/;
const HASH = /^[0-9a-f]{64}$/;

function assertSafeTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
}

function canonicalJsonValue(value: unknown, path = "$", seen = new Set<object>()): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${path} number must be a safe integer`);
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError(`${path} must not contain a cycle`);
    seen.add(value);
    const result = value.map((item, index) => canonicalJsonValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError(`${path} must not contain a cycle`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain object`);
    seen.add(value);
    const result: Record<string, Json> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new TypeError(`${path}.${key} must not be undefined`);
      result[key] = canonicalJsonValue(item, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError(`${path} contains unsupported ${typeof value}`);
}

export function canonicalMarketDataJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

export function marketDataPayloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalMarketDataJson(payload), "utf8").digest("hex");
}

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) throw new TypeError(`${name} must not be empty`);
}

function asDecimal(value: unknown, name: string, allowZero: boolean): string {
  const text = typeof value === "bigint" ? value.toString(10) : value;
  if (typeof text !== "string" || !DECIMAL.test(text) || (!allowZero && text === "0")) {
    throw new TypeError(`${name} must be a canonical ${allowZero ? "non-negative" : "positive"} decimal string`);
  }
  return text;
}

function parseLevel(value: unknown, name: string, allowZeroSize: boolean): PersistedBookLevel {
  if (Array.isArray(value) && value.length === 2) {
    return Object.freeze({
      price6: asDecimal(value[0], `${name}[0]`, false),
      size6: asDecimal(value[1], `${name}[1]`, allowZeroSize),
    });
  }
  if (value !== null && typeof value === "object") {
    const level = value as Record<string, unknown>;
    return Object.freeze({
      price6: asDecimal(level.price6, `${name}.price6`, false),
      size6: asDecimal(level.size6, `${name}.size6`, allowZeroSize),
    });
  }
  throw new TypeError(`${name} must be [price6,size6] or {price6,size6}`);
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("market-data payload must be a plain object");
  }
  return payload as Record<string, unknown>;
}

function snapshotLevels(payload: unknown, side: "bids" | "asks"): readonly PersistedBookLevel[] {
  const values = payloadRecord(payload)[side];
  if (!Array.isArray(values)) throw new TypeError(`SNAPSHOT payload.${side} must be an array`);
  const result = values.map((level, i) => parseLevel(level, `payload.${side}[${i}]`, false));
  const prices = new Set(result.map((level) => level.price6));
  if (prices.size !== result.length) throw new TypeError(`SNAPSHOT payload.${side} contains a duplicate price`);
  result.sort((a, b) => {
    const left = BigInt(a.price6);
    const right = BigInt(b.price6);
    return side === "bids" ? (left > right ? -1 : left < right ? 1 : 0) : (left < right ? -1 : left > right ? 1 : 0);
  });
  return Object.freeze(result);
}

interface DeltaChange extends PersistedBookLevel { readonly side: "BUY" | "SELL" }

function deltaChanges(payload: unknown): readonly DeltaChange[] {
  const values = payloadRecord(payload).changes;
  if (!Array.isArray(values) || values.length === 0) throw new TypeError("DELTA payload.changes must be a non-empty array");
  return Object.freeze(values.map((value, i) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`payload.changes[${i}] must be an object`);
    }
    const record = value as Record<string, unknown>;
    if (record.side !== "BUY" && record.side !== "SELL") throw new TypeError(`payload.changes[${i}].side must be BUY or SELL`);
    const level = parseLevel(record, `payload.changes[${i}]`, true);
    return Object.freeze({ side: record.side, ...level });
  }));
}

function tradePayload(payload: unknown): { price6: bigint; size6: bigint; side: string | null } {
  const record = payloadRecord(payload);
  const side = record.side;
  if (side !== undefined && side !== null && side !== "BUY" && side !== "SELL") {
    throw new TypeError("TRADE payload.side must be BUY, SELL, or null");
  }
  return {
    price6: BigInt(asDecimal(record.price6, "payload.price6", false)),
    size6: BigInt(asDecimal(record.size6, "payload.size6", false)),
    side: side ?? null,
  };
}

function validateEvent(input: MarketDataEventInput): { payload: Record<string, unknown>; payloadHash: string } {
  assertNonEmpty(input.marketId, "marketId");
  assertNonEmpty(input.connectionEpoch, "connectionEpoch");
  assertNonEmpty(input.envelopeId, "envelopeId");
  if (!Number.isSafeInteger(input.sequenceInEnvelope) || input.sequenceInEnvelope < 0) {
    throw new TypeError("sequenceInEnvelope must be a non-negative integer");
  }
  assertSafeTimestamp(input.receivedTsMs, "receivedTsMs");
  assertSafeTimestamp(input.createdAtMs, "createdAtMs");
  if (input.sourceTsMs === null) {
    if (input.sourceTimestampKind !== "RECEIVE_FALLBACK") {
      throw new TypeError("missing sourceTsMs must be labeled RECEIVE_FALLBACK");
    }
  } else {
    assertSafeTimestamp(input.sourceTsMs, "sourceTsMs");
    if (input.sourceTimestampKind !== "SOURCE") throw new TypeError("sourceTsMs must be labeled SOURCE");
  }
  if ((input.eventKind === "SNAPSHOT" || input.eventKind === "DELTA" || input.eventKind === "TRADE") && input.tokenId === null) {
    throw new TypeError(`${input.eventKind} requires tokenId`);
  }
  if (input.eventKind === "TRADE" && input.sourceTsMs === null) throw new TypeError("TRADE requires a source timestamp");
  const payload = canonicalJsonValue(input.payload) as Record<string, unknown>;
  if (input.eventKind === "SNAPSHOT") {
    snapshotLevels(payload, "bids");
    snapshotLevels(payload, "asks");
  } else if (input.eventKind === "DELTA") {
    deltaChanges(payload);
  } else if (input.eventKind === "TRADE") {
    tradePayload(payload);
  }
  const actualHash = marketDataPayloadHash(payload);
  if (input.payloadHash !== undefined && input.payloadHash !== actualHash) throw new Error("market-data payload hash mismatch");
  return { payload, payloadHash: actualHash };
}

function normalizeRow(row: typeof orderbookEvents.$inferSelect): PersistedMarketDataEvent {
  return Object.freeze({
    id: row.id,
    marketId: row.marketId,
    tokenId: row.tokenId,
    eventKind: row.eventKind as MarketDataEventKind,
    connectionEpoch: row.connectionEpoch,
    envelopeId: row.envelopeId,
    sequenceInEnvelope: row.sequenceInEnvelope,
    sourceEventId: row.sourceEventId,
    sourceTsMs: row.sourceTsMs,
    sourceTimestampKind: row.sourceTimestampKind as SourceTimestampKind,
    receivedTsMs: row.receivedTsMs,
    exchangeHash: row.exchangeHash,
    payloadHash: row.payloadHash,
    payload: row.payload as Readonly<Record<string, unknown>>,
    createdAtMs: row.createdAtMs,
  });
}

function eventMatches(row: PersistedMarketDataEvent, input: MarketDataEventInput, payloadHash: string): boolean {
  return row.marketId === input.marketId
    && row.tokenId === input.tokenId
    && row.eventKind === input.eventKind
    && row.sourceEventId === (input.sourceEventId ?? null)
    && row.sourceTsMs === input.sourceTsMs
    && row.sourceTimestampKind === input.sourceTimestampKind
    && row.receivedTsMs === input.receivedTsMs
    && row.exchangeHash === (input.exchangeHash ?? null)
    && row.payloadHash === payloadHash
    && row.createdAtMs === input.createdAtMs;
}

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Append-only §18.12 event store. It never updates or deletes an event row.
 * Retrying an identical envelope is idempotent; reusing an envelope position
 * for different content is rejected instead of silently accepting evidence.
 */
export class MarketDataStore {
  constructor(private readonly db: Db) {}

  async appendEvent(input: MarketDataEventInput): Promise<PersistedMarketDataEvent> {
    const [event] = await this.appendBatch([input]);
    return event!;
  }

  async appendEnvelope(inputs: readonly MarketDataEventInput[]): Promise<readonly PersistedMarketDataEvent[]> {
    if (inputs.length === 0) throw new TypeError("an envelope must contain at least one event and a boundary");
    const first = inputs[0]!;
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;
      if (input.connectionEpoch !== first.connectionEpoch || input.envelopeId !== first.envelopeId || input.marketId !== first.marketId) {
        throw new Error("all envelope rows must share marketId, connectionEpoch, and envelopeId");
      }
      if (input.sequenceInEnvelope !== i) throw new Error("envelope sequence must be contiguous and start at zero");
      if (input.eventKind === "ENVELOPE_BOUNDARY" && i !== inputs.length - 1) throw new Error("envelope boundary must be last");
    }
    if (inputs[inputs.length - 1]!.eventKind !== "ENVELOPE_BOUNDARY") throw new Error("envelope must end with ENVELOPE_BOUNDARY");
    return this.appendBatch(inputs);
  }

  async appendBatch(inputs: readonly MarketDataEventInput[]): Promise<readonly PersistedMarketDataEvent[]> {
    if (inputs.length === 0) return Object.freeze([]);
    const validated = inputs.map(validateEvent);
    for (let i = 1; i < inputs.length; i++) {
      if (inputs[i]!.receivedTsMs < inputs[i - 1]!.receivedTsMs) {
        throw new Error("market-data batch received timestamps must not regress");
      }
    }
    return this.db.transaction(async (tx) => {
      const result: PersistedMarketDataEvent[] = [];
      for (let i = 0; i < inputs.length; i++) {
        result.push(await this.insertOne(tx, inputs[i]!, validated[i]!));
      }
      return Object.freeze(result);
    });
  }

  private async insertOne(
    tx: Transaction,
    input: MarketDataEventInput,
    validated: { payload: Record<string, unknown>; payloadHash: string },
  ): Promise<PersistedMarketDataEvent> {
    const inserted = await tx.insert(orderbookEvents).values({
      marketId: input.marketId,
      tokenId: input.tokenId,
      eventKind: input.eventKind,
      connectionEpoch: input.connectionEpoch,
      envelopeId: input.envelopeId,
      sequenceInEnvelope: input.sequenceInEnvelope,
      sourceEventId: input.sourceEventId ?? null,
      sourceTsMs: input.sourceTsMs,
      sourceTimestampKind: input.sourceTimestampKind,
      receivedTsMs: input.receivedTsMs,
      exchangeHash: input.exchangeHash ?? null,
      payloadHash: validated.payloadHash,
      payload: validated.payload,
      createdAtMs: input.createdAtMs,
    }).onConflictDoNothing({
      target: [orderbookEvents.connectionEpoch, orderbookEvents.envelopeId, orderbookEvents.sequenceInEnvelope],
    }).returning();

    let row: PersistedMarketDataEvent;
    if (inserted[0] !== undefined) {
      row = normalizeRow(inserted[0]);
      if (input.eventKind === "TRADE") {
        const trade = tradePayload(validated.payload);
        await tx.insert(marketTradeTicks).values({
          marketId: input.marketId,
          tokenId: input.tokenId!,
          price6: trade.price6,
          size6: trade.size6,
          side: trade.side,
          sourceTsMs: input.sourceTsMs!,
          receivedTsMs: input.receivedTsMs,
        });
      }
    } else {
      const existing = await tx.select().from(orderbookEvents).where(and(
        eq(orderbookEvents.connectionEpoch, input.connectionEpoch),
        eq(orderbookEvents.envelopeId, input.envelopeId),
        eq(orderbookEvents.sequenceInEnvelope, input.sequenceInEnvelope),
      )).limit(1);
      if (existing[0] === undefined) throw new Error("market-data idempotency conflict could not be resolved");
      row = normalizeRow(existing[0]);
      if (!eventMatches(row, input, validated.payloadHash)) {
        throw new Error("market-data envelope position already contains different evidence");
      }
    }
    return row;
  }

  async reconstructBook(input: {
    readonly marketId: string;
    readonly tokenId: string;
    readonly throughEventId?: bigint;
    readonly useCheckpoint?: boolean;
  }): Promise<ReconstructionResult> {
    assertNonEmpty(input.marketId, "marketId");
    assertNonEmpty(input.tokenId, "tokenId");
    const through = input.throughEventId;
    let state: ReplayState = { book: null, requiredConnectionEpoch: null };
    let checkpointId: bigint | null = null;
    let afterId = 0n;

    if (input.useCheckpoint !== false) {
      const checkpointWhere = and(
        eq(orderbookSnapshots.marketId, input.marketId),
        eq(orderbookSnapshots.tokenId, input.tokenId),
        isNotNull(orderbookSnapshots.lastEventId),
        isNotNull(orderbookSnapshots.connectionEpoch),
        isNotNull(orderbookSnapshots.bookVersion),
        isNotNull(orderbookSnapshots.sourceTimestampKind),
        isNotNull(orderbookSnapshots.hash),
        through === undefined ? undefined : lte(orderbookSnapshots.lastEventId, through),
      );
      const checkpoints = await this.db.select().from(orderbookSnapshots)
        .where(checkpointWhere)
        .orderBy(desc(orderbookSnapshots.lastEventId), desc(orderbookSnapshots.id))
        .limit(1);
      const checkpoint = checkpoints[0];
      if (checkpoint !== undefined && checkpoint.lastEventId !== null && checkpoint.connectionEpoch !== null
        && checkpoint.bookVersion !== null && checkpoint.sourceTimestampKind !== null && checkpoint.hash !== null) {
        const integrity = await this.inferCheckpointIntegrity(input.marketId, input.tokenId, checkpoint.lastEventId);
        const book = mutableFromCheckpoint(checkpoint, integrity);
        const actual = canonicalCheckpointHash(freezeBook(book));
        if (actual !== checkpoint.hash) throw new Error(`checkpoint ${checkpoint.id} hash mismatch`);
        state = { book, requiredConnectionEpoch: book.connectionEpoch };
        checkpointId = checkpoint.id;
        afterId = checkpoint.lastEventId;
      }
    }

    const where = and(
      eq(orderbookEvents.marketId, input.marketId),
      or(eq(orderbookEvents.tokenId, input.tokenId), isNull(orderbookEvents.tokenId)),
      gt(orderbookEvents.id, afterId),
      through === undefined ? undefined : lte(orderbookEvents.id, through),
    );
    const rows = await this.db.select().from(orderbookEvents).where(where).orderBy(
      asc(orderbookEvents.receivedTsMs), asc(orderbookEvents.id), asc(orderbookEvents.sequenceInEnvelope),
    );
    const applied: bigint[] = [];
    for (const raw of rows) {
      const event = normalizeRow(raw);
      if (marketDataPayloadHash(event.payload) !== event.payloadHash) throw new Error(`event ${event.id} payload hash mismatch`);
      state = applyEvent(state, event, input.tokenId);
      applied.push(event.id);
    }
    return Object.freeze({
      book: state.book === null ? null : freezeBook(state.book),
      checkpointId,
      appliedEventIds: Object.freeze(applied),
    });
  }

  private async inferCheckpointIntegrity(
    marketId: string,
    tokenId: string,
    throughEventId: bigint,
  ): Promise<CanonicalBookIntegrity> {
    const events = await this.db.select({
      eventKind: orderbookEvents.eventKind,
    }).from(orderbookEvents).where(and(
      eq(orderbookEvents.marketId, marketId),
      or(eq(orderbookEvents.tokenId, tokenId), isNull(orderbookEvents.tokenId)),
      inArray(orderbookEvents.eventKind, ["SNAPSHOT", "DELTA", "CONNECTION_RESET"]),
      lte(orderbookEvents.id, throughEventId),
    )).orderBy(desc(orderbookEvents.receivedTsMs), desc(orderbookEvents.id), desc(orderbookEvents.sequenceInEnvelope));
    let sawDelta = false;
    for (const event of events) {
      if (event.eventKind === "DELTA") sawDelta = true;
      else if (event.eventKind === "CONNECTION_RESET") return "INVALID_AFTER_RECONNECT";
      else if (event.eventKind === "SNAPSHOT") return sawDelta ? "UNSEQUENCED_AFTER_SNAPSHOT" : "VERIFIED_SNAPSHOT";
    }
    throw new Error("checkpoint has no preceding snapshot evidence");
  }

  /** Materialize and persist a verified checkpoint at an envelope boundary. */
  async createCheckpoint(input: {
    readonly marketId: string;
    readonly tokenId: string;
    readonly throughEventId: bigint;
  }): Promise<{ readonly id: bigint; readonly hash: string; readonly book: CanonicalPersistedBook }> {
    const boundaryRows = await this.db.select().from(orderbookEvents).where(and(
      eq(orderbookEvents.id, input.throughEventId),
      eq(orderbookEvents.marketId, input.marketId),
      eq(orderbookEvents.eventKind, "ENVELOPE_BOUNDARY"),
    )).limit(1);
    if (boundaryRows[0] === undefined) throw new Error("checkpoint cutoff must be an ENVELOPE_BOUNDARY for the market");
    const reconstructed = await this.reconstructBook({ ...input, useCheckpoint: true });
    if (reconstructed.book === null) throw new Error("cannot checkpoint before a token snapshot exists");
    const book = reconstructed.book;
    if (book.integrity === "INVALID_AFTER_RECONNECT") throw new Error("cannot checkpoint an invalid post-reset book");
    if (book.sourceTsMs === null) throw new Error("cannot checkpoint a book without a venue source timestamp");
    const hash = canonicalCheckpointHash(book);
    const [row] = await this.db.insert(orderbookSnapshots).values({
      marketId: book.marketId,
      tokenId: book.tokenId,
      bids: book.bids.map((level) => [level.price6, level.size6]),
      asks: book.asks.map((level) => [level.price6, level.size6]),
      hash,
      sourceTsMs: book.sourceTsMs,
      receivedTsMs: book.receivedTsMs,
      connectionEpoch: book.connectionEpoch,
      bookVersion: book.bookVersion,
      lastEventId: book.lastEventId,
      sourceTimestampKind: book.sourceTimestampKind,
    }).returning();
    return Object.freeze({ id: row!.id, hash, book });
  }
}

interface MutableBook {
  marketId: string;
  tokenId: string;
  connectionEpoch: string;
  bookVersion: bigint;
  bids: Map<string, string>;
  asks: Map<string, string>;
  sourceTsMs: number | null;
  receivedTsMs: number;
  sourceTimestampKind: SourceTimestampKind;
  integrity: CanonicalBookIntegrity;
  lastEventId: bigint;
}

interface ReplayState {
  book: MutableBook | null;
  /** The latest reset epoch, retained even when no token snapshot exists yet. */
  requiredConnectionEpoch: string | null;
}

function applyEvent(state: ReplayState, event: PersistedMarketDataEvent, tokenId: string): ReplayState {
  let { book, requiredConnectionEpoch } = state;
  if (event.eventKind === "CONNECTION_RESET") {
    requiredConnectionEpoch = event.connectionEpoch;
    if (book !== null) {
      book.connectionEpoch = event.connectionEpoch;
      book.integrity = "INVALID_AFTER_RECONNECT";
      book.bookVersion += 1n;
      book.receivedTsMs = event.receivedTsMs;
      book.lastEventId = event.id;
    }
    return { book, requiredConnectionEpoch };
  }
  if (event.eventKind === "ENVELOPE_BOUNDARY") {
    if (book !== null && requiredConnectionEpoch === event.connectionEpoch) book.lastEventId = event.id;
    return { book, requiredConnectionEpoch };
  }
  if (event.tokenId !== tokenId) return state;
  if (event.eventKind === "SNAPSHOT") {
    const bids = snapshotLevels(event.payload, "bids");
    const asks = snapshotLevels(event.payload, "asks");
    const version = payloadRecord(event.payload).bookVersion;
    const epochIsCurrent = requiredConnectionEpoch === null || requiredConnectionEpoch === event.connectionEpoch;
    if (requiredConnectionEpoch === null) requiredConnectionEpoch = event.connectionEpoch;
    book = {
      marketId: event.marketId,
      tokenId,
      connectionEpoch: requiredConnectionEpoch,
      bookVersion: version === undefined ? (book?.bookVersion ?? 0n) + 1n : BigInt(asDecimal(version, "payload.bookVersion", true)),
      bids: new Map(bids.map((level) => [level.price6, level.size6])),
      asks: new Map(asks.map((level) => [level.price6, level.size6])),
      sourceTsMs: event.sourceTsMs,
      receivedTsMs: event.receivedTsMs,
      sourceTimestampKind: event.sourceTimestampKind,
      integrity: epochIsCurrent ? "VERIFIED_SNAPSHOT" : "INVALID_AFTER_RECONNECT",
      lastEventId: event.id,
    };
    return { book, requiredConnectionEpoch };
  }
  if (book === null) return state;
  if (event.eventKind === "DELTA") {
    if (requiredConnectionEpoch !== null && event.connectionEpoch !== requiredConnectionEpoch) {
      book.integrity = "INVALID_AFTER_RECONNECT";
      book.bookVersion += 1n;
      return { book, requiredConnectionEpoch };
    }
    for (const change of deltaChanges(event.payload)) {
      const side = change.side === "BUY" ? book.bids : book.asks;
      if (change.size6 === "0") side.delete(change.price6);
      else side.set(change.price6, change.size6);
    }
    const version = payloadRecord(event.payload).bookVersion;
    book.bookVersion = version === undefined ? book.bookVersion + 1n : BigInt(asDecimal(version, "payload.bookVersion", true));
    if (book.integrity === "VERIFIED_SNAPSHOT") book.integrity = "UNSEQUENCED_AFTER_SNAPSHOT";
    book.connectionEpoch = event.connectionEpoch;
    if (event.sourceTsMs !== null) {
      book.sourceTsMs = event.sourceTsMs;
      book.sourceTimestampKind = event.sourceTimestampKind;
    }
    book.receivedTsMs = event.receivedTsMs;
    book.lastEventId = event.id;
  }
  return { book, requiredConnectionEpoch };
}

function levelsFromMap(map: Map<string, string>, side: "bids" | "asks"): readonly PersistedBookLevel[] {
  return Object.freeze([...map.entries()].map(([price6, size6]) => Object.freeze({ price6, size6 })).sort((a, b) => {
    const left = BigInt(a.price6);
    const right = BigInt(b.price6);
    return side === "bids" ? (left > right ? -1 : left < right ? 1 : 0) : (left < right ? -1 : left > right ? 1 : 0);
  }));
}

function freezeBook(book: MutableBook): CanonicalPersistedBook {
  return Object.freeze({
    marketId: book.marketId,
    tokenId: book.tokenId,
    connectionEpoch: book.connectionEpoch,
    bookVersion: book.bookVersion,
    bids: levelsFromMap(book.bids, "bids"),
    asks: levelsFromMap(book.asks, "asks"),
    sourceTsMs: book.sourceTsMs,
    receivedTsMs: book.receivedTsMs,
    sourceTimestampKind: book.sourceTimestampKind,
    integrity: book.integrity,
    lastEventId: book.lastEventId,
  });
}

export function canonicalCheckpointHash(book: CanonicalPersistedBook): string {
  return marketDataPayloadHash({
    asks: book.asks,
    bids: book.bids,
    bookVersion: book.bookVersion,
    connectionEpoch: book.connectionEpoch,
    integrity: book.integrity,
    lastEventId: book.lastEventId,
    marketId: book.marketId,
    receivedTsMs: book.receivedTsMs,
    sourceTimestampKind: book.sourceTimestampKind,
    sourceTsMs: book.sourceTsMs,
    tokenId: book.tokenId,
  });
}

function mutableFromCheckpoint(
  row: typeof orderbookSnapshots.$inferSelect,
  integrity: CanonicalBookIntegrity,
): MutableBook {
  const bids = (row.bids as unknown[]).map((level, i) => parseLevel(level, `checkpoint.bids[${i}]`, false));
  const asks = (row.asks as unknown[]).map((level, i) => parseLevel(level, `checkpoint.asks[${i}]`, false));
  return {
    marketId: row.marketId,
    tokenId: row.tokenId,
    connectionEpoch: row.connectionEpoch!,
    bookVersion: row.bookVersion!,
    bids: new Map(bids.map((level) => [level.price6, level.size6])),
    asks: new Map(asks.map((level) => [level.price6, level.size6])),
    sourceTsMs: row.sourceTsMs,
    receivedTsMs: row.receivedTsMs,
    sourceTimestampKind: row.sourceTimestampKind as SourceTimestampKind,
    integrity,
    lastEventId: row.lastEventId!,
  };
}
