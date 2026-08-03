# [High] `strategy.calibration_required` is never enforced — UNCALIBRATED models can approve trades

**Labels:** bug, risk-governance
**Severity:** High

## Summary

The config flag `strategy.calibration_required` (default `true`) has **no runtime consumer anywhere in the codebase**. Decisions are approved using models whose versions are explicitly labeled `*_UNCALIBRATED`, even though the configuration promises that calibration is required.

## Locations

- `packages/config/src/index.ts:66` — `calibration_required: z.boolean().default(true)` is defined…
- …and never read again. `grep -r "calibration_required"` across the repo matches only the config schema, the spec (`polymarket.fable:920`), docs, and a test asserting the model *version string* contains "UNCALIBRATED".
- `apps/engine/src/engine.ts:542-544` — `decide()` picks the model purely from `strategy.probability_model` / preset, with no calibration check:
  ```ts
  const modelKey = strategyVersion === "late_snipe_composite_v1" ? "binance_composite" : this.cfg.strategy.probability_model;
  const model = MODELS[modelKey] ?? MODELS.book_baseline!;
  ```
- `packages/strategy/src/models.ts:81,134` — `distance_vol_heuristic_v1_UNCALIBRATED` and `binance_composite_v1_UNCALIBRATED` are live model options.
- `apps/engine/src/engine.ts:600` — `modelApprovedForMode` comes from `model.approvedForPaper`/`approvedForLive`, not from calibration status.

## Failure scenario

1. Operator leaves the default config (`calibration_required: true`) believing uncalibrated models cannot drive trades.
2. Config sets `probability_model: "binance_composite"` (a valid enum value).
3. The engine approves and submits a paper — or, when live-armed, a **real** — order using `binance_composite_v1_UNCALIBRATED`. Observed in practice: a winning trade approved by `binance_composite_v1_UNCALIBRATED` while `calibration_required` was `true`.

## Impact

- A documented governance gate is silently absent. The config field is pure decoration, which creates false assurance.
- Combined with live arming (see issue 004), an uncalibrated heuristic can size real-money positions.

## Suggested direction (not implemented)

Either enforce the flag (e.g., a risk-engine rejection `MODEL_UNCALIBRATED` whenever `calibration_required` is true and the selected model lacks a calibration artifact), or remove the field and document the policy honestly. The decision snapshot should record the calibration policy in force.
