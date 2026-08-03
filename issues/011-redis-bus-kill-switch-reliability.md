# [Medium] Redis bus: kill-switch delivery is fire-and-forget — publish failures are unhandled rejections and subscriptions never clean up

**Labels:** bug, reliability, safety
**Severity:** Medium

## Summary

In split-process (Redis) mode, the kill switch and all control commands travel over `Bus.publish`, which is fire-and-forget with no error handling. If Redis is unavailable, the operator's **kill** command is silently dropped — and the discarded rejected promise can crash the publishing process via `unhandledRejection`.

## Locations

- `apps/engine/src/bus.ts:50-52`:
  ```ts
  publish: (ch, payload) => {
    void pub.publish(ch, JSON.stringify(...));
  },
  ```
  `void` discards the promise. With `maxRetriesPerRequest: 3` (line 36), a Redis outage makes `publish` reject; the rejection is unhandled → Node's default behavior terminates the process. Even if the process survives (custom handler), the caller gets no signal that the kill command was lost.
- `apps/engine/src/bus.ts:59` — `subscribe`'s disposer deletes the local handler but never calls `sub.unsubscribe(ch)`, and an empty handler-set channel stays subscribed forever (minor leak; also means `handlers.has(ch)` stays true so resubscription logic is skipped — correct today only by accident).
- Kill path depending on this: API publishes `{type: "kill"}` on `CHANNELS.control` (see `apps/api/src/server.ts`), engine consumes it at `apps/engine/src/engine.ts:119-121, 144-151`.

## Failure scenario

1. Canonical-mode deployment (Postgres + Redis, separate processes) as documented in README.
2. Redis restarts or has a network blip while the engine is live-armed with resting orders.
3. Operator hits the kill switch in the dashboard. The API's `pub.publish` rejects after 3 retries: the command never reaches the engine, no error is shown to the operator (the HTTP response already returned success), and the API process may die from the unhandled rejection.

## Impact

- The most safety-critical control (kill) has silent-loss semantics exactly when infrastructure is unhealthy — the moment it's most likely to be used.
- Contrast: the engine's own DB failures fail closed (`halt("database unavailable...")`, engine.ts:868-871); the control plane has no equivalent.

## Suggested direction (not implemented)

Await and surface publish results on the control path (API should report delivery failure to the operator); add a `.catch` for telemetry publishes; consider a DB-backed fallback for kill (engine already polls the DB) so kill works with Redis down; fix the unsubscribe disposer.
