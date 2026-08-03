#!/usr/bin/env python3
"""R8 — Extended-move fade (kachoio corpus + collector magnitudes).

Source claims (Reddit): after a strong 20-minute run, reversal rates by year:
2023: 53.8%, 2024: 51.6%, 2025: 54.5%, 2026: 54.6% — framed as ~4pts of paper
edge at a 0.50 zero-fee maker price, with fills and adverse selection unproven.

Preregistered reproduction on what we have:
  - Run = >=4 consecutive same-direction CONTIGUOUS 5-minute windows (20 min),
    from resolved market outcomes (the resolution source itself). Reversal =
    next window resolves opposite. Our corpus is 2026 (Mar-May) -> comparable
    to the source's 2026 row only; 2023-2025 are DATA_GATED.
  - THE PRICE IS NOT 0.50: we also measure what the fade side actually costs at
    the next window's start (displayed ask) and the fill-conditioned reversal
    rate for a maker join at the fade side's bid (1Hz trade-through proxy) -
    the source's "4-point edge at 0.50" assumption is tested, not assumed.
  - Magnitude filter (>=0.8% cumulative move) needs a reference price stream:
    computed from the 3-day collector Chainlink export when present (tiny n,
    reported), otherwise DATA_GATED.
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd

from repro_common import (base_parser, contiguous_chain, emit, gated,
                          load_extra_params, load_kachoio, mean_ci95, obs,
                          taker_fee, wilson)

YEAR_GATE = "source's multi-year candle dataset (2023-2025 rows) - never published; our corpus is 2026-03..05 only"


def main() -> None:
    ap = base_parser(__doc__)
    args = ap.parse_args()
    extra = load_extra_params(args.params)
    min_run = int(extra.get("minRunBlocks", 4))
    fee = float(extra.get("feeCurrent", 0.07))
    entry_selapsed = int(extra.get("entrySelapsed", 5))
    maker_cutoff_srem = int(extra.get("makerCutoffSrem", 150))

    m, t = load_kachoio(args.markets, args.ticks, quick=args.quick, seed=args.seed)
    chain = contiguous_chain(m)

    observations: list[dict] = []
    per_day: list[dict] = []

    # ---- reversal rate after a >= min_run same-direction run (2026 row) ----
    cand = chain[chain["prev_contiguous"] & (chain["run_len_before"] >= min_run)]
    n = len(cand)
    k = int((cand["dir"] != cand["prev_dir"]).sum())
    lo, hi = wilson(k, n)
    observations.append(obs(
        "reversal_rate_after_run", "2026_mar_may", value=k / n if n else None, n=n,
        ci_lo=lo, ci_hi=hi,
        detail={"minRunBlocks": min_run, "sourceClaim2026": 0.546,
                "definition": "next contiguous window resolves opposite to the run direction",
                "label": "BTC market outcomes (Chainlink-resolved)"},
    ))
    for day, gd in cand.groupby("day"):
        per_day.append({"day": str(day), "scope": "reversal_after_run", "n": int(len(gd)),
                        "k": int((gd["dir"] != gd["prev_dir"]).sum())})
    for year in ("2023", "2024", "2025"):
        observations.append(gated("reversal_rate_after_run", year, YEAR_GATE))

    # ---- what the fade actually costs (the 0.50 zero-fee assumption test) ----
    fade = cand.copy()
    fade["fade_up"] = fade["prev_dir"] == -1  # fade side bets AGAINST the run direction
    early = t[t["selapsed"] >= entry_selapsed].sort_values("t").groupby("condition_id").head(1)
    early = early[early["selapsed"] <= entry_selapsed + 15].set_index("condition_id")
    fj = early.reindex(fade["condition_id"].values)
    fj = fj.join(fade.set_index("condition_id")[["fade_up", "dir", "prev_dir"]])
    fj["fade_ask"] = np.where(fj["fade_up"], fj["au"], fj["ad"])
    fj["fade_bid"] = np.where(fj["fade_up"], fj["bu"], fj["bd"])
    fj["fade_win"] = np.where(fj["fade_up"], fj["y"], 1 - fj["y"])
    fj = fj.dropna(subset=["fade_ask"])
    if len(fj) >= 30:
        a_mean, a_lo, a_hi, a_n = mean_ci95(fj["fade_ask"].values)
        observations.append(obs(
            "fade_side_entry_ask", "overall", value=a_mean, n=a_n, ci_lo=a_lo, ci_hi=a_hi,
            detail={"sourceAssumption": 0.50,
                    "note": "displayed fade-side ask ~5s after the next window opens; the source priced the fade at 0.50 zero-fee maker"},
        ))
        ev = (fj["fade_win"] - fj["fade_ask"] - taker_fee(fj["fade_ask"], fee)) / fj["fade_ask"]
        e_mean, e_lo, e_hi, e_n = mean_ci95(ev.values)
        observations.append(obs(
            "fade_taker_net_ev_per_cost", "overall", value=e_mean, n=e_n, ci_lo=e_lo, ci_hi=e_hi,
            detail={"fee": fee, "entry": "taker at displayed fade ask, hold to resolution"},
        ))
        # maker at fade bid: fill-conditioned reversal (the promotion gate input)
        later = t[(t["srem"] < 300 - entry_selapsed) & (t["srem"] >= maker_cutoff_srem)]
        lat_up = later.groupby("condition_id")["bu"].min()
        lat_dn = later.groupby("condition_id")["bd"].min()
        mk = fj.dropna(subset=["fade_bid"]).copy()
        mk["later_min_bid"] = np.where(mk["fade_up"], lat_up.reindex(mk.index), lat_dn.reindex(mk.index))
        mk = mk.dropna(subset=["later_min_bid"])
        filled = mk["later_min_bid"] < mk["fade_bid"]
        n_all, n_fill = len(mk), int(filled.sum())
        if n_all >= 30:
            k_all = int(mk["fade_win"].sum())
            observations.append(obs("fade_maker_fill_rate_proxy", "overall",
                                    value=n_fill / n_all, n=n_all,
                                    detail={"proxy": "later best bid strictly below join (1Hz book, no queue)",
                                            "joinAt": f"fade bid ~{entry_selapsed}s after open",
                                            "cancelAt": f"T-{maker_cutoff_srem}s"}))
            if n_fill >= 20:
                k_fill = int(mk.loc[filled, "fade_win"].sum())
                w_f = wilson(k_fill, n_fill)
                observations.append(obs(
                    "fade_maker_win_rate_filled_vs_all", "overall",
                    value=k_fill / n_fill - k_all / n_all, n=n_fill,
                    ci_lo=w_f[0] - k_all / n_all, ci_hi=w_f[1] - k_all / n_all,
                    value_text=f"filled {k_fill / n_fill:.4f} vs all {k_all / n_all:.4f}",
                    detail={"note": "negative = adverse selection against the resting fade bid; "
                                    "the source's zero-fee maker framing ignores exactly this"}))
    else:
        observations.append(obs("fade_side_entry_ask", "overall", n=len(fj),
                                value_text="insufficient fade candidates with books"))

    # ---- magnitude-conditioned variant (>=0.8% cumulative move over the run) --
    ref_path = os.path.join(args.collector_dir, "ref_ticks.csv") if args.collector_dir else None
    if ref_path and os.path.exists(ref_path):
        ticks = pd.read_csv(ref_path)
        ticks = ticks[(ticks["symbol"] == "btc/usd") & (ticks["source"] == "chainlink")]
        if len(ticks) > 10:
            s = ticks.sort_values("source_ts_ms")
            ts = s["source_ts_ms"].values / 1000.0
            vals = s["value_float"].values
            run_starts = cand["start_epoch"].values - 300 * min_run
            run_ends = cand["start_epoch"].values
            i0 = np.searchsorted(ts, run_starts, side="right") - 1
            i1 = np.searchsorted(ts, run_ends, side="right") - 1
            ok = (i0 >= 0) & (i1 >= 0) & ((run_starts - np.where(i0 >= 0, ts[np.clip(i0, 0, None)], np.nan)) <= 90) \
                 & ((run_ends - np.where(i1 >= 0, ts[np.clip(i1, 0, None)], np.nan)) <= 90)
            move_pct = np.where(ok, np.abs(vals[np.clip(i1, 0, None)] / vals[np.clip(i0, 0, None)] - 1) * 100, np.nan)
            big = cand[pd.Series(move_pct, index=cand.index) >= 0.8]
            nb = len(big)
            if nb >= 10:
                kb = int((big["dir"] != big["prev_dir"]).sum())
                blo, bhi = wilson(kb, nb)
                observations.append(obs("reversal_rate_after_run_ge0.8pct", "collector_overlap",
                                        value=kb / nb, n=nb, ci_lo=blo, ci_hi=bhi,
                                        detail={"sourceClaimNearest": 0.548,
                                                "note": "3-day collector overlap only"}))
            else:
                observations.append(obs("reversal_rate_after_run_ge0.8pct", "collector_overlap", n=nb,
                                        value_text=f"only {nb} run candidates overlap the 3-day collector window with >=0.8% moves - insufficient",
                                        detail={"insufficientN": True}))
    else:
        observations.append(gated("reversal_rate_after_run_ge0.8pct", "overall",
                                  "local collector export (data/pglite reference_price_ticks) not present",
                                  note="kachoio has no reference price stream; the >=0.8% magnitude filter needs one"))

    per_day.sort(key=lambda r: (r["day"], r["scope"]))
    emit(args.out, "R8_extended_move_fade",
         params={"minRunBlocks": min_run, "feeCurrent": fee, "entrySelapsed": entry_selapsed,
                 "makerCutoffSrem": maker_cutoff_srem, "quick": bool(args.quick), "seed": args.seed},
         dataset={"markets": len(m), "runCandidates": n, "days": int(m["day"].nunique())},
         observations=observations, per_day=per_day)


if __name__ == "__main__":
    main()
