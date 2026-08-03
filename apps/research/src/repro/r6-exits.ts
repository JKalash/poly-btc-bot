import { REDDIT_EXIT_PULLBACK_RECOVERY } from "@b5p/evidence";

import { checksumInputs, comparison, fmt, runPy } from "./common";
import type { ClaimComparison, PyObservation, ReproContext, ReproExperiment, ReproRunResult } from "./types";
import { findObs, DAY_FOLD_PLAN } from "./verdicts";

/**
 * R6 — Exit policies: pullback/recovery reproduction + exit-rule grid.
 * Primary comparable window is entry..T-60s (preregistered: the full window's
 * terminal convergence makes recovery tautological — winners always regain
 * entry en route to 1.0 — and the source's 97%/32%/38pt numbers are only
 * reachable if its measurement excluded that convergence; the full-window
 * variant ships alongside as the tautology exhibit).
 */

const F = REDDIT_EXIT_PULLBACK_RECOVERY;

const definition = Object.freeze({
  experimentKey: "R6_exit_policies",
  title: "R6: exit-policy grid + winner/loser pullback and recovery (kachoio)",
  hypothesis:
    "No tested exit rule (fixed stops, trailing stops, break-even arming, take-profit ladders, " +
    "threshold-cross, time exit) improves mean PnL over hold-to-resolution on the same favored-side " +
    "entries: stops convert normal winner volatility into realized losses.",
  nullHypothesis: "At least one exit rule beats hold-to-resolution mean PnL per cost.",
  primaryMetric: "exit_policy_pnl_per_cost_vs_hold",
  successCriteria:
    "SUPPORTED when every tested policy's mean PnL/cost is below hold-to-resolution's; REFUTED when " +
    "any policy's CI lower bound exceeds hold's mean; else INCONCLUSIVE.",
  sourceEvidenceIds: ["se-repro-reddit-efficient-markets-2026-exit-pullback-recovery"],
  datasetKeys: ["kachoio_btc5m_2026q2"],
  foldPlan: DAY_FOLD_PLAN,
});

/** Preregistered tolerances for the pullback numerics ("approximately"-claims get the wide band). */
const DEPTH_TOL_PP = 8;
const RATE_TOL_PP = 8;

async function run(ctx: ReproContext): Promise<ReproRunResult> {
  const t0 = Date.now();
  const doc = runPy({ ctx, script: "repro_r6_exits.py", outName: "r6.json" });
  const datasetChecksums = await checksumInputs(ctx.root, [ctx.marketsPath, ctx.ticksPath]);

  const comparisons: ClaimComparison[] = [];
  const within = (ours: number | null, claimed: number, tol: number) =>
    ours != null && Math.abs(ours - claimed) <= tol ? "REPRODUCED_MATCH" as const : "REPRODUCED_MISMATCH" as const;
  const pre = (metric: string, scope: string) => findObs(doc.observations, metric, scope);

  const numeric: Array<{ key: string; title: string; claimed: number; units: string; o: PyObservation | undefined; tol: number; scale?: number }> = [
    { key: "winner_pullback_depth", title: "Winners' first pullback ~22pp", claimed: F.data.winnerFirstPullbackAvgPpTenthsApprox / 10, units: "pp", o: pre("pullback_depth_points", "winners_preT60"), tol: DEPTH_TOL_PP },
    { key: "winner_pullback_recovery", title: "97% of winner pullbacks recovered", claimed: F.data.winnerPullbackRecoveryPctTenths / 10, units: "%", o: pre("pullback_recovery_rate", "winners_preT60"), tol: RATE_TOL_PP, scale: 100 },
    { key: "loser_pullback_depth", title: "Losers' first pullback ~38pp", claimed: F.data.loserFirstPullbackAvgPpTenthsApprox / 10, units: "pp", o: pre("pullback_depth_points", "losers_preT60"), tol: DEPTH_TOL_PP },
    { key: "loser_pullback_recovery", title: "~32% of loser pullbacks recovered", claimed: F.data.loserPullbackRecoveryPctTenthsApprox / 10, units: "%", o: pre("pullback_recovery_rate", "losers_preT60"), tol: RATE_TOL_PP, scale: 100 },
    { key: "loser_depth_ratio", title: "Loser pullbacks ~1.7x deeper", claimed: F.data.loserPullbackDepthRatioTenthsApprox / 10, units: "x", o: pre("pullback_depth_ratio_losers_over_winners", "preT60"), tol: 0.5 },
    { key: "winners_fell_10", title: "58% of winners first fell ~10%", claimed: F.data.winnersThatFirstFell.shareOfWinnersPctTenths / 10, units: "%", o: pre("winners_fell_10_share", "relative_10pct_preT60"), tol: RATE_TOL_PP, scale: 100 },
  ];
  for (const c of numeric) {
    const ours = c.o?.value != null ? c.o.value * (c.scale ?? 1) : null;
    comparisons.push(comparison({
      sourceKey: F.sourceRef.sourceKey,
      claimKey: c.key,
      title: c.title,
      claimText: F.claimText,
      claimedValue: `${c.claimed}${c.units}`,
      units: c.units,
      matchRule:
        `MATCH when |ours - claimed| <= ${c.tol}${c.units === "x" ? "" : "pp"} on the entry..T-60s window ` +
        "(preregistered: full-window stats are tautological under hold-to-resolution; see module doc).",
      reproducedValue: ours != null ? `${fmt(ours, 2)}${c.units} (n=${c.o?.n})` : null,
      verdict: ours == null ? "DATA_GATED" : within(ours, c.claimed, c.tol),
      gatedBy: ours == null ? "kachoio corpus (data/research/kachoio) not present" : null,
      notes: c.key === "winners_fell_10"
        ? "source units ambiguous ('fell ~10%'): relative reading used for the verdict; absolute-10pp reading emitted alongside"
        : null,
    }));
  }

  // qualitative exit-rule claims
  const policies = doc.observations.filter((o) => o.metric === "exit_policy_pnl_per_cost" && o.scope !== "hold_to_resolution");
  const hold = findObs(doc.observations, "exit_policy_pnl_per_cost", "hold_to_resolution");
  const holdMean = hold?.value ?? null;
  const allWorse = holdMean != null && policies.length > 0 && policies.every((p) => p.value != null && p.value < holdMean);
  const trailing = policies.filter((p) => p.scope.startsWith("trailing_stop_"));
  comparisons.push(comparison({
    sourceKey: F.sourceRef.sourceKey,
    claimKey: "trailing_stops_cut_winners",
    title: "Trailing stops at every tested percentage cut winners",
    claimText: F.claimText,
    claimedValue: "true at every tested %",
    units: null,
    matchRule: "MATCH when every trailing-stop grid point underperforms hold AND cuts >50% of winners.",
    reproducedValue: trailing.length
      ? trailing.map((p) => `${p.scope}: pnl ${fmt(p.value)}, winnersCut ${fmt((p.detail?.winnersCutShare as number) ?? null, 2)}`).join("; ")
      : null,
    verdict: trailing.length && holdMean != null &&
      trailing.every((p) => p.value != null && p.value < holdMean && ((p.detail?.winnersCutShare as number) ?? 0) > 0.5)
      ? "REPRODUCED_MATCH" : "REPRODUCED_MISMATCH",
  }));
  const beArm = findObs(doc.observations, "exit_policy_pnl_per_cost", "breakeven_arm_after_+5pts");
  comparisons.push(comparison({
    sourceKey: F.sourceRef.sourceKey,
    claimKey: "breakeven_arm_net_negative",
    title: "Break-even arming after +5% was net negative",
    claimText: F.claimText,
    claimedValue: "net negative vs hold",
    units: null,
    matchRule: "MATCH when the break-even-arm policy's mean PnL/cost is below hold-to-resolution's.",
    reproducedValue: beArm?.value != null && holdMean != null
      ? `arm ${fmt(beArm.value)} vs hold ${fmt(holdMean)}` : null,
    verdict: beArm?.value != null && holdMean != null && beArm.value < holdMean ? "REPRODUCED_MATCH" : "REPRODUCED_MISMATCH",
  }));

  const anyBeatsCi = holdMean != null && policies.some((p) => p.ciLo != null && p.ciLo > holdMean);
  const hypothesisStatus = policies.length === 0 ? "INCONCLUSIVE"
    : allWorse ? "SUPPORTED" : anyBeatsCi ? "REFUTED" : "INCONCLUSIVE";

  // R6 per-day rows carry mean PnL (not binomial k/n), so day-fold stability is
  // expressed through the per-policy CIs; no ts_fold_stability row is emitted.
  const observations = doc.observations;

  const matches = comparisons.filter((c) => c.verdict === "REPRODUCED_MATCH").length;
  return {
    status: "COMPLETED",
    hypothesisStatus,
    observations,
    perDay: doc.perDay,
    comparisons,
    datasetChecksums,
    params: doc.params,
    summary: { dataset: doc.dataset, holdMeanPnl: holdMean, policiesTested: policies.length, allPoliciesWorse: allWorse },
    runtimeMs: Date.now() - t0,
    headline:
      `${policies.length} exit policies vs hold (${fmt(holdMean)}): ` +
      `${allWorse ? "ALL worse — stops shred winners, as the source claimed" : "some policy beat hold"}; ` +
      `pullback claims: ${matches}/${comparisons.length} match`,
  };
}

export const R6_EXITS: ReproExperiment = {
  key: definition.experimentKey,
  definition,
  requiredFixtures: ["REDDIT_EXIT_PULLBACK_RECOVERY"],
  run,
};
