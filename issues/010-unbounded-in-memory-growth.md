# [Medium] Unbounded in-memory growth on 24/7 runs: markets, books, paper orders and idempotency keys are never pruned

**Labels:** bug, reliability
**Severity:** Medium

## Summary

Four engine collections grow monotonically for the life of the process. With a new market every 5 minutes (288/day, 2 tokens each) plus per-market runtime state, a 24/7 collector (the deployment target per `docs/deploy.md`, Fly VM) degrades steadily: every `step()` iterates all of them.

## Locations

- `apps/engine/src/engine.ts:59` — `markets: Map<string, MarketRuntime>`: entries added in `upsertDiscoveredMarkets`, never deleted. Iterated every 500ms step by `captureBoundaries` (line 396), `resolveDue` (line 784), `activeMarket`/`nextMarket`, and `subscriptionTokens`.
- `apps/engine/src/engine.ts:58,238-242` — `books: Map<string, BookState>`: one per token ever subscribed, never deleted (also the root cause of the stale feed-health lamp, issue 006). Each holds full level maps.
- `apps/engine/src/paper.ts:61` — `PaperExecutor.orders`: every paper order ever created stays in the map; `ordersForMarket`/`restingOrders`/`onTrade` scan all of them on every step/trade event.
- `apps/engine/src/engine.ts:69` — `usedIdempotencyKeys: Set<string>` only grows (see issue 007 — it also never matches anything).
- `MarketRuntime.lastEval` (engine.ts:43) pins the full `FeatureSet` (with indicator arrays) for every historical market, so each retained market is not small.

## Failure scenario

Run the collector for a week (spec'd use case: "gap-free 24/7 collection"): ~2,000 markets, ~4,000 book states, thousands of orders retained; `resolveDue` re-scans every unresolvable historical market each 500ms step forever (markets that never got boundary data keep `localOutcome === null` and are re-visited each step for the life of the process). Memory climbs and step latency drifts up until the VM (256–512MB on Fly) OOMs or the loop slows past the 500ms budget.

## Impact

- Slow memory leak + O(total-history) work per step on the exact deployment profile the project targets (always-on collection).
- `docs/limitations.md` acknowledges missing DB retention jobs but not this in-process growth.

## Suggested direction (not implemented)

Evict market runtimes, book states, and paper orders some safe interval after resolution/reconciliation (they are all persisted in the DB); stop scanning markets older than N windows in `resolveDue`.
