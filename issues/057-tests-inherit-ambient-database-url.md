# [Medium] Test suites inherit ambient DATABASE_URL — `pnpm test` migrates and writes to whatever database the shell points at

**Labels:** bug, tests, data-integrity
**Severity:** Medium

## Summary

The engine (and other) test suites construct their DB via `makeDb()`, which selects real Postgres whenever `DATABASE_URL` is set in the environment — there is no test-scoped override or guard. Observed directly in this review environment: `pnpm test` → 14 engine test failures with `connect ECONNREFUSED 127.0.0.1:5432` (ambient `DATABASE_URL` pointing at an unrelated database); with `DATABASE_URL=` cleared, the full suite passes on embedded PGlite.

## Locations

- `apps/engine/test/live.test.ts:11` (and sibling tests) — `makeDb()` with no env isolation; stack: `packages/db/src/client.ts:47` (`migratePg`).
- `packages/db/src/client.ts` — `makeDb()` chooses pg purely from `process.env.DATABASE_URL`.

## Failure scenario

1. **Annoying case (observed):** any machine with `DATABASE_URL` set to an unreachable/foreign DB → `pnpm test` fails with connection errors; looks like broken tests.
2. **Dangerous case:** operator runs `pnpm test` in a shell configured for the canonical deployment (`.env` loaded, `DATABASE_URL` → the production Postgres). Tests run `db.migrate()` and then **insert orders, positions, markets, and kill-switch events into the production database**, contaminating the collector's real data (compounding issue 049's seed contamination).

## Impact

Test isolation depends on shell hygiene; the failure direction is either false-red CI or silent production-data contamination.

## Suggested direction (not implemented)

Force PGlite (temp dir) in test setup regardless of ambient env (e.g., `delete process.env.DATABASE_URL` in a vitest setup file, or an explicit `makeDb({ forceEmbedded: true })` for tests).
