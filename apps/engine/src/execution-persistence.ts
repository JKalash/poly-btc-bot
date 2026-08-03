import {
  executionTimelineEvents, fillCounterfactuals, fillSelectionCostRecords, latencySamples,
  markoutObservations, orderAttempts, orderbookSnapshots, paperVariantResults, queueEstimates,
  type DbHandle,
} from "@b5p/db";
import type {
  ExecutionTimelineEvent, FillCounterfactual, FillSelectionCostRecord, LatencySample,
  MarkoutObservation, OrderAttempt, PaperVariantResult, QueueEstimate,
} from "@b5p/domain";
import { eq } from "drizzle-orm";
import { EXECUTION_BUFFER_MAX_ROWS } from "./execution-constants";
import { logger } from "./log";

/**
 * Buffered, strictly-async persistence for execution-quality records.
 *
 * The trading hot path only ever pushes plain objects into in-memory arrays
 * (synchronous, allocation-only). Draining to the database happens on a
 * serialized background chain (`requestFlush`) so DB latency can NEVER block
 * or reorder a trading decision. Failures are logged (warn-once per table)
 * and never propagate.
 *
 * Book snapshots: rows reference orderbook_snapshots.id (bigserial), which is
 * only known after insert. The hot path therefore mints a local string token
 * per captured book; the flusher inserts the snapshot, learns the DB id, and
 * rewrites token -> id before dependent rows are written.
 */

export interface CapturedBookSnapshot {
  token: string;
  marketId: string;
  tokenId: string;
  bids: Array<[string, string]>; // [price6, size6] strings, best first
  asks: Array<[string, string]>;
  sourceTsMs: number;
  receivedTsMs: number;
}

/** Timeline event as buffered: book ref still a token, resolved at flush. */
export type BufferedTimelineEvent = Omit<ExecutionTimelineEvent, "bookSnapshotId"> & { bookToken: string | null };
export type BufferedOrderAttempt = Omit<OrderAttempt,
  "decisionBookSnapshotId" | "sendBookSnapshotId" | "ackBookSnapshotId" | "fillBookSnapshotId"> & {
  decisionBookToken: string | null;
  sendBookToken: string | null;
  ackBookToken: string | null;
  fillBookToken: string | null;
};

export class ExecutionPersistence {
  private snapshots: CapturedBookSnapshot[] = [];
  private events: BufferedTimelineEvent[] = [];
  private dirtyAttempts = new Map<string, BufferedOrderAttempt>();
  private persistedAttemptIds = new Set<string>();
  private latencies: LatencySample[] = [];
  private queues: QueueEstimate[] = [];
  private counterfactuals: FillCounterfactual[] = [];
  private markouts: MarkoutObservation[] = [];
  private variants: PaperVariantResult[] = [];
  private selectionCosts: FillSelectionCostRecord[] = [];

  private snapshotIdByToken = new Map<string, bigint>();
  private flushChain: Promise<void> = Promise.resolve();
  private warned = new Set<string>();
  droppedRows = 0;

  constructor(private readonly db: DbHandle) {}

  // ---- hot-path enqueue (synchronous, never throws) ----

  addBookSnapshot(s: CapturedBookSnapshot): void { this.push(this.snapshots, s, "book_snapshots"); }
  addEvent(e: BufferedTimelineEvent): void { this.push(this.events, e, "timeline_events"); }
  upsertAttempt(a: BufferedOrderAttempt): void { this.dirtyAttempts.set(a.id, a); }
  addLatency(l: LatencySample): void { this.push(this.latencies, l, "latency_samples"); }
  addQueueEstimate(q: QueueEstimate): void { this.push(this.queues, q, "queue_estimates"); }
  addCounterfactual(c: FillCounterfactual): void { this.push(this.counterfactuals, c, "fill_counterfactuals"); }
  addMarkout(m: MarkoutObservation): void { this.push(this.markouts, m, "markout_observations"); }
  addVariantResult(v: PaperVariantResult): void { this.push(this.variants, v, "paper_variant_results"); }
  addSelectionCost(r: FillSelectionCostRecord): void { this.push(this.selectionCosts, r, "fill_selection_cost_records"); }

  private push<T>(buf: T[], row: T, kind: string): void {
    if (buf.length >= EXECUTION_BUFFER_MAX_ROWS) {
      buf.shift();
      this.droppedRows++;
      this.warnOnce(`buffer_overflow_${kind}`, `execution ${kind} buffer overflow; oldest rows dropped`);
    }
    buf.push(row);
  }

  /** Fire-and-forget serialized drain. Safe to call from the hot path. */
  requestFlush(): void {
    this.flushChain = this.flushChain.then(() => this.drain()).catch((e) => {
      this.warnOnce("flush", `execution persistence flush failed: ${String(e)}`);
    });
  }

  /** Await full drain (tests / shutdown). */
  async settle(): Promise<void> {
    this.requestFlush();
    await this.flushChain;
  }

  private async drain(): Promise<void> {
    // 1) book snapshots first: everything else references their ids
    const snaps = this.snapshots.splice(0);
    for (const s of snaps) {
      try {
        const rows = await this.db.db.insert(orderbookSnapshots).values({
          marketId: s.marketId,
          tokenId: s.tokenId,
          bids: s.bids,
          asks: s.asks,
          hash: s.token, // client token stored for traceability
          sourceTsMs: s.sourceTsMs,
          receivedTsMs: s.receivedTsMs,
        }).returning();
        const id = rows[0]?.id;
        if (id !== undefined) this.snapshotIdByToken.set(s.token, id);
        this.pruneTokenMap();
      } catch (e) {
        this.warnOnce("orderbook_snapshots", `book snapshot persist failed: ${String(e)}`);
      }
    }
    const ref = (token: string | null): bigint | null =>
      token === null ? null : this.snapshotIdByToken.get(token) ?? null;

    // 2) attempts (FK target of queue_estimates)
    const attempts = [...this.dirtyAttempts.values()];
    this.dirtyAttempts.clear();
    for (const a of attempts) {
      const row = {
        id: a.id,
        intentId: a.intentId,
        correlationId: a.correlationId,
        attemptNumber: a.attemptNumber,
        requestHash: a.requestHash,
        tokenId: a.tokenId,
        side: a.side,
        price6: a.price6,
        size6: a.size6,
        remaining6: a.remaining6,
        timeInForce: a.timeInForce,
        postOnly: a.postOnly,
        status: a.status,
        decisionBookSnapshotId: ref(a.decisionBookToken),
        sendBookSnapshotId: ref(a.sendBookToken),
        ackBookSnapshotId: ref(a.ackBookToken),
        fillBookSnapshotId: ref(a.fillBookToken),
        createdAtMs: a.createdAtMs,
        updatedAtMs: a.updatedAtMs,
        configVersion: a.configVersion,
      };
      try {
        if (this.persistedAttemptIds.has(a.id)) {
          const { id: _id, intentId: _i, correlationId: _c, attemptNumber: _n, createdAtMs: _cr, ...set } = row;
          await this.db.db.update(orderAttempts).set(set).where(eq(orderAttempts.id, a.id));
        } else {
          await this.db.db.insert(orderAttempts).values(row);
          this.persistedAttemptIds.add(a.id);
        }
      } catch (e) {
        this.warnOnce("order_attempts", `order attempt persist failed: ${String(e)}`);
      }
    }

    await this.insertBatch("execution_timeline_events", this.events.splice(0), (rows) =>
      this.db.db.insert(executionTimelineEvents).values(rows.map((e) => ({
        id: e.id,
        correlationId: e.correlationId,
        intentId: e.intentId,
        attemptId: e.attemptId,
        state: e.state,
        tsMs: e.tsMs,
        monoNs: e.monoNs,
        bookSnapshotId: ref(e.bookToken),
        mode: e.mode,
        detail: e.detail,
        configVersion: e.configVersion,
      }))));

    await this.insertBatch("latency_samples", this.latencies.splice(0), (rows) =>
      this.db.db.insert(latencySamples).values(rows));
    await this.insertBatch("queue_estimates", this.queues.splice(0), (rows) =>
      this.db.db.insert(queueEstimates).values(rows));
    await this.insertBatch("fill_counterfactuals", this.counterfactuals.splice(0), (rows) =>
      this.db.db.insert(fillCounterfactuals).values(rows));
    await this.insertBatch("markout_observations", this.markouts.splice(0), (rows) =>
      this.db.db.insert(markoutObservations).values(rows.map((m) => ({ ...m, horizonMs: String(m.horizonMs) }))));
    await this.insertBatch("paper_variant_results", this.variants.splice(0), (rows) =>
      this.db.db.insert(paperVariantResults).values(rows).onConflictDoNothing());
    await this.insertBatch("fill_selection_cost_records", this.selectionCosts.splice(0), (rows) =>
      this.db.db.insert(fillSelectionCostRecords).values(rows));
  }

  private async insertBatch<T>(kind: string, rows: T[], run: (rows: T[]) => Promise<unknown>): Promise<void> {
    if (rows.length === 0) return;
    try {
      await run(rows);
    } catch (e) {
      this.warnOnce(kind, `${kind} persist failed (${rows.length} rows dropped): ${String(e)}`);
      this.droppedRows += rows.length;
    }
  }

  private pruneTokenMap(): void {
    if (this.snapshotIdByToken.size <= 4096) return;
    const it = this.snapshotIdByToken.keys();
    for (let i = 0; i < 512; i++) {
      const k = it.next();
      if (k.done) break;
      this.snapshotIdByToken.delete(k.value);
    }
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logger.warn(msg, { kind: "execution_persistence" });
  }
}
