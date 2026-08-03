#!/usr/bin/env python3
"""R3 — Favored-side calibration by executable ask (kachoio corpus).

Reproduces the Reddit favored-side price-band study on the data we actually
have: one PREREGISTERED decision per market at T-{decision_srem}s — favored
side = side with mid > 0.5, bought at its displayed ask, held to resolution.

Also produces the EXCLUSION LEDGER that attempts to explain the source's
4,569-vs-4,442 (127 decisions, 2.78%) gap: every market that does NOT land in
a band is assigned to exactly one named exclusion class, so each class's share
can be compared against the source's missing share.

Fees: both the source's 0.072 assumption and the current 0.07 schedule.
Maker variant: quoted at favored bid; fill proxied by later trade-through of
the join price (1Hz book proxy — stated, not hidden).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from repro_common import (base_parser, decision_slice, emit, gated,
                          load_extra_params, load_kachoio, mean_ci95, obs,
                          taker_breakeven, taker_fee, wilson)

BANDS = [(0.50, 0.55), (0.55, 0.60), (0.60, 0.65), (0.65, 0.70), (0.70, 0.80), (0.80, 0.95)]
SOURCE_GAP_SHARE = 127 / 4569  # 2.78% of the source's decisions missing from its band table


def band_label(lo: float, hi: float) -> str:
    return f"{lo:.2f}-{hi:.2f}"


def favored_frame(t: pd.DataFrame, m: pd.DataFrame, srem: int):
    """Decision frame + exclusion ledger at one decision time.

    Returns (d_in_band, classes, in_band_mask, d_all) where classes is a list of
    (name, count, description) covering every resolved market exactly once
    (in-band + all classes == total markets).
    """
    total = len(m)
    at = decision_slice(t, srem).reindex(m["condition_id"].values)
    has_tick = at["mid"].notna()
    d = at[has_tick].copy()
    d["fav_up"] = d["mid"] > 0.5
    ambiguous = d["mid"] == 0.5
    d["fav_ask"] = np.where(d["fav_up"], d["au"], d["ad"])
    d["fav_bid"] = np.where(d["fav_up"], d["bu"], d["bd"])
    d["fav_ask_size"] = np.where(d["fav_up"], d["sau"], d["sad"])
    d["fav_win"] = np.where(d["fav_up"], d["y"], 1 - d["y"])
    fav_ask_missing = d["fav_ask"].isna() & ~ambiguous
    below_band = (d["fav_ask"] < 0.50) & ~ambiguous & ~fav_ask_missing
    above_band = (d["fav_ask"] >= 0.95) & ~ambiguous & ~fav_ask_missing
    in_band = ~ambiguous & ~fav_ask_missing & ~below_band & ~above_band
    classes = [
        ("no_book_at_decision", total - int(has_tick.sum()),
         "no tick within tolerance of the decision time (missing/stale book)"),
        ("ambiguous_favorite_mid_050", int(ambiguous.sum()),
         "mid exactly 0.50 - no favored side exists"),
        ("favored_ask_missing", int(fav_ask_missing.sum()),
         "favored side had no ask quoted (one-sided book)"),
        ("favored_ask_below_050", int(below_band.sum()),
         "favored ask below the bottom band edge (crossed/locked book artifact)"),
        ("favored_ask_at_or_above_095", int(above_band.sum()),
         "favored ask >= 0.95 - beyond the source's top band edge"),
    ]
    assert sum(c[1] for c in classes) + int(in_band.sum()) == total
    return d[in_band].copy(), classes, in_band, d


def main() -> None:
    ap = base_parser(__doc__)
    args = ap.parse_args()
    extra = load_extra_params(args.params)
    decision_srem = int(extra.get("decisionSrem", 270))
    gap_sweep = [int(s) for s in extra.get("gapSweepSrems", [270, 240, 210, 180, 120, 60])]
    fee_source = float(extra.get("feeSource", 0.072))
    fee_current = float(extra.get("feeCurrent", 0.07))
    maker_cutoff_srem = int(extra.get("makerCutoffSrem", 15))

    m, t = load_kachoio(args.markets, args.ticks, quick=args.quick, seed=args.seed)
    total_markets = len(m)

    observations: list[dict] = []
    per_day: list[dict] = []

    # ------- 127-gap accounting: exclusion ledger SWEPT over decision times --
    # The source never states its decision time. Each exclusion class's share
    # is a function of decision time, so the sweep shows which classes CAN
    # produce a 2.78% gap at any plausible decision time and which never can.
    for srem in gap_sweep:
        d_in, classes, in_band, d_all = favored_frame(t, m, srem)
        excluded = sum(c[1] for c in classes)
        observations.append(obs(
            "gap_accounting_total", f"T-{srem}", value=excluded / total_markets,
            n=total_markets,
            value_text=f"{excluded}/{total_markets} excluded ({excluded / total_markets:.4f}); source gap 127/4569 ({SOURCE_GAP_SHARE:.4f})",
            detail={"sourceGapShare": SOURCE_GAP_SHARE, "includedTotal": int(in_band.sum())},
        ))
        for name, count, desc in classes:
            share = count / total_markets
            observations.append(obs(
                "gap_accounting_class", f"T-{srem}/{name}", value=share, n=count,
                detail={
                    "description": desc,
                    "sourceGapShare": SOURCE_GAP_SHARE,
                    # preregistered: a class alone "explains" the source's gap at
                    # this decision time if its share is within 1.5pp of 2.78%
                    "consistentWithSourceGap": bool(abs(share - SOURCE_GAP_SHARE) <= 0.015),
                },
            ))
        # boundary-convention probe: favored-by-mid vs favored-by-higher-ask
        both_asks = d_all.dropna(subset=["au", "ad"])
        conv_diff = int(((both_asks["au"] > both_asks["ad"]) != (both_asks["mid"] > 0.5)).sum())
        observations.append(obs(
            "gap_accounting_class", f"T-{srem}/favored_convention_mid_vs_higher_ask",
            value=conv_diff / total_markets, n=conv_diff,
            detail={"description": "decisions whose favored side flips under an ask-based (vs mid-based) convention",
                    "sourceGapShare": SOURCE_GAP_SHARE,
                    "consistentWithSourceGap": bool(abs(conv_diff / total_markets - SOURCE_GAP_SHARE) <= 0.015)},
        ))

    # -------- band calibration at the PRIMARY preregistered decision time ----
    dd, _, in_band, d = favored_frame(t, m, decision_srem)
    included_total = len(dd)
    both_asks = d.dropna(subset=["au", "ad"])

    # ---------------- band calibration (taker at displayed ask) -------------
    dd = d[in_band].copy()
    for lo, hi in BANDS:
        g = dd[(dd["fav_ask"] >= lo) & (dd["fav_ask"] < hi)]
        n = len(g)
        scope = band_label(lo, hi)
        if n == 0:
            observations.append(obs("band_win_rate", scope, n=0, value_text="no decisions in band"))
            continue
        k = int(g["fav_win"].sum())
        w_lo, w_hi = wilson(k, n)
        mean_ask = float(g["fav_ask"].mean())
        be_src = float(taker_breakeven(mean_ask, fee_source))
        be_cur = float(taker_breakeven(mean_ask, fee_current))
        ev = (g["fav_win"] - g["fav_ask"] - taker_fee(g["fav_ask"], fee_current)) / g["fav_ask"]
        ev_mean, ev_lo, ev_hi, _ = mean_ci95(ev.values)
        observations.append(obs(
            "band_win_rate", scope, value=k / n, n=n, ci_lo=w_lo, ci_hi=w_hi,
            detail={"meanAsk": mean_ask,
                    "breakevenFeeSource": be_src, "breakevenFeeCurrent": be_cur,
                    "winMinusBreakevenSource": k / n - be_src,
                    "winMinusBreakevenCurrent": k / n - be_cur,
                    "feeSource": fee_source, "feeCurrent": fee_current},
        ))
        observations.append(obs(
            "band_net_ev_per_cost_taker", scope, value=ev_mean, n=n, ci_lo=ev_lo, ci_hi=ev_hi,
            detail={"fee": fee_current, "entry": "displayed favored ask, hold to resolution"},
        ))
        # spread / size stratification inside the band (execution reality)
        one_tick = g[(g["fav_ask"] - g["fav_bid"]).round(3) <= 0.011]
        if len(one_tick) >= 20:
            k1, n1 = int(one_tick["fav_win"].sum()), len(one_tick)
            w1lo, w1hi = wilson(k1, n1)
            observations.append(obs("band_win_rate_tight_spread", scope, value=k1 / n1, n=n1,
                                    ci_lo=w1lo, ci_hi=w1hi,
                                    detail={"definition": "spread <= 1 tick at decision"}))
        sizes = g["fav_ask_size"].dropna()
        if len(sizes) >= 20:
            observations.append(obs(
                "band_displayed_ask_size_usd", scope,
                value=float((sizes * g.loc[sizes.index, "fav_ask"]).median()), n=len(sizes),
                detail={"note": "median displayed $ at the touch - the size a taker can actually lift"}))

    # complementary-outcome consistency: P(fav) + P(other) sums
    comp = both_asks[in_band.reindex(both_asks.index).fillna(False)]
    if len(comp) > 0:
        gap = (comp["au"] + comp["ad"] - 1.0)
        g_mean, g_lo, g_hi, g_n = mean_ci95(gap.values)
        observations.append(obs("complement_ask_sum_minus_1", "overall", value=g_mean,
                                n=g_n, ci_lo=g_lo, ci_hi=g_hi,
                                detail={"note": "mean(au+ad-1) at decision; >0 = you pay the complement toll"}))

    # ---------------- maker variant (quoted at bid; 1Hz trade-through proxy) --
    later = t[(t["srem"] < decision_srem) & (t["srem"] >= maker_cutoff_srem)]
    lat_up = later.groupby("condition_id")["bu"].min()
    lat_dn = later.groupby("condition_id")["bd"].min()
    mk = dd.copy()
    mk["later_min_bid"] = np.where(mk["fav_up"], lat_up.reindex(mk.index), lat_dn.reindex(mk.index))
    mk = mk.dropna(subset=["fav_bid", "later_min_bid"])
    filled = mk["later_min_bid"] < mk["fav_bid"]
    if len(mk) > 0:
        k_all, n_all = int(mk["fav_win"].sum()), len(mk)
        k_fill, n_fill = int(mk.loc[filled, "fav_win"].sum()), int(filled.sum())
        w_all = wilson(k_all, n_all)
        observations.append(obs("maker_fill_rate_proxy", "overall", value=n_fill / n_all, n=n_all,
                                detail={"proxy": "later best bid strictly below join price (1Hz book, no queue model)",
                                        "cutoffSrem": maker_cutoff_srem}))
        if n_fill > 0:
            w_f = wilson(k_fill, n_fill)
            observations.append(obs(
                "maker_win_rate_filled_vs_all", "overall", value=k_fill / n_fill - k_all / n_all,
                n=n_fill, ci_lo=w_f[0] - k_all / n_all, ci_hi=w_f[1] - k_all / n_all,
                value_text=f"filled {k_fill / n_fill:.4f} vs all {k_all / n_all:.4f} (all CI {w_all[0]:.4f}-{w_all[1]:.4f})",
                detail={"note": "negative = adverse selection on passive favored-side joins"}))

    # threshold-distance stratification is impossible on this corpus
    observations.append(gated(
        "band_win_rate_by_threshold_distance", "overall",
        "kachoio corpus has no underlying Chainlink/BTC reference price stream (book-only dataset)",
        note="threshold-distance and volatility-regime strata need the collector's reference_price_ticks joined at decision time"))

    # per-day per-band counts for TS fold stability
    for (day, scope), g in dd.assign(
            band=pd.cut(dd["fav_ask"], [b[0] for b in BANDS] + [BANDS[-1][1]],
                        right=False, labels=[band_label(*b) for b in BANDS])
    ).groupby(["day", "band"], observed=True):
        per_day.append({"day": str(day), "scope": str(scope), "n": int(len(g)),
                        "k": int(g["fav_win"].sum()),
                        "meanAsk": float(g["fav_ask"].mean())})
    per_day.sort(key=lambda r: (r["day"], r["scope"]))

    emit(args.out, "R3_favored_side_calibration",
         params={"decisionSrem": decision_srem, "gapSweepSrems": gap_sweep,
                 "feeSource": fee_source, "feeCurrent": fee_current,
                 "makerCutoffSrem": maker_cutoff_srem, "bands": [band_label(*b) for b in BANDS],
                 "quick": bool(args.quick), "seed": args.seed},
         dataset={"markets": total_markets, "decisionsInBands": included_total,
                  "days": int(m["day"].nunique())},
         observations=observations, per_day=per_day)


if __name__ == "__main__":
    main()
