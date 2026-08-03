import {
  datasetManifests, experimentDefinitions, experimentObservations, experimentRuns, sourceEvidence,
  type DbHandle,
} from "@b5p/db";
import { readFileSync } from "node:fs";

/**
 * Boot-time research-provenance seeding. The reproduction suite (R1-R8, R11)
 * runs against locally-held datasets (kachoio + collector exports) that never
 * ship to deployments; its persisted rows ARE the reproducible output —
 * content-addressed ids, deterministic checksums — exported to
 * apps/api/seeds/research-seed.json and upserted here so the Evidence Lab on a
 * deployment shows the real ledger. Idempotent by id; deployment-local rows
 * with other ids are never touched.
 */
export interface SeedResearchResult {
  manifests: number;
  definitions: number;
  runs: number;
  observations: number;
  evidence: number;
}

/** Revive the exporter's bigint encoding ("123n"); leave every other value alone. */
function revive(_k: string, v: unknown): unknown {
  return typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
}

export async function seedResearch(handle: DbHandle, seedPath: string): Promise<SeedResearchResult> {
  const seed = JSON.parse(readFileSync(seedPath, "utf8"), revive) as {
    datasetManifests: Array<typeof datasetManifests.$inferInsert>;
    experimentDefinitions: Array<typeof experimentDefinitions.$inferInsert>;
    experimentRuns: Array<typeof experimentRuns.$inferInsert>;
    experimentObservations: Array<typeof experimentObservations.$inferInsert>;
    sourceEvidence: Array<typeof sourceEvidence.$inferInsert>;
  };

  for (const row of seed.datasetManifests) {
    await handle.db.insert(datasetManifests).values(row)
      .onConflictDoUpdate({ target: datasetManifests.id, set: row });
  }
  for (const row of seed.experimentDefinitions) {
    await handle.db.insert(experimentDefinitions).values(row)
      .onConflictDoUpdate({ target: experimentDefinitions.id, set: row });
  }
  for (const row of seed.experimentRuns) {
    await handle.db.insert(experimentRuns).values(row)
      .onConflictDoUpdate({ target: experimentRuns.id, set: row });
  }
  for (const row of seed.experimentObservations) {
    await handle.db.insert(experimentObservations).values(row)
      .onConflictDoUpdate({ target: experimentObservations.id, set: row });
  }
  for (const row of seed.sourceEvidence) {
    await handle.db.insert(sourceEvidence).values(row)
      .onConflictDoUpdate({ target: sourceEvidence.id, set: row });
  }
  return {
    manifests: seed.datasetManifests.length,
    definitions: seed.experimentDefinitions.length,
    runs: seed.experimentRuns.length,
    observations: seed.experimentObservations.length,
    evidence: seed.sourceEvidence.length,
  };
}
