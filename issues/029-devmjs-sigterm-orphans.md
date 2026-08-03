# [Medium] dev.mjs handles SIGINT only — SIGTERM orphans the API/engine/web children (collector path)

**Labels:** bug, deployment
**Severity:** Medium

## Summary

`dev.mjs` registers a handler for SIGINT only. `collector.sh` runs `exec pnpm dev` under launchd, whose stop path (and any plain `kill <pid>`) sends **SIGTERM**. Node's default SIGTERM handling terminates `dev.mjs` without killing the spawned `api`/`web`/`engine` children, which survive as orphans.

## Locations

- `scripts/dev.mjs:42-45` — only `process.on("SIGINT", ...)`.
- `scripts/collector.sh:8` — `exec pnpm dev` under launchd supervision.

## Failure scenario

1. `kill <dev.mjs pid>` (or launchd stop without a process-group sweep) → dev.mjs dies; the API (with embedded engine, holding the PGlite directory lock) and web keep running orphaned.
2. Launchd restarts the collector → a second API/engine starts against the same PGlite dir → startup failure, or the "duplicated engine process" hazard the threat model explicitly calls out (two engines writing the same tables).

## Impact

Orphaned trading/collection processes; possible double-engine writes to one database.

## Suggested direction (not implemented)

Register the same shutdown handler for SIGTERM (and SIGHUP); consider `detached: false` + killing the process group, so children die with the runner.
