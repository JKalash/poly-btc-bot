# [High] No staleness/pong watchdog anywhere in the WS stack — a half-open connection starves all feeds until manual restart

**Labels:** bug, reliability, websocket
**Severity:** High

## Summary

`ReconnectingWs` sends application-level PINGs but never verifies PONGs or message recency; reconnection is triggered **only by `onclose`**. A half-open TCP connection (NAT/LB silently dropping the path — a routine network event) fires no `close` for many minutes, sometimes never. Nothing in the engine ever forces a reconnect on staleness: the watchdog cancels orders and enters DEGRADED, and then the system sits there indefinitely while a perfectly working network path exists.

## Locations

- `packages/polymarket/src/ws-base.ts` — whole file: PING sent (`:51`), PONG never checked (`:57` just filters it out), no last-message timeout, reconnect only in `onclose` (`:63-66`).
- `ws-base.ts:96-98` — `ageMs()` exists, but grep confirms no caller uses it to restart a socket.
- `apps/engine/src/engine.ts:430-448` — `watchdogs()` transitions to DEGRADED on stale Chainlink and back on recovery; it never touches the feed adapters.
- `apps/engine/src/main.ts` — no supervision of `rtds`/`clob`/`klines` beyond logging status callbacks.

## Failure scenario

1. Fly/VPS NAT drops the idle-ish RTDS TCP path without RST (classic half-open).
2. Node's WebSocket keeps `readyState OPEN`; PINGs are sent into the void; no data arrives; `onclose` doesn't fire for the kernel retransmit timeout (~15+ minutes) or never.
3. Engine: "chainlink stale >30s" → DEGRADED, orders canceled — correct fail-safe — but then **nothing attempts recovery**. The 24/7 collector records a gap until a human restarts the process.

## Impact

Unbounded silent outage of the entire bot (feeds, collection, trading) from a routine network event — directly against the "gap-free 24/7 collection" deployment goal.

## Suggested direction (not implemented)

In `ReconnectingWs`, track `lastMessageTsMs` (already exists) and force-close/reconnect when it exceeds a threshold (e.g., 3× ping interval with no message or PONG); optionally have the engine's DEGRADED path kick the adapters after N seconds stale.
