# [Low] `diffConfigs` mishandles object-vs-array comparisons asymmetrically — bogus paths in the config audit trail

**Labels:** bug, config
**Severity:** Low

## Summary

The recursion guard checks `!Array.isArray(av)` but never checks `bv`. If `av` is a plain object and `bv` is an array, the function recurses across the union of object keys and array indices, emitting nonsense per-index diff paths (e.g. `research.rolling_windows_days.0`) instead of a single replacement entry. The mirrored case (av array, bv object) takes the JSON-compare branch — inconsistent output for symmetric inputs.

## Locations

- `packages/config/src/index.ts:198` — `if (typeof av === "object" && av !== null && typeof bv === "object" && bv !== null && !Array.isArray(av))`.
- Consumer: `apps/api/src/server.ts:310-317` — persisted `changedPaths` audit trail on every config change.

## Failure scenario

A config edit changes a field's shape (scalar↔array↔object, e.g., replacing an object block with an array during schema evolution). The stored `changedPaths` for that version contains fabricated per-index paths on one direction and a single entry on the other — the config version viewer shows different histories for A→B vs B→A.

## Impact

Confusing/incorrect entries in the persisted config-change audit trail. No trading impact.

## Suggested direction (not implemented)

Recurse only when both sides are non-array objects (`!Array.isArray(av) && !Array.isArray(bv)`); otherwise JSON-compare.
