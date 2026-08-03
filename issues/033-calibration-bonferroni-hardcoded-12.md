# [Low] calibration_study.py: Bonferroni correction hardcodes ×12 while grouping by exact closing minute (up to 60 buckets)

**Labels:** bug, research, statistics
**Severity:** Low
**Confidence:** math confirmed; presence of off-grid closes in the dataset needs-check

## Summary

`minute_of_hour` groups markets by raw closing minute (`(end_epoch // 60) % 60` — up to 60 possible buckets), but multiplies each p-value by a fixed 12 (the count assuming perfect :00/:05 grid alignment). If any market closes off-grid (delayed listings), the number of tests exceeds 12 and the correction is too weak; the per-minute grouping also fragments N relative to the TS-side 5-minute bucketing it is compared against (`packages/domain/src/buckets.ts:6-10`).

## Locations

- `apps/research/py/calibration_study.py:179-194`.

## Failure scenario

The 14k-market dataset contains a handful of markets ending off the 5-minute grid → extra buckets, each tested with an under-scaled Bonferroni factor → a spurious "significant minute-of-hour effect" survives correction in the study output, feeding exactly the kind of timing-pattern overinterpretation the project's own README warns against.

## Impact

Mild multiple-comparison error in a published research artifact.

## Suggested direction (not implemented)

Multiply by the actual number of buckets tested (`len(groups)`), and/or bucket identically to the TS side before testing.
