import type { AppConfig } from "@b5p/config";
import { orderFills, orders as ordersTable, type DbHandle } from "@b5p/db";
import { newId } from "@b5p/domain/ids";
import {
  breakEvenTakerUsdcCollected, mulDiv, takerFeeUsdc,
  type OutcomeSide, type Ppm, type Prob6, type Shares6, type Usdc6,
} from "@b5p/domain";
import type { BookState } from "@b5p/strategy";
import { eq } from "drizzle-orm";
import { logger } from "./log";

/**
 * Paper execution simulator.
 *
 * Maker (post-only) model — CONSERVATIVE by default and deliberately
 * pessimistic, because unconditional fill simulation systematically overstates
 * maker P&L (fills arrive precisely when flow is toxic):
 *  - the order activates after simulated latency;
 *  - post-only is rejected if it would cross at ACTIVATION time (not submit time);
 *  - we join the BACK of the displayed queue at our price;
 *  - only printed trades at our price or better, after activation, consume
 *    queue ahead of us; then we fill pro-rata with partial fills;
 *  - "optimistic" model skips the queue (still requires trades to print).
 *
 * Taker FAK model: walks the current book at activation, fills what is
 * available within the limit price, charges the live fee formula, cancels
 * the remainder.
 */

export interface PaperOrderRecord {
  id: string;
  decisionId: string;
  intentId: string;
  marketId: string;
  tokenId: string;
  outcomeSide: OutcomeSide;
  style: "maker_post_only" | "taker_fak";
  price6: Prob6;
  shares6: Shares6;
  filled6: Shares6;
  queueAhead6: Shares6;
  stakeCap6: Usdc6;
  spent6: Usdc6;
  status: "PENDING" | "LIVE" | "PARTIAL" | "MATCHED" | "CANCELED" | "REJECTED" | "EXPIRED";
  activateAtMs: number;
  expireAtMs: number | null;
  exitPolicy: string;
  createdAtMs: number;
}

export interface FillEvent {
  order: PaperOrderRecord;
  shares6: Shares6;
  price6: Prob6;
  fee6: Usdc6;
  maker: boolean;
  tsMs: number;
  /** order_fills row id for this fill (execution-timeline threading). */
  fillId?: string;
}

/**
 * Observation hooks for the execution-quality timeline (plan item 1b).
 * Strictly additive: hooks fire AFTER the executor's own state/persistence
 * changes, exceptions are swallowed, and no hook can alter fill behavior —
 * the canonical paper path (QUEUE_REPLAY) stays bit-identical with or
 * without them.
 */
export interface PaperExecHooks {
  /** Order accepted by the simulated exchange (maker: now resting; taker: about to walk the book). */
  onActivated?(o: PaperOrderRecord, nowMs: number): void;
  /** Queue ahead of a resting maker order decreased by `consumed6` (trade tape replay). */
  onQueueChanged?(o: PaperOrderRecord, consumed6: Shares6, tsMs: number): void;
  /** Order reached a terminal status (MATCHED / CANCELED / REJECTED / EXPIRED). */
  onFinished?(o: PaperOrderRecord, status: PaperOrderRecord["status"], reason: string, nowMs: number): void;
}

export class PaperExecutor {
  private orders = new Map<string, PaperOrderRecord>();
  /** Optional timeline observation hooks; never affect execution. */
  hooks: PaperExecHooks | null = null;

  constructor(
    private readonly db: DbHandle,
    private readonly feeRatePpm: () => Ppm,
    private readonly feeCollection: () => "usdc" | "shares",
    private readonly onFill: (f: FillEvent) => Promise<void>,
    private readonly books: (tokenId: string) => BookState | null,
  ) {}

  restingOrders(): PaperOrderRecord[] {
    return [...this.orders.values()].filter((o) => o.status === "LIVE" || o.status === "PARTIAL" || o.status === "PENDING");
  }

  ordersForMarket(marketId: string): PaperOrderRecord[] {
    return [...this.orders.values()].filter((o) => o.marketId === marketId);
  }

  async submit(args: {
    decisionId: string;
    intentId: string;
    marketId: string;
    tokenId: string;
    outcomeSide: OutcomeSide;
    style: "maker_post_only" | "taker_fak";
    price6: Prob6;
    shares6: Shares6;
    stakeCap6: Usdc6;
    exitPolicy: string;
    nowMs: number;
    cfg: AppConfig;
    cancelAtSecondsRemaining: number;
    marketEndEpoch: number;
  }): Promise<PaperOrderRecord> {
    const latency = args.cfg.paper.simulated_latency_ms;
    const cancelCutoffMs = (args.marketEndEpoch - args.cancelAtSecondsRemaining) * 1000;
    const rec: PaperOrderRecord = {
      id: newId(),
      decisionId: args.decisionId,
      intentId: args.intentId,
      marketId: args.marketId,
      tokenId: args.tokenId,
      outcomeSide: args.outcomeSide,
      style: args.style,
      price6: args.price6,
      shares6: args.shares6,
      filled6: 0n,
      queueAhead6: 0n,
      stakeCap6: args.stakeCap6,
      spent6: 0n,
      status: "PENDING",
      activateAtMs: args.nowMs + latency,
      expireAtMs: args.style === "maker_post_only" ? cancelCutoffMs : args.nowMs + latency + 2000,
      exitPolicy: args.exitPolicy,
      createdAtMs: args.nowMs,
    };
    this.orders.set(rec.id, rec);
    await this.db.db.insert(ordersTable).values({
      id: rec.id,
      intentId: rec.intentId,
      decisionId: rec.decisionId,
      marketId: rec.marketId,
      tokenId: rec.tokenId,
      outcomeSide: rec.outcomeSide,
      orderSide: "BUY",
      style: rec.style,
      timeInForce: rec.style === "maker_post_only" ? "GTD" : "FAK",
      postOnly: rec.style === "maker_post_only",
      price6: rec.price6,
      shares6: rec.shares6,
      filledShares6: 0n,
      stake6: rec.stakeCap6,
      mode: "paper",
      status: rec.status,
      expireAtMs: rec.expireAtMs,
      createdAtMs: rec.createdAtMs,
      updatedAtMs: rec.createdAtMs,
    });
    return rec;
  }

  /** Advance simulator time: activate pending orders, execute FAK, expire GTD. */
  async step(nowMs: number): Promise<void> {
    for (const o of this.orders.values()) {
      if (o.status === "PENDING" && nowMs >= o.activateAtMs) {
        await this.activate(o, nowMs);
      }
      if ((o.status === "LIVE" || o.status === "PARTIAL") && o.expireAtMs !== null && nowMs >= o.expireAtMs) {
        await this.finish(o, o.style === "maker_post_only" ? "CANCELED" : "EXPIRED", "time cutoff reached", nowMs);
      }
    }
  }

  private async activate(o: PaperOrderRecord, nowMs: number): Promise<void> {
    const book = this.books(o.tokenId);
    if (!book) {
      await this.finish(o, "REJECTED", "no book at activation", nowMs);
      return;
    }
    if (o.style === "maker_post_only") {
      const bestAsk = book.bestAsk();
      if (bestAsk !== null && o.price6 >= bestAsk) {
        // post-only would cross -> safe no-fill; NEVER converted to taker
        await this.finish(o, "REJECTED", "post-only would cross at activation; rejected safely", nowMs);
        return;
      }
      o.queueAhead6 = book.queueAtBid(o.price6); // join the back of the displayed queue
      o.status = "LIVE";
      await this.persistStatus(o, nowMs);
      this.safeHook((h) => h.onActivated?.(o, nowMs));
      return;
    }
    // taker FAK: walk asks up to limit price, respect stake cap
    this.safeHook((h) => h.onActivated?.(o, nowMs));
    let remaining = o.shares6;
    const rate = this.feeRatePpm();
    for (const lvl of book.sortedAsks()) {
      if (lvl.price > o.price6 || remaining <= 0n) break;
      const take = remaining < lvl.size ? remaining : lvl.size;
      const cost = mulDiv(take, lvl.price, 1_000_000n, "ceil");
      const fee = this.feeCollection() === "usdc" ? takerFeeUsdc(take, lvl.price, rate) : 0n;
      if (o.spent6 + cost + fee > o.stakeCap6) {
        // shrink to fit the stake cap: cost per share INCLUDING fee
        const budget = o.stakeCap6 - o.spent6;
        const costPerShare6 = this.feeCollection() === "usdc"
          ? breakEvenTakerUsdcCollected(lvl.price, rate) // p + f*p*(1-p) in µUSDC/share
          : lvl.price;
        let shrunk = mulDiv(budget, 1_000_000n, costPerShare6, "floor");
        // guard against rounding overshoot
        for (let guard = 0; guard < 5 && shrunk > 0n; guard++) {
          const c = mulDiv(shrunk, lvl.price, 1_000_000n, "ceil");
          const fe = this.feeCollection() === "usdc" ? takerFeeUsdc(shrunk, lvl.price, rate) : 0n;
          if (c + fe <= budget) break;
          shrunk -= 10_000n; // 0.01 share
        }
        if (shrunk <= 0n) break;
        const shrunkFee = this.feeCollection() === "usdc" ? takerFeeUsdc(shrunk, lvl.price, rate) : 0n;
        await this.recordFill(o, shrunk, lvl.price, shrunkFee, false, nowMs);
        remaining = 0n;
        break;
      }
      await this.recordFill(o, take, lvl.price, fee, false, nowMs);
      remaining -= take;
    }
    await this.finish(
      o,
      o.filled6 > 0n ? "MATCHED" : "CANCELED",
      o.filled6 > 0n ? "FAK filled available size" : "FAK: nothing executable within limit",
      nowMs,
    );
  }

  /** Feed printed trades into resting maker orders (queue-consumption model). */
  async onTrade(tokenId: string, price6: Prob6, size6: Shares6, tsMs: number, queueModel: "conservative" | "optimistic"): Promise<void> {
    for (const o of this.orders.values()) {
      if (o.tokenId !== tokenId) continue;
      if (o.status !== "LIVE" && o.status !== "PARTIAL") continue;
      if (o.style !== "maker_post_only") continue;
      if (tsMs < o.activateAtMs) continue;
      // a resting BUY at price P is hit by sells printing at P or lower
      if (price6 > o.price6) continue;

      let tradable = size6;
      if (queueModel === "conservative" && o.queueAhead6 > 0n) {
        const consumed = tradable < o.queueAhead6 ? tradable : o.queueAhead6;
        o.queueAhead6 -= consumed;
        tradable -= consumed;
        this.safeHook((h) => h.onQueueChanged?.(o, consumed, tsMs));
      }
      if (tradable <= 0n) continue;
      const remaining = o.shares6 - o.filled6;
      const fill = tradable < remaining ? tradable : remaining;
      if (fill <= 0n) continue;
      await this.recordFill(o, fill, o.price6, 0n, true, tsMs); // maker pays no fee
      if (o.filled6 >= o.shares6) {
        await this.finish(o, "MATCHED", "fully filled", tsMs);
      } else {
        o.status = "PARTIAL";
        await this.persistStatus(o, tsMs);
      }
    }
  }

  private async recordFill(o: PaperOrderRecord, shares6: Shares6, price6: Prob6, fee6: Usdc6, maker: boolean, tsMs: number): Promise<void> {
    const cost = mulDiv(shares6, price6, 1_000_000n, "ceil");
    // invariant: total stake spent never exceeds the approved cap
    if (o.spent6 + cost + fee6 > o.stakeCap6) {
      logger.error("fill would exceed approved stake; truncating", { orderId: o.id });
      return;
    }
    o.filled6 += shares6;
    o.spent6 += cost + fee6;
    const fillId = newId();
    await this.db.db.insert(orderFills).values({
      id: fillId,
      orderId: o.id,
      price6,
      shares6,
      feeUsdc6: fee6,
      maker,
      tsMs,
    });
    await this.db.db.update(ordersTable).set({ filledShares6: o.filled6, updatedAtMs: tsMs }).where(eq(ordersTable.id, o.id));
    await this.onFill({ order: o, shares6, price6, fee6, maker, tsMs, fillId });
  }

  async cancel(orderId: string, reason: string, nowMs: number): Promise<boolean> {
    const o = this.orders.get(orderId);
    if (!o) return false;
    if (o.status === "MATCHED" || o.status === "CANCELED" || o.status === "REJECTED" || o.status === "EXPIRED") return false;
    await this.finish(o, "CANCELED", reason, nowMs);
    return true;
  }

  async cancelAll(reason: string, nowMs: number): Promise<number> {
    let n = 0;
    for (const o of this.orders.values()) {
      if (o.status === "PENDING" || o.status === "LIVE" || o.status === "PARTIAL") {
        await this.finish(o, "CANCELED", reason, nowMs);
        n++;
      }
    }
    return n;
  }

  private async finish(o: PaperOrderRecord, status: PaperOrderRecord["status"], reason: string, nowMs: number): Promise<void> {
    o.status = status;
    await this.db.db.update(ordersTable)
      .set({ status, statusReason: reason, updatedAtMs: nowMs, filledShares6: o.filled6 })
      .where(eq(ordersTable.id, o.id));
    this.safeHook((h) => h.onFinished?.(o, status, reason, nowMs));
  }

  /** Hooks are observation-only: any exception is contained here. */
  private safeHook(fn: (h: PaperExecHooks) => void): void {
    if (!this.hooks) return;
    try { fn(this.hooks); } catch (e) { logger.warn("paper exec hook failed", { error: String(e) }); }
  }

  private async persistStatus(o: PaperOrderRecord, nowMs: number): Promise<void> {
    await this.db.db.update(ordersTable)
      .set({ status: o.status, updatedAtMs: nowMs, filledShares6: o.filled6 })
      .where(eq(ordersTable.id, o.id));
  }

  /** Restart reconciliation: resting paper orders from a previous process are canceled conservatively. */
  async reconcileOrphans(nowMs: number): Promise<number> {
    const rows = await this.db.db.select().from(ordersTable).where(eq(ordersTable.mode, "paper"));
    let n = 0;
    for (const r of rows) {
      if (r.status === "LIVE" || r.status === "PARTIAL" || r.status === "PENDING") {
        await this.db.db.update(ordersTable)
          .set({ status: "CANCELED", statusReason: "engine restart: conservative orphan cancellation", updatedAtMs: nowMs })
          .where(eq(ordersTable.id, r.id));
        n++;
      }
    }
    return n;
  }
}
