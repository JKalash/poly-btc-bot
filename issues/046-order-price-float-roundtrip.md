# [Low] Order prices are constructed through float round-trips, contradicting the documented fixed-point invariant (currently exact — policy boundary leak)

**Labels:** bug, money-math, strategy
**Severity:** Low (no numeric failure today; invariant/fragility issue)

## Summary

`packages/domain/src/fixed.ts:11-12` documents: "Binary floating point is never used for order construction". But `FeatureSet` down-converts book prices to floats (`p6`), and the gate/preset code converts them back to `Prob6` to build `desiredMakerPrice6`/`desiredPrice6` — which flows directly into order construction.

## Locations

- `packages/strategy/src/gates.ts:104-125` — `asProb6(f.upBestBid)` etc. → `desiredMakerPrice6`.
- `packages/strategy/src/presets.ts:131-139` — `BigInt(Math.round(ask * 1_000_000))`.
- Flow: `engine.decide` (`apps/engine/src/engine.ts:541`) → `price6` → paper/live order.

## Analysis

The round-trip is provably exact for the Prob6 domain today (integers ≤ 1e6 survive a double round-trip; error ≈1e-10 ≪ 0.5, so `Math.round` always recovers the exact micro-price). Filed because the documented invariant is violated on the *order-price path specifically*, and any future feature that transforms these floats before conversion (mid, microprice, price improvement in float space) silently loses exactness with no guard.

## Suggested direction (not implemented)

Carry `Prob6` alongside the display floats in `FeatureSet` for book prices the gates consume, or gate the conversion behind an exactness assertion.
