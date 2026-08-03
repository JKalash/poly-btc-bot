// Production single-machine runner (Fly.io / any container): API with embedded
// engine + built Next.js web, one process tree, PGlite on the mounted volume.
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const procs = [];

function run(name, cmd, args, extraEnv = {}) {
  const p = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "inherit", "inherit"],
  });
  p.on("exit", (code) => {
    console.log(`[${name}] exited with code ${code}; shutting down`);
    for (const q of procs) if (q !== p) q.kill();
    process.exit(code ?? 1);
  });
  procs.push(p);
}

console.log("[prod] starting api (engine embedded) + web (next start)");
run("api", "pnpm", ["--filter", "@b5p/api", "start"], { EMBED_ENGINE: "1" });
run("web", "pnpm", ["--filter", "@b5p/web", "start"], { API_PROXY_TARGET: "http://127.0.0.1:8787" });

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const p of procs) p.kill(sig);
    process.exit(0);
  });
}
