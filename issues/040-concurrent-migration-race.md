# [Low] Concurrent first-boot migration race in split-process mode

**Labels:** bug, db, deployment
**Severity:** Low
**Confidence:** likely (depends on drizzle 0.38 pg migrator locking; it wraps migrations in a transaction but takes no advisory lock in this version line — needs-check)

## Summary

With Postgres, both the API and the engine unconditionally run `db.migrate()` at startup, and `dev.mjs` starts them simultaneously. On an unmigrated database both can attempt migration `0000` concurrently; one crashes with "relation already exists", which the dev.mjs child-exit handler escalates into tearing down the whole stack.

## Locations

- `scripts/dev.mjs:38-39` — api and engine spawned together.
- `apps/api/src/main.ts:22-24`, `apps/engine/src/main.ts:19-20` — both call `db.migrate()`.
- `packages/db/src/client.ts:47`.

## Failure scenario

Fresh Postgres + `pnpm dev` (skipping `pnpm bootstrap`) → intermittent first-start crash of the entire stack; a retry succeeds, masking the cause as "flaky".

## Impact

Flaky first boot only; no data risk.

## Suggested direction (not implemented)

Take a Postgres advisory lock around migration, or migrate only in one process (API) and have the engine wait/verify schema version.
