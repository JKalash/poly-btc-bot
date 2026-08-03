import { checksumInputs, comparison, fmt, runPy } from "./common";
import type { ClaimComparison, ReproContext, ReproExperiment, ReproRunResult } from "./types";
import { findObs, foldStabilityRate, DAY_FOLD_PLAN } from "./verdicts";

/**
 * R11 — Higher-band taker microstructure: an OPEN RESEARCH SLOT. The commenter
 * supplied no method, so every term the brief requires is preregistered HERE
 * (our definitions, not theirs) and the claim itself stays DATA_GATED on the
 * commenter's method/trade log. Our analogue runs on kachoio and reports ROI
 * with slippage and drawdown; nothing is promotable from this slot.
 */

const definition = Object.freeze({
  experimentKey: "R11_higher_band_taker",
  title: "R11: higher-band taker microstructure research slot (preregistered analogue)",
  hypothesis:
    "Under OUR preregistered definitions (favored ask in [0.80,0.97) at T-30s, favored mid rising " +
    "over the prior 30s, taker at the displayed ask, current 0.07 fee), per-trade ROI at the " +
    "displayed touch is positive — an analogue, NOT a verification, of the commenter's ~3% ROI.",
  nullHypothesis: "Analogue per-trade ROI <= 0 at the displayed touch.",
  primaryMetric: "higher_band_roi_per_trade",
  successCriteria:
    "SUPPORTED when the primary ROI's 95% CI lower bound > 0 at the displayed touch; REFUTED when " +
    "the CI upper bound < 0; else INCONCLUSIVE. Any SUPPORTED verdict carries the latency-pool " +
    "attribution and the 1-tick-slippage variant, and authorizes nothing.",
  sourceEvidenceIds: ["se-repro-reddit-efficient-markets-2026-higher-band-taker"],
  datasetKeys: ["kachoio_btc5m_2026q2"],
  foldPlan: DAY_FOLD_PLAN,
});

async function run(ctx: ReproContext): Promise<ReproRunResult> {
  const t0 = Date.now();
  const doc = runPy({ ctx, script: "repro_r11_higher_band.py", outName: "r11.json" });
  const datasetChecksums = await checksumInputs(ctx.root, [ctx.marketsPath, ctx.ticksPath]);

  const roi = findObs(doc.observations, "higher_band_roi_per_trade", "primary");
  const roiSlip = findObs(doc.observations, "higher_band_roi_per_trade", "slippage_1_tick");
  const dd = findObs(doc.observations, "higher_band_max_drawdown_usd_per_1usd_stakes", "primary");

  const comparisons: ClaimComparison[] = [comparison({
    sourceKey: "reddit_efficient_markets_2026",
    claimKey: "higher_band_taker_3pct_roi",
    title: "Commenter claim: ~3% ROI from taker-side microstructure at higher price bands",
    claimText:
      "One commenter reports ~3% ROI using taker-side microstructure at higher price bands after " +
      "~1 year of research and 2 months live; no trades, bankroll convention, CI, or P&L supplied.",
    claimedValue: "~3% ROI",
    units: "ROI per trade (denominator: per-trade cost basis)",
    matchRule:
      "The claim is unverifiable without the commenter's method and trade log; our preregistered " +
      "analogue (band [0.80,0.97), 30s drift filter, T-30s, fee 0.07) is reported alongside but can " +
      "neither confirm nor refute their number.",
    reproducedValue: roi?.value != null
      ? `analogue ROI ${fmt(roi.value)} (CI ${fmt(roi.ciLo)}-${fmt(roi.ciHi)}, n=${roi.n}); ` +
        `with 1-tick slippage ${fmt(roiSlip?.value ?? null)}; max drawdown $${fmt(dd?.value ?? null, 2)} per $1 stakes`
      : null,
    verdict: "DATA_GATED",
    gatedBy: "commenter's method and complete trade log - never published",
    notes:
      "Analogue positivity at the displayed touch is the late-favorite drift (calibration study Result 5: " +
      "stale quotes, ~$100 displayed size, HFT latency pool) — it does not validate the commenter's claim.",
  })];

  const hypothesisStatus = roi?.value == null ? "DATA_GATED"
    : roi.ciLo != null && roi.ciLo > 0 ? "SUPPORTED"
    : roi.ciHi != null && roi.ciHi < 0 ? "REFUTED" : "INCONCLUSIVE";

  const stability = foldStabilityRate(doc.perDay, (s) => s === "higher_band", "higher_band_win_rate");
  const observations = stability ? [...doc.observations, stability] : doc.observations;

  return {
    status: "COMPLETED",
    hypothesisStatus,
    observations,
    perDay: doc.perDay,
    comparisons,
    datasetChecksums,
    params: doc.params,
    summary: {
      dataset: doc.dataset,
      roiTouch: roi?.value ?? null,
      roiSlipped: roiSlip?.value ?? null,
      maxDrawdown: dd?.value ?? null,
      promotable: false,
    },
    runtimeMs: Date.now() - t0,
    headline:
      `analogue ROI ${fmt(roi?.value ?? null)} touch / ${fmt(roiSlip?.value ?? null)} slipped (n=${roi?.n ?? 0}); ` +
      `commenter's 3% claim stays DATA_GATED (no method/trade log); latency-pool attribution applies`,
  };
}

export const R11_HIGHER_BAND: ReproExperiment = {
  key: definition.experimentKey,
  definition,
  requiredFixtures: [],
  run,
};
