# [High] Strategy-validation / live-eligibility pipeline is entirely absent — `STRATEGY_UNVALIDATED` can never fire; `require_shadow_validation` and the fill/candidate minimums are dead

**Labels:** bug, risk-governance, spec-gap
**Severity:** High

## Summary

The spec (`polymarket.fable:510-511, 957, 964-984`) makes "strategy has insufficient live/shadow validation" a hard rejection and makes shadow validation + out-of-sample minimums (1,000 candidates, 300 fills) preconditions of live eligibility. None of it exists at runtime:

- `apps/engine/src/engine.ts:601` — `strategyValidatedForMode: true` is **hardcoded** for every mode; the evaluator's `STRATEGY_UNVALIDATED` rejection (`packages/risk/src/evaluate.ts:236-238`) is unreachable outside tests.
- `apps/engine/src/engine.ts:600` — when live-armed, `modelApprovedForMode` is also forced `true`.
- `apps/engine/src/live.ts:83-112` — `arm()` checks only adapter-configured + exact ack phrase + wallet preflight. `live.require_shadow_validation: z.literal(true)` (config) is never consulted (nor is shadow mode even reachable — issue 009).
- `research.minimum_candidate_count`, `minimum_fill_count_before_live`, `walk_forward_only` (`packages/config/src/index.ts:141-143`) have zero consumers (grep-verified).

## Failure scenario

`LIVE_TRADING_ENABLED=1` + hot-wallet key + typed acknowledgement → real-money orders flow from a strategy with zero shadow validation and zero out-of-sample history, while the config that promised those preconditions reads `require_shadow_validation: true`. Even in paper mode, a whole class of promised rejections is dead code.

## Impact

The governance layer between "typed an acknowledgement" and "trades real money" — the spec's core protection — does not exist. Distinct from issue 001 (calibration flag) and 014 (EV knob); this is the validation pipeline itself.

## Suggested direction (not implemented)

Track shadow/paper candidate and fill counts per strategy version (data already exists in `signal_candidates`/`order_fills`); gate `strategyValidatedForMode` on the configured minimums; make `arm()` verify `require_shadow_validation` against recorded shadow runs.
