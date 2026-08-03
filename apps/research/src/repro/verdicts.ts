import { meanCi95, walkForwardFolds, type FoldPlan } from "@b5p/experiments";

import type { PyObservation, PyPerDayRow, ReproVerdict } from "./types";

/**
 * Preregistered numeric match rules. Every rule is stated verbatim in the
 * ClaimComparison it decides, so a verdict can always be re-derived by hand.
 * Our corpus differs from the sources' (BTC vs ETH, 2026 Mar-May vs multi-year),
 * so rules are about REPRODUCING THE PHENOMENON, not hitting the digit.
 */

/** MATCH when the claimed rate lies inside our 95% CI widened by `slackPp` points. */
export function rateMatch(claimed: number, ourCiLo: number | null, ourCiHi: number | null,
                          slackPp: number): ReproVerdict {
  if (ourCiLo == null || ourCiHi == null) return "REPRODUCED_MISMATCH";
  const s = slackPp / 100;
  return claimed >= ourCiLo - s && claimed <= ourCiHi + s ? "REPRODUCED_MATCH" : "REPRODUCED_MISMATCH";
}

/** MATCH when both values have the same sign (a direction-of-effect rule). */
export function signMatch(claimed: number, ours: number | null): ReproVerdict {
  if (ours == null) return "REPRODUCED_MISMATCH";
  return Math.sign(claimed) === Math.sign(ours) ? "REPRODUCED_MATCH" : "REPRODUCED_MISMATCH";
}

export function findObs(observations: PyObservation[], metric: string, scope?: string): PyObservation | undefined {
  return observations.find((o) => o.metric === metric && (scope === undefined || o.scope === scope));
}

export function requireObs(observations: PyObservation[], metric: string, scope?: string): PyObservation {
  const o = findObs(observations, metric, scope);
  if (!o) throw new Error(`repro: expected observation ${metric}${scope ? `/${scope}` : ""} missing from python output`);
  return o;
}

export function detailNum(o: PyObservation | undefined, key: string): number | null {
  const v = o?.detail?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Default temporal fold plan for per-day stability (walk-forward, purged, embargoed). */
export const DAY_FOLD_PLAN: FoldPlan = { nFolds: 4, embargoMs: 3_600_000, purge: true, minTrainSamples: 5 };

/**
 * TS-side temporal stability of a per-day binomial rate: days become sample
 * windows, @b5p/experiments walkForwardFolds assigns purged/embargoed test
 * blocks, and the metric is recomputed per fold test block. Returns an
 * observation-shaped record (metric `ts_fold_stability`) or null when there
 * are not enough days.
 */
export function foldStabilityRate(perDay: PyPerDayRow[], scopeFilter: (scope: string) => boolean,
                                  scopeLabel: string, plan: FoldPlan = DAY_FOLD_PLAN): PyObservation | null {
  const rows = perDay.filter((r) => scopeFilter(r.scope) && typeof r.k === "number");
  const byDay = new Map<string, { n: number; k: number }>();
  for (const r of rows) {
    const agg = byDay.get(r.day) ?? { n: 0, k: 0 };
    agg.n += r.n;
    agg.k += r.k as number;
    byDay.set(r.day, agg);
  }
  const days = [...byDay.keys()].sort();
  if (days.length < plan.minTrainSamples + 2) return null;
  const samples = days.map((d) => {
    const start = Date.parse(`${d}T00:00:00Z`);
    return { id: d, startMs: start, endMs: start + 86_400_000 };
  });
  const folds = walkForwardFolds(samples, plan);
  const foldRates: number[] = [];
  const perFold: Array<{ fold: number; days: number; n: number; rate: number }> = [];
  for (const f of folds) {
    let n = 0, k = 0;
    for (const id of f.testIds) {
      const agg = byDay.get(id)!;
      n += agg.n;
      k += agg.k;
    }
    if (n === 0) continue;
    foldRates.push(k / n);
    perFold.push({ fold: f.index, days: f.testIds.length, n, rate: k / n });
  }
  if (foldRates.length === 0) return null;
  const ci = meanCi95(foldRates);
  return {
    metric: "ts_fold_stability",
    scope: scopeLabel,
    value: ci.mean,
    valueText: null,
    n: rows.reduce((s, r) => s + r.n, 0),
    ciLo: Number.isFinite(ci.lo) ? ci.lo : null,
    ciHi: Number.isFinite(ci.hi) ? ci.hi : null,
    detail: {
      perFold,
      foldPlan: plan,
      note: "rate recomputed per purged+embargoed walk-forward test block (per-day aggregation)",
    },
  };
}
