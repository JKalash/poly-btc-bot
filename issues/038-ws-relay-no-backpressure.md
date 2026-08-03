# [Low] API WebSocket relay has no backpressure handling — a stalled client buffers cockpit traffic in the trading process

**Labels:** bug, api, reliability
**Severity:** Low

## Summary

Every bus message is `JSON.stringify`-ed and `socket.send()`-ed to each subscriber with no `bufferedAmount` check or drop policy. A client whose TCP window is closed (laptop asleep behind an SSH tunnel — the documented access pattern) causes cockpit+events payloads (~2/sec) to accumulate in process memory until the OS gives up on the connection.

## Locations

- `apps/api/src/server.ts:115-121`.

## Failure scenario

SSH tunnel half-open for hours → tens of MB buffered inside the API process — which, in embedded mode, is also the engine process (shared event loop and heap with trading/persistence).

## Impact

Memory pressure in the trading process caused by a display consumer. Single-operator scale keeps it small; the embedded-mode coupling is what makes it worth fixing.

## Suggested direction (not implemented)

Check `socket.bufferedAmount` before send and drop cockpit frames (they are idempotent snapshots) past a threshold; close sockets that stay saturated.
