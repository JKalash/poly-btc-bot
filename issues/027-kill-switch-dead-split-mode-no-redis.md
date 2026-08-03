# [High] Kill switch, arm/disarm, resume and config-reload are silently dead in split-process mode without REDIS_URL

**Labels:** bug, safety, deployment
**Severity:** High

## Summary

Split-process mode is gated **only** on `DATABASE_URL` (`scripts/dev.mjs:15,38-39`), but the control channel between API and engine only crosses process boundaries when `REDIS_URL` is set. With `DATABASE_URL` set and `REDIS_URL` unset, both processes call `makeBus()` → `getLocalBus()` — a **per-process** EventEmitter stashed on `globalThis`. Every control publish (kill, resume, arm, disarm, `config_reload`) stays inside the API process and never reaches the engine. Nothing validates or warns about this configuration.

## Locations

- `scripts/dev.mjs:15,38-39` — `embedded = !process.env.DATABASE_URL`; engine spawned as a separate process whenever `DATABASE_URL` is set.
- `apps/api/src/server.ts:415-417` — `makeApiBus()` falls back to `getLocalBus()` without `REDIS_URL`.
- `apps/engine/src/bus.ts:32-34` — engine's `makeBus()` does the same in its own process.
- `apps/api/src/server.ts:332-346` — `/api/kill` inserts a `kill_switch_events` DB row and publishes on the bus, then returns `{ok: true, note: "Emergency stop signaled…"}`.
- `apps/engine/src/engine.ts:119-121,144-151` — kill handling is bus-subscription only; the engine never polls `kill_switch_events`.

## Failure scenario

1. Operator uncomments `DATABASE_URL` in `.env` (per `.env.example`) without setting `REDIS_URL`, runs `pnpm dev`.
2. Dashboard looks fully healthy — cockpit state is served from the DB (`engine_kv`) via `/api/state` polling, which masks the dead cross-process relay.
3. Operator presses EMERGENCY STOP → API writes the DB row and returns success → **engine keeps trading**. Same silent no-op for disarm (which is supposed to cancel live orders) and config reload.

## Impact

The primary safety control reports success while doing nothing, in a configuration reachable through the shipped scripts and example env file. This is the worst failure mode a kill switch can have.

## Suggested direction (not implemented)

Fail fast at startup when split-process mode lacks a cross-process bus (refuse to start, or force embedded mode); and/or make the engine poll `kill_switch_events` as a DB-backed fallback so kill works regardless of bus health (also covers issue 011's Redis-outage case).
