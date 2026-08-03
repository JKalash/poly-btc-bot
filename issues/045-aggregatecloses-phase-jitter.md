# [Low] `aggregateCloses` buckets align to the array start, not wall-clock — EMA-cross and RSI jitter as the buffer rolls

**Labels:** bug, strategy, indicators
**Severity:** Low

## Summary

Chunking with `for (i = 0; i < n; i += seconds)` makes 5s/15s bucket boundaries a function of where the rolling candle buffer happens to begin. Both real sources roll continuously (Binance "last 600" klines re-fetched every 5s with poll jitter; synth candles start at the first tick of an evicting 10-minute buffer), so the same market history produces different `closes5s`/`closes15s` partitions on consecutive evaluations. `emaCrossSignal` can flip sign near zero and `rsi` fluctuates purely from re-bucketing; the final partial chunk (1–4 candles standing in for a 5s bar) adds further asymmetry.

## Locations

- `packages/strategy/src/indicators.ts:72-79` (`aggregateCloses`), consumers `:126-134`.

## Failure scenario

Flat-ish tape where EMA9−EMA21 on 5s closes sits at ±0.5bp: the `emaCross` composite term oscillates between +0.1 and −0.1 across consecutive seconds with no price change — ±0.01 noise in the composite (weight 1/11) and non-reproducible recorded `rsi` values.

## Impact

Nondeterministic indicator features: the same underlying market data does not reproduce the same persisted indicator values, which undermines calibration research reproducibility. Trading impact bounded by the low weight.

## Suggested direction (not implemented)

Align buckets to wall-clock epochs (`openTimeMs % (seconds*1000) === 0` boundaries) and drop the leading/trailing partial buckets.
