# Bug-discovery findings (ready-to-file GitHub issues)

Each file in this directory is a fully written GitHub issue produced by a continuous
bug-discovery review session. They are staged here because the session's GitHub
integration currently lacks **Issues: write** permission on this repository
(`403 Resource not accessible by integration`). Grant the Claude GitHub App
issue-write access and these can be filed via API verbatim.

No fixes are included anywhere in this branch — findings only, by request.

| # | Severity | Title |
|---|----------|-------|
| 001 | High | `strategy.calibration_required` is never enforced — UNCALIBRATED models can approve trades |
| 002 | High | Restarting with an open paper position corrupts the bankroll (cost resurrected, fees dropped) |
| 003 | High | README/limitations.md still claim "no signing path exists" — a real-money live path now exists |
| 004 | High | Live positions/fills bypass accounting: exposure hardcoded 0, resting-fill wins counted as losses |
| 005 | Medium | Chainlink-synthesized candles silently keep the "binance_composite" provenance label |
| 006 | Medium | `feedHealth` reports the first book ever inserted, not the active market's books |
| 007 | Medium | Idempotency duplicate-order gate can never fire (key derived from fresh random id) |
| 008 | Medium | Dashboard "Session P&L" is drawdown-from-peak; can never show positive |
| 009 | Medium | `app.mode` config is ignored; shadow mode unreachable |
| 010 | Medium | Unbounded in-memory growth on 24/7 runs (markets/books/orders/keys never pruned) |
| 011 | Medium | Redis bus: kill-switch publish is fire-and-forget; unhandled rejection on Redis outage |
| 012 | Low | `dataQualityScore` covers only Chainlink + UP book but is presented as overall data quality |

Verification status: every finding above was manually traced to its call sites in this
tree (line references in each file) before being written up.
