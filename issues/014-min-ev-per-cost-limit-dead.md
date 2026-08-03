# [Medium] `minExpectedValuePerCostPpm` risk limit is defined, configured, documented — and never enforced

**Labels:** bug, risk-engine
**Severity:** Medium

## Summary

`RiskLimits.minExpectedValuePerCostPpm` exists in the type, is set to 1% in all three built-in profiles, and is populated from the operator config knob `strategy.min_expected_value_per_cost` — but **no gate in `evaluateOrderRisk` (or anywhere else) reads it**. The only EV-related gate applied is `minConservativeEdgePpm`.

## Locations

- `packages/domain/src/types.ts:154` — declaration.
- `packages/risk/src/profiles.ts:26,43,65` — set in every profile.
- `apps/engine/src/engine.ts:1062` + `packages/config/src/index.ts:59` — built from config.
- `packages/risk/src/evaluate.ts` — zero reads (repo-wide grep: no consumer outside construction sites).
- `apps/engine/src/snapshot.ts:134` — `evPerCostAfterFriction` is display-only.

## Failure scenario

Operator sets `strategy.min_expected_value_per_cost: 0.05` (5%) with `min_conservative_edge: 0.02`, expecting sub-5%-EV trades rejected. A maker candidate with q/p−1 = 3% (q=0.5665, p=0.55) is **approved**: the 2% edge gate passes; the 5% EV limit is silently ignored.

## Impact

A documented safety knob is a no-op. With default numbers it is coincidentally subsumed (the edge gate measures the same quantity with a stricter default), so the gap is invisible until someone raises the EV knob above the edge threshold — at which point their configuration silently does nothing.

## Suggested direction (not implemented)

Add an EV gate in `evaluateOrderRisk` (reject with e.g. `INSUFFICIENT_EV`), or delete the field from `RiskLimits`/config so it cannot mislead.
