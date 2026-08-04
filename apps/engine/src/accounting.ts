import type { AppConfig } from "@b5p/config";
import {
  bankrollSnapshots, marketExposureGuards, pnlRecords, positions as positionsTable, tradingSessions, type Db, type DbHandle,
} from "@b5p/db";
import { newId } from "@b5p/domain/ids";
import {
  mulDiv, PPM, usdc, type BankrollState, type Mode, type OutcomeSide, type Usdc6,
} from "@b5p/domain";
import { and, desc, eq, gte } from "drizzle-orm";
import { logger } from "./log";
import { DirectionalExposureCoordinator } from "./directional-exposure-guard";

interface OpenPosition {
  id: string;
  marketId: string;
  decisionId: string | null;
  side: OutcomeSide;
  shares6: bigint;
  cost6: Usdc6;
  fees6: Usdc6;
  stake6: Usdc6;
  exitPolicy: string;
  openedAtMs: number;
}

/**
 * Paper accounting: simulated bankroll, session/daily peaks, consecutive
 * losses, open exposure. All amounts exact micro-USDC. Persisted so restarts
 * reconcile from the database, not from memory.
 */
export class Accounting {
  bankroll: Usdc6 = 0n;
  startingBankroll: Usdc6 = 0n;
  /** Bankroll at session start (reconcile time) — baseline for session P&L. */
  sessionStartBankroll: Usdc6 = 0n;
  sessionPeak: Usdc6 = 0n;
  dailyPeak: Usdc6 = 0n;
  consecutiveLosses = 0;
  sessionId = "";
  private dailyPeakDay = "";
  private open = new Map<string, OpenPosition>(); // marketId -> position
  private readonly exposure: DirectionalExposureCoordinator;
  reconciled = false;

  constructor(
    private readonly db: DbHandle,
    private readonly mode: Mode,
  ) {
    this.exposure = new DirectionalExposureCoordinator(db);
  }

  /** Reload open positions and bankroll from the database (restart reconciliation). */
  async reconcile(cfg: AppConfig, nowMs: number): Promise<void> {
    const rows = await this.db.db.select().from(positionsTable).where(eq(positionsTable.status, "OPEN"));
    this.open.clear();
    for (const r of rows) {
      if (r.mode !== this.mode) continue;
      this.open.set(r.marketId, {
        id: r.id,
        marketId: r.marketId,
        decisionId: r.decisionId,
        side: r.outcomeSide as OutcomeSide,
        shares6: r.shares6,
        cost6: r.cost6,
        fees6: r.fees6,
        stake6: r.stake6,
        exitPolicy: r.exitPolicy,
        openedAtMs: r.openedAtMs,
      });
    }
    const latest = (await this.db.db.select().from(bankrollSnapshots)
      .where(eq(bankrollSnapshots.mode, this.mode))
      .orderBy(desc(bankrollSnapshots.tsMs)).limit(1))[0];
    this.startingBankroll = usdc(cfg.risk.starting_paper_bankroll_usdc);
    this.bankroll = latest ? latest.bankroll6 : this.startingBankroll;
    this.sessionStartBankroll = this.bankroll;
    this.sessionPeak = this.bankroll;
    this.dailyPeakDay = utcDay(nowMs);
    // The loss stops must survive restarts (spec: no automatic re-arming).
    // consecutiveLosses carries over from the latest persisted session; the
    // daily peak is the UTC-day's true maximum from bankroll snapshots — NOT
    // the current bankroll, which would grant a fresh daily loss budget
    // measured from the post-loss level after every deploy.
    const prev = (await this.db.db.select().from(tradingSessions)
      .where(eq(tradingSessions.mode, this.mode))
      .orderBy(desc(tradingSessions.startedAtMs)).limit(1))[0];
    this.consecutiveLosses = prev?.consecutiveLosses ?? 0;
    const dayStartMs = Date.parse(`${this.dailyPeakDay}T00:00:00Z`);
    const daySnaps = await this.db.db.select({ bankroll6: bankrollSnapshots.bankroll6 }).from(bankrollSnapshots)
      .where(and(eq(bankrollSnapshots.mode, this.mode), gte(bankrollSnapshots.tsMs, dayStartMs)));
    let dayPeak = this.bankroll;
    for (const s of daySnaps) {
      if (s.bankroll6 > dayPeak) dayPeak = s.bankroll6;
    }
    this.dailyPeak = dayPeak;
    this.sessionId = newId();
    await this.db.db.insert(tradingSessions).values({
      id: this.sessionId,
      mode: this.mode,
      startedAtMs: nowMs,
      startingBankroll6: this.bankroll,
      peakBankroll6: this.bankroll,
      realized6: 0n,
      consecutiveLosses: this.consecutiveLosses,
    });
    const existingGuards = await this.db.db.select().from(marketExposureGuards);
    await this.exposure.transaction(async (_guard, executor) => {
      await this.exposure.reconcileMarkets(executor, [
        ...this.open.keys(),
        ...existingGuards.filter((row) => row.releasedAtMs === null && row.ownerKind !== "PAIR_GROUP").map((row) => row.marketId),
      ], nowMs);
    });
    this.reconciled = true;
    logger.info("accounting reconciled", { mode: this.mode, bankroll: this.bankroll, openPositions: this.open.size });
  }

  state(): BankrollState {
    let exposure = 0n;
    for (const p of this.open.values()) exposure += p.stake6;
    return {
      bankroll: this.bankroll,
      sessionPeak: this.sessionPeak,
      dailyPeak: this.dailyPeak,
      sessionRealized: this.bankroll - this.sessionPeak,
      dailyRealized: this.bankroll - this.dailyPeak,
      consecutiveLosses: this.consecutiveLosses,
      openPositions: this.open.size,
      openExposure: exposure,
      reconciled: this.reconciled,
    };
  }

  hasOpenPosition(marketId: string): boolean {
    return this.open.has(marketId);
  }

  openPositionsList(): OpenPosition[] {
    return [...this.open.values()];
  }

  /** Operator manual re-arm: clears the consecutive-loss stop (never automatic). */
  async resetLossStop(): Promise<void> {
    this.consecutiveLosses = 0;
    if (this.sessionId) {
      await this.db.db.update(tradingSessions)
        .set({ consecutiveLosses: 0 })
        .where(eq(tradingSessions.id, this.sessionId));
    }
  }

  rollDay(nowMs: number): void {
    const day = utcDay(nowMs);
    if (day !== this.dailyPeakDay) {
      this.dailyPeakDay = day;
      this.dailyPeak = this.bankroll;
    }
  }

  /** Record a fill: creates/extends the open position and deducts cost+fee from bankroll. */
  async onFill(args: {
    marketId: string;
    decisionId: string | null;
    side: OutcomeSide;
    shares6: bigint;
    price6: bigint;
    fee6: Usdc6;
    stake6: Usdc6;
    exitPolicy: string;
    nowMs: number;
  }, executor?: Db): Promise<void> {
    if (executor !== undefined) return this.persistFill(args, executor);
    await this.exposure.transaction(async (_guard, tx) => this.persistFill(args, tx));
  }

  private async persistFill(args: {
    marketId: string;
    decisionId: string | null;
    side: OutcomeSide;
    shares6: bigint;
    price6: bigint;
    fee6: Usdc6;
    stake6: Usdc6;
    exitPolicy: string;
    nowMs: number;
  }, executor: Db): Promise<void> {
    const cost6 = mulDiv(args.shares6, args.price6, 1_000_000n, "ceil");
    const previousBankroll = this.bankroll;
    const previous = this.open.get(args.marketId);
    const previousPosition = previous === undefined ? undefined : { ...previous };
    this.bankroll -= cost6 + args.fee6;
    let pos = this.open.get(args.marketId);
    try {
      if (!pos) {
        pos = {
          id: newId(), marketId: args.marketId, decisionId: args.decisionId, side: args.side,
          shares6: 0n, cost6: 0n, fees6: 0n, stake6: 0n,
          exitPolicy: args.exitPolicy, openedAtMs: args.nowMs,
        };
        this.open.set(args.marketId, pos);
        await executor.insert(positionsTable).values({
          id: pos.id, marketId: pos.marketId, decisionId: pos.decisionId, mode: this.mode,
          outcomeSide: pos.side, shares6: 0n, avgPrice6: 0n, cost6: 0n, fees6: 0n,
          stake6: 0n, exitPolicy: pos.exitPolicy, status: "OPEN", openedAtMs: pos.openedAtMs,
        });
      }
      pos.shares6 += args.shares6;
      pos.cost6 += cost6;
      pos.fees6 += args.fee6;
      pos.stake6 += cost6 + args.fee6;
      const avg = pos.shares6 > 0n ? mulDiv(pos.cost6, 1_000_000n, pos.shares6, "half-even") : 0n;
      await executor.update(positionsTable)
        .set({ shares6: pos.shares6, cost6: pos.cost6, fees6: pos.fees6, stake6: pos.stake6, avgPrice6: avg })
        .where(eq(positionsTable.id, pos.id));
      await executor.insert(bankrollSnapshots).values({
        mode: this.mode, bankroll6: this.bankroll, basis: "paper_fill", tsMs: args.nowMs,
      });
      await this.exposure.reconcileMarkets(executor, [args.marketId], args.nowMs);
    } catch (error) {
      this.bankroll = previousBankroll;
      if (previousPosition === undefined) this.open.delete(args.marketId);
      else this.open.set(args.marketId, previousPosition);
      throw error;
    }
  }

  /** Resolve a position: winner pays 1 per share. Returns net pnl. */
  async onResolution(marketId: string, outcome: OutcomeSide, nowMs: number): Promise<Usdc6 | null> {
    const pos = this.open.get(marketId);
    if (!pos) return null;
    const payout6: Usdc6 = pos.side === outcome ? pos.shares6 : 0n; // 1 USDC per share
    const net6 = payout6 - pos.cost6 - pos.fees6;
    this.bankroll += payout6;
    if (this.bankroll > this.sessionPeak) this.sessionPeak = this.bankroll;
    if (this.bankroll > this.dailyPeak) this.dailyPeak = this.bankroll;
    if (net6 < 0n) this.consecutiveLosses += 1;
    else if (net6 > 0n) this.consecutiveLosses = 0;

    this.open.delete(marketId);
    await this.exposure.transaction(async (_guard, executor) => {
      await executor.update(positionsTable)
        .set({ status: "RESOLVED", outcome, pnl6: net6, resolvedAtMs: nowMs })
        .where(eq(positionsTable.id, pos.id));
      await executor.insert(pnlRecords).values({
        id: newId(), mode: this.mode, marketId, positionId: pos.id,
        gross6: payout6 - pos.cost6, fees6: pos.fees6, rebates6: 0n, net6,
        meta: { side: pos.side, outcome, shares6: pos.shares6.toString(), exitPolicy: pos.exitPolicy }, createdAtMs: nowMs,
      });
      await executor.insert(bankrollSnapshots).values({
        mode: this.mode, bankroll6: this.bankroll, basis: "paper_resolution", tsMs: nowMs,
      });
      await executor.update(tradingSessions)
        .set({ peakBankroll6: this.sessionPeak, realized6: this.bankroll - this.sessionStartBankroll, consecutiveLosses: this.consecutiveLosses })
        .where(eq(tradingSessions.id, this.sessionId));
      await this.exposure.reconcileMarkets(executor, [marketId], nowMs);
    });
    return net6;
  }

  /**
   * Paper sizing simulations (gist integration). Only meaningful when the
   * paper_exploration profile is active; other profiles use the risk engine's
   * stake. gist_degen exists to DEMONSTRATE ruin on simulated money.
   */
  simulatedStake(cfg: AppConfig, profileStake6: Usdc6): { stake6: Usdc6; mode: string; note: string | null } {
    const sim = cfg.paper.sizing_simulation;
    if (cfg.risk.profile !== "paper_exploration" && sim !== "profile") {
      return { stake6: profileStake6, mode: "profile", note: `sizing_simulation '${sim}' ignored: risk profile is ${cfg.risk.profile}` };
    }
    switch (sim) {
      case "profile":
        return { stake6: profileStake6, mode: sim, note: null };
      case "fixed_stake":
        return { stake6: minU(usdc(cfg.risk.paper_stake_usdc), this.bankroll), mode: sim, note: null };
      case "gist_safe":
        return { stake6: mulDiv(this.bankroll, 250_000n, PPM, "floor"), mode: sim, note: "gist 'safe': 25% of simulated bankroll — far above the 10% live safety cap" };
      case "gist_aggressive": {
        const profits = this.bankroll - this.startingBankroll;
        return profits > 0n
          ? { stake6: profits, mode: sim, note: "gist 'aggressive': betting all profits above principal" }
          : { stake6: 0n, mode: sim, note: "gist 'aggressive': no profits above principal — no trade" };
      }
      case "gist_degen":
        return { stake6: this.bankroll, mode: sim, note: "gist 'degen': ENTIRE simulated bankroll — this is a ruin demonstration, not a strategy" };
    }
  }
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function minU(a: Usdc6, b: Usdc6): Usdc6 {
  return a < b ? a : b;
}
