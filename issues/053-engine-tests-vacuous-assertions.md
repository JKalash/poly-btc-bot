# [Low] engine.test.ts: fail-closed staleness test passes vacuously; "resolves a tie as UP" never exercises resolution

**Labels:** bug, tests
**Severity:** Low (test integrity)

## Summary

Two safety-relevant engine tests are weaker than their titles claim:

1. **Chainlink-staleness fail-closed test** (`apps/engine/test/engine.test.ts:177-194`): the only meaningful assertion is wrapped in `if (rd.length > 0)`; the else branch accepts "no risk decision was ever produced" as a pass. Deleting the `CHAINLINK_STALE` risk check entirely could still pass whenever the strategy gate happens to reject first — the reason-code path is never forced.
2. **"resolves a tie as UP (>= rule)"** (`:169-173`): asserts only `compareDecimal(...)` return values (1/0/−1). The actual tie→UP mapping in `resolveDue` (`engine.ts:796`) is never exercised by any test; both e2e-style tests resolve with clear ±100/±1000 USD margins.

## Failure scenario

A regression inverting the tie rule (`>` instead of `>=`) or dropping the staleness rejection reason ships with a green suite.

## Impact

The two most safety-relevant engine behaviors named in test titles are effectively untested; false confidence.

## Suggested direction (not implemented)

Drive the staleness test to a forced decision (assert `rd.length > 0` first, then the reason code); add a resolution test with `finalValue === priceToBeat` asserting outcome UP end-to-end.
