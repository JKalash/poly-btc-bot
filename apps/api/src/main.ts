import { makeDb, type DbHandle } from "@b5p/db";
import { createEngineRuntime, logger, type EngineRuntime } from "@b5p/engine";
import { AuthService } from "./auth";
import { buildServer, makeApiBus } from "./server";

/**
 * API entry point.
 * EMBED_ENGINE=1 (zero-install dev): the engine runs inside this process and
 * shares its PGlite handle — PGlite is single-connection, so both components
 * must use one handle. With DATABASE_URL (Postgres), api and engine run as
 * separate processes and this flag stays unset.
 */

let engineRuntime: EngineRuntime | null = null;
let db: DbHandle;

if (process.env.EMBED_ENGINE === "1") {
  engineRuntime = await createEngineRuntime();
  db = engineRuntime.engine.db;
  logger.info("api: engine embedded in-process");
} else {
  db = await makeDb();
  await db.migrate();
}

const auth = new AuthService();
const pw = await auth.ensurePasswordHash();
if (pw.devDefault) {
  logger.warn("api: OPERATOR_PASSWORD_HASH not set — using dev default operator/operator. Set real credentials in .env for anything beyond local experimentation.");
}
if (auth.devFallback) {
  logger.warn("api: SESSION_SECRET not set — sessions will not survive an API restart.");
}

const bus = await makeApiBus();
const app = await buildServer({ db, bus, auth, requireAuth: true });

const host = process.env.API_HOST ?? "127.0.0.1";
const port = Number(process.env.API_PORT ?? 8787);
await app.listen({ host, port });
logger.info(`api listening on http://${host}:${port}`, { embeddedEngine: engineRuntime !== null });

const shutdown = async (): Promise<void> => {
  logger.info("api shutting down");
  await app.close();
  if (engineRuntime) await engineRuntime.stop();
  else await db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
