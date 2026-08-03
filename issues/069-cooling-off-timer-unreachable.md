# [Low] Operator cooling-off timer can never activate — `coolingOffUntilMs` is hardcoded null

**Labels:** bug, risk-engine
**Severity:** Low

## Summary

The spec lists "Operator cooling-off timer active" as a hard rejection (`polymarket.fable:512`), and the risk evaluator implements it (`packages/risk/src/evaluate.ts:239-241`). But the engine passes `coolingOffUntilMs: null` unconditionally (`apps/engine/src/engine.ts:602`), and nothing anywhere in the repo ever sets a cooling-off timestamp — no API endpoint, no config field, no post-loss trigger. The rejection branch is reachable only from tests. (`DECISION_COOLDOWN_MS` is a 5s re-decision rate limit, not an operator cooling-off.)

## Impact

Another promised-but-absent protection: the COOLING_OFF_ACTIVE reason code in the risk vocabulary can never appear in a real decision, and any operator expecting a post-loss cooling-off period (the spec's behavioral-risk mitigation) has none.

## Suggested direction (not implemented)

Set a cooling-off window after loss-stop trips (and/or expose an operator control), or remove the field and reason code.
