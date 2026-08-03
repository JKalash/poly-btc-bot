# [High] Live GTD maker orders omit Polymarket's mandatory 1-minute expiration buffer — live maker flow is effectively broken

**Labels:** bug, live-trading
**Severity:** High
**Confidence:** likely (code defect unambiguous vs the documented API contract; exact server response — reject vs early kill — needs one live check)

## Summary

Polymarket's CLOB applies a documented **1-minute security threshold** to GTD orders: to have an order live for N more seconds, the client must set `expiration = now + 60s + N`. The adapter passes the engine's intended cancel time straight through with no buffer, so the exchange sees every live maker order as expiring 60 seconds earlier than intended.

## Locations

- `packages/polymarket/src/live.ts:171` — `...(req.expireAtMs ? { expiration: Math.floor(req.expireAtMs / 1000) } : {})` — raw pass-through.
- `apps/engine/src/engine.ts:720` — engine sets `expireAtMs = (endEpoch − cancel_seconds_remaining) * 1000` (default `cancel_seconds_remaining: 45`).
- Contrast: paper mode honors `expireAtMs` literally (`apps/engine/src/paper.ts:113`), so paper results never expose the divergence.

## Failure scenario

Engine enters maker orders when 60–120s remain (candidate window) and wants them canceled at 45s remaining → intended resting lifetime 15–75s. With the 60s threshold unaccounted for, the exchange treats the order as already expired (or expiring within seconds) at placement: live maker orders get rejected or killed almost immediately, silently, on every single market window.

## Impact

- The live maker path — the **default** execution style (`maker_only: true`) — cannot rest orders as designed while the paper simulation of the identical strategy works fine. Every paper-validated maker result diverges from live behavior in the worst way: silently.

## Suggested direction (not implemented)

Add the 60s threshold when building the GTD expiration (and reject submissions whose intended lifetime is non-positive after accounting for it); verify against @polymarket/clob-client v5.8.1 semantics with one live probe.
