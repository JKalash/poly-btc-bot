# [High] Most spec'd automatic halt conditions are never wired to `halt()` — the engine trades through integrity failures it promised to stop on

**Labels:** bug, safety, spec-gap
**Severity:** High

## Summary

The spec (`polymarket.fable:988-1015`) lists ~15 automatic halt conditions and an on-halt sequence ("reconcile; do not assume cancellation succeeded"). `halt()` has exactly **three** trigger sites: kill switch (`engine.ts:149`), resolution mismatch (`:843`), tick-persistence DB failure (`:870`). Verified absent (each traced):

- **Clock drift** → rejection only (`evaluate.ts:165`); never halts, never cancels resting orders.
- **Sequence gap** → nothing tracks sequence continuity; the CLOB book `hash` field is parsed and discarded (`clob-ws.ts:21,35`); RTDS has no seq tracking.
- **Duplicate market identity** → no check in `upsertDiscoveredMarkets` (`engine.ts:259-341`).
- **Wallet balance mismatch** → `refreshBankroll` (`live.ts:123-133`) disarms only on *unreadable*; no expected-vs-actual comparison exists.
- **Local vs exchange order-state divergence / unknown open order** → no live reconciliation at all (halt obligations beyond issue 004's accounting scope).
- **Repeated submission error** → a permanently failing live submit retries every 5s forever (`engine.ts:723-733`, `DECISION_COOLDOWN_MS`), logged, never halts.
- **Fee schedule changed while armed** → fee captured once at discovery (`engine.ts:262` — `if (existing) continue`), never re-read or compared.
- **Risk-limit breach at fill time** → over-cap fill is truncated with `logger.error` only (`paper.ts:244-247`); no halt, no health event.
- **On-halt sequence**: `halt()` ignores `live.cancelAll()` failure (`catch(() => 0)`, `engine.ts:195`) contrary to "do not assume cancellation succeeded"; `resume` (`engine.ts:172-180`) transits through the RECONCILING state label without reconciling anything.

## Impact

The fail-closed machine the spec describes is mostly a fail-open machine with good logging. The three implemented halts cover a fraction of the promised protection, and recovery skips the mandated reconcile.

## Suggested direction (not implemented)

Wire each condition to `halt()` (or a per-market entry block where market-scoped); verify cancelAll results; make resume perform the reconcile it names.
