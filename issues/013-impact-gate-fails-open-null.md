# [High] Price-impact gate fails OPEN when impact is unknown — precisely the worst-impact case

**Labels:** bug, risk-engine
**Severity:** High

## Summary

`evaluateOrderRisk` skips the `IMPACT_TOO_HIGH` check when `estimatedImpact` is `null`. But the engine's impact estimator, `BookState.takerBuyImpact`, returns `null` exactly when the visible book **cannot fill the requested size** — the scenario with the largest possible slippage. Every other unknown input in this evaluator fails closed (null spread → SPREAD_TOO_WIDE, null chainlink age → reject, null clock skew → reject, unknown fee schedule → reject); impact is the one that fails open, in violation of the repo's "fail closed on unknown data" non-negotiable (README:73).

## Locations

- `packages/risk/src/evaluate.ts:224` — `if (ctx.estimatedImpact !== null && ctx.estimatedImpact > L.maxPriceImpact)` — null passes.
- `apps/engine/src/engine.ts:617-619` — impact populated for taker styles from `sideBook.takerBuyImpact(shares6)`; stays `null` if the estimator returns null.
- `packages/strategy/src/book.ts:123-136` — `takerBuyImpact` returns `null` when displayed asks < requested size.
- Contrast: `evaluate.ts:221` (spread), `:230` (data quality), staleness gates — all fail closed.
- Exposure path: `late_snipe_composite_v1` preset is `style: "taker_fak"` (`packages/strategy/src/presets.ts:80`) with `allow_taker: true` shown in `docs/live-trading.md`.

## Failure scenario

Sizing requests 5,000 shares; the visible ask side holds 3,800 shares from 0.95 to 0.99 with `maxPriceImpact = 0.005`.
- `takerBuyImpact(5000e6)` → `null` → gate silently passes → FAK order walks the entire visible ask side up to 0.99.
- Had the book held 5,000 shares, computed impact (~0.02) **would** have been rejected. Thinner books are treated more favorably than thicker ones — inverted incentive.

## Impact

Taker orders larger than displayed depth bypass the only gate bounding execution slippage, in paper and (when armed) live mode. The risk test suite only exercises non-null too-high impact (`packages/risk/test/risk.test.ts:90`), so the hole is untested.

## Suggested direction (not implemented)

For taker styles, `estimatedImpact === null` must reject (e.g., `IMPACT_UNKNOWN`). Maker orders legitimately carry null impact (`engine.ts:592`), so the fail-closed rule must be style-conditional.

---
Found by systematic review (domain/risk sweep); verified against evaluator and book-state null semantics.
