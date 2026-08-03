#!/usr/bin/env python3
"""R7 — Gist composite ablation and calibration (local collector export).

The engine already computes gist_composite_v1 causally in every feature
snapshot (weightsVersion recorded per row). This script:
  - re-derives the composite from the RAW sub-indicator values using the EXACT
    fixture weights (passed via --params from @b5p/evidence
    GIST_COMPOSITE_WEIGHTS — never re-transcribed here);
  - runs the preregistered variants: exact gist, old window-delta weight 3,
    window-delta only, every leave-one-feature-out, engine score as recorded,
    book-only baseline (mid), Chainlink distance baseline;
  - scores each variant: direction hit rate, and the Brier score of
    score_strength = min(|score|/7, 1) TREATED AS IF it were a probability —
    which it is NOT (metric names say "as_if"; this run exists to demonstrate,
    with numbers, why that labeling is forbidden) — against the book-mid null
    on the same rows;
  - fits an isotonic calibration of the signed score walk-forward by UTC day
    (train = strictly earlier days) and reports OOS Brier vs the mid null.

Sample reality: the local collector ran ~3 days (~650 resolved markets).
Every number carries n; nothing here is promotable and the output says so.
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd

from repro_common import (base_parser, emit, gated, load_extra_params, obs,
                          taker_fee, wilson)

COLLECTOR_GATE = "local collector export (feature_market_snapshots.csv from data/pglite feature_snapshots) not present"

FEATURES = ["window_delta", "micro_momentum", "acceleration", "ema_cross",
            "rsi", "volume_surge", "tick_trend"]


def tiered_window_delta(delta_pct: np.ndarray, tiers: list[dict]) -> np.ndarray:
    """Signed tiered weight for the window delta (tiers: minAbsMovePpm/weight, descending)."""
    out = np.zeros_like(delta_pct)
    abs_ppm = np.abs(delta_pct) * 10_000  # pct -> ppm
    sign = np.sign(delta_pct)
    remaining = np.ones_like(delta_pct, dtype=bool)
    for tier in sorted(tiers, key=lambda t: -t["minAbsMovePpm"]):
        hit = remaining & (abs_ppm > tier["minAbsMovePpm"])
        out[hit] = sign[hit] * tier["weight"]
        remaining &= ~hit
    return out


def component_scores(f: pd.DataFrame, weights: dict, window_delta_weight: str) -> pd.DataFrame:
    """Per-feature signed contributions from RAW sub-indicator values.

    window_delta_weight: "tiered" (current 5-7 via tiers), "flat3" (old ablation).
    tick_trend is null in every collector snapshot (engine never computed it
    locally) — its contribution is 0 and the caller reports that honestly.
    """
    ind = weights["indicators"]
    c = pd.DataFrame(index=f.index)
    if window_delta_weight == "tiered":
        c["window_delta"] = tiered_window_delta(f["window_delta_pct"].fillna(0).values,
                                                ind["windowDelta"]["tiers"])
    else:
        c["window_delta"] = np.sign(f["window_delta_pct"].fillna(0)) * ind["windowDelta"]["earlierWeightAblation"]
    c["micro_momentum"] = np.sign(f["micro_momentum_pct"].fillna(0)) * ind["microMomentum"]["weight"]
    c["acceleration"] = np.sign(f["acceleration_pct"].fillna(0)) * ind["acceleration"]["weight"]
    c["ema_cross"] = np.sign(f["ema_cross_signal"].fillna(0)) * ind["emaCrossover"]["weight"]
    rsi = f["rsi"]
    c["rsi"] = np.where(rsi > ind["rsi"]["extremeUpper"], ind["rsi"]["extremeWeight"],
                        np.where(rsi < ind["rsi"]["extremeLower"], -ind["rsi"]["extremeWeight"], 0.0))
    ratio_min = ind["volumeSurge"]["minRatioTenths"] / 10.0
    c["volume_surge"] = np.where(f["volume_surge_ratio"] >= ratio_min,
                                 np.sign(f["window_delta_pct"].fillna(0)) * ind["volumeSurge"]["weight"], 0.0)
    c["tick_trend"] = np.where(f["tick_trend"].notna(),
                               np.sign(f["tick_trend"].fillna(0)) * ind["tickTrend"]["weight"], 0.0)
    return c.fillna(0.0)


def score_variant(name: str, score: pd.Series, f: pd.DataFrame, divisor: float,
                  fee: float, observations: list[dict], srem_scope: str) -> None:
    """Hit rate + score_strength-as-if-probability Brier vs book-mid null + taker EV."""
    d = f.assign(score=score.values)
    act = d[d["score"] != 0]
    n = len(act)
    scope = f"{srem_scope}/{name}"
    if n < 30:
        observations.append(obs("composite_hit_rate", scope, n=n,
                                value_text="insufficient non-abstain decisions",
                                detail={"insufficientN": True, "abstains": int(len(d) - n)}))
        return
    pred_up = act["score"] > 0
    won = np.where(pred_up, act["y"], 1 - act["y"])
    k = int(won.sum())
    lo, hi = wilson(k, n)
    observations.append(obs("composite_hit_rate", scope, value=k / n, n=n, ci_lo=lo, ci_hi=hi,
                            detail={"abstains": int(len(d) - n)}))
    strength = np.minimum(np.abs(act["score"]) / divisor, 1.0)
    brier_strength = float(np.mean((strength - won) ** 2))
    p_book_side = np.where(pred_up, act["up_mid"], 1 - act["up_mid"])
    brier_book = float(np.mean((p_book_side - won) ** 2))
    brier_half = float(np.mean((0.5 - won) ** 2))
    observations.append(obs(
        "score_strength_as_if_probability_brier", scope, value=brier_strength, n=n,
        detail={"brierBookMidSameRows": brier_book, "brierConstantHalf": brier_half,
                "strengthWorseThanBookBy": brier_strength - brier_book,
                "note": "score_strength = min(|score|/7,1) is NOT a probability; this metric exists "
                        "to quantify how badly it scores when treated as one"},
    ))
    ask_side = np.where(pred_up, act["up_best_ask"], act["down_best_ask"])
    ok = ~pd.isna(ask_side)
    if ok.sum() >= 30:
        ev = (won[ok] - ask_side[ok] - taker_fee(ask_side[ok], fee)) / ask_side[ok]
        observations.append(obs("composite_taker_net_ev_per_cost", scope,
                                value=float(np.mean(ev)), n=int(ok.sum()),
                                detail={"fee": fee, "fill": "displayed ask (1Hz snapshot)"}))


def walk_forward_isotonic(f: pd.DataFrame, score: pd.Series, observations: list[dict],
                          srem_scope: str) -> None:
    from sklearn.isotonic import IsotonicRegression
    d = f.assign(score=score.values).dropna(subset=["up_mid"])
    days = sorted(d["day"].unique())
    rows = []
    for i, day in enumerate(days):
        if i == 0:
            continue
        train = d[d["day"] < day]
        test = d[d["day"] == day]
        if len(train) < 100 or len(test) < 30:
            continue
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.001, y_max=0.999)
        iso.fit(train["score"].values, train["y"].values)
        rows.append(pd.DataFrame({"y": test["y"].values,
                                  "p_cal": iso.predict(test["score"].values),
                                  "p_mid": test["up_mid"].values}))
    scope = f"{srem_scope}/calibrated_isotonic"
    if not rows:
        observations.append(obs("composite_calibrated_oos_brier", scope, n=0,
                                value_text="not enough days for walk-forward (need >=2 qualifying days)",
                                detail={"insufficientN": True}))
        return
    oos = pd.concat(rows, ignore_index=True)
    brier_cal = float(np.mean((oos["p_cal"] - oos["y"]) ** 2))
    brier_mid = float(np.mean((oos["p_mid"].clip(0.001, 0.999) - oos["y"]) ** 2))
    observations.append(obs(
        "composite_calibrated_oos_brier", scope, value=brier_cal, n=len(oos),
        detail={"brierMidSameRows": brier_mid, "calMinusMid": brier_cal - brier_mid,
                "oosDays": len(rows),
                "note": "walk-forward by UTC day on a ~3-day sample; direction only, tiny n"},
    ))


def main() -> None:
    ap = base_parser(__doc__)
    args = ap.parse_args()
    extra = load_extra_params(args.params)
    fee = float(extra.get("feeCurrent", 0.07))
    srem_targets = [int(s) for s in extra.get("sremTargets", [10, 30, 60])]
    weights = extra.get("gistWeights")
    weights_source = "fixture:@b5p/evidence GIST_COMPOSITE_WEIGHTS" if weights else "MISSING"

    observations: list[dict] = []
    dataset: dict = {}

    path = os.path.join(args.collector_dir, "feature_market_snapshots.csv") if args.collector_dir else None
    if not path or not os.path.exists(path):
        observations.append(gated("composite_hit_rate", "overall", COLLECTOR_GATE))
        observations.append(gated("score_strength_as_if_probability_brier", "overall", COLLECTOR_GATE))
        emit(args.out, "R7_gist_composite_ablation",
             params={"feeCurrent": fee, "sremTargets": srem_targets,
                     "weightsSource": weights_source, "quick": bool(args.quick), "seed": args.seed},
             dataset=dataset, observations=observations)
        return
    if not weights:
        observations.append(gated(
            "composite_recomputed", "overall",
            "@b5p/evidence GIST_COMPOSITE_WEIGHTS fixture params not passed (--params gistWeights)",
            note="exact-weight recomputation refuses to run from a local re-transcription; "
                 "engine-recorded scores and baselines still run"))

    f_all = pd.read_csv(path)
    f_all["y"] = (f_all["outcome"] == "UP").astype(int)
    f_all["day"] = pd.to_datetime(f_all["end_epoch"], unit="s", utc=True).dt.strftime("%Y-%m-%d")
    dataset["snapshots"] = int(len(f_all))
    dataset["markets"] = int(f_all["market_id"].nunique())
    dataset["days"] = int(f_all["day"].nunique())
    dataset["tickTrendNullShare"] = float(f_all["tick_trend"].isna().mean())

    divisor = float(weights["confidenceMapping"]["divisor"]) if weights else 7.0

    for srem in srem_targets:
        g = f_all.dropna(subset=["seconds_remaining", "up_mid"])
        g = g[(g["seconds_remaining"] >= srem - 5) & (g["seconds_remaining"] <= srem + 10)]
        g = g.sort_values("ts_ms").groupby("market_id").tail(1).reset_index(drop=True)
        srem_scope = f"T-{srem}"
        if len(g) < 50:
            observations.append(obs("composite_hit_rate", srem_scope, n=len(g),
                                    value_text="insufficient snapshot coverage",
                                    detail={"insufficientN": True}))
            continue

        # engine-recorded score (gist_composite_v1 as computed live)
        score_variant("engine_recorded", g["composite_score"], g, 1.0, fee, observations, srem_scope)
        # NOTE: engine composite_score is already normalized (|score|<=1) - its
        # strength is |score|, so divisor 1.0 above.

        # book + chainlink baselines
        score_variant("baseline_book_mid_sign", np.sign(g["up_mid"] - 0.5), g, 1.0 / 0.75, fee,
                      observations, srem_scope)
        score_variant("baseline_chainlink_distance_sign", np.sign(g["distance_bps"].fillna(0)),
                      g, 1.0 / 0.75, fee, observations, srem_scope)
        # divisor chosen so strength == 0.75 flat: a deliberately dumb constant-
        # confidence baseline; the Brier comparison vs book mid is the point.

        if weights:
            comps = component_scores(g, weights, "tiered")
            exact = comps.sum(axis=1)
            score_variant("exact_gist_weights", exact, g, divisor, fee, observations, srem_scope)
            walk_forward_isotonic(g, exact, observations, srem_scope)

            comps3 = component_scores(g, weights, "flat3")
            score_variant("old_window_delta_weight_3", comps3.sum(axis=1), g, divisor, fee,
                          observations, srem_scope)
            score_variant("window_delta_only", comps["window_delta"], g, divisor, fee,
                          observations, srem_scope)
            for feat in FEATURES:
                loo = exact - comps[feat]
                score_variant(f"ablate_{feat}", loo, g, divisor, fee, observations, srem_scope)
                if feat == "tick_trend":
                    observations.append(obs(
                        "ablation_note", f"{srem_scope}/ablate_tick_trend", n=int(len(g)),
                        value_text="tick_trend was never computed by the local engine (all null): "
                                   "this ablation is degenerate (identical to exact_gist_weights)",
                        detail={"nullShare": float(g["tick_trend"].isna().mean())}))

    emit(args.out, "R7_gist_composite_ablation",
         params={"feeCurrent": fee, "sremTargets": srem_targets, "weightsSource": weights_source,
                 "divisor": divisor, "quick": bool(args.quick), "seed": args.seed},
         dataset=dataset, observations=observations)


if __name__ == "__main__":
    main()
