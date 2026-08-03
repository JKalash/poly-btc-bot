# [Medium] Five audit/persistence tables are write-orphaned — and limitations.md's book-persistence claim is itself false

**Labels:** bug, data-integrity, documentation
**Severity:** Medium

## Summary

Five spec'd persistence entities exist as tables with **zero insert sites** anywhere (grep-verified):

- `orderbook_snapshots` (`packages/db/src/schema.ts:54`)
- `market_trade_ticks` (`:66`) — `GET /api/trades` (`apps/api/src/server.ts:403-406`) reads this forever-empty table
- `fee_schedule_snapshots` (`:90`)
- `constraint_snapshots` (`:103`)
- `probability_estimates` (`:125`)

The decision snapshot stores only best bid/ask plus a top-5 depth aggregate string (`snapshot.ts:84-101`), not the "complete relevant order-book snapshot" the spec requires (`polymarket.fable:712`), and replay "any market tick by tick" (`:829-831`) is impossible for book/trade data.

**The limitation doc is wrong about this:** `docs/limitations.md:21-22` says "books are persisted as periodic snapshots + trade ticks (sufficient for the conservative fill model)" — neither books nor trade ticks are persisted at all; the fill model consumes them in-memory only.

## Failure scenario

Operator (or future backtest tooling) queries `/api/trades` or attempts a replay from recorded data: nothing exists. Post-hoc dispute of a paper fill ("did trades actually print at that price?") cannot be audited — the exact evidence class the conservative fill model's credibility rests on. Fee schedules and market constraints that priced each trade have no dedicated audit trail beyond the JSON embedded in decision snapshots.

## Impact

Advertised auditability/replayability doesn't exist for book-dependent behavior; a documented "what's persisted" statement is false; a retention policy governs data never written.

## Suggested direction (not implemented)

Wire periodic book snapshots + trade tick inserts (both data streams already flow through the engine), or drop the tables/endpoint and correct limitations.md.
