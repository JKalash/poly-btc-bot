import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDb, type DbHandle } from "@b5p/db";
import { getLocalBus } from "@b5p/engine";
import { seedAll } from "@b5p/research";
import type { FastifyInstance } from "fastify";
import { AuthService } from "../src/auth";
import { buildServer } from "../src/server";

/**
 * Execution Lab + Strategy Comparison read routes.
 * The telemetry tables are empty until the engine records execution-quality
 * events, so every route must return a well-formed empty payload — the
 * dashboard's "no data yet" states depend on these shapes.
 */

let db: DbHandle;
let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
  await db.migrate();
  await seedAll(db);
  process.env.OPERATOR_PASSWORD_HASH = await AuthService.hashPassword("test-password-123");
  process.env.OPERATOR_USERNAME = "operator";
  const auth = new AuthService();
  await auth.ensurePasswordHash();
  app = await buildServer({ db, bus: getLocalBus(), auth, requireAuth: true });
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "operator", password: "test-password-123" } });
  const setCookies = res.headers["set-cookie"] as string[] | string;
  const all = Array.isArray(setCookies) ? setCookies : [setCookies];
  cookie = all.find((c) => c.startsWith("b5p_session="))!.split(";")[0]!;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

const ROUTES = [
  "/api/execution/timelines",
  "/api/execution/funnel",
  "/api/execution/latency",
  "/api/execution/markout",
  "/api/execution/paper-variants",
  "/api/execution/queue",
  "/api/execution/fill-quality",
  "/api/strategy/comparison",
];

describe("execution lab routes", () => {
  it("every route is guarded", async () => {
    for (const url of ROUTES) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("timelines: empty until telemetry exists; intentId filter accepted", async () => {
    const res = await app.inject({ method: "GET", url: "/api/execution/timelines?limit=10", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { intents: unknown[] }).intents).toEqual([]);
    const filtered = await app.inject({ method: "GET", url: "/api/execution/timelines?intentId=nope", headers: { cookie } });
    expect(filtered.statusCode).toBe(200);
    expect((filtered.json() as { intents: unknown[] }).intents).toEqual([]);
  });

  it("funnel: zero intents, empty state list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/execution/funnel", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { states: unknown[]; totalIntents: number };
    expect(body.states).toEqual([]);
    expect(body.totalIntents).toBe(0);
  });

  it("latency: empty stage aggregates", async () => {
    const res = await app.inject({ method: "GET", url: "/api/execution/latency", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { stages: unknown[] }).stages).toEqual([]);
  });

  it("markout: empty horizon aggregates", async () => {
    const res = await app.inject({ method: "GET", url: "/api/execution/markout", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { horizons: unknown[] }).horizons).toEqual([]);
  });

  it("paper variants: empty, and pnl_records stay the QUEUE_REPLAY path", async () => {
    const res = await app.inject({ method: "GET", url: "/api/execution/paper-variants", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { variants: unknown[]; note?: string };
    expect(body.variants).toEqual([]);
    expect(body.note ?? "").toContain("QUEUE_REPLAY");
  });

  it("queue: empty methods and counterfactual summary", async () => {
    const res = await app.inject({ method: "GET", url: "/api/execution/queue", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { methods: unknown[]; counterfactuals: { n: number; wouldFill: number; reasons: unknown[] } };
    expect(body.methods).toEqual([]);
    expect(body.counterfactuals.n).toBe(0);
    expect(body.counterfactuals.reasons).toEqual([]);
  });

  it("fill quality: zeroed order/maker-taker/cancel-race stats", async () => {
    const res = await app.inject({ method: "GET", url: "/api/execution/fill-quality", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      orders: { total: number; full: number; partial: number; none: number };
      quoted: { avgQuoted6: string | null; avgFilled6: string | null; slippagePerShare6: string | null };
      cancelRaces: { requested: number; lostToFill: number };
    };
    expect(body.orders.total).toBe(body.orders.full + body.orders.partial + body.orders.none);
    expect(body.cancelRaces).toEqual({ requested: 0, lostToFill: 0 });
  });

  it("strategy comparison: rows carry promotion status and mandated notes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/strategy/comparison", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      strategies: Array<{ strategyVersion: string; promotion: { status: string }; candidates: { total: number } }>;
      fillSelectionCost: unknown;
      notes: string[];
    };
    expect(Array.isArray(body.strategies)).toBe(true);
    for (const s of body.strategies) {
      expect(["PROMOTED", "NOT_PROMOTED", "NO_DECISION"]).toContain(s.promotion.status);
    }
    expect(body.notes).toContain("Score strength is not probability.");
    expect(body.notes).toContain("Being filled can be adverse information.");
    expect(body.notes).toContain("No trade is a valid decision.");
  });
});
