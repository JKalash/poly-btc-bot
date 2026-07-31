import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  kind: "pg" | "pglite";
  close(): Promise<void>;
  migrate(): Promise<void>;
}

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Anchor the default PGlite dir at the workspace root so api/engine/CLIs share one database regardless of CWD. */
function defaultPgliteDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return path.join(dir, "data", "pglite");
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), "data", "pglite");
}

/**
 * DATABASE_URL set   -> node-postgres (canonical, docker compose).
 * DATABASE_URL unset -> embedded PGlite under PGLITE_DIR (zero-install dev).
 */
export async function makeDb(opts: { databaseUrl?: string | undefined; pgliteDir?: string | undefined } = {}): Promise<DbHandle> {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const db = drizzlePg(pool, { schema });
    return {
      db,
      kind: "pg",
      close: async () => { await pool.end(); },
      migrate: async () => { await migratePg(db, { migrationsFolder }); },
    };
  }
  const dir = opts.pgliteDir ?? process.env.PGLITE_DIR ?? defaultPgliteDir();
  if (!dir.startsWith("memory://")) mkdirSync(dir, { recursive: true });
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = new PGlite(dir);
  const db = drizzlePglite(pglite, { schema });
  return {
    db,
    kind: "pglite",
    close: async () => { await pglite.close(); },
    migrate: async () => { await migratePglite(db, { migrationsFolder }); },
  };
}

export { schema };
