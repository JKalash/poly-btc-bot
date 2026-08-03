# [Low] POST /api/config read-modify-write race can leave two `active=true` config versions

**Labels:** bug, api, config
**Severity:** Low (race confirmed; single-operator likelihood low)

## Summary

The config-update handler selects the active row, deactivates it, and inserts a new active row in three separate statements with **no transaction**. Concurrent posts (double-click, two tabs, slow embedded PGlite) can both read the same "current" and both insert `active: true`. There is no partial unique index enforcing "exactly one active".

## Locations

- `apps/api/src/server.ts:304-328` — non-transactional select → update → insert.
- `packages/db/src/schema.ts:311-318` — `config_versions` has no unique constraint on `active`.
- `GET /api/config` picks `rows.find(r => r.active)` over the newest 20 — nondeterministic when two are active; the engine's `loadConfig` (`apps/engine/src/engine.ts:125-138`) sorts by version among active rows, which may disagree with the API's pick.

## Failure scenario

Operator double-submits the config form during a slow moment → two active versions; subsequent diffs are computed against the wrong baseline; API and engine can disagree about which config is in force.

## Impact

Config-versioning invariant violated; confusing but recoverable.

## Suggested direction (not implemented)

Wrap in a transaction; add a partial unique index (`UNIQUE ... WHERE active`); have readers order deterministically by version.
