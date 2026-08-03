# [Low-Medium] `/api/pnl/summary` computes equity curve, max drawdown and loss streak over a silently truncated 2000-row window

**Labels:** bug, api, statistics
**Severity:** Low-Medium (impact grows with history length)

## Summary

P&L records are fetched `desc` with `limit(2000)`, reversed, and the equity/peak/drawdown/streak recursion starts at `equity = 0n` from the oldest of those 2000. Once more than 2000 records exist, every derived metric is computed over a suffix of history with no truncation indicator.

## Locations

- `apps/api/src/server.ts:189-236`.

## Failure scenario

A long-running paper collection (~months at dozens of resolved markets/day) crosses 2000 pnl records:
- byMode totals, win counts, and "Resolved trades" silently cap;
- max drawdown / longest loss streak reflect only the retained suffix — a historically larger drawdown quietly disappears from the risk page;
- `openPositions` counts only the newest 2000 position rows.

## Impact

The P&L Analytics page understates worst-case history exactly when a meaningful track record finally exists — the moment those numbers start mattering for go-live decisions.

## Suggested direction (not implemented)

Aggregate in SQL over the full table (SUM/COUNT/GROUP BY, and a windowed running-max for drawdown), or at minimum surface "showing last N records" in the response and UI.
