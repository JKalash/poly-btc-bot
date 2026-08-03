import {
  ctfOperations, hedgeActions, inventoryLots, inventorySnapshots, liquidityRewardAccruals,
  pairedLegs, pairedQuoteCycles, rebateAccruals, type DbHandle,
} from "@b5p/db";
import type {
  CtfOperation, HedgeAction, InventoryLot, InventorySnapshot, LiquidityRewardAccrual,
  PairedLeg, PairedQuoteCycle, RebateAccrual,
} from "@b5p/domain";
import { eq } from "drizzle-orm";
import { EXECUTION_BUFFER_MAX_ROWS } from "./execution-constants";
import { logger } from "./log";

/**
 * Buffered, strictly-async persistence for the R10 paired-cycle inventory rows
 * (execution-persistence.ts pattern): the hot path only pushes plain objects
 * into in-memory buffers; draining happens on a serialized background chain
 * (`requestFlush`) and failures are warn-once, never propagated. `settle()` is
 * awaited at the END of an engine step (after all trading actions) because the
 * embedded PGlite dev database is a single WASM connection.
 *
 * Destination tables are Agent I's (@b5p/db schema): paired_quote_cycles,
 * paired_legs, ctf_operations, hedge_actions, inventory_lots,
 * inventory_snapshots, rebate_accruals, liquidity_reward_accruals. FK order is
 * respected in the drain: cycles first, then legs/ops, then leg-referencing
 * rows. Accrual rows flatten the domain AccrualStatus union into
 * state/realized/paidAmount6/paidAtMs columns (invariant: realized === (state
 * = 'PAID'), kept by the AccrualLedger writers).
 */

export interface InventorySink {
  upsertCycle(row: PairedQuoteCycle): void;
  upsertLeg(row: PairedLeg): void;
  upsertCtfOperation(row: CtfOperation): void;
  upsertHedgeAction(row: HedgeAction): void;
  upsertLot(row: InventoryLot): void;
  addSnapshot(row: InventorySnapshot): void;
  upsertRebate(row: RebateAccrual): void;
  upsertReward(row: LiquidityRewardAccrual): void;
  requestFlush(): void;
  settle(): Promise<void>;
}

/** In-memory sink for unit tests: captures every row, no DB. */
export class MemoryInventorySink implements InventorySink {
  cycles = new Map<string, PairedQuoteCycle>();
  legs = new Map<string, PairedLeg>();
  ctfOps = new Map<string, CtfOperation>();
  hedges = new Map<string, HedgeAction>();
  lots = new Map<string, InventoryLot>();
  snapshots: InventorySnapshot[] = [];
  rebates = new Map<string, RebateAccrual>();
  rewards = new Map<string, LiquidityRewardAccrual>();

  upsertCycle(row: PairedQuoteCycle): void { this.cycles.set(row.id, { ...row }); }
  upsertLeg(row: PairedLeg): void { this.legs.set(row.id, { ...row }); }
  upsertCtfOperation(row: CtfOperation): void { this.ctfOps.set(row.id, { ...row }); }
  upsertHedgeAction(row: HedgeAction): void { this.hedges.set(row.id, { ...row }); }
  upsertLot(row: InventoryLot): void { this.lots.set(row.id, { ...row }); }
  addSnapshot(row: InventorySnapshot): void { this.snapshots.push({ ...row }); }
  upsertRebate(row: RebateAccrual): void { this.rebates.set(row.id, { ...row }); }
  upsertReward(row: LiquidityRewardAccrual): void { this.rewards.set(row.id, { ...row }); }
  requestFlush(): void { /* no-op */ }
  async settle(): Promise<void> { /* no-op */ }
}

export class InventoryPersistence implements InventorySink {
  private cycles = new Map<string, PairedQuoteCycle>();
  private legs = new Map<string, PairedLeg>();
  private ctfOps = new Map<string, CtfOperation>();
  private hedges = new Map<string, HedgeAction>();
  private lots = new Map<string, InventoryLot>();
  private snapshots: InventorySnapshot[] = [];
  private rebates = new Map<string, RebateAccrual>();
  private rewards = new Map<string, LiquidityRewardAccrual>();

  private persisted = new Set<string>(); // "<table>:<id>" insert-vs-update memory
  private flushChain: Promise<void> = Promise.resolve();
  private warned = new Set<string>();
  droppedRows = 0;

  constructor(private readonly db: DbHandle) {}

  // ---- hot-path enqueue (synchronous, never throws) ----

  upsertCycle(row: PairedQuoteCycle): void { this.cycles.set(row.id, { ...row }); }
  upsertLeg(row: PairedLeg): void { this.legs.set(row.id, { ...row }); }
  upsertCtfOperation(row: CtfOperation): void { this.ctfOps.set(row.id, { ...row }); }
  upsertHedgeAction(row: HedgeAction): void { this.hedges.set(row.id, { ...row }); }
  upsertLot(row: InventoryLot): void { this.lots.set(row.id, { ...row }); }
  upsertRebate(row: RebateAccrual): void { this.rebates.set(row.id, { ...row }); }
  upsertReward(row: LiquidityRewardAccrual): void { this.rewards.set(row.id, { ...row }); }

  addSnapshot(row: InventorySnapshot): void {
    if (this.snapshots.length >= EXECUTION_BUFFER_MAX_ROWS) {
      this.snapshots.shift();
      this.droppedRows++;
      this.warnOnce("buffer_overflow_inventory_snapshots", "inventory snapshot buffer overflow; oldest rows dropped");
    }
    this.snapshots.push({ ...row });
  }

  /** Fire-and-forget serialized drain. Safe to call from the hot path. */
  requestFlush(): void {
    this.flushChain = this.flushChain.then(() => this.drain()).catch((e) => {
      this.warnOnce("flush", `inventory persistence flush failed: ${String(e)}`);
    });
  }

  /** Await full drain (tests / end of engine step). */
  async settle(): Promise<void> {
    this.requestFlush();
    await this.flushChain;
  }

  private async drain(): Promise<void> {
    // FK order: cycles -> legs -> (ops, hedges, lots, accruals referencing them)
    for (const row of this.take(this.cycles)) {
      await this.upsert("paired_quote_cycles", row.id, {
        id: row.id, correlationId: row.correlationId, marketId: row.marketId, mode: row.mode,
        kind: row.kind, state: row.state, targetPairPrice6: row.targetPairPrice6,
        collateralCommitted6: row.collateralCommitted6, worstCaseLoss6: row.worstCaseLoss6,
        splitOperationId: row.splitOperationId, mergeOperationId: row.mergeOperationId,
        oneLegFilledAtMs: row.oneLegFilledAtMs, hedgeCompletedAtMs: row.hedgeCompletedAtMs,
        unhedgedDurationMs: row.unhedgedDurationMs, spreadCaptured6: row.spreadCaptured6,
        fees6: row.fees6, realizedPnl6: row.realizedPnl6, createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs, reconciledAtMs: row.reconciledAtMs, configVersion: row.configVersion,
      }, (v) => this.db.db.insert(pairedQuoteCycles).values(v), (set) =>
        this.db.db.update(pairedQuoteCycles).set(set).where(eq(pairedQuoteCycles.id, row.id)));
    }
    for (const row of this.take(this.legs)) {
      await this.upsert("paired_legs", row.id, {
        id: row.id, correlationId: row.correlationId, cycleId: row.cycleId, marketId: row.marketId,
        tokenId: row.tokenId, outcomeSide: row.outcomeSide, orderSide: row.orderSide, state: row.state,
        price6: row.price6, size6: row.size6, filledShares6: row.filledShares6,
        avgFillPrice6: row.avgFillPrice6, feeUsdc6: row.feeUsdc6, attemptId: row.attemptId,
        quotedAtMs: row.quotedAtMs, firstFillAtMs: row.firstFillAtMs,
        unhedgedStartedAtMs: row.unhedgedStartedAtMs, hedgedAtMs: row.hedgedAtMs,
        closedAtMs: row.closedAtMs, createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs,
        configVersion: row.configVersion,
      }, (v) => this.db.db.insert(pairedLegs).values(v), (set) =>
        this.db.db.update(pairedLegs).set(set).where(eq(pairedLegs.id, row.id)));
    }
    for (const row of this.take(this.ctfOps)) {
      await this.upsert("ctf_operations", row.id, {
        id: row.id, correlationId: row.correlationId, cycleId: row.cycleId, marketId: row.marketId,
        conditionId: row.conditionId, kind: row.kind, state: row.state, mode: row.mode,
        requestedAmount6: row.requestedAmount6, confirmedAmount6: row.confirmedAmount6,
        collateralDelta6: row.collateralDelta6, estGasUsdc6: row.estGasUsdc6,
        actualGasUsdc6: row.actualGasUsdc6, relayed: row.relayed, txHash: row.txHash,
        failureReason: row.failureReason, createdAtMs: row.createdAtMs, submittedAtMs: row.submittedAtMs,
        confirmedAtMs: row.confirmedAtMs, updatedAtMs: row.updatedAtMs, configVersion: row.configVersion,
      }, (v) => this.db.db.insert(ctfOperations).values(v), (set) =>
        this.db.db.update(ctfOperations).set(set).where(eq(ctfOperations.id, row.id)));
    }
    for (const row of this.take(this.hedges)) {
      await this.upsert("hedge_actions", row.id, {
        id: row.id, correlationId: row.correlationId, cycleId: row.cycleId, legId: row.legId,
        marketId: row.marketId, tokenId: row.tokenId, kind: row.kind, state: row.state, mode: row.mode,
        targetShares6: row.targetShares6, executedShares6: row.executedShares6,
        expectedCost6: row.expectedCost6, actualCost6: row.actualCost6, feeUsdc6: row.feeUsdc6,
        attemptId: row.attemptId, unhedgedDurationMs: row.unhedgedDurationMs,
        decidedAtMs: row.decidedAtMs, executedAtMs: row.executedAtMs, updatedAtMs: row.updatedAtMs,
        configVersion: row.configVersion,
      }, (v) => this.db.db.insert(hedgeActions).values(v), (set) =>
        this.db.db.update(hedgeActions).set(set).where(eq(hedgeActions.id, row.id)));
    }
    for (const row of this.take(this.lots)) {
      await this.upsert("inventory_lots", row.id, {
        id: row.id, correlationId: row.correlationId, cycleId: row.cycleId, marketId: row.marketId,
        tokenId: row.tokenId, outcomeSide: row.outcomeSide, source: row.source, sourceRef: row.sourceRef,
        mode: row.mode, acquiredShares6: row.acquiredShares6, remainingShares6: row.remainingShares6,
        costBasis6: row.costBasis6, acquiredAtMs: row.acquiredAtMs, consumedAtMs: row.consumedAtMs,
        configVersion: row.configVersion,
      }, (v) => this.db.db.insert(inventoryLots).values(v), (set) =>
        this.db.db.update(inventoryLots).set(set).where(eq(inventoryLots.id, row.id)));
    }
    for (const row of this.take(this.rebates)) {
      // domain `program` discriminant is implied by the table; not a column
      await this.upsert("rebate_accruals", row.id, {
        id: row.id, correlationId: row.correlationId, programVersion: row.programVersion,
        marketId: row.marketId, cycleId: row.cycleId, fillId: row.fillId,
        basisShares6: row.basisShares6, basisNotional6: row.basisNotional6, amount6: row.amount6,
        state: row.state, realized: row.realized, paidAmount6: row.paidAmount6, paidAtMs: row.paidAtMs,
        createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs, configVersion: row.configVersion,
      }, (v) => this.db.db.insert(rebateAccruals).values(v), (set) =>
        this.db.db.update(rebateAccruals).set(set).where(eq(rebateAccruals.id, row.id)));
    }
    for (const row of this.take(this.rewards)) {
      await this.upsert("liquidity_reward_accruals", row.id, {
        id: row.id, correlationId: row.correlationId, programVersion: row.programVersion,
        marketId: row.marketId, epochKey: row.epochKey, qualifyingUptimeMs: row.qualifyingUptimeMs,
        scoreDetail: row.scoreDetail, amount6: row.amount6,
        state: row.state, realized: row.realized, paidAmount6: row.paidAmount6, paidAtMs: row.paidAtMs,
        createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs, configVersion: row.configVersion,
      }, (v) => this.db.db.insert(liquidityRewardAccruals).values(v), (set) =>
        this.db.db.update(liquidityRewardAccruals).set(set).where(eq(liquidityRewardAccruals.id, row.id)));
    }
    const snaps = this.snapshots.splice(0);
    if (snaps.length > 0) {
      try {
        await this.db.db.insert(inventorySnapshots).values(snaps.map((row) => ({
          id: row.id, correlationId: row.correlationId, marketId: row.marketId, mode: row.mode,
          upShares6: row.upShares6, downShares6: row.downShares6, pairedShares6: row.pairedShares6,
          unpairedUpShares6: row.unpairedUpShares6, unpairedDownShares6: row.unpairedDownShares6,
          reservedUpShares6: row.reservedUpShares6, reservedDownShares6: row.reservedDownShares6,
          collateralFree6: row.collateralFree6, exchangeUpShares6: row.exchangeUpShares6,
          exchangeDownShares6: row.exchangeDownShares6, onchainUpShares6: row.onchainUpShares6,
          onchainDownShares6: row.onchainDownShares6, reconciled: row.reconciled,
          divergence: row.divergence, tsMs: row.tsMs, configVersion: row.configVersion,
        })));
      } catch (e) {
        this.droppedRows += snaps.length;
        this.warnOnce("inventory_snapshots", `inventory_snapshots persist failed (${snaps.length} rows dropped): ${String(e)}`);
      }
    }
  }

  private take<T>(buf: Map<string, T>): T[] {
    const rows = [...buf.values()];
    buf.clear();
    return rows;
  }

  private async upsert<Row extends { id: string; createdAtMs?: number }>(
    table: string,
    id: string,
    row: Row,
    insert: (row: Row) => Promise<unknown> | { execute?: unknown },
    update: (set: Partial<Row>) => Promise<unknown> | { execute?: unknown },
  ): Promise<void> {
    const key = `${table}:${id}`;
    try {
      if (this.persisted.has(key)) {
        const { id: _id, createdAtMs: _c, ...set } = row;
        await (update(set as Partial<Row>) as Promise<unknown>);
      } else {
        await (insert(row) as Promise<unknown>);
        this.persisted.add(key);
        this.pruneUpsertMemory();
      }
    } catch (e) {
      this.droppedRows++;
      this.warnOnce(`${table}_write`, `${table} persist failed: ${String(e)}`);
    }
  }

  private pruneUpsertMemory(): void {
    if (this.persisted.size <= 8192) return;
    const it = this.persisted.values();
    for (let i = 0; i < 1024; i++) {
      const k = it.next();
      if (k.done) break;
      this.persisted.delete(k.value);
    }
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logger.warn(msg, { kind: "inventory_persistence" });
  }
}
