# [Low] `clampLimit` accepts fractional limits and produces `LIMIT 0` — list endpoints return empty instead of erroring

**Labels:** bug, api
**Severity:** Low

## Summary

`?limit=0.5` passes the guard (`Number.isFinite(n) && n > 0`), then `Math.floor(0.5)` → `0` → drizzle `.limit(0)` returns zero rows. Every list endpoint (`/api/markets`, `/api/orders`, `/api/audit`, …) silently returns an empty array for fractional limits below 1, indistinguishable from "no data".

## Locations

- `apps/api/src/server.ts:419-422`:
  ```ts
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(500, Math.floor(n)) : dflt;
  ```

## Failure scenario

A client (or a hand-typed curl) sends `limit=0.9` → `[]` with HTTP 200. The caller concludes the table is empty.

## Impact

Minor API-contract wart; confuses clients rather than breaking safety.

## Suggested direction (not implemented)

Floor before the `> 0` check (`const n = Math.floor(Number(v)); n >= 1 ? ... : dflt`), or 400 on non-integer limits.
