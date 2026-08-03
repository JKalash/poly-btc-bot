import { REDDIT_MOMENTUM_CONTINUATION, REDDIT_SUSTAINED_RUN } from "@b5p/evidence";
import path from "node:path";

import { checksumInputs, comparison, fmt, runPy } from "./common";
import type { ClaimComparison, ReproContext, ReproExperiment, ReproRunResult } from "./types";
import { findObs, foldStabilityRate, rateMatch, DAY_FOLD_PLAN } from "./verdicts";

/**
 * R2 — Momentum / sustained-run continuation. BTC only (ETH DATA_GATED, named).
 * Chainlink vs Binance window-delta continuation run separately on the 3-day
 * collector export; the main BTC series is kachoio market OUTCOMES (the
 * resolution source itself, 8 weeks) — never pooled with the source's ETH.
 */

const SUS = REDDIT_SUSTAINED_RUN;
const MOM = REDDIT_MOMENTUM_CONTINUATION;

const definition = Object.freeze({
  experimentKey: "R2_momentum_continuation",
  title: "R2: momentum & sustained-run continuation on BTC (kachoio outcomes + collector deltas)",
  hypothesis:
    "The source's ETH pattern reproduces on BTC market outcomes: continuation is below 50% and " +
    "declines monotonically with run length (mean reversion grows with run persistence).",
  nullHypothesis: "Continuation is independent of run length (flat at ~50%).",
  primaryMetric: "outcome_run_continuation_monotonicity",
  successCriteria:
    "SUPPORTED when continuation for run>=2..run>=5 is strictly decreasing AND every rate < 0.5; " +
    "REFUTED when any rate >= 0.5 or the ordering increases; else INCONCLUSIVE.",
  sourceEvidenceIds: ["se-repro-reddit-efficient-markets-2026-sustained-run"],
  datasetKeys: ["kachoio_btc5m_2026q2", "collector_local_btc_2026w31"],
  foldPlan: DAY_FOLD_PLAN,
});

const ETH_GATE = "source's ~3-year ETH 1-minute candle dataset (1.73M bars / 346,094 windows) - never published";

async function run(ctx: ReproContext): Promise<ReproRunResult> {
  const t0 = Date.now();
  const doc = runPy({ ctx, script: "repro_r2_momentum.py", outName: "r2.json" });
  const datasetChecksums = await checksumInputs(ctx.root, [
    ctx.marketsPath, ctx.ticksPath, path.join(ctx.collectorDir, "ref_ticks.csv"),
  ]);

  const comparisons: ClaimComparison[] = [];
  const runRates: Array<number | null> = [];
  for (const row of SUS.data.rows.filter((r) => r.minTotalMovePpm === null)) {
    const scope = `run>=${row.minRunBlocks}`;
    const o = findObs(doc.observations, "outcome_run_continuation", scope);
    runRates.push(o?.value ?? null);
    const claimed = row.continuationWinRatePctTenths / 1000;
    comparisons.push(comparison({
      sourceKey: SUS.sourceRef.sourceKey,
      claimKey: `sustained_run_ge${row.minRunBlocks}`,
      title: `Sustained-run continuation, ${row.filter} (source ETH: ${row.continuationWinRatePctTenths / 10}%)`,
      claimText: SUS.claimText,
      claimedValue: `${row.continuationWinRatePctTenths / 10}%`,
      units: "continuation rate",
      matchRule:
        "MATCH when our BTC-outcome rate is < 0.5 AND the source's rate lies within our 95% CI widened " +
        "by 3pp (phenomenon reproduction across asset/period, not digit equality).",
      reproducedValue: o?.value != null ? `${fmt(o.value)} (n=${o.n}, CI ${fmt(o.ciLo)}-${fmt(o.ciHi)})` : null,
      verdict: o?.value == null ? "DATA_GATED"
        : o.value < 0.5 ? rateMatch(claimed, o.ciLo, o.ciHi, 3) : "REPRODUCED_MISMATCH",
      gatedBy: o?.value == null ? "kachoio corpus (data/research/kachoio) not present" : null,
      notes: "BTC 5m market outcomes (Chainlink-resolved), 2026 Mar-May; source is ETH candles over ~3 years.",
    }));
  }
  // magnitude-conditioned sustained-run row + the momentum magnitude table
  const magRow = SUS.data.rows.find((r) => r.minTotalMovePpm !== null)!;
  comparisons.push(comparison({
    sourceKey: SUS.sourceRef.sourceKey,
    claimKey: "sustained_run_ge4_move_ge08pct",
    title: `Sustained run ${magRow.filter} (source: ${magRow.continuationWinRatePctTenths / 10}%)`,
    claimText: SUS.claimText,
    claimedValue: `${magRow.continuationWinRatePctTenths / 10}%`,
    units: "continuation rate",
    matchRule: "Requires a multi-month reference price stream to measure cumulative run magnitude.",
    reproducedValue: null,
    verdict: "DATA_GATED",
    gatedBy: ETH_GATE,
    notes: "kachoio carries no underlying price stream; the 3-day collector overlap yields ~0 qualifying runs.",
  }));
  for (const row of MOM.data.rows) {
    const scope = row.minPriorMovePpm === null ? "any" : `>=${(row.minPriorMovePpm / 10000).toFixed(2)}pct`;
    const cl = findObs(doc.observations, "delta_continuation_chainlink", scope);
    const bn = findObs(doc.observations, "delta_continuation_binance", scope);
    const claimed = row.continuationWinRatePctTenths / 1000;
    const usable = cl?.value != null ? cl : null;
    comparisons.push(comparison({
      sourceKey: MOM.sourceRef.sourceKey,
      claimKey: `momentum_continuation_${scope.replaceAll(">=", "ge").replaceAll(".", "")}`,
      title: `Momentum continuation, filter "${row.filter}" (source ETH: ${row.continuationWinRatePctTenths / 10}%)`,
      claimText: MOM.claimText,
      claimedValue: `${row.continuationWinRatePctTenths / 10}%`,
      units: "continuation rate",
      matchRule:
        "Chainlink and Binance window-delta continuation computed SEPARATELY on the 3-day BTC collector " +
        "sample; MATCH when the source's rate lies within our chainlink 95% CI widened by 3pp; the ETH " +
        "original remains gated regardless.",
      reproducedValue: usable
        ? `chainlink ${fmt(usable.value)} (n=${usable.n}, CI ${fmt(usable.ciLo)}-${fmt(usable.ciHi)})` +
          (bn?.value != null ? `; binance ${fmt(bn.value)} (n=${bn.n})` : "; binance insufficient")
        : null,
      verdict: usable ? rateMatch(claimed, usable.ciLo, usable.ciHi, 3) : "DATA_GATED",
      gatedBy: usable ? null : "local collector export (data/pglite reference_price_ticks) not present or insufficient n",
      notes: "3-day BTC sample - CIs are wide by construction; never pooled with kachoio outcomes or the source's ETH.",
    }));
  }
  comparisons.push(comparison({
    sourceKey: MOM.sourceRef.sourceKey,
    claimKey: "momentum_continuation_eth",
    title: "ETH momentum/continuation reproduction",
    claimText: MOM.claimText,
    claimedValue: "~49.0% / 48.0% / 46.5%",
    units: "continuation rate",
    matchRule: "Requires the source's ETH dataset.",
    reproducedValue: null,
    verdict: "DATA_GATED",
    gatedBy: ETH_GATE,
  }));

  const present = runRates.filter((r): r is number => r != null);
  const monotone = present.length === 4 && present.every((r, i) => r < 0.5 && (i === 0 || r < present[i - 1]!));
  const anyHigh = present.some((r) => r >= 0.5);
  const hypothesisStatus = present.length < 4 ? "INCONCLUSIVE" : monotone ? "SUPPORTED" : anyHigh ? "REFUTED" : "INCONCLUSIVE";

  const stability = foldStabilityRate(doc.perDay, (s) => s === "run>=2", "continuation_run_ge2");
  const observations = stability ? [...doc.observations, stability] : doc.observations;

  return {
    status: "COMPLETED",
    hypothesisStatus,
    observations,
    perDay: doc.perDay,
    comparisons,
    datasetChecksums,
    params: doc.params,
    summary: { dataset: doc.dataset, runContinuation: present },
    runtimeMs: Date.now() - t0,
    headline:
      `BTC outcome continuation run>=2..5: ${present.map((r) => fmt(r, 3)).join(" > ")} ` +
      `(${monotone ? "monotone decline, matches source shape" : "ordering differs from source"}); ETH gated`,
  };
}

export const R2_MOMENTUM: ReproExperiment = {
  key: definition.experimentKey,
  definition,
  requiredFixtures: ["REDDIT_SUSTAINED_RUN", "REDDIT_MOMENTUM_CONTINUATION"],
  run,
};
