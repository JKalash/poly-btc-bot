# [Medium] prod.mjs / dev.mjs exit immediately after signaling children — graceful-shutdown race risks PGlite data loss on every deploy

**Labels:** bug, deployment, data-integrity
**Severity:** Medium

## Summary

On SIGINT/SIGTERM the process runners call `p.kill(sig)` on each child and then `process.exit(0)` **synchronously**, without awaiting child exit. In the Fly.io deployment, `prod.mjs` is PID 1: when it exits, the container is torn down and children are SIGKILLed mid-shutdown — before the API's `app.close()` / `engineRuntime.stop()` / `db.close()` (`apps/api/src/main.ts:43-51`) can flush embedded PGlite on the mounted volume.

## Locations

- `scripts/prod.mjs:28-33` — signal handler: kill children, `process.exit(0)` immediately.
- `scripts/dev.mjs:42-45` — same pattern; `:27-31` — child-exit handler also kills siblings and exits without waiting.

## Failure scenario

`fly deploy` or a machine restart sends SIGTERM → runner exits ~instantly → container reaped → API killed mid `db.close()` → last cockpit/tick/order writes lost or the PGlite directory left dirty. The deployment's stated mission (`docs/deploy.md`) is *gap-free* 24/7 collection; this creates a loss window on **every** restart/deploy.

## Impact

Routine deploys can drop the tail of collected data or corrupt the embedded DB; failures are silent and only visible later as gaps.

## Suggested direction (not implemented)

Signal children, then `await` their exit (with a timeout escalation to SIGKILL) before exiting the runner; in prod, consider forwarding signals and using `init`-style reaping.
