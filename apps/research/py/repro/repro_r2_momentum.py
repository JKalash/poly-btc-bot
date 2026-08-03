#!/usr/bin/env python3
"""R2 — Momentum and sustained-run continuation.

Source claims (Reddit, ETH 1-minute candles, ~3 years, 346,094 windows):
continuation ~49.0% (any move), 48.0% (>=0.10%), 46.5% (>=0.40%); sustained
runs: >=2: 48.4%, >=3: 47.6%, >=4: 46.4%, >=5: 46.1%, >=4 & >=0.8%: 44.8%.

What our data supports, run separately and labeled:
  A. kachoio BTC market-OUTCOME runs (Chainlink-resolved, 8 weeks, ~14k
     contiguous windows): P(next window same direction | run length k). This is
     the closest BTC analogue of the sustained-run table; the OUTCOME series is
     the resolution source itself (no candle approximation).
  B. Local collector windows (3 days): 5-minute deltas from the Chainlink
     stream and from Binance ticks SEPARATELY, with the magnitude filters
     (any / >=0.10% / >=0.40%) - tiny n, reported with Wilson CIs, never pooled
     with A.
  ETH (all rows) and the source's 3-year magnitude-conditioned table are
  DATA_GATED - the exact missing dataset is named in the output.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from repro_common import (base_parser, contiguous_chain, emit, gated,
                          load_extra_params, load_kachoio, obs, wilson)

ETH_GATE = "source's ~3-year ETH 1-minute candle dataset (1.73M bars / 346,094 windows) - never published"


def outcome_runs(m: pd.DataFrame, observations: list[dict], per_day: list[dict]) -> None:
    chain = contiguous_chain(m)
    # continuation given run length ending at the PREVIOUS window
    valid = chain[chain["prev_contiguous"]]
    # any prior window (run>=1)
    for min_run, scope in [(1, "any_prior_direction"), (2, "run>=2"), (3, "run>=3"),
                           (4, "run>=4"), (5, "run>=5")]:
        sub = valid[valid["run_len_before"] >= min_run]
        n = len(sub)
        if n == 0:
            observations.append(obs("outcome_run_continuation", scope, n=0))
            continue
        k = int((sub["dir"] == sub["prev_dir"]).sum())
        lo, hi = wilson(k, n)
        observations.append(obs(
            "outcome_run_continuation", scope, value=k / n, n=n, ci_lo=lo, ci_hi=hi,
            detail={"label": "BTC 5m market outcomes (Chainlink-resolved), continuation of resolved direction",
                    "asset": "BTC", "sourceAsset": "ETH", "poolable": False},
        ))
        if min_run >= 2:
            for day, gd in sub.groupby("day"):
                per_day.append({"day": str(day), "scope": scope, "n": int(len(gd)),
                                "k": int((gd["dir"] == gd["prev_dir"]).sum())})


def window_deltas(ticks: pd.DataFrame, label: str, staleness_s: int) -> pd.DataFrame:
    """5-minute window open/close from a reference tick stream.

    Boundary value = last tick at or before the boundary, no older than
    staleness_s. Returns frame indexed by window epoch with delta_pct.
    """
    s = ticks.sort_values("source_ts_ms")
    ts = s["source_ts_ms"].values / 1000.0
    vals = s["value_float"].values
    lo = int(np.ceil(ts.min() / 300.0) * 300)
    hi = int(np.floor(ts.max() / 300.0) * 300)
    bounds = np.arange(lo, hi + 1, 300)
    idx = np.searchsorted(ts, bounds, side="right") - 1
    ok = idx >= 0
    b_ts = np.where(ok, ts[np.clip(idx, 0, None)], np.nan)
    b_val = np.where(ok, vals[np.clip(idx, 0, None)], np.nan)
    fresh = (bounds - b_ts) <= staleness_s
    f = pd.DataFrame({"epoch": bounds, "value": np.where(fresh, b_val, np.nan)}).set_index("epoch")
    f["next_value"] = f["value"].shift(-1)
    f["delta_pct"] = (f["next_value"] - f["value"]) / f["value"] * 100.0
    f["source"] = label
    return f.dropna(subset=["delta_pct"])


def collector_momentum(collector_dir: str | None, observations: list[dict],
                       staleness_s: int) -> dict:
    import os
    meta: dict = {}
    path = os.path.join(collector_dir, "ref_ticks.csv") if collector_dir else None
    if not path or not os.path.exists(path):
        for src in ("chainlink", "binance"):
            for scope in ("any", ">=0.10pct", ">=0.40pct"):
                observations.append(gated(
                    f"delta_continuation_{src}", scope,
                    "local collector export (data/pglite reference_price_ticks) not present",
                    note="run apps/research repro CLI with the collector export step on the machine that holds the collector DB"))
        return meta
    ticks = pd.read_csv(path)
    ticks = ticks[ticks["symbol"] == "btc/usd"]
    for src in ("chainlink", "binance"):
        sub = ticks[ticks["source"] == src]
        if len(sub) < 10:
            observations.append(gated(f"delta_continuation_{src}", "any",
                                      f"collector export has no {src} btc/usd ticks"))
            continue
        f = window_deltas(sub, src, staleness_s)
        # continuation: next window direction == this window direction
        f["dir"] = np.sign(f["delta_pct"])
        f["next_dir"] = f["dir"].shift(-1)
        f["next_delta"] = f["delta_pct"].shift(-1)
        f = f.dropna(subset=["next_dir"])
        f = f[(f["dir"] != 0) & (f["next_dir"] != 0)]
        meta[f"{src}_windows"] = int(len(f))
        for scope, mask in [("any", np.ones(len(f), dtype=bool)),
                            (">=0.10pct", np.abs(f["delta_pct"].values) >= 0.10),
                            (">=0.40pct", np.abs(f["delta_pct"].values) >= 0.40)]:
            sub_f = f[mask]
            n = len(sub_f)
            if n < 10:
                observations.append(obs(f"delta_continuation_{src}", scope, n=n,
                                        value_text=f"only {n} windows in 3-day collector sample - insufficient",
                                        detail={"insufficientN": True}))
                continue
            k = int((sub_f["next_dir"] == sub_f["dir"]).sum())
            lo, hi = wilson(k, n)
            observations.append(obs(
                f"delta_continuation_{src}", scope, value=k / n, n=n, ci_lo=lo, ci_hi=hi,
                detail={"asset": "BTC", "windowSeconds": 300, "boundaryStalenessMaxS": staleness_s,
                        "note": "3-day local collector sample; CIs are wide by construction"},
            ))
    return meta


def main() -> None:
    ap = base_parser(__doc__)
    args = ap.parse_args()
    extra = load_extra_params(args.params)
    staleness_s = int(extra.get("boundaryStalenessMaxS", 90))

    observations: list[dict] = []
    per_day: list[dict] = []
    dataset: dict = {}

    if args.markets and args.ticks:
        m, _t = load_kachoio(args.markets, args.ticks, quick=args.quick, seed=args.seed)
        dataset.update({"markets": len(m), "days": int(m["day"].nunique())})
        outcome_runs(m, observations, per_day)
    else:
        observations.append(gated("outcome_run_continuation", "overall",
                                  "kachoio corpus (data/research/kachoio) not present"))

    dataset.update(collector_momentum(args.collector_dir, observations, staleness_s))

    # everything ETH is data-gated, visibly
    observations.append(gated("outcome_run_continuation", "ETH", ETH_GATE))
    for scope in ("any", ">=0.10pct", ">=0.40pct"):
        observations.append(gated("delta_continuation_eth", scope, ETH_GATE))
    observations.append(gated("sustained_run_magnitude", "run>=4_and_>=0.8pct",
                              ETH_GATE,
                              note="also not computable from the 3-day collector sample (expected n ~ 0)"))

    per_day.sort(key=lambda r: (r["day"], r["scope"]))
    emit(args.out, "R2_momentum_continuation",
         params={"boundaryStalenessMaxS": staleness_s, "quick": bool(args.quick), "seed": args.seed},
         dataset=dataset, observations=observations, per_day=per_day)


if __name__ == "__main__":
    main()
