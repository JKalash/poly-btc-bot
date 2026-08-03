# [Low-Medium] `TickBuffer` never deduplicates; RTDS reconnect backfill double-inserts overlapping ticks, collapsing `medianGapMs` to 0

**Labels:** bug, strategy, feeds
**Severity:** Low-Medium (reproduced by execution)

## Summary

`TickBuffer.push` sorts out-of-order ticks but never drops a tick whose `(sourceTsMs, value)` already exists. RTDS sends a backfill array on every subscribe, so after any WS reconnect the overlap region (buffer retains 10 minutes) is inserted twice. Duplicate zero-gaps then dominate `medianGapMs`.

## Locations

- `packages/strategy/src/ticks.ts:12-27` (`push`), `:139-146` (`medianGapMs`).
- Feeders: `packages/polymarket/src/rtds.ts:96-108` (backfill replay on subscribe), `apps/engine/src/engine.ts:210-213` (unconditional push).

## Reproduced failure

61 ticks at 1/s, then the same 61 replayed → `size = 122`, `medianGapMs = 0`. A genuinely degraded feed (real 5s gaps) still reports a perfect 0ms median cadence for up to 10 minutes after every reconnect. `warmedUp`'s `size >= 10` and `tickTrend`'s length thresholds are also met with half the intended distinct data.

(Verified bounded: `realizedVolBps` is nearly invariant to the duplication — zero-returns halve variance but double the count, canceling — and EWMA vol is essentially unaffected via dt-weighting.)

## Impact

`chainlinkMedianGapMs` — a feed-health feature persisted in every feature snapshot and usable for cadence monitoring — is wrong after every reconnect; degradation monitoring masked exactly when reconnects (the degradation signal) happen.

## Suggested direction (not implemented)

Dedupe on `sourceTsMs` (or `(sourceTsMs, value)`) at push, or have the RTDS adapter skip backfill entries older than the last delivered tick.
