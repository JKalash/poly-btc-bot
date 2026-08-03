# [High] Restarting with an open paper position corrupts the bankroll (position cost resurrected, fees dropped)

**Labels:** bug, accounting
**Severity:** High

## Summary

`Accounting` persists the bankroll **only at resolution** (`bankroll_snapshots` insert exists solely in `onResolution`). Fills deduct cost+fees from the in-memory bankroll but never snapshot it. If the engine restarts between a fill and the market's resolution, `reconcile()` restores the **pre-fill** bankroll from the last snapshot *and* restores the open position — so when the position later resolves, the payout is added to a bankroll that never paid for the position.

## Locations

- `apps/engine/src/accounting.ts:130-131` — `onFill` mutates `this.bankroll -= cost6 + args.fee6` (memory only).
- `apps/engine/src/accounting.ts:200-205` — the only `bankrollSnapshots` insert, in `onResolution` (`basis: "paper_resolution"`). Verified by grep: no other insert site.
- `apps/engine/src/accounting.ts:65-71` — `reconcile()` sets `this.bankroll` from the latest snapshot and separately restores OPEN positions.
- `apps/engine/src/accounting.ts:59` — restored positions get `fees6: 0n` (fees are not persisted on the `positions` row), so post-restart `pnlRecords.fees6`/`net6` omit real fees.

## Failure scenario (concrete)

1. Bankroll snapshot exists at 1000.00 USDC.
2. Maker order fills: cost 95.00 + fee 0 → in-memory bankroll 905.00; position OPEN.
3. Engine restarts (deploy, crash, Fly migration). `reconcile()` loads bankroll = **1000.00** (last snapshot) and the OPEN position.
4. Market resolves as a win: `bankroll += payout (100.00)` → **1100.00**, snapshot written.
   - Correct value: 1005.00. The books are now permanently inflated by 95.00.
   - On a loss the bankroll shows 1000.00 instead of 905.00 — the loss vanishes.

## Impact

- Paper P&L, session/daily peaks, drawdown stops (`session_loss_limit`, `daily_loss_limit`) and Kelly sizing all run off a corrupted bankroll after any restart with an open position. On a 24/7 collector with periodic deploys this happens routinely.
- The repo's core promise ("impossible to confuse a lucky win with a good decision", auditable exact accounting) is violated silently.
- Secondary: restored positions lose `fees6`, so their eventual `pnl_records.net6` overstates profit by the fee amount.

## Suggested direction (not implemented)

Snapshot the bankroll on every fill (basis `"paper_fill"`), or derive the reconciled bankroll as `latest_snapshot − Σ(open position cost+fees since snapshot)`; persist `fees6` on the positions row.
