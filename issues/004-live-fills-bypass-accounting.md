# [High] Live positions/fills bypass the accounting layer: exposure hardcoded 0, resting-fill wins counted as losses, dashboard cannot certify zero live exposure

**Labels:** bug, live-trading, accounting
**Severity:** High

## Summary

The live path records orders in the DB but is not integrated with the `Accounting` position/P&L pipeline that the risk engine and dashboard rely on. Four concrete defects follow.

## Defects and locations

1. **`openExposure` hardcoded to `0n` while live-armed.**
   `apps/engine/src/live.ts:145` — `bankState()` returns `openExposure: 0n`. The risk engine's `available_balance` cap is `bankroll − openExposure` (`packages/risk/src/evaluate.ts:137`), so between a live fill and the next 30-second balance refresh (`engine.ts:364-367`), open live exposure is invisible to sizing.

2. **Fills on resting live maker orders are never recorded.**
   `apps/engine/src/live.ts:231-243` — a fill row is written only when the submission returns immediately `MATCHED`. A GTD post-only order that rests and fills later has no user-channel WS subscription and no polling; `orders.filledShares6` stays `0`.

3. **Consecutive-loss stop gets wrong inputs → wins counted as losses.**
   `apps/engine/src/engine.ts:827-831` — at resolution, `wonSide` is derived from live orders with `filledShares6 > 0n`. Because of (2), a resting maker order that filled and *won* yields `wonSide === undefined` → `markClosed(marketId, false)` → `consecutiveLosses += 1` (`live.ts:152-155`). Two winning resting fills in a row trip the consecutive-loss stop; conversely real losses on unrecorded fills produce no P&L record at all.

4. **Dashboard "positions/P&L" covers paper only.**
   `apps/engine/src/engine.ts:966-968` — `cockpitState.openPositions` comes from `this.accounting.openPositionsList()`; live fills never call `accounting.onFill`. A dashboard showing "0 positions" cannot certify zero real exposure on a live-configured deployment.

## Failure scenario

Arm live with a maker-only strategy (the default: `maker_only: true`). Every fill that ever happens on such a deployment arrives via a resting order → 0 fills recorded, positions page empty, wins increment the loss counter, P&L exists only as unexplained wallet-balance drift.

## Impact

Live-mode risk stops (consecutive-loss, exposure-aware sizing) operate on wrong data; audit trail (fills, positions, pnl_records) is silent for exactly the order style the strategy defaults to; UI gives false "no exposure" assurance.

## Suggested direction (not implemented)

Subscribe to the CLOB user channel (or poll order status / trade history) for live fills; route live fills through `Accounting` (or a parallel live ledger feeding the same interfaces); compute `openExposure` from recorded live stakes; derive win/loss from recorded fills only, and treat "no recorded fill" as "unknown", not "loss".
