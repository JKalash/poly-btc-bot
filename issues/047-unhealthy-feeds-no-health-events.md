# [Low] Unhealthy feed lamps never generate health events — the health log misses exactly what the cockpit shows red

**Labels:** bug, telemetry
**Severity:** Low

## Summary

`feedHealth()` computes healthy/unhealthy per feed for the cockpit display, but no transition to unhealthy ever writes a `health_events` row. The only feed-related health event in the engine is "Chainlink stale **with resting orders**" (`apps/engine/src/engine.ts:439`). A Binance feed that goes red for hours, a CLOB book lamp stuck unhealthy (see issue 006), or stale klines produce zero entries in the health log — while the same log fills with per-market resolution warnings.

## Locations

- `apps/engine/src/engine.ts:875-889` — `feedHealth()` display computation, no event emission.
- Full inventory of `this.health(...)` call sites (grep): reconcile, live-armed, halt, rules, price_to_beat, chainlink-stale-with-resting-orders, resolution, database — nothing for binance/clob_book/binance_klines transitions.

## Failure scenario

Operator reviews the Health page after an incident: it shows resolution warnings but no record of when the Binance feed died or the CLOB lamp went red — the audit trail cannot reconstruct feed-health history (feed snapshots inside decision snapshots exist only when decisions fire, which is rare by design).

## Impact

Health telemetry is incomplete on exactly the signals the cockpit surfaces as lamps; incident reconstruction relies on operator memory.

## Suggested direction (not implemented)

Emit a health event on each healthy→unhealthy transition (with dedup/hysteresis so flapping doesn't spam — one event per transition, not per step), and one on recovery.

---
Origin: external operator audit (finding 6, "red Binance/CLOB lamps create no health events"). The other half of that finding — 89 duplicate resolution warnings for one market — appears already fixed in this tree by the `resolveWarned` once-per-market guard (`engine.ts:803-806`).
