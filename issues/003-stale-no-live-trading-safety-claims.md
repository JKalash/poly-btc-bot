# [High] README and docs/limitations.md still claim "no signing path exists" — but a real-money live path now exists

**Labels:** bug, documentation, safety
**Severity:** High (safety-claim integrity)

## Summary

The repo's headline safety claim is false in the current tree. A complete live-trading path (hot-wallet key, arming flow, real CLOB order submission) was added in commit `908a978` ("live: real-money CLOB executor behind the arming flow"), but the two central safety documents still assert the opposite.

## Locations

- `README.md:4-6` — "Live execution does not exist in this release: there is no signing path anywhere in the codebase, by design."
- `README.md:68` — "Paper mode by default; **live trading disabled** — no signing path exists at all."
- `docs/limitations.md` — "**Live trading** — entire path absent by design. `DisabledLiveAdapter` refuses everything. LIVE_* engine states exist in the FSM but are unreachable."
- Reality: `apps/engine/src/live.ts` (`LiveController`, `HOT_WALLET_PRIVATE_KEY`, `LIVE_TRADING_ENABLED`), `packages/polymarket/src/execution.ts` (`LiveClobAdapter`), `apps/engine/src/engine.ts:713-735` (live submission path), and `docs/live-trading.md` ("how to configure a wallet, arm, and place REAL orders").

## Failure scenario

An operator (or reviewer, or auditor) reads README/limitations.md, concludes the deployment cannot possibly spend money, and treats wallet/key hygiene, `LIVE_TRADING_ENABLED`, and the arming flow as irrelevant. Meanwhile setting two env vars enables real-money order submission.

## Impact

- The strongest safety property the project advertises ("no signing path") is no longer true; every decision that trusted that claim (deployment posture, key handling, review depth for the risk engine) is built on a stale premise.
- `docs/limitations.md` additionally misdescribes shadow mode and the `DisabledLiveAdapter` as current behavior.

## Suggested direction (not implemented)

Update README and limitations.md to describe the actual state (live path exists, disarmed by default, gated by env + typed acknowledgement + TTL), and reconcile the contradiction between README line 4 and README line 95 (which already links `docs/live-trading.md`).
