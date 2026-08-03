# [Medium] `fee_collection_convention: "shares"` silently simulates taker trades fee-free — approvals price a fee the simulator never charges

**Labels:** bug, accounting, fees
**Severity:** Medium (latent — default convention is "usdc")

## Summary

The share-collected fee formulas exist and are tested (`takerFeeShares`, `netWinningSharesShareCollected`, `packages/domain/src/fees.ts:31-38`) but have **zero call sites** outside tests. The paper executor charges `0n` fee whenever collection is `"shares"` (`apps/engine/src/paper.ts:179,190,195`) and never deducts fee shares; accounting pays out the full `pos.shares6` at resolution (`accounting.ts:176`).

Meanwhile the risk gates *do* use the share-collected break-even (`breakEvenTaker` respects `collection`), so approvals assume a fee that execution then never applies. `docs/architecture.md:17-20` claims "Both conventions are implemented exactly" — the math is; the wiring is not.

## Failure scenario

Operator flips the documented knob to `"shares"` to study that convention: every simulated taker trade's P&L is overstated by exactly the fee (e.g., ~2.79 USDC on the tutorial-sized 839-share trade at 0.95), corrupting precisely the fee-sensitivity research the dual implementation exists to support.

## Impact

A documented, validated config option silently produces fee-free simulation; break-even/EV gating and realized P&L disagree about whether the fee exists.

## Suggested direction (not implemented)

Wire `takerFeeShares`/`netWinningSharesShareCollected` into the paper fill and resolution paths when `collection === "shares"`, or reject that config value until implemented.
