import {
  canonicalPairDatasetJson,
  pairDatasetObjectHash,
  verifyPairDatasetManifest,
  type PairDatasetManifest,
} from "./pair-dataset-manifest";
import {
  PairReplayClock,
  deterministicPairReplayId,
  type PairReplayTimer,
} from "./pair-replay-clock";

export type PairReplayEventKind = "SNAPSHOT" | "DELTA" | "TRADE" | "CONNECTION_RESET" | "ENVELOPE_BOUNDARY";
export type PairReplayBookIntegrity = "VERIFIED_SNAPSHOT" | "UNSEQUENCED_AFTER_SNAPSHOT" | "INVALID_AFTER_RECONNECT" | "GAP_SUSPECTED";

export interface PairReplayMarketEvent {
  readonly id: bigint;
  readonly marketId: string;
  readonly tokenId: string | null;
  readonly eventKind: PairReplayEventKind;
  readonly connectionEpoch: string;
  readonly envelopeId: string;
  readonly sequenceInEnvelope: number;
  readonly sourceTsMs: number | null;
  readonly receivedTsMs: number;
  readonly payloadHash: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PairReplayCheckpoint {
  readonly checkpointId: bigint;
  readonly marketId: string;
  readonly tokenId: string;
  readonly lastEventId: bigint;
  readonly connectionEpoch: string;
  readonly bookVersion: bigint;
  readonly sourceTsMs: number | null;
  readonly receivedTsMs: number;
  readonly integrity: PairReplayBookIntegrity;
  readonly bids: readonly PairReplayBookLevel[];
  readonly asks: readonly PairReplayBookLevel[];
  readonly checkpointHash: string;
}

export interface PairReplayBookLevel { readonly price6: bigint; readonly shares6: bigint }

export interface PairReplayBookView {
  readonly marketId: string;
  readonly tokenId: string;
  readonly connectionEpoch: string;
  readonly requiredConnectionEpoch: string | null;
  readonly bookVersion: bigint;
  readonly sourceTsMs: number | null;
  readonly receivedTsMs: number;
  readonly integrity: PairReplayBookIntegrity;
  readonly bids: readonly PairReplayBookLevel[];
  readonly asks: readonly PairReplayBookLevel[];
}

export interface PairReplayBoundaryRecord {
  readonly kind: "BOUNDARY";
  readonly replayEventId: string;
  readonly triggerId: string;
  readonly captureId: string;
  readonly marketId: string;
  readonly connectionEpoch: string;
  readonly envelopeId: string;
  readonly boundaryEventId: bigint;
  readonly receivedTsMs: number;
  readonly barriers: readonly string[];
  readonly books: readonly PairReplayBookView[];
}

export type PairReplayOutputRecord = PairReplayBoundaryRecord | {
  readonly kind: "TIMER";
  readonly replayEventId: string;
  readonly firedAtMs: number;
  readonly timer: PairReplayTimer;
};

export interface PairMarketReplayResult {
  readonly datasetHash: string;
  readonly clockModelVersion: "pair_replay_clock_v1";
  readonly tieRuleVersion: "pair_replay_tie_v1";
  readonly records: readonly PairReplayOutputRecord[];
  readonly finalBooks: readonly PairReplayBookView[];
  readonly canonicalOutput: string;
  readonly outputHash: string;
}

export interface PairMarketReplayOptions {
  readonly initialTimers?: readonly PairReplayTimer[];
  readonly onBoundary?: (record: PairReplayBoundaryRecord, clock: PairReplayClock) => void;
}

export class PairMarketReplayError extends Error {}

interface MutableBook {
  marketId: string;
  tokenId: string;
  connectionEpoch: string;
  requiredConnectionEpoch: string | null;
  bookVersion: bigint;
  sourceTsMs: number | null;
  receivedTsMs: number;
  integrity: PairReplayBookIntegrity;
  bids: Map<bigint, bigint>;
  asks: Map<bigint, bigint>;
}

const DECIMAL = /^(?:0|[1-9]\d*)$/;

function object(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PairMarketReplayError(`${at} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) throw new PairMarketReplayError(`${at} must be a non-empty string`);
  return value;
}

function exactBigint(value: unknown, at: string): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new PairMarketReplayError(`${at} must be an exact unsigned decimal string`);
  return BigInt(value);
}

function safeInteger(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new PairMarketReplayError(`${at} must be a non-negative safe integer`);
  return value;
}

function nullableTime(value: unknown, at: string): number | null {
  return value === null ? null : safeInteger(value, at);
}

function parseLevel(value: unknown, at: string): PairReplayBookLevel {
  const row = object(value, at);
  const sharesValue = row.shares6 ?? row.size6;
  const level = { price6: exactBigint(row.price6, `${at}.price6`), shares6: exactBigint(sharesValue, `${at}.shares6`) };
  if (level.price6 <= 0n || level.shares6 < 0n) throw new PairMarketReplayError(`${at} has invalid price/size`);
  return Object.freeze(level);
}

function parseLevels(value: unknown, at: string): readonly PairReplayBookLevel[] {
  if (!Array.isArray(value)) throw new PairMarketReplayError(`${at} must be an array`);
  const levels = value.map((item, index) => parseLevel(item, `${at}[${index}]`));
  if (new Set(levels.map(({ price6 }) => price6.toString())).size !== levels.length) throw new PairMarketReplayError(`${at} contains duplicate prices`);
  return Object.freeze(levels);
}

function parseJsonDocuments(bytes: Uint8Array, path: string): readonly unknown[] {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  if (source.length === 0) return [];
  try {
    const parsed: unknown = source.startsWith("[") ? JSON.parse(source) : source.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    throw new PairMarketReplayError(`invalid JSON/JSONL artifact: ${path}`, { cause: error });
  }
}

function parseEvent(value: unknown, at: string): PairReplayMarketEvent {
  const row = object(value, at);
  const kind = row.eventKind;
  if (kind !== "SNAPSHOT" && kind !== "DELTA" && kind !== "TRADE" && kind !== "CONNECTION_RESET" && kind !== "ENVELOPE_BOUNDARY") {
    throw new PairMarketReplayError(`${at}.eventKind is unsupported`);
  }
  const payload = object(row.payload, `${at}.payload`);
  const payloadHash = text(row.payloadHash, `${at}.payloadHash`);
  if (pairDatasetObjectHash(payload) !== payloadHash) throw new PairMarketReplayError(`${at}.payloadHash mismatch`);
  const tokenId = row.tokenId === null ? null : text(row.tokenId, `${at}.tokenId`);
  if ((kind === "SNAPSHOT" || kind === "DELTA" || kind === "TRADE") && tokenId === null) throw new PairMarketReplayError(`${at} requires tokenId`);
  return Object.freeze({
    id: exactBigint(row.id, `${at}.id`), marketId: text(row.marketId, `${at}.marketId`), tokenId,
    eventKind: kind, connectionEpoch: text(row.connectionEpoch, `${at}.connectionEpoch`),
    envelopeId: text(row.envelopeId, `${at}.envelopeId`), sequenceInEnvelope: safeInteger(row.sequenceInEnvelope, `${at}.sequenceInEnvelope`),
    sourceTsMs: nullableTime(row.sourceTsMs, `${at}.sourceTsMs`), receivedTsMs: safeInteger(row.receivedTsMs, `${at}.receivedTsMs`),
    payloadHash, payload: Object.freeze({ ...payload }),
  });
}

function checkpointMaterial(checkpoint: Omit<PairReplayCheckpoint, "checkpointHash">): unknown {
  return checkpoint;
}

function parseCheckpoint(value: unknown, at: string): PairReplayCheckpoint {
  const row = object(value, at);
  const withoutHash = Object.freeze({
    checkpointId: exactBigint(row.checkpointId, `${at}.checkpointId`),
    marketId: text(row.marketId, `${at}.marketId`), tokenId: text(row.tokenId, `${at}.tokenId`),
    lastEventId: exactBigint(row.lastEventId, `${at}.lastEventId`),
    connectionEpoch: text(row.connectionEpoch, `${at}.connectionEpoch`),
    bookVersion: exactBigint(row.bookVersion, `${at}.bookVersion`),
    sourceTsMs: nullableTime(row.sourceTsMs, `${at}.sourceTsMs`),
    receivedTsMs: safeInteger(row.receivedTsMs, `${at}.receivedTsMs`),
    integrity: text(row.integrity, `${at}.integrity`) as PairReplayBookIntegrity,
    bids: parseLevels(row.bids, `${at}.bids`), asks: parseLevels(row.asks, `${at}.asks`),
  });
  if (!["VERIFIED_SNAPSHOT", "UNSEQUENCED_AFTER_SNAPSHOT", "INVALID_AFTER_RECONNECT", "GAP_SUSPECTED"].includes(withoutHash.integrity)) {
    throw new PairMarketReplayError(`${at}.integrity is unsupported`);
  }
  const checkpointHash = text(row.checkpointHash, `${at}.checkpointHash`);
  if (pairDatasetObjectHash(checkpointMaterial(withoutHash)) !== checkpointHash) throw new PairMarketReplayError(`${at}.checkpointHash mismatch`);
  return Object.freeze({ ...withoutHash, checkpointHash });
}

function cloneBook(book: MutableBook): MutableBook {
  return { ...book, bids: new Map(book.bids), asks: new Map(book.asks) };
}

function view(book: MutableBook): PairReplayBookView {
  const side = (levels: Map<bigint, bigint>, descending: boolean) => Object.freeze([...levels.entries()]
    .filter(([, size]) => size > 0n)
    .sort(([a], [b]) => a === b ? 0 : descending ? (a > b ? -1 : 1) : (a < b ? -1 : 1))
    .map(([price6, shares6]) => Object.freeze({ price6, shares6 })));
  return Object.freeze({
    marketId: book.marketId, tokenId: book.tokenId, connectionEpoch: book.connectionEpoch,
    requiredConnectionEpoch: book.requiredConnectionEpoch, bookVersion: book.bookVersion,
    sourceTsMs: book.sourceTsMs, receivedTsMs: book.receivedTsMs, integrity: book.integrity,
    bids: side(book.bids, true), asks: side(book.asks, false),
  });
}

function payloadBookVersion(payload: Readonly<Record<string, unknown>>, at: string): bigint {
  return exactBigint(payload.bookVersion, `${at}.bookVersion`);
}

function envelopeKey(event: PairReplayMarketEvent): string {
  return `${event.marketId}\u0000${event.connectionEpoch}\u0000${event.envelopeId}`;
}

function eventCompare(a: PairReplayMarketEvent, b: PairReplayMarketEvent): number {
  return a.receivedTsMs - b.receivedTsMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || a.sequenceInEnvelope - b.sequenceInEnvelope;
}

function timerRecord(datasetHash: string, timer: PairReplayTimer, firedAtMs: number): PairReplayOutputRecord {
  return Object.freeze({
    kind: "TIMER",
    replayEventId: deterministicPairReplayId({ namespace: "event", datasetHash, parts: ["timer", timer.timerId, firedAtMs] }),
    firedAtMs,
    timer,
  });
}

export async function loadPairReplayDataset(root: string, manifest: PairDatasetManifest): Promise<{
  readonly events: readonly PairReplayMarketEvent[];
  readonly checkpoints: readonly PairReplayCheckpoint[];
}> {
  const contents = await verifyPairDatasetManifest(root, manifest);
  const events: PairReplayMarketEvent[] = [];
  const checkpoints: PairReplayCheckpoint[] = [];
  for (const entry of manifest.artifacts) {
    const bytes = contents.get(entry.path)!;
    if (entry.role === "MARKET_EVENTS") {
      parseJsonDocuments(bytes, entry.path).forEach((item, index) => events.push(parseEvent(item, `${entry.path}[${index}]`)));
    } else if (entry.role === "BOOK_CHECKPOINTS") {
      parseJsonDocuments(bytes, entry.path).forEach((item, index) => checkpoints.push(parseCheckpoint(item, `${entry.path}[${index}]`)));
    }
  }
  events.sort(eventCompare);
  const eventIds = new Set<string>();
  for (const event of events) {
    const id = event.id.toString(10);
    if (eventIds.has(id)) throw new PairMarketReplayError(`duplicate market event id: ${id}`);
    eventIds.add(id);
  }
  checkpoints.sort((a, b) => a.marketId.localeCompare(b.marketId)
    || a.tokenId.localeCompare(b.tokenId)
    || (a.lastEventId === b.lastEventId ? 0 : a.lastEventId < b.lastEventId ? -1 : 1));
  return Object.freeze({ events: Object.freeze(events), checkpoints: Object.freeze(checkpoints) });
}

export function replayPairMarketDataset(input: {
  readonly manifest: PairDatasetManifest;
  readonly events: readonly PairReplayMarketEvent[];
  readonly checkpoints: readonly PairReplayCheckpoint[];
  readonly options?: PairMarketReplayOptions;
}): PairMarketReplayResult {
  const events = [...input.events].sort(eventCompare);
  const books = new Map<string, MutableBook>();
  const checkpointCutoff = new Map<string, bigint>();
  const checkpointByMarket = new Map<string, bigint>();
  const checkpointTokens = new Set<string>();
  const requiredEpochByMarket = new Map<string, string>();
  for (const checkpoint of input.checkpoints) {
    const marketCutoff = checkpointByMarket.get(checkpoint.marketId);
    if (marketCutoff !== undefined && marketCutoff !== checkpoint.lastEventId) {
      throw new PairMarketReplayError(`market checkpoints do not share one causal boundary: ${checkpoint.marketId}`);
    }
    const checkpointTokenKey = `${checkpoint.marketId}\u0000${checkpoint.tokenId}`;
    if (checkpointTokens.has(checkpointTokenKey)) throw new PairMarketReplayError(`duplicate checkpoint token: ${checkpoint.marketId}/${checkpoint.tokenId}`);
    checkpointTokens.add(checkpointTokenKey);
    checkpointByMarket.set(checkpoint.marketId, checkpoint.lastEventId);
    checkpointCutoff.set(checkpoint.marketId, checkpoint.lastEventId);
    if (checkpoint.integrity === "INVALID_AFTER_RECONNECT" || checkpoint.integrity === "GAP_SUSPECTED") {
      requiredEpochByMarket.set(checkpoint.marketId, checkpoint.connectionEpoch);
    }
    books.set(checkpoint.tokenId, {
      marketId: checkpoint.marketId, tokenId: checkpoint.tokenId, connectionEpoch: checkpoint.connectionEpoch,
      requiredConnectionEpoch: checkpoint.integrity === "INVALID_AFTER_RECONNECT" || checkpoint.integrity === "GAP_SUSPECTED"
        ? checkpoint.connectionEpoch
        : null,
      bookVersion: checkpoint.bookVersion, sourceTsMs: checkpoint.sourceTsMs, receivedTsMs: checkpoint.receivedTsMs,
      integrity: checkpoint.integrity,
      bids: new Map(checkpoint.bids.map(({ price6, shares6 }) => [price6, shares6])),
      asks: new Map(checkpoint.asks.map(({ price6, shares6 }) => [price6, shares6])),
    });
  }
  const filtered = events.filter((event) => event.id > (checkpointCutoff.get(event.marketId) ?? -1n));
  const grouped = new Map<string, PairReplayMarketEvent[]>();
  for (const event of filtered) {
    const group = grouped.get(envelopeKey(event)) ?? [];
    group.push(event);
    grouped.set(envelopeKey(event), group);
  }
  const envelopes = [...grouped.values()].map((rows) => rows.sort((a, b) => a.sequenceInEnvelope - b.sequenceInEnvelope));
  for (const rows of envelopes) {
    const first = rows[0]!;
    if (rows.some((event, index) => event.sequenceInEnvelope !== index || event.marketId !== first.marketId || event.receivedTsMs !== first.receivedTsMs)) {
      throw new PairMarketReplayError(`envelope has a causal sequence/time/market gap: ${first.envelopeId}`);
    }
    const boundaryIndexes = rows.flatMap((event, index) => event.eventKind === "ENVELOPE_BOUNDARY" ? [index] : []);
    if (boundaryIndexes.length !== 1 || boundaryIndexes[0] !== rows.length - 1) {
      throw new PairMarketReplayError(`envelope must contain exactly one terminal boundary: ${first.envelopeId}`);
    }
  }
  envelopes.sort((a, b) => eventCompare(a[0]!, b[0]!) || a[0]!.envelopeId.localeCompare(b[0]!.envelopeId));
  const startMs = Math.min(...[...envelopes.map((rows) => rows[0]!.receivedTsMs), ...input.options?.initialTimers?.map((timer) => timer.scheduledDueMs) ?? []]);
  const clock = new PairReplayClock(Number.isFinite(startMs) ? startMs : 0);
  for (const timer of input.options?.initialTimers ?? []) clock.schedule(timer);
  const records: PairReplayOutputRecord[] = [];
  let envelopeIndex = 0;
  while (envelopeIndex < envelopes.length) {
    const receivedTsMs = envelopes[envelopeIndex]![0]!.receivedTsMs;
    for (const timer of clock.advanceBefore(receivedTsMs)) records.push(timerRecord(input.manifest.datasetHash, timer, timer.scheduledDueMs));
    const sameTime: PairReplayMarketEvent[][] = [];
    while (envelopeIndex < envelopes.length && envelopes[envelopeIndex]![0]!.receivedTsMs === receivedTsMs) sameTime.push(envelopes[envelopeIndex++]!);
    sameTime.sort((a, b) => a[0]!.envelopeId.localeCompare(b[0]!.envelopeId) || eventCompare(a[0]!, b[0]!));
    for (const rows of sameTime) {
      const first = rows[0]!;
      const draft = new Map<string, MutableBook>();
      for (const [tokenId, book] of books) draft.set(tokenId, cloneBook(book));
      const barriers: string[] = [];
      for (const event of rows.slice(0, -1)) {
        if (event.eventKind === "CONNECTION_RESET") {
          requiredEpochByMarket.set(event.marketId, event.connectionEpoch);
          for (const book of draft.values()) if (book.marketId === event.marketId) {
            book.requiredConnectionEpoch = event.connectionEpoch;
            book.connectionEpoch = event.connectionEpoch;
            book.integrity = "INVALID_AFTER_RECONNECT";
            book.receivedTsMs = event.receivedTsMs;
          }
          barriers.push(`RECONNECT:${event.connectionEpoch}`);
          continue;
        }
        if (event.eventKind === "TRADE") continue;
        const tokenId = event.tokenId!;
        if (event.eventKind === "SNAPSHOT") {
          const bookRequired = draft.get(tokenId)?.requiredConnectionEpoch ?? null;
          const marketRequired = requiredEpochByMarket.get(event.marketId) ?? null;
          if ((bookRequired !== null && bookRequired !== event.connectionEpoch)
            || (marketRequired !== null && marketRequired !== event.connectionEpoch)) {
            barriers.push(`STALE_SNAPSHOT:${tokenId}:${event.connectionEpoch}`);
            continue;
          }
          const bids = parseLevels(event.payload.bids, `${event.envelopeId}.bids`);
          const asks = parseLevels(event.payload.asks, `${event.envelopeId}.asks`);
          draft.set(tokenId, {
            marketId: event.marketId, tokenId, connectionEpoch: event.connectionEpoch, requiredConnectionEpoch: null,
            bookVersion: payloadBookVersion(event.payload, event.envelopeId), sourceTsMs: event.sourceTsMs,
            receivedTsMs: event.receivedTsMs, integrity: "VERIFIED_SNAPSHOT",
            bids: new Map(bids.map(({ price6, shares6 }) => [price6, shares6])),
            asks: new Map(asks.map(({ price6, shares6 }) => [price6, shares6])),
          });
          continue;
        }
        const book = draft.get(tokenId);
        const marketRequired = requiredEpochByMarket.get(event.marketId) ?? null;
        if (book === undefined || book.requiredConnectionEpoch !== null || book.connectionEpoch !== event.connectionEpoch
          || (marketRequired !== null && marketRequired !== event.connectionEpoch)) {
          barriers.push(`DELTA_BLOCKED:${tokenId}:${event.connectionEpoch}`);
          continue;
        }
        const nextVersion = payloadBookVersion(event.payload, event.envelopeId);
        if (nextVersion !== book.bookVersion + 1n) {
          book.integrity = "GAP_SUSPECTED";
          book.requiredConnectionEpoch = event.connectionEpoch;
          barriers.push(`BOOK_VERSION_GAP:${tokenId}:${book.bookVersion}->${nextVersion}`);
          continue;
        }
        if (!Array.isArray(event.payload.changes) || event.payload.changes.length === 0) throw new PairMarketReplayError(`${event.envelopeId}.changes must be non-empty`);
        for (const [index, changeValue] of event.payload.changes.entries()) {
          const change = object(changeValue, `${event.envelopeId}.changes[${index}]`);
          const side = change.side;
          if (side !== "BUY" && side !== "SELL") throw new PairMarketReplayError(`${event.envelopeId}.changes[${index}].side invalid`);
          const level = parseLevel(change, `${event.envelopeId}.changes[${index}]`);
          const target = side === "BUY" ? book.bids : book.asks;
          if (level.shares6 === 0n) target.delete(level.price6); else target.set(level.price6, level.shares6);
        }
        book.bookVersion = nextVersion;
        book.sourceTsMs = event.sourceTsMs;
        book.receivedTsMs = event.receivedTsMs;
        book.integrity = "UNSEQUENCED_AFTER_SNAPSHOT";
      }
      books.clear();
      for (const [tokenId, book] of draft) books.set(tokenId, book);
      const boundary = rows[rows.length - 1]!;
      const parts = [first.marketId, first.connectionEpoch, first.envelopeId, boundary.id] as const;
      const record: PairReplayBoundaryRecord = Object.freeze({
        kind: "BOUNDARY",
        replayEventId: deterministicPairReplayId({ namespace: "event", datasetHash: input.manifest.datasetHash, parts }),
        triggerId: deterministicPairReplayId({ namespace: "trigger", datasetHash: input.manifest.datasetHash, parts }),
        captureId: deterministicPairReplayId({ namespace: "capture", datasetHash: input.manifest.datasetHash, parts }),
        marketId: first.marketId, connectionEpoch: first.connectionEpoch, envelopeId: first.envelopeId,
        boundaryEventId: boundary.id, receivedTsMs, barriers: Object.freeze(barriers),
        books: Object.freeze([...books.values()].filter((book) => book.marketId === first.marketId).map(view).sort((a, b) => a.tokenId.localeCompare(b.tokenId))),
      });
      records.push(record);
      input.options?.onBoundary?.(record, clock);
    }
    for (const timer of clock.flushDueAtCurrent()) records.push(timerRecord(input.manifest.datasetHash, timer, clock.nowMs()));
  }
  for (const timer of clock.drain()) records.push(timerRecord(input.manifest.datasetHash, timer, timer.scheduledDueMs));
  const material = Object.freeze({
    datasetHash: input.manifest.datasetHash,
    clockModelVersion: "pair_replay_clock_v1" as const,
    tieRuleVersion: "pair_replay_tie_v1" as const,
    records: Object.freeze(records),
    finalBooks: Object.freeze([...books.values()].map(view).sort((a, b) => a.marketId.localeCompare(b.marketId) || a.tokenId.localeCompare(b.tokenId))),
  });
  const canonicalOutput = canonicalPairDatasetJson(material);
  return Object.freeze({ ...material, canonicalOutput, outputHash: pairDatasetObjectHash(material) });
}
