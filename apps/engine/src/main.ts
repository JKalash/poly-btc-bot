import type { AppConfig } from "@b5p/config";
import { configVersions, makeDb } from "@b5p/db";
import {
  BinanceKlinesPoller, ClobMarketWs, GammaClient, RtdsClient, tsToMs,
} from "@b5p/polymarket";
import { eq } from "drizzle-orm";
import { makeBus } from "./bus";
import { Engine } from "./engine";
import { logger } from "./log";

/**
 * Standalone engine entry point. In embedded dev mode the API imports
 * createEngineRuntime() instead and runs this wiring in-process.
 */
export interface EngineRuntime {
  engine: Engine;
  stop(): Promise<void>;
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

  // --- feeds
  const rtds = new RtdsClient({
    onTick: (t) => engine.onReferenceTick(t),
    onClockSample: (skew) => engine.onClockSample(skew),
    onStatus: (s, d) => logger.info("rtds status", { status: s, detail: d }),
  });
  rtds.start();

  const tokenToMarket = new Map<string, string>();
  const clob = new ClobMarketWs({
    onBook: (msg, ts) => {
      engine.onBookSnapshot(msg.asset_id, msg.bids, msg.asks, tsToMs(msg.timestamp, ts), ts);
    },
    onPriceChange: (msg, ts) => {
      for (const c of msg.price_changes) {
        engine.onPriceChange(c.asset_id, c.price, c.size, c.side, tsToMs(msg.timestamp, ts), ts);
      }
    },
    onLastTrade: (msg, ts) => {
      // caught: an out-of-spec trade payload must drop the message, not kill
      // the process via an unhandled rejection
      engine.onTrade(msg.asset_id, msg.price, msg.size ?? "0", tsToMs(msg.timestamp, ts))
        .catch((e) => logger.warn("trade ingestion failed; message dropped", { error: String(e), tokenId: msg.asset_id }));
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
    stop: async () => {
      clearInterval(discoveryTimer);
      clearInterval(stepTimer);
      engine.stop();
      rtds.stop();
      clob.stop();
      klines.stop();
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
