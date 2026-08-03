# [High] `mapResponse` classifies "unmatched"/unknown CLOB statuses as accepted LIVE orders — phantom live positions that lock out trading

**Labels:** bug, live-trading
**Severity:** High

## Summary

The live adapter's response mapper treats any response carrying *any* status string as an accepted order, and any status it doesn't recognize as `"LIVE"`. The CLOB's documented placement statuses include `unmatched` (FOK/FAK killed without a fill): `{success: true, status: "unmatched"}` becomes `accepted: true, status: "LIVE"`.

## Locations

- `packages/polymarket/src/live.ts:221-234`:
  ```ts
  const ok = resp?.success !== false && (resp?.orderID || resp?.orderId || resp?.status);
  const status = String(resp?.status ?? (ok ? "LIVE" : "REJECTED")).toUpperCase();
  const norm = status === "MATCHED" ? "MATCHED" : status === "LIVE" ? "LIVE" :
               status === "DELAYED" ? "DELAYED" : ok ? "LIVE" : "REJECTED";
  ```
  Note also `resp?.success !== false` treats a *missing* success field as success.
- Consumers: `apps/engine/src/live.ts:219-245` (records order status), `apps/engine/src/engine.ts:723-727` — `res.ok` → `live.markOpen(marketId)` and market transitions to RESTING/FILLED.

## Failure scenario

1. Armed FOK taker order is killed unfilled (`status: "unmatched"`).
2. Adapter reports `accepted: true, status: "LIVE"`; LiveController persists the order as LIVE; engine calls `markOpen` and transitions the market to RESTING.
3. With `max_open_positions: 1`, the phantom "open position" blocks every further entry; no order-status polling exists to ever reconcile it. Live accounting believes an order rests that does not exist.

## Impact

Real-money state divergence plus a trading lockout for the remainder of the session (the phantom market never resolves a position, and `markClosed` runs only through the resolution path). Combined with issue 004 (no fill tracking), the live order lifecycle is unreliable end-to-end.

## Suggested direction (not implemented)

Map statuses by allowlist (`matched|live|delayed` accepted; everything else — including `unmatched` — rejected with the raw status preserved in `reason`), and require `success === true` explicitly.
