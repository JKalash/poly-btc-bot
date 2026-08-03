# Bug-discovery findings (ready-to-file GitHub issues)

Each file in this directory is a fully written GitHub issue produced by a continuous
bug-discovery review session. They are staged here because the session's GitHub
integration currently lacks **Issues: write** (and Contents: write) permission on this
repository (`403 Resource not accessible by integration`). Grant the Claude GitHub App
write access and these can be filed via API verbatim.

No fixes are included anywhere in this branch — findings only, by request.

Verification status: every finding was traced to its call sites in this tree (line
references in each file); several were additionally reproduced by executing throwaway
tests (marked "reproduced"). Findings that require one live check against Polymarket's
servers are marked with a confidence note.

## High severity

| # | Title |
|---|-------|
| 001 | `strategy.calibration_required` is never enforced — UNCALIBRATED models can approve trades |
| 002 | Restarting with an open paper position corrupts the bankroll (cost resurrected, fees dropped) |
| 003 | README/limitations.md/execution.ts still claim "no signing path exists" — a real-money live path now exists |
| 004 | Live positions/fills bypass accounting: exposure hardcoded 0, resting-fill wins counted as losses |
| 013 | Price-impact gate fails OPEN when impact is unknown — precisely the worst-impact case |
| 017 | Live GTD maker orders omit Polymarket's mandatory 1-minute expiration buffer |
| 018 | `mapResponse` classifies "unmatched" CLOB statuses as accepted LIVE orders — phantom positions, trading lockout |
| 019 | No staleness/pong watchdog in the WS stack — half-open connection starves all feeds until manual restart |
| 027 | Kill switch/arm/disarm/resume silently dead in split-process mode without REDIS_URL |
| 048 | `API_PROXY_TARGET` baked at Next build — split-process compose deploy ships a non-functional dashboard |

## Medium severity

| # | Title |
|---|-------|
| 005 | Chainlink-synthesized candles silently keep the "binance_composite" provenance label |
| 006 | `feedHealth` reports the first book ever inserted, not the active market's books |
| 007 | Idempotency duplicate-order gate can never fire (key derived from fresh random id) |
| 008 | Dashboard "Session P&L" is drawdown-from-peak; can never show positive |
| 009 | `app.mode` config is ignored; shadow mode unreachable |
| 010 | Unbounded in-memory growth on 24/7 runs (markets/books/orders/keys never pruned) |
| 011 | Redis bus: kill-switch publish is fire-and-forget; unhandled rejection on Redis outage |
| 014 | `minExpectedValuePerCostPpm` risk limit is defined, configured — and never enforced |
| 015 | The "absolute" 10% cap is a caller convention, not an evaluator invariant; profiles mutable |
| 020 | WS backoff resets on `open` — accept-then-drop failures reconnect at 1 Hz forever |
| 021 | `ClobMarketWs.setAssets` neither reconnects nor unsubscribes (new-market subscription semantics unverified) |
| 022 | Config schema strips unknown keys — typo'd fields silently revert to defaults |
| 023 | Config validation lacks bounds — `live_price_ceiling: "1.50"`, negative cutoffs validate cleanly |
| 028 | prod/dev.mjs shutdown race — PGlite data-loss window on every deploy |
| 029 | dev.mjs handles SIGINT only — SIGTERM orphans api/engine/web (double-engine hazard) |
| 030 | Emergency-stop UI swallows failures — dialog closes as if the stop succeeded |
| 032 | calibration_study.py: vol60/flips features depend on implicit row order (no time sort before diff) |
| 041 | Crossed book → negative uncertainty, inverted probability bounds, conservative widening lost (reproduced) |
| 042 | `computeIndicators` has no staleness/gap handling; late-snipe can enter on a 19s-old picture |
| 043 | `windowDeltaPct` silently rebases to buffer start after mid-window restarts (reproduced) |
| 049 | Seeded tutorial trade counted as a real paper result in P&L/orders/positions |
| 050 | Cockpit WebSocket hardcoded to 127.0.0.1 and never reconnects — realtime dead off-localhost |
| 051 | Risk-page UI + .env.example still claim "no signing path" beside the live-arming card |

## Low severity

| # | Title |
|---|-------|
| 012 | `dataQualityScore` covers only Chainlink + UP book but is presented as overall data quality |
| 016 | `breakEvenTakerShareCollected` rounds down 1 µ despite "Rounded up" contract (numerically verified) |
| 024 | `ReconnectingWs` stop()/start() race — duplicate sockets (latent; booby-traps the issue-019 fix) |
| 025 | `BinanceKlinesPoller`: overlapping polls can overwrite fresh candles with stale ones |
| 026 | `diffConfigs` mishandles object-vs-array — bogus paths in the config audit trail |
| 031 | `/api/pnl/summary` computes drawdown/streaks over a silently truncated 2000-row window |
| 033 | calibration_study.py: Bonferroni hardcodes ×12 while grouping by raw closing minute |
| 034 | Backfill progress counters double-count on errors; insert failures swallowed |
| 035 | `clampLimit` accepts fractional limits → `LIMIT 0` → empty responses |
| 036 | POST /api/config race can leave two `active=true` config versions |
| 037 | Auth maps grow without bound (tickets/sessions/login attempts) |
| 038 | API WebSocket relay has no backpressure handling |
| 039 | Non-constant-time comparisons for session HMAC and CSRF token |
| 040 | Concurrent first-boot migration race in split-process mode |
| 047 | Unhealthy feed lamps never generate health events |
| 052 | Missing indexes on hot dashboard queries; unbounded `markets` scan per P&L poll |
| 053 | engine.test.ts: vacuous fail-closed test; tie-rule test never exercises resolution |
| 054 | Data pages conflate error/loading with empty — "No orders yet" while the API is down |
| 055 | Playwright smoke test cannot pass (`getByLabel` has no label association) |
| 056 | Timing Lab never reloads its table after a refresh completes |
| 044 | `TickBuffer` never dedups; RTDS backfill collapses `medianGapMs` to 0 (reproduced) |
| 045 | `aggregateCloses` bucket phase jitter makes EMA/RSI non-reproducible |
| 046 | Order prices round-trip through floats, contradicting the fixed-point invariant (currently exact) |

## Areas verified clean (notable non-findings)

- `mulDiv` rounding (exhaustively brute-forced against exact rational rounding, all sign combinations), fee/Kelly/sizing math, cap-chain monotonicity, session/daily budget arithmetic.
- Statistics: Wilson, Bonferroni, Benjamini–Hochberg, chi-square, Mann-Whitney tie correction, normCdf — all re-derived and correct (both TS and Python implementations, except the two Python findings above).
- Auth: scrypt usage, CSRF-vs-session binding, one-time WS tickets; walk-forward study has no train/test leakage; backfill dedup constraints; migrations match schema.ts; timezone handling is pure UTC epoch math throughout.
- Paper executor conservative fill model (queue join, post-only cross rejection, stake-cap invariant on fills).
