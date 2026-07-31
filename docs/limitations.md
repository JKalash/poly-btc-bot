# Known limitations (explicit, per spec's final build step)

## Not implemented (stubs / documented seams)

- **Live trading** — entire path absent by design. `DisabledLiveAdapter` refuses everything.
  LIVE_* engine states exist in the FSM but are unreachable.
- **Shadow wallet reads** — shadow mode produces would-submit intents and snapshots, but reads no
  real wallet balances (requires authenticated CLOB API; deferred with the live adapter).
- **Backtest/replay UI** — `backtest_runs` table and recorded tick/book/trade data exist and the
  paper engine is deterministic-steppable (see engine tests, which drive `step(nowMs)` manually),
  but there is no dashboard page to launch replays yet. Replays run today only as code.
- **Calibrated models** — `calibrated_logistic` refuses to estimate (no artifact). Building the
  walk-forward calibration pipeline over accumulated feature snapshots is the next research task.
- **Maker-rebate accounting** — displayed as schedule info; not accrued to P&L (paper never earns
  rebates; live accrual belongs with the live adapter).
- **Retention/compaction jobs** — retention policy documented, tables partition-ready (indexed by
  time), but no automatic pruning yet.
- **OpenTelemetry export** — logs are structured JSON with correlation ids; metrics live in the
  cockpit/health tables rather than an OTel exporter.
- **TOTP / passkeys** — single-user scrypt password + rate limiting + CSRF; TOTP hook not built.
- **Order-book delta persistence** — books are persisted as periodic snapshots + trade ticks
  (sufficient for the conservative fill model), not full L2 delta streams.

## Known rough edges

- Clock-skew estimation uses RTDS server timestamps minus receive time (one-way latency bias);
  the risk gate widens tolerance by 150ms to compensate. An NTP query would be cleaner.
- In embedded (PGlite) mode the API and engine share one DB connection; very heavy dashboard
  polling during a busy market window can add latency to engine persistence. Use Postgres mode
  for anything serious.
- Binance RTDS updates were sparse in live capture (the adapter also polls 1s klines, which is
  the primary Binance source); the `binance` feed health lamp may show unhealthy while klines
  remain green — indicators still work.
- Gamma discovery of the *next* window can lag ~1 minute after a slot boundary until Polymarket
  activates the market (tokens absent until activation).
- E2E tests require `npx playwright install chromium` once, and a running stack.
