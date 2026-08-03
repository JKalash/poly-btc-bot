# [Medium-Low] `windowDeltaPct` silently rebases to the first available candle when history doesn't reach window open

**Labels:** bug, strategy, indicators
**Severity:** Medium-Low (reproduced by execution; realistic trigger is engine restart mid-window)

## Summary

`candles1s.find((c) => c.openTimeMs >= windowStartMs)` has no upper bound on how far **after** window open the matched candle may be. If the candle buffer begins after the window opened, every candle matches and `candles1s[0]` is silently used: the dominant composite indicator (weight 6 of 11) measures "move since buffer start", not "move since window open", with no flag.

## Locations

- `packages/strategy/src/indicators.ts:106-110`.
- Trigger path: `apps/engine/src/engine.ts:463-465` — synth candles from the Chainlink tick buffer, which retains 10 min but starts empty on process start; warmup requires only 120s of ticks while a window is 300s.

## Reproduced failure

Window opened 290s ago; candles cover only the last 60s during which price fell steadily → `windowDeltaPct = −0.092`, `direction = DOWN`, `confidence = 0.69` — even though the true since-open move could be strongly positive. Realistic trigger: engine restart mid-window on the synth-candle path.

## Impact

Composite confidence/direction computed over the wrong baseline right after restarts; Chainlink confirmation limits order-fire risk to blocking correct entries or over-confirming coincidentally-matching ones; the mislabeled `windowDeltaPct` is persisted into feature snapshots used for calibration research.

## Suggested direction (not implemented)

Require the matched candle to be within a small tolerance of `windowStartMs` (e.g., ≤2s); return null otherwise so the composite degrades explicitly.
