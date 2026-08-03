# [Medium] Local resolution accepts an arbitrarily stale "final" Chainlink tick — then halts the engine on its own self-inflicted mismatch

**Labels:** bug, resolution
**Severity:** Medium

## Summary

`resolveDue` resolves a market from `chainlink.atOrBefore(endEpoch*1000)` with **no freshness check** (`apps/engine/src/engine.ts:789-796`), while the symmetric boundary capture enforces `max_gap_ms` (`:403-407`). `TickBuffer.atOrBefore` (`packages/strategy/src/ticks.ts:34-39`) returns the last tick regardless of age.

## Failure scenario

The Chainlink feed dies 3 minutes before window end (see issue 019 for how that happens silently). At `endEpoch + 3s`, `resolveDue` finds a 3-minute-old tick, declares an outcome from it, books paper/live P&L, updates the consecutive-loss counter and bankroll snapshots. When Gamma's official outcome later disagrees, `crossCheckResolution` **halts the entire engine** on a mismatch the engine created for itself — the wait-for-official-outcome path (`:797-807`) exists but is only reached when the tick is entirely missing, not when it's stale.

## Impact

Wrong outcomes booked into the audit trail during feed outages; unnecessary full halts; violates the fail-closed-on-stale-data non-negotiable in the one place (resolution) where correctness matters most.

## Suggested direction (not implemented)

Apply the same `max_gap_ms` rule as boundary capture: if the tick at-or-before `endEpoch` is older than the gap tolerance, defer to the official-outcome path instead of resolving locally.
