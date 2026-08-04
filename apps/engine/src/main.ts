import type { AppConfig } from "@b5p/config";
import {
  MarketDataStore, configVersions, makeDb,
  type MarketDataEventInput, type PersistedMarketDataEvent,
} from "@b5p/db";
import { prob, shares, usdc } from "@b5p/domain";
import { canonicalObjectHash } from "@b5p/pair-execution";
import {
  BinanceKlinesPoller, ClobMarketWs, GammaClient,
  POLYMARKET_CLOB_V2_USDC_TAKER_FEE_CONTRACT, PublicClobTokenTermsSource,
  RtdsClient, tsToMs,
} from "@b5p/polymarket";
import { eq } from "drizzle-orm";
import { makeBus } from "./bus";
import { Engine } from "./engine";
import { logger } from "./log";
import { PairCaptureQueue, type PairMarketDataRecord } from "./pair-capture-queue";
import { PairAccountStore } from "./pair-account-store";
import { PairPortfolioStore } from "./pair-portfolio-store";
import { createPairSubsystem, type PairSubsystem } from "./pair-subsystem";
import { ENGINE_VERSION } from "./snapshot";

/**
 * Standalone engine entry point. In embedded dev mode the API imports
 * createEngineRuntime() instead and runs this wiring in-process.
 */
export interface EngineRuntime {
  engine: Engine;
  pairSubsystem: PairSubsystem;
  stop(): Promise<void>;
}

export function releasePersistedPairObserverBoundaries(input: {
  readonly persisted: readonly PersistedMarketDataEvent[];
  readonly pending: Map<string, { readonly marketId: string; readonly envelopeId: string }>;
  readonly durableSequences: Map<string, bigint>;
  readonly maximumRetainedSequences: number;
  readonly markDirty: (marketId: string, envelopeId: string) => "SCHEDULED" | "COALESCED" | "DUPLICATE" | "UNREGISTERED";
}): number {
  let released = 0;
  for (const event of input.persisted) {
    if (event.eventKind !== "ENVELOPE_BOUNDARY") continue;
    const pending = input.pending.get(event.envelopeId);
    if (pending === undefined) continue;
    input.durableSequences.set(event.envelopeId, event.id);
    input.pending.delete(event.envelopeId);
    const mark = input.markDirty(pending.marketId, pending.envelopeId);
    if (mark === "UNREGISTERED") input.durableSequences.delete(event.envelopeId);
    else released += 1;
  }
  while (input.durableSequences.size > input.maximumRetainedSequences) {
    const oldest = input.durableSequences.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    input.durableSequences.delete(oldest);
  }
  return released;
}

export async function createEngineRuntime(): Promise<EngineRuntime> {
  const db = await makeDb();
  await db.migrate();
  const bus = await makeBus();

  const modeEnv = process.env.ENGINE_MODE;
  const gamma = new GammaClient();

  // The validated config's app.mode decides the engine mode (observe | paper |
  // shadow); ENGINE_MODE env overrides it. `live` is NOT a bootable mode —
  // live trading is entered at runtime through the arming flow — so a config
  // requesting `live` boots as paper with a warning.
  const cfgRows = await db.db.select().from(configVersions).where(eq(configVersions.active, true));
  const cfgRow = cfgRows.sort((a, b) => b.version - a.version)[0];
  const cfgMode = (cfgRow?.config as AppConfig | undefined)?.app.mode ?? "paper";
  const requested = modeEnv ?? cfgMode;
  const mode: "observe" | "paper" | "shadow" =
    requested === "observe" ? "observe" : requested === "shadow" ? "shadow" : "paper";
  if (requested === "live") {
    logger.warn("app.mode 'live' is not bootable; starting in paper. Live trading requires the runtime arming flow.");
  }
  if (modeEnv && modeEnv !== cfgMode) {
    logger.info("ENGINE_MODE env overrides config app.mode", { env: modeEnv, config: cfgMode });
  }
  const engine = new Engine(db, bus, mode);
  await engine.start(Date.now());

  let activeClobEpoch: string | null = null;
  let captureQueueRef: PairCaptureQueue | null = null;
  const pendingObserverEnvelopes = new Map<string, { readonly marketId: string; readonly envelopeId: string }>();
  const durableEnvelopeSequences = new Map<string, bigint>();
  const pairAccountSessionKey = `pair-runtime:${ENGINE_VERSION}:config:${engine.configVersion}`;
  const pairAccountId = `pairacct_${canonicalObjectHash({ pairAccountSessionKey }).slice(0, 32)}`;
  const pairStartingCash6 = usdc(engine.cfg.risk.starting_paper_bankroll_usdc);
  const pairAccounts = new PairAccountStore(db);
  await pairAccounts.createAccount({
    id: pairAccountId,
    sessionKey: pairAccountSessionKey,
    sourceConfigVersion: engine.configVersion,
    startingCash6: pairStartingCash6,
    dailyBucketUtc: new Date().toISOString().slice(0, 10),
    createdAtMs: Date.now(),
  });
  const pairPortfolios = new PairPortfolioStore(db);
  const pairTermsSource = new PublicClobTokenTermsSource({
    feeCollectionContract: POLYMARKET_CLOB_V2_USDC_TAKER_FEE_CONTRACT,
    nowMs: Date.now,
  });
  const pairTermsHealth = () => pairTermsSource.health({
    tokenIds: engine.subscriptionTokens(Math.floor(Date.now() / 1000)).filter((tokenId) => tokenId.trim().length > 0),
    asOfMs: Date.now(),
    maximumFeeAgeMs: engine.cfg.pair.maximum_fee_snapshot_age_ms,
    maximumConstraintAgeMs: engine.cfg.pair.maximum_constraint_snapshot_age_ms,
  });
  const pairSubsystem = await createPairSubsystem({
    db,
    config: engine.cfg,
    configVersion: engine.configVersion,
    sourceVersion: ENGINE_VERSION,
    startupRunKey: `engine:${Date.now()}:${process.pid}`,
    engine,
    termsSource: pairTermsSource,
    portfolio: async ({ asOfMs }) => {
      const directional = engine.accounting.state();
      return pairPortfolios.snapshot({
        accountId: pairAccountId,
        referenceBankroll6: pairStartingCash6,
        directionalFreeCash6: directional.bankroll > 0n ? directional.bankroll : 0n,
        globalAppMode: engine.cfg.app.mode,
        directionalLiveArmed: engine.live.isArmed(asOfMs),
        asOfMs,
      });
    },
    requestedCashCap6: ({ portfolio, policy }) => {
      const configured = (portfolio.referenceBankroll6 * policy.maximumCashFractionPpm) / 1_000_000n;
      const absolute = (portfolio.referenceBankroll6 * policy.hardRiskConstant.valuePpm) / 1_000_000n;
      return [configured, absolute, portfolio.pairCashAvailable6, portfolio.sharedCapAvailable6]
        .reduce((lowest, value) => value < lowest ? value : lowest);
    },
    maximumObserverMarkets: 64,
    nowMs: Date.now,
    captureSequence: ({ trigger }) => {
      if (trigger.kind !== "CLOB_ENVELOPE") throw new Error("non-CLOB observer trigger has no durable market-data sequence");
      const sequence = durableEnvelopeSequences.get(trigger.id);
      if (sequence === undefined) throw new Error(`durable sequence unavailable for envelope ${trigger.id}`);
      return sequence;
    },
    onObserverResult: (result) => {
      if (result.trigger.kind === "CLOB_ENVELOPE") durableEnvelopeSequences.delete(result.trigger.id);
    },
    onObserverHealth: (code, detail) => logger.warn("pair observer health event", { code, ...detail }),
    healthSources: {
      captureQueueDepth: () => captureQueueRef?.metrics().depth ?? 0,
      captureQueueOverflowed: () => (captureQueueRef?.metrics().unhealthyMarketCount ?? 0) > 0,
      captureGapUnbounded: () => (captureQueueRef?.metrics().unhealthyMarketCount ?? 0) > 0,
      invalidMarketCount: () => captureQueueRef?.metrics().unhealthyMarketCount ?? 0,
      feeTermsHealthy: () => pairTermsHealth().feeTermsHealthy,
      constraintTermsHealthy: () => pairTermsHealth().constraintTermsHealthy,
      lastFeeSnapshotAtMs: () => pairTermsHealth().lastFeeSnapshotAtMs,
      lastConstraintSnapshotAtMs: () => pairTermsHealth().lastConstraintSnapshotAtMs,
    },
  });
  logger.info("pair subsystem initialized", {
    observerConfigured: pairSubsystem.capability.observerConfigured,
    paperSchedulingConfigured: pairSubsystem.capability.paperSchedulingConfigured,
    paperSchedulingAllowed: pairSubsystem.capability.paperSchedulingAllowed,
    unwiredReasons: pairSubsystem.capability.unwiredReasons,
  });

  const marketDataStore = new MarketDataStore(db.db);
  const captureQueue = new PairCaptureQueue({
    capacity: engine.cfg.pair.capture_queue_capacity,
    batchSize: engine.cfg.pair.market_event_batch_size,
    persistBatch: async (batch) => {
      const rows: MarketDataEventInput[] = batch.map((record) => ({
        marketId: record.marketId, tokenId: record.tokenId, eventKind: record.kind,
        connectionEpoch: record.connectionEpoch, envelopeId: record.envelopeId,
        sequenceInEnvelope: record.sequenceInEnvelope, sourceEventId: record.sourceEventId ?? null,
        sourceTsMs: record.sourceTsMs,
        sourceTimestampKind: record.sourceTsMs === null ? "RECEIVE_FALLBACK" : "SOURCE",
        receivedTsMs: record.receivedTsMs, exchangeHash: record.exchangeHash ?? null,
        payload: record.payload, createdAtMs: record.createdAtMs,
      }));
      const persisted = await marketDataStore.appendBatch(rows);
      // Strict observer evaluation is released only after the entire envelope,
      // including its boundary row, commits. The boundary row id is the exact
      // durable receive sequence used by capture identity/replay.
      releasePersistedPairObserverBoundaries({
        persisted,
        pending: pendingObserverEnvelopes,
        durableSequences: durableEnvelopeSequences,
        maximumRetainedSequences: engine.cfg.pair.capture_queue_capacity,
        markDirty: (marketId, envelopeId) => pairSubsystem.observer.markDirty(marketId, {
          kind: "CLOB_ENVELOPE",
          id: envelopeId,
        }),
      });
    },
    onContinuityLost: (marketId, code) => {
      const epoch = activeClobEpoch ?? "capture-overflow";
      engine.invalidatePairBooksForMarket(marketId, epoch);
      logger.error("pair market-data capture continuity lost", { marketId, code, epoch });
    },
  });
  captureQueueRef = captureQueue;

  // Exactly one complete-envelope hook. It records pending observer work; the
  // persistence callback above is solely responsible for releasing it.
  engine.setPairEnvelopeDirtyMarker((marketId, envelopeId) => {
    pendingObserverEnvelopes.set(envelopeId, Object.freeze({ marketId, envelopeId }));
  });

  const enqueueEnvelope = (records: readonly PairMarketDataRecord[]) => {
    const result = captureQueue.enqueueEnvelope(records);
    if (result !== "ENQUEUED") {
      const envelopeId = records[0]?.envelopeId;
      if (envelopeId !== undefined) pendingObserverEnvelopes.delete(envelopeId);
      logger.warn("pair market-data envelope not enqueued", { marketId: records[0]?.marketId, envelopeId, result });
    }
    return result;
  };

  // --- feeds
  const rtds = new RtdsClient({
    onTick: (t) => engine.onReferenceTick(t),
    onClockSample: (skew) => engine.onClockSample(skew),
    onStatus: (s, d) => logger.info("rtds status", { status: s, detail: d }),
  });
  rtds.start();

  const tokenToMarket = new Map<string, string>();
  const marketTokens = new Map<string, readonly [string, string]>();
  const registeredPairMarkets = new Map<string, { readonly conditionId: string; readonly upTokenId: string; readonly downTokenId: string }>();
  const marketIdForToken = (tokenId: string, sourceMarketId: string): string => tokenToMarket.get(tokenId) ?? sourceMarketId;
  let clobEnvelopeOrdinal = 0;
  const clob = new ClobMarketWs({
    onBook: (msg, ts, meta) => {
      const marketId = marketIdForToken(msg.asset_id, msg.market);
      const sourceTs = msg.timestamp === undefined ? null : tsToMs(msg.timestamp, ts);
      engine.onBookSnapshot(msg.asset_id, msg.bids, msg.asks, sourceTs ?? 0, ts, {
        connectionEpoch: meta.connectionEpoch,
        exchangeHash: msg.hash ?? null,
        marketId,
      });
      const envelopeId = `book:${meta.connectionEpoch}:${ts}:${++clobEnvelopeOrdinal}`;
      pendingObserverEnvelopes.set(envelopeId, Object.freeze({ marketId, envelopeId }));
      enqueueEnvelope([
        {
          kind: "SNAPSHOT", marketId, tokenId: msg.asset_id, connectionEpoch: meta.connectionEpoch,
          envelopeId, sequenceInEnvelope: 0, sourceTsMs: sourceTs, receivedTsMs: ts,
          exchangeHash: msg.hash ?? null, createdAtMs: ts,
          payload: {
            bids: msg.bids.map((level) => ({ price6: prob(level.price).toString(), size6: shares(level.size).toString() })),
            asks: msg.asks.map((level) => ({ price6: prob(level.price).toString(), size6: shares(level.size).toString() })),
            bookVersion: engine.bookFor(msg.asset_id).bookVersion.toString(),
          },
        },
        { kind: "ENVELOPE_BOUNDARY", marketId, tokenId: null, connectionEpoch: meta.connectionEpoch, envelopeId, sequenceInEnvelope: 1, sourceTsMs: sourceTs, receivedTsMs: ts, createdAtMs: ts, payload: { eventKind: "book" } },
      ]);
    },
    // §12.2: the whole price_change envelope crosses the engine boundary as
    // one unit — never fanned out per level (no torn intermediate book).
    onPriceChange: (msg, ts, meta) => {
      const envelopeId = `change:${meta.connectionEpoch}:${ts}:${++clobEnvelopeOrdinal}`;
      const marketId = msg.price_changes.length === 0
        ? msg.market
        : marketIdForToken(msg.price_changes[0]!.asset_id, msg.market);
      const sourceTs = msg.timestamp === undefined ? null : tsToMs(msg.timestamp, ts);
      engine.onPriceChangeEnvelope({
        envelopeId,
        marketId,
        sourceTsMs: sourceTs ?? 0,
        receivedTsMs: ts,
        changes: msg.price_changes.map((c) => ({
          assetId: c.asset_id, price: c.price, size: c.size, side: c.side, hash: c.hash,
        })),
        meta: { connectionEpoch: meta.connectionEpoch },
      });
      const grouped = new Map<string, typeof msg.price_changes>();
      for (const change of msg.price_changes) grouped.set(change.asset_id, [...(grouped.get(change.asset_id) ?? []), change]);
      const records: PairMarketDataRecord[] = [];
      for (const [tokenId, changes] of grouped) {
        records.push({
          kind: "DELTA", marketId, tokenId, connectionEpoch: meta.connectionEpoch,
          envelopeId, sequenceInEnvelope: records.length, sourceTsMs: sourceTs, receivedTsMs: ts,
          exchangeHash: changes[changes.length - 1]?.hash ?? null, createdAtMs: ts,
          payload: {
            changes: changes.map((change) => ({
              side: change.side, price6: prob(change.price).toString(), size6: shares(change.size).toString(),
            })),
            bookVersion: engine.bookFor(tokenId).bookVersion.toString(),
          },
        });
      }
      records.push({ kind: "ENVELOPE_BOUNDARY", marketId, tokenId: null, connectionEpoch: meta.connectionEpoch, envelopeId, sequenceInEnvelope: records.length, sourceTsMs: sourceTs, receivedTsMs: ts, createdAtMs: ts, payload: { eventKind: "price_change", changeCount: msg.price_changes.length } });
      enqueueEnvelope(records);
    },
    onLastTrade: (msg, ts, meta) => {
      const marketId = marketIdForToken(msg.asset_id, msg.market);
      const sourceTs = msg.timestamp === undefined ? null : tsToMs(msg.timestamp, ts);
      engine.onTrade(msg.asset_id, msg.price, msg.size ?? "0", sourceTs ?? 0)
        .catch((e) => logger.warn("trade ingestion failed; message dropped", { error: String(e), tokenId: msg.asset_id }));
      if (msg.size !== undefined && sourceTs !== null) {
        const envelopeId = `trade:${meta.connectionEpoch}:${ts}:${++clobEnvelopeOrdinal}`;
        enqueueEnvelope([
          { kind: "TRADE", marketId, tokenId: msg.asset_id, connectionEpoch: meta.connectionEpoch, envelopeId, sequenceInEnvelope: 0, sourceTsMs: sourceTs, receivedTsMs: ts, createdAtMs: ts, payload: { price6: prob(msg.price).toString(), size6: shares(msg.size).toString(), side: msg.side ?? null } },
          { kind: "ENVELOPE_BOUNDARY", marketId, tokenId: null, connectionEpoch: meta.connectionEpoch, envelopeId, sequenceInEnvelope: 1, sourceTsMs: sourceTs, receivedTsMs: ts, createdAtMs: ts, payload: { eventKind: "last_trade_price" } },
        ]);
      }
    },
    // §12.3: reconnect barrier — invalidate every book before any message of
    // the new connection arrives; only fresh same-epoch snapshots revive them.
    onEpochChange: (epoch, prevEpoch) => {
      activeClobEpoch = epoch;
      engine.onConnectionEpochChange(epoch, prevEpoch);
      for (const marketId of marketTokens.keys()) {
        const ts = Date.now();
        const envelopeId = `reset:${epoch}:${ts}:${++clobEnvelopeOrdinal}`;
        enqueueEnvelope([
          { kind: "CONNECTION_RESET", marketId, tokenId: null, connectionEpoch: epoch, envelopeId, sequenceInEnvelope: 0, sourceTsMs: null, receivedTsMs: ts, createdAtMs: ts, payload: { previousEpoch: prevEpoch } },
          { kind: "ENVELOPE_BOUNDARY", marketId, tokenId: null, connectionEpoch: epoch, envelopeId, sequenceInEnvelope: 1, sourceTsMs: null, receivedTsMs: ts, createdAtMs: ts, payload: { eventKind: "connection_reset" } },
        ]);
      }
    },
    onStatus: (s, d) => logger.info("clob ws status", { status: s, detail: d }),
  });
  clob.start();

  const klines = new BinanceKlinesPoller({
    pollIntervalMs: 5000,
    onUpdate: (c) => engine.onCandles(c),
    onError: (e) => logger.warn("binance klines error", { error: e }),
  });
  klines.start();

  // --- discovery loop
  let discovering = false;
  const discover = async () => {
    if (discovering) return;
    discovering = true;
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const parsed = await gamma.discoverWindows(engine.cfg.market.slug_prefix, nowSec, engine.cfg.market.discover_ahead_windows);
      // refresh recently finished windows too, for official-outcome cross-checks
      for (const back of [1, 2, 3]) {
        const slot = Math.floor(nowSec / 300) * 300 - back * 300;
        const ev = await gamma.fetchEventBySlug(engine.cfg.market.slug_prefix + slot);
        if (ev) {
          const { parseFiveMinMarket } = await import("@b5p/polymarket");
          const p = parseFiveMinMarket(ev);
          if (p) parsed.push(p);
        }
      }
      await engine.upsertDiscoveredMarkets(parsed, Date.now());
      const desired = new Map(parsed
        .filter((market) => market.upTokenId && market.downTokenId && !market.closed && market.endEpoch >= nowSec)
        .map((market) => [market.marketId, market] as const));
      for (const [marketId, registered] of registeredPairMarkets) {
        const next = desired.get(marketId);
        const unchanged = next !== undefined && next.conditionId === registered.conditionId
          && next.upTokenId === registered.upTokenId && next.downTokenId === registered.downTokenId;
        if (unchanged) continue;
        if (!pairSubsystem.observer.unregisterMarket(marketId)) continue;
        captureQueue.unregisterMarket(marketId);
        registeredPairMarkets.delete(marketId);
        marketTokens.delete(marketId);
        tokenToMarket.delete(registered.upTokenId);
        tokenToMarket.delete(registered.downTokenId);
      }
      for (const market of desired.values()) {
        const prior = registeredPairMarkets.get(market.marketId);
        if (prior !== undefined) continue;
        tokenToMarket.set(market.upTokenId, market.marketId);
        tokenToMarket.set(market.downTokenId, market.marketId);
        marketTokens.set(market.marketId, [market.upTokenId, market.downTokenId]);
        captureQueue.registerMarket(market.marketId, market.upTokenId, market.downTokenId);
        const registered = pairSubsystem.observer.registerMarket({
          marketId: market.marketId,
          conditionId: market.conditionId,
          upTokenId: market.upTokenId,
          downTokenId: market.downTokenId,
          mode: pairSubsystem.configuredAuthority.paperSchedulingEnabled ? "paper" : "observe",
        });
        if (registered) {
          registeredPairMarkets.set(market.marketId, Object.freeze({
            conditionId: market.conditionId,
            upTokenId: market.upTokenId,
            downTokenId: market.downTokenId,
          }));
        } else {
          captureQueue.unregisterMarket(market.marketId);
          marketTokens.delete(market.marketId);
          tokenToMarket.delete(market.upTokenId);
          tokenToMarket.delete(market.downTokenId);
        }
      }
      clob.setAssets(engine.subscriptionTokens(nowSec));
    } catch (e) {
      logger.warn("discovery error", { error: String(e) });
      // surface in the health log too: a wedged discovery loop idles the
      // whole engine with nothing visible in the cockpit otherwise
      void engine.health("warning", "discovery", `market discovery cycle failed: ${String(e)}`);
    } finally {
      discovering = false;
    }
  };
  await discover();
  const discoveryTimer = setInterval(() => void discover(), 20_000);

  // --- main loop
  let stepping = false;
  const stepTimer = setInterval(() => {
    if (stepping) return;
    stepping = true;
    engine.step(Date.now())
      .catch((e) => logger.error("engine step error", { error: String(e), stack: (e as Error).stack }))
      .finally(() => { stepping = false; });
  }, 500);
  let captureFlushing = false;
  const captureFlushTimer = setInterval(() => {
    if (captureFlushing) return;
    captureFlushing = true;
    captureQueue.flushOneBatch()
      .catch((error) => logger.error("pair market-data capture flush failed", { error: String(error), depth: captureQueue.metrics().depth }))
      .finally(() => { captureFlushing = false; });
  }, engine.cfg.pair.observer_flush_interval_ms);
  let pairMaintaining = false;
  const pairMaintenanceTimer = setInterval(() => {
    if (pairMaintaining) return;
    pairMaintaining = true;
    const nowMs = Date.now();
    pairSubsystem.refreshHealth()
      .then(async (health) => {
        if (pairSubsystem.facade !== null && pairSubsystem.authority.paperSchedulingEnabled && health.paperSchedulingAllowed) {
          await pairSubsystem.facade.advance(nowMs);
        }
      })
      .catch((error) => logger.error("pair subsystem maintenance failed", { error: String(error) }))
      .finally(() => { pairMaintaining = false; });
  }, engine.cfg.pair.reconcile_interval_ms);

  logger.info("engine runtime started", { mode: engine.mode, db: db.kind, bus: bus.kind });
  // #27: a standalone engine process with a process-LOCAL bus cannot receive
  // API control messages (kill/arm/disarm/resume). The DB-polled kill
  // fallback still works, but everything else is dead — say so loudly.
  if (!process.env.EMBED_ENGINE && process.env.DATABASE_URL && bus.kind === "local") {
    void engine.health("critical", "control",
      "split-process engine without REDIS_URL: bus control messages (arm/disarm/resume/config-reload) CANNOT reach this process; only the kill switch works, via DB polling. Set REDIS_URL.");
  }

  return {
    engine,
    pairSubsystem,
    stop: async () => {
      clearInterval(discoveryTimer);
      clearInterval(stepTimer);
      clearInterval(captureFlushTimer);
      clearInterval(pairMaintenanceTimer);
      engine.setPairEnvelopeDirtyMarker(null);
      for (const marketId of registeredPairMarkets.keys()) pairSubsystem.observer.unregisterMarket(marketId);
      pendingObserverEnvelopes.clear();
      durableEnvelopeSequences.clear();
      engine.stop();
      rtds.stop();
      clob.stop();
      klines.stop();
      try { await captureQueue.flushAll(); } catch (error) { logger.error("final pair capture flush failed", { error: String(error), depth: captureQueue.metrics().depth }); }
      await db.close();
    },
  };
}

// standalone execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const runtime = await createEngineRuntime();
  const shutdown = async () => {
    logger.info("engine shutting down");
    await runtime.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // Last-resort isolation: an escaped exception/rejection becomes a
  // controlled HALT (orders canceled, live disarmed, health event) instead of
  // silent process death that abandons resting orders on the exchange.
  const fatal = (kind: string) => (err: unknown) => {
    logger.error(`${kind}; halting engine (fail closed)`, { error: String(err), stack: (err as Error)?.stack });
    void runtime.engine.halt(`${kind}: ${String(err)}`, Date.now()).catch(() => undefined);
  };
  process.on("uncaughtException", fatal("uncaught exception"));
  process.on("unhandledRejection", fatal("unhandled rejection"));
}
