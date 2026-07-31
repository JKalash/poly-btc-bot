import { makeDb } from "@b5p/db";
import { backfillResolvedMarkets, runTimingStats } from "./backfill";

/** usage: pnpm research:backfill [-- hours=24] */
const hoursArg = process.argv.find((a) => a.startsWith("hours="));
const hours = hoursArg ? Number(hoursArg.split("=")[1]) : 24;

const db = await makeDb();
await db.migrate();
const nowEpoch = Math.floor(Date.now() / 1000);
console.log(`[research] backfilling ${hours}h of resolved markets from Gamma (slug enumeration)...`);
const res = await backfillResolvedMarkets(db, {
  fromEpoch: nowEpoch - hours * 3600,
  toEpoch: nowEpoch,
  onProgress: (p) => console.log(`[research] scanned ${p.scanned}/${p.total}, resolved found ${p.found}`),
});
console.log(`[research] backfill done: ${res.found} resolved markets from ${res.scanned} slots`);
console.log("[research] computing timing statistics...");
const run = await runTimingStats(db, { windowDaysList: [7, 14, 30] });
console.log(`[research] timing run ${run.runId} complete for windows ${run.windows.join(", ")}d`);
await db.close();
