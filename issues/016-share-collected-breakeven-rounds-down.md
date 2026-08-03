# [Low] `breakEvenTakerShareCollected` can round DOWN 1 micro-unit despite its "Rounded up" contract

**Labels:** bug, money-math
**Severity:** Low

## Summary

The share-collected taker break-even q* = p / (1 − f·(1−p)) is documented "Rounded up", and downstream code depends on the break-even being conservatively high (`ev.ts:25`: "break-even already conservatively rounded up"). But the implementation floors the intermediate fee factor, which inflates the denominator and can push the final result 1 micro-probability **below** the true ceiling — anti-conservative.

## Locations

- `packages/domain/src/fees.ts:48-54`:
  ```ts
  const feeFactor = mulDiv(ratePpm, ONE - p, PPM, "floor"); // floor inflates denom
  const denom = ONE - feeFactor;
  return mulDiv(p, ONE, denom, "ceil");                     // ceil cannot recover the loss
  ```
- Reaches `takerEdgeSatisfied` (`ev.ts:27`), `fullKellyTaker` (`kelly.ts:24`), and the risk evaluator (`evaluate.ts:216`) via `breakEvenTaker`, whenever `fee_collection_convention = "shares"`.

## Failure scenario (numerically verified)

Brute force over all p at step 7 with rate = 7%: ~37,000 of ~143,000 sampled prices produce a break-even exactly 1 micro-unit below the true ceiling, e.g. p = 0.002892 → computed BE 2892 µ vs true ceil 2893 µ. With `minEdgePpm = 0`, `takerEdgeSatisfied` passes at a price where true EV is marginally negative.

## Impact

≤10⁻⁶ probability error — economically negligible (profiles require ≥2% edge), and only under the non-default "shares" collection convention. Filed because it is a genuine violation of the conservative-rounding invariant in a file whose whole purpose is exactness, and the invariant is what downstream comments rely on.

## Suggested direction (not implemented)

Compute q* with a single division using ceiling on the exact rational: `ceil(p·PPM·ONE / (PPM·ONE − ratePpm·(ONE−p)))`.
