---
fable_spec_version: "1.0"
project_name: "BTC Five-Minute Polymarket Command Center"
project_slug: "5min-btc-poly"
document_type: "autonomous-build-brief"
status: "ready-for-build"
primary_user: "single operator / administrator"
generated_at: "2026-07-31"
default_timezone: "Europe/Madrid"
trading_timezone: "UTC"
build_priority: "correctness, capital protection, observability, then speed"
default_mode: "paper"
live_trading_default: false
---

# Fable mission

Build a complete, locally runnable application for observing, researching, paper-trading, backtesting, and—only after explicit operator arming—executing trades in Polymarket's BTC Up or Down five-minute markets.

This is not a visual mock-up. Deliver working source code, database migrations, tests, seed data, Docker-based local infrastructure, a polished admin dashboard, documented configuration, a one-command development startup, and a production build. Continue until the system runs end to end and the acceptance tests pass.

The product must embody the findings and mistakes documented in this specification:

- A winning trade can still be a terrible decision.
- Buying at 95 cents with 30 seconds remaining creates extremely asymmetric risk.
- Market prices are not evidence of edge; an estimated true probability must exceed the effective break-even probability.
- Maker status must be verified, not assumed from the word "limit."
- The Chainlink stream named in the market rules is authoritative; Binance is a secondary diagnostic feed.
- Position sizing happens after edge validation, never because the operator "needs" a target return.
- A fixed objective such as 1% every five minutes is mathematically incompatible with bounded risk and uncertain outcomes.
- Minute-of-hour patterns must be tested out of sample and corrected for multiple comparisons. They are not standalone signals.
- The application must support an intentionally very-aggressive profile, but it must never silently become an all-in or martingale system.

# Non-negotiable operating principles

1. Start in paper mode.
2. Never transmit a live order until the operator completes the live-trading arming flow.
3. Store private keys only on the backend, encrypted at rest. Never send a key, seed phrase, signing material, or API secret to the browser.
4. Use decimal/fixed-point arithmetic for prices, shares, balances, fees, and P&L. Do not use binary floating point for money or order construction.
5. Every order decision must be reconstructable from an immutable decision snapshot.
6. Every rejection must show a human-readable reason.
7. If authoritative data are stale, inconsistent, unavailable, or outside configured tolerances, fail closed and do not trade.
8. Do not promise, display, or imply guaranteed returns.
9. Never implement martingale, loss-chasing, automatic doubling, unlimited averaging down, or automatic "win it back" behavior.
10. Never treat rebates as guaranteed edge.
11. Do not use RSI, candle color, closing-minute bucket, or a Binance-only signal as sufficient authorization to trade.
12. Live automation must have a prominent physical-looking ARM/DISARM control and an always-available emergency kill switch.

# Deliverables

Create a production-quality monorepo with:

- `apps/web`: responsive admin dashboard.
- `apps/api`: authenticated HTTP/WebSocket API.
- `apps/engine`: market-data, signal, risk, execution, reconciliation, and resolution worker.
- `apps/research`: historical ingestion, analysis, walk-forward backtesting, replay, and calibration jobs.
- `packages/domain`: strongly typed domain entities and pure business rules.
- `packages/polymarket`: Gamma, CLOB, market WebSocket, authenticated order, and account adapters.
- `packages/reference-data`: Chainlink RTDS and Binance reference-price adapters.
- `packages/strategy`: feature computation, probability models, signal gates, and strategy versions.
- `packages/risk`: sizing, exposure, stop logic, guardrails, and risk profiles.
- `packages/config`: validated configuration schema, defaults, and migrations.
- `packages/ui`: reusable accessible UI components.
- `packages/test-fixtures`: deterministic market/order/feed fixtures.
- `infra`: Docker Compose, PostgreSQL, Redis, optional TimescaleDB extension, observability.
- `docs`: architecture, setup, operations, threat model, live-trading checklist, and incident runbooks.
- `.env.example`: placeholders only; no real credentials.
- `README.md`: setup, commands, screenshots, paper-mode quick start, live-mode warnings.

Prefer a TypeScript-first implementation because Polymarket's supported clients and order signing are available in TypeScript and shared types reduce drift:

- Node.js LTS.
- pnpm workspaces and Turborepo.
- Next.js with React and TypeScript for the dashboard.
- Fastify or NestJS for the API.
- A separate Node.js worker process for the engine.
- PostgreSQL for durable state.
- Redis Streams or Redis Pub/Sub for real-time internal events.
- Zod for configuration and API validation.
- Prisma or Drizzle for database access and migrations.
- `decimal.js` or an equivalent exact-decimal library.
- Vitest for unit/integration tests.
- Playwright for end-to-end dashboard tests.
- OpenTelemetry-compatible structured logging and metrics.

If current official SDK constraints make another stack materially safer, document the reason before deviating. Pin dependency versions and record the current Polymarket API version. The exchange moved to CLOB V2 in April 2026; do not use an obsolete V1 signing or order path.

# Product modes

Implement four explicit modes with identical decision logic but different execution adapters:

## Observe

- Connect to live public feeds.
- Discover current and next BTC five-minute markets.
- Compute features, signals, effective break-even probabilities, and hypothetical sizing.
- Never create simulated or live orders.

## Paper

- Default mode.
- Simulate post-only and taker execution using recorded book state, configurable latency, queue assumptions, partial fills, fees, cancellations, and resolution.
- Persist every simulated order and outcome.
- Make paper-vs-live visual distinctions impossible to miss.

## Shadow

- Run against live feeds with real wallet/account state read-only.
- Produce an exact "would submit" order request and decision snapshot.
- Never sign or transmit the order.
- Compare hypothetical fills against actual subsequent order-book activity.

## Live

- Disabled by default.
- Requires configured signing wallet, authentication, health checks, a deliberate arming sequence, and an expiring live-session token.
- Must display current bankroll, maximum loss per order, session loss limit, daily loss limit, and exact mode at all times.
- Must automatically disarm after restart, deployment, credential change, data-integrity failure, reconciliation mismatch, or kill-switch activation.

# Official integrations

Build adapters against the current official documentation and verify schemas at implementation time.

## Gamma discovery API

- Base: `https://gamma-api.polymarket.com`
- Discover BTC five-minute series using series slug `btc-up-or-down-5m` or current series ID obtained from Gamma.
- Current observed series ID at specification time: `10684`; do not hard-code without a discovery fallback.
- Current event slug convention: `btc-updown-5m-{unix_start_epoch}` where the epoch is aligned to a 300-second boundary.
- Use keyset pagination for historical event discovery.
- Persist market/event ID, condition ID, token IDs, start epoch, end epoch, rules, resolution source, outcomes, fee schedule, tick size, minimum order size, best bid/ask, volume, and status.
- Re-read the market's actual fee schedule and constraints. Never assume a global minimum size or fee.

## CLOB

- Base: `https://clob.polymarket.com`
- Market WebSocket: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Send application heartbeat `PING` every ten seconds and monitor `PONG`.
- Consume full book snapshots, price changes, last trades, tick-size changes, market state, and authenticated user/order updates.
- Support GTC and GTD maker orders.
- Support explicit post-only semantics.
- Treat a post-only rejection as a safe no-fill, not as authorization to retry as a taker.
- Taker FOK/FAK support must exist but remain disabled by default.
- Confirm order status after submission: live, matched, delayed, partial, canceled, rejected, resolved.
- Reconcile local state with CLOB and on-chain/account state after reconnect or restart.

## Polymarket Real-Time Data Service

- Base: `wss://ws-live-data.polymarket.com`
- Send `PING` every five seconds.
- Subscribe to:
  - Chainlink BTC/USD reference prices.
  - Binance BTCUSDT reference prices for comparison only.
- Prefer full-accuracy string values when the feed provides them.
- Record source timestamp, receive timestamp, clock offset, ingest latency, sequence continuity, and freshness.
- Maintain a rolling two-minute warm-up buffer before enabling signals.

## Resolution and price-to-beat

- Treat the resolution source specified by each market's rules as authoritative.
- Fetch and persist the exact price-to-beat.
- Cross-check price-to-beat values from all available official representations.
- If official representations disagree beyond a configurable tolerance, halt entries for that market.
- Resolution rule: Up if the final authoritative Chainlink value is greater than or equal to the starting authoritative value; otherwise Down.
- Never use the Binance quote as a substitute for settlement.

## Wallet and authenticated trading

- Support the current Polymarket wallet/signature flow and CLOB V2.
- Use a dedicated low-balance hot wallet rather than the operator's primary wallet.
- Support allowance/balance preflight.
- Encrypted key storage using OS keychain where possible, otherwise libsodium/AES-GCM with a user-supplied unlock secret.
- Never log raw credentials, private keys, full authorization headers, or seed phrases.
- Provide a "forget credentials" operation that securely removes locally stored encrypted material after confirmation.

# Core domain model

Implement explicit types and database tables for:

- `Market`
- `MarketOutcome`
- `MarketRuleSnapshot`
- `MarketConstraintSnapshot`
- `FeeScheduleSnapshot`
- `ReferencePriceTick`
- `OrderBookSnapshot`
- `OrderBookDelta`
- `MarketTradeTick`
- `FeatureSnapshot`
- `ProbabilityEstimate`
- `StrategyVersion`
- `SignalCandidate`
- `RiskDecision`
- `DecisionSnapshot`
- `OrderIntent`
- `Order`
- `OrderFill`
- `Position`
- `Resolution`
- `PnLRecord`
- `BankrollSnapshot`
- `Session`
- `RiskLimit`
- `KillSwitchEvent`
- `HealthEvent`
- `ConfigVersion`
- `BacktestRun`
- `ReplayRun`
- `ModelCalibrationRun`
- `TimingBucketStatistic`
- `AuditEvent`

Every entity must use stable IDs, UTC timestamps, source timestamps where applicable, creation timestamps, and correlation IDs.

# Engine state machine

Each market instance must move through a deterministic state machine:

`DISCOVERED -> WARMING -> OBSERVING -> CANDIDATE -> RISK_APPROVED -> ORDER_PENDING -> RESTING -> PARTIAL/FILLED -> RESOLVED -> RECONCILED`

Side paths:

- `CANDIDATE -> REJECTED`
- `ORDER_PENDING -> REJECTED`
- `RESTING -> CANCELED`
- `PARTIAL -> CANCELED`
- Any active state -> `HALTED`
- Any data-loss condition -> `STALE`

The engine-wide state machine:

- `BOOTING`
- `READ_ONLY`
- `PAPER`
- `SHADOW`
- `LIVE_DISARMED`
- `LIVE_ARMING`
- `LIVE_ARMED`
- `HALTED`
- `RECONCILING`
- `DEGRADED`

State transitions must be logged and visible in the dashboard.

# Feature computation

Compute and persist at a configurable interval, normally every 250 ms to one second:

## Time features

- Market start and end epochs.
- Seconds elapsed.
- Seconds remaining.
- UTC hour.
- UTC closing minute bucket: 00, 05, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55.
- Quarter-hour flag for closes at 00/15/30/45.
- Top-of-hour flag.
- Day of week.
- Session labels for Asia, Europe, US, overlap, and low-liquidity hours.

## Authoritative price features

- Chainlink current price.
- Chainlink price-to-beat.
- Signed distance in dollars.
- Signed distance in basis points:

  `distance_bps = side_sign * (chainlink_now - price_to_beat) / price_to_beat * 10_000`

- Distance velocity and acceleration.
- Number and recency of threshold crossings.
- Minimum distance from threshold in rolling windows.
- Maximum favorable/adverse distance.

## Volatility features

- Realized volatility over 5, 10, 15, 30, 60, 120, and 300 seconds.
- EWMA volatility with configurable half-lives.
- High-low ranges for the same windows.
- Standardized distance:

  `distance_z = signed_distance / estimated_remaining_move_std`

- The initial remaining-move estimator may use square-root-of-time scaling, but production probabilities must be empirically calibrated because BTC returns are not normal and jumps matter.
- Volatility regime percentile based only on historical data available before the current tick.

## Cross-feed features

- Binance minus Chainlink difference in dollars and basis points.
- Cross-feed lead/lag.
- Feed freshness.
- Update rates.
- Divergence duration.
- Never interpret Binance leadership as guaranteed executable edge.

## Order-book features

- Best bid and ask for Up and Down.
- Midpoint and spread.
- Top-N depth on each side.
- Microprice.
- Imbalance at configurable depths.
- Order-book slope.
- Recent adds, cancels, and trades.
- Queue size ahead of a hypothetical maker order.
- Last-trade price and age.
- Quote stability and flip rate.
- Implied complementary-price consistency.
- Estimated market impact for requested size.

## Execution-quality features

- Local-to-source latency.
- Source-to-CLOB response lag.
- Order round-trip time.
- Rejection and partial-fill rates.
- Maker fill probability estimate.
- Fill-conditioned adverse price movement after 1, 2, 5, 10, and 30 seconds.

# Probability engine

The application must distinguish three quantities:

1. `market_probability`: executable market price or book-derived probability.
2. `model_probability`: the engine's calibrated estimate of resolution probability.
3. `conservative_probability`: a lower-confidence estimate after uncertainty and data-quality penalties.

Implement a pluggable probability interface:

```text
estimate(features, model_version) ->
  probability,
  lower_bound,
  upper_bound,
  calibration_bucket,
  uncertainty,
  feature_attributions,
  data_quality_penalty
```

Provide these models:

- Book-only baseline.
- Empirical conditional-frequency lookup.
- Logistic regression.
- Gradient-boosted model if justified.
- Isotonic or Platt calibration layer.
- Optional ensemble that cannot trade until separately walk-forward validated.

Do not use an uncalibrated normal CDF as the live probability.

Use time-series walk-forward validation only. Never random-shuffle future markets into training data. Avoid target leakage from final prices, future book states, resolution status, or post-decision data.

# Fees, break-even, and expected value

Read the live market fee schedule. At specification time, the current crypto fee formula is:

`fee_usd_equivalent = shares * fee_rate * price * (1 - price)`

with observed crypto `fee_rate = 0.07`, maker fee zero, and a maker-rebate pool funded from a configurable percentage of taker fees. These values can change; never hard-code them without a market-schedule override and alert.

For a taker buy when fees are collected in shares:

- Gross shares: `C`
- Fee shares: `C * fee_rate * (1 - price)`
- Net winning shares: `C * (1 - fee_rate * (1 - price))`
- Cost: `C * price`
- Effective break-even probability:

  `p_effective_taker = price / (1 - fee_rate * (1 - price))`

For a maker buy with zero maker fee:

`p_effective_maker = price`

Maker rebates:

- Display estimated rebates separately.
- Exclude rebates from pre-trade edge and sizing by default.
- Add paid rebates to realized P&L only when actually credited.

Expected value:

- Maker per currency unit risked:

  `ev_per_cost = q_conservative / price - 1`

- Taker per currency unit risked:

  `ev_per_cost = q_conservative * (1 - fee_rate * (1 - price)) / price - 1`

A live order is forbidden unless conservative EV exceeds configured minimum edge after fee, spread, latency, slippage, model uncertainty, and fill-selection penalties.

# Risk engine

Risk decisions are pure, deterministic, unit-tested functions. They receive the complete decision snapshot and return APPROVE or REJECT with reasons.

## Risk vocabulary

- `bankroll`: reconciled available collateral plus marked positions according to configured accounting policy.
- `stake`: maximum currency loss if the selected outcome resolves incorrectly.
- `risk_fraction`: stake divided by bankroll.
- `gross_win_profit`: winning payout minus stake before any terminal fee effects.
- `session_drawdown`: current session peak-to-current bankroll decline.
- `daily_drawdown`: UTC-day peak-to-current decline.

## Built-in profiles

### Paper exploration

- Live allowed: no.
- Stake: configurable simulated amount.
- No economic limit, but display equivalent risk.

### Aggressive

- Base risk per filled market: 2%.
- Absolute per-market cap: 5%.
- Session loss stop: 8%.
- Daily loss stop: 12%.
- Consecutive-loss stop: 3.
- One open BTC five-minute position.

### Very aggressive

This profile exists because the operator explicitly requested very aggressive behavior.

- Base risk per filled market: 5%.
- Absolute per-market cap: 10%.
- Session loss stop: 15%.
- Daily loss stop: 20%.
- Consecutive-loss stop: 2.
- One open BTC five-minute position.
- No automatic re-arming after a stop.
- A 10% stake is genuinely extreme: five full losses leave about 59% of starting capital and ten leave about 35%. Display this before activation.

### Custom

- All limits configurable.
- The UI must show projected bankroll after 1, 2, 3, 5, and 10 consecutive full losses.
- Any configuration above 10% per market requires an additional typed acknowledgement and remains blocked in the first production release unless the source code's explicit absolute safety cap is changed and tests are updated.
- Never provide an "all in" preset.

## Kelly support

Optional fractional Kelly sizing:

`full_kelly_fraction = (q_conservative - price) / (1 - price)`

Then:

`requested_fraction = kelly_multiplier * max(0, full_kelly_fraction)`

Cap it by:

- Profile per-market maximum.
- Session remaining loss budget.
- Daily remaining loss budget.
- Available balance.
- Book depth and impact.
- Model-confidence tier.

Default Kelly multiplier:

- Aggressive: 0.25.
- Very aggressive: 0.50.

Never use point-estimate probability for Kelly. Use the conservative probability.

## Target-return calculator

The dashboard may show the stake required to make a requested fraction `g` of bankroll on a winning maker trade:

`required_stake_fraction = g * price / (1 - price)`

For a 1% bankroll profit target:

- At 0.75: risk 3.00% of bankroll.
- At 0.80: risk 4.00%.
- At 0.82: risk 4.56%.
- At 0.83: risk 4.88%.
- At 0.85: risk 5.67%.
- At 0.90: risk 9.00%.
- At 0.95: risk 19.00%.

The calculator must never convert a target return into automatic authorization. At 95 cents, a 1% target requires risking 19% of bankroll and therefore violates the built-in very-aggressive 10% cap.

## Hard rejection rules

Reject a new order when any applies:

- Engine not armed for the requested mode.
- Authoritative Chainlink feed stale.
- Order book stale.
- System clock drift exceeds tolerance.
- Price-to-beat unknown or inconsistent.
- Market rules/resolution source not verified.
- Fee schedule unknown.
- Bankroll reconciliation incomplete.
- Requested stake exceeds profile cap.
- Session/daily loss stop reached.
- Consecutive-loss stop reached.
- Existing open BTC five-minute exposure violates concurrency rules.
- Requested live price exceeds configured ceiling.
- Seconds remaining below the configured entry cutoff.
- Conservative probability does not exceed effective break-even plus minimum edge.
- Expected impact/spread exceeds tolerance.
- Post-only maker order would cross.
- Data-quality score below threshold.
- Model version not approved for live use.
- Strategy has insufficient live/shadow validation.
- Operator cooling-off timer active.
- Duplicate decision/order idempotency key.

# Strategy presets

## Research-only momentum preset

Use only for measurement until validated:

- Candidate window: configurable 60–120 seconds remaining.
- Chainlink direction must match model direction.
- Binance may confirm but cannot override Chainlink.
- Require standardized distance and calibrated probability.
- Require acceptable spread and book depth.
- No RSI-only entry.

## Late-favorite preset

Designed to analyze—but not normalize—the previous 95-cent/30-second behavior:

- Disabled in live mode by default.
- Paper/shadow only until a dedicated walk-forward test passes.
- Price range configurable, initially 0.90–0.99.
- Remaining time initially 10–60 seconds.
- Report how many identical wins one full loss erases.
- Require lower-bound probability above effective break-even by a strict buffer.
- Simulate taker fees and maker non-fill/adverse selection.
- Produce a calibration plot by quoted price: 90–92, 92–94, 94–96, 96–98, 98–99.
- Display exact threshold distance and remaining-volatility percentile.

## Maker-value preset

- Explicit post-only.
- Configurable price improvement from best ask.
- Cancel if the signal invalidates.
- Cancel at configured seconds-remaining cutoff.
- Model probability must be recomputed while resting.
- If conservative edge disappears, cancel immediately.
- Measure fill-conditioned outcomes separately from signal-conditioned outcomes.

# Empirical minute-of-hour findings to seed the research dashboard

The following analysis was run from Polymarket's public Gamma event history for the BTC five-minute series. It used 8,637 resolved markets over approximately 30 days, from 2026-06-30 23:15 UTC through 2026-07-30 23:00 UTC. Outcomes came from resolved market outcome prices. Five-minute return magnitudes were reconstructed where consecutive official price-to-beat values were available; return sample count was 7,891. Recent incomplete markets were excluded.

## Thirty-day result

- Overall Up rate: 50.10%.
- Quarter-hour closing windows at minute 00/15/30/45:
  - N = 2,879.
  - Up = 51.41%.
- Other five-minute closing windows:
  - N = 5,758.
  - Up = 49.44%.
- Quarter vs other direction test:
  - z = 1.72.
  - two-sided p = 0.0855.
  - Not statistically persuasive at 5%.
- Global test across all twelve five-minute closing buckets:
  - chi-square approximately 13.05 with 11 degrees of freedom.
  - p approximately 0.289.
  - No reliable overall minute-of-hour directional effect.

Individual 30-day Up rates:

| Closing minute UTC | N | Up rate | Median absolute five-minute move |
|---:|---:|---:|---:|
| 00 | 720 | 50.00% | 3.45 bps |
| 05 | 719 | 46.87% | 5.63 bps |
| 10 | 719 | 49.37% | 4.97 bps |
| 15 | 720 | 50.28% | 4.74 bps |
| 20 | 720 | 47.64% | 5.55 bps |
| 25 | 720 | 52.22% | 5.69 bps |
| 30 | 719 | 51.32% | 4.25 bps |
| 35 | 720 | 50.14% | 5.70 bps |
| 40 | 720 | 47.92% | 4.91 bps |
| 45 | 720 | 54.03% | 4.70 bps |
| 50 | 720 | 51.53% | 4.48 bps |
| 55 | 720 | 49.86% | 4.73 bps |

The `:45` Up rate had an unadjusted p around 0.0276 versus other buckets, but Bonferroni correction across twelve inspected buckets produced p around 0.332. It is not safe to trade this as a discovered edge.

The exact `:15` close was 50.28% Up. There is no observed directional reason to prefer it.

## Seven-day result

- Overall Up rate: 49.85%.
- Quarter-hour closes: 52.83% Up.
- Other closes: 48.36% Up.
- Difference p approximately 0.0587.
- `:15` close: 49.40% Up.
- `:45` close: 58.93% Up.
- `:45` raw p approximately 0.014; multiple-comparison-corrected p approximately 0.168.
- Global twelve-bucket p approximately 0.489.

This recent `:45` run is a monitoring candidate, not a live signal. The app must label it "unconfirmed / likely selection-sensitive."

## Volatility and liquidity finding

The stronger result was lower movement, not direction:

- All windows median absolute move: 4.87 bps.
- Quarter-hour closes median absolute move: 4.25 bps.
- Other closes median absolute move: 5.18 bps.
- Rank-based quarter-vs-other p approximately `6.6e-11`.
- Quarter-hour mean absolute move: 6.44 bps.
- Other mean absolute move: 7.35 bps.
- Quarter-hour p90 absolute move: 14.48 bps.
- Other p90 absolute move: 16.33 bps.
- Median recorded market volume:
  - Quarter-hour closes: approximately 71.6k.
  - Other closes: approximately 74.9k.

Interpretation:

- Quarter-hour closes were calmer in this sample.
- Calmness is not automatically profit because Polymarket prices can incorporate it.
- Lower movement can make a fixed dollar threshold distance more meaningful, but the model must condition on volatility and compare probability against executable price.
- Do not hard-code this relationship. Recompute rolling 7-, 14-, 30-, 60-, and 90-day views.

## Timing Lab requirements

Create a dedicated Timing Lab page:

- Up/Down outcome rates by closing minute.
- Wilson confidence intervals.
- Raw and multiple-comparison-adjusted p-values.
- Quarter-hour vs other comparison.
- Absolute-return distribution by bucket.
- Volume, spread, depth, and maker-fill rate by bucket.
- Calibration by quoted price and seconds remaining.
- Realized EV by bucket after fee and simulated/live execution.
- Rolling-window stability.
- Walk-forward train/test separation.
- Toggle between UTC and local display, while calculations remain UTC.
- A prominent warning: "Outcome skew is not trading edge unless price fails to reflect it."

# Order execution

## Maker-first default

For maker orders:

1. Read current best ask and tick size.
2. Compute desired price from model value and configuration.
3. Ensure price is strictly non-marketable at submission time.
4. Submit as explicit post-only GTC or GTD.
5. Use an idempotency key derived from decision ID and intent version.
6. Verify returned status.
7. If rejected for crossing, do not silently convert to taker.
8. Continue recomputing conservative edge.
9. Cancel on invalidation, stale data, risk stop, or cutoff.
10. Track partial fills and ensure total stake never exceeds approved stake.

## Taker exception path

Taker orders may be enabled only when:

- The live strategy explicitly permits them.
- Conservative edge remains positive after current fee schedule, spread, slippage, latency, and uncertainty.
- Expected taker EV exceeds maker EV adjusted for fill probability.
- Size can execute inside impact limits.
- Operator and risk profile permit it.

At 95 cents and a 0.07 crypto fee parameter, the effective break-even probability is approximately 95.33%. Show this calculation in the decision inspector.

## Cancellation

- Configurable cancel cutoff, default 45 seconds remaining for maker-value experiments.
- Very-aggressive live profile default: no new entries under 60 seconds until a validated strategy version changes the cutoff.
- Cancel if authoritative distance, volatility regime, probability, or book state invalidates the original edge.
- Confirm cancellation; unresolved cancellation state blocks a replacement order.
- Use heartbeat/cancel-all protection if supported.

## Exits

- Default five-minute strategy assumes the stake can go to zero.
- Never assume an exit is available.
- Support tested exit policies:
  - hold to resolution,
  - threshold-cross invalidation,
  - probability-vs-executable-bid exit,
  - time-based exit.
- A live strategy version must select exactly one approved exit policy before entry.
- Do not permit ad hoc automatic switching among exit policies.

# Decision snapshot

Before any simulated, shadow, or live order, persist:

- Market/event/condition/token IDs.
- Exact rules and resolution source hash.
- Market start/end.
- Local and UTC decision time.
- Seconds remaining.
- Chainlink price-to-beat.
- Chainlink current price and timestamp.
- Binance price and timestamp.
- Distance in dollars/bps/z-score.
- Recent volatility features.
- Threshold crossings.
- Complete relevant order-book snapshot.
- Bid, ask, midpoint, spread, depth, microprice.
- Fee schedule.
- Requested side, price, shares, stake, and maximum loss.
- Maker/taker intent.
- Model version and probability estimate.
- Conservative probability and uncertainty.
- Effective break-even probability.
- Expected value before and after modeled friction.
- Risk profile and every risk-limit value.
- Bankroll.
- Stake as bankroll fraction.
- Target-return calculation if displayed.
- Approval/rejection reasons.
- Feed freshness, latency, and clock health.
- Configuration version.
- Engine build/version.

Render this snapshot in a human-readable trade-detail page.

# Admin dashboard

Create a dark, information-dense but calm professional interface. It should resemble a trading operations console, not a casino. Use red only for actual risk/errors and green only for confirmed positive states. Do not use celebratory animations after wins.

## Global header

- Mode badge: OBSERVE/PAPER/SHADOW/LIVE.
- Armed/disarmed state.
- Emergency stop.
- Wallet connection health.
- Reconciled bankroll.
- Current exposure and maximum possible loss.
- Session and daily P&L.
- Session and daily drawdown.
- Chainlink/CLOB/RTDS health.
- UTC clock with measured drift.
- Current market countdown.

## Main cockpit

- Current and next market.
- Exact price-to-beat.
- Large authoritative Chainlink price.
- Signed distance in dollars, bps, and standardized units.
- Up and Down executable bid/ask.
- Model probability, conservative probability, effective break-even, and edge.
- Fee impact.
- Recommended action: no trade, observe, maker candidate, taker candidate, cancel, exit.
- Exact reason list.
- Position-sizing card for each risk profile.
- "One loss erases N wins" card.
- Recent threshold-cross timeline.
- Data freshness and latency.

## Market ladder

- Full order book for both outcomes.
- Best bid/ask, spread, depth, and hypothetical impact.
- Existing orders and queue estimates.
- Post-only price chooser.
- Partial-fill display.

## Signal inspector

- Every feature with timestamp.
- Model contribution/attribution.
- Raw vs conservative probability.
- Uncertainty and data-quality penalties.
- Book-only baseline comparison.
- Strategy gate checklist.
- "What would have to change?" explanation for rejected signals.

## Risk center

- Profile editor.
- Bankroll basis.
- Per-trade, session, daily, and consecutive-loss limits.
- Price ceiling.
- Entry-time cutoff.
- Maximum number of open positions.
- Kelly multiplier.
- Minimum conservative edge.
- Impact and spread limits.
- Data-staleness thresholds.
- Drawdown simulations.
- Projected bankroll after loss streaks.
- Typed acknowledgement for very-aggressive mode.

## Orders and positions

- Live/open/canceled/rejected/resolved tables.
- Filter by mode, strategy, side, maker/taker, minute bucket.
- Order and fill timelines.
- Decision snapshot link.
- Fee and rebate reconciliation.
- Position outcome and P&L.

## P&L analytics

- Gross, fee, slippage, rebate, and net P&L.
- P&L by strategy version.
- P&L by maker/taker.
- P&L by quoted-price bucket.
- P&L by seconds-remaining bucket.
- P&L by closing minute.
- P&L by volatility regime.
- Win rate versus average paid probability.
- Brier score and calibration.
- Maximum drawdown.
- Profit factor.
- Expected vs realized P&L.
- Fill-conditioned versus all-signal results.

## Backtest and replay

- Select date range and strategy/config version.
- Choose historical source.
- Configure latency, fee schedule, queue/fill model, impact, and cancellation.
- Run walk-forward tests.
- Replay any market tick by tick with the dashboard frozen to historical time.
- Display what the engine knew at each moment.
- Never expose future values during replay until time advances.

## Timing Lab

Implement all requirements in the empirical timing section.

## System health

- Feed connections.
- Heartbeats.
- Message rates.
- Clock drift.
- Database/Redis health.
- Order reconciliation.
- Error rates.
- Latency histograms.
- Recent restarts.
- Current engine state.

## Configuration

- Typed schema-driven forms.
- Change preview.
- Validation errors.
- Version history.
- Diff viewer.
- Rollback.
- Live-impact warnings.
- Configuration changes during a live position must not retroactively change the position's recorded policy.

## Audit log

- Append-only view.
- Mode changes.
- Arming/disarming.
- Configuration changes.
- Risk approvals/rejections.
- Orders, fills, cancels, exits.
- Credential lifecycle events without secret contents.
- Kill switches and incidents.

# Configuration schema

Implement a validated configuration equivalent to:

```yaml
app:
  timezone_display: Europe/Madrid
  calculation_timezone: UTC
  mode: paper
  bind_host: 127.0.0.1
  require_auth: true

market:
  asset: BTC
  series_slug: btc-up-or-down-5m
  duration_seconds: 300
  discover_ahead_windows: 3
  rules_must_name_chainlink: true

feeds:
  chainlink:
    required: true
    max_age_ms: 1500
    max_gap_ms: 2500
  binance:
    required: false
    max_age_ms: 1500
  clob:
    max_book_age_ms: 1000
  clock:
    max_drift_ms: 100

strategy:
  active_version: book_distance_v1
  candidate_seconds_remaining_min: 60
  candidate_seconds_remaining_max: 120
  live_entry_cutoff_seconds: 60
  paper_entry_cutoff_seconds: 15
  min_conservative_edge: 0.02
  min_expected_value_per_cost: 0.01
  live_price_ceiling: 0.90
  maker_only: true
  allow_taker: false
  cancel_seconds_remaining: 45
  volatility_model: empirical_ewma
  probability_model: calibrated_logistic
  calibration_required: true
  minute_bucket_standalone_signal: false

risk:
  profile: very_aggressive
  base_risk_fraction: 0.05
  max_risk_fraction: 0.10
  session_loss_limit: 0.15
  daily_loss_limit: 0.20
  consecutive_loss_limit: 2
  max_open_positions: 1
  kelly_multiplier: 0.50
  no_martingale: true
  no_averaging_down: true
  auto_rearm: false

execution:
  post_only: true
  time_in_force: GTD
  permit_partial_fills: true
  max_price_impact: 0.005
  max_spread: 0.02
  idempotency_required: true
  reconcile_after_every_fill: true

paper:
  simulated_latency_ms: 350
  queue_model: conservative
  partial_fill_model: true
  adverse_selection_penalty: true
  current_fee_schedule: true

live:
  enabled: false
  arming_token_ttl_minutes: 30
  require_typed_acknowledgement: true
  require_wallet_reconciliation: true
  require_shadow_validation: true
  kill_switch_hotkey: true

research:
  rolling_windows_days: [7, 14, 30, 60, 90]
  multiple_testing_correction: benjamini_hochberg_and_bonferroni
  walk_forward_only: true
  minimum_candidate_count: 1000
  minimum_fill_count_before_live: 300
```

Store config versions in the database. Environment variables may override deployment/secrets only, not silently override risk limits.

# Research and validation standards

Before a strategy becomes live-eligible:

- At least 1,000 out-of-sample candidate decisions.
- At least 300 realistically simulated or shadow fills.
- Positive net EV after current fees, spread, latency, conservative fill assumptions, and adverse selection.
- Positive lower confidence bound for EV under the chosen statistical method.
- Calibration chart without material overconfidence in the traded probability range.
- No single day, minute bucket, or volatility regime responsible for most profits.
- Walk-forward stability across multiple windows.
- Report maximum drawdown and longest losing streak.
- Report sensitivity to 2x latency, one-tick worse price, missed cancels, and reduced fill probability.
- Compare against a no-signal book-probability baseline.
- Keep paper, shadow, and live results separate.

External research noted at specification time found no tradable out-of-sample edge from a sophisticated Binance/Polymarket feature set on BTC fifteen-minute markets after fees and slippage. Treat this as a warning against assuming obvious cross-market momentum is profitable.

# Safety and incident behavior

## Automatic halt conditions

- Chainlink disconnect or staleness.
- CLOB disconnect or stale book.
- Clock drift.
- Unhandled sequence gap.
- Duplicate market identity.
- Price-to-beat disagreement.
- Wallet balance mismatch.
- Local order differs from exchange order state.
- Unknown open order.
- Unknown position.
- Repeated submission error.
- Fee schedule changed during an armed session.
- Risk-limit breach.
- Database unavailable for durable audit.
- Engine exception in the decision or risk path.

On halt:

1. Stop new entries.
2. Attempt safe cancellation of resting orders if connectivity permits.
3. Do not assume cancellation succeeded.
4. Reconcile.
5. Notify dashboard prominently.
6. Require manual review and re-arm.

## Emergency stop

- Available on every page.
- Keyboard shortcut with confirmation.
- Immediately disables new orders.
- Cancels resting orders where possible.
- Does not blindly market-exit filled positions.
- Presents positions requiring manual resolution decisions.
- Writes an audit event.

# Authentication and security

- Local single-user authentication with passkey or strong password plus optional TOTP.
- CSRF protection.
- Secure, HTTP-only cookies.
- Rate-limited authentication.
- Short sessions for live controls.
- Re-authentication for credential changes and live arming.
- Backend-only secrets.
- Content Security Policy.
- Dependency scanning and lockfiles.
- Redacted logs.
- Encrypted database fields for sensitive metadata.
- Database backups must not contain plaintext keys.
- Threat-model document covering browser compromise, stolen database, malicious dependency, replayed order, duplicated process, stale feeds, and operator error.

# Database and retention

- PostgreSQL migrations checked into source control.
- Partition or hypertable high-frequency ticks by time.
- Configurable retention:
  - Raw price ticks: 90 days default.
  - Raw order-book deltas: 30 days default.
  - Minute/second aggregates: indefinite.
  - Decisions/orders/fills/resolutions/audit: indefinite.
- Background compaction.
- Export any backtest or trade audit to JSON/CSV/Parquet.
- Referential integrity between decision, risk decision, order, fill, position, and resolution.

# Observability

Metrics:

- Feed age and latency.
- Messages/sec.
- Reconnects.
- Clock drift.
- Decision rate.
- Candidate and rejection counts by reason.
- Order latency.
- Maker/taker ratio.
- Post-only rejection rate.
- Fill rate and partial-fill rate.
- Adverse selection after fill.
- Cancel latency and failure rate.
- P&L and drawdown.
- Calibration error.
- Risk utilization.

Logs:

- Structured JSON.
- Correlation IDs.
- No secrets.
- Decision and order logs durable before external mutation where feasible.

Alerts:

- Browser notifications and optional local email/webhook adapters.
- Separate informational, warning, critical.
- Critical alert for any live reconciliation mismatch.

# Testing

## Unit tests

- Fee calculations at 0.50, 0.75, 0.80, 0.85, 0.90, 0.95.
- Effective taker break-even.
- Target-return sizing.
- Kelly sizing and caps.
- Drawdown and consecutive-loss stops.
- Maker/taker classification.
- Tick-size rounding.
- Partial-fill exposure.
- No over-allocation across concurrent decisions.
- Minute-bucket assignment.
- Multiple-testing corrections.
- State-machine transitions.
- Staleness and clock-drift gates.

## Integration tests

- Gamma discovery from fixtures and optional live public smoke test.
- CLOB book subscription.
- RTDS Chainlink/Binance subscription.
- Heartbeat/reconnect.
- Paper order through resolution.
- Post-only crossing rejection.
- Partial fill then cancel.
- Restart/reconciliation.
- Database outage fail-closed.
- Fee-schedule change halts armed engine.

## Property tests

- Stake never exceeds approved maximum under any combination of partial fills/retries.
- No live order without armed state.
- No live order without durable decision snapshot.
- No order when any required feed is stale.
- P&L accounting conserves cash/shares under fills and resolution.

## End-to-end tests

- First-run onboarding into paper mode.
- View current market.
- Run paper strategy.
- Inspect decision.
- Change config and see version diff.
- Trigger risk rejection.
- Trigger emergency stop.
- Backtest and replay.
- Arm flow using a mocked trading adapter.

# Local developer experience

Provide:

- `pnpm install`
- `pnpm dev`
- `pnpm test`
- `pnpm test:e2e`
- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `docker compose up -d postgres redis`
- A single convenience command such as `pnpm bootstrap`.

Seed the application with:

- The empirical minute-bucket findings in this specification.
- A deterministic sample five-minute market.
- The earlier 95-cent late-favorite case:
  - 839 gross shares at 0.95.
  - approximately 797.05 cost.
  - 41.95 gross profit if 839 winning shares are paid.
  - current fee-equivalent estimate around 2.79 under the cited formula.
  - one full loss erases roughly 19 gross wins and more after fee effects.
- Use it as a tutorial demonstrating why outcome quality and decision quality differ.

# UX copy requirements

Use direct language:

- "No verified edge."
- "Maker status not confirmed."
- "A loss at this price erases approximately N wins."
- "The Chainlink distance was not captured; this decision cannot be audited."
- "Minute-of-hour pattern is not statistically confirmed."
- "Target profit requires risk above your configured cap."
- "Live trading is disarmed."
- "Order rejected safely."

Avoid:

- "Guaranteed."
- "Safe bet."
- "Easy 1%."
- "Almost certain."
- Celebratory gambling language.

# Acceptance criteria

The build is complete only when:

1. A new user can clone, configure, and start the app locally from the README.
2. The dashboard discovers and displays the active BTC five-minute market.
3. Live Chainlink and CLOB data update in the UI with freshness indicators.
4. The paper engine can evaluate, reject/approve, simulate, resolve, and account for a trade.
5. Every paper decision has a complete reconstructable snapshot.
6. Risk profiles, including Very Aggressive, work and cannot exceed their caps.
7. The target-return calculator correctly rejects a 1% target at 0.95 under a 10% maximum-risk cap.
8. The Timing Lab reproduces the seeded empirical table and can refresh it from Gamma.
9. Maker orders in the mocked/live-sandbox path use explicit post-only semantics and never silently become takers.
10. Taker EV includes the current fee schedule.
11. Stale Chainlink or order-book data blocks trading.
12. Emergency stop disables entry and attempts resting-order cancellation.
13. Restart reconciliation works.
14. Unit, integration, and end-to-end tests pass.
15. The production build succeeds.
16. No secrets are committed or exposed to the browser.
17. Live trading remains disabled until the deliberate arming sequence is completed.

# Build sequence for Fable

1. Inspect this specification completely.
2. Verify current Polymarket official docs, current SDK packages, CLOB V2 signing, fee schema, and WebSocket messages.
3. Write an architecture decision record.
4. Scaffold the monorepo and local infrastructure.
5. Implement domain types, exact math, database schema, and risk engine first.
6. Implement public feeds and persistent market capture.
7. Implement paper execution and replay.
8. Build the dashboard around real paper-engine state.
9. Implement research/Timing Lab and seeded analysis.
10. Implement wallet/live adapter behind a disabled feature flag.
11. Implement reconciliation, kill switch, and security.
12. Add tests at every layer.
13. Run the full app, inspect it visually, fix errors and layout problems.
14. Run lint, typecheck, unit, integration, E2E, and production build.
15. Document remaining limitations explicitly.

# References to verify during build

- Polymarket market-data overview: `https://docs.polymarket.com/market-data/overview`
- Real-time data and WebSockets: `https://docs.polymarket.com/market-data/realtime-data`
- Market details and constraints: `https://docs.polymarket.com/market-data/market-details`
- Order lifecycle and post-only: `https://docs.polymarket.com/concepts/order-lifecycle`
- Order creation: `https://docs.polymarket.com/trading/orders/create`
- Fees: `https://docs.polymarket.com/trading/fees`
- Maker rebates: `https://docs.polymarket.com/programs/maker-rebates`
- Gamma keyset events: `https://docs.polymarket.com/api-reference/events/list-events-keyset-pagination`
- Historical prices: `https://docs.polymarket.com/api-reference/markets/get-prices-history`
- Geographic restrictions: `https://help.polymarket.com/en/articles/13364163-geographic-restrictions`
- Example BTC five-minute rules: inspect a current `btc-updown-5m-*` market.
- OpenMarket research warning: `https://arxiv.org/abs/2607.26245`

# Final instruction

Build the safest possible implementation of an intentionally aggressive research and execution system. "Very aggressive" means configurable 5–10% maximum loss per approved market with strict session/daily stops, not all-in behavior. The system's primary job is to refuse trades lacking auditable edge, expose the exact risk of approved trades, and make it impossible to confuse a lucky win with a good decision.
