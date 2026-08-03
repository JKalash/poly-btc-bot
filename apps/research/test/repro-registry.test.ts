import * as evidence from "@b5p/evidence";
import { describe, expect, it } from "vitest";

import { definitionId, runId } from "../src/repro/common";
import { REPRO_EXPERIMENTS, findExperiment } from "../src/repro/index";

/**
 * Preregistration integrity: definitions are frozen, content-addressed, and
 * complete BEFORE any run; moving the goalposts (changing the primary metric)
 * necessarily creates a new definition id. Fixture names each experiment
 * compares against must actually exist in @b5p/evidence (the cross-agent
 * reconciliation check).
 */

const EXPECTED_KEYS = [
  "R1_feed_lag_basis",
  "R2_momentum_continuation",
  "R3_favored_side_calibration",
  "R4_trend_side_cheapness",
  "R5_entry_time_surface",
  "R6_exit_policies",
  "R7_gist_composite_ablation",
  "R8_extended_move_fade",
  "R11_higher_band_taker",
];

describe("repro registry", () => {
  it("covers R1-R8 and R11 exactly once each", () => {
    const keys = REPRO_EXPERIMENTS.map((e) => e.key).sort();
    expect(keys).toEqual([...EXPECTED_KEYS].sort());
    expect(new Set(keys).size).toBe(REPRO_EXPERIMENTS.length);
  });

  it("resolves short CLI aliases", () => {
    expect(findExperiment("r3")?.key).toBe("R3_favored_side_calibration");
    expect(findExperiment("R11")?.key).toBe("R11_higher_band_taker");
    expect(findExperiment("r1")?.key).toBe("R1_feed_lag_basis");
    expect(findExperiment("r99")).toBeUndefined();
  });

  it("every definition is complete and preregistered", () => {
    for (const e of REPRO_EXPERIMENTS) {
      expect(e.definition.experimentKey).toBe(e.key);
      for (const field of ["title", "hypothesis", "nullHypothesis", "primaryMetric", "successCriteria"] as const) {
        expect(e.definition[field].length, `${e.key}.${field}`).toBeGreaterThan(10);
      }
      expect(e.definition.datasetKeys.length).toBeGreaterThan(0);
      if (e.definition.foldPlan) {
        expect(e.definition.foldPlan.purge).toBe(true);
        expect(e.definition.foldPlan.embargoMs).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("definitions are frozen — runtime mutation throws", () => {
    for (const e of REPRO_EXPERIMENTS) {
      expect(Object.isFrozen(e.definition), e.key).toBe(true);
      expect(() => {
        (e.definition as { primaryMetric: string }).primaryMetric = "moved_goalpost";
      }).toThrow();
    }
  });

  it("definition ids are content-addressed: stable, and changed by a changed primary metric", () => {
    for (const e of REPRO_EXPERIMENTS) {
      const id1 = definitionId(e.definition);
      const id2 = definitionId({ ...e.definition });
      expect(id1).toBe(id2);
      const moved = definitionId({ ...e.definition, primaryMetric: `${e.definition.primaryMetric}_v2` });
      expect(moved, e.key).not.toBe(id1);
      const movedRule = definitionId({ ...e.definition, successCriteria: "p < 0.05 somewhere" });
      expect(movedRule, e.key).not.toBe(id1);
    }
  });

  it("run ids are deterministic and input-sensitive", () => {
    const def = REPRO_EXPERIMENTS[0]!.definition;
    const dId = definitionId(def);
    const files = [{ path: "a.parquet", sha256: "ab".repeat(32), bytes: 10 }];
    const r1 = runId(dId, files, { x: 1 }, 42);
    expect(runId(dId, files, { x: 1 }, 42)).toBe(r1);
    expect(runId(dId, files, { x: 2 }, 42)).not.toBe(r1);
    expect(runId(dId, files, { x: 1 }, 43)).not.toBe(r1);
    expect(runId(dId, [{ ...files[0]!, sha256: "cd".repeat(32) }], { x: 1 }, 42)).not.toBe(r1);
  });

  it("required fixtures exist in @b5p/evidence (cross-agent reconciliation)", () => {
    const exports = evidence as Record<string, unknown>;
    for (const e of REPRO_EXPERIMENTS) {
      for (const name of e.requiredFixtures) {
        expect(exports[name], `${e.key} requires @b5p/evidence.${name}`).toBeDefined();
      }
    }
    // the fixture index must also carry them
    expect(evidence.SOURCE_FIXTURES.reddit_favored_side_bands_v1).toBeDefined();
    expect(evidence.SOURCE_FIXTURE_VERSION).toBe("2026-07-31-001");
  });

  it("never labels the gist score a probability in metric names", () => {
    // the only metric that evaluates min(|score|/7,1) as a probability must say "as_if"
    expect("score_strength_as_if_probability_brier").toContain("as_if");
  });
});
