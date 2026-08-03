# [Medium] `computeIndicators` treats the last candle as "now" and candle indices as seconds — no staleness or gap handling; engine feeds it klines up to 20s old

**Labels:** bug, strategy, indicators
**Severity:** Medium

## Summary

`computeIndicators` receives `nowMs` but uses it only for `tickTrend`. `windowDeltaPct`, `microMomentumPct`, and `accelerationPct` are computed from the last candle's close and pure index offsets (`end − secondsBack`), assuming (a) the last candle ends at `nowMs` and (b) candles are contiguous 1-second bars. Nothing validates the last candle's `openTimeMs` against `nowMs`, and Binance omits zero-trade 1s klines, so both assumptions fail in practice. The engine tolerates klines up to 20s old (`klinesFresh < 20_000`, 5s poll cadence).

## Locations

- `packages/strategy/src/indicators.ts:100-124`.
- Call site: `apps/engine/src/engine.ts:462-469`.

## Failure scenario

Klines last refreshed at T−19s (two-three poll failures within tolerance). Price was +0.08% since window open as of T−19s, then reversed to −0.05% by T−10s. At T−10s — inside the late-snipe 5–30s entry window whose entire premise is precision timing — the composite reports `windowDeltaPct ≈ +0.08` and "momentum over the last 30s" that actually ended 19s ago, direction UP with high confidence. If the Chainlink distance hasn't crossed yet, `chainlink_confirmation` passes and a paper taker entry fires on a 19-second-old picture, seconds before a DOWN resolution.

## Impact

- The late-snipe preset can enter on stale momentum (paper/shadow only today — but that's exactly the data intended to become the calibration corpus).
- Persisted `IndicatorBlock` features are mislabeled (windows silently shifted/stretched by gaps), poisoning future calibration built from feature snapshots.

## Suggested direction (not implemented)

Index candles by timestamp, not array offset; return null (degrade) when the last candle is older than a threshold or when the window has gaps beyond a tolerance.
