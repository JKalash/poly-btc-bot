import { REDDIT_LAG_ARM_AND_WATCH } from "@b5p/evidence";
import path from "node:path";

import { checksumInputs, comparison, fmt, runPy } from "./common";
import type { ClaimComparison, ReproContext, ReproExperiment, ReproRunResult } from "./types";
import { detailNum, findObs } from "./verdicts";

/**
 * R1 — Feed lag and structural cross-feed basis.
 *
 * Runs on the local collector export (3 days, BTC, chainlink+binance). The
 * source's exact 5,826-window ETH study is DATA_GATED; the structural-offset
 * LESSON (an absolute gate smaller than normal basis fires structurally) is
 * tested on BTC, and the source's internal -0.4pp vs -0.5pp rounding gap is
 * checked from the fixture itself.
 */

const F = REDDIT_LAG_ARM_AND_WATCH;

const definition = Object.freeze({
  experimentKey: "R1_feed_lag_basis",
  title: "R1: cross-feed basis, gate false-fire, and lag reconciliation (local collector)",
  hypothesis:
    "An absolute cross-feed gate at 0.10% fires structurally on raw BTC basis, and rolling " +
    "structural-basis correction reduces the false-fire share by at least half.",
  nullHypothesis:
    "Structural correction does not materially reduce absolute-gate false fires (basis is already centered).",
  primaryMetric: "gate_false_fire_share_raw_vs_corrected_0.10pct",
  successCriteria:
    "SUPPORTED when corrected false-fire share <= 0.5x raw share at the 0.10% gate; REFUTED when " +
    "corrected >= raw; else INCONCLUSIVE. DATA_GATED when the collector export is absent.",
  sourceEvidenceIds: ["se-repro-reddit-efficient-markets-2026-arm-and-watch-lag"],
  datasetKeys: ["collector_local_btc_2026w31"],
  foldPlan: null, // 3-day sample; per-day folds are not meaningful here
});

async function run(ctx: ReproContext): Promise<ReproRunResult> {
  const t0 = Date.now();
  const doc = runPy({ ctx, script: "repro_r1_feedlag.py", outName: "r1.json", needsKachoio: false });
  const datasetChecksums = await checksumInputs(ctx.root, [
    path.join(ctx.collectorDir, "ref_ticks.csv"),
    path.join(ctx.collectorDir, "feature_market_snapshots.csv"),
  ]);

  const comparisons: ClaimComparison[] = [];

  // 1) The source's own arithmetic: printed gap vs printed operands (fixture-only check).
  const computedGapPpTenths = F.data.momentumSideResolutionPctTenths - F.data.observedPolymarketAskPctTenths;
  comparisons.push(comparison({
    sourceKey: F.sourceRef.sourceKey,
    claimKey: "arm_and_watch_gap_rounding",
    title: "Arm-and-watch reported gap (-0.4pp) vs its own printed operands (74.8 - 75.3)",
    claimText: "The post reports a -0.4pp gap while its printed rate and ask subtract to -0.5pp.",
    claimedValue: `${F.data.reportedGapPpTenths / 10}pp`,
    units: "pp",
    matchRule: "MATCH when reportedGap equals (rate - ask) from the same table; computed from the fixture, never re-transcribed.",
    reproducedValue: `${computedGapPpTenths / 10}pp (from fixture operands)`,
    verdict: computedGapPpTenths === F.data.reportedGapPpTenths ? "REPRODUCED_MATCH" : "REPRODUCED_MISMATCH",
    notes: "A source-internal inconsistency: preserved as a reconciliation issue per the brief, not corrected.",
  }));

  // 2) The 5,826-entry no-fillable-lag study itself: their windows are unavailable.
  const analogue = findObs(doc.observations, "momentum_side_rate_vs_ask", "overall");
  comparisons.push(comparison({
    sourceKey: F.sourceRef.sourceKey,
    claimKey: "arm_and_watch_no_fillable_lag",
    title: "Arm-and-watch: momentum side resolved 74.8% vs 75.3% ask over 5,826 entries (no fillable lag)",
    claimText: F.claimText,
    claimedValue: `rate ${F.data.momentumSideResolutionPctTenths / 10}% vs ask ${F.data.observedPolymarketAskPctTenths / 10}%`,
    units: "pct",
    matchRule: "Directly reproducible only on the source's recorded windows (ETH, offset-corrected cross-feed momentum).",
    reproducedValue: analogue?.value != null
      ? `BTC analogue (~T-30s, sign of Chainlink distance): ${analogue.valueText ?? fmt(analogue.value)} (n=${analogue.n})`
      : null,
    verdict: "DATA_GATED",
    gatedBy: "source's ETH tick recordings / 5,826 arm-and-watch windows - never published",
    notes:
      "Our small-n BTC analogue shows the momentum side resolving ABOVE its displayed ask (+6.5pp, n=62) - " +
      "the displayed-touch optimism documented in docs/research/calibration-study-2026-08.md Result 5, " +
      "not evidence of fillable lag; design differs from the source's.",
  }));

  // 3) The structural-offset lesson, tested on BTC.
  const fire10 = findObs(doc.observations, "gate_false_fire_share", "abs>=0.10pct");
  const raw = fire10?.value ?? null;
  const corrected = detailNum(fire10, "afterStructuralCorrection");
  comparisons.push(comparison({
    sourceKey: F.sourceRef.sourceKey,
    claimKey: "structural_offset_false_edge",
    title: "A 0.10% gate under a structural cross-feed offset fires structurally (the +$456 artifact)",
    claimText:
      "An apparent +$456 Chainlink/Binance offset strategy (0.10% entry vs ~0.12% structural ETH offset) " +
      "disappeared after offset correction.",
    claimedValue: "entry 0.10% vs structural ~0.12% (ETH)",
    units: "pct of price",
    matchRule:
      "Concept test on BTC: MATCH when structural-basis correction cuts the 0.10%-gate false-fire share " +
      "by >=50% (their ETH offset exceeded the gate; BTC basis is smaller, so shares differ by construction).",
    reproducedValue: raw != null
      ? `BTC raw fire ${fmt(raw)} -> corrected ${fmt(corrected)} (n=${fire10?.n})`
      : null,
    verdict: raw == null ? "DATA_GATED"
      : corrected != null && corrected <= raw * 0.5 ? "REPRODUCED_MATCH" : "REPRODUCED_MISMATCH",
    gatedBy: raw == null ? "local collector export (data/pglite reference_price_ticks) not present" : null,
    notes: "The exact ETH 0.12% offset is untestable here (no ETH feeds); gated observation emitted separately.",
  }));

  const hypothesisStatus = raw == null ? "DATA_GATED"
    : corrected != null && corrected <= raw * 0.5 ? "SUPPORTED"
    : corrected != null && corrected >= raw ? "REFUTED" : "INCONCLUSIVE";

  return {
    status: "COMPLETED",
    hypothesisStatus,
    observations: doc.observations,
    perDay: doc.perDay,
    comparisons,
    datasetChecksums,
    params: doc.params,
    summary: { dataset: doc.dataset, rawFire010: raw, correctedFire010: corrected },
    runtimeMs: Date.now() - t0,
    headline: raw == null
      ? "DATA_GATED: collector export absent"
      : `BTC basis: 0.10% gate fires ${fmt(raw)} raw -> ${fmt(corrected)} corrected; ` +
        `rounding gap -0.5 vs printed -0.4 detected; ETH study + book-reaction DATA_GATED`,
  };
}

export const R1_FEED_LAG: ReproExperiment = {
  key: definition.experimentKey,
  definition,
  requiredFixtures: ["REDDIT_LAG_ARM_AND_WATCH"],
  run,
};
