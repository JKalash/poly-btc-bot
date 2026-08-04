import { readFile } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairReadModelValidationError } from "../src/pair-read-repository";
import {
  PAIR_READ_ROUTE_DEFINITIONS,
  registerPairReadRoutes,
  type PairReadRouteRepository,
} from "../src/pair-routes";

function repository(): PairReadRouteRepository {
  const page = async () => ({ items: [], nextCursor: null });
  const detail = async (id: string) => ({ id });
  return {
    getSummary: vi.fn(async (nowMs: number) => ({ nowMs, pairCashAvailable6: 9_007_199_254_740_993n })),
    getHealth: vi.fn(async () => ({ status: "HEALTHY" })),
    listEpisodes: vi.fn(page),
    getEpisode: vi.fn(detail),
    listObservations: vi.fn(page),
    getObservation: vi.fn(detail),
    listGroups: vi.fn(page),
    getGroup: vi.fn(detail),
    listGroupEvents: vi.fn(async (groupId: string) => ({ items: [{ groupId }], nextCursor: null })),
    listGroupReconciliations: vi.fn(async (groupId: string) => ({ items: [{ groupId }], nextCursor: null })),
    listResearchRuns: vi.fn(page),
    getResearchRun: vi.fn(detail),
  };
}

async function makeApp(
  reads: PairReadRouteRepository,
  guard: (request: Parameters<Parameters<typeof registerPairReadRoutes>[1]["guard"]>[0], reply: Parameters<Parameters<typeof registerPairReadRoutes>[1]["guard"]>[1]) => Promise<boolean> = async () => true,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerPairReadRoutes(app, { repository: reads, guard, nowMs: () => 1234 });
  await app.ready();
  return app;
}

describe("pair read routes", () => {
  let reads: PairReadRouteRepository;
  let app: FastifyInstance;

  beforeEach(async () => {
    reads = repository();
    app = await makeApp(reads);
  });

  afterEach(async () => {
    await app.close();
  });

  it.each([
    ["/api/pairs/summary", "nowMs"],
    ["/api/pairs/health", "status"],
    ["/api/pairs/episodes", "items"],
    ["/api/pairs/episodes/episode-1", "id"],
    ["/api/pairs/observations", "items"],
    ["/api/pairs/observations/observation-1", "id"],
    ["/api/pairs/groups", "items"],
    ["/api/pairs/groups/group-1", "id"],
    ["/api/pairs/groups/group-1/events", "items"],
    ["/api/pairs/groups/group-1/reconciliations", "items"],
    ["/api/pairs/research-runs", "items"],
    ["/api/pairs/research-runs/run-1", "id"],
  ])("serves GET %s", async (url, property) => {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty(property);
  });

  it("forwards strict filters and serializes economic bigints as exact decimal strings", async () => {
    const listGroups = vi.mocked(reads.listGroups);
    const response = await app.inject({ method: "GET", url: "/api/pairs/groups?limit=7&has_residual=true" });
    expect(response.statusCode).toBe(200);
    expect(listGroups).toHaveBeenCalledWith({ limit: "7", has_residual: "true" });

    const summary = await app.inject({ method: "GET", url: "/api/pairs/summary" });
    expect(summary.json()).toMatchObject({ nowMs: 1234, pairCashAvailable6: "9007199254740993" });
  });

  it("returns stable validation, not-found, and internal error envelopes", async () => {
    vi.mocked(reads.listEpisodes).mockRejectedValueOnce(new PairReadModelValidationError("limit must be between 1 and 200"));
    expect((await app.inject({ method: "GET", url: "/api/pairs/episodes?limit=0" })).json()).toEqual({
      error: "invalid_pair_request",
      code: "PAIR_READ_FILTER_INVALID",
      message: "limit must be between 1 and 200",
    });

    vi.mocked(reads.getEpisode).mockResolvedValueOnce(null);
    const missing = await app.inject({ method: "GET", url: "/api/pairs/episodes/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "pair_resource_not_found" });

    vi.mocked(reads.getHealth).mockRejectedValueOnce(new Error("database password must not leak"));
    const failed = await app.inject({ method: "GET", url: "/api/pairs/health" });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "pair_read_failed" });
  });

  it("rejects filters on non-list routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/pairs/health?limit=1" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_pair_request", code: "PAIR_READ_FILTER_INVALID" });
  });

  it("uses the supplied authentication guard before touching the repository", async () => {
    await app.close();
    const guard = vi.fn(async (_request, reply) => {
      await reply.code(401).send({ error: "unauthenticated" });
      return false;
    });
    app = await makeApp(reads, guard);
    const response = await app.inject({ method: "GET", url: "/api/pairs/health" });
    expect(response.statusCode).toBe(401);
    expect(reads.getHealth).not.toHaveBeenCalled();
  });

  it("has a static GET-only route manifest and no pair mutation registration", async () => {
    expect(PAIR_READ_ROUTE_DEFINITIONS).toHaveLength(12);
    expect(PAIR_READ_ROUTE_DEFINITIONS.every((route) => route.startsWith("GET /api/pairs/"))).toBe(true);
    const source = await readFile(new URL("../src/pair-routes.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/app\.(?:post|put|patch|delete)\(\s*["']\/api\/pairs\//i);
  });
});
