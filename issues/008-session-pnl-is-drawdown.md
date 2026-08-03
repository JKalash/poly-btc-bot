# [Medium] Dashboard "Session P&L" actually shows drawdown-from-peak — it can never be positive

**Labels:** bug, web-ui
**Severity:** Medium

## Summary

The shell header's "Session P&L" is computed as `bankroll − sessionPeak`. Since `sessionPeak` is a ratcheting high-water mark seeded at session start and raised on every gain (`accounting.ts:179`), this difference is ≤ 0 by construction. A profitable session forever displays `+0.00`; the number only moves when under water, where it shows drawdown from the peak, not session profit.

## Locations

- `apps/web/components/Shell.tsx:112` — `const sessionPnl = s ? Number(s.bankroll.bankroll6) - Number(s.bankroll.sessionPeak6) : 0;`
- `apps/web/components/Shell.tsx:149-151` — rendered as "Session P&L" with green/red coloring; the `> 0` green branch is unreachable.
- `apps/engine/src/accounting.ts:69,179` — `sessionPeak` initialized to the starting bankroll and only ever ratcheted upward.
- Note the engine-side field is honestly named `sessionRealized` as a *drawdown* input for the session-loss stop (`accounting.ts:93`, consumed in `packages/risk/src/evaluate.ts` budget caps) — the bug is presenting that risk metric as P&L.

## Failure scenario (observed)

A session with one winning trade (+4.75 USDC) shows "Session P&L +0.00" for the rest of the session (bankroll == new peak). An operator reviewing a live/paper session cannot see realized session profit anywhere in the header, and a `+0.00` after a winning trade reads as "the trade didn't book".

## Impact

- Core operator-facing P&L number is wrong in the positive half of its range; correct-looking in the negative half — the worst kind of wrong (plausible).

## Suggested direction (not implemented)

Session P&L should be `bankroll − session starting bankroll` (`tradingSessions.startingBankroll6`, already persisted, and `realized6` is already maintained in `accounting.ts:207`). Show drawdown-from-peak separately, labeled as such.
