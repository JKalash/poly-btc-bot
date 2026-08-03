import { makeDb } from "@b5p/db";
import path from "node:path";
import { seedCalibration } from "./seed-calibration";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const outDir = path.join(import.meta.dirname, "..", "py", "out");
const artifactPath = arg("artifact", path.join(outDir, "calibrated_logistic_kachoio_T90.json"));
const decisionPath = arg("decision", path.join(outDir, "decision_kachoio_T90.json"));

const db = await makeDb();
await db.migrate();
const r = await seedCalibration(db, { artifactPath, decisionPath, nowMs: Date.now() });
console.log(
  `[research] calibration registry seeded: model artifact ${r.modelArtifactId}, ` +
  `${r.calibrationRows} calibration fit(s), decision ${r.decisionId} ` +
  `(approved=${r.approved}, active=${r.active})`,
);
await db.close();
