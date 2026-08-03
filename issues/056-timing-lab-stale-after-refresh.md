# [Low] Timing Lab never reloads its table after a refresh completes — stale (possibly seeded) stats shown as the fresh result

**Labels:** bug, web-ui
**Severity:** Low

## Summary

The Timing Lab table is fetched once (`useApi<Payload>("/api/timing-lab", 0)` — no polling), and the "Refresh from Gamma" flow re-polls only the *status* endpoint. When the background backfill+stats run finishes, nothing re-fetches the table: the header keeps showing the previous run's `runId`/`source: seed`/`computedAt` and stale rows until the operator notices the small manual reload button.

## Locations

- `apps/web/app/timing-lab/page.tsx:22` (single fetch), `:36-44` (`refresh()` reloads status only), `:76-81`.

## Failure scenario

Operator clicks "Refresh from Gamma", watches the progress line complete, and reads the still-displayed **seeded** 30-day table as the fresh result — precisely the seed-vs-real confusion the `source` label was designed to prevent.

## Impact

Stale statistics presented as the outcome of a just-completed refresh.

## Suggested direction (not implemented)

Re-fetch the table when `status.running` transitions true→false (or poll the table while a run is active).
