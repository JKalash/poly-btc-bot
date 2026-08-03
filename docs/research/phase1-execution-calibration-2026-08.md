# Phase 1 — Execution truth + calibration gate (refinement brief, 2026-08-03)

Implements the first phase of `2026-07-31-001-initial-refinement.fable`: make live trading
measurable and gate-able. Everything below is landed, tested (257 tests repo-wide), and deployed.

## What was built

**Evidence + experiment rails (1a).** `packages/evidence` (labels, `SourceEvidence`,
`DatasetManifest`, canonical-JSON/file checksums) and `packages/experiments`
(definitions/runs/observations, walk-forward folds with embargo+purge, promotion primitives).
The kachoio dataset manifest and the 2026-08 calibration study are backfilled as first-class
provenance (`pnpm --filter @b5p/research seed:evidence`).

**Execution-quality timeline (1b).** Every order now leaves a 14-state audit trail
(`DECISION_SNAPSHOT → … → BALANCE_RECONCILED`, `@b5p/domain/execution`) with UTC + monotonic
timestamps, correlation-id threading, and the four book snapshots (decision/send/ack/fill)
referenced per attempt. Latency samples, queue estimates, fill counterfactuals, and post-fill
markouts (250ms/1s/2s/5s/10s/30s/at-resolution; only books strictly after the fill; dropped —
never fabricated — when no book arrives) persist to eight new tables (migration 0003).
Invariants enforced in `apps/engine/src/execution-invariants.ts`: one in-flight mutation per
intent, remaining-size-aware retries, no retry after UNKNOWN_OUTCOME until reconciled, no retry
past cutoff, duplicate ack ≠ duplicate exposure, post-only crossing = safe REJECTED.

**Three paper fill variants (1c).** `OPTIMISTIC_TOUCH` / `QUEUE_REPLAY` / `CONSERVATIVE_STRESS`
are computed and persisted per decision (`paper_variant_results`, never merged; `pnl6` net of
fees). `QUEUE_REPLAY` is the pre-existing conservative-queue logic — regression-tested bit-exact
against a golden fixture — and remains what `pnl_records` reports. `CONSERVATIVE_STRESS` is a
provable subset (latency-filtered, one-tick-worse, seeded-RNG missed fills/cancels, adverse
markout penalty): tests assert it can never fill more or better than QUEUE_REPLAY.
`fill_selection_cost = signal_conditioned_value − fill_conditioned_value` is computed per
resolution batch (this is R9 as core measurement).

**Calibrated model + promotion gate (1d).** `apps/research/py/train_calibrated_model.py` is a
manifest-driven trainer (purged/embargoed walk-forward logistic, isotonic+Platt, byte-exact
sealed artifact). `calibrated_logistic` in `@b5p/strategy` loads a sealed artifact
(config `strategy.calibrated_artifact_path` or `B5P_CALIBRATED_ARTIFACT_PATH`): without one it
estimates nothing and is approved for nothing; with one it is paper-approved; live requires a
PASSING persisted `StrategyPromotionDecision`. `governanceForMode()` in `@b5p/risk` now derives
the two governance gates from persisted evidence (fail-closed), and arming bypasses exactly
those two gates and nothing else (asserted by set-difference in tests).

**Dashboards (1e).** Execution Lab (`/execution`): funnel, latency waterfall, markout curve,
quoted-vs-filled, queue/counterfactuals, three-variant P&L side by side. Strategy Comparison
(`/strategy`): per-strategy counts, prices, Brier/log-loss, EV decomposition (spread column
honestly absent — spread-at-decision is not yet persisted), promotion status with reasons.
Mandatory language present: "Score strength is not probability", "Being filled can be adverse
information", "No trade is a valid decision".

## The headline result (unsoftened)

Training on the kachoio dataset (14,226 markets, T-90s, 6 purged+embargoed folds, 12,208
out-of-fold decisions, runtime-mappable features only):

- Out-of-fold Brier: model **0.11713** vs mid-price null **0.11711** — **the null held**,
  replicating the 2026-08 study. ECE 0.0052 (well-calibrated, but not better than the market).
- Net EV per unit cost after fees (0.07 taker), spread, latency, and the measured −8.8pt
  adverse selection: **−0.1013**, 95% CI [−0.1020, −0.1007].
- Promotion decision: **FAIL** — "net-EV lower 95% CI −0.1020 does not exceed 0". The decision
  is persisted, `active=true`, and is what the governance gate reads.

Consequence: `approvedForPaper: true, approvedForLive: false`. The previous state — live
trading via arm-override on an admittedly uncalibrated model — is now an explicit, measured
refusal. Arming still bypasses the two governance gates by design (operator override), but the
override now stands against recorded evidence that the model has no executable edge at T-90s,
and every live order it places is now fully instrumented (timeline, markouts, counterfactuals)
so the cost of that override is measurable.

## Reproduce

```
cd apps/research/py && . venv/bin/activate
python train_calibrated_model.py --manifest out/kachoio_manifest.json --out out/
pnpm --filter @b5p/research promote -- --artifact py/out/calibrated_logistic_kachoio_T90.json \
  --out py/out/decision_kachoio_T90.json
pnpm --filter @b5p/research seed:calibration   # registers artifact + decision in the DB
```

Artifacts are sealed (sha256 over exact bytes with the checksum field blanked); the loader and
the seeder refuse tampered or mispaired files. Phase 2 (source fixtures, R1–R8/R11
reproductions, Evidence Lab) and Phase 3 (CTF/inventory MM, rewards) are next per the plan.
