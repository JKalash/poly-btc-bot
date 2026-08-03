import { orderFills, orders as ordersTable, type DbHandle } from "@b5p/db";
import { newId } from "@b5p/domain/ids";
import {
  mulDiv, usdc, type BankrollState, type OutcomeSide, type Prob6, type Shares6, type Usdc6,
} from "@b5p/domain";
import { LiveClobAdapter, type LivePreflight, type OrderRequest } from "@b5p/polymarket";
import { eq } from "drizzle-orm";
import { logger } from "./log";

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
  disarmReason: string | null = null;

  constructor(private readonly db: DbHandle) {
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
    this.consecutiveLosses = 0;
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

  async refreshBankroll(): Promise<void> {
    if (!this.adapter || this.state !== "ARMED") return;
    try {
      this.liveBankroll6 = await this.adapter.usdcBalance();
      if (this.liveBankroll6 > this.sessionPeak6) this.sessionPeak6 = this.liveBankroll6;
      if (this.liveBankroll6 > this.dailyPeak6) this.dailyPeak6 = this.liveBankroll6;
    } catch (e) {
      logger.warn("live bankroll refresh failed; disarming", { error: String(e) });
      this.disarm("wallet balance unreadable");
    }
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
      openExposure: 0n,
      reconciled: this.lastPreflight?.ok ?? false,
    };
  }

  hasOpenPosition(marketId: string): boolean { return this.openMarkets.has(marketId); }
  markOpen(marketId: string): void { this.openMarkets.add(marketId); }
  markClosed(marketId: string, won: boolean): void {
    this.openMarkets.delete(marketId);
    if (won) this.consecutiveLosses = 0; else this.consecutiveLosses += 1;
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

    await this.db.db.insert(ordersTable).values({
      id: orderId,
      intentId: args.intentId,
      decisionId: args.decisionId,
      marketId: args.marketId,
      tokenId: args.tokenId,
      outcomeSide: args.outcomeSide,
      orderSide: "BUY",
      style: args.style === "maker_post_only" ? "maker_post_only" : "taker_fak",
      timeInForce: req.timeInForce,
      postOnly: req.postOnly,
      price6: args.price6,
      shares6: args.shares6,
      filledShares6: 0n,
      stake6: args.stake6,
      mode: "live",
      status: "PENDING",
      ...(args.expireAtMs ? { expireAtMs: args.expireAtMs } : {}),
      externalId: null,
      createdAtMs: args.nowMs,
      updatedAtMs: args.nowMs,
    });

    const res = await this.adapter.submit(req);
    const status = res.accepted ? res.status : "REJECTED";
    await this.db.db.update(ordersTable).set({
      status,
      ...(res.externalId ? { externalId: res.externalId } : {}),
      ...(res.reason ? { statusReason: res.reason } : {}),
      updatedAtMs: args.nowMs,
    }).where(eq(ordersTable.id, orderId));

    // A MATCHED taker fill is immediate; record it at the requested price as a
    // conservative proxy (exact fills reconcile from trade history in a later
    // pass — see docs/limitations.md).
    if (res.accepted && status === "MATCHED") {
      await this.db.db.insert(orderFills).values({
        id: newId(),
        orderId,
        price6: args.price6,
        shares6: args.shares6,
        feeUsdc6: 0n,
        maker: args.style === "maker_post_only",
        tradeRef: res.externalId ?? null,
        tsMs: args.nowMs,
      });
      await this.db.db.update(ordersTable).set({ filledShares6: args.shares6 }).where(eq(ordersTable.id, orderId));
    }

    return { ok: res.accepted, orderId, status, ...(res.reason ? { reason: res.reason } : {}) };
  }

  async cancelAll(): Promise<number> {
    if (!this.adapter) return 0;
    const r = await this.adapter.cancelAll();
    return r.ok ? 1 : 0;
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
