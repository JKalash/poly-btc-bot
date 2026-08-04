/** Bounded, fail-closed market-data capture queue (spec §12.6). */

export type PairMarketDataRecordKind = "SNAPSHOT" | "DELTA" | "TRADE" | "CONNECTION_RESET" | "ENVELOPE_BOUNDARY";

export interface PairMarketDataRecord {
  readonly kind: PairMarketDataRecordKind;
  readonly marketId: string;
  readonly tokenId: string | null;
  readonly connectionEpoch: string;
  readonly envelopeId: string;
  readonly sequenceInEnvelope: number;
  readonly sourceEventId?: string | null;
  readonly sourceTsMs: number | null;
  readonly receivedTsMs: number;
  readonly exchangeHash?: string | null;
  readonly createdAtMs: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PairCaptureQueueMetrics {
  readonly depth: number;
  readonly maxDepth: number;
  readonly enqueued: number;
  readonly flushed: number;
  readonly flushes: number;
  readonly overflows: number;
  readonly rejectedWhileUnhealthy: number;
  readonly lastFlushLatencyMs: number | null;
  readonly unhealthyMarketCount: number;
}

export interface PairCaptureQueueOptions {
  readonly capacity: number;
  readonly batchSize: number;
  readonly persistBatch: (batch: readonly PairMarketDataRecord[]) => Promise<void>;
  readonly onContinuityLost: (marketId: string, code: "PAIR_CAPTURE_QUEUE_OVERFLOW") => void;
  readonly nowMs?: () => number;
}

interface RegisteredMarket { readonly upTokenId: string; readonly downTokenId: string }
interface RecoveryState { epoch: string; tokens: Set<string> }
interface QueuedRecord { readonly groupKey: string; readonly record: PairMarketDataRecord }

function immutableCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = immutableCopy(item);
    return Object.freeze(out) as T;
  }
  return value;
}

export class PairCaptureQueue {
  private readonly queue: QueuedRecord[] = [];
  private readonly markets = new Map<string, RegisteredMarket>();
  private readonly unhealthy = new Set<string>();
  private readonly recovery = new Map<string, RecoveryState>();
  private maxDepth = 0;
  private enqueued = 0;
  private flushed = 0;
  private flushes = 0;
  private overflows = 0;
  private rejectedWhileUnhealthy = 0;
  private lastFlushLatencyMs: number | null = null;
  private readonly nowMs: () => number;

  constructor(private readonly options: PairCaptureQueueOptions) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity <= 0) throw new RangeError("capture queue capacity must be a positive integer");
    if (!Number.isSafeInteger(options.batchSize) || options.batchSize <= 0 || options.batchSize > options.capacity) throw new RangeError("capture queue batch size must be in [1, capacity]");
    this.nowMs = options.nowMs ?? Date.now;
  }

  registerMarket(marketId: string, upTokenId: string, downTokenId: string): void {
    this.markets.set(marketId, Object.freeze({ upTokenId, downTokenId }));
  }

  unregisterMarket(marketId: string): void {
    this.markets.delete(marketId);
    this.recovery.delete(marketId);
    this.unhealthy.delete(marketId);
  }

  /**
   * Enqueue a deep-frozen record. On pressure the record is explicitly
   * rejected, continuity is invalidated, and evaluation must remain stopped.
   */
  enqueue(record: PairMarketDataRecord): "ENQUEUED" | "OVERFLOW" | "CONTINUITY_UNHEALTHY" {
    return this.enqueueGroup([record], `single:${record.envelopeId}:${record.sequenceInEnvelope}`);
  }

  /** Enqueue one normalized source envelope atomically; it is never split across flush batches. */
  enqueueEnvelope(records: readonly PairMarketDataRecord[]): "ENQUEUED" | "OVERFLOW" | "CONTINUITY_UNHEALTHY" {
    if (records.length === 0) throw new TypeError("capture envelope must not be empty");
    const first = records[0]!;
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      if (record.marketId !== first.marketId || record.connectionEpoch !== first.connectionEpoch || record.envelopeId !== first.envelopeId || record.sequenceInEnvelope !== i) {
        throw new TypeError("capture envelope records must share identity/epoch and use contiguous sequence numbers");
      }
    }
    if (records[records.length - 1]!.kind !== "ENVELOPE_BOUNDARY") throw new TypeError("capture envelope must end with ENVELOPE_BOUNDARY");
    return this.enqueueGroup(records, `envelope:${first.connectionEpoch}:${first.envelopeId}`);
  }

  private enqueueGroup(records: readonly PairMarketDataRecord[], groupKey: string): "ENQUEUED" | "OVERFLOW" | "CONTINUITY_UNHEALTHY" {
    const record = records[0]!;
    const isRecoverySnapshot = record.kind === "SNAPSHOT";
    if (this.unhealthy.has(record.marketId) && !isRecoverySnapshot) {
      this.rejectedWhileUnhealthy++;
      return "CONTINUITY_UNHEALTHY";
    }
    if (this.queue.length + records.length > this.options.capacity) {
      this.overflows++;
      this.unhealthy.add(record.marketId);
      this.recovery.delete(record.marketId);
      this.options.onContinuityLost(record.marketId, "PAIR_CAPTURE_QUEUE_OVERFLOW");
      return "OVERFLOW";
    }
    for (const item of records) this.queue.push(Object.freeze({ groupKey, record: immutableCopy(item) }));
    this.enqueued += records.length;
    this.maxDepth = Math.max(this.maxDepth, this.queue.length);
    return "ENQUEUED";
  }

  /** Persist at most one batch. Failed writes leave the exact batch queued. */
  async flushOneBatch(): Promise<number> {
    if (this.queue.length === 0) return 0;
    let end = 0;
    while (end < this.queue.length) {
      const group = this.queue[end]!.groupKey;
      let groupEnd = end + 1;
      while (groupEnd < this.queue.length && this.queue[groupEnd]!.groupKey === group) groupEnd++;
      if (end > 0 && groupEnd > this.options.batchSize) break;
      end = groupEnd;
      if (end >= this.options.batchSize) break;
    }
    const queuedBatch = this.queue.slice(0, end);
    const batch = Object.freeze(queuedBatch.map((item) => item.record));
    const started = this.nowMs();
    await this.options.persistBatch(batch);
    this.queue.splice(0, queuedBatch.length);
    this.flushed += batch.length;
    this.flushes++;
    this.lastFlushLatencyMs = Math.max(0, this.nowMs() - started);
    for (const record of batch) if (record.kind === "SNAPSHOT") this.notePersistedSnapshot(record);
    return batch.length;
  }

  async flushAll(): Promise<number> {
    let total = 0;
    while (this.queue.length > 0) total += await this.flushOneBatch();
    return total;
  }

  isContinuityHealthy(marketId: string): boolean { return !this.unhealthy.has(marketId); }

  metrics(): PairCaptureQueueMetrics {
    return Object.freeze({
      depth: this.queue.length, maxDepth: this.maxDepth, enqueued: this.enqueued,
      flushed: this.flushed, flushes: this.flushes, overflows: this.overflows,
      rejectedWhileUnhealthy: this.rejectedWhileUnhealthy,
      lastFlushLatencyMs: this.lastFlushLatencyMs, unhealthyMarketCount: this.unhealthy.size,
    });
  }

  private notePersistedSnapshot(record: PairMarketDataRecord): void {
    if (!this.unhealthy.has(record.marketId) || record.tokenId === null || record.connectionEpoch === "") return;
    const registered = this.markets.get(record.marketId);
    if (registered === undefined) return;
    let state = this.recovery.get(record.marketId);
    if (state === undefined || state.epoch !== record.connectionEpoch) {
      state = { epoch: record.connectionEpoch, tokens: new Set<string>() };
      this.recovery.set(record.marketId, state);
    }
    if (record.tokenId === registered.upTokenId || record.tokenId === registered.downTokenId) state.tokens.add(record.tokenId);
    if (state.tokens.has(registered.upTokenId) && state.tokens.has(registered.downTokenId)) {
      this.unhealthy.delete(record.marketId);
      this.recovery.delete(record.marketId);
    }
  }
}
