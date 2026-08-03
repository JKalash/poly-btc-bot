import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import { validateConfig, diffConfigs, type AppConfig } from "@b5p/config";
import {
  auditEvents, calibrationArtifacts, configVersions, decisionSnapshots, engineKv,
  executionTimelineEvents, fillCounterfactuals, fillSelectionCostRecords, healthEvents,
  killSwitchEvents, latencySamples, marketTradeTicks, markets, markoutObservations,
  orderAttempts, orderFills, orders, paperVariantResults, pnlRecords, positions,
  queueEstimates, researchMarkets, resolutions, riskDecisions, signalCandidates,
  strategyPromotionDecisions, timingBucketStatistics, type DbHandle,
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
