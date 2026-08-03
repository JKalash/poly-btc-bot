#!/usr/bin/env python3
"""
Manifest-driven trainer for the calibrated logistic model.

Consumes a DatasetManifest JSON (packages/evidence DatasetManifest shape),
runs a PURGED + EMBARGOED walk-forward (exact port of
packages/experiments/src/folds.ts), fits a logistic model (optional GBM behind
--model gbm, research-only), fits isotonic AND Platt calibration on
out-of-fold predictions, and emits a SEALED CalibrationArtifact JSON matching
packages/experiments/src/artifacts.ts.

SEALING CONTRACT (shared with TS `sealArtifactText`/`verifyArtifactText`):
the document is compact JSON containing exactly one `"artifactChecksum":"…"`
field; the checksum is sha256 over the exact serialized bytes with that value
replaced by the empty string. Verification never re-serializes floats.

Honesty: metrics are strictly out-of-fold; the mid-price null is scored on the
same rows; net EV includes taker fee (0.07 crypto_fees_v2), spread (entry at
the executable ask), latency drift, and the measured −8.8pt adverse selection.
The artifact records whatever the data says — the promotion gate, not this
trainer, decides whether anything may trade.

Usage:
  # seal a manifest for a dataset
  .venv/bin/python train_calibrated_model.py --make-manifest \
      --files data/research/kachoio/btc_markets.parquet,data/research/kachoio/btc_ticks.parquet \
      --dataset-key kachoio_btc5m_2026q2 --out out/kachoio_manifest.json

  # train
  .venv/bin/python train_calibrated_model.py --manifest out/kachoio_manifest.json \
      --slice 90 --folds 6 --embargo-sec 60 --out out/calibrated_logistic_T90.json
"""
import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import time

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
DEFAULT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))

# Features an exported artifact may use: must exist in the runtime extractor
# vocabulary (packages/strategy/src/calibrated.ts CALIBRATED_FEATURE_EXTRACTORS).
RUNTIME_FEATURES = {"mid", "spread", "dist_half", "quarter",
                    "complement_inconsistency", "distance_z", "seconds_remaining"}
DEFAULT_FEATURES = ["mid", "spread", "dist_half", "quarter"]

# ---------------------------------------------------------------- canonical

def canonical_json(v) -> str:
    """Port of packages/evidence/src/checksum.ts canonicalJson (sorted keys, compact)."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (int, float)):
        if isinstance(v, float) and not math.isfinite(v):
            raise ValueError(f"canonical_json: non-finite number {v}")
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonical_json(x) for x in v) + "]"
    if isinstance(v, dict):
        items = sorted((k, val) for k, val in v.items())
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{canonical_json(val)}" for k, val in items) + "}"
    raise ValueError(f"canonical_json: unsupported type {type(v)}")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: str) -> tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


CHECKSUM_FIELD_EMPTY = '"artifactChecksum":""'


def seal_artifact_text(unsealed: str) -> str:
    """Mirror of TS sealArtifactText."""
    first = unsealed.find(CHECKSUM_FIELD_EMPTY)
    if first == -1:
        raise ValueError("seal: no empty artifactChecksum field (must be compact JSON)")
    if unsealed.find(CHECKSUM_FIELD_EMPTY, first + 1) != -1:
        raise ValueError("seal: multiple empty artifactChecksum fields")
    digest = sha256_text(unsealed)
    return unsealed[:first] + f'"artifactChecksum":"{digest}"' + unsealed[first + len(CHECKSUM_FIELD_EMPTY):]


def to_plain(v):
    """Deep-convert numpy scalars/arrays so json.dumps(allow_nan=False) accepts them."""
    if isinstance(v, dict):
        return {k: to_plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [to_plain(x) for x in v]
    if isinstance(v, (np.floating,)):
        f = float(v)
        return None if not math.isfinite(f) else f
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v

# -------------------------------------------------------------------- folds

def walk_forward_folds(start_ms: np.ndarray, end_ms: np.ndarray, n_folds: int,
                       embargo_ms: int, min_train: int):
    """Exact port of packages/experiments/src/folds.ts walkForwardFolds.

    Samples are WINDOWS [start_ms, end_ms]: features known by start, label at
    end. PURGE: windows overlapping a boundary belong to neither set.
    EMBARGO: training windows must end >= embargo before the test block.
    Returns list of dicts with train/test index arrays.
    """
    if n_folds < 1:
        raise ValueError("n_folds must be >= 1")
    if (end_ms < start_ms).any():
        raise ValueError("sample with end_ms < start_ms")
    span_start = int(start_ms.min())
    span_end = int(end_ms.max())
    block = (span_end - span_start) / (n_folds + 1)
    folds = []
    if block <= 0:
        return folds
    for k in range(n_folds):
        test_start = span_start + block * (k + 1)
        test_end = span_end if k == n_folds - 1 else span_start + block * (k + 2)
        embargo_boundary = test_start - embargo_ms
        train_mask = end_ms <= embargo_boundary
        test_mask = (start_ms >= test_start) & (end_ms <= test_end)
        if int(train_mask.sum()) < min_train:
            continue  # a fold trained on too little data is silently unsound -> dropped loudly
        folds.append({
            "index": k,
            "train": np.where(train_mask)[0],
            "test": np.where(test_mask)[0],
            "test_start_ms": test_start,
            "test_end_ms": test_end,
        })
    return folds

# ------------------------------------------------------------------ metrics

EPS = 1e-15


def brier(p: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean((p - y) ** 2)) if len(p) else float("nan")


def log_loss(p: np.ndarray, y: np.ndarray) -> float:
    if not len(p):
        return float("nan")
    q = np.clip(p, EPS, 1 - EPS)
    return float(np.mean(np.where(y == 1, -np.log(q), -np.log(1 - q))))


def ece(p: np.ndarray, y: np.ndarray, bins: int = 10) -> float:
    """Port of packages/experiments/src/metrics.ts expectedCalibrationError (equal-count bins)."""
    n = len(p)
    if n == 0:
        return float("nan")
    order = np.argsort(p, kind="stable")
    ps, ys = p[order], y[order]
    n_bins = min(bins, n)
    total = 0.0
    for b in range(n_bins):
        lo = (b * n) // n_bins
        hi = ((b + 1) * n) // n_bins
        if hi <= lo:
            continue
        total += ((hi - lo) / n) * abs(float(ps[lo:hi].mean()) - float(ys[lo:hi].mean()))
    return total


def mean_ci95(xs: np.ndarray):
    """Port of metrics.ts meanCi95 (normal approximation)."""
    n = len(xs)
    if n == 0:
        return {"mean": None, "ciLo": None, "ciHi": None, "n": 0}
    mean = float(np.mean(xs))
    if n == 1:
        return {"mean": mean, "ciLo": None, "ciHi": None, "n": 1}  # one sample proves nothing
    se = float(np.std(xs, ddof=1)) / math.sqrt(n)
    z = 1.959963985
    return {"mean": mean, "ciLo": mean - z * se, "ciHi": mean + z * se, "n": n}


def metric_block(p: np.ndarray, y: np.ndarray) -> dict:
    return {"brier": brier(p, y), "logLoss": log_loss(p, y), "ece": ece(p, y), "n": int(len(p))}

# ------------------------------------------------------------- calibrators

def fit_isotonic(p_raw: np.ndarray, y: np.ndarray) -> IsotonicRegression:
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.001, y_max=0.999)
    iso.fit(p_raw, y)
    return iso


def isotonic_curve(iso: IsotonicRegression):
    xs = np.asarray(iso.X_thresholds_, dtype=float)
    ys = np.asarray(iso.y_thresholds_, dtype=float)
    return [{"x": float(x), "y": float(yv)} for x, yv in zip(xs, ys)]


def fit_platt(p_raw: np.ndarray, y: np.ndarray):
    """Platt scaling p_cal = 1/(1+exp(a*x+b)) — matches TS applyCalibration."""
    lr = LogisticRegression(C=1e6, max_iter=1000)
    lr.fit(p_raw.reshape(-1, 1), y)
    w = float(lr.coef_[0][0])
    c = float(lr.intercept_[0])
    return {"a": -w, "b": -c}


def apply_platt(platt: dict, x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(platt["a"] * x + platt["b"]))

# ----------------------------------------------------------------- manifest

def load_manifest(path: str, root: str, allow_mismatch: bool) -> dict:
    with open(path) as fh:
        manifest = json.load(fh)
    for entry in manifest.get("files", []):
        fpath = os.path.join(root, entry["path"])
        if not os.path.exists(fpath):
            raise SystemExit(f"DATA_GATED: manifest file absent: {entry['path']}")
        if entry.get("sha256"):
            actual, _ = sha256_file(fpath)
            if actual != entry["sha256"]:
                msg = f"checksum mismatch for {entry['path']}: manifest {entry['sha256'][:12]}… actual {actual[:12]}…"
                if allow_mismatch:
                    print(f"WARNING: {msg} (continuing: --allow-checksum-mismatch)")
                else:
                    raise SystemExit(f"REFUSING TO TRAIN: {msg}")
    return manifest


def make_manifest(files: list[str], dataset_key: str, title: str, root: str, out: str):
    entries = []
    for rel in files:
        fpath = os.path.join(root, rel)
        if os.path.exists(fpath):
            sha, size = sha256_file(fpath)
            entries.append({"path": rel, "sha256": sha, "bytes": size, "rows": None})
        else:
            entries.append({"path": rel, "sha256": None, "bytes": None, "rows": None})
    now_ms = int(time.time() * 1000)
    manifest = {
        "id": f"dm-{dataset_key.replace('_', '-')}",
        "datasetKey": dataset_key,
        "title": title or dataset_key,
        "source": "generated by train_calibrated_model.py --make-manifest",
        "license": None,
        "files": entries,
        "contentChecksum": sha256_text(canonical_json(entries)),
        "timeRangeStartMs": None,
        "timeRangeEndMs": None,
        "rowCount": None,
        "schemaDescription": None,
        "materialized": all(e["sha256"] for e in entries),
        "retrievedAtMs": now_ms,
        "createdAtMs": now_ms,
    }
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w") as fh:
        json.dump(manifest, fh, indent=1)
    print(f"manifest written: {out} (contentChecksum {manifest['contentChecksum'][:16]}…)")

# --------------------------------------------------------------------- data

def load_samples(manifest: dict, root: str, slice_srem: int, features: list[str]) -> pd.DataFrame:
    """Return one row per decision: start_ms (decision time), end_ms (label
    time), y, mid, spread + feature columns."""
    paths = [os.path.join(root, e["path"]) for e in manifest["files"]]
    kachoio = [p for p in paths if p.endswith("btc_ticks.parquet")]
    if kachoio:
        markets = next(p for p in paths if p.endswith("btc_markets.parquet"))
        ticks = kachoio[0]
        from calibration_study import build_slice_features, load  # reuse study utilities
        m, t = load(markets, ticks)
        f = build_slice_features(t, slice_srem)
        f = f.merge(m.set_index("condition_id")[["start_epoch", "end_epoch"]],
                    left_index=True, right_index=True, how="inner")
        out = pd.DataFrame(index=f.index)
        out["start_ms"] = (f["end_epoch"] - slice_srem) * 1000  # decision time
        out["end_ms"] = f["end_epoch"] * 1000                    # label resolves here
        out["y"] = f["y"].astype(int)
        out["mid"] = f["mid"]
        out["spread"] = f["spread"]
        for name in features:
            if name not in f.columns:
                raise SystemExit(f"feature {name} not produced by build_slice_features")
            out[name] = f[name]
        return out.dropna(subset=["mid", "spread", *features]).reset_index(drop=True)

    csvs = [p for p in paths if p.endswith(".csv")]
    if len(csvs) != 1:
        raise SystemExit("manifest must reference either the kachoio parquet pair or exactly one CSV")
    df = pd.read_csv(csvs[0])
    required = {"id", "start_ms", "end_ms", "y", "mid", "spread"}
    missing = required - set(df.columns)
    if missing:
        raise SystemExit(f"CSV missing required columns: {sorted(missing)}")
    for name in features:
        if name not in df.columns:
            raise SystemExit(f"CSV missing feature column: {name}")
    return df.dropna(subset=["mid", "spread", *features]).reset_index(drop=True)

# ----------------------------------------------------------------- training

def fit_model(kind: str, X: np.ndarray, y: np.ndarray):
    if kind == "logistic":
        clf = LogisticRegression(max_iter=1000, C=1.0)
    else:  # gbm — research-only; the runtime refuses to score it
        from sklearn.ensemble import GradientBoostingClassifier
        clf = GradientBoostingClassifier(random_state=7)
    clf.fit(X, y)
    return clf


def train(args):
    root = os.path.abspath(args.root)
    manifest = load_manifest(args.manifest, root, args.allow_checksum_mismatch)
    features = [f.strip() for f in args.features.split(",") if f.strip()]
    unmapped = [f for f in features if f not in RUNTIME_FEATURES]
    if unmapped and not args.research_features:
        raise SystemExit(
            f"features {unmapped} have no runtime extractor in packages/strategy calibrated.ts; "
            "an artifact trained on them could never be scored honestly. "
            "Pass --research-features to train anyway (artifact will be refused by the runtime).")

    df = load_samples(manifest, root, args.slice, features)
    n = len(df)
    if n < 10:
        raise SystemExit(f"only {n} samples — nothing to train on")
    start_ms = df["start_ms"].to_numpy(dtype=np.int64)
    end_ms = df["end_ms"].to_numpy(dtype=np.int64)
    y = df["y"].to_numpy(dtype=int)
    X = df[features].to_numpy(dtype=float)
    mid = df["mid"].to_numpy(dtype=float)
    spread = df["spread"].to_numpy(dtype=float)

    embargo_ms = args.embargo_sec * 1000
    folds = walk_forward_folds(start_ms, end_ms, args.folds, embargo_ms, args.min_train)
    print(f"samples={n} folds_realized={len(folds)}/{args.folds} (purged, embargo {args.embargo_sec}s)")

    # ---- walk-forward out-of-fold predictions --------------------------------
    oof_idx, oof_raw, oof_iso, oof_platt = [], [], [], []
    per_fold = []
    for fold in folds:
        tr, te = fold["train"], fold["test"]
        if len(te) == 0:
            continue
        mu, sd = X[tr].mean(axis=0), X[tr].std(axis=0) + 1e-9
        clf = fit_model(args.model, (X[tr] - mu) / sd, y[tr])
        p_tr = clf.predict_proba((X[tr] - mu) / sd)[:, 1]
        p_te = clf.predict_proba((X[te] - mu) / sd)[:, 1]
        iso = fit_isotonic(p_tr, y[tr])
        platt = fit_platt(p_tr, y[tr])
        p_te_iso = iso.predict(p_te)
        p_te_platt = apply_platt(platt, p_te)
        oof_idx.append(te)
        oof_raw.append(p_te)
        oof_iso.append(p_te_iso)
        oof_platt.append(p_te_platt)
        per_fold.append({
            "fold": fold["index"], "te": te,
            "iso": p_te_iso, "platt": p_te_platt,
        })

    if not oof_idx:
        raise SystemExit("no fold produced test predictions — dataset too small for the fold plan")
    idx = np.concatenate(oof_idx)
    p_raw = np.concatenate(oof_raw)
    p_iso = np.concatenate(oof_iso)
    p_platt = np.concatenate(oof_platt)
    y_oof = y[idx]
    mid_oof = np.clip(mid[idx], 0.001, 0.999)

    iso_metrics = metric_block(p_iso, y_oof)
    platt_metrics = metric_block(p_platt, y_oof)
    mid_metrics = metric_block(mid_oof, y_oof)
    selected = "isotonic" if iso_metrics["brier"] <= platt_metrics["brier"] else "platt"
    sel_oof = p_iso if selected == "isotonic" else p_platt

    per_fold_vs_null = []
    for pf in per_fold:
        te = pf["te"]
        p_sel = pf["iso"] if selected == "isotonic" else pf["platt"]
        m_te = np.clip(mid[te], 0.001, 0.999)
        per_fold_vs_null.append({
            "fold": pf["fold"], "n": int(len(te)),
            "brierModel": brier(p_sel, y[te]), "logLossModel": log_loss(p_sel, y[te]),
            "brierMid": brier(m_te, y[te]), "logLossMid": log_loss(m_te, y[te]),
        })

    # ---- net EV after ALL frictions (fees/spread/latency/adverse selection) --
    # Preregistered rule: trade the model-favored side as a TAKER at the
    # executable ask on EVERY out-of-fold decision (no cherry-picked subset).
    p_side = np.where(sel_oof >= 0.5, sel_oof, 1 - sel_oof)
    ask = np.where(sel_oof >= 0.5, mid[idx] + spread[idx] / 2, (1 - mid[idx]) + spread[idx] / 2)
    ask = np.clip(ask, 0.001, 0.999)
    break_even = ask * (1 + args.fee * (1 - ask))
    p_win = np.clip(p_side - args.latency - args.adverse, 0.0, 1.0)
    net_ev = p_win / break_even - 1.0
    ev_ci = mean_ci95(net_ev)

    # ---- final export: model on ALL data, calibrators on pooled OOF raws -----
    mu_all, sd_all = X.mean(axis=0), X.std(axis=0) + 1e-9
    final = fit_model(args.model, (X - mu_all) / sd_all, y)
    if args.model == "logistic":
        coefficients = {
            "intercept": float(final.intercept_[0]),
            "weights": {f: float(w) for f, w in zip(features, final.coef_[0])},
        }
        standardization = {f: {"mean": float(m), "std": float(s)} for f, m, s in zip(features, mu_all, sd_all)}
    else:
        coefficients = None
        standardization = None
    final_iso = fit_isotonic(p_raw, y_oof)      # calibrators learn from OOF raws,
    final_platt = fit_platt(p_raw, y_oof)       # never from in-sample predictions

    trained_at = int(time.time() * 1000)
    date = time.strftime("%Y-%m-%d", time.gmtime(trained_at / 1000))
    try:
        code_version = subprocess.run(["git", "-C", root, "rev-parse", "--short", "HEAD"],
                                      capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        code_version = "unknown"

    version = args.version or f"calibrated_logistic_v1_{date}_T{args.slice}s"
    artifact = {
        "schemaVersion": 1,
        "id": f"cal-{manifest['datasetKey'].replace('_', '-')}-T{args.slice}s-{manifest['contentChecksum'][:8]}",
        "modelKey": "calibrated_logistic",
        "version": version,
        "kind": args.model,
        "featureNames": features,
        "coefficients": coefficients,
        "standardization": standardization,
        "foldPlan": {"nFolds": args.folds, "embargoMs": embargo_ms, "purge": True, "minTrainSamples": args.min_train},
        "foldsRealized": len(per_fold),
        "perFoldVsNull": per_fold_vs_null,
        "oofModel": iso_metrics if selected == "isotonic" else platt_metrics,
        "oofMidNull": mid_metrics,
        "fits": [
            {"method": "isotonic", "curve": isotonic_curve(final_iso), "platt": None, "metrics": iso_metrics},
            {"method": "platt", "curve": None, "platt": final_platt, "metrics": platt_metrics},
        ],
        "selectedMethod": selected,
        "netEv": {
            "perCost": ev_ci,
            "frictions": {
                "feeRate": args.fee,
                "spreadIncluded": True,
                "latencyProbPenalty": args.latency,
                "adverseSelectionProbPenalty": args.adverse,
            },
            "signalRule": f"taker model-favored side at executable ask, ALL OOF decisions at T-{args.slice}s",
        },
        "dataset": {"manifestId": manifest.get("id"), "manifestChecksum": manifest["contentChecksum"], "rows": n},
        "trainedAtMs": trained_at,
        "codeVersion": code_version,
        "artifactChecksum": "",
    }
    unsealed = json.dumps(to_plain(artifact), separators=(",", ":"), allow_nan=False)
    sealed = seal_artifact_text(unsealed)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as fh:
        fh.write(sealed)

    # ---- honest summary ------------------------------------------------------
    print(f"\nartifact written: {args.out}")
    print(f"  version={version} kind={args.model} features={features}")
    print(f"  OOF n={iso_metrics['n']}  selected={selected}")
    print(f"  brier  model={artifact['oofModel']['brier']:.5f}  mid-null={mid_metrics['brier']:.5f}  "
          f"{'MODEL BEATS NULL' if artifact['oofModel']['brier'] < mid_metrics['brier'] else 'NULL HOLDS (mid wins)'}")
    print(f"  ece    model={artifact['oofModel']['ece']:.5f}")
    if ev_ci["mean"] is not None and ev_ci["ciLo"] is not None:
        lo = ev_ci["ciLo"]
        print(f"  net EV/cost after frictions: mean={ev_ci['mean']:+.4f}  "
              f"95% CI [{lo:+.4f}, {ev_ci['ciHi']:+.4f}]  n={ev_ci['n']}")
        print(f"  promotion preview (authoritative gate: @b5p/experiments evaluateArtifactPromotion): "
              f"{'would PASS' if (lo > 0 and artifact['oofModel']['ece'] <= 0.05) else 'FAILS (as expected if the null held)'}")
    else:
        print("  net EV/cost: not enough samples for a confidence bound")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=DEFAULT_ROOT, help="repo root for manifest-relative paths")
    ap.add_argument("--make-manifest", action="store_true", help="write a DatasetManifest for --files and exit")
    ap.add_argument("--files", default="", help="(make-manifest) comma-separated repo-relative files")
    ap.add_argument("--dataset-key", default="", help="(make-manifest) dataset key slug")
    ap.add_argument("--title", default="", help="(make-manifest) dataset title")
    ap.add_argument("--manifest", help="DatasetManifest JSON path")
    ap.add_argument("--out", required=True, help="output path (manifest or artifact JSON)")
    ap.add_argument("--slice", type=int, default=90, help="seconds remaining at decision time (kachoio mode)")
    ap.add_argument("--folds", type=int, default=6)
    ap.add_argument("--embargo-sec", type=int, default=60)
    ap.add_argument("--min-train", type=int, default=500)
    ap.add_argument("--features", default=",".join(DEFAULT_FEATURES))
    ap.add_argument("--model", choices=["logistic", "gbm"], default="logistic",
                    help="gbm is research-only: the runtime refuses to score it")
    ap.add_argument("--fee", type=float, default=0.07, help="taker fee rate (crypto_fees_v2)")
    ap.add_argument("--latency", type=float, default=0.005, help="probability points lost to quote latency")
    ap.add_argument("--adverse", type=float, default=0.088, help="probability points lost to adverse selection (measured)")
    ap.add_argument("--version", default="", help="override artifact version string")
    ap.add_argument("--allow-checksum-mismatch", action="store_true")
    ap.add_argument("--research-features", action="store_true",
                    help="allow features outside the runtime extractor vocabulary (artifact unusable live)")
    args = ap.parse_args()

    if args.make_manifest:
        files = [f.strip() for f in args.files.split(",") if f.strip()]
        if not files or not args.dataset_key:
            raise SystemExit("--make-manifest requires --files and --dataset-key")
        make_manifest(files, args.dataset_key, args.title, os.path.abspath(args.root), args.out)
        return
    if not args.manifest:
        raise SystemExit("--manifest is required (or use --make-manifest)")
    train(args)


if __name__ == "__main__":
    main()
