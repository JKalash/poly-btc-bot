#!/usr/bin/env python3
"""R6 — Exit policies: pullback/recovery statistics + exit-rule grid (kachoio).

Source claims (Reddit): trailing stops at every tested % cut winners; 58% of
eventual winners first fell ~10% before recovering; break-even arming after +5%
was net negative; winners' first pullback ~22 points with 97% recovery; losers'
~38 points (~1.7x deeper) with ~32% recovery.

Preregistered reproduction: entry = favored side (mid>0.5) at T-{entrySrem}s,
bought at displayed ask, tracked on the 1Hz mid; triggers evaluated on the mid,
exits EXECUTED at the displayed favored-side bid (never the mid). Pullback
depth = entry_mid - min(mid) (maximum adverse excursion); recovered = mid
returns to >= entry_mid after the trough before resolution. The source's units
are ambiguous ("22 percentage points" vs "fell 10%"), so both absolute-points
and relative-% variants are reported.

Every policy is compared against hold-to-resolution on the SAME entries.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from repro_common import (base_parser, decision_slice, emit, load_extra_params,
                          load_kachoio, mean_ci95, obs, taker_fee, wilson)


def first_trigger(w: pd.DataFrame, trigger: pd.Series) -> pd.DataFrame:
    """First triggering tick per market (w must be sorted by condition_id, t)."""
    hit = w[trigger.values]
    return hit.groupby("condition_id", sort=False).head(1).set_index("condition_id")


def policy_pnl(entries: pd.DataFrame, exit_rows: pd.DataFrame, fee: float) -> pd.Series:
    """PnL per $1 cost: exit at bid (sell taker fee) or hold to resolution."""
    cost = entries["entry_ask"] + taker_fee(entries["entry_ask"], fee)
    exit_bid = exit_rows["fav_bid"].reindex(entries.index)
    proceeds = np.where(exit_bid.notna(),
                        exit_bid - taker_fee(exit_bid.fillna(0), fee),
                        entries["fav_win"].astype(float))
    return (pd.Series(proceeds, index=entries.index) - cost) / cost


def main() -> None:
    ap = base_parser(__doc__)
    args = ap.parse_args()
    extra = load_extra_params(args.params)
    entry_srem = int(extra.get("entrySrem", 240))
    fee = float(extra.get("feeCurrent", 0.07))

    m, t = load_kachoio(args.markets, args.ticks, quick=args.quick, seed=args.seed)

    at = decision_slice(t, entry_srem)
    at = at[at["mid"] != 0.5].copy()
    at["fav_up"] = at["mid"] > 0.5
    at["entry_mid"] = np.where(at["fav_up"], at["mid"], 1 - at["mid"])
    at["entry_ask"] = np.where(at["fav_up"], at["au"], at["ad"])
    at["fav_win"] = np.where(at["fav_up"], at["y"], 1 - at["y"])
    entries = at.dropna(subset=["entry_ask"])[["entry_mid", "entry_ask", "fav_win", "t", "day"]]
    entries = entries.rename(columns={"t": "entry_t"})

    # post-entry 1Hz series with favored-side mid/bid
    w = t.merge(entries[["entry_t", "entry_mid"]], left_on="condition_id", right_index=True, how="inner")
    w = w[w["t"] > w["entry_t"]].copy()
    fav_up = at["fav_up"].reindex(w["condition_id"]).values
    w["fav_mid"] = np.where(fav_up, w["mid"], 1 - w["mid"])
    w["fav_bid"] = np.where(fav_up, w["bu"], w["bd"])
    w = w.dropna(subset=["fav_mid"]).sort_values(["condition_id", "t"]).reset_index(drop=True)

    g = w.groupby("condition_id", sort=False)
    w["peak"] = g["fav_mid"].cummax()

    observations: list[dict] = []
    per_day: list[dict] = []

    def pullback_frame(series: pd.DataFrame) -> pd.DataFrame:
        """Trough / recovery per market over one measurement window."""
        gg = series.groupby("condition_id", sort=False)
        suffix = series.iloc[::-1].groupby("condition_id", sort=False)["fav_mid"].cummax().iloc[::-1]
        trough = gg["fav_mid"].min()
        trough_idx = gg["fav_mid"].idxmin()
        per = pd.DataFrame({
            "trough": trough,
            "recovered_to_entry": pd.Series(suffix.loc[trough_idx].values, index=trough.index),
        })
        per = entries.join(per, how="inner")
        per["depth"] = (per["entry_mid"] - per["trough"]).clip(lower=0)
        per["had_pullback"] = per["depth"] >= 0.01
        per["recovered"] = per["recovered_to_entry"] >= per["entry_mid"]
        return per

    def pullback_stats(sub: pd.DataFrame, scope: str, source_depth_pts: float,
                       source_recovery: float, window_note: str) -> None:
        pb = sub[sub["had_pullback"]]
        if len(pb) == 0:
            observations.append(obs("pullback_depth_points", scope, n=0, value_text="no pullbacks"))
            return
        d_mean, d_lo, d_hi, dn = mean_ci95(pb["depth"].values * 100)
        observations.append(obs("pullback_depth_points", scope, value=d_mean, n=dn,
                                ci_lo=d_lo, ci_hi=d_hi,
                                detail={"sourceClaimPoints": source_depth_pts,
                                        "units": "token price points x100",
                                        "definition": "entry_mid - min(fav mid) after entry (MAE)",
                                        "window": window_note}))
        k = int(pb["recovered"].sum())
        w_lo, w_hi = wilson(k, len(pb))
        observations.append(obs("pullback_recovery_rate", scope, value=k / len(pb), n=len(pb),
                                ci_lo=w_lo, ci_hi=w_hi,
                                detail={"sourceClaim": source_recovery,
                                        "definition": "fav mid returns to >= entry_mid after the trough",
                                        "window": window_note}))

    # PRIMARY comparable window: ticks up to T-60s. Rationale (preregistered):
    # over the full window, terminal convergence makes the stats tautological -
    # a winner's mid always regains entry on its way to 1.0 (recovery == 100%)
    # and a loser's MAE equals its entry price (depth == entry). The source's
    # 97%/32%/38pt numbers are only reachable if its measurement excluded the
    # final convergence, so the pre-T-60 window is the comparable one; the
    # full-window variant is kept as the tautology exhibit.
    for suffix_name, series, window_note, primary in [
        ("preT60", w[w["srem"] > 60], "entry .. T-60s (excludes terminal convergence)", True),
        ("full", w, "entry .. resolution (terminal convergence makes recovery near-deterministic)", False),
    ]:
        per = pullback_frame(series)
        winners = per[per["fav_win"] == 1]
        losers = per[per["fav_win"] == 0]
        pullback_stats(winners, f"winners_{suffix_name}", 22.0, 0.97, window_note)
        pullback_stats(losers, f"losers_{suffix_name}", 38.0, 0.32, window_note)
        wd = winners[winners["had_pullback"]]["depth"]
        ld = losers[losers["had_pullback"]]["depth"]
        if len(wd) and len(ld):
            observations.append(obs(f"pullback_depth_ratio_losers_over_winners", suffix_name,
                                    value=float(ld.mean() / wd.mean()), n=len(wd) + len(ld),
                                    detail={"sourceClaim": 1.7, "window": window_note,
                                            "primaryComparable": primary}))
        if len(winners):
            for scope, mask in [
                (f"absolute_10pts_{suffix_name}", winners["depth"] >= 0.10),
                (f"relative_10pct_{suffix_name}", winners["depth"] >= 0.10 * winners["entry_mid"]),
            ]:
                k, n = int(mask.sum()), len(winners)
                w_lo, w_hi = wilson(k, n)
                observations.append(obs("winners_fell_10_share", scope, value=k / n, n=n,
                                        ci_lo=w_lo, ci_hi=w_hi,
                                        detail={"sourceClaim": 0.58, "window": window_note,
                                                "note": "source units ambiguous; both readings reported"}))

    # ------------------------------ policy grid ------------------------------
    def add_policy(name: str, exit_rows: pd.DataFrame, detail_extra: dict | None = None) -> None:
        pnl = policy_pnl(entries, exit_rows, fee)
        p_mean, p_lo, p_hi, pn = mean_ci95(pnl.values)
        exited = exit_rows.index.intersection(entries.index)
        winners_cut = int(entries.loc[exited, "fav_win"].sum()) if len(exited) else 0
        observations.append(obs(
            "exit_policy_pnl_per_cost", name, value=p_mean, n=pn, ci_lo=p_lo, ci_hi=p_hi,
            detail={"exitRate": len(exited) / len(entries) if len(entries) else None,
                    "winnersCut": winners_cut,
                    "winnersCutShare": winners_cut / max(1, int(entries["fav_win"].sum())),
                    "execution": "trigger on mid, exit at displayed favored bid, sell taker fee applied",
                    **(detail_extra or {})},
        ))

    hold_pnl = policy_pnl(entries, w.iloc[0:0].set_index("condition_id"), fee)
    h_mean, h_lo, h_hi, hn = mean_ci95(hold_pnl.values)
    observations.append(obs("exit_policy_pnl_per_cost", "hold_to_resolution",
                            value=h_mean, n=hn, ci_lo=h_lo, ci_hi=h_hi,
                            detail={"baseline": True}))
    for day, gd in entries.groupby("day"):
        pnl = policy_pnl(gd, w.iloc[0:0].set_index("condition_id"), fee)
        per_day.append({"day": str(day), "scope": "hold_to_resolution",
                        "n": int(len(gd)), "meanPnl": float(pnl.mean())})

    em = entries["entry_mid"].reindex(w["condition_id"]).values
    for stop_pct in (0.05, 0.10, 0.15, 0.20):
        add_policy(f"fixed_stop_-{int(stop_pct * 100)}pct",
                   first_trigger(w, pd.Series(w["fav_mid"].values <= em * (1 - stop_pct))),
                   {"trigger": f"fav mid <= entry_mid * {1 - stop_pct:.2f}"})
    for trail in (0.05, 0.10, 0.15, 0.20):
        add_policy(f"trailing_stop_{int(trail * 100)}pts",
                   first_trigger(w, pd.Series((w["peak"] - w["fav_mid"]).values >= trail)),
                   {"trigger": f"peak - fav mid >= {trail:.2f}"})
    armed = w["peak"].values >= em + 0.05
    add_policy("breakeven_arm_after_+5pts",
               first_trigger(w, pd.Series(armed & (w["fav_mid"].values <= em))),
               {"trigger": "after peak >= entry+0.05, exit when fav mid <= entry_mid",
                "sourceClaim": "net negative in one study"})
    for tp in (0.10, 0.20, 0.30):
        add_policy(f"take_profit_+{int(tp * 100)}pts",
                   first_trigger(w, pd.Series(w["fav_mid"].values >= em + tp)),
                   {"trigger": f"fav mid >= entry_mid + {tp:.2f}"})
    add_policy("threshold_cross_invalidation",
               first_trigger(w, pd.Series(w["fav_mid"].values < 0.5)),
               {"trigger": "favored side loses the favorite (fav mid < 0.5)"})
    add_policy("time_exit_T-30",
               first_trigger(w, pd.Series(w["srem"].values <= 30)),
               {"trigger": "exit at bid at T-30s"})

    per_day.sort(key=lambda r: (r["day"], r["scope"]))
    emit(args.out, "R6_exit_policies",
         params={"entrySrem": entry_srem, "feeCurrent": fee,
                 "quick": bool(args.quick), "seed": args.seed},
         dataset={"markets": len(m), "entries": len(entries), "days": int(m["day"].nunique())},
         observations=observations, per_day=per_day)


if __name__ == "__main__":
    main()
