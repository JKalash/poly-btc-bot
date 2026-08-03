# [Medium] Crossed book produces negative uncertainty and inverted probability bounds; conservative widening vanishes exactly when the book is untrustworthy

**Labels:** bug, strategy, models
**Severity:** Medium (reproduced by execution)

## Summary

`BookState.applyLevelUpdate` applies `price_change` levels one at a time with no crossed/locked-book handling, so between two messages of one burst the book can be crossed (best bid > best ask). Downstream, `bookBaselineModel` computes `uncertainty = min(0.2, halfSpread + incons)` which goes **negative**, producing `lowerBound > probability > upperBound` (invariant violation), and `conservativeProbabilityForSide` degenerates to the raw point estimate — zero widening — at exactly the moment the book is most untrustworthy. The spread gate also passes on a negative spread.

## Locations

- `packages/strategy/src/book.ts:65-69` — `spread()` can return negative.
- `packages/strategy/src/models.ts:48-57` — uncertainty/bounds from spread; `:177-183` — `conservativeProbabilityForSide` clamp removes widening.
- `packages/strategy/src/gates.ts:80-85` — spread gate `f.upSpread <= cfg.maxSpread` passes for negatives.

## Reproduced failure

UP bids `[0.58]`, asks `[0.56]` (aggressive bid update arrives before the matching ask removal), mirror-consistent DOWN book →
`upSpread = −0.02`, `uncertainty = −0.01`, `probability = 570000n`, `lowerBound = 580000n > upperBound = 560000n`, `conservativeProbabilityForSide(est,"UP") = 570000n` (no widening), spread check `pass: true` at `−0.020`.

## Impact

- Persisted `ProbabilityEstimate`s (decision snapshots, `signal_candidates`, Signal Inspector via `rt.lastEval`) violate lower ≤ upper.
- The risk engine's Kelly input (`conservativeProbability`) is un-widened during crossed-book instants — anti-conservative sizing input.
- Order *placement* is still blocked for the maker preset (`maker_price_available` yields null when bid ≥ ask), so this corrupts sizing inputs and audit data rather than firing orders directly.

## Suggested direction (not implemented)

Detect crossed/locked books in `BookState` (flag or clamp spread at ≥ 0), floor uncertainty at a minimum positive value, and assert/clamp bound ordering in `ProbabilityEstimate` construction.
