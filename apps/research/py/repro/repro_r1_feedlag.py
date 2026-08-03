#!/usr/bin/env python3
"""R1 — Feed lag and structural cross-feed basis (local collector export).

Source claims (Reddit): a 5,826-entry "arm-and-watch" lag test with
momentum-side resolution 74.8% vs observed ask 75.3% (reported gap -0.4pp;
the visible rounded values subtract to -0.5pp — preserved as a reconciliation
issue, handled TS-side from the fixture); an apparent +$456 Chainlink/Binance
offset strategy that vanished after correcting a structural ~0.12% ETH offset
with a 0.10% entry gate.

What our data supports (BTC, 3-day local collector export, both feeds):
  - per-feed update cadence and source->receive clock offset;
  - rolling Binance-minus-Chainlink basis (structural level via rolling
    median), robust z of the residual;
  - the FALSE-FIRE test: share of time an absolute cross-feed gate (0.10%,
    0.12%) fires BEFORE vs AFTER structural-basis correction — the source's
    core lesson, tested on BTC;
  - lead/lag cross-correlation on jointly-fresh segments;
  - a small-n momentum-side analogue from engine feature snapshots
    (sign(distanceBps) at ~T-30s vs resolution vs displayed ask).
DATA_GATED (named): the source's ETH feeds/windows; Polymarket book reaction
time (local orderbook_snapshots is empty); decision->send->ack->fill latency
(needs live/paper order flow).
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd

from repro_common import (base_parser, emit, gated, load_extra_params,
                          mean_ci95, obs, wilson)

ETH_GATE = "source's ETH tick recordings / 5,826 arm-and-watch windows - never published"
BOOK_GATE = "orderbook_snapshots (local collector table is empty; the live one is on the Fly volume)"
EXEC_GATE = "execution timeline events (decision/send/ack/fill) - requires live or paper order flow, absent locally"


def feed_stats(ticks: pd.DataFrame, observations: list[dict]) -> None:
    for src, g in ticks.groupby("source"):
        gaps = np.diff(np.sort(g["source_ts_ms"].values)) / 1000.0
        offs = (g["received_ts_ms"] - g["source_ts_ms"]).values / 1000.0
        observations.append(obs("feed_update_median_gap_s", str(src),
                               value=float(np.median(gaps)) if len(gaps) else None, n=len(g),
                               detail={"p95GapS": float(np.quantile(gaps, 0.95)) if len(gaps) else None}))
        observations.append(obs("feed_receive_minus_source_median_s", str(src),
                               value=float(np.median(offs)), n=len(g),
                               detail={"p95S": float(np.quantile(offs, 0.95)),
                                       "note": "includes real transport delay AND local clock offset; not separable without a trusted clock"}))


def basis_analysis(ticks: pd.DataFrame, observations: list[dict],
                   gates_pct: list[float]) -> None:
    cl = ticks[ticks["source"] == "chainlink"].sort_values("source_ts_ms")
    bn = ticks[ticks["source"] == "binance"].sort_values("source_ts_ms")
    if len(cl) < 100 or len(bn) < 100:
        observations.append(gated("cross_feed_basis_pct", "overall",
                                  "collector export lacks sufficient chainlink+binance overlap"))
        return
    a = pd.merge_asof(
        cl[["source_ts_ms", "value_float"]].rename(columns={"value_float": "chainlink"}),
        bn[["source_ts_ms", "value_float"]].rename(columns={"value_float": "binance"}),
        on="source_ts_ms", direction="backward", tolerance=120_000)
    a = a.dropna(subset=["binance"])
    if len(a) < 100:
        observations.append(gated("cross_feed_basis_pct", "overall",
                                  "no jointly-fresh chainlink+binance stretches within 120s staleness"))
        return
    a["basis_pct"] = (a["binance"] - a["chainlink"]) / a["chainlink"] * 100.0
    a = a.set_index(pd.to_datetime(a["source_ts_ms"], unit="ms", utc=True))
    a["structural"] = a["basis_pct"].rolling("1800s", min_periods=30).median()
    a["residual"] = a["basis_pct"] - a["structural"]
    mad = a["residual"].rolling("1800s", min_periods=30).apply(
        lambda x: float(np.median(np.abs(x - np.median(x)))), raw=True)
    a["robust_z"] = a["residual"] / (1.4826 * mad.replace(0, np.nan))

    m_mean, m_lo, m_hi, m_n = mean_ci95(a["basis_pct"].values)
    observations.append(obs("cross_feed_basis_pct", "overall", value=m_mean, n=m_n,
                            ci_lo=m_lo, ci_hi=m_hi,
                            detail={"medianPct": float(a["basis_pct"].median()),
                                    "p95AbsPct": float(np.quantile(np.abs(a["basis_pct"]), 0.95)),
                                    "asset": "BTC", "sourceStructuralClaimEthPct": 0.12}))
    res = a["residual"].dropna()
    for gate in gates_pct:
        raw_fire = float((np.abs(a["basis_pct"]) >= gate).mean())
        corr_fire = float((np.abs(res) >= gate).mean()) if len(res) else None
        observations.append(obs(
            "gate_false_fire_share", f"abs>={gate:.2f}pct", value=raw_fire, n=len(a),
            detail={"afterStructuralCorrection": corr_fire,
                    "note": "share of aligned ticks where an absolute cross-feed gate fires; "
                            "the source's 0.10% gate fired structurally on ETH - this is the BTC analogue"}))
    z = a["robust_z"].dropna()
    if len(z):
        observations.append(obs("basis_robust_z_p95_abs", "overall",
                                value=float(np.quantile(np.abs(z), 0.95)), n=len(z)))

    # lead/lag cross-correlation on jointly fresh 5s grid
    grid = a[~a.index.duplicated(keep="last")]
    g5 = grid[["chainlink", "binance"]].resample("5s").last().ffill(limit=6).dropna()
    if len(g5) >= 300:
        rc = np.log(g5["chainlink"]).diff(6).dropna()   # 30s returns
        rb = np.log(g5["binance"]).diff(6).dropna()
        joined = pd.concat([rc.rename("c"), rb.rename("b")], axis=1).dropna()
        best_lag, best_corr = None, 0.0
        lags = list(range(-12, 13))
        corrs = []
        for lag in lags:  # lag>0: binance leads chainlink by lag*5s
            c = joined["c"].corr(joined["b"].shift(lag))
            corrs.append(float(c) if pd.notna(c) else 0.0)
            if pd.notna(c) and abs(c) > abs(best_corr):
                best_corr, best_lag = float(c), lag
        observations.append(obs(
            "lead_lag_best_5s_steps", "binance_vs_chainlink",
            value=float(best_lag) if best_lag is not None else None, n=len(joined),
            detail={"bestCorr": best_corr, "corrByLag": dict(zip([str(l) for l in lags], corrs)),
                    "convention": "positive = binance leads chainlink by lag*5s (30s log returns)",
                    "caveat": "descriptive alignment diagnostic on 3 days of BTC; not a tradable-lag claim"}))
    else:
        observations.append(obs("lead_lag_best_5s_steps", "binance_vs_chainlink", n=len(g5),
                                value_text="insufficient jointly-fresh grid points",
                                detail={"insufficientN": True}))


def momentum_analogue(collector_dir: str, observations: list[dict], srem_target: int) -> None:
    path = os.path.join(collector_dir, "feature_market_snapshots.csv")
    if not os.path.exists(path):
        observations.append(gated("momentum_side_rate_vs_ask", "overall",
                                  "local collector export (feature_market_snapshots.csv) not present"))
        return
    f = pd.read_csv(path)
    f = f.dropna(subset=["seconds_remaining", "distance_bps", "up_best_ask", "down_best_ask"])
    f = f[(f["seconds_remaining"] >= srem_target - 5) & (f["seconds_remaining"] <= srem_target + 10)]
    f = f.sort_values("ts_ms").groupby("market_id").tail(1)
    f = f[f["distance_bps"] != 0]
    n = len(f)
    if n < 50:
        observations.append(obs("momentum_side_rate_vs_ask", "overall", n=n,
                                value_text="insufficient snapshot coverage",
                                detail={"insufficientN": True}))
        return
    mom_up = f["distance_bps"] > 0
    won = np.where(mom_up, (f["outcome"] == "UP"), (f["outcome"] == "DOWN"))
    ask = np.where(mom_up, f["up_best_ask"], f["down_best_ask"])
    k = int(won.sum())
    lo, hi = wilson(k, n)
    observations.append(obs(
        "momentum_side_rate_vs_ask", "overall", value=k / n - float(np.mean(ask)), n=n,
        ci_lo=lo - float(np.mean(ask)), ci_hi=hi - float(np.mean(ask)),
        value_text=f"momentum-side resolution {k / n:.4f} (CI {lo:.4f}-{hi:.4f}) vs mean displayed ask {float(np.mean(ask)):.4f}",
        detail={"sourceClaim": {"rate": 0.748, "ask": 0.753, "reportedGap": -0.004, "n": 5826},
                "design": f"BTC analogue at ~T-{srem_target}s: momentum side = sign(chainlink distance to strike); "
                          "the source's design (ETH, offset-corrected cross-feed momentum) differs",
                "asset": "BTC"}))


def main() -> None:
    ap = base_parser(__doc__)
    args = ap.parse_args()
    extra = load_extra_params(args.params)
    gates_pct = [float(x) for x in extra.get("gatesPct", [0.10, 0.12])]
    srem_target = int(extra.get("momentumSrem", 30))

    observations: list[dict] = []
    dataset: dict = {}

    ref_path = os.path.join(args.collector_dir, "ref_ticks.csv") if args.collector_dir else None
    if ref_path and os.path.exists(ref_path):
        ticks = pd.read_csv(ref_path)
        ticks = ticks[ticks["symbol"] == "btc/usd"]
        dataset["refTicks"] = int(len(ticks))
        dataset["bySource"] = {str(s): int(n) for s, n in ticks.groupby("source").size().items()}
        feed_stats(ticks, observations)
        basis_analysis(ticks, observations, gates_pct)
        momentum_analogue(args.collector_dir, observations, srem_target)
    else:
        for metric in ("feed_update_median_gap_s", "cross_feed_basis_pct",
                       "gate_false_fire_share", "momentum_side_rate_vs_ask"):
            observations.append(gated(metric, "overall",
                                      "local collector export (data/pglite reference_price_ticks) not present"))

    observations.append(gated("book_reaction_time_ms", "overall", BOOK_GATE))
    observations.append(gated("decision_send_ack_fill_latency_ms", "overall", EXEC_GATE))
    observations.append(gated("eth_structural_offset_pct", "overall", ETH_GATE,
                              note="the 0.12% offset / 0.10% gate scenario is tested on BTC via gate_false_fire_share"))

    emit(args.out, "R1_feed_lag_basis",
         params={"gatesPct": gates_pct, "momentumSrem": srem_target,
                 "quick": bool(args.quick), "seed": args.seed},
         dataset=dataset, observations=observations)


if __name__ == "__main__":
    main()
