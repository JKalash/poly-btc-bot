import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PairReadModelValidationError } from "./pair-read-repository";

export const PAIR_READ_ROUTE_DEFINITIONS = [
  "GET /api/pairs/summary",
  "GET /api/pairs/health",
  "GET /api/pairs/episodes",
  "GET /api/pairs/episodes/:id",
  "GET /api/pairs/observations",
  "GET /api/pairs/observations/:id",
  "GET /api/pairs/groups",
  "GET /api/pairs/groups/:id",
  "GET /api/pairs/groups/:id/events",
  "GET /api/pairs/groups/:id/reconciliations",
  "GET /api/pairs/research-runs",
  "GET /api/pairs/research-runs/:id",
] as const;

type Query = Readonly<Record<string, unknown>>;

export interface PairReadRouteRepository {
  getSummary(nowMs: number): Promise<unknown>;
  getHealth(): Promise<unknown>;
  listEpisodes(query?: Query): Promise<unknown>;
  getEpisode(id: string): Promise<unknown | null>;
  listObservations(query?: Query): Promise<unknown>;
  getObservation(id: string): Promise<unknown | null>;
  listGroups(query?: Query): Promise<unknown>;
  getGroup(id: string): Promise<unknown | null>;
  listGroupEvents(groupId: string, query?: Query): Promise<unknown>;
  listGroupReconciliations(groupId: string, query?: Query): Promise<unknown>;
  listResearchRuns(query?: Query): Promise<unknown>;
  getResearchRun(id: string): Promise<unknown | null>;
}

export interface PairReadRouteOptions {
  readonly repository: PairReadRouteRepository;
  readonly guard: (request: FastifyRequest, reply: FastifyReply) => Promise<boolean>;
  readonly nowMs?: () => number;
}

export function registerPairReadRoutes(app: FastifyInstance, options: PairReadRouteOptions): void {
  const execute = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operation: () => Promise<unknown>,
    detail = false,
  ): Promise<unknown> => {
    if (!(await options.guard(request, reply))) return;
    try {
      const result = await operation();
      if (detail && result === null) return reply.code(404).send({ error: "pair_resource_not_found" });
      return exactJson(result);
    } catch (error) {
      if (error instanceof PairReadModelValidationError) {
        return reply.code(400).send({ error: "invalid_pair_request", code: error.code, message: error.message });
      }
      request.log.error({ err: error }, "pair read request failed");
      return reply.code(500).send({ error: "pair_read_failed" });
    }
  };

  app.get("/api/pairs/summary", (request, reply) => execute(request, reply, async () => {
    assertNoQuery(request.query);
    return options.repository.getSummary((options.nowMs ?? Date.now)());
  }));
  app.get("/api/pairs/health", (request, reply) => execute(request, reply, async () => {
    assertNoQuery(request.query);
    return options.repository.getHealth();
  }));
  app.get("/api/pairs/episodes", (request, reply) => execute(request, reply,
    () => options.repository.listEpisodes(asQuery(request.query))));
  app.get("/api/pairs/episodes/:id", (request, reply) => execute(request, reply,
    () => options.repository.getEpisode(readId(request.params)), true));
  app.get("/api/pairs/observations", (request, reply) => execute(request, reply,
    () => options.repository.listObservations(asQuery(request.query))));
  app.get("/api/pairs/observations/:id", (request, reply) => execute(request, reply,
    () => options.repository.getObservation(readId(request.params)), true));
  app.get("/api/pairs/groups", (request, reply) => execute(request, reply,
    () => options.repository.listGroups(asQuery(request.query))));
  app.get("/api/pairs/groups/:id", (request, reply) => execute(request, reply,
    () => options.repository.getGroup(readId(request.params)), true));
  app.get("/api/pairs/groups/:id/events", (request, reply) => execute(request, reply,
    () => options.repository.listGroupEvents(readId(request.params), asQuery(request.query))));
  app.get("/api/pairs/groups/:id/reconciliations", (request, reply) => execute(request, reply,
    () => options.repository.listGroupReconciliations(readId(request.params), asQuery(request.query))));
  app.get("/api/pairs/research-runs", (request, reply) => execute(request, reply,
    () => options.repository.listResearchRuns(asQuery(request.query))));
  app.get("/api/pairs/research-runs/:id", (request, reply) => execute(request, reply,
    () => options.repository.getResearchRun(readId(request.params)), true));
}

function readId(params: unknown): string {
  const id = (params as { id?: unknown }).id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new PairReadModelValidationError("id must not be empty");
  }
  return id;
}

function asQuery(query: unknown): Query {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw new PairReadModelValidationError("query must be an object");
  }
  return query as Query;
}

function assertNoQuery(query: unknown): void {
  const keys = Object.keys(asQuery(query));
  if (keys.length > 0) throw new PairReadModelValidationError(`unsupported filters: ${keys.sort().join(",")}`);
}

function exactJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(exactJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, exactJson(item)]));
  }
  return value;
}
