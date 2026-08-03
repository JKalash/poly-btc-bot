# [Medium] WS backoff resets on `open`, not on a healthy connection — accept-then-drop failures reconnect in a tight 1s loop forever

**Labels:** bug, reliability, websocket
**Severity:** Medium

## Summary

`ReconnectingWs` resets its exponential backoff to 1s the moment the socket handshake completes (`onopen`). If the server accepts connections and then immediately closes them (load shedding, subscription rejection, app-layer rate limiting), every cycle is connect → open (backoff reset) → close → reconnect after exactly 1s — a permanent 1 Hz reconnect storm per socket instead of exponential backoff.

## Locations

- `packages/polymarket/src/ws-base.ts:47-48` — `ws.onopen = () => { this.backoffMs = 1000; ... }`.
- `ws-base.ts:69-75` — `scheduleReconnect` doubles from whatever `backoffMs` currently is; after any successful handshake it is back at 1s.

## Failure scenario

Polymarket's gateway sheds load by closing sockets shortly after accept. All three bot sockets (RTDS, CLOB, plus reconnects) hammer the endpoint at ~1 Hz indefinitely, which is exactly the behavior that gets a client IP rate-limited or banned — worsening the outage the backoff was meant to survive.

## Impact

Reconnect storms during partial outages; potential IP-level bans affecting the collector's long-term viability.

## Suggested direction (not implemented)

Reset backoff only after the connection has proven healthy (e.g., N seconds open or first data message received), not on handshake completion.
