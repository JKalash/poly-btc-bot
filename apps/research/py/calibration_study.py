#!/usr/bin/env python3
"""
Calibration study: can anything beat the market's own price on Polymarket
BTC 5-minute markets?

Data: kachoio CC0 dataset (btc_markets.parquet, btc_ticks.parquet),
15,682 markets, 1Hz two-sided top-of-book, 2026-03-24 .. 2026-05-18.

Null hypothesis (the only one that matters): "I can't beat the market's own
price." Everything is walk-forward by UTC day; features at a decision time use
only ticks at or before that time within the same market window.

Outputs: JSON results to stdout-file + printed summary. Deliberately no
plotting deps; numbers go into docs/research/calibration-study-2026-08.md.

Run:
  apps/research/py/.venv/bin/python apps/research/py/calibration_study.py \
      --markets data/research/kachoio/btc_markets.parquet \
      --ticks data/research/kachoio/btc_ticks.parquet \
      --out data/research/kachoio/study_results.json
"""
import argparse
import json
import math
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score, brier_score_loss

FEE = 0.07
SLICES = [120, 90, 60, 30, 10]  # seconds remaining at decision time
MIN_TRAIN_DAYS = 7

def wilson(k, n, z=1.959963985):
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, center - half), min(1.0, center + half))

def taker_breakeven(p, fee=FEE):
    return p * (1 + fee * (1 - p))

def load(markets_path, ticks_path):
    m = pd.read_parquet(markets_path)
    t = pd.read_parquet(ticks_path)
    m = m[m["outcome"].isin(["Up", "Down"])].copy()
    m["y"] = (m["outcome"] == "Up").astype(int)
    m["end_epoch"] = m["market_end"].astype("int64") // 10**9
    m["start_epoch"] = m["market_start"].astype("int64") // 10**9
    m["day"] = m["market_end"].dt.strftime("%Y-%m-%d")
    m["closing_minute"] = (m["end_epoch"] // 60) % 60
    t = t.merge(m[["condition_id", "y", "start_epoch", "end_epoch", "day", "closing_minute"]],
                on="condition_id", how="inner")
    t = t.dropna(subset=["bu", "au"])
    t["mid"] = (t["bu"] + t["au"]) / 2.0
    t["srem"] = t["end_epoch"] - t["t"]
    t["selapsed"] = t["t"] - t["start_epoch"]
    return m, t

def build_slice_features(t, srem):
    """One row per market at the tick closest to `srem` seconds remaining (never after it)."""
    win = t[(t["srem"] >= srem)].sort_values("t")
    at = win.groupby("condition_id").tail(1).set_index("condition_id")

    def lag_mid(sec):
        lag = t[t["srem"] >= srem + sec].sort_values("t").groupby("condition_id").tail(1)
        return lag.set_index("condition_id")["mid"]

    mid30 = lag_mid(30)
    mid60 = lag_mid(60)
    first = t.sort_values("t").groupby("condition_id").head(1).set_index("condition_id")["mid"]

    # np.diff is order-sensitive, so do not rely on parquet/input row order.
    hist = t[t["srem"] >= srem].sort_values(["condition_id", "t"])
    vol60 = (hist[hist["srem"] <= srem + 60].groupby("condition_id")["mid"]
             .apply(lambda s: float(np.std(np.diff(s))) if len(s) > 2 else np.nan))
    flips = (hist[hist["srem"] <= srem + 60].groupby("condition_id")["bu"]
             .apply(lambda s: int((np.diff(s) != 0).sum())))

    f = pd.DataFrame(index=at.index)
    f["y"] = at["y"]
    f["day"] = at["day"]
    f["closing_minute"] = at["closing_minute"]
    f["mid"] = at["mid"]
    f["spread"] = at["au"] - at["bu"]
    f["compl_ask"] = at["au"] + at["ad"] - 1.0     # buy-both dislocation
    f["compl_bid"] = at["bu"] + at["bd"] - 1.0     # sell-both dislocation
    f["imb_best"] = (at["su"] - at["sau"]) / (at["su"] + at["sau"]).replace(0, np.nan)
    f["depth_ratio"] = at["du"] / (at["du"] + at["dd"]).replace(0, np.nan)
    f["mom30"] = at["mid"] - mid30.reindex(at.index)
    f["mom60"] = at["mid"] - mid60.reindex(at.index)
    f["mom_open"] = at["mid"] - first.reindex(at.index)
    f["vol60"] = vol60.reindex(at.index)
    f["flips60"] = flips.reindex(at.index).fillna(0)
    f["dist_half"] = at["mid"] - 0.5
    f["quarter"] = (at["closing_minute"] % 15 == 0).astype(int)
    f["srem_actual"] = at["srem"]
    # keep only decisions reasonably close to the intended slice
    f = f[f["srem_actual"] <= srem + 15]
    return f.dropna(subset=["mid", "spread", "mom30", "vol60"])

FEATURES = ["mid", "spread", "compl_ask", "compl_bid", "imb_best", "depth_ratio",
            "mom30", "mom60", "mom_open", "vol60", "flips60", "dist_half", "quarter"]

def walk_forward(f):
    """Per-day walk-forward: logistic + isotonic on all prior days, test on day d."""
    days = sorted(f["day"].unique())
    rows = []
    for i, d in enumerate(days):
        if i < MIN_TRAIN_DAYS:
            continue
        train = f[f["day"] < d]
        test = f[f["day"] == d]
        if len(train) < 500 or len(test) < 30:
            continue
        Xtr = train[FEATURES].fillna(0).values
        Xte = test[FEATURES].fillna(0).values
        ytr, yte = train["y"].values, test["y"].values
        mu, sd = Xtr.mean(axis=0), Xtr.std(axis=0) + 1e-9
        clf = LogisticRegression(max_iter=1000, C=1.0)
        clf.fit((Xtr - mu) / sd, ytr)
        p_raw_tr = clf.predict_proba((Xtr - mu) / sd)[:, 1]
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.001, y_max=0.999)
        iso.fit(p_raw_tr, ytr)
        p_model = iso.predict(clf.predict_proba((Xte - mu) / sd)[:, 1])
        rows.append(pd.DataFrame({
            "day": d, "y": yte, "p_model": p_model, "p_mid": test["mid"].values,
            "closing_minute": test["closing_minute"].values,
        }))
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()

def metrics(oos):
    out = {}
    if len(oos) == 0 or oos["y"].nunique() < 2:
        return {"n": int(len(oos))}
    out["n"] = int(len(oos))
    out["auc_model"] = float(roc_auc_score(oos["y"], oos["p_model"]))
    out["auc_mid"] = float(roc_auc_score(oos["y"], oos["p_mid"]))
    out["brier_model"] = float(brier_score_loss(oos["y"], oos["p_model"]))
    out["brier_mid"] = float(brier_score_loss(oos["y"], oos["p_mid"].clip(0.001, 0.999)))
    # per-day AUC deltas -> sign test on days
    day_delta = []
    for d, g in oos.groupby("day"):
        if g["y"].nunique() == 2 and len(g) >= 30:
            day_delta.append(roc_auc_score(g["y"], g["p_model"]) - roc_auc_score(g["y"], g["p_mid"]))
    out["days"] = len(day_delta)
    out["days_model_wins"] = int(sum(1 for x in day_delta if x > 0))
    out["mean_day_auc_delta"] = float(np.mean(day_delta)) if day_delta else None
    return out

def calibration_by_price(oos_or_slice, price_col="p_mid"):
    """Favorite-side realized frequency vs quoted price, vs taker break-even."""
    df = oos_or_slice.copy()
    fav_up = df[price_col] >= 0.5
    df["fav_price"] = np.where(fav_up, df[price_col], 1 - df[price_col])
    df["fav_won"] = np.where(fav_up, df["y"], 1 - df["y"])
    edges = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.92, 0.94, 0.96, 0.98, 0.995]
    rows = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        g = df[(df["fav_price"] >= lo) & (df["fav_price"] < hi)]
        if len(g) < 20:
            continue
        k, n = int(g["fav_won"].sum()), len(g)
        wlo, whi = wilson(k, n)
        pmean = float(g["fav_price"].mean())
        be = taker_breakeven(pmean)
        rows.append({
            "bucket": f"{lo:.3f}-{hi:.3f}", "n": n, "freq": k / n,
            "wilson_lo": wlo, "wilson_hi": whi, "mean_price": pmean,
            "taker_breakeven": be,
            "maker_edge_lower": wlo - pmean,          # >0 -> maker +EV at lower CI
            "taker_edge_lower": wlo - be,             # >0 -> taker +EV at lower CI
        })
    return rows

def minute_of_hour(m):
    rows = []
    total_up, total_n = int(m["y"].sum()), len(m)
    groups = m.groupby("closing_minute")
    bonferroni_tests = groups.ngroups
    for minute, g in groups:
        k, n = int(g["y"].sum()), len(g)
        rest_k, rest_n = total_up - k, total_n - n
        p1, p2 = k / n, rest_k / rest_n
        pool = (k + rest_k) / (n + rest_n)
        se = math.sqrt(pool * (1 - pool) * (1 / n + 1 / rest_n))
        z = (p1 - p2) / se if se > 0 else 0.0
        praw = 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))
        wlo, whi = wilson(k, n)
        rows.append({"minute": int(minute), "n": n, "up_rate": p1,
                     "wilson_lo": wlo, "wilson_hi": whi,
                     "p_raw": praw,
                     "p_bonferroni": min(1.0, praw * bonferroni_tests)})
    return sorted(rows, key=lambda r: r["minute"])

def executor_validation(t, join_srem=90, cutoff_srem=45):
    """Hypothetical maker join at best UP bid at T-90s; did price touch/trade through before cutoff?"""
    at = t[t["srem"] >= join_srem].sort_values("t").groupby("condition_id").tail(1)
    at = at[at["srem"] <= join_srem + 15][["condition_id", "bu", "y"]].rename(columns={"bu": "join_px"})
    later = t[(t["srem"] < join_srem) & (t["srem"] >= cutoff_srem)][["condition_id", "bu", "au"]]
    g = later.merge(at, on="condition_id", how="inner")
    agg = g.groupby("condition_id").agg(
        min_bu=("bu", "min"), join_px=("join_px", "first"), y=("y", "first"))
    touched = (agg["min_bu"] <= agg["join_px"])
    through = (agg["min_bu"] < agg["join_px"])
    fill_won_through = agg[through]["y"]  # for an UP maker buy filled on trade-through
    fill_won_touched = agg[touched]["y"]
    return {
        "n_markets": int(len(agg)),
        "p_touched": float(touched.mean()),
        "p_traded_through": float(through.mean()),
        "up_win_rate_all": float(agg["y"].mean()),
        "up_win_rate_when_through": float(fill_won_through.mean()) if len(fill_won_through) else None,
        "up_win_rate_when_touched": float(fill_won_touched.mean()) if len(fill_won_touched) else None,
        "note": "through-fills winning less than all-markets = adverse selection, quantified",
    }

def two_sided_scan(t):
    """Structural complement dislocations: buy-both (au+ad<1) and sell-both (bu+bd>1), gross and net of taker fees."""
    s = t.dropna(subset=["au", "ad", "bu", "bd"]).copy()
    s["buy_both_cost"] = s["au"] + s["ad"]
    s["sell_both_recv"] = s["bu"] + s["bd"]
    s["buy_both_fee"] = FEE * s["au"] * (1 - s["au"]) + FEE * s["ad"] * (1 - s["ad"])
    gross_arb = s["buy_both_cost"] < 1.0
    net_arb = (s["buy_both_cost"] + s["buy_both_fee"]) < 1.0
    sell_arb = s["sell_both_recv"] > 1.0
    return {
        "ticks": int(len(s)),
        "p_buy_both_gross": float(gross_arb.mean()),
        "p_buy_both_net_of_taker_fees": float(net_arb.mean()),
        "p_sell_both_gross": float(sell_arb.mean()),
        "mean_buy_both_cost": float(s["buy_both_cost"].mean()),
        "p95_buy_both_discount": float((1.0 - s["buy_both_cost"]).quantile(0.95)),
        "mean_complement_gap_bid": float((1.0 - s["sell_both_recv"]).mean()),
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--markets", required=True)
    ap.add_argument("--ticks", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    m, t = load(args.markets, args.ticks)
    results = {
        "dataset": {
            "markets_resolved": int(len(m)),
            "up_rate_overall": float(m["y"].mean()),
            "date_range": [str(m["market_end"].min()), str(m["market_end"].max())],
            "ticks": int(len(t)),
        },
        "slices": {},
        "minute_of_hour": minute_of_hour(m),
        "executor_validation_T90_join": executor_validation(t),
        "two_sided_scan": two_sided_scan(t),
    }

    for srem in SLICES:
        f = build_slice_features(t, srem)
        oos = walk_forward(f)
        results["slices"][str(srem)] = {
            "rows_total": int(len(f)),
            "oos": metrics(oos),
            "calibration_by_price_mid": calibration_by_price(oos if len(oos) else f.assign(p_mid=f["mid"]), "p_mid"),
        }
        print(f"[slice T-{srem}s] rows={len(f)} oos={results['slices'][str(srem)]['oos']}")

    with open(args.out, "w") as fh:
        json.dump(results, fh, indent=1)
    print(f"\nwritten: {args.out}")

if __name__ == "__main__":
    main()
