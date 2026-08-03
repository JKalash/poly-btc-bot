# [Medium] The idempotency duplicate-order gate can never fire — the key is derived from a freshly-generated random id

**Labels:** bug, risk-engine
**Severity:** Medium

## Summary

`execution.idempotency_required` is enforced via `riskCtx.idempotencyKeyIsDuplicate`, but the key being checked is `idempotencyKey(decisionId, 1)` where `decisionId = newId()` (a fresh random UUID) generated moments earlier in the same function. The key is unique by construction, so `usedIdempotencyKeys.has(idemKey)` is always `false`. The duplicate-order safety gate is dead code providing zero protection.

## Locations

- `apps/engine/src/engine.ts:560` — `const decisionId = newId();`
- `apps/engine/src/engine.ts:566` — `const idemKey = idempotencyKey(decisionId, 1);`
- `apps/engine/src/engine.ts:604` — `idempotencyKeyIsDuplicate: this.usedIdempotencyKeys.has(idemKey)` — always false.
- `apps/engine/src/engine.ts:691` — the key is added to the set after approval, but no future decision can ever collide with it.
- `packages/domain/src/ids.ts:6-8` — `idempotencyKey` = sha256(decisionId:intentVersion): deterministic *given the decision id*, but the decision id itself is random per call.
- The set is in-memory only (`engine.ts:69`), so it would not survive the restart scenarios where duplicate submission is most likely.

## Failure scenario

Any code path that retries `decide()`/order submission (now or after future refactors) mints a new `decisionId` and sails through the "duplicate" check; the risk-report line `idempotency` in every decision snapshot claims a protection that structurally cannot trigger. E.g., a future retry-on-timeout in `LiveController.submit` would double-submit a real order with two "unique" idempotency keys.

## Impact

- The protection promised by `execution.idempotency_required: z.literal(true)` (config) is illusory.
- For live trading this is the classic double-spend-on-retry hole: the whole point of an idempotency key is to survive retries and restarts; deriving it from a per-call random UUID defeats that.

## Suggested direction (not implemented)

Derive the key from stable intent content (marketId + side + window + intent version), persist used keys (they are already written to `order_intents.idempotencyKey` — check against the DB, unique-constrained), and check before submission on both paper and live paths.
