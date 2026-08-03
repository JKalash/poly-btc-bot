// One-command dev startup.
// - With DATABASE_URL set: expects Postgres (docker compose) and starts api + engine + web.
// - Without DATABASE_URL: embedded mode — PGlite + in-process engine inside the API,
//   so the whole system runs with zero external infrastructure.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
if (!existsSync(path.join(root, ".env")) && !process.env.SESSION_SECRET) {
  console.log("[dev] no .env found — using dev defaults (operator/operator). Copy .env.example to .env to customize.");
}

// Split-process mode REQUIRES a cross-process control bus: without REDIS_URL
// every control publish (kill switch, arm/disarm, resume, config reload)
// stays inside the API process and silently never reaches the engine. Force
// embedded mode rather than ship a dashboard whose emergency stop is a no-op.
const hasDb = Boolean(process.env.DATABASE_URL);
const hasRedis = Boolean(process.env.REDIS_URL);
const embedded = !hasDb || !hasRedis;
if (hasDb && !hasRedis) {
  console.warn("[dev] DATABASE_URL is set but REDIS_URL is not — forcing EMBEDDED mode so the kill switch and control channel actually reach the engine. Set REDIS_URL to run split-process.");
}
const procs = [];

function run(name, cmd, args, extraEnv = {}) {
  const p = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = `[${name}]`;
  p.stdout.on("data", (d) => process.stdout.write(String(d).split("\n").filter(Boolean).map((l) => `${tag} ${l}`).join("\n") + "\n"));
  p.stderr.on("data", (d) => process.stderr.write(String(d).split("\n").filter(Boolean).map((l) => `${tag} ${l}`).join("\n") + "\n"));
  p.on("exit", (code) => {
    console.log(`${tag} exited with code ${code}`);
    for (const q of procs) if (q !== p) q.kill();
    process.exit(code ?? 0);
  });
  procs.push(p);
  return p;
}

console.log(`[dev] mode: ${embedded ? "embedded (PGlite, engine runs inside API process)" : "external (Postgres/Redis, separate engine process)"}`);

run("api", "pnpm", ["--filter", "@b5p/api", "dev"], embedded ? { EMBED_ENGINE: "1" } : {});
if (!embedded) run("engine", "pnpm", ["--filter", "@b5p/engine", "dev"]);
run("web", "pnpm", ["--filter", "@b5p/web", "dev"]);

process.on("SIGINT", () => {
  for (const p of procs) p.kill("SIGINT");
  process.exit(0);
});
