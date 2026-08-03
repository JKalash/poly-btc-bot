#!/usr/bin/env python3
"""R4 — Trend-side cheapness (kachoio corpus).

Source claim (Reddit): within a confirmed 30-minute trend, buying the
trend-direction side showed win rates 30.8% / 42.9% / 58.6% / 84.2% in the
price bands 0.00-0.45 / 0.45-0.55 / 0.55-0.70 / 0.70-1.00 (N = 1,262 total).

Our reproduction, preregistered:
  - CAUSAL trend definition: >=5 of the 6 CONTIGUOUS prior 5-minute windows
    resolved the same direction (all 6 windows must resolve before this window
    starts, so no lookahead). Sensitivity variants 4/6 and 6/6 are secondary.
  - Decision at T-{decisionSrem}s: buy the trend-direction side at its
    displayed ask; hold to resolution.
  - BTC only (the source's asset for this table is not stated; ours is BTC).
  - Stratified by volatility regime (mid-vol over prior 60s, terciles) and by
    a second decision time for the seconds-remaining interaction.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from repro_common import (base_parser, contiguous_chain, decision_slice, emit,
                          load_extra_params, load_kachoio, mean_ci95, obs,
                          taker_fee, wilson)

BANDS = [(0.00, 0.45), (0.45, 0.55), (0.55, 0.70), (0.70, 1.00)]


def run_at(t: pd.DataFrame, mm: pd.DataFrame, srem: int, fee: float,
           min_agree: int, observations: list[dict], scope_prefix: str,
           per_day: list[dict] | None) -> int:
    """Band table for one (decision time, trend definition). Returns N."""
    trend = mm[mm["trend_dir"] != 0]
    at = decision_slice(t, srem)
    d = at.reindex(trend["condition_id"].values).dropna(subset=["mid"])
    d = d.join(trend.set_index("condition_id")["trend_dir"])
    d["side_ask"] = np.where(d["trend_dir"] > 0, d["au"], d["ad"])
    d["side_win"] = np.where(d["trend_dir"] > 0, d["y"], 1 - d["y"])
    d = d.dropna(subset=["side_ask"])
    total = 0
    for lo, hi in BANDS:
        g = d[(d["side_ask"] >= lo) & (d["side_ask"] < hi)]
        n = len(g)
        total += n
        scope = f"{scope_prefix}{lo:.2f}-{hi:.2f}"
        if n == 0:
            observations.append(obs("trend_band_win_rate", scope, n=0,
                                    value_text="no decisions in band"))
            continue
        k = int(g["side_win"].sum())
        w_lo, w_hi = wilson(k, n)
        ev = (g["side_win"] - g["side_ask"] - taker_fee(g["side_ask"], fee)) / g["side_ask"]
        ev_mean, ev_lo, ev_hi, _ = mean_ci95(ev.values)
        observations.append(obs(
            "trend_band_win_rate", scope, value=k / n, n=n, ci_lo=w_lo, ci_hi=w_hi,
            detail={"meanAsk": float(g["side_ask"].mean()),
                    "netEvPerCostTaker": ev_mean, "netEvCi": [ev_lo, ev_hi],
                    "fee": fee, "minAgreeOf6": min_agree, "decisionSrem": srem},
        ))
        if per_day is not None:
            for day, gd in g.groupby("day"):
                per_day.append({"day": str(day), "scope": scope, "n": int(len(gd)),
                                "k": int(gd["side_win"].sum())})
    return total


def main() -> None:
    ap = base_parser(__doc__)
    args = ap.parse_args()
    extra = load_extra_params(args.params)
    decision_srem = int(extra.get("decisionSrem", 270))
    secondary_srem = int(extra.get("secondarySrem", 60))
    fee = float(extra.get("feeCurrent", 0.07))
    min_agree = int(extra.get("minAgreeOf6", 5))

    m, t = load_kachoio(args.markets, args.ticks, quick=args.quick, seed=args.seed)
    chain = contiguous_chain(m)

    # trend over the prior 30 minutes = prior 6 contiguous windows, >= min_agree same direction
    dirs = np.where(chain["y"].values == 1, 1, -1)
    starts = chain["start_epoch"].values
    ends = chain["end_epoch"].values
    n = len(chain)
    trend_dir = np.zeros(n, dtype=int)
    for i in range(6, n):
        if all(ends[i - j - 1] == starts[i - j] for j in range(6)):
            window = dirs[i - 6:i]
            ups = int((window == 1).sum())
            if ups >= min_agree:
                trend_dir[i] = 1
            elif (6 - ups) >= min_agree:
                trend_dir[i] = -1
    chain["trend_dir"] = trend_dir

    observations: list[dict] = []
    per_day: list[dict] = []
    n_trend = int((trend_dir != 0).sum())
    observations.append(obs("trend_windows", "overall", value=n_trend / n, n=n_trend,
                            value_text=f"{n_trend}/{n} windows in a confirmed 30-min trend "
                                       f"({min_agree}/6 prior contiguous windows same direction)",
                            detail={"sourceN": 1262, "sourceWindows": 4604}))

    total = run_at(t, chain, decision_srem, fee, min_agree, observations, "", per_day)
    observations.append(obs("trend_decisions_total", "overall", n=total,
                            value_text=f"{total} band decisions at T-{decision_srem}s (source: 1,262)"))

    # seconds-remaining interaction: same table at a late decision time
    run_at(t, chain, secondary_srem, fee, min_agree, observations, f"T-{secondary_srem}/", None)

    # sensitivity: looser/stricter trend definitions (secondary, not the preregistered primary)
    for agree in (4, 6):
        td = np.zeros(n, dtype=int)
        for i in range(6, n):
            if all(ends[i - j - 1] == starts[i - j] for j in range(6)):
                ups = int((dirs[i - 6:i] == 1).sum())
                if ups >= agree:
                    td[i] = 1
                elif (6 - ups) >= agree:
                    td[i] = -1
        mm2 = chain.copy()
        mm2["trend_dir"] = td
        run_at(t, mm2, decision_srem, fee, agree, observations, f"agree{agree}/", None)

    # volatility-regime stratification at the primary decision time
    at = decision_slice(t, decision_srem)
    hist = t[(t["srem"] >= decision_srem) & (t["srem"] <= decision_srem + 60)]
    vol = hist.groupby("condition_id")["mid"].apply(
        lambda s: float(np.std(np.diff(s))) if len(s) > 2 else np.nan)
    trend = chain[chain["trend_dir"] != 0]
    dv = at.reindex(trend["condition_id"].values).dropna(subset=["mid"])
    dv = dv.join(trend.set_index("condition_id")["trend_dir"]).join(vol.rename("vol60"))
    dv["side_ask"] = np.where(dv["trend_dir"] > 0, dv["au"], dv["ad"])
    dv["side_win"] = np.where(dv["trend_dir"] > 0, dv["y"], 1 - dv["y"])
    dv = dv.dropna(subset=["side_ask", "vol60"])
    if len(dv) >= 60:
        dv["vol_bucket"] = pd.qcut(dv["vol60"], 3, labels=["low", "mid", "high"], duplicates="drop")
        for b, g in dv.groupby("vol_bucket", observed=True):
            cheap = g[g["side_ask"] < 0.45]
            if len(cheap) >= 20:
                k, nn = int(cheap["side_win"].sum()), len(cheap)
                w_lo, w_hi = wilson(k, nn)
                observations.append(obs("trend_cheap_band_win_rate_by_vol", str(b),
                                        value=k / nn, n=nn, ci_lo=w_lo, ci_hi=w_hi,
                                        detail={"band": "0.00-0.45", "volMeasure": "std of 1Hz mid diffs, prior 60s"}))

    per_day.sort(key=lambda r: (r["day"], r["scope"]))
    emit(args.out, "R4_trend_side_cheapness",
         params={"decisionSrem": decision_srem, "secondarySrem": secondary_srem,
                 "feeCurrent": fee, "minAgreeOf6": min_agree,
                 "bands": [f"{lo:.2f}-{hi:.2f}" for lo, hi in BANDS],
                 "quick": bool(args.quick), "seed": args.seed},
         dataset={"markets": len(m), "trendWindows": n_trend, "days": int(m["day"].nunique())},
         observations=observations, per_day=per_day)


if __name__ == "__main__":
    main()
