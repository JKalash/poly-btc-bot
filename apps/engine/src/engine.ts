import { DEFAULT_CONFIG, type AppConfig } from "@b5p/config";
import {
  auditEvents, configVersions, decisionSnapshots, engineKv, featureSnapshots, healthEvents,
  killSwitchEvents, marketRuleSnapshots, markets as marketsTable, orderIntents, orders,
  referencePriceTicks, resolutions, riskDecisions, signalCandidates, type DbHandle,
} from "@b5p/db";
import {
  ENGINE_TRANSITIONS, MARKET_TRANSITIONS, canTransition, makerEdgeSatisfied, parseFixed,
  ppm, prob, roundSharesToLot, sharesForStake, shares as sharesOf, usdc,
  type EngineState, type MarketInstanceState, type MarketRef, type Mode, type OutcomeSide,
  type Ppm, type Prob6, type ReferenceTick, type Usdc6,
} from "@b5p/domain";
import { idempotencyKey, newId, sha256Hex } from "@b5p/domain/ids";
import type { ParsedFiveMinMarket } from "@b5p/polymarket";
import { evaluateOrderRisk, RISK_PROFILES, clampCustomProfile, type RiskContext } from "@b5p/risk";
import {
  BookState, MODELS, STRATEGY_PRESETS, TickBuffer, computeFeatures, computeIndicators,
  presetAllowsMode, type Candle, type FeatureSet, type PresetContext, type StrategyDecision,
} from "@b5p/strategy";
import { eq } from "drizzle-orm";
import { Accounting } from "./accounting";
import { CHANNELS, type Bus } from "./bus";
import { LiveController, minArmUsdc, type ArmRequest } from "./live";
import { logger } from "./log";
import { PaperExecutor } from "./paper";
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
      },
      (tokenId) => this.books.get(tokenId) ?? null,
    );
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
    }

    const active = this.activeMarket(nowMs);
    if (active) {
      await this.evaluateMarket(active, nowMs);
      await this.maintainRestingOrders(active, nowMs);
    }
    await this.resolveDue(nowMs);
    await this.publishCockpit(nowMs);
  }

  activeMarket(nowMs: number): MarketRuntime | null {
    const nowSec = nowMs / 1000;
    for (const rt of this.markets.values()) {
      if (rt.ref.startEpoch <= nowSec && nowSec < rt.ref.endEpoch) return rt;
    }
    return null;
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
      // Paper/shadow require the model be paper-approved. When live-armed the
      // operator has explicitly accepted an unproven model (typed arm
      // acknowledgement), so these two governance gates pass; all economic and
      // safety gates below remain in force.
      modelApprovedForMode: liveArmed ? true : (this.mode === "paper" || this.mode === "shadow" ? model.approvedForPaper : model.approvedForLive),
      // calibration_required is a config policy, not an arming governance gate:
      // it holds in every mode, including live-armed. Trading an uncalibrated
      // model requires the explicit config change calibration_required: false.
      calibrationRequired: this.cfg.strategy.calibration_required,
      modelCalibrated: model.calibrated,
      strategyValidatedForMode: true,
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
      this.transitionMarket(rt, "REJECTED");
      this.transitionMarket(rt, "OBSERVING");
      this.emitEvent({ type: "decision_rejected", decisionId, marketId: rt.ref.marketId, reasons: verdict.reasons.map((r) => r.code) });
      return;
    }

    this.transitionMarket(rt, "RISK_APPROVED");
    this.usedIdempotencyKeys.add(idemKey);
    const intentId = newId();
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

    if (decisionMode === "shadow") {
      await this.audit("order", "shadow_would_submit", { decisionId, side, price: price6, shares: shares6 });
      this.emitEvent({ type: "shadow_would_submit", decisionId, marketId: rt.ref.marketId });
      this.transitionMarket(rt, "OBSERVING");
      return;
    }

    // LIVE path: real order via the CLOB adapter.
    if (liveArmed) {
      this.transitionMarket(rt, "ORDER_PENDING");
      const tokenId = side === "UP" ? rt.ref.upTokenId : rt.ref.downTokenId;
      const res = await this.live.submit({
        decisionId, intentId, marketId: rt.ref.marketId, tokenId, outcomeSide: side,
        style, price6, shares6, stake6, tickSize6: rt.tickSize6, negRisk: false,
        ...(style === "maker_post_only" ? { expireAtMs: (rt.ref.endEpoch - this.cfg.strategy.cancel_seconds_remaining) * 1000 } : {}),
        idempotencyKey: idemKey, nowMs,
      });
      if (res.ok) {
        this.live.markOpen(rt.ref.marketId);
        this.transitionMarket(rt, res.status === "MATCHED" ? "FILLED" : "RESTING");
        await this.audit("order", "live_submitted", { decisionId, orderId: res.orderId, side, price: price6, shares: shares6, stake: stake6, status: res.status });
        this.emitEvent({ type: "live_order", orderId: res.orderId, marketId: rt.ref.marketId, decisionId, status: res.status });
      } else {
        this.transitionMarket(rt, "REJECTED");
        this.transitionMarket(rt, "OBSERVING");
        await this.audit("order", "live_rejected", { decisionId, reason: res.reason });
        this.emitEvent({ type: "live_rejected", decisionId, marketId: rt.ref.marketId, reason: res.reason });
      }
      return;
    }

    this.transitionMarket(rt, "ORDER_PENDING");
    const order = await this.paper.submit({
      decisionId,
      intentId,
      marketId: rt.ref.marketId,
      tokenId: side === "UP" ? rt.ref.upTokenId : rt.ref.downTokenId,
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

  // ---------- resolution ----------

  async resolveDue(nowMs: number): Promise<void> {
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
