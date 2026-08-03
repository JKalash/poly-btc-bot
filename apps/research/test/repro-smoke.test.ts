import { experimentDefinitions, experimentObservations, experimentRuns, makeDb, sourceEvidence } from "@b5p/db";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { makeContext, observationsChecksum, pythonBin, workspaceRoot } from "../src/repro/common";
import { R2_MOMENTUM } from "../src/repro/r2-momentum";
import { R3_FAVORED_SIDE } from "../src/repro/r3-favored-side";
import { persistReproRun } from "../src/repro/persist";
import type { ReproContext } from "../src/repro/types";

/**
 * End-to-end harness tests on the COMMITTED synthetic mini-corpus
 * (py/fixtures/repro_smoke) — no real dataset, no network:
 *  - determinism: same manifest+seed => byte-identical observation checksums;
 *  - DATA_GATED labeling: absent datasets surface as named gates, never as
 *    silently skipped or fabricated results;
 *  - persistence: definition + run + observations + labeled evidence rows land
 *    in an in-memory PGlite, idempotently.
 */

const root = workspaceRoot();
const py = pythonBin(root);
const hasVenv = existsSync(py);
const smokeDir = path.join(root, "apps", "research", "py", "fixtures", "repro_smoke");
const outDir = path.join(root, "apps", "research", "py", "out", "repro-test");

function smokeCtx(overrides: Partial<ReproContext> = {}): ReproContext {
  return makeContext({
    marketsPath: path.join(smokeDir, "markets.csv"),
    ticksPath: path.join(smokeDir, "ticks.csv"),
    collectorDir: path.join(smokeDir, "no_such_collector_export"), // absent on purpose
    datasetKey: "repro_smoke_v1",
    outDir,
    nowMs: 1_770_000_000_000,
    codeVersion: "test",
    ...overrides,
  });
}

describe.skipIf(!hasVenv)("repro smoke (end-to-end, synthetic fixture)", () => {
  it("R3 runs on the smoke corpus and is deterministic: same inputs => identical observation checksums", { timeout: 120_000 }, async () => {
    rmSync(outDir, { recursive: true, force: true });
    const a = await R3_FAVORED_SIDE.run(smokeCtx());
    const b = await R3_FAVORED_SIDE.run(smokeCtx());
    expect(a.status).toBe("COMPLETED");
    expect(a.observations.length).toBeGreaterThan(20);
    expect(observationsChecksum(a.observations)).toBe(observationsChecksum(b.observations));
    expect(a.hypothesisStatus).toBeDefined();
    // the 127-gap accounting is present with every exclusion class named
    const classes = a.observations.filter((o) => o.metric === "gap_accounting_class");
    expect(classes.length).toBeGreaterThan(5);
    // band comparisons carry preregistered match rules and verdicts
    expect(a.comparisons.length).toBeGreaterThanOrEqual(7);
    for (const c of a.comparisons) {
      expect(c.matchRule.length).toBeGreaterThan(20);
      expect(["REPRODUCED_MATCH", "REPRODUCED_MISMATCH", "DATA_GATED"]).toContain(c.verdict);
    }
  });

  it("R2 labels missing datasets DATA_GATED with the exact dataset named", { timeout: 120_000 }, async () => {
    const r = await R2_MOMENTUM.run(smokeCtx());
    expect(r.status).toBe("COMPLETED");
    // ETH is always gated; the collector export is absent in this ctx
    const gatedObs = r.observations.filter((o) => (o.detail as Record<string, unknown> | null)?.dataGated);
    expect(gatedObs.length).toBeGreaterThanOrEqual(5);
    const gates = gatedObs.map((o) => String((o.detail as Record<string, unknown>).dataGated));
    expect(gates.some((g) => g.includes("ETH 1-minute candle dataset"))).toBe(true);
    expect(gates.some((g) => g.includes("reference_price_ticks"))).toBe(true);
    const gatedClaims = r.comparisons.filter((c) => c.verdict === "DATA_GATED");
    expect(gatedClaims.length).toBeGreaterThanOrEqual(2);
    for (const c of gatedClaims) expect(c.gatedBy, c.claimKey).toBeTruthy();
    // and the runnable part still ran: outcome-run continuation exists with n
    const runObs = r.observations.filter((o) => o.metric === "outcome_run_continuation" && o.value != null);
    expect(runObs.length).toBeGreaterThanOrEqual(4);
  });

  it("persists definition + run + observations + labeled evidence idempotently (in-memory PGlite)", { timeout: 180_000 }, async () => {
    const ctx = smokeCtx();
    const result = await R3_FAVORED_SIDE.run(ctx);
    const handle = await makeDb({ pgliteDir: "memory://repro-smoke-test" });
    try {
      await handle.migrate();
      const p1 = await persistReproRun(handle, R3_FAVORED_SIDE, ctx, result, { repro_smoke_v1: "dm-smoke" });
      const p2 = await persistReproRun(handle, R3_FAVORED_SIDE, ctx, result, { repro_smoke_v1: "dm-smoke" });
      expect(p2.runId).toBe(p1.runId); // deterministic run id => idempotent upsert
      expect(p2.resultChecksum).toBe(p1.resultChecksum);

      const defs = await handle.db.select().from(experimentDefinitions);
      const runs = await handle.db.select().from(experimentRuns);
      const obs = await handle.db.select().from(experimentObservations);
      const ev = await handle.db.select().from(sourceEvidence);
      expect(defs.some((d) => d.id === p1.definitionId && d.experimentKey === "R3_favored_side_calibration")).toBe(true);
      expect(runs.filter((r) => r.id === p1.runId)).toHaveLength(1);
      expect(runs[0]!.resultChecksum).toBe(p1.resultChecksum);
      expect(obs.filter((o) => o.runId === p1.runId)).toHaveLength(result.observations.length);
      // every comparison landed as a labeled evidence row pointing at the run
      const reproEv = ev.filter((e) => e.reproductionRunId === p1.runId);
      expect(reproEv).toHaveLength(result.comparisons.length);
      for (const row of reproEv) {
        expect(["REPRODUCED_MATCH", "REPRODUCED_MISMATCH", "DATA_GATED"]).toContain(row.label);
        expect(row.methodologyNotes).toContain("match rule:");
      }
    } finally {
      await handle.close();
    }
  });
});

describe("repro smoke guard", () => {
  it("smoke fixture files are committed and present", () => {
    expect(existsSync(path.join(smokeDir, "markets.csv"))).toBe(true);
    expect(existsSync(path.join(smokeDir, "ticks.csv"))).toBe(true);
  });
});
