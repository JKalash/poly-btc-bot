# [Medium] Config validation has no upper/lower bounds on safety-relevant values — nonsense configs validate cleanly

**Labels:** bug, config
**Severity:** Medium

## Summary

The `fraction` type accepts any non-negative decimal (`^\d+(\.\d{1,6})?$` — e.g. `"9.999999"`), and most integer fields have no `.min()`/`.max()`. Values that disable safety gates or invert time logic pass validation without error.

## Locations & examples

- `packages/config/src/index.ts:12` — `fraction` unbounded above: `session_loss_limit: "5.0"`, `live_price_ceiling: "1.50"`, `kelly_multiplier: "9.0"`, `max_spread: "3"` all validate.
- `:36-48` — `max_age_ms`, `max_gap_ms`, `max_drift_ms` accept zero/negative.
- `:54-63` — `candidate_seconds_*`, `cancel_seconds_remaining` accept negatives: `cancel_seconds_remaining: -100` validates.
- `:71-72` — nothing validates `late_snipe.snipe_seconds_remaining_min < max`.
- `:109,131` — `simulated_latency_ms`, `arming_token_ttl_minutes` unbounded (TTL is clamped later in code, others are not).
- Only `max_risk_fraction`/`base_risk_fraction` get cross-checks (`:174-182`).

## Failure scenarios

- `cancel_seconds_remaining: -100` → maker-order expiry becomes `endEpoch + 100s` (`apps/engine/src/engine.ts:720`, `apps/engine/src/paper.ts:113`): orders rest past market end and are never time-canceled.
- `live_price_ceiling: "1.50"` → the PRICE_ABOVE_CEILING gate can never fire (prices are ≤ 1.0) — a live safety gate disabled by a validated config.
- Negative `max_age_ms` inverts staleness checks (fails safe by rejecting everything, but is accepted nonsense).

## Impact

Safety-relevant limits can be configured into meaninglessness with zero validation feedback, in the same config path the operator is told to trust.

## Suggested direction (not implemented)

Bound every fraction to its meaningful domain (probabilities/fractions ≤ 1, kelly multiplier ≤ 1, spreads ≤ 1), require positive integers where negative/zero is meaningless, and add the missing min<max cross-checks.
