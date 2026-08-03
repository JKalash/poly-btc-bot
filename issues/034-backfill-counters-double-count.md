# [Low] Backfill progress counters double-count on errors; DB insert failures are silently swallowed

**Labels:** bug, research
**Severity:** Low

## Summary

Inside the backfill worker, `scanned++` occurs after the Gamma fetch inside the `try`; if `parseFiveMinMarket`, `resolvedOutcome`, or the DB insert then throws, the `catch` increments `scanned` **again** for the same slot — and `found++` may already have counted a row that was never written. `scanned` can exceed `total`, `found` overstates ingested rows, and DB errors produce no health event.

## Locations

- `apps/research/src/backfill.ts:41-71`.

## Failure scenario

A transient PGlite/Postgres error mid-refresh → Timing Lab progress shows "scanned 310/300, resolved found 120" while fewer rows were stored; `runTimingStats` then runs on the silently incomplete set with no warning, and the operator trusts the resulting minute-of-hour statistics.

## Impact

Misleading ingestion accounting; silent partial backfills feeding the Timing Lab.

## Suggested direction (not implemented)

Increment `scanned` exactly once per slot (e.g., in `finally`), count `found` only after a successful insert, and surface insert errors (health event or per-run error counter).
