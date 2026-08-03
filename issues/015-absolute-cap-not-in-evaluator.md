# [Medium] The "absolute, unbypassable" 10% cap is a caller convention, not an evaluator invariant — and profile objects are mutable

**Labels:** bug, risk-engine, defense-in-depth
**Severity:** Medium

## Summary

`packages/risk/src/profiles.ts:5-10` promises "per-market risk can never exceed 10% … regardless of profile or custom configuration". In reality `evaluateOrderRisk`/`computeSizing` never reference `ABSOLUTE_MAX_RISK_PPM`; the cap lives only in `clampCustomProfile`, which callers must remember to invoke (the engine does — but only for `profile === "custom"`, `apps/engine/src/engine.ts:548-550`).

## Defects

1. **Cap absent from the evaluation path.** `packages/risk/src/evaluate.ts:133-138` builds the cap chain from `ctx.limits.maxRiskFractionPpm` verbatim; `:247-250` (STAKE_EXCEEDS_CAP) compares against the same caller-supplied number. `ABSOLUTE_MAX_RISK_PPM` appears nowhere in `evaluate.ts` (grep-confirmed: only profiles.ts and its test).
2. **`RISK_PROFILES` is exported unfrozen** (`profiles.ts:12-70`, no `Object.freeze`). Any code — including a future bug — can execute `RISK_PROFILES.very_aggressive.maxRiskFractionPpm = ppm("0.5")` and silently raise the live cap, defeating the stated "requires a source change plus updating the tests that pin it".
3. **`clampCustomProfile` clamps only `maxRiskFractionPpm`/`baseRiskFractionPpm`** (`profiles.ts:73-85`); custom `sessionLossLimitPpm`/`dailyLossLimitPpm` of e.g. 100% pass through unclamped.

## Failure scenario

A caller passes `limits = { ...RISK_PROFILES.very_aggressive, maxRiskFractionPpm: ppm("0.50") }` (forgetting `clampCustomProfile`), bankroll $1,000, mode live. `evaluateOrderRisk` approves a $500 stake — the cap chain binds at 50% and nothing compares against the absolute 10%. Expected per the package's own header: hard ceiling at $100.

## Impact

No wired exploit exists in the current single caller, but the package README ("absolute 10% cap") overstates what the code guarantees: the cap is one forgotten function call or one object mutation away from bypass. Defense-in-depth for the single most important safety number belongs inside the evaluator.

## Suggested direction (not implemented)

Always append an `absolute_max` entry (= `ABSOLUTE_MAX_RISK_PPM`) to the cap chain inside `computeSizing`; `Object.freeze` the profiles (deep); clamp loss limits in `clampCustomProfile`.
