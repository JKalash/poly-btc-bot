# [Medium] Exit policies are an enum, not a feature — three of four configured policies silently do nothing

**Labels:** bug, spec-gap
**Severity:** Medium

## Summary

`strategy.exit_policy` offers `hold_to_resolution | threshold_cross_invalidation | probability_vs_bid_exit | time_based_exit` (`packages/config/src/index.ts:76-78`; spec `polymarket.fable:686-695`). The value is recorded onto orders, positions, and decision snapshots (`engine.ts:652,748`, `accounting.ts:143,157`, `snapshot.ts:117`) and then **never consulted**: grep shows the three non-default values appear only in config, types, schema, and seed. `Accounting` closes positions exclusively in `onResolution` — no code path exits a position before resolution.

## Failure scenario

Operator configures `probability_vs_bid_exit` expecting positions to be closed when the model probability drops below the recoverable bid. The position is held to resolution regardless — and every persisted position/snapshot **records the non-default policy as if it governed the trade**, making the audit trail state a false management policy for three of four enum values.

## Impact

Silent no-op config plus a falsified audit field. (Resting-order *cancellation* on lost edge exists — issue 063 covers its live gap — but position *exit* after fill does not, for any policy.)

## Suggested direction (not implemented)

Implement the exit policies in the engine loop (paper first), or restrict the enum to `hold_to_resolution` until then so the snapshot never lies.
