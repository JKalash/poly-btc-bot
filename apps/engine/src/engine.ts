import { DEFAULT_CONFIG, type AppConfig } from "@b5p/config";
import {
  auditEvents, configVersions, decisionSnapshots, engineKv, featureSnapshots, healthEvents,
  killSwitchEvents, marketRuleSnapshots, markets as marketsTable, orderIntents, orders,
  referencePriceTicks, resolutions, riskDecisions, signalCandidates, strategyPromotionDecisions,
  type DbHandle,
} from "@b5p/db";
import {
  ENGINE_TRANSITIONS, MARKET_TRANSITIONS, canTransition, makerEdgeSatisfied, parseFixed,
  ppm, prob, roundSharesToLot, sharesForStake, shares as sharesOf, usdc,
  type EngineState, type ExecutionMode, type MarketInstanceState, type MarketRef, type Mode,
  type OutcomeSide, type Ppm, type Prob6, type ReferenceTick, type Usdc6,
} from "@b5p/domain";
import { idempotencyKey, newId, sha256Hex } from "@b5p/domain/ids";
import { LiquidityRewardLedger, RebateLedger } from "./accruals";
import { resolveExecutionResearchConfig, type ResolvedExecutionResearchConfig } from "./execution-constants";
import { ExecutionGuardRegistry } from "./execution-invariants";
import { ExecutionPersistence } from "./execution-persistence";
import { ExecutionTimeline, durationUs, monotonicNs } from "./execution-timeline";
import {
  PairedCycleSimulator, resolveInventoryResearchConfig, type ResolvedInventoryResearchConfig,
} from "./inventory-cycle";
import { InventoryPersistence } from "./inventory-persistence";
import { FillCounterfactualRecorder, MarkoutSampler } from "./markout";
import { PaperVariantEngine } from "./paper-variants";
import type { ParsedFiveMinMarket } from "@b5p/polymarket";
import {
  DEFAULT_INVENTORY_RISK_LIMITS, evaluateOrderRisk, governanceForMode, RISK_PROFILES, clampCustomProfile,
  type GovernancePromotionSummary, type InventoryRiskLimits, type RiskContext,
} from "@b5p/risk";
import {
  BookState, MODELS, STRATEGY_PRESETS, TickBuffer, computeFeatures, computeIndicators,
  configureCalibratedModel, presetAllowsMode,
  type Candle, type ExtendedMoveFadePriorRun, type FeatureSet, type PresetContext, type StrategyDecision,
} from "@b5p/strategy";
import { eq } from "drizzle-orm";
import { Accounting } from "./accounting";
import { CHANNELS, type Bus } from "./bus";
import { LiveController, minArmUsdc, type ArmRequest } from "./live";
import { logger } from "./log";
import { PaperExecutor, type FillEvent, type PaperOrderRecord } from "./paper";
import { ENGINE_VERSION, buildDecisionSnapshot } from "./snapshot";

interface MarketRuntime {
  ref: MarketRef;
  tickSize6: Prob6;
  minOrderShares6: bigint;
  fee: { ratePpm: Ppm; rebateRatePpm: Ppm; takerOnly: boolean; feeType: string | null } | null;
  rulesVerified: boolean;
  rulesHash: string;
  resolutionSource: string;
  state: MarketInstanceState;
  priceToBeat: { text: string; float: number; capturedAtMs: number; source: string } | null;
  ptbConsistent: boolean;
  officialOutcome: OutcomeSide | null;
  localOutcome: OutcomeSide | null;
  finalValueText: string | null;
  resolveWarned: boolean;
  lastEval: { f: FeatureSet; gate: StrategyDecision; estVersion: string | null } | null;
  lastDecisionAtMs: number;
  lastRejectionReasons: Array<{ code: string; message: string }>;
}

const DECISION_COOLDOWN_MS = 5000;
const RESOLUTION_GRACE_MS = 3000;
const MIN_DATA_QUALITY = 0.7;
const PTB_TOLERANCE_BPS = 1;

export class Engine {
  readonly chainlink = new TickBuffer();
  readonly binance = new TickBuffer();
  private candles: Candle[] = [];
  private candlesUpdatedAtMs = 0;
  readonly books = new Map<string, BookState>();
  readonly markets = new Map<string, MarketRuntime>();
  private clockSamples: number[] = [];
  engineState: EngineState = "BOOTING";
  private haltReason: string | null = null;
  accounting: Accounting;
  paper: PaperExecutor;
  live: LiveController;
  cfg: AppConfig = DEFAULT_CONFIG;
  configVersion = 0;
  private lastCockpitPublish = 0;
  private usedIdempotencyKeys = new Set<string>();
  private tickPersistQueue: ReferenceTick[] = [];
  private lastFeaturePersistMs = 0;
  private lastLiveRefreshMs = 0;
  private stopped = false;
  private unsubscribeControl: (() => void) | null = null;

  // --- execution-quality instrumentation (plan items 1b/1c) ---
  readonly execPersistence: ExecutionPersistence;
  readonly execTimeline: ExecutionTimeline;
  readonly execGuards = new ExecutionGuardRegistry();
  readonly markouts: MarkoutSampler;
  readonly counterfactuals: FillCounterfactualRecorder;
  readonly paperVariants: PaperVariantEngine;
  /** intentId -> correlation metadata for timeline threading. */
  private intentMeta = new Map<string, { correlationId: string; decisionId: string; marketId: string }>();
  private marketIntents = new Map<string, string[]>();
  private execCfgCache: { version: number; value: ResolvedExecutionResearchConfig } | null = null;
  private livePromotion: GovernancePromotionSummary | null = null;

  // --- R10 paired-cycle inventory research (Phase 3; PAPER/SHADOW ONLY, OFF by default) ---
  readonly inventoryPersistence: InventoryPersistence;
  readonly rebateLedger: RebateLedger;
  readonly rewardLedger: LiquidityRewardLedger;
  /** null in observe mode; never constructed for live (no live MM adapter exists). */
  readonly inventorySim: PairedCycleSimulator | null;
  private invCfgCache: { version: number; value: ResolvedInventoryResearchConfig } | null = null;

  constructor(
    readonly db: DbHandle,
    readonly bus: Bus,
    readonly mode: Exclude<Mode, "live">,
  ) {
    this.accounting = new Accounting(db, mode);
    this.live = new LiveController(db); // boots DISARMED; only active if a hot-wallet key is configured
    this.paper = new PaperExecutor(
      db,
      () => this.activeFeeRate(),
      () => this.cfg.paper.fee_collection_convention,
      async (fill) => {
        const rt = this.markets.get(fill.order.marketId);
        await this.accounting.onFill({
          marketId: fill.order.marketId,
          decisionId: fill.order.decisionId,
          side: fill.order.outcomeSide,
          shares6: fill.shares6,
          price6: fill.price6,
          fee6: fill.fee6,
          stake6: fill.order.stakeCap6,
          exitPolicy: fill.order.exitPolicy,
          nowMs: fill.tsMs,
        });
        if (rt) this.transitionMarket(rt, fill.order.filled6 >= fill.order.shares6 ? "FILLED" : "PARTIAL");
        await this.audit("order", "fill", { orderId: fill.order.id, shares: fill.shares6, price: fill.price6, maker: fill.maker });
        this.emitEvent({ type: "fill", orderId: fill.order.id, marketId: fill.order.marketId });
        this.observePaperFill(fill);
      },
      (tokenId) => this.books.get(tokenId) ?? null,
    );

    this.execPersistence = new ExecutionPersistence(db);
    this.execTimeline = new ExecutionTimeline(this.execPersistence, () => this.configVersion);
    this.markouts = new MarkoutSampler(
      this.execPersistence,
      (tokenId) => this.books.get(tokenId) ?? null,
      () => this.execCfg().markoutHorizonsMs,
      () => this.configVersion,
    );
    this.counterfactuals = new FillCounterfactualRecorder(
      this.execPersistence,
      () => this.configVersion,
      () => this.execCfg().recordFillCounterfactuals,
    );
    this.paperVariants = new PaperVariantEngine(
      this.execPersistence,
      () => this.execCfg().stress,
      () => this.configVersion,
    );
    this.paper.hooks = {
      onActivated: (o, nowMs) => this.onPaperActivated(o, nowMs),
      onQueueChanged: (o, consumed6, tsMs) => this.onPaperQueueChanged(o, consumed6, tsMs),
      onFinished: (o, status, reason, nowMs) => this.onPaperFinished(o, status, reason, nowMs),
    };

    // R10 paired-cycle simulation: buffered persistence + separate accrual
    // ledgers (rebates vs liquidity rewards — never merged; realized only at
    // PAID). The simulator exists only for paper/shadow; there is NO live
    // construction path (and the simulator itself refuses any other mode).
    this.inventoryPersistence = new InventoryPersistence(db);
    this.rebateLedger = new RebateLedger((e) => this.inventoryPersistence.upsertRebate(e), () => this.configVersion);
    this.rewardLedger = new LiquidityRewardLedger((e) => this.inventoryPersistence.upsertReward(e), () => this.configVersion);
    this.inventorySim = mode === "observe" ? null : new PairedCycleSimulator({
      mode,
      sink: this.inventoryPersistence,
      books: (tokenId) => this.books.get(tokenId) ?? null,
      cfg: () => this.invCfg(),
      configVersion: () => this.configVersion,
      rebates: this.rebateLedger,
      rewards: this.rewardLedger,
      bankroll6: () => this.accounting.state().bankroll,
      riskLimits: () => this.inventoryRiskLimits(),
      // Rejection codes from @b5p/risk evaluateInventoryRisk are persisted
      // durably (audit_events.data) with the cycle/market correlation.
      onRiskRejection: (rej) => {
        void this.audit("inventory", "cycle_risk_rejected", {
          cycleId: rej.cycleId, marketId: rej.marketId, phase: rej.phase,
          codes: rej.codes, reasons: rej.reasons, tsMs: rej.tsMs,
        });
      },
    });
  }

  private invCfg(): ResolvedInventoryResearchConfig {
    if (this.invCfgCache?.version !== this.configVersion) {
      // Single source of truth: the one-leg/unhedged budgets come from
      // inventory_risk; inventory_research carries only simulation knobs.
      const invRisk = (this.cfg as {
        inventory_risk?: { max_one_leg_duration_ms?: number; max_unhedged_risk_fraction?: string };
      }).inventory_risk;
      const rawResearch = (this.cfg as { inventory_research?: Record<string, unknown> }).inventory_research;
      const value = resolveInventoryResearchConfig({
        ...this.cfg,
        inventory_research: {
          ...rawResearch,
          ...(invRisk?.max_one_leg_duration_ms !== undefined
            ? { max_one_leg_seconds: Math.floor(invRisk.max_one_leg_duration_ms / 1000) }
            : {}),
          ...(invRisk?.max_unhedged_risk_fraction !== undefined
            ? { max_unhedged_risk_fraction: invRisk.max_unhedged_risk_fraction }
            : {}),
        },
      } as typeof this.cfg);
      if (value.clamped.length > 0) {
        logger.warn("inventory_research config keys clamped to safe values", { clamped: value.clamped });
      }
      this.invCfgCache = { version: this.configVersion, value };
    }
    return this.invCfgCache.value;
  }

  /** Agent K inventory limits, with the duration/fraction budgets synced to the resolved config. */
  private inventoryRiskLimits(): InventoryRiskLimits {
    const inv = this.invCfg();
    return {
      ...DEFAULT_INVENTORY_RISK_LIMITS,
      maxUnhedgedRiskFractionPpm: inv.maxUnhedgedRiskFractionPpm,
      maxOneLegDurationMs: inv.maxOneLegSeconds * 1000,
    };
  }

  private execCfg(): ResolvedExecutionResearchConfig {
    if (this.execCfgCache?.version !== this.configVersion) {
      this.execCfgCache = { version: this.configVersion, value: resolveExecutionResearchConfig(this.cfg) };
    }
    return this.execCfgCache.value;
  }

  // ---------- lifecycle ----------

  async start(nowMs: number): Promise<void> {
    await this.loadConfig();
    this.transitionEngine("RECONCILING", "boot");
    const orphans = await this.paper.reconcileOrphans(nowMs);
    if (orphans > 0) await this.health("warning", "reconcile", `${orphans} orphaned resting order(s) canceled on restart`);
    await this.accounting.reconcile(this.cfg, nowMs);
    const target: EngineState = this.mode === "observe" ? "READ_ONLY" : this.mode === "paper" ? "PAPER" : "SHADOW";
    this.transitionEngine(target, "startup complete");
    await this.audit("engine", "start", { mode: this.mode, engineVersion: ENGINE_VERSION });
    this.unsubscribeControl = this.bus.subscribe(CHANNELS.control, (payload) => {
      if (!this.stopped) void this.onControl(payload, Date.now());
    });
  }

  async loadConfig(): Promise<void> {
    let rows = await this.db.db.select().from(configVersions).where(eq(configVersions.active, true));
    if (rows.length === 0) {
      await this.db.db.insert(configVersions).values({
        config: DEFAULT_CONFIG,
        actor: "engine:bootstrap",
        active: true,
        changedPaths: [],
        createdAtMs: Date.now(),
      });
      rows = await this.db.db.select().from(configVersions).where(eq(configVersions.active, true));
    }
    const row = rows.sort((a, b) => b.version - a.version)[0]!;
    this.cfg = row.config as AppConfig;
    this.configVersion = row.version;
    configureCalibratedModel({
      artifactPath: this.cfg.strategy.calibrated_artifact_path ?? null,
      promotionPath: this.cfg.strategy.promotion_decision_path ?? null,
    });
    await this.loadLivePromotion();
  }

  /**
   * Latest active LIVE promotion decision for the active strategy — consumed by
   * governanceForMode() so the strategy-validated gate reflects persisted
   * promotion evidence rather than a hardcoded flag.
   */
  private async loadLivePromotion(): Promise<void> {
    try {
      const rows = await this.db.db.select().from(strategyPromotionDecisions)
        .where(eq(strategyPromotionDecisions.strategyVersion, this.cfg.strategy.active_version));
      const live = rows
        .filter((r) => r.mode === "live" && r.active)
        .sort((a, b) => b.decidedAtMs - a.decidedAtMs)[0] ?? null;
      this.livePromotion = live ? { approved: live.approved, active: live.active, mode: live.mode } : null;
    } catch {
      this.livePromotion = null; // fail closed: no promotion evidence -> not validated for live
    }
  }

  private async onControl(payload: unknown, nowMs: number): Promise<void> {
    const msg = payload as { type?: string; reason?: string; actor?: string; acknowledgement?: string; ttlMinutes?: number; replyChannel?: string };
    switch (msg.type) {
      case "kill": {
        await this.db.db.insert(killSwitchEvents).values({
          id: newId(), scope: "engine", reason: msg.reason ?? "operator", actor: msg.actor ?? "operator", createdAtMs: nowMs,
        });
        this.live.disarm(`kill switch: ${msg.reason ?? "operator"}`);
        await this.halt(`kill switch: ${msg.reason ?? "operator"}`, nowMs);
        break;
      }
      case "arm": {
        const req: ArmRequest = {
          acknowledgement: msg.acknowledgement ?? "",
          ttlMinutes: msg.ttlMinutes ?? this.cfg.live.arming_token_ttl_minutes,
          minUsdc: minArmUsdc(),
        };
        const result = await this.live.arm(req, nowMs);
        await this.audit("live", result.ok ? "armed" : "arm_rejected", { actor: msg.actor ?? "operator", reasons: result.reasons, wallet: result.walletAddress });
        this.emitEvent({ type: "arm_result", ...result });
        if (result.ok) await this.health("warning", "live", `LIVE TRADING ARMED by ${msg.actor ?? "operator"} until ${new Date(result.expiresAtMs ?? nowMs).toISOString()}`);
        break;
      }
      case "disarm": {
        this.live.disarm(`operator: ${msg.reason ?? "manual disarm"}`);
        await this.paper.cancelAll("disarm", nowMs).catch(() => 0);
        if (this.live.configured) await this.live.cancelAll().catch(() => 0);
        await this.audit("live", "disarmed", { actor: msg.actor ?? "operator", reason: msg.reason });
        this.emitEvent({ type: "disarmed", reason: msg.reason ?? "manual" });
        break;
      }
      case "resume": {
        if (this.engineState === "HALTED") {
          this.haltReason = null;
          this.transitionEngine("RECONCILING", "operator resume");
          const target: EngineState = this.mode === "observe" ? "READ_ONLY" : this.mode === "paper" ? "PAPER" : "SHADOW";
          this.transitionEngine(target, "operator resume");
          await this.audit("engine", "resume", { actor: msg.actor ?? "operator" });
        }
        break;
      }
      case "config_reload": {
        await this.loadConfig();
        await this.audit("config", "reload", { version: this.configVersion });
        break;
      }
    }
  }

  async halt(reason: string, nowMs: number): Promise<void> {
    if (this.engineState === "HALTED") return;
    this.haltReason = reason;
    this.live.disarm(`halt: ${reason}`); // any halt condition disarms live immediately
    this.transitionEngine("HALTED", reason);
    if (this.live.configured) await this.live.cancelAll().catch(() => 0);
    const canceled = await this.paper.cancelAll(`halt: ${reason}`, nowMs);
    await this.health("critical", "halt", reason, { canceledOrders: canceled });
    await this.audit("engine", "halt", { reason });
    this.emitEvent({ type: "halt", reason });
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribeControl?.();
    this.unsubscribeControl = null;
  }

  // ---------- data ingestion (called by adapters or tests) ----------

  onReferenceTick(t: ReferenceTick): void {
    (t.source === "chainlink" ? this.chainlink : this.binance).push(t);
    this.tickPersistQueue.push(t);
  }

  onClockSample(skewMs: number): void {
    this.clockSamples.push(skewMs);
    if (this.clockSamples.length > 120) this.clockSamples.splice(0, this.clockSamples.length - 120);
  }

  /**
   * Clock-skew estimate from RTDS envelope timestamps. Each sample is
   * (serverTs - receiveTs) = -(one-way latency) - clockOffset, so the sample
   * CLOSEST TO ZERO (least latency contamination) best approximates -offset.
   * Median would report pipeline latency as "drift" and wrongly trip the gate.
   */
  clockSkewMs(): number | null {
    if (this.clockSamples.length < 5) return null;
    let best = this.clockSamples[0]!;
    for (const s of this.clockSamples) if (Math.abs(s) < Math.abs(best)) best = s;
    return best;
  }

  onCandles(c: Candle[]): void {
    this.candles = c;
    this.candlesUpdatedAtMs = Date.now();
  }

  bookFor(tokenId: string): BookState {
    let b = this.books.get(tokenId);
    if (!b) { b = new BookState(tokenId); this.books.set(tokenId, b); }
    return b;
  }

  onBookSnapshot(tokenId: string, bids: Array<{ price: string; size: string }>, asks: Array<{ price: string; size: string }>, sourceTsMs: number, receivedTsMs: number): void {
    this.bookFor(tokenId).applySnapshot(bids, asks, sourceTsMs, receivedTsMs);
  }

  onPriceChange(tokenId: string, price: string, size: string, side: "BUY" | "SELL", sourceTsMs: number, receivedTsMs: number): void {
    this.bookFor(tokenId).applyLevelUpdate(price, size, side, sourceTsMs, receivedTsMs);
  }

  async onTrade(tokenId: string, price: string, size: string, sourceTsMs: number): Promise<void> {
    this.bookFor(tokenId).applyTrade(price, sourceTsMs);
    await this.paper.onTrade(tokenId, prob(price), sharesOf(size), sourceTsMs, this.cfg.paper.queue_model);
    this.counterfactuals.onTrade(tokenId, prob(price), sharesOf(size), sourceTsMs);
  }

  // ---------- discovery ----------

  async upsertDiscoveredMarkets(parsed: ParsedFiveMinMarket[], nowMs: number): Promise<void> {
    for (const p of parsed) {
      const existing = this.markets.get(p.marketId);
      if (existing) {
        // refresh official outcome for cross-checking
        if (p.closed && p.outcomePrices) {
          const [upP, downP] = p.outcomePrices;
          existing.officialOutcome = upP > 0.99 ? "UP" : downP > 0.99 ? "DOWN" : null;
          await this.crossCheckResolution(existing, nowMs);
        }
        continue;
      }
      if (!p.upTokenId || !p.downTokenId) continue; // not yet activated
      const rulesHash = sha256Hex(`${p.description}|${p.resolutionSource}`);
      const rulesVerified = this.cfg.market.rules_must_name_chainlink ? p.rulesNameChainlink : true;
      const rt: MarketRuntime = {
        ref: {
          marketId: p.marketId,
          eventId: p.eventId,
          conditionId: p.conditionId,
          slug: p.slug,
          upTokenId: p.upTokenId,
          downTokenId: p.downTokenId,
          startEpoch: p.startEpoch,
          endEpoch: p.endEpoch,
        },
        tickSize6: prob(p.tickSize.toFixed(6)),
        minOrderShares6: sharesOf(String(p.minOrderSize)),
        fee: p.feeSchedule
          ? {
              ratePpm: ppm(p.feeSchedule.rate.toFixed(6)),
              rebateRatePpm: ppm(p.feeSchedule.rebateRate.toFixed(6)),
              takerOnly: p.feeSchedule.takerOnly,
              feeType: p.feeSchedule.feeType,
            }
          : null,
        rulesVerified,
        rulesHash,
        resolutionSource: p.resolutionSource,
        state: "DISCOVERED",
        priceToBeat: null,
        ptbConsistent: true,
        officialOutcome: null,
        localOutcome: null,
        finalValueText: null,
        resolveWarned: false,
        lastEval: null,
        lastDecisionAtMs: 0,
        lastRejectionReasons: [],
      };
      this.markets.set(p.marketId, rt);
      await this.db.db.insert(marketsTable).values({
        id: p.marketId,
        eventId: p.eventId,
        conditionId: p.conditionId,
        slug: p.slug,
        question: p.question,
        upTokenId: p.upTokenId,
        downTokenId: p.downTokenId,
        startEpoch: p.startEpoch,
        endEpoch: p.endEpoch,
        rulesText: p.description,
        rulesHash,
        resolutionSource: p.resolutionSource,
        rulesNameChainlink: p.rulesNameChainlink,
        tickSize6: rt.tickSize6,
        minOrderShares6: rt.minOrderShares6,
        negRisk: p.negRisk,
        status: "DISCOVERED",
        raw: p.raw,
        discoveredAtMs: nowMs,
        updatedAtMs: nowMs,
      }).onConflictDoNothing();
      await this.db.db.insert(marketRuleSnapshots).values({
        id: newId(), marketId: p.marketId, rulesText: p.description, rulesHash,
        resolutionSource: p.resolutionSource, capturedAtMs: nowMs,
      });
      if (!rulesVerified) {
        await this.health("critical", "rules", `market ${p.slug} rules do not name the Chainlink BTC stream; entries blocked`, { slug: p.slug });
      }
      this.emitEvent({ type: "market_discovered", slug: p.slug });
    }
  }

  /** Token ids the CLOB WS should subscribe to (active + next windows). */
  subscriptionTokens(nowSec: number): string[] {
    const tokens: string[] = [];
    for (const rt of this.markets.values()) {
      if (rt.ref.endEpoch >= nowSec - 60) {
        tokens.push(rt.ref.upTokenId, rt.ref.downTokenId);
      }
    }
    return tokens;
  }

  // ---------- main loop ----------

  async step(nowMs: number): Promise<void> {
    if (this.stopped) return;
    this.accounting.rollDay(nowMs);
    await this.persistTicksBatch(nowMs);
    await this.captureBoundaries(nowMs);
    await this.paper.step(nowMs);
    await this.watchdogs(nowMs);
    // refresh real USDC balance periodically while armed (drives live drawdown stops)
    if (this.live.isArmed(nowMs) && nowMs - this.lastLiveRefreshMs > 30_000) {
      this.lastLiveRefreshMs = nowMs;
      await this.live.refreshBankroll();
      // A successful wallet re-read reconciles any UNKNOWN_OUTCOME intents:
      // only after this may a NEW attempt be authorized again.
      if (this.live.state === "ARMED") {
        for (const g of this.execGuards.unreconciled()) {
          g.markBalanceReconciled();
          this.execTimeline.transition(g.intentId, "BALANCE_RECONCILED", { utcMs: nowMs, reason: "live bankroll re-read" });
        }
      }
    }

    const active = this.activeMarket(nowMs);
    if (active) {
      await this.evaluateMarket(active, nowMs);
      await this.maintainRestingOrders(active, nowMs);
    }
    await this.resolveDue(nowMs);
    // R10 paired-cycle research loop: config-gated (OFF by default), paper/
    // shadow only, and strictly after the canonical trading path.
    this.stepInventoryResearch(active, nowMs);
    await this.publishCockpit(nowMs);
    // Execution-quality bookkeeping: strictly after the trading hot path.
    // The drain is awaited HERE (end of step, all trading actions done) rather
    // than run on a detached chain: the embedded PGlite dev database is a
    // single WASM connection and cannot tolerate interleaved queries.
    this.markouts.sample(nowMs);
    this.counterfactuals.expire(nowMs);
    await this.execTimeline.settle();
    await this.inventoryPersistence.settle();
  }

  /**
   * R10 paired-cycle loop (plan Phase 3). Hard gates, in order:
   *  - simulator exists only in paper/shadow (observe: null; live: no
   *    construction path anywhere, and the simulator constructor refuses it);
   *  - inventory_research.enabled must be explicitly true (default false);
   *  - engine must be in a healthy PAPER/SHADOW state (never DEGRADED/HALTED).
   * All simulator work is in-memory + buffered persistence; exceptions are
   * contained so the canonical trading path can never be disturbed.
   */
  private stepInventoryResearch(active: MarketRuntime | null, nowMs: number): void {
    if (!this.inventorySim) return;
    if (!this.invCfg().enabled) return; // OFF by default
    if (this.engineState !== "PAPER" && this.engineState !== "SHADOW") return;
    try {
      if (active && active.rulesVerified && active.ptbConsistent && active.fee) {
        this.inventorySim.consider({
          marketId: active.ref.marketId,
          conditionId: active.ref.conditionId,
          slug: active.ref.slug,
          upTokenId: active.ref.upTokenId,
          downTokenId: active.ref.downTokenId,
          endEpoch: active.ref.endEpoch,
          cutoffMs: (active.ref.endEpoch - this.cfg.strategy.cancel_seconds_remaining) * 1000,
          tickSize6: active.tickSize6,
          feeRatePpm: active.fee.ratePpm,
          rebateSharePpm: active.fee.rebateRatePpm,
          maxBookAgeMs: this.cfg.feeds.clob.max_book_age_ms,
        }, nowMs);
      }
      this.inventorySim.step(nowMs);
    } catch (e) {
      logger.error("paired-cycle simulator step failed (contained)", { error: String(e) });
    }
  }

  activeMarket(nowMs: number): MarketRuntime | null {
    const nowSec = nowMs / 1000;
    for (const rt of this.markets.values()) {
      if (rt.ref.startEpoch <= nowSec && nowSec < rt.ref.endEpoch) return rt;
    }
    return null;
  }

  /** RESOLVED prior-window run feeding extended_move_fade_v1 (fail-closed: null when the chain breaks). */
  private priorRunFor(activeStartEpoch: number): ExtendedMoveFadePriorRun | null {
    return computePriorRun(
      [...this.markets.values()].map((m) => ({
        startEpoch: m.ref.startEpoch,
        endEpoch: m.ref.endEpoch,
        outcome: m.localOutcome ?? m.officialOutcome,
        openText: m.priceToBeat?.text ?? null,
        closeText: m.finalValueText,
      })),
      activeStartEpoch,
    );
  }

  nextMarket(nowMs: number): MarketRuntime | null {
    const nowSec = nowMs / 1000;
    let best: MarketRuntime | null = null;
    for (const rt of this.markets.values()) {
      if (rt.ref.startEpoch > nowSec && (best === null || rt.ref.startEpoch < best.ref.startEpoch)) best = rt;
    }
    return best;
  }

  private async captureBoundaries(nowMs: number): Promise<void> {
    for (const rt of this.markets.values()) {
      if (rt.priceToBeat !== null) continue;
      const boundaryMs = rt.ref.startEpoch * 1000;
      if (nowMs < boundaryMs) continue;
      if (nowMs - boundaryMs > 5 * 60_000) continue; // market basically over; leave null
      const tick = this.chainlink.atOrBefore(boundaryMs);
      if (!tick) continue;
      const gap = boundaryMs - tick.sourceTsMs;
      if (gap > this.cfg.feeds.chainlink.max_gap_ms) {
        // tick too old to represent the boundary; wait for backfill or leave unknown
        continue;
      }
      const text = tick.fullAccuracyValue ?? String(tick.value);
      rt.priceToBeat = { text, float: tick.value, capturedAtMs: nowMs, source: "rtds_chainlink_boundary" };
      await this.db.db.update(marketsTable).set({
        priceToBeatText: text,
        priceToBeatSource: rt.priceToBeat.source,
        priceToBeatCapturedAtMs: nowMs,
        updatedAtMs: nowMs,
      }).where(eq(marketsTable.id, rt.ref.marketId));
      // continuity cross-check: previous window's final value should equal this boundary
      const prev = [...this.markets.values()].find((m) => m.ref.endEpoch === rt.ref.startEpoch);
      if (prev?.finalValueText) {
        const diffBps = relDiffBps(prev.finalValueText, text);
        if (diffBps !== null && diffBps > PTB_TOLERANCE_BPS) {
          rt.ptbConsistent = false;
          await this.health("warning", "price_to_beat", `price-to-beat continuity mismatch ${diffBps.toFixed(2)}bps for ${rt.ref.slug}; entries halted for this market`);
        }
      }
      await this.audit("market", "price_to_beat_captured", { slug: rt.ref.slug, value: text, gapMs: gap });
      this.emitEvent({ type: "price_to_beat", slug: rt.ref.slug, value: text });
    }
  }

  private async watchdogs(nowMs: number): Promise<void> {
    if (this.engineState === "HALTED") return;
    const cl = this.chainlink.latest();
    const clAge = cl ? nowMs - cl.receivedTsMs : null;
    // stale chainlink while orders rest -> cancel and degrade
    if (this.mode !== "observe" && (clAge === null || clAge > this.cfg.feeds.chainlink.max_age_ms * 4)) {
      const resting = this.paper.restingOrders();
      if (resting.length > 0) {
        await this.paper.cancelAll("authoritative feed stale; failing closed", nowMs);
        await this.health("critical", "feeds", "Chainlink stale with resting orders; canceled all resting orders");
      }
      if (this.engineState !== "DEGRADED" && clAge !== null && clAge > 30_000) {
        this.transitionEngine("DEGRADED", "chainlink stale >30s");
      }
    } else if (this.engineState === "DEGRADED" && clAge !== null && clAge < this.cfg.feeds.chainlink.max_age_ms) {
      const target: EngineState = this.mode === "observe" ? "READ_ONLY" : this.mode === "paper" ? "PAPER" : "SHADOW";
      this.transitionEngine(target, "feeds recovered");
    }
  }

  private async evaluateMarket(rt: MarketRuntime, nowMs: number): Promise<void> {
    if (rt.state === "DISCOVERED") this.transitionMarket(rt, "WARMING");

    const preset = STRATEGY_PRESETS[this.cfg.strategy.active_version];
    if (!preset) return;

    const upBook = this.bookFor(rt.ref.upTokenId);
    const downBook = this.bookFor(rt.ref.downTokenId);
    // Candle source: Binance 1s klines when fresh; otherwise synthesize from the
    // Chainlink stream (Binance blocks US IPs with HTTP 451 — and Chainlink is
    // the resolution feed anyway, so momentum computed from it is more faithful.
    // Volume-surge degrades to null under synthesis; the composite handles that.)
    const klinesFresh = this.candlesUpdatedAtMs > 0 && nowMs - this.candlesUpdatedAtMs < 20_000;
    const candles1s = klinesFresh && this.candles.length > 0
      ? this.candles
      : synthCandlesFromTicks(this.chainlink, nowMs);
    const momentumTicks = klinesFresh ? this.binance : this.chainlink;
    const indicators = candles1s.length > 30
      ? computeIndicators({ nowMs, windowStartEpochSec: rt.ref.startEpoch, candles1s, binanceTicks: momentumTicks })
      : null;
    const f = computeFeatures({
      nowMs,
      market: rt.ref,
      chainlink: this.chainlink,
      binance: this.binance,
      upBook,
      downBook,
      priceToBeat: rt.priceToBeat?.float ?? null,
      warmupSeconds: this.cfg.feeds.warmup_seconds,
      chainlinkMaxAgeMs: this.cfg.feeds.chainlink.max_age_ms,
      bookMaxAgeMs: this.cfg.feeds.clob.max_book_age_ms,
      indicators,
    });

    if (rt.state === "WARMING" && f.warmedUp) this.transitionMarket(rt, "OBSERVING");

    const presetCtx: PresetContext = {
      candidateSecondsRemainingMin: this.cfg.strategy.candidate_seconds_remaining_min,
      candidateSecondsRemainingMax: this.cfg.strategy.candidate_seconds_remaining_max,
      maxSpread: Number(this.cfg.execution.max_spread),
      minDepthShares: this.cfg.strategy.min_depth_shares,
      minAbsDistanceZ: this.cfg.strategy.min_abs_distance_z,
      priceImprovementTicks: this.cfg.execution.price_improvement_ticks,
      tickSize6: rt.tickSize6,
      probabilityModelKey: this.cfg.strategy.probability_model,
      lateSnipe: {
        snipeSecondsRemainingMin: this.cfg.strategy.late_snipe.snipe_seconds_remaining_min,
        snipeSecondsRemainingMax: this.cfg.strategy.late_snipe.snipe_seconds_remaining_max,
        minConfidence: this.cfg.strategy.late_snipe.min_confidence,
        maxPrice: Number(this.cfg.strategy.late_snipe.max_price),
      },
      // extended_move_fade_v1 inputs: RESOLVED prior-window run only (never
      // inferred from the current window); absent fields fail closed in the preset.
      extendedMoveFade: {
        minRunBlocks: this.cfg.strategy.extended_move_fade.minimum_run_blocks,
        minRunMovePct: this.cfg.strategy.extended_move_fade.minimum_run_move_pct,
        maxEntryPrice: Number(this.cfg.strategy.extended_move_fade.max_entry_price),
        priorRun: this.priorRunFor(rt.ref.startEpoch),
      },
    };
    const gate = preset.evaluate(f, presetCtx);
    rt.lastEval = { f, gate, estVersion: null };

    // persist a low-rate feature snapshot (1/s)
    if (nowMs - this.lastFeaturePersistMs >= 1000) {
      this.lastFeaturePersistMs = nowMs;
      await this.db.db.insert(featureSnapshots).values({
        marketId: rt.ref.marketId,
        tsMs: nowMs,
        features: JSON.parse(JSON.stringify(f, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
      });
    }

    if (!gate.candidate || gate.side === null || gate.desiredMakerPrice6 === null) {
      if (rt.state === "CANDIDATE") this.transitionMarket(rt, "OBSERVING");
      return;
    }
    if (rt.state === "OBSERVING") this.transitionMarket(rt, "CANDIDATE");

    if (this.mode === "observe") return;
    if (!presetAllowsMode(preset, this.mode)) return;
    if (this.engineState !== "PAPER" && this.engineState !== "SHADOW") return;
    if (nowMs - rt.lastDecisionAtMs < DECISION_COOLDOWN_MS) return;
    if (this.accounting.hasOpenPosition(rt.ref.marketId)) return;
    if (this.paper.ordersForMarket(rt.ref.marketId).some((o) => o.status === "PENDING" || o.status === "LIVE" || o.status === "PARTIAL")) return;

    rt.lastDecisionAtMs = nowMs;
    await this.decide(rt, f, gate, preset.version, preset.style, nowMs);
  }

  private async decide(
    rt: MarketRuntime,
    f: FeatureSet,
    gate: StrategyDecision,
    strategyVersion: string,
    style: "maker_post_only" | "taker_fok" | "taker_fak",
    nowMs: number,
  ): Promise<void> {
    const side = gate.side!;
    const price6 = gate.desiredMakerPrice6!;
    const modelKey = strategyVersion === "late_snipe_composite_v1" ? "binance_composite" : this.cfg.strategy.probability_model;
    const model = MODELS[modelKey] ?? MODELS.book_baseline!;
    const est = model.estimate(f);
    const conservative6 = gate.conservativeProbability6 ?? 0n;

    const profileName = this.cfg.risk.profile;
    const limits = profileName === "custom"
      ? clampCustomProfile(customLimitsFromConfig(this.cfg)).limits
      : RISK_PROFILES[profileName];

    // Live routing: armed + profile permits live. When armed, the typed
    // acknowledgement has accepted trading an unproven model with real money,
    // so the two GOVERNANCE gates (model-approved, strategy-validated) are
    // satisfied — but every ECONOMIC and SAFETY gate (edge, break-even, caps,
    // staleness, price ceiling, cutoff, drawdown stops) still applies unchanged.
    const liveArmed = this.live.isArmed(nowMs) && limits.liveAllowed;
    const decisionMode: Mode = liveArmed ? "live" : this.mode;

    const decisionId = newId();
    const correlationId = newId();
    // Pre-generated intent id: the execution timeline references it from
    // DECISION_SNAPSHOT on, before (and whether or not) the intent row exists.
    const intentId = newId();
    const execMode: ExecutionMode = decisionMode === "live" ? "LIVE" : decisionMode === "shadow" ? "SHADOW" : "PAPER";
    const bank = liveArmed ? this.live.bankState() : this.accounting.state();
    const feeSchedule = { ratePpm: rt.fee?.ratePpm ?? ppm("0.07"), collection: this.cfg.paper.fee_collection_convention };
    const sideBook = side === "UP" ? this.bookFor(rt.ref.upTokenId) : this.bookFor(rt.ref.downTokenId);
    const bookAge = sideBook.ageMs(nowMs);
    const idemKey = idempotencyKey(decisionId, 1);

    const riskCtx: RiskContext = {
      mode: decisionMode,
      engineArmedForMode: liveArmed ? true : (this.engineState === "PAPER" || this.engineState === "SHADOW"),
      limits,
      profileName,
      bankroll: bank,
      chainlinkAgeMs: f.chainlinkAgeMs,
      chainlinkMaxAgeMs: this.cfg.feeds.chainlink.max_age_ms,
      bookAgeMs: bookAge,
      bookMaxAgeMs: this.cfg.feeds.clob.max_book_age_ms,
      clockSkewMs: this.clockSkewMs(),
      clockMaxDriftMs: this.cfg.feeds.clock.max_drift_ms + 150, // allowance for one-way network latency in the skew estimate
      priceToBeatKnown: rt.priceToBeat !== null,
      priceToBeatConsistent: rt.ptbConsistent,
      rulesVerified: rt.rulesVerified,
      feeScheduleKnown: rt.fee !== null,
      dataQualityScore: f.dataQualityScore,
      minDataQuality: MIN_DATA_QUALITY,
      style,
      takerPermittedByStrategy: this.cfg.strategy.allow_taker && style !== "maker_post_only",
      price: price6,
      bestBidSameSide: sideBook.bestBid(),
      bestAskSameSide: sideBook.bestAsk(),
      spread: sideBook.spread(),
      estimatedImpact: null, // filled below for takers
      secondsRemaining: f.secondsRemaining,
      conservativeProbability: conservative6,
      feeSchedule,
      // Governance gates derived centrally (@b5p/risk governanceForMode): the
      // live-arm acknowledgement bypasses EXACTLY these two gates and nothing
      // else; live without the override requires model live-approval plus an
      // active, approved LIVE promotion decision. All economic and safety
      // gates below remain in force regardless.
      ...governanceForMode(
        decisionMode,
        liveArmed,
        { approvedForPaper: model.approvedForPaper, approvedForLive: model.approvedForLive },
        this.livePromotion,
      ),
      // Calibration policy (PR #72 gate): when calibration_required is set,
      // an uncalibrated model may not drive trades in ANY mode — the live-arm
      // override cannot bypass this (it is not a governance gate).
      calibrationRequired: this.cfg.strategy.calibration_required,
      modelCalibrated: model.calibrated,
      coolingOffUntilMs: null,
      nowMs,
      idempotencyKeyIsDuplicate: this.usedIdempotencyKeys.has(idemKey),
      requestedStakeFractionPpm: null,
      minOrderStake6: costOf(rt.minOrderShares6, price6),
    };

    // pre-size to estimate impact for taker styles
    const preVerdict = evaluateOrderRisk(riskCtx);
    let stake6 = preVerdict.sizing?.stake6 ?? 0n;
    // Paper uses the (possibly simulated) sizing modes; live uses the risk
    // engine's real-bankroll stake directly (never the paper simulation).
    const sim = this.accounting.simulatedStake(this.cfg, stake6);
    if (this.mode === "paper" && !liveArmed) stake6 = sim.stake6;
    let shares6 = roundSharesToLot(sharesForStake(stake6, price6), sharesOf("0.01"));
    if (style !== "maker_post_only") {
      const impact = sideBook.takerBuyImpact(shares6);
      riskCtx.estimatedImpact = impact ? impact.impact6 : null;
    }
    const verdict = evaluateOrderRisk(riskCtx);
    rt.lastRejectionReasons = verdict.reasons;

    const snapshot = buildDecisionSnapshot({
      decisionId,
      correlationId,
      mode: decisionMode,
      nowMs,
      market: rt.ref,
      rulesHash: rt.rulesHash,
      resolutionSource: rt.resolutionSource,
      priceToBeat: rt.priceToBeat ? { text: rt.priceToBeat.text, capturedAtMs: rt.priceToBeat.capturedAtMs, source: rt.priceToBeat.source } : null,
      features: f,
      gate,
      estimate: est,
      conservative6,
      side,
      style,
      price6,
      shares6,
      stake6,
      bankroll6: bank.bankroll,
      feeRatePpm: feeSchedule.ratePpm,
      feeRebatePpm: rt.fee?.rebateRatePpm ?? 0n,
      feeCollection: feeSchedule.collection,
      verdict,
      modelCalibrated: model.calibrated,
      profileName,
      limits: limitsToStrings(limits),
      cfg: this.cfg,
      configVersion: this.configVersion,
      clockSkewMs: this.clockSkewMs(),
      exitPolicy: this.cfg.strategy.exit_policy,
      feedHealth: this.feedHealth(nowMs),
    });

    // persist snapshot BEFORE any order exists (non-negotiable ordering)
    await this.db.db.insert(decisionSnapshots).values({
      decisionId,
      marketId: rt.ref.marketId,
      mode: decisionMode,
      correlationId,
      data: snapshot as unknown as Record<string, unknown>,
      createdAtMs: nowMs,
    });

    // execution timeline: decision snapshot persisted, intent id minted.
    // All emission below is synchronous in-memory buffering (hot-path safe).
    this.execTimeline.begin({ correlationId, intentId, mode: execMode });
    this.intentMeta.set(intentId, { correlationId, decisionId, marketId: rt.ref.marketId });
    const mIntents = this.marketIntents.get(rt.ref.marketId) ?? [];
    mIntents.push(intentId);
    this.marketIntents.set(rt.ref.marketId, mIntents);
    const decisionBookToken = this.execTimeline.captureBook(sideBook, rt.ref.marketId);
    this.execTimeline.transition(intentId, "DECISION_SNAPSHOT", {
      utcMs: nowMs, bookToken: decisionBookToken, detail: { decisionId, marketId: rt.ref.marketId, side, style },
    });
    this.execTimeline.transition(intentId, "INTENT_CREATED", { utcMs: nowMs, detail: { idempotencyKey: idemKey } });
    if (sideBook.receivedTsMs > 0 && sideBook.sourceTsMs > 0) {
      this.execTimeline.latency({
        correlationId, intentId, attemptId: null, stage: "BOOK_FEED",
        durationUs: Math.max(0, (sideBook.receivedTsMs - sideBook.sourceTsMs) * 1000), mode: execMode, nowMs,
      });
    }
    await this.db.db.insert(signalCandidates).values({
      id: newId(),
      marketId: rt.ref.marketId,
      tsMs: nowMs,
      strategyVersion,
      side,
      status: verdict.approved ? "RISK_APPROVED" : "REJECTED",
      detail: { decisionId, checks: gate.checks, simulationSizing: sim.mode, simulationNote: sim.note },
    });
    await this.db.db.insert(riskDecisions).values({
      id: newId(),
      decisionId,
      approved: verdict.approved,
      reasons: verdict.reasons,
      capChain: (verdict.sizing?.capResult.caps ?? []).map((c) => ({ name: c.name, capPpm: c.capPpm.toString() })),
      createdAtMs: nowMs,
    });

    if (!verdict.approved) {
      this.execTimeline.transition(intentId, "REJECTED", {
        utcMs: nowMs, reason: "risk_rejected", detail: { codes: verdict.reasons.map((r) => r.code) },
      });
      // counterfactual: would this maker order have filled had we placed it?
      if (shares6 > 0n && style === "maker_post_only") {
        this.counterfactuals.register({
          correlationId, decisionId, marketId: rt.ref.marketId,
          tokenId: side === "UP" ? rt.ref.upTokenId : rt.ref.downTokenId,
          price6, size6: shares6, reason: "risk_rejected",
          queueAhead6: sideBook.queueAtBid(price6), registeredAtMs: nowMs,
          expiresAtMs: (rt.ref.endEpoch - this.cfg.strategy.cancel_seconds_remaining) * 1000,
        });
      }
      this.transitionMarket(rt, "REJECTED");
      this.transitionMarket(rt, "OBSERVING");
      this.emitEvent({ type: "decision_rejected", decisionId, marketId: rt.ref.marketId, reasons: verdict.reasons.map((r) => r.code) });
      return;
    }

    this.transitionMarket(rt, "RISK_APPROVED");
    this.execTimeline.transition(intentId, "RISK_APPROVED", {
      utcMs: nowMs, detail: { stake6: stake6.toString(), shares6: shares6.toString() },
    });
    this.usedIdempotencyKeys.add(idemKey);
    await this.db.db.insert(orderIntents).values({
      id: intentId,
      decisionId,
      version: 1,
      idempotencyKey: idemKey,
      payload: {
        side, style, price6: price6.toString(), shares6: shares6.toString(), stake6: stake6.toString(),
        tokenId: side === "UP" ? rt.ref.upTokenId : rt.ref.downTokenId,
        shadow: this.mode === "shadow",
      },
      createdAtMs: nowMs,
    });

    const tokenId = side === "UP" ? rt.ref.upTokenId : rt.ref.downTokenId;
    const cancelCutoffMs = (rt.ref.endEpoch - this.cfg.strategy.cancel_seconds_remaining) * 1000;

    if (decisionMode === "shadow") {
      // No order is sent: record the would-be maker fill as a counterfactual.
      this.counterfactuals.register({
        correlationId, decisionId, marketId: rt.ref.marketId, tokenId,
        price6, size6: shares6, reason: "shadow_not_placed",
        queueAhead6: sideBook.queueAtBid(price6), registeredAtMs: nowMs, expiresAtMs: cancelCutoffMs,
      });
      await this.audit("order", "shadow_would_submit", { decisionId, side, price: price6, shares: shares6 });
      this.emitEvent({ type: "shadow_would_submit", decisionId, marketId: rt.ref.marketId });
      this.transitionMarket(rt, "OBSERVING");
      return;
    }

    // Execution invariants: per-intent guard (remaining-size-aware retries,
    // one in-flight mutation, cutoff, UNKNOWN_OUTCOME quarantine).
    const cutoffSeconds = decisionMode === "live" ? limits.liveEntryCutoffSeconds : limits.paperEntryCutoffSeconds;
    const guard = this.execGuards.create({
      intentId, decisionId, correlationId, approvedShares6: shares6,
      entryCutoffMs: (rt.ref.endEpoch - cutoffSeconds) * 1000,
    });
    const timeInForce = style === "maker_post_only" ? "GTD" : style === "taker_fok" ? "FOK" : "FAK";
    const requestHash = sha256Hex(JSON.stringify({
      intentId, attempt: 1, tokenId, orderSide: "BUY", style,
      price6: price6.toString(), shares6: shares6.toString(), timeInForce,
    }));
    const attemptId = this.execTimeline.beginAttempt({
      intentId, attemptNumber: 1, requestHash, tokenId, side: "BUY",
      price6, size6: shares6, timeInForce, postOnly: style === "maker_post_only",
      decisionBookToken, nowMs,
    });
    const auth = guard.authorizeAttempt(shares6, nowMs);
    const lock = auth.ok && attemptId !== null ? guard.beginMutation(attemptId) : { ok: false as const };
    if (!auth.ok || attemptId === null || !lock.ok) {
      const reason = `execution invariant refused attempt: ${auth.refusal ?? ("refusal" in lock ? lock.refusal : "NO_ATTEMPT")}`;
      this.execTimeline.transition(intentId, "SIGN_STARTED", { utcMs: nowMs });
      this.execTimeline.transition(intentId, "REJECTED", { utcMs: nowMs, reason });
      this.transitionMarket(rt, "REJECTED");
      this.transitionMarket(rt, "OBSERVING");
      await this.audit("order", "attempt_refused", { decisionId, reason });
      return;
    }

    // LIVE path: real order via the CLOB adapter.
    if (liveArmed) {
      this.transitionMarket(rt, "ORDER_PENDING");
      this.execTimeline.transition(intentId, "SIGN_STARTED", { utcMs: nowMs });
      const sendBookToken = this.execTimeline.captureBook(sideBook, rt.ref.marketId);
      this.execTimeline.attachSnapshot(attemptId, "send", sendBookToken);
      this.execTimeline.transition(intentId, "SENT", { utcMs: nowMs, bookToken: sendBookToken });
      const t0 = monotonicNs();
      let res: Awaited<ReturnType<LiveController["submit"]>>;
      try {
        res = await this.live.submit({
          decisionId, intentId, marketId: rt.ref.marketId, tokenId, outcomeSide: side,
          style, price6, shares6, stake6, tickSize6: rt.tickSize6, negRisk: false,
          ...(style === "maker_post_only" ? { expireAtMs: cancelCutoffMs } : {}),
          idempotencyKey: idemKey, nowMs,
        });
      } catch (e) {
        // Transport/adapter exception: outcome unknown. Quarantine the intent —
        // NO retry until balances are reconciled against exchange truth.
        guard.markUnknownOutcome();
        this.execTimeline.transition(intentId, "UNKNOWN_OUTCOME", { utcMs: Date.now(), reason: String(e) });
        this.execTimeline.latency({ correlationId, intentId, attemptId, stage: "ACK", durationUs: durationUs(t0, monotonicNs()), mode: execMode, nowMs });
        await this.health("critical", "live", `live submit outcome UNKNOWN for ${decisionId}: ${String(e)}; retries blocked until balance reconciliation`);
        return;
      }
      this.execTimeline.latency({ correlationId, intentId, attemptId, stage: "ACK", durationUs: durationUs(t0, monotonicNs()), mode: execMode, nowMs });
      if (res.ok) {
        const ackBookToken = this.execTimeline.captureBook(sideBook, rt.ref.marketId);
        this.execTimeline.attachSnapshot(attemptId, "ack", ackBookToken);
        this.execTimeline.transition(intentId, "EXCHANGE_ACK", { utcMs: Date.now(), bookToken: ackBookToken, detail: { orderId: res.orderId, status: res.status } });
        this.execTimeline.bindOrder(res.orderId, attemptId);
        // Duplicate-ack idempotence: exposure is only recorded the first time
        // this requestHash is acknowledged.
        const firstAck = guard.registerAck(requestHash);
        this.live.markOpen(rt.ref.marketId);
        if (res.status === "MATCHED") {
          if (firstAck) {
            guard.recordFill(shares6);
            this.execTimeline.recordAttemptFill(attemptId, shares6, nowMs);
          }
          const fillBookToken = this.execTimeline.captureBook(sideBook, rt.ref.marketId);
          this.execTimeline.attachSnapshot(attemptId, "fill", fillBookToken);
          this.execTimeline.transition(intentId, "FILLED", { utcMs: Date.now(), bookToken: fillBookToken });
          this.markouts.registerFill({
            correlationId, attemptId, fillId: null, marketId: rt.ref.marketId, tokenId,
            side: "BUY", fillTsMs: nowMs, midAtFill6: sideBook.mid() ?? price6,
          });
        } else {
          this.execTimeline.transition(intentId, "RESTING", { utcMs: Date.now() });
        }
        this.transitionMarket(rt, res.status === "MATCHED" ? "FILLED" : "RESTING");
        await this.audit("order", "live_submitted", { decisionId, orderId: res.orderId, side, price: price6, shares: shares6, stake: stake6, status: res.status });
        this.emitEvent({ type: "live_order", orderId: res.orderId, marketId: rt.ref.marketId, decisionId, status: res.status });
      } else {
        this.execTimeline.transition(intentId, "REJECTED", { utcMs: Date.now(), reason: res.reason ?? "live rejected" });
        this.transitionMarket(rt, "REJECTED");
        this.transitionMarket(rt, "OBSERVING");
        await this.audit("order", "live_rejected", { decisionId, reason: res.reason });
        this.emitEvent({ type: "live_rejected", decisionId, marketId: rt.ref.marketId, reason: res.reason });
      }
      guard.endMutation(attemptId);
      return;
    }

    this.transitionMarket(rt, "ORDER_PENDING");
    this.execTimeline.transition(intentId, "SIGN_STARTED", { utcMs: nowMs, detail: { simulated: true } });
    const t0 = monotonicNs();
    const order = await this.paper.submit({
      decisionId,
      intentId,
      marketId: rt.ref.marketId,
      tokenId,
      outcomeSide: side,
      style: style === "maker_post_only" ? "maker_post_only" : "taker_fak",
      price6,
      shares6,
      stakeCap6: stake6,
      exitPolicy: this.cfg.strategy.exit_policy,
      nowMs,
      cfg: this.cfg,
      cancelAtSecondsRemaining: this.cfg.strategy.cancel_seconds_remaining,
      marketEndEpoch: rt.ref.endEpoch,
    });
    this.execTimeline.latency({ correlationId, intentId, attemptId, stage: "SEND", durationUs: durationUs(t0, monotonicNs()), mode: execMode, nowMs });
    const sendBookToken = this.execTimeline.captureBook(sideBook, rt.ref.marketId);
    this.execTimeline.attachSnapshot(attemptId, "send", sendBookToken);
    this.execTimeline.transition(intentId, "SENT", { utcMs: nowMs, bookToken: sendBookToken, detail: { orderId: order.id } });
    this.execTimeline.bindOrder(order.id, attemptId);
    this.paperVariants.onOrderSubmitted(order, {
      correlationId, tickSize6: rt.tickSize6,
      feeRatePpm: rt.fee?.ratePpm ?? ppm("0.07"), feeCollection: this.cfg.paper.fee_collection_convention,
    });
    guard.endMutation(attemptId);
    this.transitionMarket(rt, "RESTING");
    await this.audit("order", "submitted", { decisionId, orderId: order.id, side, price: price6, shares: shares6, stake: stake6, sim: sim.mode });
    this.emitEvent({ type: "order_submitted", orderId: order.id, marketId: rt.ref.marketId, decisionId });
  }

  private async maintainRestingOrders(rt: MarketRuntime, nowMs: number): Promise<void> {
    const minEdge = ppm(this.cfg.strategy.min_conservative_edge);
    for (const o of this.paper.ordersForMarket(rt.ref.marketId)) {
      if (o.status !== "LIVE" && o.status !== "PARTIAL") continue;
      if (o.style !== "maker_post_only") continue;
      const cons = rt.lastEval?.gate.conservativeProbability6 ?? null;
      const sideMatches = rt.lastEval?.gate.side === o.outcomeSide;
      const stale = (rt.lastEval?.f.chainlinkAgeMs ?? Infinity) > this.cfg.feeds.chainlink.max_age_ms;
      if (stale) {
        await this.paper.cancel(o.id, "cancel: authoritative data stale", nowMs);
        this.transitionMarket(rt, "CANCELED");
        this.transitionMarket(rt, "OBSERVING");
        continue;
      }
      if (cons === null || !sideMatches || !makerEdgeSatisfied(cons, o.price6, minEdge)) {
        await this.paper.cancel(o.id, "cancel: conservative edge no longer present", nowMs);
        this.transitionMarket(rt, "CANCELED");
        this.transitionMarket(rt, "OBSERVING");
      }
    }
  }

  // ---------- execution-quality observation (plan item 1b) ----------
  // All handlers are synchronous in-memory buffering; persistence happens on
  // the background flush chain and can never block or reorder trading.

  /** Simulated exchange accept: EXCHANGE_ACK (+RESTING and queue estimate for makers). */
  private onPaperActivated(o: PaperOrderRecord, nowMs: number): void {
    const attemptId = this.execTimeline.attemptForOrder(o.id);
    const intentId = attemptId ? this.execTimeline.intentForAttempt(attemptId) : null;
    if (!attemptId || !intentId) return;
    const book = this.books.get(o.tokenId) ?? null;
    const ackBookToken = this.execTimeline.captureBook(book, o.marketId);
    this.execTimeline.attachSnapshot(attemptId, "ack", ackBookToken);
    this.execTimeline.transition(intentId, "EXCHANGE_ACK", { utcMs: nowMs, bookToken: ackBookToken, detail: { orderId: o.id, simulated: true } });
    if (o.style === "maker_post_only") {
      this.execTimeline.transition(intentId, "RESTING", { utcMs: nowMs, detail: { queueAhead6: o.queueAhead6.toString() } });
      const meta = this.intentMeta.get(intentId);
      if (meta) {
        this.execTimeline.queueEstimate({
          correlationId: meta.correlationId, attemptId, tokenId: o.tokenId,
          price6: o.price6, aheadShares6: o.queueAhead6, method: "FULL_LEVEL_CONSERVATIVE", nowMs,
        });
      }
    }
    this.paperVariants.onOrderActivated(o.id, nowMs);
  }

  private onPaperQueueChanged(o: PaperOrderRecord, _consumed6: bigint, tsMs: number): void {
    const attemptId = this.execTimeline.attemptForOrder(o.id);
    const intentId = attemptId ? this.execTimeline.intentForAttempt(attemptId) : null;
    const meta = intentId ? this.intentMeta.get(intentId) : null;
    if (!attemptId || !meta) return;
    this.execTimeline.queueEstimate({
      correlationId: meta.correlationId, attemptId, tokenId: o.tokenId,
      price6: o.price6, aheadShares6: o.queueAhead6, method: "TRADE_TAPE_REPLAY", nowMs: tsMs,
    });
  }

  /** Terminal paper order status -> timeline (post-only crossing routes to REJECTED). */
  private onPaperFinished(o: PaperOrderRecord, status: PaperOrderRecord["status"], reason: string, nowMs: number): void {
    this.paperVariants.onOrderFinished(o.id, status, nowMs);
    const attemptId = this.execTimeline.attemptForOrder(o.id);
    const intentId = attemptId ? this.execTimeline.intentForAttempt(attemptId) : null;
    if (!intentId) return;
    const state = this.execTimeline.stateOf(intentId);
    if (status === "REJECTED") {
      // includes post-only-would-cross: a safe no-fill, never converted to taker
      this.execTimeline.transition(intentId, "REJECTED", { utcMs: nowMs, reason });
    } else if (status === "CANCELED" || status === "EXPIRED") {
      if (state === "RESTING" || state === "PARTIAL_FILL") {
        this.execTimeline.transition(intentId, "CANCEL_REQUESTED", { utcMs: nowMs, reason });
        this.execTimeline.transition(intentId, "CANCEL_CONFIRMED", { utcMs: nowMs, reason });
        // counterfactual: maker order canceled before it could (fully) fill
        const meta = this.intentMeta.get(intentId);
        const remaining = o.shares6 - o.filled6;
        if (meta && o.style === "maker_post_only" && remaining > 0n && o.expireAtMs !== null && o.expireAtMs > nowMs) {
          this.counterfactuals.register({
            correlationId: meta.correlationId, decisionId: meta.decisionId, marketId: o.marketId,
            tokenId: o.tokenId, price6: o.price6, size6: remaining, reason: "canceled_before_fill",
            queueAhead6: o.queueAhead6, registeredAtMs: nowMs, expiresAtMs: o.expireAtMs,
          });
        }
      } else {
        // never rested (FAK nothing executable / canceled pre-activation): safe no-fill
        this.execTimeline.transition(intentId, "REJECTED", { utcMs: nowMs, reason });
      }
    } else if (status === "MATCHED" && o.filled6 < o.shares6) {
      this.execTimeline.transition(intentId, "CANCEL_CONFIRMED", { utcMs: nowMs, reason: "FAK remainder canceled at stake cap/limit" });
    }
    // full MATCHED: FILLED already emitted by the fill observer
  }

  /** Every paper fill: guard accounting, timeline fill events, markouts, variants. */
  private observePaperFill(fill: FillEvent): void {
    const o = fill.order;
    const attemptId = this.execTimeline.attemptForOrder(o.id);
    const intentId = attemptId ? this.execTimeline.intentForAttempt(attemptId) : null;
    const meta = intentId ? this.intentMeta.get(intentId) : null;
    const book = this.books.get(o.tokenId) ?? null;
    if (attemptId && intentId) {
      const guard = this.execGuards.get(intentId);
      if (guard) {
        const res = guard.recordFill(fill.shares6);
        if (res.clamped) {
          logger.error("fill exceeded approved intent size; clamped in guard", { orderId: o.id, intentId });
        }
      }
      const fillBookToken = this.execTimeline.captureBook(book, o.marketId);
      this.execTimeline.attachSnapshot(attemptId, "fill", fillBookToken);
      this.execTimeline.recordAttemptFill(attemptId, fill.shares6, fill.tsMs);
      this.execTimeline.transition(intentId, o.filled6 >= o.shares6 ? "FILLED" : "PARTIAL_FILL", {
        utcMs: fill.tsMs, bookToken: fillBookToken,
        detail: { shares6: fill.shares6.toString(), price6: fill.price6.toString(), fee6: fill.fee6.toString(), maker: fill.maker },
      });
    }
    this.markouts.registerFill({
      correlationId: meta?.correlationId ?? o.decisionId,
      attemptId,
      fillId: fill.fillId ?? null,
      marketId: o.marketId,
      tokenId: o.tokenId,
      side: "BUY",
      fillTsMs: fill.tsMs,
      midAtFill6: book?.mid() ?? fill.price6,
    });
    this.paperVariants.onActualFill(o, fill.shares6, fill.price6, fill.fee6, fill.tsMs);
  }

  // ---------- resolution ----------

  async resolveDue(nowMs: number): Promise<void> {
    let resolvedAny = false;
    for (const rt of this.markets.values()) {
      if (rt.localOutcome !== null) continue;
      const dueMs = rt.ref.endEpoch * 1000 + RESOLUTION_GRACE_MS;
      if (nowMs < dueMs) continue;

      const finalTick = this.chainlink.atOrBefore(rt.ref.endEpoch * 1000);
      let outcome: OutcomeSide | null = null;
      let source = "rtds_chainlink_boundary";
      let finalText: string | null = null;

      if (finalTick && rt.priceToBeat) {
        finalText = finalTick.fullAccuracyValue ?? String(finalTick.value);
        outcome = compareDecimal(finalText, rt.priceToBeat.text) >= 0 ? "UP" : "DOWN";
      } else if (rt.officialOutcome) {
        outcome = rt.officialOutcome;
        source = "gamma_official";
      }

      if (outcome === null) {
        if (nowMs - dueMs > 60_000 && !rt.resolveWarned) {
          rt.resolveWarned = true; // warn once per market, not every step
          await this.health("warning", "resolution", `cannot resolve ${rt.ref.slug} locally (missing boundary data); awaiting official outcome`);
        }
        continue;
      }

      rt.localOutcome = outcome;
      rt.finalValueText = finalText;
      if (canTransition(MARKET_TRANSITIONS, rt.state, "RESOLVED")) this.transitionMarket(rt, "RESOLVED");
      await this.db.db.insert(resolutions).values({
        id: newId(),
        marketId: rt.ref.marketId,
        outcome,
        priceToBeatText: rt.priceToBeat?.text ?? null,
        finalValueText: finalText,
        officialOutcome: rt.officialOutcome,
        mismatch: false,
        source,
        resolvedAtMs: nowMs,
      }).onConflictDoNothing();
      await this.db.db.update(marketsTable).set({ status: "RESOLVED", outcome, updatedAtMs: nowMs }).where(eq(marketsTable.id, rt.ref.marketId));
      const pnl = await this.accounting.onResolution(rt.ref.marketId, outcome, nowMs);
      // live position bookkeeping: mark closed (win/loss feeds consecutive-loss stop) and re-read real balance
      if (this.live.hasOpenPosition(rt.ref.marketId)) {
        const liveOrders = await this.db.db.select().from(orders).where(eq(orders.marketId, rt.ref.marketId));
        const wonSide = liveOrders.find((o) => o.mode === "live" && o.filledShares6 > 0n)?.outcomeSide;
        this.live.markClosed(rt.ref.marketId, wonSide === outcome);
        await this.live.refreshBankroll();
      }
      await this.audit("resolution", "resolved", { slug: rt.ref.slug, outcome, source, pnl: pnl ?? "no position" });
      this.emitEvent({ type: "resolved", slug: rt.ref.slug, outcome, pnl: pnl?.toString() ?? null });
      await this.crossCheckResolution(rt, nowMs);

      // execution research: AT_RESOLUTION markouts, three-variant results,
      // fill-selection samples, and timeline balance reconciliation.
      resolvedAny = true;
      this.markouts.onResolution(
        rt.ref.marketId, outcome,
        (tokenId) => tokenId === rt.ref.upTokenId ? "UP" : tokenId === rt.ref.downTokenId ? "DOWN" : null,
        nowMs,
      );
      this.paperVariants.onResolution(rt.ref.marketId, outcome, nowMs);
      // R10 cycles: settle held exposure / wind down stragglers. Always called
      // when the simulator exists so cycles from a later-disabled config still
      // reconcile; a no-op without cycles for this market.
      try {
        this.inventorySim?.onResolution(rt.ref.marketId, outcome, nowMs);
      } catch (e) {
        logger.error("paired-cycle resolution settle failed (contained)", { error: String(e) });
      }
      for (const intentId of this.marketIntents.get(rt.ref.marketId) ?? []) {
        const s = this.execTimeline.stateOf(intentId);
        if (s === "FILLED" || s === "REJECTED" || s === "CANCEL_CONFIRMED" || s === "UNKNOWN_OUTCOME") {
          this.execTimeline.transition(intentId, "BALANCE_RECONCILED", { utcMs: nowMs, reason: "market resolved; paper accounting settled" });
        }
        this.intentMeta.delete(intentId);
      }
      this.marketIntents.delete(rt.ref.marketId);
    }
    if (resolvedAny) {
      // fill_selection_cost = signal-conditioned value − fill-conditioned value,
      // computed per resolution batch (drained at end of step).
      this.paperVariants.flushSelectionCost(nowMs);
    }
  }

  private async crossCheckResolution(rt: MarketRuntime, nowMs: number): Promise<void> {
    if (rt.localOutcome === null || rt.officialOutcome === null) return;
    if (rt.localOutcome !== rt.officialOutcome) {
      await this.db.db.update(resolutions).set({ mismatch: true, officialOutcome: rt.officialOutcome }).where(eq(resolutions.marketId, rt.ref.marketId));
      await this.halt(`RESOLUTION MISMATCH on ${rt.ref.slug}: local=${rt.localOutcome} official=${rt.officialOutcome}`, nowMs);
    } else {
      await this.db.db.update(resolutions).set({ officialOutcome: rt.officialOutcome }).where(eq(resolutions.marketId, rt.ref.marketId));
      if (rt.state === "RESOLVED") this.transitionMarket(rt, "RECONCILED");
    }
  }

  // ---------- persistence helpers ----------

  private async persistTicksBatch(nowMs: number): Promise<void> {
    if (this.tickPersistQueue.length === 0) return;
    const batch = this.tickPersistQueue.splice(0, this.tickPersistQueue.length);
    const rows = batch
      .filter((t, i) => t.source === "chainlink" || i % 2 === 0) // light binance downsample
      .map((t) => ({
        source: t.source,
        symbol: t.symbol,
        valueText: t.fullAccuracyValue ?? String(t.value),
        valueFloat: t.value,
        sourceTsMs: t.sourceTsMs,
        receivedTsMs: t.receivedTsMs,
      }));
    if (rows.length > 0) {
      try {
        await this.db.db.insert(referencePriceTicks).values(rows);
      } catch (e) {
        await this.health("critical", "database", `tick persistence failed: ${String(e)}`);
        await this.halt("database unavailable for durable audit", nowMs);
      }
    }
  }

  feedHealth(nowMs: number): Record<string, { ageMs: number | null; healthy: boolean }> {
    const cl = this.chainlink.latest();
    const bn = this.binance.latest();
    const anyBook = [...this.books.values()][0] ?? null;
    const clAge = cl ? nowMs - cl.receivedTsMs : null;
    const bnAge = bn ? nowMs - bn.receivedTsMs : null;
    const bookAge = anyBook?.ageMs(nowMs) ?? null;
    const candleAge = this.candlesUpdatedAtMs === 0 ? null : nowMs - this.candlesUpdatedAtMs;
    return {
      chainlink: { ageMs: clAge, healthy: clAge !== null && clAge <= this.cfg.feeds.chainlink.max_age_ms },
      binance: { ageMs: bnAge, healthy: bnAge !== null && bnAge <= this.cfg.feeds.binance.max_age_ms },
      clob_book: { ageMs: bookAge, healthy: bookAge !== null && bookAge <= this.cfg.feeds.clob.max_book_age_ms * 10 },
      binance_klines: { ageMs: candleAge, healthy: candleAge !== null && candleAge <= 20_000 },
    };
  }

  private async publishCockpit(nowMs: number): Promise<void> {
    if (nowMs - this.lastCockpitPublish < 1000) return;
    this.lastCockpitPublish = nowMs;
    const state = this.cockpitState(nowMs);
    this.bus.publish(CHANNELS.cockpit, state);
    try {
      await this.db.db.insert(engineKv)
        .values({ key: "cockpit", value: state as Record<string, unknown>, updatedAtMs: nowMs })
        .onConflictDoUpdate({ target: engineKv.key, set: { value: state as Record<string, unknown>, updatedAtMs: nowMs } });
    } catch (e) {
      logger.error("cockpit kv write failed", { error: String(e) });
    }
  }

  cockpitState(nowMs: number): Record<string, unknown> {
    const active = this.activeMarket(nowMs);
    const next = this.nextMarket(nowMs);
    const bank = this.accounting.state();
    const f = active?.lastEval?.f ?? null;
    const gate = active?.lastEval?.gate ?? null;
    const cl = this.chainlink.latest();
    return jsonSafe({
      ts: nowMs,
      engineState: this.engineState,
      mode: this.mode,
      engineVersion: ENGINE_VERSION,
      configVersion: this.configVersion,
      haltReason: this.haltReason,
      profile: this.cfg.risk.profile,
      strategyVersion: this.cfg.strategy.active_version,
      sizingSimulation: this.cfg.paper.sizing_simulation,
      live: this.live.status(nowMs),
      bankroll: {
        bankroll6: bank.bankroll,
        sessionPeak6: bank.sessionPeak,
        dailyPeak6: bank.dailyPeak,
        consecutiveLosses: bank.consecutiveLosses,
        openPositions: bank.openPositions,
        openExposure6: bank.openExposure,
        reconciled: bank.reconciled,
      },
      feeds: this.feedHealth(nowMs),
      clockSkewMs: this.clockSkewMs(),
      chainlinkNow: cl ? { value: cl.value, ageMs: nowMs - cl.receivedTsMs } : null,
      activeMarket: active
        ? {
            slug: active.ref.slug,
            marketId: active.ref.marketId,
            startEpoch: active.ref.startEpoch,
            endEpoch: active.ref.endEpoch,
            secondsRemaining: Math.max(0, Math.round(active.ref.endEpoch - nowMs / 1000)),
            state: active.state,
            priceToBeat: active.priceToBeat?.text ?? null,
            ptbConsistent: active.ptbConsistent,
            rulesVerified: active.rulesVerified,
            distanceUsd: f?.distanceUsd ?? null,
            distanceBps: f?.distanceBps ?? null,
            distanceZ: f?.distanceZ ?? null,
            upBestBid: f?.upBestBid ?? null,
            upBestAsk: f?.upBestAsk ?? null,
            downBestBid: f?.downBestBid ?? null,
            downBestAsk: f?.downBestAsk ?? null,
            spread: f?.upSpread ?? null,
            volatilityEwma: f?.ewmaVolBpsPerSqrtSec ?? null,
            indicators: f?.indicators ?? null,
            gate: gate ? { candidate: gate.candidate, side: gate.side, checks: gate.checks } : null,
            lastRejectionReasons: active.lastRejectionReasons,
            dataQuality: f?.dataQualityScore ?? null,
          }
        : null,
      nextMarket: next ? { slug: next.ref.slug, startEpoch: next.ref.startEpoch } : null,
      restingOrders: this.paper.restingOrders().map((o) => ({
        id: o.id, marketId: o.marketId, side: o.outcomeSide, style: o.style,
        price6: o.price6, shares6: o.shares6, filled6: o.filled6, status: o.status, queueAhead6: o.queueAhead6,
      })),
      openPositions: this.accounting.openPositionsList().map((p) => ({
        id: p.id, marketId: p.marketId, side: p.side, shares6: p.shares6, cost6: p.cost6, stake6: p.stake6,
      })),
      // Inventory Lab feed: null unless the R10 research loop is enabled.
      inventoryResearch: this.inventorySim && this.invCfg().enabled ? this.inventorySim.summary() : null,
    });
  }

  // ---------- infra ----------

  private transitionEngine(to: EngineState, why: string): void {
    if (this.engineState === to) return;
    if (!canTransition(ENGINE_TRANSITIONS, this.engineState, to)) {
      logger.error("illegal engine transition suppressed", { from: this.engineState, to, why });
      return;
    }
    logger.info("engine state", { from: this.engineState, to, why });
    this.engineState = to;
    this.emitEvent({ type: "engine_state", state: to, why });
  }

  private transitionMarket(rt: MarketRuntime, to: MarketInstanceState): void {
    if (rt.state === to) return;
    if (!canTransition(MARKET_TRANSITIONS, rt.state, to)) {
      logger.warn("illegal market transition suppressed", { slug: rt.ref.slug, from: rt.state, to });
      return;
    }
    rt.state = to;
    void this.db.db.update(marketsTable).set({ status: to, updatedAtMs: Date.now() }).where(eq(marketsTable.id, rt.ref.marketId));
  }

  async health(severity: "info" | "warning" | "critical", kind: string, message: string, data?: Record<string, unknown>): Promise<void> {
    logger[severity === "critical" ? "error" : severity === "warning" ? "warn" : "info"](message, { kind, ...data });
    try {
      await this.db.db.insert(healthEvents).values({ kind, severity, message, data: data ?? null, createdAtMs: Date.now() });
    } catch { /* db down is itself reported via halt path */ }
    this.emitEvent({ type: "health", severity, kind, message });
  }

  async audit(category: string, action: string, data?: Record<string, unknown>): Promise<void> {
    try {
      await this.db.db.insert(auditEvents).values({
        category, action, actor: "engine", correlationId: null,
        data: data ? (jsonSafe(data) as Record<string, unknown>) : null, createdAtMs: Date.now(),
      });
    } catch (e) {
      logger.error("audit write failed", { error: String(e) });
    }
  }

  private emitEvent(payload: Record<string, unknown>): void {
    this.bus.publish(CHANNELS.events, jsonSafe({ ts: Date.now(), ...payload }));
  }

  private activeFeeRate(): Ppm {
    const nowMs = Date.now();
    const active = this.activeMarket(nowMs);
    return active?.fee?.ratePpm ?? ppm("0.07");
  }
}

// ---------- utilities ----------

function costOf(shares6: bigint, price6: Prob6): Usdc6 {
  return (shares6 * price6 + 999_999n) / 1_000_000n;
}

/**
 * Consecutive same-direction RESOLVED 5m windows immediately preceding
 * `activeStartEpoch`, chained by endEpoch === next.startEpoch. Direction comes
 * from resolved outcomes only; the signed cumulative move (%) spans the oldest
 * run window's open (price-to-beat) to the newest's close, and is null when
 * either boundary value is missing — never fabricated (extended_move_fade_v1
 * then fails its run_magnitude gate, which is the intended fail-closed).
 */
export function computePriorRun(
  windows: ReadonlyArray<{
    startEpoch: number;
    endEpoch: number;
    outcome: OutcomeSide | null;
    openText: string | null;
    closeText: string | null;
  }>,
  activeStartEpoch: number,
): ExtendedMoveFadePriorRun | null {
  const byEnd = new Map<number, (typeof windows)[number]>();
  for (const w of windows) byEnd.set(w.endEpoch, w);
  const newest = byEnd.get(activeStartEpoch);
  if (!newest || newest.outcome === null) return null;
  const direction = newest.outcome;
  let oldest = newest;
  let blocks = 1;
  for (let guard = 0; guard < 64; guard++) {
    const prev = byEnd.get(oldest.startEpoch);
    if (!prev || prev.outcome !== direction || prev.endEpoch <= prev.startEpoch) break;
    oldest = prev;
    blocks++;
  }
  let cumulativeMovePct: number | null = null;
  const open = oldest.openText !== null ? Number(oldest.openText) : NaN;
  const close = newest.closeText !== null ? Number(newest.closeText) : NaN;
  if (Number.isFinite(open) && Number.isFinite(close) && open > 0) {
    cumulativeMovePct = ((close - open) / open) * 100;
  }
  return { blocks, direction, cumulativeMovePct };
}

/** Exact decimal string comparison via 1e18 fixed-point. */
export function compareDecimal(a: string, b: string): number {
  const pa = parseFixed(a, 18, { truncateExtra: true });
  const pb = parseFixed(b, 18, { truncateExtra: true });
  return pa === pb ? 0 : pa > pb ? 1 : -1;
}

function relDiffBps(a: string, b: string): number | null {
  const fa = Number(a);
  const fb = Number(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb) || fa === 0) return null;
  return Math.abs((fb - fa) / fa) * 10_000;
}

function limitsToStrings(l: object): Record<string, string> {
  return Object.fromEntries(Object.entries(l).map(([k, v]) => [k, String(v)]));
}

function customLimitsFromConfig(cfg: AppConfig) {
  return {
    baseRiskFractionPpm: ppm(cfg.risk.base_risk_fraction),
    maxRiskFractionPpm: ppm(cfg.risk.max_risk_fraction),
    sessionLossLimitPpm: ppm(cfg.risk.session_loss_limit),
    dailyLossLimitPpm: ppm(cfg.risk.daily_loss_limit),
    consecutiveLossLimit: cfg.risk.consecutive_loss_limit,
    maxOpenPositions: cfg.risk.max_open_positions,
    kellyMultiplierPpm: ppm(cfg.risk.kelly_multiplier),
    livePriceCeiling: prob(cfg.strategy.live_price_ceiling),
    liveEntryCutoffSeconds: cfg.strategy.live_entry_cutoff_seconds,
    paperEntryCutoffSeconds: cfg.strategy.paper_entry_cutoff_seconds,
    minConservativeEdgePpm: ppm(cfg.strategy.min_conservative_edge),
    minExpectedValuePerCostPpm: ppm(cfg.strategy.min_expected_value_per_cost),
    maxSpread: prob(cfg.execution.max_spread),
    maxPriceImpact: prob(cfg.execution.max_price_impact),
    liveAllowed: false, // live is disabled in this release regardless of profile
  };
}

function jsonSafe<T = Record<string, unknown>>(v: unknown): T {
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val))) as T;
}

/** Forward-filled 1s candles synthesized from a reference tick stream (volume 0 -> surge indicator degrades to null). */
export function synthCandlesFromTicks(buf: TickBuffer, nowMs: number, lookbackSec = 600): Candle[] {
  const ticks = buf.window(nowMs, lookbackSec * 1000);
  if (ticks.length < 2) return [];
  const startSec = Math.floor(ticks[0]!.sourceTsMs / 1000);
  const endSec = Math.floor(nowMs / 1000);
  const out: Candle[] = [];
  let i = 0;
  let last = ticks[0]!.value;
  for (let s = startSec; s <= endSec; s++) {
    let open = last;
    let high = last;
    let low = last;
    while (i < ticks.length && Math.floor(ticks[i]!.sourceTsMs / 1000) <= s) {
      const v = ticks[i]!.value;
      if (v > high) high = v;
      if (v < low) low = v;
      last = v;
      i++;
    }
    out.push({ openTimeMs: s * 1000, open, high, low, close: last, volume: 0 });
  }
  return out;
}
