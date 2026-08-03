import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import { validateConfig, diffConfigs, type AppConfig } from "@b5p/config";
import {
  auditEvents, configVersions, decisionSnapshots, engineKv, healthEvents, killSwitchEvents,
  marketTradeTicks, markets, orderFills, orders, pnlRecords, positions, researchMarkets,
  resolutions, riskDecisions, timingBucketStatistics, type DbHandle,
} from "@b5p/db";
import { closingMinuteBucket } from "@b5p/domain";
import { newId } from "@b5p/domain/ids";
import { CHANNELS, getLocalBus, makeBus, type Bus } from "@b5p/engine";
import { backfillResolvedMarkets, runTimingStats } from "@b5p/research";
import { desc, eq, inArray, sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthService } from "./auth";

export interface ApiDeps {
  db: DbHandle;
  bus: Bus;
  auth: AuthService;
  requireAuth: boolean;
}

const SESSION_COOKIE = "b5p_session";
const CSRF_COOKIE = "b5p_csrf";

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: false });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  const { db, bus, auth } = deps;

  // security headers for API responses
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
  });

  const sessionOf = (req: FastifyRequest) => auth.validate(req.cookies[SESSION_COOKIE]);

  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (!deps.requireAuth) return true;
    const s = sessionOf(req);
    if (!s) {
      await reply.code(401).send({ error: "unauthenticated" });
      return false;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      const header = req.headers["x-csrf-token"];
      if (!header || header !== s.csrfToken) {
        await reply.code(403).send({ error: "csrf token missing or invalid" });
        return false;
      }
    }
    return true;
  };

  // ---------- auth ----------

  app.post("/api/auth/login", async (req, reply) => {
    const body = z.object({ username: z.string(), password: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad request" });
    if (auth.rateLimited(req.ip)) return reply.code(429).send({ error: "too many attempts; wait a minute" });
    const result = await auth.login(body.data.username, body.data.password);
    if (!result) {
      await db.db.insert(auditEvents).values({ category: "auth", action: "login_failed", actor: body.data.username, correlationId: null, data: null, createdAtMs: Date.now() });
      return reply.code(401).send({ error: "invalid credentials" });
    }
    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true, sameSite: "lax", secure: false, path: "/",
    });
    reply.setCookie(CSRF_COOKIE, result.csrfToken, {
      httpOnly: false, sameSite: "lax", secure: false, path: "/",
    });
    await db.db.insert(auditEvents).values({ category: "auth", action: "login", actor: body.data.username, correlationId: null, data: null, createdAtMs: Date.now() });
    return { ok: true, csrfToken: result.csrfToken };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    auth.logout(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    const s = sessionOf(req);
    if (!s && deps.requireAuth) return reply.code(401).send({ error: "unauthenticated" });
    return { username: s?.username ?? "anonymous", csrfToken: s?.csrfToken ?? null };
  });

  // ---------- live state ----------

  app.get("/api/state", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const rows = await db.db.select().from(engineKv).where(eq(engineKv.key, "cockpit"));
    return rows[0]?.value ?? { engineState: "OFFLINE", note: "engine has not published state yet" };
  });

  app.get("/api/ws-ticket", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const s = sessionOf(req);
    return { ticket: auth.issueWsTicket(s ?? { username: "anonymous", createdAtMs: 0, expiresAtMs: 0, csrfToken: "" }) };
  });

  app.get("/api/ws", { websocket: true }, (socket, req) => {
    const url = new URL(req.url, "http://localhost");
    const ticket = url.searchParams.get("ticket") ?? undefined;
    if (deps.requireAuth && !auth.redeemWsTicket(ticket) && !sessionOf(req)) {
      socket.close(4401, "unauthenticated");
      return;
    }
    const un1 = bus.subscribe(CHANNELS.cockpit, (payload) => {
      try { socket.send(JSON.stringify({ channel: "cockpit", payload })); } catch { /* closed */ }
    });
    const un2 = bus.subscribe(CHANNELS.events, (payload) => {
      try { socket.send(JSON.stringify({ channel: "events", payload })); } catch { /* closed */ }
    });
    socket.on("close", () => { un1(); un2(); });
  });

  // ---------- markets / decisions / orders ----------

  app.get("/api/markets", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const limit = clampLimit((req.query as Record<string, string>).limit, 50);
    const rows = await db.db.select().from(markets).orderBy(desc(markets.endEpoch)).limit(limit);
    return rows.map(jsonSafe);
  });

  app.get("/api/decisions", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const limit = clampLimit((req.query as Record<string, string>).limit, 50);
    const snaps = await db.db.select({
      decisionId: decisionSnapshots.decisionId,
      marketId: decisionSnapshots.marketId,
      mode: decisionSnapshots.mode,
      createdAtMs: decisionSnapshots.createdAtMs,
    }).from(decisionSnapshots).orderBy(desc(decisionSnapshots.createdAtMs)).limit(limit);
    const ids = snaps.map((s) => s.decisionId);
    const risks = ids.length > 0
      ? await db.db.select().from(riskDecisions).where(inArray(riskDecisions.decisionId, ids))
      : [];
    const riskBy = new Map(risks.map((r) => [r.decisionId, r]));
    return snaps.map((s) => ({
      ...s,
      approved: riskBy.get(s.decisionId)?.approved ?? null,
      reasons: riskBy.get(s.decisionId)?.reasons ?? [],
    }));
  });

  app.get("/api/decisions/:id", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const id = (req.params as { id: string }).id;
    const snap = await db.db.select().from(decisionSnapshots).where(eq(decisionSnapshots.decisionId, id));
    if (snap.length === 0) return reply.code(404).send({ error: "not found" });
    const risk = await db.db.select().from(riskDecisions).where(eq(riskDecisions.decisionId, id));
    const ordersRows = await db.db.select().from(orders).where(eq(orders.decisionId, id));
    const orderIds = ordersRows.map((o) => o.id);
    const fills = orderIds.length > 0 ? await db.db.select().from(orderFills).where(inArray(orderFills.orderId, orderIds)) : [];
    return jsonSafe({ snapshot: snap[0], risk: risk[0] ?? null, orders: ordersRows, fills });
  });

  app.get("/api/orders", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const limit = clampLimit((req.query as Record<string, string>).limit, 100);
    const rows = await db.db.select().from(orders).orderBy(desc(orders.createdAtMs)).limit(limit);
    return rows.map(jsonSafe);
  });

  app.get("/api/positions", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const limit = clampLimit((req.query as Record<string, string>).limit, 100);
    const rows = await db.db.select().from(positions).orderBy(desc(positions.openedAtMs)).limit(limit);
    return rows.map(jsonSafe);
  });

  app.get("/api/resolutions", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const limit = clampLimit((req.query as Record<string, string>).limit, 100);
    const rows = await db.db.select().from(resolutions).orderBy(desc(resolutions.resolvedAtMs)).limit(limit);
    return rows.map(jsonSafe);
  });

  // ---------- P&L analytics ----------

  app.get("/api/pnl/summary", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const pnls = await db.db.select().from(pnlRecords).orderBy(desc(pnlRecords.createdAtMs)).limit(2000);
    const poss = await db.db.select().from(positions).orderBy(desc(positions.openedAtMs)).limit(2000);
    const mkts = await db.db.select({ id: markets.id, endEpoch: markets.endEpoch }).from(markets);
    const endEpochBy = new Map(mkts.map((m) => [m.id, m.endEpoch]));

    const byMode: Record<string, { gross: bigint; fees: bigint; net: bigint; n: number; wins: number }> = {};
    const byBucket: Record<string, { net: bigint; n: number; wins: number }> = {};
    let peak = 0n;
    let equity = 0n;
    let maxDrawdown = 0n;
    let longestLossStreak = 0;
    let streak = 0;

    for (const p of [...pnls].reverse()) {
      const m = (byMode[p.mode] ??= { gross: 0n, fees: 0n, net: 0n, n: 0, wins: 0 });
      m.gross += p.gross6;
      m.fees += p.fees6;
      m.net += p.net6;
      m.n += 1;
      if (p.net6 > 0n) m.wins += 1;
      equity += p.net6;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDrawdown) maxDrawdown = dd;
      if (p.net6 < 0n) { streak += 1; longestLossStreak = Math.max(longestLossStreak, streak); } else streak = 0;

      const end = endEpochBy.get(p.marketId);
      if (end !== undefined) {
        const bucket = closingMinuteBucket(end);
        const bb = (byBucket[bucket] ??= { net: 0n, n: 0, wins: 0 });
        bb.net += p.net6;
        bb.n += 1;
        if (p.net6 > 0n) bb.wins += 1;
      }
    }

    const openCount = poss.filter((p) => p.status === "OPEN").length;
    return jsonSafe({
      byMode,
      byClosingMinute: byBucket,
      maxDrawdown6: maxDrawdown,
      longestLossStreak,
      openPositions: openCount,
      totalRecords: pnls.length,
    });
  });

  // ---------- timing lab ----------

  app.get("/api/timing-lab", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const q = req.query as Record<string, string>;
    const latestRun = await db.db.select({ runId: timingBucketStatistics.runId, computedAtMs: timingBucketStatistics.computedAtMs, source: timingBucketStatistics.source })
      .from(timingBucketStatistics)
      .orderBy(desc(timingBucketStatistics.computedAtMs))
      .limit(1);
    const runId = q.runId ?? latestRun[0]?.runId;
    if (!runId) return { runs: [], rows: [] };
    const rows = await db.db.select().from(timingBucketStatistics).where(eq(timingBucketStatistics.runId, runId));
    const counted = await db.db.select({ n: sql<number>`count(*)` }).from(researchMarkets);
    return jsonSafe({
      runId,
      source: rows[0]?.source,
      computedAtMs: rows[0]?.computedAtMs,
      researchMarketCount: Number(counted[0]?.n ?? 0),
      rows,
      warning: "Outcome skew is not trading edge unless price fails to reflect it.",
    });
  });

  const backfillState = { running: false, progress: null as null | { scanned: number; found: number; total: number }, lastRunId: null as string | null, error: null as string | null };

  app.post("/api/timing-lab/refresh", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    if (backfillState.running) return reply.code(409).send({ error: "refresh already running", progress: backfillState.progress });
    const body = z.object({ hours: z.number().int().min(1).max(24 * 40).default(24) }).safeParse(req.body ?? {});
    const hours = body.success ? body.data.hours : 24;
    backfillState.running = true;
    backfillState.error = null;
    const nowEpoch = Math.floor(Date.now() / 1000);
    void (async () => {
      try {
        await backfillResolvedMarkets(db, {
          fromEpoch: nowEpoch - hours * 3600,
          toEpoch: nowEpoch,
          onProgress: (p) => { backfillState.progress = p; },
        });
        const run = await runTimingStats(db, { windowDaysList: [7, 14, 30] });
        backfillState.lastRunId = run.runId;
        await db.db.insert(healthEvents).values({ kind: "research", severity: "info", message: `timing-lab refresh complete (run ${run.runId})`, data: null, createdAtMs: Date.now() });
      } catch (e) {
        backfillState.error = String(e);
      } finally {
        backfillState.running = false;
      }
    })();
    return { started: true, hours };
  });

  app.get("/api/timing-lab/refresh/status", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    return backfillState;
  });

  // ---------- config ----------

  app.get("/api/config", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const rows = await db.db.select().from(configVersions).orderBy(desc(configVersions.version)).limit(20);
    const active = rows.find((r) => r.active) ?? rows[0];
    return jsonSafe({ active, history: rows });
  });

  app.post("/api/config", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const validation = validateConfig(req.body);
    if (!validation.ok) return reply.code(400).send({ error: "invalid configuration", issues: validation.issues });
    const rows = await db.db.select().from(configVersions).where(eq(configVersions.active, true));
    const current = rows.sort((a, b) => b.version - a.version)[0];
    const changed = diffConfigs(current?.config ?? {}, validation.config);
    if (changed.length === 0) return reply.code(400).send({ error: "no changes" });
    if (current) {
      await db.db.update(configVersions).set({ active: false }).where(eq(configVersions.version, current.version));
    }
    await db.db.insert(configVersions).values({
      config: validation.config as AppConfig,
      changedPaths: changed,
      actor: "operator",
      active: true,
      createdAtMs: Date.now(),
    });
    bus.publish(CHANNELS.control, { type: "config_reload" });
    await db.db.insert(auditEvents).values({
      category: "config", action: "update", actor: "operator", correlationId: null,
      data: { changed }, createdAtMs: Date.now(),
    });
    return { ok: true, changed };
  });

  // ---------- kill switch / mode ----------

  app.post("/api/kill", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const body = z.object({ reason: z.string().default("operator emergency stop") }).safeParse(req.body ?? {});
    const reason = body.success ? body.data.reason : "operator emergency stop";
    await db.db.insert(killSwitchEvents).values({ id: newId(), scope: "api", reason, actor: "operator", createdAtMs: Date.now() });
    bus.publish(CHANNELS.control, { type: "kill", reason, actor: "operator" });
    return { ok: true, note: "Emergency stop signaled. New orders disabled; resting order cancellation attempted; positions require manual review." };
  });

  app.post("/api/resume", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    bus.publish(CHANNELS.control, { type: "resume", actor: "operator" });
    await db.db.insert(auditEvents).values({ category: "engine", action: "resume_requested", actor: "operator", correlationId: null, data: null, createdAtMs: Date.now() });
    return { ok: true };
  });

  // ---------- live arming (real money) ----------
  // The engine enforces every arming rule; the API relays the request and
  // re-verifies the operator password (re-auth for live controls). The typed
  // acknowledgement phrase must match exactly (engine-side check).

  app.post("/api/arm", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const body = z.object({
      acknowledgement: z.string(),
      password: z.string(),
      ttlMinutes: z.number().int().min(1).max(120).default(30),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad request" });
    // re-authenticate for this sensitive control
    const ok = await auth.reverify(body.data.password);
    if (!ok) return reply.code(401).send({ error: "re-authentication failed" });
    bus.publish(CHANNELS.control, {
      type: "arm", actor: "operator",
      acknowledgement: body.data.acknowledgement,
      ttlMinutes: body.data.ttlMinutes,
    });
    await db.db.insert(auditEvents).values({ category: "live", action: "arm_requested", actor: "operator", correlationId: null, data: { ttlMinutes: body.data.ttlMinutes }, createdAtMs: Date.now() });
    return { ok: true, note: "Arm request sent. Watch /api/state (live.state) and health events for the result — the engine runs wallet reconciliation before arming." };
  });

  app.post("/api/disarm", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const body = z.object({ reason: z.string().default("operator manual disarm") }).safeParse(req.body ?? {});
    bus.publish(CHANNELS.control, { type: "disarm", actor: "operator", reason: body.success ? body.data.reason : "operator" });
    await db.db.insert(auditEvents).values({ category: "live", action: "disarm_requested", actor: "operator", correlationId: null, data: null, createdAtMs: Date.now() });
    return { ok: true };
  });

  // ---------- audit / health / misc ----------

  app.get("/api/audit", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const limit = clampLimit((req.query as Record<string, string>).limit, 200);
    const rows = await db.db.select().from(auditEvents).orderBy(desc(auditEvents.createdAtMs)).limit(limit);
    return rows.map(jsonSafe);
  });

  app.get("/api/health/events", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const limit = clampLimit((req.query as Record<string, string>).limit, 100);
    const rows = await db.db.select().from(healthEvents).orderBy(desc(healthEvents.createdAtMs)).limit(limit);
    return rows.map(jsonSafe);
  });

  app.get("/api/tutorial", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const rows = await db.db.select().from(engineKv).where(eq(engineKv.key, "tutorial_95c"));
    return rows[0]?.value ?? null;
  });

  app.get("/api/trades", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const limit = clampLimit((req.query as Record<string, string>).limit, 200);
    const rows = await db.db.select().from(marketTradeTicks).orderBy(desc(marketTradeTicks.sourceTsMs)).limit(limit);
    return rows.map(jsonSafe);
  });

  app.get("/api/healthz", async () => ({ ok: true, ts: Date.now() }));

  return app;
}

export async function makeApiBus(): Promise<Bus> {
  return process.env.REDIS_URL ? makeBus() : getLocalBus();
}

function clampLimit(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(500, Math.floor(n)) : dflt;
}

function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val))) as T;
}
