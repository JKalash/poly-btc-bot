# [High] Restart silently clears the consecutive-loss stop and resets the daily-drawdown peak

**Labels:** bug, risk-engine, accounting
**Severity:** High

## Summary

The spec defines the consecutive-loss stop as requiring **manual re-arm** ("No automatic re-arming after a stop", `polymarket.fable:432-434`) and the daily loss limit against the UTC-day peak (`:404-405`). `Accounting.reconcile()` (`apps/engine/src/accounting.ts:47-84`) restores bankroll and open positions on restart but:

- `consecutiveLosses` stays at its field initializer `0` — nothing reads the prior `trading_sessions.consecutiveLosses` (which *is* persisted, `accounting.ts:206-208`);
- `dailyPeak = this.bankroll` (current value), not the day's true peak — nothing reads the day's `bankroll_snapshots` maximum.

## Failure scenario

1. Two consecutive losses under the very-aggressive profile trip `CONSECUTIVE_LOSS_STOP` — trading stops, exactly as designed.
2. Any process restart (deploy, crash, Fly migration — routine per issues 028/029) → counter back to 0 → trading **auto-resumes** with a fresh stop budget.
3. Similarly mid-day: a restart after a morning drawdown grants a fresh daily loss budget measured from the post-loss bankroll (bankroll drops on fills, so the reset peak can even be *below* the day's true peak, loosening the daily stop precisely after losses).

## Impact

The two drawdown stops — the spec's answer to "never auto win-it-back" — are only as durable as process uptime. Distinct from issue 002 (bankroll *value* corruption on restart); this is loss-*stop* state.

## Suggested direction (not implemented)

Restore `consecutiveLosses` from the latest `trading_sessions` row (or recompute from trailing `pnl_records`) and `dailyPeak` from the UTC-day's max `bankroll_snapshots` in `reconcile()`.
