# [Low] `BinanceKlinesPoller`: no re-entrancy guard and no fetch timeout — overlapping polls can overwrite fresh candles with stale ones

**Labels:** bug, feeds
**Severity:** Low

## Summary

`setInterval(() => void tick(), 5000)` starts a new async poll regardless of whether the previous one finished, and the `fetch` has no AbortSignal/timeout. A slow response issued at t0 can resolve **after** a fast response issued at t5, overwriting `this.candles` with older data while stamping the freshness timestamp as now — stale candles that look fresh. Hung requests also accumulate unboundedly during network stalls.

## Locations

- `packages/polymarket/src/binance.ts:59-89`.
- Downstream freshness consumer: `apps/engine/src/engine.ts:462` (`klinesFresh` window) and `:887` (`binance_klines` feed health).

## Failure scenario

Network degradation makes poll A (t0) take 12s while poll B (t5) returns in 1s. Order of completion: B (fresh data), then A (older data) — final state: candles from t0 labeled as updated at t12. Indicators (EMA/RSI/momentum) compute on data up to 12s staler than `candlesUpdatedAtMs` claims, inside the 20s freshness tolerance.

## Impact

Bounded (Binance is diagnostic/confirmation-only per README), but it corrupts exactly the freshness signal that decides whether the composite uses Binance or falls back to Chainlink synthesis (see issue 005).

## Suggested direction (not implemented)

Skip a tick if one is in flight (same `discovering`-style guard used in main.ts), add an AbortSignal timeout < poll interval, and ignore responses older than the last applied one.
