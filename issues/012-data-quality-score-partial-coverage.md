# [Low] `dataQualityScore` measures only Chainlink + UP book + price-to-beat + warmup, but is presented as overall data quality

**Labels:** bug, telemetry
**Severity:** Low

## Summary

The multiplicative `dataQualityScore` — displayed in the cockpit as "Data quality" and gated at `MIN_DATA_QUALITY = 0.7` — never looks at the DOWN book or the Binance feed. A "96%" score is read by operators as global feed health while half of the order-book inputs and the confirmation feed are unmeasured.

## Locations

- `packages/strategy/src/features.ts:120-126`:
  ```ts
  let quality = 1.0;
  if (clAge === null || clAge > inp.chainlinkMaxAgeMs) quality *= 0.2;
  else quality *= 1 - Math.min(0.3, clAge / (inp.chainlinkMaxAgeMs * 4));
  if (bookAge === null || bookAge > inp.bookMaxAgeMs) quality *= 0.5;   // bookAge = UP book only (line 117)
  if (inp.priceToBeat === null) quality *= 0.1;
  if (!warmedUp) quality *= 0.5;
  ```
- `packages/strategy/src/features.ts:117` — `bookAge = inp.upBook.ageMs(nowMs)`; `downBook` is used for features but not for quality.
- Consumed as a risk gate in `apps/engine/src/engine.ts:584-585` (`MIN_DATA_QUALITY`, engine.ts:50) and displayed in the cockpit (`engine.ts:958`).

## Failure scenario

DOWN book stale/empty (e.g., one-sided WS subscription hiccup) while UP book is fresh: features derived from the DOWN book (`downBestBid/Ask`, complement consistency) are stale, a DOWN-side decision can be evaluated, yet "Data quality" shows ~0.96 and the quality gate passes. (The per-side book age check in the risk context covers the *chosen* side's best-bid/ask staleness at decision time, but the score shown to the operator and stored in snapshots remains misleadingly high; Binance staleness never affects it despite the composite model consuming Binance-derived indicators — see issue 005.)

## Impact

- Operator-facing and snapshot-recorded "data quality" overstate coverage; degraded DOWN-book or Binance conditions are invisible in the one number people actually watch.

## Suggested direction (not implemented)

Include worst-of(UP, DOWN) book age; include Binance/kline freshness when the active model consumes those indicators; or rename the metric to reflect what it measures.
