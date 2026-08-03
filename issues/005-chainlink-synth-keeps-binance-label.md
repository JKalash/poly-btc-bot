# [Medium] Indicator/model provenance mislabeled: Chainlink-synthesized candles silently keep the "binance_composite" label

**Labels:** bug, provenance
**Severity:** Medium

## Summary

When Binance 1s klines are stale (>20s) or absent, the engine silently synthesizes candles and momentum ticks from the Chainlink stream, but the model identity, decision snapshots, and UI continue to say "Binance composite" (`binance_composite_v1_UNCALIBRATED`). The recorded provenance of every such decision is wrong.

## Locations

- `apps/engine/src/engine.ts:458-468`:
  ```ts
  const klinesFresh = this.candlesUpdatedAtMs > 0 && nowMs - this.candlesUpdatedAtMs < 20_000;
  const candles1s = klinesFresh && this.candles.length > 0 ? this.candles : synthCandlesFromTicks(this.chainlink, nowMs);
  const momentumTicks = klinesFresh ? this.binance : this.chainlink;
  ```
  No flag records which source was used; `FeatureSet.indicators` carries no source field.
- `packages/strategy/src/models.ts:134` — model version stays `binance_composite_v1_UNCALIBRATED` regardless.
- `apps/engine/src/snapshot.ts:119-130` — the immutable decision snapshot stores `model.version` with no candle-source provenance.
- Note: Binance blocks US IPs with HTTP 451 (comment at `engine.ts:459`), so on US-hosted deployments the fallback is the *common* case, not the exception.

## Failure scenario

A deployment in a US region can never fetch Binance klines. Every decision's snapshot and the dashboard model field claim Binance-derived indicators; research later "validates" the Binance composite using decisions whose indicators were actually Chainlink-synthesized with `volume=0` (volume-surge indicator silently degraded to null).

## Impact

- Decision snapshots — the system's core audit artifact — record false provenance.
- Model comparison / calibration research over these snapshots is contaminated (two different feature distributions under one model version label).

## Suggested direction (not implemented)

Record `candleSource: "BINANCE_KLINES" | "CHAINLINK_SYNTHETIC"` in `IndicatorBlock`/`FeatureSet` and the decision snapshot; surface it in the UI; optionally suffix the effective model version.
