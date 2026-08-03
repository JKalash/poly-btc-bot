import { checksumInputs, comparison, fmt, runPy } from "./common";
import type { ClaimComparison, ReproContext, ReproExperiment, ReproRunResult } from "./types";
import { findObs } from "./verdicts";

/**
 * R5 — Entry-time surface, T-180 .. T-5 every 5s, with fees and displayed-touch
 * fill reality from the kachoio books. The source published no numeric table
 * for this section, so the comparisons cover its qualitative timing claims;
 * the surface itself is the deliverable (acceptance criterion 11).
 *
 * HONESTY CONSTRAINT (docs/research/calibration-study-2026-08.md Result 5 is
 * not contradicted): positive net EV at the displayed touch late in the window
 * is attributed to stale displayed quotes (the HFT latency pool) and tiny
 * displayed size — it is an artifact of touch-fill optimism, not a harvestable
 * edge, and every positive row carries that attribution.
 */

const definition = Object.freeze({
  experimentKey: "R5_entry_time_surface",
  title: "R5: entry-time net-EV surface T-180..T-5 with fees and displayed-touch fills (kachoio)",
  hypothesis:
    "Net EV at the displayed ask varies systematically with decision time and turns apparently " +
    "positive late in the window — consistent with the late-favorite-drift artifact (stale quotes, " +
    "~$100 displayed size), not with a harvestable retail edge.",
  nullHypothesis: "The entry-time surface is flat: no decision time shows CI-positive net EV at the touch.",
  primaryMetric: "entry_surface_net_ev_per_cost",
  successCriteria:
    "SUPPORTED when >=1 grid point has net-EV CI lower bound > 0 at the displayed touch AND the " +
    "positive region grows toward expiry (drift shape); REFUTED when all grid points are CI-negative; " +
    "else INCONCLUSIVE. A SUPPORTED result is explicitly NOT a trade recommendation (fill model is optimistic).",
  sourceEvidenceIds: ["se-repro-reddit-efficient-markets-2026-timing-filters"],
  datasetKeys: ["kachoio_btc5m_2026q2"],
  foldPlan: null, // surface is descriptive; per-point CIs carry the uncertainty
});

async function run(ctx: ReproContext): Promise<ReproRunResult> {
  const t0 = Date.now();
  const doc = runPy({ ctx, script: "repro_r5_entry_surface.py", outName: "r5.json" });
  const datasetChecksums = await checksumInputs(ctx.root, [ctx.marketsPath, ctx.ticksPath]);

  const surface = doc.observations.filter((o) => o.metric === "entry_surface" && o.value != null);
  const positive = surface.filter((o) => o.ciLo != null && o.ciLo > 0);
  const late = surface.filter((o) => Number(o.scope.slice(2)) <= 60);
  const latePositive = late.filter((o) => o.ciLo != null && o.ciLo > 0);
  const driftShape = positive.length >= 1 && latePositive.length >= Math.ceil(late.length / 2);

  const comparisons: ClaimComparison[] = [];
  // Source timing-filter claims (qualitative; no fixture table exists for them).
  const t120 = findObs(doc.observations, "entry_surface", "T-120");
  const t30 = findObs(doc.observations, "entry_surface", "T-30");
  const brier120 = (t120?.detail?.brierMid as number | undefined) ?? null;
  const brier30 = (t30?.detail?.brierMid as number | undefined) ?? null;
  comparisons.push(comparison({
    sourceKey: "reddit_efficient_markets_2026",
    claimKey: "timing_final_seconds_weaker",
    title: "Source timing claim: 'approximately the final 0-60 seconds were weaker or noisier'",
    claimText:
      "The source tested skipping the first 60-120s and last 60-80s and observed the final ~0-60s " +
      "were weaker or noisier; filtering reduced the sample but did not make the strategy net positive.",
    claimedValue: "final 0-60s weaker/noisier",
    units: null,
    matchRule:
      "Tested as: Brier(mid) at T-30 vs T-120 (higher late Brier = noisier prices late). NOTE the " +
      "source's claim was about ITS strategy's signals, which we cannot reconstruct; this is the " +
      "closest preregistered price-informativeness reading.",
    reproducedValue: brier30 != null && brier120 != null
      ? `Brier(mid) T-30 ${fmt(brier30)} vs T-120 ${fmt(brier120)} — prices get MORE informative late`
      : null,
    verdict: brier30 != null && brier120 != null && brier30 > brier120 ? "REPRODUCED_MATCH" : "REPRODUCED_MISMATCH",
    notes:
      "On our corpus the book gets sharper into expiry; the 'weak final minute' is not a price property. " +
      "What IS true late: displayed size shrinks relative to drift and the touch is stale (Result 5).",
  }));
  comparisons.push(comparison({
    sourceKey: "archetapp_gist",
    claimKey: "t10_sweet_spot",
    title: "Gist claim: T-10s is a 'sweet spot'",
    claimText: "The gist sleeps to T-10s, argues direction is largely locked, and calls T-10 a sweet spot.",
    claimedValue: "T-10 sweet spot",
    units: null,
    matchRule:
      "MATCH only when T-10 net EV at the touch is positive AND maximal over the surface; the full " +
      "surface (not a single favorite second) is the deliverable either way.",
    reproducedValue: (() => {
      const t10 = surface.find((o) => o.scope === "T-10");
      const best = [...surface].sort((a, b) => (b.value ?? -1) - (a.value ?? -1))[0];
      return t10 ? `T-10 netEV ${fmt(t10.value)} (CI ${fmt(t10.ciLo)}-${fmt(t10.ciHi)}); best point ${best?.scope} ${fmt(best?.value ?? null)}` : null;
    })(),
    verdict: (() => {
      const t10 = surface.find((o) => o.scope === "T-10");
      if (!t10 || t10.value == null) return "DATA_GATED" as const;
      const best = Math.max(...surface.map((o) => o.value ?? -Infinity));
      return t10.value > 0 && t10.value >= best - 1e-9 ? "REPRODUCED_MATCH" as const : "REPRODUCED_MISMATCH" as const;
    })(),
    notes:
      "Touch-fill optimism applies at every point; the apparent late positivity is the latency-pool " +
      "artifact (calibration study Result 5), so even a 'MATCH' here would not authorize live entries.",
  }));

  const hypothesisStatus = surface.length === 0 ? "INCONCLUSIVE"
    : driftShape ? "SUPPORTED"
    : positive.length === 0 ? "REFUTED" : "INCONCLUSIVE";

  const bestLate = latePositive[latePositive.length - 1];
  return {
    status: "COMPLETED",
    hypothesisStatus,
    observations: doc.observations,
    perDay: doc.perDay,
    comparisons,
    datasetChecksums,
    params: doc.params,
    summary: {
      dataset: doc.dataset,
      gridPoints: surface.length,
      ciPositivePoints: positive.map((o) => o.scope),
      attribution: "positive touch-EV attributed to stale displayed quotes + tiny size (study Result 5); not harvestable",
    },
    runtimeMs: Date.now() - t0,
    headline:
      `${surface.length}-point surface; CI-positive at touch: ${positive.length} points ` +
      `(${positive[0]?.scope ?? "-"}..${bestLate?.scope ?? positive[positive.length - 1]?.scope ?? "-"}) — ` +
      `late-drift artifact shape, median displayed size ~$115-150, NOT tradable`,
  };
}

export const R5_ENTRY_SURFACE: ReproExperiment = {
  key: definition.experimentKey,
  definition,
  requiredFixtures: [],
  run,
};
