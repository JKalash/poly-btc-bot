"""Shared helpers for the R1-R11 source-reproduction scripts.

Contract with the TS layer (apps/research/src/repro):
  - every script is deterministic: same inputs + same --seed => byte-identical
    observation payloads (sorted keys, explicit ordering everywhere, no wall
    clock, no network, no unseeded randomness);
  - output is a single JSON document:
      { "experiment": str, "params": {...}, "dataset": {...},
        "observations": [ {metric, scope, value, valueText, n, ciLo, ciHi, detail} ],
        "perDay": [ {...} ] }        # optional per-day rows for TS fold stats
  - anything the data cannot support is emitted as an observation with
    detail.dataGated = the exact missing dataset name — never silently skipped.

Statistics here are descriptive (doubles); verdicts/decision rules live in TS.
"""
from __future__ import annotations

import argparse
import json
import math
import os

import numpy as np
import pandas as pd

Z95 = 1.959963985


# ------------------------------------------------------------------ stats

def wilson(k: int, n: int, z: float = Z95) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, center - half), min(1.0, center + half))


def mean_ci95(xs: np.ndarray) -> tuple[float, float, float, int]:
    """(mean, lo, hi, n) — normal approximation, mirrors @b5p/experiments meanCi95."""
    n = int(xs.size)
    if n == 0:
        return (float("nan"), float("nan"), float("nan"), 0)
    mean = float(np.mean(xs))
    if n == 1:
        return (mean, float("-inf"), float("inf"), 1)
    se = float(np.std(xs, ddof=1)) / math.sqrt(n)
    return (mean, mean - Z95 * se, mean + Z95 * se, n)


def taker_fee(price: np.ndarray | float, fee_rate: float) -> np.ndarray | float:
    """Per-share taker fee, the source's formula: rate * price * (1 - price)."""
    return fee_rate * price * (1 - price)


def taker_breakeven(price: np.ndarray | float, fee_rate: float) -> np.ndarray | float:
    """Win probability needed for a taker buy at `price` to break even."""
    return price * (1 + fee_rate * (1 - price))


# ------------------------------------------------------------------ loading

def _read(path: str) -> pd.DataFrame:
    if path.endswith(".csv"):
        return pd.read_csv(path)
    return pd.read_parquet(path)


def load_kachoio(markets_path: str, ticks_path: str, quick: bool = False,
                 quick_markets: int = 400, seed: int = 42):
    """Load + normalize the kachoio corpus (or a schema-identical smoke fixture).

    Returns (m, t):
      m: one row per resolved Up/Down market — condition_id, y, start_epoch,
         end_epoch, day, sorted by start_epoch.
      t: ticks joined to m — condition_id, t, bu/au/bd/ad, su/sau/sd/sad, du/dd,
         mid (UP mid), srem, selapsed.
    Quick mode subsamples markets DETERMINISTICALLY (every k-th market in
    chronological order, k chosen to keep ~quick_markets) — stated in output.
    """
    m = _read(markets_path)
    t = _read(ticks_path)
    m = m[m["outcome"].isin(["Up", "Down"])].copy()
    m["y"] = (m["outcome"] == "Up").astype(int)
    if pd.api.types.is_numeric_dtype(m["market_start"]):
        m["start_epoch"] = m["market_start"].astype("int64")
        m["end_epoch"] = m["market_end"].astype("int64")
        m["day"] = pd.to_datetime(m["end_epoch"], unit="s", utc=True).dt.strftime("%Y-%m-%d")
    else:
        m["market_start"] = pd.to_datetime(m["market_start"], utc=True)
        m["market_end"] = pd.to_datetime(m["market_end"], utc=True)
        m["start_epoch"] = m["market_start"].astype("int64") // 10 ** 9
        m["end_epoch"] = m["market_end"].astype("int64") // 10 ** 9
        m["day"] = m["market_end"].dt.strftime("%Y-%m-%d")
    m = m.sort_values(["start_epoch", "condition_id"]).reset_index(drop=True)

    if quick and len(m) > quick_markets:
        k = max(1, len(m) // quick_markets)
        m = m.iloc[::k].reset_index(drop=True)  # deterministic chronological thinning

    keep = m[["condition_id", "y", "start_epoch", "end_epoch", "day"]]
    t = t.merge(keep, on="condition_id", how="inner")
    for col in ("su", "sd", "sau", "sad", "du", "dd"):
        if col not in t.columns:
            t[col] = np.nan
    t = t.dropna(subset=["bu", "au"]).copy()
    t["mid"] = (t["bu"] + t["au"]) / 2.0
    t["srem"] = t["end_epoch"] - t["t"]
    t["selapsed"] = t["t"] - t["start_epoch"]
    t = t.sort_values(["condition_id", "t"]).reset_index(drop=True)
    return m, t


def decision_slice(t: pd.DataFrame, srem: int, tolerance: int = 15) -> pd.DataFrame:
    """One row per market: last tick at or before `srem` seconds remaining,
    but no more than `tolerance` seconds earlier. Indexed by condition_id."""
    win = t[t["srem"] >= srem].sort_values("t")
    at = win.groupby("condition_id").tail(1).set_index("condition_id")
    return at[at["srem"] <= srem + tolerance]


def contiguous_chain(m: pd.DataFrame) -> pd.DataFrame:
    """Markets annotated with prior-run info from CONTIGUOUS windows only.

    Adds: prev_contiguous (bool: previous market ends exactly when this starts),
    run_len_before (# of consecutive same-direction outcomes immediately before
    this window, counting only across contiguous windows), prev_dir (+1/-1/0).
    Causal: uses only windows that RESOLVED before this window starts.
    """
    m = m.sort_values("start_epoch").reset_index(drop=True)
    dirs = np.where(m["y"].values == 1, 1, -1)
    starts = m["start_epoch"].values
    ends = m["end_epoch"].values
    n = len(m)
    run_before = np.zeros(n, dtype=int)
    prev_dir = np.zeros(n, dtype=int)
    prev_contig = np.zeros(n, dtype=bool)
    for i in range(1, n):
        if ends[i - 1] == starts[i]:
            prev_contig[i] = True
            prev_dir[i] = dirs[i - 1]
            if i >= 2 and prev_contig[i - 1] and dirs[i - 2] == dirs[i - 1]:
                run_before[i] = run_before[i - 1] + 1 if run_before[i - 1] > 0 else 2
            else:
                run_before[i] = 1
    m["prev_contiguous"] = prev_contig
    m["prev_dir"] = prev_dir
    m["run_len_before"] = run_before
    m["dir"] = dirs
    return m


# ------------------------------------------------------------------ output

def obs(metric: str, scope: str, value=None, n=None, ci_lo=None, ci_hi=None,
        value_text=None, detail=None) -> dict:
    def f(x):
        if x is None:
            return None
        x = float(x)
        if math.isnan(x):
            return None
        if math.isinf(x):
            return None  # +-inf is not representable in JSON; CI stays open
        return x
    return {
        "metric": metric,
        "scope": scope,
        "value": f(value),
        "valueText": value_text,
        "n": int(n) if n is not None else None,
        "ciLo": f(ci_lo),
        "ciHi": f(ci_hi),
        "detail": detail,
    }


def gated(metric: str, scope: str, missing_dataset: str, note: str | None = None) -> dict:
    """A visible DATA_GATED observation naming the exact missing dataset."""
    return obs(metric, scope, detail={
        "dataGated": missing_dataset,
        **({"note": note} if note else {}),
    })


def emit(out_path: str, experiment: str, params: dict, dataset: dict,
         observations: list[dict], per_day: list[dict] | None = None) -> None:
    doc = {
        "experiment": experiment,
        "params": params,
        "dataset": dataset,
        "observations": observations,
        "perDay": per_day or [],
    }
    text = json.dumps(doc, sort_keys=True, indent=1, allow_nan=False)
    if out_path == "-":
        print(text)
    else:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w") as fh:
            fh.write(text)


def base_parser(description: str) -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=description)
    ap.add_argument("--markets", required=False, help="kachoio btc_markets.parquet (or smoke csv)")
    ap.add_argument("--ticks", required=False, help="kachoio btc_ticks.parquet (or smoke csv)")
    ap.add_argument("--collector-dir", required=False, default=None,
                    help="directory with collector export CSVs (ref_ticks.csv, feature_market_snapshots.csv, markets.csv)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--quick", action="store_true", help="deterministic chronological subsample (stated in params)")
    ap.add_argument("--params", default=None, help="JSON file with extra params (e.g. fixture weights from TS)")
    return ap


def load_extra_params(path: str | None) -> dict:
    if not path:
        return {}
    with open(path) as fh:
        return json.load(fh)
