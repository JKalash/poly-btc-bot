# [Medium] Seeded tutorial trade is counted as a real paper result in P&L analytics, orders and positions

**Labels:** bug, data-integrity
**Severity:** Medium

## Summary

The tutorial seed inserts a fabricated winning trade with `mode: "paper"` into `orders`, `order_fills`, `positions`, `resolutions`, and `pnl_records` (`net6: 39_160_325n`). The tutorial marker exists only inside jsonb (`meta.tutorial`, `statusReason`), which **no query filters on**. `/api/pnl/summary` aggregates all `pnl_records`; `/api/orders` and `/api/positions` list the rows verbatim. Seeding is part of the standard bootstrap (`pnpm bootstrap`, `docs/deploy.md`, the compose `seed` service), so every deployment starts contaminated.

## Locations

- `apps/research/src/seed.ts:186-226` — paper-mode order/fill/position/resolution/pnl rows.
- `apps/api/src/server.ts:189-236` (`/api/pnl/summary`), `:166-178` (orders/positions) — no seed/tutorial filter.
- `apps/web/app/pnl/page.tsx:28` — card claims "paper results never mix with live" (nor, implicitly, with fiction).

## Failure scenario

Fresh deployment, zero real trades: `/pnl` shows paper 1 trade, 100% win rate, net +39.16; closing-minute bucket ":40" shows 1/1 wins; Orders/Positions list an 839-share MATCHED order with no tutorial marker. The fake row stays inside the 2000-row analytics window until 2000 real records exist.

## Impact

The operator's primary strategy-performance readout starts permanently skewed by a fabricated win — the exact "lucky win ≠ good decision" confusion the tutorial teaches against. (Timing Lab is clean: its seed rows carry `source: "seed"`.)

## Suggested direction (not implemented)

Add a `source`/`is_seed` column (or dedicated tutorial mode) to trading tables and filter it out of every analytics/list endpoint; or stop seeding trading tables and keep the tutorial entirely in its own namespace.
