import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import { validateConfig, diffConfigs, type AppConfig } from "@b5p/config";
import {
  auditEvents, boundaryPriceObservations, calibrationArtifacts, configVersions, ctfOperations,
  datasetManifests, decisionSnapshots, engineKv, executionTimelineEvents, experimentDefinitions,
  experimentObservations, experimentRuns, feedBasisEstimates, fillCounterfactuals,
  fillSelectionCostRecords, healthEvents, hedgeActions, inventorySnapshots, killSwitchEvents,
  latencySamples, liquidityRewardAccruals, marketTradeTicks, markets, markoutObservations,
  orderAttempts, orderFills, orders, pairedLegs, pairedQuoteCycles, paperVariantResults,
  pnlRecords, positions, queueEstimates, rebateAccruals, researchMarkets, resolutions,
  riskDecisions, signalCandidates, sourceEvidence, strategyPromotionDecisions,
  timingBucketStatistics, type DbHandle,
} from "@b5p/db";
import {
  ACCRUAL_STATES, BOUNDARY_KINDS, closingMinuteBucket, CTF_OPERATION_KINDS, HEDGE_ACTION_KINDS,
  isRiskFree, PAIRED_CYCLE_STATES, PAIRED_LEG_STATES, type PairedCycleState, type PairedLegState,
} from "@b5p/domain";
import { newId } from "@b5p/domain/ids";
import { CHANNELS, getLocalBus, makeBus, METRICS_CONTENT_TYPE, metricsRegistry, type Bus } from "@b5p/engine";
import { backfillResolvedMarkets, runTimingStats } from "@b5p/research";
import { desc, eq, inArray, sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthService, REMEMBERED_SESSION_TTL_SECONDS, timingSafeStringEqual } from "./auth";
import { PairReadModelRepository, type PairReadCapability } from "./pair-read-repository";
import { registerPairReadRoutes, type PairReadRouteRepository } from "./pair-routes";

export interface ApiDeps {
  db: DbHandle;
  bus: Bus;
  auth: AuthService;
  requireAuth: boolean;
  pairReadRepository?: PairReadRouteRepository;
  pairReadCapability?: PairReadCapability;
  pairRuntimeHealth?: () => Readonly<Record<string, unknown>>;
  pairReadNowMs?: () => number;
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
      if (typeof header !== "string" || !timingSafeStringEqual(header, s.csrfToken)) {
        await reply.code(403).send({ error: "csrf token missing or invalid" });
        return false;
      }
    }
    return true;
  };

  const pairReadRepository = deps.pairReadRepository ?? new PairReadModelRepository(db, {
    capability: deps.pairReadCapability ?? {
      observerEnabled: true,
      paperExecutionEnabled: false,
      liveExecutionAvailable: false,
      strategyVersion: "complete_set_pair_v0_RESEARCH_ONLY",
    },
    runtimeHealth: deps.pairRuntimeHealth,
  });
  registerPairReadRoutes(app, { repository: pairReadRepository, guard, nowMs: deps.pairReadNowMs });

  // ---------- auth ----------

  app.post("/api/auth/login", async (req, reply) => {
    const body = z.object({
      username: z.string(),
      password: z.string(),
      remember: z.boolean().optional().default(false),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad request" });
    if (auth.rateLimited(req.ip)) return reply.code(429).send({ error: "too many attempts; wait a minute" });
    const result = await auth.login(body.data.username, body.data.password, body.data.remember);
    if (!result) {
      await db.db.insert(auditEvents).values({ category: "auth", action: "login_failed", actor: body.data.username, correlationId: null, data: null, createdAtMs: Date.now() });
      return reply.code(401).send({ error: "invalid credentials" });
    }
    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true, sameSite: "lax", secure: false, path: "/",
      ...(body.data.remember ? { maxAge: REMEMBERED_SESSION_TTL_SECONDS } : {}),
    });
    reply.setCookie(CSRF_COOKIE, result.csrfToken, {
      httpOnly: false, sameSite: "lax", secure: false, path: "/",
      ...(body.data.remember ? { maxAge: REMEMBERED_SESSION_TTL_SECONDS } : {}),
    });
    await db.db.insert(auditEvents).values({ category: "auth", action: "login", actor: body.data.username, correlationId: null, data: null, createdAtMs: Date.now() });
    return { ok: true, csrfToken: result.csrfToken };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    auth.logout(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
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

  // ---------- execution lab (read-only telemetry; tables fill once the engine
  // records execution-quality events — every route degrades to an empty payload) ----------

  const TELEMETRY_NOTE = "execution telemetry unavailable (tables missing or migration not applied)";

  app.get("/api/execution/timelines", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const q = req.query as Record<string, string>;
    const limit = Math.min(100, clampLimit(q.limit, 25));
    try {
      let intentIds: string[];
      if (q.intentId) {
        intentIds = [q.intentId];
      } else {
        const recent = await db.db.select({
          intentId: executionTimelineEvents.intentId,
          last: sql<number>`max(${executionTimelineEvents.tsMs})`,
        }).from(executionTimelineEvents)
          .groupBy(executionTimelineEvents.intentId)
          .orderBy(desc(sql`max(${executionTimelineEvents.tsMs})`))
          .limit(limit);
        intentIds = recent.map((r) => r.intentId);
      }
      if (intentIds.length === 0) return { intents: [] };
      const events = await db.db.select().from(executionTimelineEvents)
        .where(inArray(executionTimelineEvents.intentId, intentIds))
        .orderBy(executionTimelineEvents.tsMs);
      const attempts = await db.db.select().from(orderAttempts)
        .where(inArray(orderAttempts.intentId, intentIds))
        .orderBy(orderAttempts.attemptNumber);
      const evBy = new Map<string, typeof events>();
      for (const e of events) {
        const list = evBy.get(e.intentId) ?? [];
        list.push(e);
        evBy.set(e.intentId, list);
      }
      const atBy = new Map<string, typeof attempts>();
      for (const a of attempts) {
        const list = atBy.get(a.intentId) ?? [];
        list.push(a);
        atBy.set(a.intentId, list);
      }
      const intents = intentIds.flatMap((id) => {
        const evs = evBy.get(id) ?? [];
        if (evs.length === 0) return [];
        const first = evs[0]!;
        const lastEv = evs[evs.length - 1]!;
        return [{
          intentId: id,
          correlationId: first.correlationId,
          mode: first.mode,
          firstTsMs: first.tsMs,
          lastTsMs: lastEv.tsMs,
          lastState: lastEv.state,
          events: evs.map((e) => ({ id: e.id, state: e.state, tsMs: e.tsMs, attemptId: e.attemptId, detail: e.detail })),
          attempts: (atBy.get(id) ?? []).map((a) => ({
            id: a.id, attemptNumber: a.attemptNumber, side: a.side, price6: a.price6, size6: a.size6,
            remaining6: a.remaining6, timeInForce: a.timeInForce, postOnly: a.postOnly, status: a.status,
            createdAtMs: a.createdAtMs, updatedAtMs: a.updatedAtMs,
          })),
        }];
      });
      // most recent activity first
      intents.sort((a, b) => b.lastTsMs - a.lastTsMs);
      return jsonSafe({ intents });
    } catch {
      return { intents: [], note: TELEMETRY_NOTE };
    }
  });

  app.get("/api/execution/funnel", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    try {
      const rows = await db.db.select({
        state: executionTimelineEvents.state,
        intents: sql<number>`count(distinct ${executionTimelineEvents.intentId})`,
      }).from(executionTimelineEvents).groupBy(executionTimelineEvents.state);
      const total = await db.db.select({ n: sql<number>`count(distinct ${executionTimelineEvents.intentId})` })
        .from(executionTimelineEvents);
      return {
        states: rows.map((r) => ({ state: r.state, intents: Number(r.intents) })),
        totalIntents: Number(total[0]?.n ?? 0),
      };
    } catch {
      return { states: [], totalIntents: 0, note: TELEMETRY_NOTE };
    }
  });

  app.get("/api/execution/latency", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    try {
      const rows = await db.db.select({
        stage: latencySamples.stage,
        n: sql<number>`count(*)`,
        p50Us: sql<number>`percentile_cont(0.5) within group (order by ${latencySamples.durationUs})`,
        p90Us: sql<number>`percentile_cont(0.9) within group (order by ${latencySamples.durationUs})`,
        p99Us: sql<number>`percentile_cont(0.99) within group (order by ${latencySamples.durationUs})`,
        maxUs: sql<number>`max(${latencySamples.durationUs})`,
      }).from(latencySamples).groupBy(latencySamples.stage);
      return {
        stages: rows.map((r) => ({
          stage: r.stage, n: Number(r.n),
          p50Us: Number(r.p50Us), p90Us: Number(r.p90Us), p99Us: Number(r.p99Us), maxUs: Number(r.maxUs),
        })),
      };
    } catch {
      return { stages: [], note: TELEMETRY_NOTE };
    }
  });

  app.get("/api/execution/markout", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    try {
      const rows = await db.db.select({
        horizonMs: markoutObservations.horizonMs,
        n: sql<number>`count(*)`,
        sumMarkout6: sql<string>`coalesce(sum(${markoutObservations.markout6}), 0)::text`,
        medianMarkout6: sql<string | null>`(percentile_cont(0.5) within group (order by ${markoutObservations.markout6}))::bigint::text`,
        adverseCount: sql<number>`sum(case when ${markoutObservations.markout6} < 0 then 1 else 0 end)`,
      }).from(markoutObservations).groupBy(markoutObservations.horizonMs);
      // horizon_ms is TEXT (incl. "AT_RESOLUTION"): the UI orders horizons explicitly.
      return {
        horizons: rows.map((r) => ({
          horizonMs: r.horizonMs, n: Number(r.n), sumMarkout6: r.sumMarkout6,
          medianMarkout6: r.medianMarkout6, adverseCount: Number(r.adverseCount),
        })),
      };
    } catch {
      return { horizons: [], note: TELEMETRY_NOTE };
    }
  });

  app.get("/api/execution/paper-variants", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    try {
      const agg = await db.db.select({
        variant: paperVariantResults.variant,
        decisions: sql<number>`count(*)`,
        filledCount: sql<number>`sum(case when ${paperVariantResults.filled} then 1 else 0 end)`,
        resolved: sql<number>`count(${paperVariantResults.pnl6})`,
        wins: sql<number>`sum(case when ${paperVariantResults.pnl6} > 0 then 1 else 0 end)`,
        net6: sql<string>`coalesce(sum(${paperVariantResults.pnl6}), 0)::text`,
        fees6: sql<string>`coalesce(sum(case when ${paperVariantResults.pnl6} is not null then ${paperVariantResults.fee6} else 0 end), 0)::text`,
        avgFillPrice6: sql<string | null>`(sum(${paperVariantResults.fillPrice6}::numeric * ${paperVariantResults.fillSize6}) / nullif(sum(${paperVariantResults.fillSize6}), 0))::bigint::text`,
      }).from(paperVariantResults).groupBy(paperVariantResults.variant);

      // resolved rows in time order for drawdown / streak (exact bigint walk)
      const resolvedRows = await db.db.select({
        variant: paperVariantResults.variant,
        pnl6: paperVariantResults.pnl6,
      }).from(paperVariantResults)
        .where(sql`${paperVariantResults.pnl6} is not null`)
        .orderBy(paperVariantResults.tsMs)
        .limit(5000);
      const walk = new Map<string, { equity: bigint; peak: bigint; maxDd: bigint; streak: number; longest: number }>();
      for (const r of resolvedRows) {
        const w = walk.get(r.variant) ?? { equity: 0n, peak: 0n, maxDd: 0n, streak: 0, longest: 0 };
        const p = r.pnl6 ?? 0n;
        w.equity += p;
        if (w.equity > w.peak) w.peak = w.equity;
        if (w.peak - w.equity > w.maxDd) w.maxDd = w.peak - w.equity;
        if (p < 0n) { w.streak += 1; w.longest = Math.max(w.longest, w.streak); } else w.streak = 0;
        walk.set(r.variant, w);
      }
      return jsonSafe({
        variants: agg.map((a) => {
          const w = walk.get(a.variant);
          return {
            variant: a.variant,
            decisions: Number(a.decisions),
            filledCount: Number(a.filledCount),
            resolved: Number(a.resolved),
            wins: Number(a.wins),
            net6: a.net6,
            fees6: a.fees6,
            gross6: (BigInt(a.net6) + BigInt(a.fees6)).toString(),
            avgFillPrice6: a.avgFillPrice6,
            maxDrawdown6: (w?.maxDd ?? 0n).toString(),
            longestLossStreak: w?.longest ?? 0,
          };
        }),
        note: "pnl_records remain the QUEUE_REPLAY paper path; variants are alternative fill assumptions over the same decisions and are never merged.",
      });
    } catch {
      return { variants: [], note: TELEMETRY_NOTE };
    }
  });

  app.get("/api/execution/queue", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    try {
      const methods = await db.db.select({
        method: queueEstimates.method,
        n: sql<number>`count(*)`,
        avgAhead6: sql<string | null>`avg(${queueEstimates.aheadShares6})::bigint::text`,
        medianAhead6: sql<string | null>`(percentile_cont(0.5) within group (order by ${queueEstimates.aheadShares6}))::bigint::text`,
      }).from(queueEstimates).groupBy(queueEstimates.method);
      const cf = await db.db.select({
        n: sql<number>`count(*)`,
        wouldFill: sql<number>`coalesce(sum(case when ${fillCounterfactuals.wouldFill} then 1 else 0 end), 0)`,
      }).from(fillCounterfactuals);
      const reasons = await db.db.select({
        reason: fillCounterfactuals.reason,
        n: sql<number>`count(*)`,
        wouldFill: sql<number>`sum(case when ${fillCounterfactuals.wouldFill} then 1 else 0 end)`,
      }).from(fillCounterfactuals).groupBy(fillCounterfactuals.reason).orderBy(desc(sql`count(*)`)).limit(6);
      return {
        methods: methods.map((m) => ({ method: m.method, n: Number(m.n), avgAhead6: m.avgAhead6, medianAhead6: m.medianAhead6 })),
        counterfactuals: {
          n: Number(cf[0]?.n ?? 0),
          wouldFill: Number(cf[0]?.wouldFill ?? 0),
          reasons: reasons.map((r) => ({ reason: r.reason, n: Number(r.n), wouldFill: Number(r.wouldFill) })),
        },
      };
    } catch {
      return { methods: [], counterfactuals: { n: 0, wouldFill: 0, reasons: [] }, note: TELEMETRY_NOTE };
    }
  });

  app.get("/api/execution/fill-quality", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    // quoted-vs-filled / partial / missed / maker-taker from the core order tables
    const ords = await db.db.select({
      id: orders.id, orderSide: orders.orderSide, price6: orders.price6,
      shares6: orders.shares6, filledShares6: orders.filledShares6,
    }).from(orders).orderBy(desc(orders.createdAtMs)).limit(2000);
    const orderIds = ords.map((o) => o.id);
    const fills = orderIds.length > 0
      ? await db.db.select().from(orderFills).where(inArray(orderFills.orderId, orderIds))
      : [];
    const byOrder = new Map(ords.map((o) => [o.id, o]));

    let full = 0, partial = 0, none = 0;
    let quotedNum = 0n, quotedDen = 0n;
    for (const o of ords) {
      if (o.filledShares6 <= 0n) none += 1;
      else if (o.filledShares6 >= o.shares6) full += 1;
      else partial += 1;
      if (o.filledShares6 > 0n) {
        quotedNum += o.price6 * o.filledShares6;
        quotedDen += o.filledShares6;
      }
    }
    let filledNum = 0n, filledDen = 0n, slipNum = 0n;
    let makerFills = 0, takerFills = 0, makerShares = 0n, takerShares = 0n;
    for (const f of fills) {
      filledNum += f.price6 * f.shares6;
      filledDen += f.shares6;
      const o = byOrder.get(f.orderId);
      if (o) {
        const diff = o.orderSide === "BUY" ? f.price6 - o.price6 : o.price6 - f.price6;
        slipNum += diff * f.shares6;
      }
      if (f.maker) { makerFills += 1; makerShares += f.shares6; } else { takerFills += 1; takerShares += f.shares6; }
    }

    // cancel races come from the timeline (guarded: telemetry may not exist yet)
    let cancelRaces = { requested: 0, lostToFill: 0 };
    try {
      const cr = await db.db.select({
        intentId: executionTimelineEvents.intentId,
        t: sql<number>`min(${executionTimelineEvents.tsMs})`,
      }).from(executionTimelineEvents)
        .where(eq(executionTimelineEvents.state, "CANCEL_REQUESTED"))
        .groupBy(executionTimelineEvents.intentId);
      if (cr.length > 0) {
        const fl = await db.db.select({
          intentId: executionTimelineEvents.intentId,
          t: sql<number>`max(${executionTimelineEvents.tsMs})`,
        }).from(executionTimelineEvents)
          .where(inArray(executionTimelineEvents.state, ["PARTIAL_FILL", "FILLED"]))
          .groupBy(executionTimelineEvents.intentId);
        const fillBy = new Map(fl.map((r) => [r.intentId, Number(r.t)]));
        cancelRaces = {
          requested: cr.length,
          lostToFill: cr.filter((r) => (fillBy.get(r.intentId) ?? Number.NEGATIVE_INFINITY) >= Number(r.t)).length,
        };
      }
    } catch { /* telemetry tables absent — leave zeros */ }

    return jsonSafe({
      orders: { total: ords.length, full, partial, none },
      quoted: {
        avgQuoted6: quotedDen > 0n ? (quotedNum / quotedDen).toString() : null,
        avgFilled6: filledDen > 0n ? (filledNum / filledDen).toString() : null,
        slippagePerShare6: filledDen > 0n ? (slipNum / filledDen).toString() : null,
      },
      makerTaker: { makerFills, takerFills, makerShares6: makerShares, takerShares6: takerShares },
      cancelRaces,
    });
  });

  // ---------- strategy comparison ----------

  app.get("/api/strategy/comparison", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const decisionIdOf = sql`${signalCandidates.detail} ->> 'decisionId'`;

    // candidates per strategy (existing tables)
    const cand = await db.db.select({
      sv: signalCandidates.strategyVersion,
      total: sql<number>`count(*)`,
      approved: sql<number>`sum(case when ${signalCandidates.status} = 'RISK_APPROVED' then 1 else 0 end)`,
    }).from(signalCandidates).groupBy(signalCandidates.strategyVersion);

    // orders + fills per strategy, via the candidate's decision id
    const fillAgg = await db.db.select({
      sv: signalCandidates.strategyVersion,
      placed: sql<number>`count(distinct ${orders.id})`,
      filledOrders: sql<number>`count(distinct case when ${orders.filledShares6} > 0 then ${orders.id} end)`,
      fillCount: sql<number>`count(${orderFills.id})`,
      shares6: sql<string>`coalesce(sum(${orderFills.shares6}), 0)::text`,
      avgPrice6: sql<string | null>`(sum(${orderFills.price6}::numeric * ${orderFills.shares6}) / nullif(sum(${orderFills.shares6}), 0))::bigint::text`,
      slip6: sql<string | null>`(sum((case when ${orders.orderSide} = 'BUY' then ${orderFills.price6} - ${orders.price6} else ${orders.price6} - ${orderFills.price6} end)::numeric * ${orderFills.shares6}) / nullif(sum(${orderFills.shares6}), 0))::bigint::text`,
    }).from(signalCandidates)
      .innerJoin(orders, sql`${orders.decisionId} = ${decisionIdOf}`)
      .leftJoin(orderFills, eq(orderFills.orderId, orders.id))
      .groupBy(signalCandidates.strategyVersion);

    // resolved outcomes per strategy, in resolution order (drawdown / streak / CI)
    const pnlRows = await db.db.select({
      sv: signalCandidates.strategyVersion,
      pnl6: positions.pnl6,
    }).from(signalCandidates)
      .innerJoin(positions, sql`${positions.decisionId} = ${decisionIdOf}`)
      .where(sql`${positions.pnl6} is not null`)
      .orderBy(positions.resolvedAtMs)
      .limit(5000);

    // gross / fees decomposition from pnl_records
    const feeAgg = await db.db.select({
      sv: signalCandidates.strategyVersion,
      gross6: sql<string>`coalesce(sum(${pnlRecords.gross6}), 0)::text`,
      fees6: sql<string>`coalesce(sum(${pnlRecords.fees6}), 0)::text`,
    }).from(signalCandidates)
      .innerJoin(positions, sql`${positions.decisionId} = ${decisionIdOf}`)
      .innerJoin(pnlRecords, eq(pnlRecords.positionId, positions.id))
      .groupBy(signalCandidates.strategyVersion);

    // adverse selection proxy: avg 30s side-adjusted markout, linked via correlation id
    const advBy = new Map<string, { n: number; avg6: string }>();
    try {
      const adv = await db.db.select({
        sv: signalCandidates.strategyVersion,
        n: sql<number>`count(*)`,
        avg6: sql<string>`avg(${markoutObservations.markout6})::bigint::text`,
      }).from(signalCandidates)
        .innerJoin(decisionSnapshots, sql`${decisionSnapshots.decisionId} = ${decisionIdOf}`)
        .innerJoin(markoutObservations, eq(markoutObservations.correlationId, decisionSnapshots.correlationId))
        .where(eq(markoutObservations.horizonMs, "30000"))
        .groupBy(signalCandidates.strategyVersion);
      for (const a of adv) advBy.set(a.sv, { n: Number(a.n), avg6: a.avg6 });
    } catch { /* markout table absent — leave empty */ }

    // promotion decisions (latest per strategy; an active one wins)
    const promos = await db.db.select().from(strategyPromotionDecisions)
      .orderBy(desc(strategyPromotionDecisions.decidedAtMs)).limit(500);
    const promoBy = new Map<string, typeof promos[number]>();
    for (const p of promos) {
      // rows arrive newest-first: keep the latest, but let an active decision win
      const cur = promoBy.get(p.strategyVersion);
      if (!cur || (p.active && !cur.active)) promoBy.set(p.strategyVersion, p);
    }
    const calibIds = [...promoBy.values()].map((p) => p.calibrationArtifactId).filter((x): x is string => x !== null);
    const calibs = calibIds.length > 0
      ? await db.db.select().from(calibrationArtifacts).where(inArray(calibrationArtifacts.id, calibIds))
      : [];
    const calibBy = new Map(calibs.map((c) => [c.id, c]));

    // portfolio-level fill-selection cost: latest aggregate window (market_id null preferred)
    let fillSelectionCost: Record<string, unknown> | null = null;
    try {
      const fscRows = await db.db.select().from(fillSelectionCostRecords)
        .orderBy(desc(fillSelectionCostRecords.tsMs)).limit(50);
      const f = fscRows.find((r) => r.marketId === null) ?? fscRows[0];
      if (f) {
        fillSelectionCost = {
          signalConditionedValue6: f.signalConditionedValue6,
          fillConditionedValue6: f.fillConditionedValue6,
          cost6: f.cost6,
          signalSampleCount: f.signalSampleCount,
          fillSampleCount: f.fillSampleCount,
          windowStartMs: f.windowStartMs,
          windowEndMs: f.windowEndMs,
        };
      }
    } catch { /* table absent */ }

    // realized outcome walks per strategy (exact bigint)
    const outcomes = new Map<string, { pnls: bigint[]; equity: bigint; peak: bigint; maxDd: bigint; streak: number; longest: number; wins: number; net: bigint }>();
    for (const r of pnlRows) {
      const w = outcomes.get(r.sv) ?? { pnls: [], equity: 0n, peak: 0n, maxDd: 0n, streak: 0, longest: 0, wins: 0, net: 0n };
      const p = r.pnl6 ?? 0n;
      w.pnls.push(p);
      w.net += p;
      if (p > 0n) w.wins += 1;
      w.equity += p;
      if (w.equity > w.peak) w.peak = w.equity;
      if (w.peak - w.equity > w.maxDd) w.maxDd = w.peak - w.equity;
      if (p < 0n) { w.streak += 1; w.longest = Math.max(w.longest, w.streak); } else w.streak = 0;
      outcomes.set(r.sv, w);
    }
    const feeBy = new Map(feeAgg.map((f) => [f.sv, f]));
    const fillBy = new Map(fillAgg.map((f) => [f.sv, f]));

    const versions = [...new Set([...cand.map((c) => c.sv), ...promoBy.keys()])].sort();
    const strategies = versions.map((sv) => {
      const c = cand.find((x) => x.sv === sv);
      const f = fillBy.get(sv);
      const w = outcomes.get(sv);
      const fee = feeBy.get(sv);
      const promo = promoBy.get(sv);
      const evidence = promo ? (promo.evidence as {
        walkForward?: { folds: number; brier: number; logLoss: number; ece: number; n: number; purged: boolean };
        netEvPerCost?: { mean: number; ciLo: number; ciHi: number; n: number };
        frictions?: { feesIncluded: boolean; spreadIncluded: boolean; latencyIncluded: boolean; adverseSelectionIncluded: boolean };
      } | null) : null;
      const calib = promo?.calibrationArtifactId ? calibBy.get(promo.calibrationArtifactId) : undefined;
      const calibMetrics = calib ? (calib.metrics as { brier: number; logLoss: number; ece: number; n: number }) : null;

      // realized per-trade net CI (95%, normal approximation) — display-grade floats at the edge
      let ci6: { lo: string; hi: string } | null = null;
      if (w && w.pnls.length >= 2) {
        const xs = w.pnls.map((p) => Number(p));
        const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
        const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
        const half = 1.96 * sd / Math.sqrt(xs.length);
        ci6 = { lo: String(Math.round(mean - half)), hi: String(Math.round(mean + half)) };
      }

      return {
        strategyVersion: sv,
        candidates: { total: Number(c?.total ?? 0), approved: Number(c?.approved ?? 0) },
        orders: { placed: Number(f?.placed ?? 0), filled: Number(f?.filledOrders ?? 0) },
        fills: {
          count: Number(f?.fillCount ?? 0),
          shares6: f?.shares6 ?? "0",
          avgPrice6: f?.avgPrice6 ?? null,
          slippagePerShare6: f?.slip6 ?? null,
        },
        outcomes: w ? {
          resolved: w.pnls.length,
          wins: w.wins,
          net6: w.net.toString(),
          gross6: fee?.gross6 ?? "0",
          fees6: fee?.fees6 ?? "0",
          maxDrawdown6: w.maxDd.toString(),
          longestLossStreak: w.longest,
          ci6,
        } : null,
        adverse: advBy.get(sv) ? { n: advBy.get(sv)!.n, avgMarkout30s6: advBy.get(sv)!.avg6 } : null,
        evidence: evidence ? {
          brier: evidence.walkForward?.brier ?? null,
          logLoss: evidence.walkForward?.logLoss ?? null,
          ece: evidence.walkForward?.ece ?? null,
          n: evidence.walkForward?.n ?? null,
          folds: evidence.walkForward?.folds ?? null,
          purged: evidence.walkForward?.purged ?? null,
          netEvPerCost: evidence.netEvPerCost ?? null,
          frictions: evidence.frictions ?? null,
        } : null,
        calibration: calib && calibMetrics ? {
          method: calib.method,
          brier: calibMetrics.brier, logLoss: calibMetrics.logLoss, ece: calibMetrics.ece, n: calibMetrics.n,
        } : null,
        promotion: promo ? {
          status: promo.approved ? "PROMOTED" as const : "NOT_PROMOTED" as const,
          reasons: (promo.reasons as string[]) ?? [],
          mode: promo.mode,
          decidedAtMs: promo.decidedAtMs,
          active: promo.active,
        } : { status: "NO_DECISION" as const, reasons: [], mode: null, decidedAtMs: null, active: false },
      };
    });

    return jsonSafe({
      strategies,
      fillSelectionCost,
      notes: [
        "Score strength is not probability.",
        "Being filled can be adverse information.",
        "No trade is a valid decision.",
      ],
    });
  });

  // ---------- evidence lab (read-only provenance; rows arrive from seed-evidence
  // and the R1–R8/R11 reproduction runners — every route degrades to a
  // well-formed empty payload, and a failed reproduction is a result) ----------

  // Mirrors packages/evidence/src/labels.ts EVIDENCE_LABELS. apps/api does not
  // depend on @b5p/evidence (workspace link not declared); keep this list in
  // sync with that module — the vocabulary only changes alongside a migration.
  const EVIDENCE_LABEL_LIST = [
    "SOURCE_CLAIM_UNVERIFIED",
    "OFFICIAL_CURRENT_AT_RETRIEVAL",
    "REPRODUCED_MATCH",
    "REPRODUCED_MISMATCH",
    "DATA_GATED",
    "INTERNAL_HYPOTHESIS",
    "LIVE_VALIDATED",
    "REJECTED_ANTI_PATTERN",
  ] as const;
  const zeroLabelCounts = (): Record<string, number> =>
    Object.fromEntries(EVIDENCE_LABEL_LIST.map((l) => [l, 0]));
  const EVIDENCE_NOTE = "evidence tables unavailable (migration not applied)";
  const LEDGER_NOTES = [
    "A failed reproduction is a result.",
    "No live order can be created by any unverified source claim.",
  ];

  interface ManifestFileEntry { path: string; sha256: string | null; bytes: number | null; rows: number | null }

  app.get("/api/evidence/ledger", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    try {
      const rows = await db.db.select().from(sourceEvidence)
        .orderBy(sourceEvidence.sourceKey, sourceEvidence.claimKey);
      const runIds = [...new Set(rows.map((r) => r.reproductionRunId).filter((x): x is string => x !== null))];
      const runs = runIds.length > 0
        ? await db.db.select({
            id: experimentRuns.id, definitionId: experimentRuns.definitionId, runKey: experimentRuns.runKey,
            status: experimentRuns.status, startedAtMs: experimentRuns.startedAtMs,
            finishedAtMs: experimentRuns.finishedAtMs, codeVersion: experimentRuns.codeVersion,
            resultChecksum: experimentRuns.resultChecksum, datasetManifestIds: experimentRuns.datasetManifestIds,
          }).from(experimentRuns).where(inArray(experimentRuns.id, runIds))
        : [];
      const defIds = [...new Set(runs.map((r) => r.definitionId))];
      const defs = defIds.length > 0
        ? await db.db.select({
            id: experimentDefinitions.id, experimentKey: experimentDefinitions.experimentKey,
            title: experimentDefinitions.title, status: experimentDefinitions.status,
          }).from(experimentDefinitions).where(inArray(experimentDefinitions.id, defIds))
        : [];
      const manifestIds = [...new Set(runs.flatMap((r) => (r.datasetManifestIds as string[] | null) ?? []))];
      const manifests = manifestIds.length > 0
        ? await db.db.select({
            id: datasetManifests.id, datasetKey: datasetManifests.datasetKey, title: datasetManifests.title,
            materialized: datasetManifests.materialized, contentChecksum: datasetManifests.contentChecksum,
          }).from(datasetManifests).where(inArray(datasetManifests.id, manifestIds))
        : [];
      const runBy = new Map(runs.map((r) => [r.id, r]));
      const defBy = new Map(defs.map((d) => [d.id, d]));
      const manifestBy = new Map(manifests.map((m) => [m.id, m]));

      const counts = zeroLabelCounts();
      for (const r of rows) counts[r.label] = (counts[r.label] ?? 0) + 1;

      const claims = rows.map((r) => {
        const run = r.reproductionRunId ? runBy.get(r.reproductionRunId) ?? null : null;
        const def = run ? defBy.get(run.definitionId) ?? null : null;
        const datasets = run
          ? ((run.datasetManifestIds as string[] | null) ?? []).flatMap((id) => {
              const m = manifestBy.get(id);
              return m ? [m] : [];
            })
          : [];
        return {
          id: r.id, sourceKey: r.sourceKey, claimKey: r.claimKey, title: r.title,
          claimText: r.claimText, claimedValue: r.claimedValue, units: r.units,
          label: r.label, url: r.url, retrievedAtMs: r.retrievedAtMs,
          reproducedValue: r.reproducedValue, methodologyNotes: r.methodologyNotes,
          configVersion: r.configVersion, createdAtMs: r.createdAtMs, updatedAtMs: r.updatedAtMs,
          reproduction: run ? {
            runId: run.id, runKey: run.runKey, status: run.status,
            startedAtMs: run.startedAtMs, finishedAtMs: run.finishedAtMs,
            codeVersion: run.codeVersion, resultChecksum: run.resultChecksum,
            definitionId: run.definitionId,
            experimentKey: def?.experimentKey ?? null, experimentTitle: def?.title ?? null,
            dataGated: datasets.some((d) => !d.materialized),
          } : null,
          datasets,
        };
      });
      return jsonSafe({ claims, counts, labels: EVIDENCE_LABEL_LIST, notes: LEDGER_NOTES });
    } catch {
      return { claims: [], counts: zeroLabelCounts(), labels: EVIDENCE_LABEL_LIST, notes: LEDGER_NOTES, note: EVIDENCE_NOTE };
    }
  });

  app.get("/api/evidence/experiments", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    try {
      const defs = await db.db.select().from(experimentDefinitions)
        .orderBy(experimentDefinitions.experimentKey);
      if (defs.length === 0) return { experiments: [] };
      // resultSummary is intentionally omitted (it can be tens of KB — the full
      // study JSON); resultChecksum identifies the artifact byte-exactly.
      const runs = await db.db.select({
        id: experimentRuns.id, definitionId: experimentRuns.definitionId, runKey: experimentRuns.runKey,
        params: experimentRuns.params, datasetManifestIds: experimentRuns.datasetManifestIds,
        codeVersion: experimentRuns.codeVersion, configVersion: experimentRuns.configVersion,
        status: experimentRuns.status, startedAtMs: experimentRuns.startedAtMs,
        finishedAtMs: experimentRuns.finishedAtMs, resultChecksum: experimentRuns.resultChecksum,
      }).from(experimentRuns).orderBy(desc(experimentRuns.startedAtMs));
      const runIds = runs.map((r) => r.id);
      const obs = runIds.length > 0
        ? await db.db.select().from(experimentObservations)
            .where(inArray(experimentObservations.runId, runIds))
            .orderBy(experimentObservations.metric, experimentObservations.scope)
        : [];
      const manifests = await db.db.select({
        id: datasetManifests.id, datasetKey: datasetManifests.datasetKey, materialized: datasetManifests.materialized,
      }).from(datasetManifests);
      const materializedByKey = new Map<string, boolean>();
      for (const m of manifests) {
        materializedByKey.set(m.datasetKey, (materializedByKey.get(m.datasetKey) ?? false) || m.materialized);
      }
      const materializedById = new Map(manifests.map((m) => [m.id, m.materialized]));
      const runsBy = new Map<string, typeof runs>();
      for (const r of runs) {
        const list = runsBy.get(r.definitionId) ?? [];
        list.push(r);
        runsBy.set(r.definitionId, list);
      }
      const obsBy = new Map<string, typeof obs>();
      for (const o of obs) {
        const list = obsBy.get(o.runId) ?? [];
        list.push(o);
        obsBy.set(o.runId, list);
      }
      const experiments = defs.map((d) => {
        const datasetKeys = (d.datasetKeys as string[] | null) ?? [];
        return {
          id: d.id, experimentKey: d.experimentKey, title: d.title,
          hypothesis: d.hypothesis, nullHypothesis: d.nullHypothesis,
          primaryMetric: d.primaryMetric, successCriteria: d.successCriteria,
          status: d.status, foldPlan: d.foldPlan, datasetKeys,
          sourceEvidenceIds: (d.sourceEvidenceIds as string[] | null) ?? [],
          // gated when the declared status says so, or any required dataset has
          // no materialized manifest — awaiting data, never faked.
          dataGated: d.status === "DATA_GATED" || datasetKeys.some((k) => materializedByKey.get(k) !== true),
          createdAtMs: d.createdAtMs, updatedAtMs: d.updatedAtMs,
          runs: (runsBy.get(d.id) ?? []).map((r) => {
            const ids = (r.datasetManifestIds as string[] | null) ?? [];
            return {
              id: r.id, runKey: r.runKey, status: r.status,
              startedAtMs: r.startedAtMs, finishedAtMs: r.finishedAtMs,
              codeVersion: r.codeVersion, configVersion: r.configVersion,
              resultChecksum: r.resultChecksum, params: r.params,
              datasetManifestIds: ids,
              dataGated: ids.some((id) => materializedById.get(id) !== true),
              observations: (obsBy.get(r.id) ?? []).map((o) => ({
                id: o.id, metric: o.metric, scope: o.scope, value: o.value,
                valueText: o.valueText, n: o.n, ciLo: o.ciLo, ciHi: o.ciHi,
              })),
            };
          }),
        };
      });
      return jsonSafe({ experiments });
    } catch {
      return { experiments: [], note: EVIDENCE_NOTE };
    }
  });

  app.get("/api/evidence/manifests", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    try {
      const rows = await db.db.select().from(datasetManifests).orderBy(datasetManifests.datasetKey);
      return jsonSafe({
        manifests: rows.map((m) => {
          const files = (m.files as ManifestFileEntry[] | null) ?? [];
          return {
            id: m.id, datasetKey: m.datasetKey, title: m.title, source: m.source,
            license: m.license, contentChecksum: m.contentChecksum, materialized: m.materialized,
            rowCount: m.rowCount, timeRangeStartMs: m.timeRangeStartMs, timeRangeEndMs: m.timeRangeEndMs,
            schemaDescription: m.schemaDescription, retrievedAtMs: m.retrievedAtMs, createdAtMs: m.createdAtMs,
            files,
            fileCount: files.length,
            checksummedFiles: files.filter((f) => f.sha256 !== null).length,
          };
        }),
      });
    } catch {
      return { manifests: [], note: EVIDENCE_NOTE };
    }
  });

  // ---------- inventory lab (read-only over the R10 paired-cycle simulator's
  // tables; the simulator is paper/shadow only and OFF by default, so these
  // routes usually serve well-formed empty payloads — and degrade to the same
  // shapes with a note when the tables are absent) ----------

  const INVENTORY_NOTE = "inventory simulation tables unavailable (migration not applied)";
  /** Mirrors inventory_research.maximum_one_leg_seconds (refinement brief): 2s. */
  const ONE_LEG_CAP_MS = 2000;
  const CYCLE_NOTES = [
    "A split position is not risk-free while a leg is open.",
    "One-leg exposure is directional risk.",
  ];
  const ACCRUAL_NOTES = [
    "Rewards are revenue only when paid.",
    "Rebate not included until paid.",
    "Unpaid accruals NEVER count toward EV — realized income is PAID rows only.",
  ];

  app.get("/api/inventory/cycles", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const q = req.query as Record<string, string>;
    const limit = Math.min(100, clampLimit(q.limit, 25));
    if (q.state && !(PAIRED_CYCLE_STATES as readonly string[]).includes(q.state)) {
      return reply.code(400).send({ error: "unknown cycle state", states: PAIRED_CYCLE_STATES });
    }
    const stateFilter = q.state as PairedCycleState | undefined;
    try {
      const rows = stateFilter
        ? await db.db.select().from(pairedQuoteCycles)
            .where(eq(pairedQuoteCycles.state, stateFilter))
            .orderBy(desc(pairedQuoteCycles.createdAtMs)).limit(limit)
        : await db.db.select().from(pairedQuoteCycles)
            .orderBy(desc(pairedQuoteCycles.createdAtMs)).limit(limit);
      const ids = rows.map((c) => c.id);
      const legs = ids.length > 0
        ? await db.db.select().from(pairedLegs).where(inArray(pairedLegs.cycleId, ids)).orderBy(pairedLegs.createdAtMs)
        : [];
      const hedges = ids.length > 0
        ? await db.db.select().from(hedgeActions).where(inArray(hedgeActions.cycleId, ids)).orderBy(hedgeActions.decidedAtMs)
        : [];
      const ops = ids.length > 0
        ? await db.db.select().from(ctfOperations).where(inArray(ctfOperations.cycleId, ids)).orderBy(ctfOperations.createdAtMs)
        : [];
      const legsBy = new Map<string, typeof legs>();
      for (const l of legs) { const list = legsBy.get(l.cycleId) ?? []; list.push(l); legsBy.set(l.cycleId, list); }
      const hedgesBy = new Map<string, typeof hedges>();
      for (const h of hedges) { const list = hedgesBy.get(h.cycleId) ?? []; list.push(h); hedgesBy.set(h.cycleId, list); }
      const opsBy = new Map<string, typeof ops>();
      for (const o of ops) {
        if (o.cycleId === null) continue;
        const list = opsBy.get(o.cycleId) ?? []; list.push(o); opsBy.set(o.cycleId, list);
      }
      const cycles = rows.map((c) => {
        const cycleLegs = legsBy.get(c.id) ?? [];
        return {
          ...c,
          // THE risk-free predicate (domain isRiskFree): RECONCILED + every leg
          // closed. Anything else may NEVER be labeled risk-free downstream.
          riskFree: isRiskFree(
            { state: c.state as PairedCycleState },
            cycleLegs.map((l) => ({ state: l.state as PairedLegState })),
          ),
          legs: cycleLegs,
          hedgeActions: hedgesBy.get(c.id) ?? [],
          ctfOperations: opsBy.get(c.id) ?? [],
        };
      });
      return jsonSafe({ cycles, states: PAIRED_CYCLE_STATES, legStates: PAIRED_LEG_STATES, notes: CYCLE_NOTES });
    } catch {
      return { cycles: [], states: PAIRED_CYCLE_STATES, legStates: PAIRED_LEG_STATES, notes: CYCLE_NOTES, note: INVENTORY_NOTE };
    }
  });

  app.get("/api/inventory/summary", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const emptySummary = () => ({
      cycles: {
        total: 0,
        byState: PAIRED_CYCLE_STATES.map((state) => ({ state, n: 0 })),
        oneLegFilled: 0,
        hedgeCompleted: 0,
      },
      legs: { byState: PAIRED_LEG_STATES.map((state) => ({ state, n: 0 })) },
      hedges: { byKind: HEDGE_ACTION_KINDS.map((kind) => ({ kind, n: 0, done: 0, failed: 0 })) },
      operations: {
        byKind: CTF_OPERATION_KINDS.map((kind) => ({
          kind, n: 0, confirmed: 0, partiallyConfirmed: 0, failed: 0, unknown: 0, estGas6: "0", actualGas6: "0",
        })),
        unknownOutcomes: 0,
        estGas6: "0",
        actualGas6: "0",
        recent: [] as unknown[],
      },
      worstCaseLoss: { open: { n: 0, sum6: "0", max6: "0" }, all: { n: 0, sum6: "0", max6: "0" } },
      unhedged: { n: 0, maxMs: null as number | null, avgMs: null as number | null, overCapCount: 0, capMs: ONE_LEG_CAP_MS },
      notes: CYCLE_NOTES,
    });
    try {
      const stateAgg = await db.db.select({ state: pairedQuoteCycles.state, n: sql<number>`count(*)` })
        .from(pairedQuoteCycles).groupBy(pairedQuoteCycles.state);
      const cycleTotals = await db.db.select({
        n: sql<number>`count(*)`,
        oneLeg: sql<number>`coalesce(sum(case when ${pairedQuoteCycles.oneLegFilledAtMs} is not null then 1 else 0 end), 0)`,
        hedged: sql<number>`coalesce(sum(case when ${pairedQuoteCycles.hedgeCompletedAtMs} is not null then 1 else 0 end), 0)`,
        wclSum6: sql<string>`coalesce(sum(${pairedQuoteCycles.worstCaseLoss6}), 0)::text`,
        wclMax6: sql<string>`coalesce(max(${pairedQuoteCycles.worstCaseLoss6}), 0)::text`,
      }).from(pairedQuoteCycles);
      const openTotals = await db.db.select({
        n: sql<number>`count(*)`,
        wclSum6: sql<string>`coalesce(sum(${pairedQuoteCycles.worstCaseLoss6}), 0)::text`,
        wclMax6: sql<string>`coalesce(max(${pairedQuoteCycles.worstCaseLoss6}), 0)::text`,
      }).from(pairedQuoteCycles).where(sql`${pairedQuoteCycles.state} <> 'RECONCILED'`);
      const unhedgedAgg = await db.db.select({
        n: sql<number>`count(*)`,
        maxMs: sql<number | null>`max(${pairedQuoteCycles.unhedgedDurationMs})`,
        avgMs: sql<number | null>`avg(${pairedQuoteCycles.unhedgedDurationMs})::float8`,
        over: sql<number>`coalesce(sum(case when ${pairedQuoteCycles.unhedgedDurationMs} > ${ONE_LEG_CAP_MS} then 1 else 0 end), 0)`,
      }).from(pairedQuoteCycles).where(sql`${pairedQuoteCycles.unhedgedDurationMs} is not null`);
      const legAgg = await db.db.select({ state: pairedLegs.state, n: sql<number>`count(*)` })
        .from(pairedLegs).groupBy(pairedLegs.state);
      const hedgeAgg = await db.db.select({
        kind: hedgeActions.kind,
        n: sql<number>`count(*)`,
        done: sql<number>`coalesce(sum(case when ${hedgeActions.state} = 'DONE' then 1 else 0 end), 0)`,
        failed: sql<number>`coalesce(sum(case when ${hedgeActions.state} = 'FAILED' then 1 else 0 end), 0)`,
      }).from(hedgeActions).groupBy(hedgeActions.kind);
      const opAgg = await db.db.select({
        kind: ctfOperations.kind,
        n: sql<number>`count(*)`,
        confirmed: sql<number>`coalesce(sum(case when ${ctfOperations.state} = 'CONFIRMED' then 1 else 0 end), 0)`,
        partiallyConfirmed: sql<number>`coalesce(sum(case when ${ctfOperations.state} = 'PARTIALLY_CONFIRMED' then 1 else 0 end), 0)`,
        failed: sql<number>`coalesce(sum(case when ${ctfOperations.state} = 'FAILED' then 1 else 0 end), 0)`,
        unknown: sql<number>`coalesce(sum(case when ${ctfOperations.state} = 'UNKNOWN' then 1 else 0 end), 0)`,
        estGas6: sql<string>`coalesce(sum(${ctfOperations.estGasUsdc6}), 0)::text`,
        actualGas6: sql<string>`coalesce(sum(${ctfOperations.actualGasUsdc6}), 0)::text`,
      }).from(ctfOperations).groupBy(ctfOperations.kind);
      const recentOps = await db.db.select().from(ctfOperations).orderBy(desc(ctfOperations.createdAtMs)).limit(50);

      const stateBy = new Map(stateAgg.map((r) => [r.state, Number(r.n)]));
      const legBy = new Map(legAgg.map((r) => [r.state, Number(r.n)]));
      const hedgeBy = new Map(hedgeAgg.map((r) => [r.kind, r]));
      const opBy = new Map(opAgg.map((r) => [r.kind, r]));
      const t = cycleTotals[0];
      const o = openTotals[0];
      const u = unhedgedAgg[0];
      const opsByKind = CTF_OPERATION_KINDS.map((kind) => {
        const r = opBy.get(kind);
        return {
          kind,
          n: Number(r?.n ?? 0),
          confirmed: Number(r?.confirmed ?? 0),
          partiallyConfirmed: Number(r?.partiallyConfirmed ?? 0),
          failed: Number(r?.failed ?? 0),
          unknown: Number(r?.unknown ?? 0),
          estGas6: r?.estGas6 ?? "0",
          actualGas6: r?.actualGas6 ?? "0",
        };
      });
      return jsonSafe({
        cycles: {
          total: Number(t?.n ?? 0),
          byState: PAIRED_CYCLE_STATES.map((state) => ({ state, n: stateBy.get(state) ?? 0 })),
          // cycles that EVER had exactly one leg filled (incidence, not current state)
          oneLegFilled: Number(t?.oneLeg ?? 0),
          hedgeCompleted: Number(t?.hedged ?? 0),
        },
        legs: { byState: PAIRED_LEG_STATES.map((state) => ({ state, n: legBy.get(state) ?? 0 })) },
        hedges: {
          byKind: HEDGE_ACTION_KINDS.map((kind) => ({
            kind,
            n: Number(hedgeBy.get(kind)?.n ?? 0),
            done: Number(hedgeBy.get(kind)?.done ?? 0),
            failed: Number(hedgeBy.get(kind)?.failed ?? 0),
          })),
        },
        operations: {
          byKind: opsByKind,
          unknownOutcomes: opsByKind.reduce((a, r) => a + r.unknown, 0),
          estGas6: opsByKind.reduce((a, r) => a + BigInt(r.estGas6), 0n).toString(),
          actualGas6: opsByKind.reduce((a, r) => a + BigInt(r.actualGas6), 0n).toString(),
          recent: recentOps,
        },
        worstCaseLoss: {
          open: { n: Number(o?.n ?? 0), sum6: o?.wclSum6 ?? "0", max6: o?.wclMax6 ?? "0" },
          all: { n: Number(t?.n ?? 0), sum6: t?.wclSum6 ?? "0", max6: t?.wclMax6 ?? "0" },
        },
        unhedged: {
          n: Number(u?.n ?? 0),
          maxMs: u?.maxMs === null || u?.maxMs === undefined ? null : Number(u.maxMs),
          avgMs: u?.avgMs === null || u?.avgMs === undefined ? null : Number(u.avgMs),
          overCapCount: Number(u?.over ?? 0),
          capMs: ONE_LEG_CAP_MS,
        },
        notes: CYCLE_NOTES,
      });
    } catch {
      return { ...emptySummary(), note: INVENTORY_NOTE };
    }
  });

  app.get("/api/inventory/accruals", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    // THE TWO LEDGERS ARE STRICTLY SEPARATE (brief: never merge their
    // eligibility or accounting). realized totals sum paid_amount6 of PAID rows
    // ONLY — estimated amount6 never becomes revenue.
    const zeroLedger = (program: "MAKER_REBATE" | "LIQUIDITY_REWARD") => ({
      program,
      byState: ACCRUAL_STATES.map((state) => ({ state, n: 0, amount6: "0" })),
      realized: { n: 0, paid6: "0" },
      unrealized: { n: 0, amount6: "0" },
      inconsistentRows: 0,
    });
    interface StateAgg { state: string; n: number; amount6: string; paid6: string }
    const shapeLedger = (program: "MAKER_REBATE" | "LIQUIDITY_REWARD", rows: StateAgg[], inconsistentRows: number) => {
      const by = new Map(rows.map((r) => [r.state, r]));
      const paid = by.get("PAID");
      let unrealizedN = 0;
      let unrealized6 = 0n;
      for (const r of rows) {
        if (r.state === "PAID") continue;
        unrealizedN += Number(r.n);
        unrealized6 += BigInt(r.amount6);
      }
      return {
        program,
        byState: ACCRUAL_STATES.map((state) => ({
          state, n: Number(by.get(state)?.n ?? 0), amount6: by.get(state)?.amount6 ?? "0",
        })),
        realized: { n: Number(paid?.n ?? 0), paid6: paid?.paid6 ?? "0" },
        unrealized: { n: unrealizedN, amount6: unrealized6.toString() },
        inconsistentRows,
      };
    };
    try {
      const rebateAgg = await db.db.select({
        state: rebateAccruals.state,
        n: sql<number>`count(*)`,
        amount6: sql<string>`coalesce(sum(${rebateAccruals.amount6}), 0)::text`,
        paid6: sql<string>`coalesce(sum(${rebateAccruals.paidAmount6}), 0)::text`,
      }).from(rebateAccruals).groupBy(rebateAccruals.state);
      const rebateBad = await db.db.select({ n: sql<number>`count(*)` }).from(rebateAccruals)
        .where(sql`(${rebateAccruals.state} = 'PAID') <> ${rebateAccruals.realized}
          or ((${rebateAccruals.state} = 'PAID') and (${rebateAccruals.paidAmount6} is null or ${rebateAccruals.paidAtMs} is null))
          or ((${rebateAccruals.state} <> 'PAID') and (${rebateAccruals.paidAmount6} is not null or ${rebateAccruals.paidAtMs} is not null))`);
      const rewardAgg = await db.db.select({
        state: liquidityRewardAccruals.state,
        n: sql<number>`count(*)`,
        amount6: sql<string>`coalesce(sum(${liquidityRewardAccruals.amount6}), 0)::text`,
        paid6: sql<string>`coalesce(sum(${liquidityRewardAccruals.paidAmount6}), 0)::text`,
      }).from(liquidityRewardAccruals).groupBy(liquidityRewardAccruals.state);
      const rewardBad = await db.db.select({ n: sql<number>`count(*)` }).from(liquidityRewardAccruals)
        .where(sql`(${liquidityRewardAccruals.state} = 'PAID') <> ${liquidityRewardAccruals.realized}
          or ((${liquidityRewardAccruals.state} = 'PAID') and (${liquidityRewardAccruals.paidAmount6} is null or ${liquidityRewardAccruals.paidAtMs} is null))
          or ((${liquidityRewardAccruals.state} <> 'PAID') and (${liquidityRewardAccruals.paidAmount6} is not null or ${liquidityRewardAccruals.paidAtMs} is not null))`);
      return jsonSafe({
        makerRebate: shapeLedger("MAKER_REBATE", rebateAgg, Number(rebateBad[0]?.n ?? 0)),
        liquidityReward: shapeLedger("LIQUIDITY_REWARD", rewardAgg, Number(rewardBad[0]?.n ?? 0)),
        states: ACCRUAL_STATES,
        notes: ACCRUAL_NOTES,
      });
    } catch {
      return {
        makerRebate: zeroLedger("MAKER_REBATE"),
        liquidityReward: zeroLedger("LIQUIDITY_REWARD"),
        states: ACCRUAL_STATES,
        notes: ACCRUAL_NOTES,
        note: INVENTORY_NOTE,
      };
    }
  });

  app.get("/api/inventory/snapshots", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const limit = Math.min(100, clampLimit((req.query as Record<string, string>).limit, 25));
    try {
      const rows = await db.db.select().from(inventorySnapshots).orderBy(desc(inventorySnapshots.tsMs)).limit(limit);
      const totals = await db.db.select({
        n: sql<number>`count(*)`,
        mismatches: sql<number>`coalesce(sum(case when ${inventorySnapshots.reconciled} then 0 else 1 end), 0)`,
      }).from(inventorySnapshots);
      return jsonSafe({
        snapshots: rows,
        totals: { n: Number(totals[0]?.n ?? 0), mismatches: Number(totals[0]?.mismatches ?? 0) },
      });
    } catch {
      return { snapshots: [], totals: { n: 0, mismatches: 0 }, note: INVENTORY_NOTE };
    }
  });

  app.get("/api/inventory/basis", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const BASIS_NOTES = ["Binance is not the resolution source."];
    const zeroBoundary = () => ({
      byKind: BOUNDARY_KINDS.map((kind) => ({ kind, n: 0, matched: 0, mismatched: 0, unchecked: 0, late: 0 })),
      totals: { n: 0, matched: 0, mismatched: 0, unchecked: 0, lateCaptures: 0 },
      recent: [] as unknown[],
    });
    try {
      const est = await db.db.select().from(feedBasisEstimates).orderBy(desc(feedBasisEstimates.tsMs)).limit(500);
      interface PairAcc {
        symbol: string; baseSource: string; refSource: string;
        n: number; samples: number;
        latest: (typeof est)[number];
        meanPpmSum: number; meanPpmMin: number; meanPpmMax: number; stdPpmSum: number;
      }
      const byPair = new Map<string, PairAcc>();
      for (const e of est) {
        const key = `${e.symbol}|${e.baseSource}|${e.refSource}`;
        const p = byPair.get(key);
        if (!p) {
          // rows are recent-first: the first row per pair is the latest estimate
          byPair.set(key, {
            symbol: e.symbol, baseSource: e.baseSource, refSource: e.refSource,
            n: 1, samples: e.sampleCount, latest: e,
            meanPpmSum: e.meanPpm, meanPpmMin: e.meanPpm, meanPpmMax: e.meanPpm, stdPpmSum: e.stdPpm,
          });
        } else {
          p.n += 1;
          p.samples += e.sampleCount;
          p.meanPpmSum += e.meanPpm;
          p.meanPpmMin = Math.min(p.meanPpmMin, e.meanPpm);
          p.meanPpmMax = Math.max(p.meanPpmMax, e.meanPpm);
          p.stdPpmSum += e.stdPpm;
        }
      }
      const pairs = [...byPair.values()].map((p) => ({
        symbol: p.symbol,
        baseSource: p.baseSource,
        refSource: p.refSource,
        estimates: p.n,
        samples: p.samples,
        meanPpmAvg: p.meanPpmSum / p.n,
        meanPpmMin: p.meanPpmMin,
        meanPpmMax: p.meanPpmMax,
        stdPpmAvg: p.stdPpmSum / p.n,
        latest: {
          meanPpm: p.latest.meanPpm, medianPpm: p.latest.medianPpm, stdPpm: p.latest.stdPpm,
          madPpm: p.latest.madPpm, clockOffsetMs: p.latest.clockOffsetMs, leadLagMs: p.latest.leadLagMs,
          regime: p.latest.regime, method: p.latest.method, sampleCount: p.latest.sampleCount,
          windowStartMs: p.latest.windowStartMs, windowEndMs: p.latest.windowEndMs, tsMs: p.latest.tsMs,
        },
      }));

      const bAgg = await db.db.select({
        kind: boundaryPriceObservations.boundaryKind,
        n: sql<number>`count(*)`,
        matched: sql<number>`coalesce(sum(case when ${boundaryPriceObservations.matchesOfficial} is true then 1 else 0 end), 0)`,
        mismatched: sql<number>`coalesce(sum(case when ${boundaryPriceObservations.matchesOfficial} is false then 1 else 0 end), 0)`,
        unchecked: sql<number>`coalesce(sum(case when ${boundaryPriceObservations.matchesOfficial} is null then 1 else 0 end), 0)`,
        late: sql<number>`coalesce(sum(case when ${boundaryPriceObservations.firstAtOrAfterBoundary} then 0 else 1 end), 0)`,
      }).from(boundaryPriceObservations).groupBy(boundaryPriceObservations.boundaryKind);
      const recent = await db.db.select().from(boundaryPriceObservations)
        .orderBy(desc(boundaryPriceObservations.boundaryEpoch), desc(boundaryPriceObservations.receivedTsMs))
        .limit(20);
      const bBy = new Map(bAgg.map((r) => [r.kind, r]));
      const byKind = BOUNDARY_KINDS.map((kind) => ({
        kind,
        n: Number(bBy.get(kind)?.n ?? 0),
        matched: Number(bBy.get(kind)?.matched ?? 0),
        mismatched: Number(bBy.get(kind)?.mismatched ?? 0),
        unchecked: Number(bBy.get(kind)?.unchecked ?? 0),
        late: Number(bBy.get(kind)?.late ?? 0),
      }));
      return jsonSafe({
        basis: { pairs },
        boundary: {
          byKind,
          totals: {
            n: byKind.reduce((a, r) => a + r.n, 0),
            matched: byKind.reduce((a, r) => a + r.matched, 0),
            mismatched: byKind.reduce((a, r) => a + r.mismatched, 0),
            unchecked: byKind.reduce((a, r) => a + r.unchecked, 0),
            lateCaptures: byKind.reduce((a, r) => a + r.late, 0),
          },
          recent,
        },
        notes: BASIS_NOTES,
      });
    } catch {
      return { basis: { pairs: [] }, boundary: zeroBoundary(), notes: BASIS_NOTES, note: INVENTORY_NOTE };
    }
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
    try {
      await bus.publishReliable(CHANNELS.control, { type: "config_reload" });
    } catch (e) {
      return reply.code(502).send({ error: `config saved but reload signal not delivered: ${String(e)}. The engine will pick it up on restart.` });
    }
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
    try {
      await bus.publishReliable(CHANNELS.control, { type: "kill", reason, actor: "operator" });
    } catch (e) {
      // The kill MUST NOT be silently lost: tell the operator delivery failed.
      return reply.code(502).send({ error: `kill command could NOT be delivered to the engine (control bus unavailable: ${String(e)}). Stop the engine process directly.` });
    }
    return { ok: true, note: "Emergency stop signaled. New orders disabled; resting order cancellation attempted; positions require manual review." };
  });

  app.post("/api/resume", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    try {
      await bus.publishReliable(CHANNELS.control, { type: "resume", actor: "operator" });
    } catch (e) {
      return reply.code(502).send({ error: `resume command not delivered: ${String(e)}` });
    }
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
    try {
      await bus.publishReliable(CHANNELS.control, {
        type: "arm", actor: "operator",
        acknowledgement: body.data.acknowledgement,
        ttlMinutes: body.data.ttlMinutes,
      });
    } catch (e) {
      return reply.code(502).send({ error: `arm request not delivered: ${String(e)}` });
    }
    await db.db.insert(auditEvents).values({ category: "live", action: "arm_requested", actor: "operator", correlationId: null, data: { ttlMinutes: body.data.ttlMinutes }, createdAtMs: Date.now() });
    return { ok: true, note: "Arm request sent. Watch /api/state (live.state) and health events for the result — the engine runs wallet reconciliation before arming." };
  });

  app.post("/api/disarm", async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const body = z.object({ reason: z.string().default("operator manual disarm") }).safeParse(req.body ?? {});
    try {
      await bus.publishReliable(CHANNELS.control, { type: "disarm", actor: "operator", reason: body.success ? body.data.reason : "operator" });
    } catch (e) {
      return reply.code(502).send({ error: `disarm command not delivered: ${String(e)}` });
    }
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

  // Prometheus scrape endpoint. Unauthenticated like /api/healthz: the app has
  // no public [[services]] for this port on Fly, so callers are already inside
  // the org's private network. Carries no market data or secrets — only
  // operational gauges (queue depth, feed staleness, engine state, RSS).
  // In embedded mode (EMBED_ENGINE=1, the production layout) the engine
  // publishes into this process-global registry; split-process deployments see
  // API-side metrics only.
  app.get("/metrics", async (_req, reply) => {
    return reply.header("Content-Type", METRICS_CONTENT_TYPE).send(metricsRegistry.render());
  });

  return app;
}

export async function makeApiBus(): Promise<Bus> {
  return process.env.REDIS_URL ? makeBus() : getLocalBus();
}

export function clampLimit(v: string | undefined, dflt: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(500, n) : dflt;
}

function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val))) as T;
}
