# [Medium] Config risk/strategy limits are silently ignored unless `risk.profile = "custom"` — and two different spread tolerances govern one order

**Labels:** bug, risk-engine, config
**Severity:** Medium

## Summary

For the three built-in profiles, `evaluateOrderRisk` receives limits from the hardcoded `RISK_PROFILES` constants; `customLimitsFromConfig` is reached **only** when `profile === "custom"` (`apps/engine/src/engine.ts:548-550, 1049-1067`). So the validated, versioned, audited config fields `risk.base_risk_fraction`, `session_loss_limit`, `daily_loss_limit`, `consecutive_loss_limit`, `kelly_multiplier`, `strategy.live_price_ceiling`, both entry cutoffs, `min_conservative_edge`, `execution.max_spread`, `max_price_impact` are all **no-ops** under the default profiles — with no validation warning that they're inert.

Worse, the wiring is internally inconsistent for the same order:
- the preset gate uses config `execution.max_spread` (`engine.ts:489`),
- the risk verdict uses the profile constant `maxSpread`,
- the resting-order edge-cancel check uses config `min_conservative_edge` (`engine.ts:760`) while the entry gate used the profile's `minConservativeEdgePpm`.

## Failure scenario

Operator on `paper_exploration` tightens `risk.session_loss_limit` from 0.15 to 0.05 via the Config page; the change is validated, versioned, diffed, audited — and does nothing. Conversely a *loosened* config value would also do nothing, so the operator's mental model and the enforced limits silently diverge in both directions. An order can pass the preset's config-spread check and fail the risk engine's profile-spread check (or vice versa) for one number the operator believes is single-valued.

## Impact

The entire Risk Center config surface is decorative outside "custom"; audit records imply configured limits governed decisions when profile constants did.

## Suggested direction (not implemented)

Either derive built-in profile limits from config (profiles as defaults, config as overrides bounded by the absolute cap) or have `validateConfig` reject/warn when risk fields are set while a built-in profile is active; unify each limit to a single source per decision.
