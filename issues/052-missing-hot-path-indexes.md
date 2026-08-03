# [Low-Medium] Missing indexes on every hot dashboard query path; `/api/pnl/summary` scans all of `markets` per poll

**Labels:** bug, db, performance
**Severity:** Low-Medium (degrades steadily over runtime)

## Summary

Every dashboard list endpoint runs `ORDER BY <ts> DESC LIMIT n` with no index whose leading column serves the sort, and `/api/pnl/summary` executes an **unbounded** `select id, end_epoch from markets` on every call (dashboard polls it every 10s; other tabs poll every 5s).

## Locations

- `packages/db/src/schema.ts:206-209` (orders: only `market_id`, `status`), `:238-241` (positions: no `opened_at_ms`), `:160-162` (decision_snapshots: composite `(market_id, created_at_ms)` can't serve plain `ORDER BY created_at_ms`), `:253-255`, `:112-114` (market_trade_ticks), `:268-270` (pnl_records: `(mode, created_at_ms)`).
- Consumers: `apps/api/src/server.ts:141,169,176,183,191-193,406`; the unbounded markets select at `:193`.
- Migrations 0000/0001 confirm no such indexes exist.

## Failure scenario

24/7 collector: `markets` grows ~288 rows/day (~105k/yr); `market_trade_ticks` reaches millions. Each poll triggers full-table top-N sorts on PGlite/Postgres — in embedded mode, on the same connection and CPU as the trading engine (compounding issue 010's in-memory growth and the documented PGlite contention rough edge).

## Impact

Dashboard latency and engine-shared CPU degrade without bound; `/api/trades` worst.

## Suggested direction (not implemented)

Add descending timestamp indexes for the hot lists; bound the markets select (only unresolved/recent markets are needed for the open-position end-epoch join).
