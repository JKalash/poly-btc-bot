# [Low] Data pages conflate error and loading states with genuine empty states — "No orders yet" while the API is down

**Labels:** bug, web-ui
**Severity:** Low

## Summary

`useApi` returns an `error` field that **no consumer reads**; `data === null` (still loading, or a 500) renders the same copy as a legitimately empty table.

## Locations

- `apps/web/lib/hooks.ts:6-21` — `error` exposed, universally dropped.
- `apps/web/app/decisions/page.tsx:20-21` — `!data || data.length === 0` → "No decisions yet".
- `apps/web/app/orders/page.tsx:39,60` — "No orders yet"/"No positions yet".
- `apps/web/app/pnl/page.tsx:22` — permanent "Loading P&L…" on API error.
- `apps/web/app/tutorial/page.tsx:17` — shows "Tutorial data not seeded — run: pnpm db:seed" during initial load and on any fetch error.

## Failure scenario

API returns 500s (e.g., during the issue-028 shutdown race or a DB hiccup). The operator opens Orders and sees "No orders yet" while resting orders exist — reads as "flat", not "blind". Complements issue 030 (swallowed mutations); this is the read-path equivalent.

## Impact

Reassuring empty-state copy masks real system failure from the operator.

## Suggested direction (not implemented)

Render `error` distinctly (banner + retry), and distinguish loading from empty.
