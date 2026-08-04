import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDb, type DbHandle } from "@b5p/db";
import { getLocalBus } from "@b5p/engine";
import { seedAll } from "@b5p/research";
import type { FastifyInstance } from "fastify";
import { AuthService } from "../src/auth";
import { buildServer } from "../src/server";

let db: DbHandle;
let app: FastifyInstance;
let cookie = "";
let csrf = "";

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
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("auth", () => {
  it("rejects unauthenticated access", async () => {
    const res = await app.inject({ method: "GET", url: "/api/state" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects bad credentials", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "operator", password: "wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("logs in and sets an http-only session cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "operator", password: "test-password-123", remember: true } });
    expect(res.statusCode).toBe(200);
    const setCookies = res.headers["set-cookie"] as string[] | string;
    const all = Array.isArray(setCookies) ? setCookies : [setCookies];
    const session = all.find((c) => c.startsWith("b5p_session="))!;
    expect(session).toContain("HttpOnly");
    expect(session).toMatch(/Max-Age=2592000/i);
    cookie = session.split(";")[0]!;
    csrf = (res.json() as { csrfToken: string }).csrfToken;
    expect(csrf.length).toBeGreaterThan(10);
  });

  it("authenticated requests succeed", async () => {
    const res = await app.inject({ method: "GET", url: "/api/state", headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it("mutations without CSRF token are refused", async () => {
    const res = await app.inject({ method: "POST", url: "/api/kill", headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});

describe("seeded data", () => {
  it("serves the seeded timing-lab table (spec's 30-day findings)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/timing-lab", headers: { cookie } });
    const body = res.json() as { rows: Array<{ bucket: string; windowDays: number; upRate: number; n: number }>; warning: string };
    expect(body.warning).toContain("not trading edge");
    const b45 = body.rows.find((r) => r.bucket === "45" && r.windowDays === 30)!;
    expect(b45.n).toBe(720);
    expect(b45.upRate).toBeCloseTo(0.5403, 4);
    const all = body.rows.find((r) => r.bucket === "all" && r.windowDays === 30)!;
    expect(all.n).toBe(8637);
    expect(all.upRate).toBeCloseTo(0.5010, 4);
  });

  it("serves the 95-cent tutorial with its full decision chain", async () => {
    const tut = await app.inject({ method: "GET", url: "/api/tutorial", headers: { cookie } });
    const data = tut.json() as { narrative: string[]; effectiveBreakEven: string };
    expect(data.effectiveBreakEven).toBe("0.953325");
    expect(data.narrative.join(" ")).toContain("erases ~19");

    const dec = await app.inject({ method: "GET", url: "/api/decisions/00000000-0000-4000-8000-0000000000d1", headers: { cookie } });
    const body = dec.json() as { orders: Array<{ status: string }>; fills: Array<{ feeUsdc6: string }> };
    expect(body.orders[0]!.status).toBe("MATCHED");
    expect(body.fills[0]!.feeUsdc6).toBe("2789675"); // ~2.79 USDC at the live fee formula
  });
});

describe("kill switch and config", () => {
  it("kill switch works with CSRF token and writes an audit trail", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/kill", headers: { cookie, "x-csrf-token": csrf }, payload: { reason: "test stop" },
    });
    expect(res.statusCode).toBe(200);
    const audit = await app.inject({ method: "GET", url: "/api/audit", headers: { cookie } });
    expect(res.json()).toMatchObject({ ok: true });
    expect(audit.statusCode).toBe(200);
  });

  it("rejects config that violates the absolute risk cap", async () => {
    const cfgRes = await app.inject({ method: "GET", url: "/api/config", headers: { cookie } });
    const active = (cfgRes.json() as { active: { config: Record<string, unknown> } }).active.config;
    const evil = { ...active, risk: { ...(active.risk as Record<string, unknown>), max_risk_fraction: "0.50" } };
    const res = await app.inject({
      method: "POST", url: "/api/config", headers: { cookie, "x-csrf-token": csrf }, payload: evil,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { issues: Array<{ path: string; message: string }> };
    expect(body.issues[0]!.message).toContain("safety cap");
  });

  it("accepts a valid config change and versions it", async () => {
    const cfgRes = await app.inject({ method: "GET", url: "/api/config", headers: { cookie } });
    const active = (cfgRes.json() as { active: { config: { risk: Record<string, unknown> } } }).active.config;
    const updated = { ...active, risk: { ...active.risk, profile: "aggressive" } };
    const res = await app.inject({
      method: "POST", url: "/api/config", headers: { cookie, "x-csrf-token": csrf }, payload: updated,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { changed: Array<{ path: string }> };
    expect(body.changed.map((c) => c.path)).toContain("risk.profile");
  });
});
