#!/usr/bin/env python3
"""R11 — Higher-band taker microstructure (open research slot, preregistered).

Source claim (Reddit commenter): ~3% ROI from taker-side microstructure at
higher price bands, ~1 year research + 2 months live. No trades, bankroll
convention, confidence interval, or P&L were supplied, and no method was
described — so the claim itself is untestable (DATA_GATED on the commenter's
method/trade log). What CAN be preregistered and run is OUR definition of each
term, producing an analogue result on the kachoio corpus:

  higher price band   := favored (mid>0.5) displayed ask in [0.80, 0.97)
  directional drift   := favored mid rose over the prior 30s (mom30 toward
                         the favorite, strictly > 0)
  ROI denominator     := per-trade cost basis (ask + taker fee), $1 stake
  sample interval     := one decision per market at T-30s
  fees                := current crypto_fees_v2 taker 0.07
  spread/slippage     := primary at displayed ask; conservative at ask+1 tick
  win/loss history    := complete per-day counts emitted in perDay
  drawdown            := max drawdown of the cumulative $1-stake PnL sequence
                         in market start-time order
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from repro_common import (base_parser, decision_slice, emit, load_extra_params,
                          load_kachoio, mean_ci95, obs, taker_fee, wilson)


def main() -> None:
    ap = base_parser(__doc__)
    args = ap.parse_args()
    extra = load_extra_params(args.params)
    srem = int(extra.get("decisionSrem", 30))
    band_lo = float(extra.get("bandLo", 0.80))
    band_hi = float(extra.get("bandHi", 0.97))
    fee = float(extra.get("feeCurrent", 0.07))
    tick = 0.01

    m, t = load_kachoio(args.markets, args.ticks, quick=args.quick, seed=args.seed)

    at = decision_slice(t, srem)
    at = at[at["mid"] != 0.5].copy()
    at["fav_up"] = at["mid"] > 0.5
    at["fav_ask"] = np.where(at["fav_up"], at["au"], at["ad"])
    at["fav_mid"] = np.where(at["fav_up"], at["mid"], 1 - at["mid"])
    at["fav_win"] = np.where(at["fav_up"], at["y"], 1 - at["y"])

    # drift: favored mid 30s earlier
    prior = decision_slice(t, srem + 30)
    prior_fav_mid = np.where(at["fav_up"], prior["mid"].reindex(at.index),
                             1 - prior["mid"].reindex(at.index))
    at["drift"] = at["fav_mid"] - prior_fav_mid

    d = at.dropna(subset=["fav_ask", "drift"])
    d = d[(d["fav_ask"] >= band_lo) & (d["fav_ask"] < band_hi) & (d["drift"] > 0)]
    d = d.join(m.set_index("condition_id")["start_epoch"], rsuffix="_m").sort_values("start_epoch")

    observations: list[dict] = []
    per_day: list[dict] = []
    n = len(d)
    if n >= 30:
        roi = (d["fav_win"] - d["fav_ask"] - taker_fee(d["fav_ask"], fee)) / (d["fav_ask"] + taker_fee(d["fav_ask"], fee))
        r_mean, r_lo, r_hi, _ = mean_ci95(roi.values)
        observations.append(obs("higher_band_roi_per_trade", "primary", value=r_mean, n=n,
                                ci_lo=r_lo, ci_hi=r_hi,
                                detail={"sourceClaim": 0.03, "band": [band_lo, band_hi],
                                        "driftDefinition": "fav mid up over prior 30s",
                                        "fee": fee, "fill": "displayed ask (1Hz touch, no queue/latency)"}))
        k = int(d["fav_win"].sum())
        w_lo, w_hi = wilson(k, n)
        observations.append(obs("higher_band_win_rate", "primary", value=k / n, n=n,
                                ci_lo=w_lo, ci_hi=w_hi,
                                detail={"meanAsk": float(d["fav_ask"].mean())}))
        slip = np.minimum(d["fav_ask"] + tick, 0.99)
        roi_s = (d["fav_win"] - slip - taker_fee(slip, fee)) / (slip + taker_fee(slip, fee))
        s_mean, s_lo, s_hi, _ = mean_ci95(roi_s.values)
        observations.append(obs("higher_band_roi_per_trade", "slippage_1_tick", value=s_mean, n=n,
                                ci_lo=s_lo, ci_hi=s_hi, detail={"sourceClaim": 0.03}))
        # drawdown of the $1-stake cumulative pnl in chronological order
        pnl = (d["fav_win"] - d["fav_ask"] - taker_fee(d["fav_ask"], fee)).values
        equity = np.cumsum(pnl)
        dd_max = float(np.max(np.maximum.accumulate(equity) - equity)) if len(equity) else 0.0
        observations.append(obs("higher_band_max_drawdown_usd_per_1usd_stakes", "primary",
                                value=dd_max, n=n,
                                detail={"note": "max drawdown of cumulative PnL, $1 stake per trade, chronological"}))
        # complete win/loss history per day
        for day, gd in d.groupby("day"):
            per_day.append({"day": str(day), "scope": "higher_band", "n": int(len(gd)),
                            "k": int(gd["fav_win"].sum()),
                            "pnl": float((gd["fav_win"] - gd["fav_ask"] - taker_fee(gd["fav_ask"], fee)).sum())})
    else:
        observations.append(obs("higher_band_roi_per_trade", "primary", n=n,
                                value_text="insufficient qualifying decisions"))

    per_day.sort(key=lambda r: (r["day"], r["scope"]))
    emit(args.out, "R11_higher_band_taker",
         params={"decisionSrem": srem, "bandLo": band_lo, "bandHi": band_hi,
                 "feeCurrent": fee, "quick": bool(args.quick), "seed": args.seed},
         dataset={"markets": len(m), "qualifyingDecisions": n, "days": int(m["day"].nunique())},
         observations=observations, per_day=per_day)


if __name__ == "__main__":
    main()
