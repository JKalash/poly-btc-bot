import { orderFills, orders as ordersTable, pnlRecords, positions as positionsTable, type Db, type DbHandle } from "@b5p/db";
import { newId } from "@b5p/domain/ids";
import {
  mulDiv, usdc, type BankrollState, type OutcomeSide, type Prob6, type Shares6, type Usdc6,
} from "@b5p/domain";
import { LiveClobAdapter, type LivePreflight, type OrderRequest } from "@b5p/polymarket";
import { and, desc, eq, inArray } from "drizzle-orm";
import { logger } from "./log";
import { DirectionalExposureCoordinator } from "./directional-exposure-guard";

/**
 * Live arming controller. Owns the real-money adapter and the arm state machine.
 * The engine composes one of these; it exists ONLY when a hot-wallet key is
 * configured. Every safety rule the spec demands is enforced here:
 *
 *  - Boots DISARMED, always. Restart => DISARMED (this object is recreated).
 *  - Arming requires: live enabled, a configured adapter, a typed acknowledgement
 *    string that matches exactly, a successful wallet reconciliation (balance +
 *    allowance readable and sufficient), and it grants an EXPIRING window.
 *  - Auto-disarms on: kill switch, halt, fee-schedule change, reconciliation
 *    mismatch, data-integrity failure, or token expiry.
 *  - No key ever passes through this class's logs or return values.
 */

export type ArmState = "DISARMED" | "ARMING" | "ARMED";

export const ARM_ACK_PHRASE =
  "I understand this trades real money and can lose up to my configured per-trade risk on every trade";

export interface ArmRequest {
  acknowledgement: string;
  ttlMinutes: number;
  minUsdc: Usdc6;
}

export interface ArmResult {
  ok: boolean;
  state: ArmState;
  reasons: string[];
  walletAddress?: string;
  usdcBalance?: string;
  expiresAtMs?: number;
}

interface LiveOpenPosition {
  positionId: string;
  marketId: string;
  decisionId: string | null;
  side: OutcomeSide;
  shares6: Shares6;
  cost6: Usdc6;
  fees6: Usdc6;
  stake6: Usdc6;
  exitPolicy: string;
  openedAtMs: number;
}

export class LiveController {
  private adapter: LiveClobAdapter | null = null;
  state: ArmState = "DISARMED";
  expiresAtMs = 0;
  lastPreflight: LivePreflight | null = null;
  liveBankroll6: Usdc6 = 0n;
  sessionPeak6: Usdc6 = 0n;
  dailyPeak6: Usdc6 = 0n;
  consecutiveLosses = 0;
  private openMarkets = new Set<string>();
  /** marketId -> live position built from RECORDED fills only. */
  private positions = new Map<string, LiveOpenPosition>();
  /** orderId -> stake reserved by a resting (unfilled) live order. */
  private restingReserve = new Map<string, { marketId: string; stake6: Usdc6 }>();
  disarmReason: string | null = null;
  private readonly exposure: DirectionalExposureCoordinator;

  constructor(private readonly db: DbHandle, adapterOverride?: LiveClobAdapter) {
    this.exposure = new DirectionalExposureCoordinator(db);
    if (adapterOverride !== undefined) {
      this.adapter = adapterOverride;
      return;
    }
    const enabled = process.env.LIVE_TRADING_ENABLED === "1";
    const key = process.env.HOT_WALLET_PRIVATE_KEY;
    if (enabled && key) {
      try {
        this.adapter = new LiveClobAdapter({
          privateKey: key,
          ...(process.env.CLOB_HOST ? { host: process.env.CLOB_HOST } : {}),
          ...(process.env.FUNDER_ADDRESS ? { funderAddress: process.env.FUNDER_ADDRESS } : {}),
        });
        logger.info("live adapter configured (DISARMED by default)");
      } catch (e) {
        // never log the key; constructor only validates format
        logger.error("live adapter configuration failed", { error: String(e).replace(/0x[0-9a-fA-F]{64}/g, "0x<redacted>") });
      }
    }
  }

  get configured(): boolean { return this.adapter !== null; }

  /**
   * Restore the live consecutive-loss streak from persisted live pnl_records
   * (newest first: count net6 < 0 rows until a win; scratch trades neither
   * break nor extend the streak — matching settle()'s semantics). Without
   * this, every restart-then-re-arm silently wiped a tripped loss stop on the
   * real-money path while the paper path kept its restored counter.
   */
  async reconcile(): Promise<void> {
    const rows = await this.db.db.select({ net6: pnlRecords.net6, createdAtMs: pnlRecords.createdAtMs })
      .from(pnlRecords).where(eq(pnlRecords.mode, "live"))
      .orderBy(desc(pnlRecords.createdAtMs)).limit(50);
    let streak = 0;
    for (const r of rows) {
      if (r.net6 < 0n) streak += 1;
      else if (r.net6 > 0n) break;
      // net6 === 0n: scratch — skip, keep counting
    }
    this.consecutiveLosses = streak;
    if (streak > 0) logger.warn("live consecutive-loss streak restored from persisted records", { streak });
  }

  isArmed(nowMs: number): boolean {
    if (this.state === "ARMED" && nowMs >= this.expiresAtMs) {
      this.disarm("arming token expired");
    }
    return this.state === "ARMED";
  }

  async arm(req: ArmRequest, nowMs: number): Promise<ArmResult> {
    const reasons: string[] = [];
    if (!this.adapter) reasons.push("live trading is not configured on this deployment (no hot-wallet key)");
    if (req.acknowledgement.trim() !== ARM_ACK_PHRASE) reasons.push("typed acknowledgement does not match exactly");
    if (reasons.length > 0) return { ok: false, state: this.state, reasons };

    this.state = "ARMING";
    const pf = await this.adapter!.preflight(req.minUsdc);
    this.lastPreflight = pf;
    if (!pf.ok) {
      this.state = "DISARMED";
      return { ok: false, state: this.state, reasons: pf.reasons, walletAddress: pf.walletAddress };
    }
    this.liveBankroll6 = pf.usdcBalance;
    this.sessionPeak6 = pf.usdcBalance;
    this.dailyPeak6 = pf.usdcBalance;
    // NOTE: consecutiveLosses is deliberately NOT reset here — arming must not
    // re-arm a tripped loss stop. The counter is restored from persisted live
    // pnl_records at boot (reconcile()) and cleared only by operator resume.
    this.state = "ARMED";
    this.disarmReason = null;
    const ttl = Math.min(Math.max(req.ttlMinutes, 1), 120);
    this.expiresAtMs = nowMs + ttl * 60_000;
    return {
      ok: true,
      state: this.state,
      reasons: [],
      walletAddress: pf.walletAddress,
      usdcBalance: (Number(pf.usdcBalance) / 1e6).toFixed(6),
      expiresAtMs: this.expiresAtMs,
    };
  }

  disarm(reason: string): void {
    if (this.state !== "DISARMED") {
      logger.warn("live disarm", { reason });
      this.disarmReason = reason;
    }
    this.state = "DISARMED";
    this.expiresAtMs = 0;
  }

  /** #60: engine drains this each step; a set value triggers a full halt. */
  private pendingHaltReason: string | null = null;
  takePendingHalt(): string | null {
    const r = this.pendingHaltReason;
    this.pendingHaltReason = null;
    return r;
  }

  async refreshBankroll(): Promise<void> {
    if (!this.adapter || this.state !== "ARMED") return;
    try {
      const expected = this.liveBankroll6;
      const actual = await this.adapter.usdcBalance();
      // #60: wallet balance mismatch beyond tolerance is a spec'd halt
      // condition — money moved that this engine did not account for
      // (external transfer, another client trading, or accounting drift).
      // Tolerance: 2% of expected, floor 5 USDC, to absorb fee rounding.
      const tolerance6 = expected / 50n > 5_000_000n ? expected / 50n : 5_000_000n;
      const diff = actual > expected ? actual - expected : expected - actual;
      if (expected > 0n && diff > tolerance6) {
        this.pendingHaltReason = `wallet balance mismatch: expected ~${expected} got ${actual} (diff ${diff} > tolerance ${tolerance6})`;
        this.disarm("wallet balance mismatch");
        return;
      }
      this.liveBankroll6 = actual;
      if (this.liveBankroll6 > this.sessionPeak6) this.sessionPeak6 = this.liveBankroll6;
      if (this.liveBankroll6 > this.dailyPeak6) this.dailyPeak6 = this.liveBankroll6;
    } catch (e) {
      logger.warn("live bankroll refresh failed; disarming", { error: String(e) });
      this.disarm("wallet balance unreadable");
    }
  }

  /** Cash at risk right now: recorded open positions plus resting-order reservations. */
  openExposure6(): Usdc6 {
    let total = 0n;
    for (const p of this.positions.values()) total += p.stake6;
    for (const r of this.restingReserve.values()) total += r.stake6;
    return total;
  }

  /** BankrollState the risk engine consumes when live-armed (real USDC, session/daily peaks from arm time). */
  bankState(): BankrollState {
    return {
      bankroll: this.liveBankroll6,
      sessionPeak: this.sessionPeak6,
      dailyPeak: this.dailyPeak6,
      sessionRealized: this.liveBankroll6 - this.sessionPeak6,
      dailyRealized: this.liveBankroll6 - this.dailyPeak6,
      consecutiveLosses: this.consecutiveLosses,
      openPositions: this.openMarkets.size,
      openExposure: this.openExposure6(),
      reconciled: this.lastPreflight?.ok ?? false,
    };
  }

  hasOpenPosition(marketId: string): boolean { return this.openMarkets.has(marketId); }
  markOpen(marketId: string): void { this.openMarkets.add(marketId); }
  /**
   * Close a market's live bookkeeping. `won === null` means NO fill was ever
   * recorded — outcome unknown, and unknown is never counted as a loss (a
   * winning resting fill mistaken for a loss would trip the consecutive-loss
   * stop on wins; a real loss is captured by settle() from recorded fills).
   */
  markClosed(marketId: string, won: boolean | null): void {
    this.openMarkets.delete(marketId);
    if (won === null) return;
    if (won) this.consecutiveLosses = 0; else this.consecutiveLosses += 1;
  }

  livePositionsList(): LiveOpenPosition[] {
    return [...this.positions.values()];
  }

  /**
   * Record a live fill into the position ledger (memory + positions row,
   * mode "live") so risk exposure, resolution accounting and the dashboard
   * all see real fills. Mirrors Accounting.onFill for the live path.
   */
  private async applyFill(args: {
    marketId: string;
    decisionId: string | null;
    side: OutcomeSide;
    shares6: Shares6;
    price6: Prob6;
    fee6: Usdc6;
    exitPolicy: string;
    nowMs: number;
  }, executor: Db): Promise<void> {
    const cost6 = mulDiv(args.shares6, args.price6, 1_000_000n, "ceil");
    let pos = this.positions.get(args.marketId);
    if (!pos) {
      pos = {
        positionId: newId(),
        marketId: args.marketId,
        decisionId: args.decisionId,
        side: args.side,
        shares6: 0n,
        cost6: 0n,
        fees6: 0n,
        stake6: 0n,
        exitPolicy: args.exitPolicy,
        openedAtMs: args.nowMs,
      };
      this.positions.set(args.marketId, pos);
      await executor.insert(positionsTable).values({
        id: pos.positionId,
        marketId: pos.marketId,
        decisionId: pos.decisionId,
        mode: "live",
        outcomeSide: pos.side,
        shares6: 0n,
        avgPrice6: 0n,
        cost6: 0n,
        fees6: 0n,
        stake6: 0n,
        exitPolicy: pos.exitPolicy,
        status: "OPEN",
        openedAtMs: pos.openedAtMs,
      });
    }
    pos.shares6 += args.shares6;
    pos.cost6 += cost6;
    pos.fees6 += args.fee6;
    pos.stake6 += cost6 + args.fee6;
    const avg = pos.shares6 > 0n ? mulDiv(pos.cost6, 1_000_000n, pos.shares6, "half-even") : 0n;
    await executor.update(positionsTable)
      .set({ shares6: pos.shares6, cost6: pos.cost6, fees6: pos.fees6, stake6: pos.stake6, avgPrice6: avg })
      .where(eq(positionsTable.id, pos.positionId));
  }

  /**
   * Poll the exchange for fills on non-terminal live orders. The default
   * strategy is maker-only, so fills usually arrive AFTER the submission ack —
   * without this, resting fills would never reach orders/order_fills, the
   * position ledger, or the win/loss logic. Runs whenever the adapter is
   * configured (even disarmed: a disarm must not blind the books to fills on
   * orders that are already on the exchange).
   */
  async pollOpenOrders(nowMs: number): Promise<void> {
    if (!this.adapter) return;
    const open = await this.db.db.select().from(ordersTable).where(and(
      eq(ordersTable.mode, "live"),
      inArray(ordersTable.status, ["PENDING", "LIVE", "DELAYED", "PARTIAL"]),
    ));
    if (open.length === 0) return;
    let fills: Awaited<ReturnType<LiveClobAdapter["fillsForOrders"]>>;
    try {
      fills = await this.adapter.fillsForOrders(open.filter((o) => o.externalId).map((o) => o.externalId!));
    } catch (e) {
      logger.warn("live fill poll failed; will retry", { error: String(e) });
      return;
    }
    for (const o of open) {
      const agg = o.externalId ? fills.get(o.externalId) : undefined;
      const total6 = agg?.filledShares6 ?? o.filledShares6;
      if (total6 > o.filledShares6) {
        const delta6 = total6 - o.filledShares6;
        const price6 = agg?.avgPrice6 ?? o.price6;
        const full = total6 >= o.shares6;
        await this.exposure.transaction(async (guard, executor) => {
          await executor.insert(orderFills).values({
            id: newId(), orderId: o.id, price6, shares6: delta6, feeUsdc6: 0n,
            maker: o.postOnly, tradeRef: o.externalId, tsMs: nowMs,
          });
          await executor.update(ordersTable)
            .set({ filledShares6: total6, status: full ? "MATCHED" : "PARTIAL", updatedAtMs: nowMs })
            .where(eq(ordersTable.id, o.id));
          await this.applyFill({
            marketId: o.marketId, decisionId: o.decisionId, side: o.outcomeSide as OutcomeSide,
            shares6: delta6, price6, fee6: 0n, exitPolicy: "hold_to_resolution", nowMs,
          }, executor);
          await this.exposure.reconcile(guard, executor, o.marketId, nowMs);
        });
        if (full) this.restingReserve.delete(o.id);
        logger.info("live resting fill recorded", { orderId: o.id, shares6: delta6.toString(), price6: price6.toString() });
      } else if (o.expireAtMs !== null && nowMs > o.expireAtMs + 60_000) {
        // GTD expiry passed with no (further) fill visible in trade history
        await this.exposure.transaction(async (guard, executor) => {
          await executor.update(ordersTable)
            .set({ status: "EXPIRED", statusReason: "GTD expiry passed", updatedAtMs: nowMs })
            .where(eq(ordersTable.id, o.id));
          await this.exposure.reconcile(guard, executor, o.marketId, nowMs);
        });
        this.restingReserve.delete(o.id);
      }
    }
  }

  /**
   * Settle a live position at resolution from RECORDED fills. Returns the net
   * P&L, or null when no fill was ever recorded (caller must treat that as
   * unknown, not as a loss). Falls back to the persisted positions row when
   * process memory was lost between fill and resolution.
   */
  async settle(marketId: string, outcome: OutcomeSide, nowMs: number): Promise<Usdc6 | null> {
    let pos = this.positions.get(marketId) ?? null;
    if (!pos) {
      const rows = await this.db.db.select().from(positionsTable).where(and(
        eq(positionsTable.marketId, marketId), eq(positionsTable.mode, "live"), eq(positionsTable.status, "OPEN"),
      ));
      const r = rows[0];
      if (r && r.shares6 > 0n) {
        pos = {
          positionId: r.id, marketId: r.marketId, decisionId: r.decisionId,
          side: r.outcomeSide as OutcomeSide, shares6: r.shares6, cost6: r.cost6,
          fees6: r.fees6, stake6: r.stake6, exitPolicy: r.exitPolicy, openedAtMs: r.openedAtMs,
        };
      }
    }
    if (!pos || pos.shares6 <= 0n) {
      this.markClosed(marketId, null);
      await this.exposure.transaction(async (guard, executor) => this.exposure.reconcile(guard, executor, marketId, nowMs));
      return null;
    }
    const payout6: Usdc6 = pos.side === outcome ? pos.shares6 : 0n;
    const net6 = payout6 - pos.cost6 - pos.fees6;
    await this.exposure.transaction(async (guard, executor) => {
      await executor.update(positionsTable)
        .set({ status: "RESOLVED", outcome, pnl6: net6, resolvedAtMs: nowMs })
        .where(eq(positionsTable.id, pos.positionId));
      await executor.insert(pnlRecords).values({
        id: newId(), mode: "live", marketId, positionId: pos.positionId,
        gross6: payout6 - pos.cost6, fees6: pos.fees6, rebates6: 0n, net6,
        meta: { side: pos.side, outcome, shares6: pos.shares6.toString(), exitPolicy: pos.exitPolicy }, createdAtMs: nowMs,
      });
      await this.exposure.reconcile(guard, executor, marketId, nowMs);
    });
    this.positions.delete(marketId);
    this.markClosed(marketId, net6 > 0n ? true : net6 < 0n ? false : null);
    return net6;
  }

  /** Submit a live order and persist it + any immediate fill. Returns success. */
  async submit(args: {
    decisionId: string;
    intentId: string;
    marketId: string;
    tokenId: string;
    outcomeSide: OutcomeSide;
    style: "maker_post_only" | "taker_fak" | "taker_fok";
    price6: Prob6;
    shares6: Shares6;
    stake6: Usdc6;
    tickSize6: Prob6;
    negRisk: boolean;
    expireAtMs?: number;
    idempotencyKey: string;
    exitPolicy?: string;
    nowMs: number;
  }): Promise<{ ok: boolean; orderId: string; status: string; reason?: string }> {
    if (!this.adapter || this.state !== "ARMED") {
      return { ok: false, orderId: "", status: "REJECTED", reason: "not armed" };
    }
    const orderId = newId();
    const req: OrderRequest = {
      idempotencyKey: args.idempotencyKey,
      decisionId: args.decisionId,
      marketId: args.marketId,
      tokenId: args.tokenId,
      outcomeSide: args.outcomeSide,
      orderSide: "BUY",
      style: args.style,
      timeInForce: args.style === "maker_post_only" ? "GTD" : args.style === "taker_fok" ? "FOK" : "FAK",
      postOnly: args.style === "maker_post_only",
      price6: args.price6,
      shares6: args.shares6,
      stake6: args.stake6,
      tickSize6: args.tickSize6,
      negRisk: args.negRisk,
      ...(args.expireAtMs ? { expireAtMs: args.expireAtMs } : {}),
    };

    // External acknowledgement cannot share a database transaction. Commit the
    // guard and durable PENDING intent first; a crash/unknown response retains
    // conservative ownership until reconciliation proves a terminal outcome.
    await this.exposure.transaction(async (guard, executor) => {
      await this.exposure.claimOrder(guard, args.marketId, args.nowMs);
      await executor.insert(ordersTable).values({
        id: orderId, intentId: args.intentId, decisionId: args.decisionId,
        marketId: args.marketId, tokenId: args.tokenId, outcomeSide: args.outcomeSide,
        orderSide: "BUY", style: args.style === "maker_post_only" ? "maker_post_only" : "taker_fak",
        timeInForce: req.timeInForce, postOnly: req.postOnly, price6: args.price6,
        shares6: args.shares6, filledShares6: 0n, stake6: args.stake6, mode: "live", status: "PENDING",
        ...(args.expireAtMs ? { expireAtMs: args.expireAtMs } : {}),
        externalId: null, createdAtMs: args.nowMs, updatedAtMs: args.nowMs,
      });
    });

    const res = await this.adapter.submit(req);
    const status = res.accepted ? res.status : "REJECTED";
    await this.exposure.transaction(async (guard, executor) => {
      await executor.update(ordersTable).set({
        status,
        ...(res.externalId ? { externalId: res.externalId } : {}),
        ...(res.reason ? { statusReason: res.reason } : {}),
        updatedAtMs: args.nowMs,
      }).where(eq(ordersTable.id, orderId));
      if (res.accepted && status === "MATCHED") {
        await executor.insert(orderFills).values({
          id: newId(), orderId, price6: args.price6, shares6: args.shares6, feeUsdc6: 0n,
          maker: args.style === "maker_post_only", tradeRef: res.externalId ?? null, tsMs: args.nowMs,
        });
        await executor.update(ordersTable).set({ filledShares6: args.shares6 }).where(eq(ordersTable.id, orderId));
        await this.applyFill({
          marketId: args.marketId, decisionId: args.decisionId, side: args.outcomeSide,
          shares6: args.shares6, price6: args.price6, fee6: 0n,
          exitPolicy: args.exitPolicy ?? "hold_to_resolution", nowMs: args.nowMs,
        }, executor);
      }
      await this.exposure.reconcile(guard, executor, args.marketId, args.nowMs);
    });
    if (res.accepted && status !== "MATCHED") {
      // resting order: its stake is committed on the exchange — visible to the
      // risk engine as open exposure until it fills, expires or is canceled
      this.restingReserve.set(orderId, { marketId: args.marketId, stake6: args.stake6 });
    }

    return { ok: res.accepted, orderId, status, ...(res.reason ? { reason: res.reason } : {}) };
  }

  async cancelAll(): Promise<number> {
    if (!this.adapter) return 0;
    const r = await this.adapter.cancelAll();
    if (!r.ok) return 0;
    const rows = await this.db.db.select().from(ordersTable).where(and(
      eq(ordersTable.mode, "live"), inArray(ordersTable.status, ["PENDING", "LIVE", "DELAYED", "PARTIAL"]),
    ));
    await this.exposure.transaction(async (guard, executor) => {
      for (const row of rows) {
        await executor.update(ordersTable).set({ status: "CANCELED", statusReason: "live cancel-all acknowledged", updatedAtMs: Date.now() }).where(eq(ordersTable.id, row.id));
        await this.exposure.reconcile(guard, executor, row.marketId, Date.now());
        this.restingReserve.delete(row.id);
      }
    });
    return 1;
  }

  /** Reassert durable ownership after restart; never releases unknown live effects. */
  async reconcileExposureGuards(nowMs: number): Promise<void> {
    const [orders, positions] = await Promise.all([
      this.db.db.select().from(ordersTable).where(eq(ordersTable.mode, "live")),
      this.db.db.select().from(positionsTable).where(eq(positionsTable.mode, "live")),
    ]);
    await this.exposure.transaction(async (_guard, executor) => {
      await this.exposure.reconcileMarkets(executor, [
        ...orders.map((row) => row.marketId), ...positions.map((row) => row.marketId),
      ], nowMs);
    });
  }

  address(): string {
    return this.adapter?.address() ?? "";
  }

  status(nowMs: number): Record<string, unknown> {
    return {
      configured: this.configured,
      state: this.isArmed(nowMs) ? "ARMED" : this.state,
      expiresAtMs: this.expiresAtMs,
      expiresInS: this.state === "ARMED" ? Math.max(0, Math.round((this.expiresAtMs - nowMs) / 1000)) : 0,
      walletAddress: this.address() ? this.address().slice(0, 6) + "…" + this.address().slice(-4) : null,
      liveBankroll6: this.liveBankroll6.toString(),
      openExposure6: this.openExposure6().toString(),
      openPositions: this.livePositionsList().map((p) => ({
        marketId: p.marketId, side: p.side,
        shares6: p.shares6.toString(), cost6: p.cost6.toString(), stake6: p.stake6.toString(),
      })),
      disarmReason: this.disarmReason,
      lastPreflightReasons: this.lastPreflight?.reasons ?? [],
    };
  }
}

/** Minimum USDC to arm: enough for one min-size order plus headroom. */
export function minArmUsdc(): Usdc6 {
  return usdc("5");
}

export function fractionOfLive(bankroll6: Usdc6, fractionPpm: bigint): Usdc6 {
  return mulDiv(bankroll6, fractionPpm, 1_000_000n, "floor");
}
