# [Low] `ReconnectingWs` stop()/start() restart race produces duplicate live sockets and leaked ping intervals (latent)

**Labels:** bug, websocket, latent
**Severity:** Low (no current caller restarts; becomes live the moment a staleness-kick fix for issue 019 is added)

## Summary

`stop()` closes the socket asynchronously; a subsequent `start()` sets `stopped = false` and connects a new socket. When the old socket's `onclose` finally fires, it observes `stopped === false` and calls `scheduleReconnect`, spawning a **third** connection while the second is healthy. `this.ws`/`this.pingTimer` are overwritten, leaking the earlier socket (whose `onmessage` still feeds duplicate data into `opts.onMessage`) and its ping interval. `scheduleReconnect` also never clears a pending `reconnectTimer` before assigning a new one.

## Locations

- `packages/polymarket/src/ws-base.ts:87-94` (`stop`), `:30-33` (`start`), `:63-66` (`onclose` of the stale socket), `:69-75` (`scheduleReconnect` overwrites the timer handle without clearing).

## Failure scenario

Any future restart path — e.g., the natural fix for issue 019 ("force reconnect when stale") implemented as `stop(); start();` — intermittently yields two live sockets: duplicated ticks/book messages (double-counted in `TickBuffer`, see issue 044), plus leaked intervals.

## Impact

Latent now (grep confirms each client is started exactly once in `apps/engine/src/main.ts`), but it booby-traps the exact fix the WS stack most needs.

## Suggested direction (not implemented)

Generation-token the connection (ignore events from superseded sockets), clear pending reconnect timers in `scheduleReconnect`/`stop`, and null out handlers on the old socket before opening a new one.
