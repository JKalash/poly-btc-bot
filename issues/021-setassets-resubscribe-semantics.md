# [Medium] `ClobMarketWs.setAssets` neither reconnects nor unsubscribes — new-market subscriptions rely on unverified server semantics

**Labels:** bug, websocket, needs-live-verification
**Severity:** Medium
**Confidence:** code behavior confirmed; live server semantics for repeat subscribe payloads needs one live check

## Summary

The method's own doc comment says "Replace the subscription set (**reconnect-based**; …)" but the implementation performs no reconnect — it just sends another full `{assets_ids, type: "market"}` payload on the already-open socket, and nothing ever unsubscribes removed assets. The documented CLOB market-channel contract consumes the subscription message at connection start; whether a repeated full-list message adds new assets mid-connection is server-version-dependent.

## Locations

- `packages/polymarket/src/clob-ws.ts:94-101` — sends a second subscribe payload on the live socket; comment contradicts code.
- `apps/engine/src/main.ts:85` — `clob.setAssets(engine.subscriptionTokens(nowSec))` every 20s discovery cycle.

## Failure scenario

This bot's entire premise is a **new token pair every 5 minutes** on a long-lived socket. If the server ignores repeat subscribes, every market after the initial connection receives zero book data: books stay stale, the risk gate blocks all entries, and the operator sees a permanently degraded book feed that "fixes itself" only on incidental disconnects. Under the benign interpretation, expired assets are never unsubscribed and accumulate on the connection for hours (growing message volume; the engine's `books` map also grows — see issue 010).

## Impact

Potential total loss of order-book data for all post-connect market windows; at minimum unbounded subscription growth.

## Suggested direction (not implemented)

Make the comment true: reconnect (with backoff protections) when the asset set changes, or verify and use the CLOB's documented incremental subscribe/unsubscribe operations; either way, verify against the live endpoint once.
