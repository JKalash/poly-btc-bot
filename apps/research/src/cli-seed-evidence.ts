import { makeDb } from "@b5p/db";
import { seedEvidence } from "./seed-evidence";

const db = await makeDb();
await db.migrate();
const r = await seedEvidence(db, Date.now());
console.log(
  `[research] evidence seed complete: manifest ${r.manifestMaterialized ? "materialized (checksummed)" : "UNMATERIALIZED (files absent)"}, ` +
  `${r.filesChecksummed} file(s) checksummed, ${r.evidenceRows} evidence row(s), calibration run ${r.runBackfilled ? "backfilled" : "not backfilled (study_results.json absent)"}`,
);
await db.close();
