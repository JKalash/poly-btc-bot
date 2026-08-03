# [Medium] calibration_study.py: vol60/flips60 features depend on implicit DataFrame row order — no time sort before `np.diff`

**Labels:** bug, research
**Severity:** Medium (for research conclusions)
**Confidence:** defect confirmed in code; whether the source parquet happens to be time-sorted is unverifiable from the repo

## Summary

The volatility and quote-flip features are computed with `groupby("condition_id")["mid"].apply(lambda s: np.std(np.diff(s)))` on a frame that was **never sorted by time**. Every other extraction in the same function sorts explicitly; these two rely on the ticks parquet already being ordered per market. `groupby` preserves input order, so any out-of-order rows turn `vol60`/`flips60` into diffs of a shuffled sequence — inflated volatility and flip counts.

## Locations

- `apps/research/py/calibration_study.py:77-81` — `hist = t[t["srem"] >= srem]` then unsorted groupby-apply with `np.diff`.
- Contrast: the `at`/`lag_mid`/`first` extractions in the same file sort by `t` explicitly.

## Failure scenario

The dataset is written from partitioned/parallel ingestion where per-market ticks interleave out of order (common for parquet written from multiple workers). Two of the thirteen model features become noise; the walk-forward AUC comparisons in `docs/research/calibration-study-2026-08.md` — whose conclusion ("the mid beats our model at every horizon") gates strategy decisions — shift by an unknown amount.

## Impact

Research artifact contamination in the exact study used to justify the conservative trading posture. Even if the current parquet is sorted, the code is one data-refresh away from silently producing garbage features.

## Suggested direction (not implemented)

`sort_values(["condition_id", "t"])` before the groupby-apply (one line), matching the rest of the file.
