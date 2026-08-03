# [Medium] Cockpit WebSocket URL is hardcoded to 127.0.0.1:8787 and never reconnects — live streaming is dead on any real deployment

**Labels:** bug, web-ui
**Severity:** Medium

## Summary

The dashboard's realtime hook opens `ws(s)://127.0.0.1:8787/api/ws` — the **viewer's own machine**, not the server. On the Fly deployment this becomes `wss://127.0.0.1:8787`, blocked by CSP (`connect-src` allows only `ws://127.0.0.1:8787`, never `wss:`) and refused (fly.toml exposes no public API listener). And after any single WS drop, `onclose`/`onerror` just set `live=false`; nothing ever reconnects — the session silently downgrades to 2s polling forever.

## Locations

- `apps/web/lib/hooks.ts:91-92` — hardcoded URL; `:101-102` — no retry.
- `apps/web/next.config.mjs:18` — CSP `connect-src 'self' ws://127.0.0.1:8787 http://127.0.0.1:8787`.

## Failure scenario

Operator opens the production dashboard: header shows "polling" permanently; updates arrive at 2s granularity instead of push — including during the final 30 seconds of a market window, where the product's entire value lives. Same-machine dev is the only topology where streaming works, and even there one API restart kills it until a full page reload.

## Impact

The realtime path is dead code everywhere but localhost dev; the polling fallback silently masks it.

## Suggested direction (not implemented)

Derive the WS URL from `location.host` (same-origin through the Next proxy) or a runtime-injected config; add `wss:`/`ws:` same-origin to CSP; reconnect with backoff on close.
