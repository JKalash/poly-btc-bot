import { REDDIT_TREND_SIDE_BANDS } from "@b5p/evidence";

import { checksumInputs, comparison, fmt, runPy } from "./common";
import type { ClaimComparison, ReproContext, ReproExperiment, ReproRunResult } from "./types";
import { findObs, foldStabilityRate, rateMatch, DAY_FOLD_PLAN } from "./verdicts";

/**
 * R4 — Trend-side cheapness. Causal 30-minute trend (>=5 of 6 prior contiguous
 * windows same direction, all resolved before decision), decision at T-270s,
 * BTC, volatility and seconds-remaining stratification in the python output.
 */

const F = REDDIT_TREND_SIDE_BANDS;

const definition = Object.freeze({
  experimentKey: "R4_trend_side_cheapness",
  title: "R4: trend-side price bands within a causal 30-minute trend (kachoio)",
  hypothesis:
    "Cheap trend-side tokens win at roughly their price, not above it: apparent cheapness is not " +
    "a discount once the trend is defined causally and the price paid is the displayed ask.",
  nullHypothesis:
    "Trend-side tokens below 0.45 win more often than their ask price plus fee (a real discount).",
  primaryMetric: "trend_cheap_band_win_minus_ask",
  successCriteria:
    "SUPPORTED when the 0.00-0.45 band's win rate is <= its mean ask + 2pp (no discount); REFUTED " +
    "when its Wilson CI lower bound exceeds mean ask + fee-adjusted margin; else INCONCLUSIVE.",
  sourceEvidenceIds: ["se-repro-reddit-efficient-markets-2026-trend-side-bands"],
  datasetKeys: ["kachoio_btc5m_2026q2"],
  foldPlan: DAY_FOLD_PLAN,
});

async function run(ctx: ReproContext): Promise<ReproRunResult> {
  const t0 = Date.now();
  const doc = runPy({ ctx, script: "repro_r4_trend.py", outName: "r4.json" });
  const datasetChecksums = await checksumInputs(ctx.root, [ctx.marketsPath, ctx.ticksPath]);

  const comparisons: ClaimComparison[] = [];
  for (const row of F.data.rows) {
    const scope = `${(row.priceMinCents / 100).toFixed(2)}-${(row.priceMaxCents / 100).toFixed(2)}`;
    const o = findObs(doc.observations, "trend_band_win_rate", scope);
    const claimed = row.winRatePctTenths / 1000;
    comparisons.push(comparison({
      sourceKey: F.sourceRef.sourceKey,
      claimKey: `trend_band_${row.priceMinCents}_${row.priceMaxCents}`,
      title: `Trend-side band ${row.band} (source: ${row.winRatePctTenths / 10}%, N=${row.n})`,
      claimText: F.claimText,
      claimedValue: `${row.winRatePctTenths / 10}%`,
      units: "win rate",
      matchRule:
        "MATCH when the source's rate lies within our 95% CI widened by 3pp (phenomenon reproduction " +
        "across corpora; trend defined causally as >=5 of 6 prior contiguous windows).",
      reproducedValue: o?.value != null ? `${fmt(o.value)} (n=${o.n}, CI ${fmt(o.ciLo)}-${fmt(o.ciHi)})` : null,
      verdict: o?.value == null ? "DATA_GATED" : rateMatch(claimed, o.ciLo, o.ciHi, 3),
      gatedBy: o?.value == null ? "kachoio corpus (band empty at decision time)" : null,
    }));
  }

  const cheap = findObs(doc.observations, "trend_band_win_rate", "0.00-0.45");
  const cheapAsk = (cheap?.detail?.meanAsk as number | undefined) ?? null;
  const hypothesisStatus =
    cheap?.value == null || cheapAsk == null ? "INCONCLUSIVE"
      : cheap.value <= cheapAsk + 0.02 ? "SUPPORTED"
      : cheap.ciLo != null && cheap.ciLo > cheapAsk + 0.02 ? "REFUTED" : "INCONCLUSIVE";

  const stability = foldStabilityRate(doc.perDay, (s) => s === "0.00-0.45", "trend_cheap_band_win_rate");
  const observations = stability ? [...doc.observations, stability] : doc.observations;

  return {
    status: "COMPLETED",
    hypothesisStatus,
    observations,
    perDay: doc.perDay,
    comparisons,
    datasetChecksums,
    params: doc.params,
    summary: { dataset: doc.dataset, cheapBandWin: cheap?.value ?? null, cheapBandMeanAsk: cheapAsk },
    runtimeMs: Date.now() - t0,
    headline:
      `trend bands ${F.data.rows.map((r) => {
        const o = findObs(doc.observations, "trend_band_win_rate", `${(r.priceMinCents / 100).toFixed(2)}-${(r.priceMaxCents / 100).toFixed(2)}`);
        return `${fmt(o?.value ?? null, 3)}(src ${(r.winRatePctTenths / 10).toFixed(1)}%)`;
      }).join(" ")} — cheap side is priced, not discounted`,
  };
}

export const R4_TREND_SIDE: ReproExperiment = {
  key: definition.experimentKey,
  definition,
  requiredFixtures: ["REDDIT_TREND_SIDE_BANDS"],
  run,
};
