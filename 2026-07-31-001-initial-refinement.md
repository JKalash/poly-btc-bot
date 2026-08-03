---
fable_spec_version: "1.0"
project_name: "BTC Five-Minute Polymarket Command Center"
project_slug: "5min-btc-poly"
document_type: "autonomous-refinement-brief"
document_id: "2026-07-31-001-initial-refinement"
status: "ready-for-build"
generated_at: "2026-07-31"
default_timezone: "Europe/Madrid"
trading_timezone: "UTC"
parent_specification: "polymarket.fable"
refinement_scope: "source synthesis, empirical research, execution quality, and market-making safety"
default_mode: "paper"
live_trading_default: false
build_priority: "falsifiability, capital protection, execution realism, observability, then speed"
source_reddit: "https://www.reddit.com/r/PredictionsMarkets/comments/1uoqskg/how_efficient_are_polymarkets_5min_crypto_markets/"
source_gist: "https://gist.github.com/Archetapp/7680adabc48f812a561ca79d73cbac69"
source_gist_file: "PolymarketBot.md"
source_gist_revision_observed: "e45340873b7a2e2f2f3e6663cf77f667e61cc0b7"
sources_inspected_at: "2026-07-31"
---

# Refinement mission

Refine the existing BTC five-minute Polymarket application into a better bot by turning every useful claim in the Reddit analysis and the Archetapp gist into one of:

1. a reproducible empirical result,
2. a paper/shadow-only strategy hypothesis,
3. an execution or inventory-management capability,
4. a hard safety constraint,
5. a clearly labeled unresolved question, or
6. a rejected anti-pattern with a regression test.

Do not copy either source's confidence. Preserve its data, test its claims, and improve the system's ability to learn from real decisions and real fills.

The central refinement is:

> The bot is not better because it trades more often or predicts more confidently. It is better when it can prove what it knew, estimate what could actually fill, reject negative-EV trades, measure adverse selection, reconcile inventory, and distinguish an apparent signal from executable edge.

This file is an additive refinement of `polymarket.fable`. Read the parent specification completely before implementing this file. The parent remains authoritative unless this refinement is stricter. If the two conflict, use the requirement that:

- protects more capital,
- relies on the actual market rules and live fee schedule,
- uses more authoritative data,
- makes fewer unverified assumptions,
- provides stronger auditability, or
- keeps an unvalidated behavior out of live mode.

This is an autonomous build instruction, not an essay. Inspect the existing repository, preserve working modules, implement the refinement end to end, test it, run it, inspect the UI, and document anything that remains incomplete.

# What "better bot" means

A better bot must improve all five layers:

1. **Truth:** use the exact market rules, authoritative Chainlink stream, actual order book, actual fee schedule, exchange state, and reconciled token balances.
2. **Inference:** estimate calibrated outcome probabilities and uncertainty without confusing a score, price move, or win rate with edge.
3. **Decision:** compare conservative probability with executable break-even after all expected frictions.
4. **Execution:** model and measure latency, queue position, partial fills, adverse selection, leg risk, cancellation, and reconciliation.
5. **Learning:** replay every decision, compare forecasts with outcomes and fills, reproduce cited studies, and promote strategies only through walk-forward evidence.

Do not optimize for:

- number of trades,
- headline win rate,
- the largest backtest bankroll,
- a fixed return per window,
- leaderboard resemblance,
- the highest uncalibrated confidence score, or
- a lucky streak.

# Evidence policy

The linked sources are research inputs, not verified ground truth.

For every source-derived datum stored in code, fixtures, or the database, record:

- source URL,
- source title,
- source revision or retrieval date where available,
- whether it is a direct source claim, a derived calculation, an official fact, or an internal reproduction,
- asset,
- time range,
- sample count,
- decision time,
- price type,
- execution assumption,
- fee assumption,
- outcome source,
- known limitations,
- reproduction status,
- code version,
- data checksum, and
- result artifact ID.

Use these evidence labels:

- `SOURCE_CLAIM_UNVERIFIED`
- `SOURCE_CLAIM_PARTIALLY_SPECIFIED`
- `OFFICIAL_CURRENT_AT_RETRIEVAL`
- `REPRODUCED_MATCH`
- `REPRODUCED_MISMATCH`
- `INTERNAL_HYPOTHESIS`
- `LIVE_VALIDATED`
- `REJECTED_ANTI_PATTERN`

Never display a source claim as a confirmed edge. Never silently convert a source percentage into a live configuration.

# Current repository refinement baseline

At the time this brief was created, the repository already contained early implementations of:

- exact/fixed-point domain math,
- fee and break-even functions,
- Kelly and stake sizing,
- state machines,
- statistical helpers,
- configuration validation,
- database schema/migrations,
- pure risk evaluation,
- strategy features and indicators,
- a book/distance strategy,
- an uncalibrated seven-indicator Binance composite, and
- a late-snipe preset restricted to observe, paper, and shadow.

The repository did not yet contain the complete application surface required by the parent brief. Inspect current state rather than assuming this snapshot is still exact.

Preserve these good properties:

- all money and order construction use exact decimal/fixed-point types,
- uncalibrated models cannot authorize live trades,
- the book-only model is a null baseline,
- the gist-derived composite is labeled uncalibrated,
- Binance can confirm or diagnose but cannot override Chainlink,
- late-snipe behavior is not live-eligible,
- risk evaluation returns every rejection reason, and
- no unsafe source behavior can bypass the parent hard gates.

# Source A: Reddit analysis evidence ledger

Source:

`https://www.reddit.com/r/PredictionsMarkets/comments/1uoqskg/how_efficient_are_polymarkets_5min_crypto_markets/`

Treat the following as source claims to reproduce, not facts to hard-code.

## Claimed research scope

- Approximately seven months of building and research.
- Approximately 1.7 million candles.
- Elsewhere described more precisely as 1.73 million ETH one-minute bars over approximately three years.
- Approximately 4,600 real resolved five-minute windows.
- Elsewhere described as 4,604 resolved windows.
- A favored-side study described as 4,569 decisions across those 4,604 windows.
- Tested themes:
  - arbitrage,
  - Binance/Chainlink or spot/book lag,
  - momentum,
  - directional continuation,
  - sustained trends,
  - favorite and cheap-side price bands,
  - timing filters,
  - stop losses,
  - break-even arming,
  - take profits,
  - maker versus taker execution,
  - split/merge mechanics,
  - maker rebates,
  - and leaderboard-wallet behavior.

The post's global conclusion is that the book is highly calibrated, most obvious directional edges are priced away, fees turn many coin-flip strategies negative, and execution is the main controllable variable.

## Market mechanics claimed by the source

- Each five-minute market sets a strike from the Chainlink price at the opening boundary.
- It resolves using the Chainlink price at the closing boundary.
- Up wins when close is greater than or equal to strike.
- The source uses a taker-fee parameter of `0.072` in:

  `fee_equivalent = shares * 0.072 * price * (1 - price)`

- The source says makers pay zero fee.
- The source reports approximate taker break-even win rates:
  - 51.8% at price 0.50,
  - 66.6% at price 0.65.
- It characterizes the fee wedge near 0.50 as approximately 1.8 percentage points compared with a zero-fee maker.

Required interpretation:

- Preserve `0.072` only as the parameter claimed by this source.
- Do not use it as a runtime default without a versioned source fixture.
- Current official documentation observed when this refinement was written listed a crypto taker fee-rate parameter of `0.07`, maker fee `0`, per-market fee schedule fields, and a 20% crypto maker-rebate allocation. These can change.
- Runtime pricing must use the market's live `feeSchedule`, not either prose value.
- The UI must show the exact fee formula, collection method, rounding, and effective break-even used for each decision.
- The research layer must be able to rerun a study with both the historical source assumption and the actual schedule applicable to each market.

## Lag/arbitrage result

The source reports an "arm-and-watch" test with:

- 5,826 entries,
- offset-corrected feeds,
- momentum-side resolution rate of 74.8%,
- observed Polymarket ask of 75.3%,
- a reported gap of negative 0.4 percentage points,
- and the conclusion that there was no fillable lag.

Note the visible rounded values subtract to negative 0.5 percentage points, while the post reports negative 0.4. Preserve this as a reconciliation issue rather than silently correcting it.

The source also reports:

- an apparent Chainlink/Binance offset strategy showing approximately +$456,
- a structural ETH Binance-to-Chainlink offset of approximately 0.12%,
- an entry threshold of 0.10%,
- and disappearance of the apparent profit after offset correction.

Required lesson:

- Absolute cross-feed difference is not a signal until the rolling asset-specific level, scale, clock offset, lead/lag, and regime are estimated using only past data.
- Any threshold smaller than the normal cross-feed basis will fire structurally and create a false edge.
- A lag result must compare outcome probability with the executable price available after realistic decision and order latency, not only whether the signal predicted direction.

## Momentum and continuation result

The source reports:

- 346,094 windows,
- 1.73 million ETH one-minute bars,
- approximately three years of data,
- no lookahead,
- strike equal to the window open,
- outcome equal to the window close.

Claimed continuation rates:

| Prior move filter | Continuation win rate |
|---|---:|
| Any | approximately 49.0% |
| At least 0.10% | 48.0% |
| At least 0.40% | 46.5% |

Required lesson:

- Reproduce on BTC and ETH separately.
- Do not transfer an ETH candle result to BTC live trading without BTC validation.
- Test whether the apparent mean reversion remains after using the exact Chainlink boundary values, executable outcome-token prices, and event-time fills.

## Sustained-trend result

Claimed continuation rates:

| Trend filter | N | Continuation win rate |
|---|---:|---:|
| At least 2 consecutive same-direction five-minute blocks | 168,815 | 48.4% |
| At least 3 | 81,364 | 47.6% |
| At least 4 | 38,571 | 46.4% |
| At least 5 | 17,856 | 46.1% |
| At least 4 and at least 0.8% total move | 5,873 | 44.8% |

The source interprets the monotonic decline as mean reversion after stronger and longer moves.

Required lesson:

- Add run length, cumulative move, path shape, volatility regime, distance from strike, and seconds remaining as research features.
- Test continuation and reversal as separate labels.
- Require year-by-year and asset-by-asset stability.
- Do not trade the inversion until the price paid, fill process, and adverse selection are included.

## Favored-side price-band result

The source describes 4,569 decisions over 4,604 resolved windows using recorded real books and a hold-to-resolution favored-side buy at the actual ask with the source's fee assumption.

Claimed band results:

| Ask band | N | Actual win rate | Claimed break-even | Actual minus break-even |
|---|---:|---:|---:|---:|
| 0.50–0.55 | 466 | 49.8% | 54.3% | -4.5pp |
| 0.55–0.60 | 604 | 57.1% | 59.3% | -2.1pp |
| 0.60–0.65 | 671 | 60.5% | 64.2% | -3.7pp |
| 0.65–0.70 | 636 | 62.6% | 69.1% | -6.5pp |
| 0.70–0.80 | 1,107 | 74.7% | 76.3% | -1.6pp |
| 0.80–0.95 | 958 | 84.7% | 88.3% | -3.6pp |

The displayed band counts sum to 4,442, not 4,569. The reproduction report must account for the missing 127 decisions, such as excluded prices, missing books, boundary conventions, or reporting error.

Required lesson:

- Price is a forecast and a cost.
- Win rate must be compared with effective break-even, not 50%.
- Report calibration and net EV within every price band.
- Include confidence intervals and sample selection.
- Test both outcomes symmetrically and de-duplicate complementary observations from the same market.

## Trend-side price result

Within a confirmed 30-minute trend, the source reports 1,262 real decisions:

| Price paid for trend-direction side | N | Win rate |
|---|---:|---:|
| 0.00–0.45 | 559 | 30.8% |
| 0.45–0.55 | 175 | 42.9% |
| 0.55–0.70 | 263 | 58.6% |
| 0.70–1.00 | 265 | 84.2% |

The counts reconcile to 1,262.

Required lesson:

- Cheapness is not a discount without a probability estimate exceeding price plus friction.
- A low-priced trend-side token may be cheap because the market already expects reversal.
- Add this exact table as a source fixture and require an internal reproduction.

## Timing-filter result

The source says it tested:

- skipping the first 60–120 seconds,
- skipping the last 60–80 seconds,
- and observed that approximately the final 0–60 seconds were weaker or noisier.

It says filtering bad windows reduced the sample but did not make the remaining strategy net positive.

Required lesson:

- Treat entry time as an interaction among information gain, price deterioration, reversal hazard, spread, latency, and fill probability.
- Never label T-10 seconds, T-5 seconds, or any other time a "sweet spot" without an out-of-sample net-EV surface.

## Exit-engineering result

The source reports:

- trailing stops at every tested percentage consistently cut winners,
- 58% of eventual winners first fell approximately 10% before recovering,
- moving a stop to break-even after a +5% move was net negative in one study,
- take-profit ladders capped winners needed to offset losses,
- winners' first pullback averaged approximately 22 percentage points,
- 97% of those winner pullbacks recovered,
- losers' first pullback averaged approximately 38 percentage points,
- loser pullbacks were approximately 1.7 times deeper,
- only approximately 32% of loser pullbacks recovered,
- and winners and losers were difficult to separate in the first few seconds.

Required lesson:

- Exit studies must be conditioned on the actual executable bid and fill probability.
- Compare hold-to-resolution against exits with paired decisions from the same entry snapshot.
- Estimate censoring and survivorship effects.
- A stop rule is not protective if it converts normal winner volatility into realized losses.

## Execution and adverse-selection result

The source reports or argues that:

- backtests that assume an immediate fill at the observed price overstate results,
- real fills can be 2–10 cents worse, partial, or absent,
- failed fills occur disproportionately during fast moves,
- taker fees and the exit spread can erase small paper edges,
- makers avoid taker fees but do not avoid adverse selection,
- a resting bid tends to fill when the token is becoming less valuable,
- being filled is information,
- unfilled maker orders and filled maker orders must be evaluated separately,
- FAK orders can partially fill and reprice,
- balance/allowance races can occur while partial-fill shares are reserved,
- the exchange/API can temporarily report a fill before reconciled on-chain balances agree,
- exits execute at the bid rather than the midpoint,
- and clean fee math is an optimistic floor for break-even.

Required lesson:

- Build the bot as an execution-measurement system.
- Store decision-time book, send-time book, acknowledgment-time book, fill-time book, and post-fill books.
- Measure signal-conditioned outcomes separately from fill-conditioned outcomes.
- Create counterfactuals for unfilled orders without pretending they filled.

## Two-legged maker and CTF claims

The source explains:

- `SPLIT`: one unit of collateral becomes one Up and one Down token.
- `MERGE`: equal Up and Down tokens become one unit of collateral.
- A complete pair is collateralized and one side eventually pays one.
- Illustrative split-sell:
  - split for 1.00,
  - sell Up at 0.52,
  - sell Down at 0.50,
  - collect 1.02 if both fills actually complete.
- Illustrative buy-both-and-merge:
  - buy Up at 0.64,
  - buy Down at 0.33,
  - combined cost 0.97 before friction,
  - merge for 1.00 if both legs are acquired and merge completes.

The source also gives the adverse-selection failure path:

- only one quote fills,
- the other token reprices,
- the bot becomes directionally exposed,
- dumping the survivor crosses spread and may pay a taker fee,
- merging is impossible without equal paired inventory,
- and a static "risk-free" spread becomes a latency-sensitive market-making cycle.

Required lesson:

- Never call split-sell or buy-both-and-merge risk-free before both legs and the merge/redeem state are reconciled.
- Track leg risk continuously.
- Model gas/relayer behavior, allowances, transaction latency, partial fills, inventory reuse, and opportunity decay.
- Require a maximum unhedged inventory duration and loss budget.

## Whale and leaderboard claims

Preserve as unverified anecdotes requiring wallet-level reproduction:

- wallets earning more than $100,000 per month,
- one wallet described as approximately $143,000 per month over approximately 39,000 predictions,
- split-sell clips of approximately $500–$2,000 per market,
- an illustrative wallet compounding $5 to $445 in five days,
- buy-both-and-merge clips of 100 or more shares,
- extreme orders around 1–3 cents and 95–97 cents,
- individual resolved losses of approximately $3,800 and $6,100,
- and the interpretation that spread capture, inventory operations, scale, fee avoidance, and rebates may explain results better than directional prediction.

Do not infer causality from public P&L alone. The source and a commenter acknowledge survivorship bias in the $5-to-$445 example.

Any wallet study must:

- include all visible deposits, withdrawals, splits, merges, redeems, transfers, rewards, rebates, and open positions,
- separate trading P&L from capital flows,
- reconstruct inventory cost basis,
- handle linked proxy/funder wallets,
- use a complete observation interval,
- include inactive and failed wallets where the sampling frame permits,
- and report uncertainty caused by unavailable off-chain data.

## Maker incentives

The source describes two potentially distinct programs:

- maker rebates funded from taker fees and paid on executed maker liquidity,
- liquidity rewards for competitive resting quotes near the midpoint.

The Reddit post initially portrays rebates/rewards as an important stacked income stream. In discussion, the author accepts the criticism that rebates are better viewed as a tailwind than the core engine and that spread plus scale are the stronger claimed drivers.

Required lesson:

- Model rebates and liquidity rewards separately.
- Do not merge their eligibility formulas.
- Do not accrue either as guaranteed pre-trade EV.
- Add only paid, reconciled rewards to realized P&L.
- Track expected, accrued, pending, paid, and disputed amounts.
- Version the program rules and market eligibility.

## Mean-reversion caveat

The source's only directional hypothesis described as having a faint positive signal is fading an extended move.

Claimed reversal rates after a strong 20-minute run:

| Year | Reversal rate |
|---|---:|
| 2023 | 53.8% |
| 2024 | 51.6% |
| 2025 | 54.5% |
| 2026 | 54.6% |

The source frames this as approximately a four-point paper edge at a 0.50 zero-fee maker price, while explicitly stating that real maker fills and adverse selection were not proven.

Required lesson:

- Implement `extended_move_fade_v1` as a disabled research hypothesis.
- It is not live-eligible.
- Reproduce with exact definitions, embargoed walk-forward folds, actual BTC markets, actual maker queues, and fill-conditioned results.
- The weak 2024 rate is a required stability warning, not a row to omit.

## Operational cockpit claims

The source describes a local Linux/macOS terminal that:

- connects directly to feeds and the CLOB,
- avoids browser rendering latency,
- uses single hotkeys for opening, closing, and moving to the next market,
- leaves the trading decision to the human,
- checks positions against on-chain balances,
- marks P&L to the live book,
- and reads resolution from the same Chainlink source used by the market rather than waiting on web UI presentation.

Required lesson:

- Measure interface-to-intent latency and network/exchange latency separately.
- Hotkeys must never bypass arming, price, risk, or data-quality gates.
- Reconciliation and source-of-truth discipline matter more than UI animation speed.

## Reddit discussion claims

Preserve these discussion points as hypotheses or critiques:

- One commenter reports approximately 3% ROI using taker-side microstructure at higher price bands after roughly one year of research and two months live. No trades, bankroll convention, confidence interval, or complete P&L were supplied. Treat this only as `higher_band_taker_microstructure_v1`, a research lead.
- A critical commenter argues that split-sell is continuous market-making under adverse selection, not static arbitrage; buying both legs below one dollar is a race; extreme-price optionality can be efficiently priced; rebates may be small; and a single successful wallet is subject to survivorship bias.
- The post author agrees with the adverse-selection framing, accepts that rebates may be a tailwind rather than the engine, and accepts the survivorship-bias criticism.

# Source B: Archetapp gist evidence ledger

Source:

`https://gist.github.com/Archetapp/7680adabc48f812a561ca79d73cbac69`

Observed raw revision:

`e45340873b7a2e2f2f3e6663cf77f667e61cc0b7`

The gist is a build guide, not an audited result report. Its useful content must be preserved as a benchmark strategy and its unsafe assumptions must become anti-pattern tests.

## Gist architecture

The guide proposes six Python files:

| File | Proposed purpose |
|---|---|
| `bot.py` | Main timing, modes, bankroll, and order engine |
| `strategy.py` | Composite signal from seven weighted indicators |
| `compare_runs.py` | Multi-configuration backtest and Excel report |
| `backtest.py` | Historical candle retrieval |
| `setup_creds.py` | API credential derivation from a private key |
| `auto_claim.py` | Browser/Playwright-based winner claiming |

Named dependencies:

- `py-clob-client==0.34.5`
- `python-dotenv>=1.0.0`
- `requests>=2.31.0`
- `playwright>=1.40.0`
- `openpyxl>=3.1.0`
- Python 3.10 or newer

Required interpretation:

- Do not replace the existing TypeScript-first architecture just to mimic these files.
- Recreate the behavior as versioned strategy/research adapters inside the parent monorepo.
- Verify current SDK packages and APIs before implementation.
- Do not use browser automation for redemption when the supported CTF/relayer path is available.

## Clock-derived discovery

The guide derives:

```text
window_ts = now - (now % 300)
close_time = window_ts + 300
slug = "btc-updown-5m-" + window_ts
```

It calls Gamma once with the derived slug to retrieve the event and Up/Down token IDs.

Required interpretation:

- Implement the clock-derived slug as a fast prediction and prefetch path.
- Always validate it against Gamma market identity, start/end times, rules, condition ID, and token IDs.
- Keep series/keyset discovery as fallback.
- Clock drift or an identity mismatch must halt order creation.

## Late-snipe timing claim

The guide:

- sleeps until T-10 seconds,
- begins a signal loop,
- argues direction is largely locked by then,
- trades off higher confidence against more expensive tokens,
- and calls T-10 seconds a sweet spot in its lessons.

This is a hypothesis contradicted by the parent live cutoff and questioned by the Reddit execution study.

Required interpretation:

- Keep the gist timing in paper/shadow only.
- Research a full time surface rather than a single favorite second.
- Live entries remain blocked under the parent cutoff until a separately approved strategy proves otherwise.

## Seven-indicator composite

The guide computes a signed score where positive means Up and negative means Down.

### 1. Window delta

Claimed weights:

| Absolute window move | Weight |
|---|---:|
| Greater than 0.10% | 7 |
| Greater than 0.02% | 5 |
| Greater than 0.005% | 3 |
| Greater than 0.001% | 1 |

The guide calls this the dominant feature and says its weight was increased from 3 to 5–7 after noisy indicators overruled clear window direction.

### 2. Micro momentum

- Weight 2.
- Direction of the last two one-minute candles.

### 3. Acceleration

- Weight 1.5.
- Compare the latest candle move with the move two candles earlier.

### 4. EMA crossover

- Weight 1.
- EMA 9 versus EMA 21.

### 5. RSI

- Period 14.
- Weight 1–2.
- RSI above 75 or below 25 receives weight 2.
- Neutral values receive zero.

### 6. Volume surge

- Weight 1.
- Recent three-bar average volume at least 1.5 times the preceding three-bar average confirms current direction.

### 7. Real-time tick trend

- Weight 2.
- Uses two-second polling.
- Requires at least 60% directional consistency.
- Requires more than 0.005% move.

Claimed confidence mapping:

`confidence = min(abs(score) / 7, 1)`

Required interpretation:

- Preserve the exact thresholds and weights as `gist_composite_v1`.
- Preserve the earlier window-delta weight 3 as an ablation option.
- This "confidence" is a normalized score, not a probability.
- Rename it `score_strength` in domain logic or display a mandatory "uncalibrated score" label.
- It cannot enter EV or Kelly formulas until calibrated out of sample.
- Add feature ablation, multicollinearity, time alignment, and leakage checks.
- Compute Chainlink window distance independently; Binance-derived window delta can only be diagnostic/confirmatory.

## Gist modes

The guide defines:

### Safe

- 25% of bankroll per trade.
- Minimum score confidence 30%.
- Claims four consecutive losses reduce bankroll by approximately 68%.

The arithmetic is consistent with losing about 68.36% and retaining about 31.64%:

`1 - 0.75^4 = 0.68359375`

This is not safe under the parent risk vocabulary.

### Aggressive

- Minimum confidence 20%.
- Described as risking "all proceeds" or profits above original investment.
- Also says the first trade risks the original bankroll and later protects the original.

This description is ambiguous and can still produce catastrophic exposure. Do not implement it as a live profile.

### Degen

- All-in every trade.
- Minimum confidence zero.
- Never skips.
- Explicitly accepts frequent ruin for streak-based compounding.

This is a prohibited anti-pattern.

Required interpretation:

- Preserve all three only as source fixtures in the Risk Lab.
- The parent `Aggressive` and `Very aggressive` profiles retain their capped meanings.
- Never expose "Safe" for 25% risk without a warning that the source label is misleading.
- Never expose a live all-in mode.
- Add regression tests proving source modes cannot override the absolute safety cap.

## Gist signal loop

The guide:

1. analyzes every two seconds beginning at T-10,
2. tracks the largest absolute score seen,
3. fires immediately when score jumps at least 1.5,
4. fires when the mode's score threshold is met,
5. otherwise uses the best observed signal by a T-5 hard deadline,
6. and never skips a window.

Required interpretation:

- Implement this exact loop only in deterministic replay and paper/shadow experiments.
- Add a causal event-time implementation; the "best seen" score may not use later observations at an earlier timestamp.
- `score_jump >= 1.5` is a research feature, not authorization.
- Forced trade at T-5 is prohibited outside the source-reproduction sandbox.
- The production engine must prefer no trade when edge is unverified.

## Gist order execution

The guide proposes:

- primary FOK market buy for an exact dollar amount,
- retry every three seconds until the window closes,
- fallback GTC buy at 0.95 when the favored token has no asks,
- claimed minimum five shares,
- and a 4.75 minimum spend at 0.95.

Required interpretation:

- Market constraints must be fetched per market.
- FOK and FAK semantics must be implemented according to the current SDK.
- No blind three-second retry loop.
- Every attempt needs an idempotency key, deadline, remaining-size calculation, acknowledgment reconciliation, and duplicate-exposure guard.
- A 0.95 GTC order is not maker merely because it is a limit order.
- Fallback orders must use explicit post-only semantics and must be rejected if they would cross.
- Never post an order after the market's safe entry/cancel cutoff.
- At 0.95, display effective break-even, fee, one-loss-erases-wins, impact, and maximum loss.

## Gist dry-run pricing and scoring

The guide's simulated token-price curve:

| Absolute window delta | Simulated token price |
|---|---:|
| Below 0.005% | 0.50 |
| Around 0.02% | 0.55 |
| Around 0.05% | 0.65 |
| Around 0.10% | 0.80 |
| At least 0.15% | 0.92–0.97 |

Dry run:

- uses live Binance data around T-10,
- uses the synthetic delta-price curve,
- waits for close,
- scores outcome using Binance,
- estimates profit,
- and resets bankroll after falling below the minimum so data collection continues.

Required interpretation:

- Preserve the piecewise curve only as a named synthetic baseline.
- Never call it a realistic fill model.
- Main paper/backtest execution must replay captured Polymarket books.
- Separate strategy performance from collection continuity; a bankroll reset must create a new simulated account/episode and cannot erase ruin.
- Score market outcomes from the actual market resolution and authoritative rule source.

## Gist comparison tool

The guide proposes:

- nine confidence thresholds,
- three modes described as flat, safe, and aggressive,
- 27 configurations,
- reuse of the actual strategy function,
- simulated bankroll curves,
- an example 72-hour run,
- and an Excel workbook with:
  - Summary,
  - Best Config Trades,
  - Bankroll Curves.

Required interpretation:

- Reproduce this comparison exactly as a legacy/source report.
- Add all modern validation reports required below.
- Never select "Best Config" on the same data used to evaluate it.
- Include all 27 configurations, not only the winner, to expose multiple testing.

## Gist setup and secrets

The guide names:

- a Polymarket account funded on Polygon,
- a private key,
- derived API key, secret, and passphrase,
- funder/proxy address,
- signature type,
- starting bankroll,
- minimum bet,
- and bot mode.

It presents these as `.env` variables.

Required interpretation:

- `.env.example` may contain placeholders only.
- Do not store a real private key or seed phrase in plaintext.
- Use the parent encrypted backend-only credential design.
- Redact all credentials from logs, snapshots, exceptions, exports, and UI.
- Credential derivation and funder/signature configuration require current official SDK verification.

## Gist resolution and Chainlink discussion

The guide uses Binance candle open/close as its primary dry-run outcome and Polymarket outcome-token prices as fallback. That is not acceptable for production truth.

A gist commenter reports:

- difficulty retrieving historical exact price-to-beat values,
- Gamma `/prices` returning 404 in their attempt,
- CLOB history returning outcome-token prices rather than the underlying BTC reference,
- RTDS being live rather than a historical lookup,
- and another commenter claims that `wss://ws-live-data.polymarket.com`, subscribed to `crypto_prices_chainlink` with a BTC/USD filter, can capture the first value at or after the boundary and match price-to-beat at the boundary.

Required interpretation:

- Chainlink RTDS observations and exact market rules are authoritative inputs.
- Persist the boundary tick with source and receive timestamps and sequence metadata.
- Cross-check the captured boundary against official price-to-beat representations.
- A commenter's "+0ms" observation is a hypothesis, not a latency guarantee.
- If the bot starts late or misses the boundary, it may observe but cannot claim a reconstructed authoritative strike without an official historical source.
- Binance remains a secondary diagnostic feed and never decides settlement.

## Gist result limitations

The gist does not provide:

- audited live trade history,
- statistically valid out-of-sample performance,
- exact source data,
- confidence intervals,
- fee-complete realized P&L,
- slippage and queue modeling,
- an answered profitability question,
- or evidence that its claimed T-10 behavior survives executable prices.

The bot must show this data gap wherever the gist benchmark is displayed.

# Source reconciliation and mandatory dispositions

| Source idea | Disposition in the refined bot |
|---|---|
| Window delta is dominant | Keep as a feature and ablation hypothesis; use authoritative Chainlink distance for market truth |
| Seven-indicator composite | Reproduce exactly; label uncalibrated; paper/shadow only |
| T-10 is a sweet spot | Test across time; never assume |
| Never skip a trade | Reject as an anti-pattern |
| 25% "safe" risk | Preserve in Risk Lab only with ruin warning |
| All-in/degen | Prohibit in executable modes |
| FOK retries until close | Replace with deadline-, exposure-, and idempotency-aware execution |
| GTC at 0.95 is maker | Reject; maker must be explicit and verified |
| Synthetic delta pricing | Keep only as a baseline to demonstrate model bias |
| Binance decides outcome | Reject; Chainlink/market resolution is authoritative |
| Price band predicts outcome | Compare probability with executable cost and fees |
| Binance leads the book | Reproduce offset-corrected event-time test |
| Extended runs mean-revert | Research-only candidate with stability and fill tests |
| Stops protect capital | Test against winner-shredding and executable exits |
| Maker is free edge | Reject; measure non-fill and adverse selection |
| Split-sell is risk-free | Reject until both legs and collateral state are complete |
| Buy-both-and-merge is risk-free | Reject until acquisition, fee, latency, and merge completion are complete |
| Rebates/rewards make whales profitable | Wallet-reconstruct and separate programs; do not assume |
| Execution is the controllable edge | Make execution measurement a first-class subsystem |
| Higher-band taker microstructure earns 3% | Treat as an unverified research hypothesis |

# New research architecture

Implement a reproducible experiment system under `apps/research` and shared packages.

Every experiment must define:

- immutable experiment ID,
- hypothesis,
- null hypothesis,
- preregistered primary metric,
- secondary metrics,
- data manifest and checksums,
- inclusion/exclusion rules,
- asset and market series,
- time interval,
- decision schedule,
- feature cutoff time,
- outcome source,
- book-price source,
- fee schedule source,
- latency model,
- fill/queue model,
- missing-data policy,
- train/validation/test folds,
- embargo/purge interval,
- multiple-testing family,
- seed,
- code commit,
- config version,
- and promotion status.

Required output:

- machine-readable JSON,
- CSV or Parquet observations,
- human-readable HTML/dashboard report,
- calibration plots,
- equity and drawdown curves,
- fill funnel,
- parameter sensitivity,
- and a signed/hash-addressed manifest.

# Mandatory source-reproduction experiments

## R1 — Feed lag and structural basis

Reproduce the 5,826-entry lag concept.

Measure:

- source timestamps and receive timestamps,
- local clock offset,
- per-feed update frequency,
- rolling Binance-minus-Chainlink basis,
- robust z-score of residual basis,
- lead/lag cross-correlation without future leakage,
- Polymarket book reaction time,
- observed versus executable ask,
- size available,
- decision-to-send latency,
- send-to-ack latency,
- ack-to-fill latency,
- actual fill price,
- momentum-side outcome,
- and net EV.

Report:

- raw direction accuracy,
- price paid,
- probability-price gap,
- net EV by latency and size,
- fill rate,
- and results before and after basis correction.

Explicitly test the cited ETH 0.12% structural offset and 0.10% gate as a known artifact scenario.

## R2 — Momentum and sustained-run continuation

Reproduce:

- any prior move,
- at least 0.10%,
- at least 0.40%,
- run lengths 2–5,
- run length at least 4 plus at least 0.8%.

Run:

- BTC and ETH separately,
- Chainlink and exchange-candle definitions separately,
- all source years,
- recent rolling windows,
- and executable Polymarket outcomes where books are available.

Report continuation and reversal probabilities, uncertainty, calibration, and price-adjusted EV.

## R3 — Favored-side calibration by executable ask

Reproduce every cited price band.

Add:

- maker and taker variants,
- quoted versus filled price,
- current fee schedule,
- book depth,
- seconds remaining,
- threshold distance,
- volatility regime,
- and complementary-outcome consistency.

Explain the cited 4,569 versus 4,442 count mismatch.

## R4 — Trend-side cheapness

Reproduce the four cited price bands and exact counts.

Test whether apparent underperformance remains after:

- defining the 30-minute trend causally,
- using BTC,
- stratifying by volatility,
- stratifying by seconds remaining,
- and using actual fills.

## R5 — Entry-time surface

Evaluate at minimum every five seconds from T-180 through T-5.

For each decision time report:

- information gain,
- forecast accuracy,
- quoted price,
- effective break-even,
- spread,
- depth,
- fill probability,
- slippage,
- reversal hazard,
- post-fill adverse movement,
- and net EV.

Include the source filters:

- skip first 60–120 seconds,
- skip last 60–80 seconds,
- T-10 loop,
- T-5 forced-trade benchmark.

## R6 — Exit policies

Test:

- hold to resolution,
- trailing-stop grid,
- fixed-stop grid including approximately -10%,
- break-even arming after +5%,
- take-profit ladders,
- threshold-cross invalidation,
- probability-versus-bid exit,
- and time-based exit.

Reproduce the cited pullback/recovery statistics and report them with confidence intervals.

## R7 — Gist composite ablation and calibration

Run:

- exact seven-indicator gist weights,
- old window-delta weight 3,
- current 5–7 weights,
- window delta only,
- every leave-one-feature-out variant,
- book-only baseline,
- Chainlink distance/volatility baseline,
- and a properly trained calibrated model.

Never call `abs(score)/7` a probability.

## R8 — Extended-move fade

Reproduce the four cited yearly reversal rates.

Test:

- alternate run definitions,
- move magnitude,
- path smoothness,
- volatility,
- time of day,
- spread/depth,
- maker price,
- queue position,
- and fill-conditioned results.

Require positive conservative net EV after adverse-selection penalties before any promotion beyond shadow.

## R9 — Maker adverse selection

For every hypothetical and actual quote, measure:

- probability before posting,
- order age,
- queue ahead,
- whether filled,
- fill side,
- probability immediately after fill,
- markout at 250ms, 1s, 2s, 5s, 10s, 30s, and resolution,
- cancellation race,
- missed-fill counterfactual,
- and realized outcome.

Primary metric:

`fill_selection_cost = signal_conditioned_value - fill_conditioned_value`

## R10 — Split/sell and buy-both/merge cycles

Model every cycle as a state machine, not a single trade.

Required states:

`PLANNED -> INVENTORY_PREFLIGHT -> SPLIT_PENDING -> INVENTORY_READY -> QUOTING_BOTH -> ONE_LEG_FILLED -> HEDGE_OR_CANCEL -> BOTH_LEGS_FILLED -> MERGE_OR_SETTLE -> RECONCILED`

Side states:

- `PARTIAL_LEG`
- `UNHEDGED`
- `MERGE_PENDING`
- `ALLOWANCE_BLOCKED`
- `REWARD_PENDING`
- `HALTED`
- `FAILED_RECONCILIATION`

Evaluate:

- pair spread,
- both-fill probability,
- time between leg fills,
- unhedged markout,
- hedge cost,
- taker fee,
- merge latency,
- capital lockup,
- inventory reuse,
- rebate/reward income only when paid,
- and worst-case loss.

## R11 — Higher-band taker microstructure

Implement only as an open research slot because the comment supplied no method.

Require a preregistered definition of:

- "higher price band,"
- "directional drift,"
- 3% ROI denominator,
- sample interval,
- complete win/loss history,
- fees,
- spread/slippage,
- and drawdown.

No result is promotable without these definitions.

## R12 — Wallet economics

Build an optional wallet-research pipeline that reconstructs:

- trades,
- splits,
- merges,
- redeems,
- rewards,
- rebates,
- deposits,
- withdrawals,
- transfers,
- inventory,
- open risk,
- and time-weighted capital.

Use it to test whether observed whale P&L is attributable to:

- directional edge,
- spread capture,
- CTF inventory operations,
- maker rebates,
- liquidity rewards,
- capital scale,
- transfers,
- or survivorship/selection.

# Probability and decision refinements

Implement or complete:

- empirical conditional-frequency models,
- regularized logistic regression,
- optional gradient boosting,
- isotonic or Platt calibration,
- time-series cross-validation,
- purged/embargoed folds,
- uncertainty from finite sample, drift, and execution selection,
- and model registry approval artifacts.

Every candidate must keep distinct:

- `market_probability`,
- `model_probability`,
- `conservative_probability`,
- `score_strength`,
- `effective_break_even_probability`,
- `fill_probability`,
- and `expected_value_if_filled`.

Also calculate:

`expected_value_per_signal = fill_probability * expected_value_if_filled - cancellation_and_operational_cost`

For paired maker cycles calculate:

`cycle_ev = both_fill_value + one_leg_fill_value + no_fill_value + paid_incentive_value - operational_cost`

with every term probability-weighted and empirically estimated.

Do not use:

- raw win rate as edge,
- a normalized indicator score as probability,
- midpoint as executable price,
- future resolution data in features,
- synthetic token prices when real books exist,
- rebates as guaranteed expected revenue,
- or a point estimate for Kelly sizing.

# Execution-quality engine

Add a first-class execution timeline:

`DECISION_SNAPSHOT -> INTENT_CREATED -> RISK_APPROVED -> SIGN_STARTED -> SENT -> EXCHANGE_ACK -> RESTING/PARTIAL/FILLED/REJECTED -> CANCEL_REQUESTED -> CANCEL_CONFIRMED -> BALANCE_RECONCILED`

Persist monotonic and UTC wall-clock times for every transition.

For each order store:

- client idempotency key,
- intent version,
- attempt number,
- request hash,
- exact signed order payload hash,
- order type,
- post-only flag,
- time in force,
- source book sequence,
- decision price,
- send price,
- acknowledgment price,
- fills and fill prices,
- remaining size,
- cancellation status,
- CLOB state,
- account state,
- token balance state,
- and reconciliation differences.

Implement:

- one in-flight mutation per intent,
- remaining-size-aware retries,
- no retry after unknown outcome without reconciliation,
- no retry past cutoff,
- cancel/replace only after confirmed state,
- post-only rejection as safe no-fill,
- and kill-switch cancellation with explicit unknown states.

# Paper and shadow fidelity

Paper trading must use recorded books and configurable:

- inbound feed latency,
- feature-computation latency,
- decision latency,
- signing latency,
- outbound network latency,
- exchange processing latency,
- queue priority,
- trade-through requirement,
- partial fills,
- cancellation latency,
- missed cancels,
- tick size,
- minimum size,
- price impact,
- taker fee,
- maker/taker classification,
- and adverse-selection markout.

Maintain three paper results:

1. `OPTIMISTIC_TOUCH` — fills when price touches; educational upper bound only.
2. `QUEUE_REPLAY` — fills from queue-aware book/trade replay.
3. `CONSERVATIVE_STRESS` — worse latency, one-tick disadvantage, missed fills/cancels, and adverse selection.

Never merge them into one paper P&L.

Shadow mode must emit the exact order that would have been sent, then track whether and how it likely would have filled without signing or transmitting it.

# Data-model additions

Add or extend versioned domain entities for:

- `SourceEvidence`
- `DatasetManifest`
- `ExperimentDefinition`
- `ExperimentRun`
- `ExperimentObservation`
- `HypothesisStatus`
- `ModelArtifact`
- `CalibrationArtifact`
- `LatencySample`
- `OrderAttempt`
- `ExecutionTimelineEvent`
- `QueueEstimate`
- `FillCounterfactual`
- `MarkoutObservation`
- `FeedBasisEstimate`
- `BoundaryPriceObservation`
- `InventoryLot`
- `InventorySnapshot`
- `PairedQuoteCycle`
- `PairedLeg`
- `CTFOperation`
- `HedgeAction`
- `RebateAccrual`
- `LiquidityRewardAccrual`
- `WalletResearchSnapshot`
- and `StrategyPromotionDecision`.

All must have stable IDs, UTC timestamps, correlation IDs, source provenance, and config/build versions.

# Risk refinements

Keep all parent limits and add:

- maximum unhedged paired-cycle exposure,
- maximum one-leg duration,
- maximum order attempts per intent,
- maximum cancel uncertainty duration,
- maximum pending CTF operation value,
- maximum inventory per outcome,
- maximum gross paired inventory,
- maximum daily operational/reconciliation loss,
- and maximum source-claim strategy allocation.

Hard reject when:

- an uncalibrated score is passed as a probability,
- a synthetic price is passed as executable,
- a Binance outcome is passed as authoritative resolution,
- source fixture mode requests more than the absolute cap,
- a source-reproduction strategy requests live mode,
- a paired cycle lacks enough collateral/inventory for its failure path,
- one-leg exposure exceeds its budget or duration,
- reward/rebate income is needed to make pre-trade EV positive,
- an order retry follows an unknown prior outcome without reconciliation,
- a boundary strike was reconstructed from a non-authoritative feed,
- or research provenance is missing.

# Dashboard refinements

Add an **Evidence Lab**:

- source ledger,
- original claimed result,
- internal reproduced result,
- match/mismatch status,
- methodology differences,
- sample reconciliation,
- and links to experiment artifacts.

Add an **Execution Lab**:

- signal-to-fill funnel,
- latency waterfall,
- quoted versus filled price,
- partial/missed-fill rates,
- queue estimates,
- maker/taker classification,
- post-fill markouts,
- cancellation races,
- and optimistic versus queue versus stress P&L.

Add an **Inventory Lab**:

- Up and Down token inventory,
- paired versus unpaired amounts,
- split/merge/redeem state,
- one-leg exposure timer,
- quote-cycle state,
- hedge cost,
- spread captured,
- realized trading P&L,
- paid rebates,
- paid liquidity rewards,
- and total reconciled cycle P&L.

Add a **Strategy Comparison** page:

- book baseline,
- distance/volatility,
- exact gist composite,
- extended-move fade,
- favored-side hold,
- higher-band taker research slot,
- and maker paired-cycle research.

For every strategy show:

- sample size,
- candidate count,
- fill count,
- price paid,
- win rate,
- Brier/log loss,
- calibration,
- gross EV,
- fees,
- spread,
- slippage,
- adverse selection,
- net EV,
- confidence interval,
- maximum drawdown,
- longest losing streak,
- and promotion status.

Mandatory UI language:

- "Source claim — not reproduced."
- "Score strength is not probability."
- "High win rate does not imply positive EV."
- "Observed price is not a guaranteed fill."
- "Being filled can be adverse information."
- "One-leg exposure is directional risk."
- "Rebate not included until paid."
- "Synthetic pricing baseline — not executable."
- "Binance is not the resolution source."
- "No trade is a valid decision."

# Configuration refinements

Add an equivalent validated configuration:

```yaml
research:
  source_reproduction:
    enabled: true
    source_fixture_version: "2026-07-31-001"
  gist_composite:
    enabled_modes: [observe, paper, shadow]
    live_allowed: false
    poll_interval_ms: 2000
    snipe_start_seconds: 10
    forced_trade_benchmark_seconds: 5
    forced_trade_executable: false
    score_jump_threshold: 1.5
    confidence_is_probability: false
  extended_move_fade:
    enabled_modes: [observe, paper, shadow]
    live_allowed: false
    minimum_run_blocks: 4
    minimum_candidate_count: 1000

execution_research:
  paper_fill_models: [optimistic_touch, queue_replay, conservative_stress]
  markout_horizons_ms: [250, 1000, 2000, 5000, 10000, 30000]
  maximum_attempts_per_intent: 1
  reconcile_before_retry: true
  capture_decision_send_ack_fill_books: true

inventory_research:
  enabled_modes: [observe, paper, shadow]
  live_allowed: false
  maximum_one_leg_seconds: 2
  maximum_unhedged_risk_fraction: 0.01
  rebates_in_pretrade_ev: false
  rewards_in_pretrade_ev: false
  require_ctf_reconciliation: true

evidence:
  provenance_required: true
  source_claims_are_live_signals: false
  require_dataset_checksum: true
  require_code_commit: true
```

These are schema examples, not permission to weaken stricter parent limits.

# Testing requirements

## Source-fixture tests

- Every Reddit numeric table is represented exactly.
- The favored-side count mismatch is detected.
- The 74.8 versus 75.3 rounded-gap discrepancy is detected.
- The gist's seven weights and thresholds are represented exactly.
- The 27-configuration comparison grid is generated.
- The gist synthetic pricing curve reproduces its specified anchors.
- The 25%-risk four-loss calculation reports approximately 68.36% lost.

## Anti-pattern tests

- Gist degen mode cannot create an executable order.
- A forced T-5 benchmark cannot enter live mode.
- Binance cannot write an authoritative resolution.
- A 0.95 GTC order is not classified maker without explicit verified post-only status.
- An uncalibrated composite score cannot reach Kelly sizing.
- A synthetic price cannot become a paper fill when a real book is required.
- A bankroll reset cannot erase a simulated ruin event.
- Paid incentives cannot be fabricated from estimated rewards.
- Split/sell cannot be labeled risk-free while one leg is open.
- Unknown FOK/FAK state blocks retry.

## Research integrity tests

- Feature snapshots never include post-decision values.
- Fold boundaries purge overlapping windows and embargo nearby observations.
- Model selection and final evaluation use different data.
- Multiple comparisons are reported.
- Outcome and fill denominators are explicit.
- Missing book data cannot silently become a fill.
- Source dataset and result hashes are stable.
- BTC and ETH results cannot be pooled without an explicit model.

## Execution tests

- Decision/send/ack/fill books remain distinguishable.
- Partial fill reduces remaining authorized size.
- Duplicate acknowledgment does not duplicate exposure.
- Cancel uncertainty blocks replacement.
- Fill markouts use only subsequent observed books.
- Post-only crossing remains a safe rejection.
- On-chain/account mismatch halts.
- One-leg timer halts and follows the configured hedge/cancel policy.

## Property tests

- No combination of retries and partial fills exceeds approved stake.
- No paired-cycle path exceeds its unhedged risk cap.
- No reward or rebate is realized twice.
- Split/merge accounting conserves collateral and outcome-token units.
- Every winning/losing outcome conserves cash, shares, fees, and payouts.
- No source-reproduction strategy can become live merely through configuration.

# Acceptance criteria

This refinement is complete only when:

1. The application links this brief to its parent and exposes the source ledger.
2. Every substantive numeric claim from both sources exists as a versioned fixture or research hypothesis.
3. The Reddit reproduction suite can run from immutable dataset manifests.
4. The gist composite can run causally in replay, paper, and shadow but cannot run live.
5. The UI never labels the gist score as probability.
6. Real book replay replaces synthetic pricing for primary paper results.
7. Synthetic pricing remains available only as a visibly labeled source baseline.
8. Binance cannot define price-to-beat or resolution.
9. The lag study corrects asset-specific cross-feed basis and includes executable price and latency.
10. The favored-side report explains or flags the 127-decision count gap.
11. Entry-time research covers T-180 through T-5 and includes fees/fills.
12. Exit research reproduces the cited pullback and recovery claims.
13. Extended-move fade remains non-live until fill-conditioned validation passes.
14. Maker results separate all signals, filled orders, and unfilled orders.
15. Execution timelines persist decision, send, acknowledgment, fill, cancel, and reconciliation state.
16. FOK/FAK attempts are idempotent and exposure-aware.
17. A 0.95 limit is never assumed maker.
18. Split/merge cycles are represented as inventory state machines.
19. One-leg exposure is visible, limited, timed, and included in P&L.
20. Rebates and liquidity rewards are separate and realized only after payment.
21. Wallet research separates trading P&L from flows and incentives.
22. The source's 25% "safe" and all-in modes are non-executable cautionary simulations only.
23. Paper results report optimistic, queue-replay, and conservative-stress variants separately.
24. Model promotion requires walk-forward calibration and a positive lower confidence bound on net EV.
25. No live order can be created by any unverified source claim.
26. Tests, lint, typecheck, production build, migrations, and relevant E2E flows pass.
27. Documentation explains which source claims reproduced, failed, or remain untestable.

# Refinement build sequence

1. Read `polymarket.fable` and this file completely.
2. Inspect the current repository and produce a gap checklist against both briefs.
3. Verify current official Polymarket SDK, CLOB, RTDS, fee schedule, maker incentives, CTF, and resolution behavior.
4. Add the source-evidence fixtures and discrepancy tests first.
5. Complete immutable dataset manifests and experiment-run infrastructure.
6. Complete authoritative Chainlink boundary capture and cross-checking.
7. Complete order-book capture with sequence and latency metadata.
8. Implement the exact gist composite as a non-live benchmark.
9. Implement the Reddit reproduction experiments.
10. Implement queue-aware paper fills and execution timelines.
11. Implement markouts, fill counterfactuals, and adverse-selection reports.
12. Implement paired inventory/CTF simulation before any market-making adapter.
13. Build Evidence, Execution, Inventory, and Strategy Comparison UI pages.
14. Add risk gates and anti-pattern regression tests.
15. Run research smoke tests and deterministic fixture reproductions.
16. Run unit, integration, property, E2E, lint, typecheck, and build checks.
17. Inspect the application visually at realistic viewport sizes.
18. Document result mismatches and remaining limitations without softening them.

# References to verify during implementation

Source material:

- Reddit analysis: `https://www.reddit.com/r/PredictionsMarkets/comments/1uoqskg/how_efficient_are_polymarkets_5min_crypto_markets/`
- Archetapp gist: `https://gist.github.com/Archetapp/7680adabc48f812a561ca79d73cbac69`
- Observed gist raw revision: `https://gist.githubusercontent.com/Archetapp/7680adabc48f812a561ca79d73cbac69/raw/e45340873b7a2e2f2f3e6663cf77f667e61cc0b7/PolymarketBot.md`

Current official references observed while preparing this refinement:

- Fees: `https://docs.polymarket.com/trading/fees`
- Maker rebates: `https://docs.polymarket.com/market-makers/maker-rebates`
- Liquidity rewards: `https://docs.polymarket.com/market-makers/liquidity-rewards`
- Order creation and post-only behavior: `https://docs.polymarket.com/trading/orders/create`
- Market-maker trading guidance: `https://docs.polymarket.com/market-makers/trading`
- CTF overview: `https://docs.polymarket.com/trading/ctf/overview`
- Split: `https://docs.polymarket.com/trading/ctf/split`
- Merge: `https://docs.polymarket.com/trading/ctf/merge`
- Inventory management: `https://docs.polymarket.com/market-makers/inventory`
- Changelog: `https://docs.polymarket.com/changelog`

Always re-verify these at build time. The live market object and current official documentation override source prose and this file's time-stamped observations.

# Final instruction

Use both sources to make the bot more skeptical, measurable, and execution-aware.

The gist contributes a concrete late-snipe composite, timing loop, synthetic-price baseline, and operational simplicity. Preserve them as reproducible research artifacts, not as permission for forced trades, all-in sizing, Binance settlement, or assumed fills.

The Reddit analysis contributes a strong efficient-market null, detailed negative results, execution/adverse-selection warnings, a weak mean-reversion hypothesis, and a market-making/inventory direction. Preserve every cited result, reproduce it, and design the bot so that a failed reproduction is as useful and visible as a successful one.

Do not promise profitability. Do not manufacture activity. Do not hide non-fills, count mismatches, unstable years, fees, one-leg risk, or lost bankroll episodes.

Build a bot that is difficult to fool—especially by its own backtests.
