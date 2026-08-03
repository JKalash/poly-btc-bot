# [Medium] Live resting orders have no invalidation/staleness maintenance — and arming-token expiry abandons them on the exchange

**Labels:** bug, live-trading
**Severity:** Medium

## Summary

The spec mandates continuous maintenance of resting maker orders: recompute edge while resting, "if conservative edge disappears, cancel immediately", cancel on staleness/risk stops, confirm cancellations (`polymarket.fable:546-549, 661-663, 681-683`). This exists **only for paper orders**:

- `maintainRestingOrders` (`apps/engine/src/engine.ts:759-779`) iterates `this.paper.ordersForMarket(...)` only.
- The staleness watchdog (`engine.ts:435-443`) calls `paper.cancelAll` only.
- A live GTD post-only order is canceled by exactly: exchange-side expiry, engine halt, or operator disarm. `LiveController.disarm()` itself cancels **nothing** (`live.ts:114-121`) — the engine's disarm *message* handler cancels (`engine.ts:164-170`), but disarm-by-**token-expiry** happens inside `isArmed()` (`live.ts:76-81`) with no cancel path at all.

## Failure scenario

Operator arms for 30 minutes; a maker order rests; edge vanishes (Chainlink moves against the position) — order stays. Or: the arming token expires while an order rests → the system reports DISARMED while a real-money order remains live on the exchange with zero local management, monitoring, or cancellation until GTD expiry (which itself is broken the other way — issue 017).

## Impact

The edge-cancel discipline that makes maker resting tolerable exists only in the simulator; the live path can hold real orders through stale data, vanished edge, and disarm-by-expiry. Complements issues 004/017 without overlapping them.

## Suggested direction (not implemented)

Extend `maintainRestingOrders` and the staleness watchdog to live orders (via `live.cancel(externalId)`); make every disarm path (including expiry) cancel outstanding live orders and verify the cancellation result.
