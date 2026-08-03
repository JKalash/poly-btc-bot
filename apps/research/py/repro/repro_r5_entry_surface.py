#!/usr/bin/env python3
"""R5 — Entry-time surface, T-180 .. T-5 every 5 seconds (kachoio corpus).

For each decision time: favored-side (mid>0.5) taker buy at the displayed ask.
Reported per decision time: n, favored win rate (and reversal hazard = 1-win),
mean ask, mean spread, median displayed ask $ size, effective break-even at
the current 0.07 fee, Brier of the mid (information gain proxy), net EV per $1
at the displayed ask, and a conservative slippage variant at ask+1 tick.

Source filters represented:
  - "skip first 60-120s": every decision here has >=120s elapsed (T-180 on a
    300s window) - the whole surface passes the source's first-seconds filter.
  - "skip last 60-80s": rows with srem < 60 / < 80 carry lateWindow flags.
  - "T-5 forced-trade benchmark": the T-5 row, flagged forcedTradeBenchmark -
    it is a benchmark, never an executable recommendation.

Fill reality on this corpus is the displayed touch (1Hz snapshots, no queue):
stated in every row via fillModel.
"""
from __future__ import annotations

import numpy as np

from repro_common import (base_parser, emit, load_extra_params, load_kachoio,
                          mean_ci95, obs, taker_breakeven, taker_fee, wilson)

TICK = 0.01


def main() -> None:
    ap = base_parser(__doc__)
    args = ap.parse_args()
    extra = load_extra_params(args.params)
    fee = float(extra.get("feeCurrent", 0.07))
    grid = list(range(int(extra.get("gridStart", 180)), int(extra.get("gridEnd", 5)) - 1,
                      -int(extra.get("gridStep", 5))))

    m, t = load_kachoio(args.markets, args.ticks, quick=args.quick, seed=args.seed)

    # 1Hz data: exact-srem selection, one row per market per grid point.
    tt = t[t["srem"].isin(grid)].copy()
    # if duplicate ticks share one srem (rare), keep the last by time
    tt = tt.sort_values("t").groupby(["condition_id", "srem"]).tail(1)

    tt["fav_up"] = tt["mid"] > 0.5
    tt = tt[tt["mid"] != 0.5].copy()  # ambiguous favorite: no decision
    tt["fav_ask"] = np.where(tt["fav_up"], tt["au"], tt["ad"])
    tt["fav_bid"] = np.where(tt["fav_up"], tt["bu"], tt["bd"])
    tt["fav_ask_size"] = np.where(tt["fav_up"], tt["sau"], tt["sad"])
    tt["fav_win"] = np.where(tt["fav_up"], tt["y"], 1 - tt["y"])
    tt["fav_mid"] = np.where(tt["fav_up"], tt["mid"], 1 - tt["mid"])
    tt = tt.dropna(subset=["fav_ask"])

    observations: list[dict] = []
    for srem in grid:
        g = tt[tt["srem"] == srem]
        n = len(g)
        scope = f"T-{srem}"
        if n < 30:
            observations.append(obs("entry_surface", scope, n=n, value_text="insufficient decisions"))
            continue
        k = int(g["fav_win"].sum())
        w_lo, w_hi = wilson(k, n)
        mean_ask = float(g["fav_ask"].mean())
        ev = (g["fav_win"] - g["fav_ask"] - taker_fee(g["fav_ask"], fee)) / g["fav_ask"]
        ev_mean, ev_lo, ev_hi, _ = mean_ci95(ev.values)
        slip_ask = np.minimum(g["fav_ask"] + TICK, 0.99)
        ev_s = (g["fav_win"] - slip_ask - taker_fee(slip_ask, fee)) / slip_ask
        evs_mean, evs_lo, evs_hi, _ = mean_ci95(ev_s.values)
        brier_mid = float(np.mean((g["fav_mid"] - g["fav_win"]) ** 2))
        sizes = g["fav_ask_size"].dropna()
        observations.append(obs(
            "entry_surface", scope, value=ev_mean, n=n, ci_lo=ev_lo, ci_hi=ev_hi,
            detail={
                "winRate": k / n, "winRateCi": [w_lo, w_hi],
                "reversalHazard": 1 - k / n,
                "meanAsk": mean_ask,
                "meanSpread": float((g["fav_ask"] - g["fav_bid"]).mean()),
                "medianAskSizeUsd": float((sizes * g.loc[sizes.index, "fav_ask"]).median()) if len(sizes) else None,
                "breakevenAtMeanAsk": float(taker_breakeven(mean_ask, fee)),
                "brierMid": brier_mid,
                "netEvPerCostSlip1Tick": evs_mean, "netEvSlipCi": [evs_lo, evs_hi],
                "fee": fee,
                "fillModel": "displayed touch at 1Hz snapshot; no queue/latency model (optimistic)",
                "lateWindow60": bool(srem < 60), "lateWindow80": bool(srem < 80),
                "forcedTradeBenchmark": bool(srem == 5),
                "skipFirstFilterSatisfied": True,
            },
        ))

    emit(args.out, "R5_entry_time_surface",
         params={"grid": grid, "feeCurrent": fee, "tick": TICK,
                 "quick": bool(args.quick), "seed": args.seed},
         dataset={"markets": len(m), "gridPoints": len(grid), "days": int(m["day"].nunique())},
         observations=observations)


if __name__ == "__main__":
    main()
