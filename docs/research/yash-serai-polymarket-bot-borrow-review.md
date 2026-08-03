# What we can responsibly borrow from `YashSerai/polymarket-bot`

**Review date:** 2026-08-03  
**Upstream repository:** [YashSerai/polymarket-bot](https://github.com/YashSerai/polymarket-bot)  
**Upstream commit reviewed:** `0fcac6618f64579e9817fedbb75181099d6e6413`  
**Related post:** [Polymarket 5-Minute Bitcoin Trading Bot Results](https://www.linkedin.com/posts/yash-serai_algotrading-polymarket-bitcoin-activity-7429931408472686592-eFF-/)  
**Purpose of this document:** identify the small amount of useful research value in the upstream project without importing its unsupported performance claims, execution assumptions, or code.

---

## Executive decision

Do **not** vendor, port, or merge the upstream implementation. Do **not** treat its stated win rates or confidence values as evidence. Do **not** use it to weaken any calibration, execution, or risk gate in this repository.

There are, however, four ideas worth preserving in a clean-room form:

1. **Early-window momentum persistence as a falsifiable shadow hypothesis.**
   Reproduce the upstream “large BTC move by roughly T+120 seconds” rule as a deliberately simple benchmark, then replace its fixed-dollar threshold with volatility-normalized variants. This is the only directional idea worth new measurement.
2. **Sum-to-one arbitrage as an observability metric, not a trading strategy.**
   Continuously calculate whether equal quantities of UP and DOWN are jointly executable below their guaranteed payout after exact fees, book walking, latency, and partial-fill risk. The expected result is almost always “no,” which is still operationally useful.
3. **A strategy-tournament research harness.**
   Evaluate several strategies on the same immutable feature snapshot and maintain separate virtual ledgers. The upstream does this crudely; the experimental design is useful even though its accounting is not.
4. **Simple, human-readable signal labels.**
   Preserve names such as `momentum_magnitude`, `momentum_3min`, `momentum_4min`, and `arb_sum_to_one` as research tags and ablation labels. Do not preserve their hard-coded “confidence” numbers.

Everything else is either already implemented more rigorously here, contradicted by our existing evidence, or technically unsafe.

### Priority summary

| Candidate | Recommendation | Priority | Allowed mode | Why |
|---|---:|---:|---|---|
| Early momentum persistence | Build as an ablation/benchmark | P1 | Research, observe, shadow; paper only after offline checks | Simple, falsifiable, and not identical to the current late-snipe trigger |
| Net executable pair-arb monitor | Build as telemetry | P2 | Observe/research only initially | Validates market integrity and measures a claimed opportunity with exact economics |
| Multi-strategy tournament | Build in research layer | P2 | Research/shadow | Enables paired comparisons and prevents “different night, different regime” conclusions |
| Human-readable reason tags | Reuse the vocabulary | P3 | All non-live analytics | Improves experiment legibility with negligible risk |
| Enhanced TA composite | Do not port | — | — | Already represented by our superior indicator block; no calibrated edge |
| Contrarian strategy | Keep only as a negative control | P3 | Offline research only | Useful for detecting leakage or implausibly optimistic simulators |
| Upstream backtester, collector, runner, accounting | Reject | — | — | Material correctness, execution, resolution, and leakage problems |

---

## Scope and evidence standard

This review compares the upstream source code with:

- this repository's architecture and strategy implementation;
- the current fee and execution model;
- the walk-forward calibration study on 14,226 resolved BTC five-minute markets and 4.27 million top-of-book observations;
- the independent ecosystem findings collected in the Reddit dossier.

The relevant local evidence is:

- [`calibration-study-2026-08.md`](./calibration-study-2026-08.md)
- [`reddit-5min-bot-ecosystem.md`](./reddit-5min-bot-ecosystem.md)
- [`../architecture.md`](../architecture.md)
- [`../live-trading-checklist.md`](../live-trading-checklist.md)

The upstream repository had one visible commit and no visible license file when reviewed. Therefore:

- ideas and public facts may be independently reimplemented;
- upstream source should not be copied, translated line-for-line, or incorporated;
- any implementation proposed here must use this repository's types, conventions, tests, exact fixed-point arithmetic, and safety model;
- provenance should remain documented in this note even for a clean-room implementation.

This is an engineering recommendation, not a conclusion that any strategy is profitable.

---

## What the upstream project actually contains

The upstream project advertises five strategies:

1. sniper / cross-venue lag;
2. contrarian / mean reversion;
3. enhanced technical analysis;
4. momentum persistence;
5. UP-plus-DOWN sum-to-one arbitrage.

Its public runner assigns an independent nominal bankroll to each strategy and evaluates all five during the same market loop. That high-level shape is useful. The details are not.

### Important mismatches between the post and the code

The LinkedIn post says the simulation included a 2% fee, artificial network delay, and probabilistic fills. The reviewed [`run_backtest.py`](https://github.com/YashSerai/polymarket-bot/blob/main/run_backtest.py) does not implement those claims:

- P&L is computed as `1 - entry_price` on a win or `-entry_price` on a loss;
- no fee is charged;
- no latency is applied between signal and execution;
- no order-book depth is consumed;
- no partial fill is possible;
- no fill probability is applied;
- no quote-staleness limit is enforced;
- the strategy is assumed to transact at the historical row's price;
- the backtester does not run the standalone momentum or arbitrage modules at all;
- results are in abstract “units,” not an exact cash/shares ledger.

The historical [`fetch_data.py`](https://github.com/YashSerai/polymarket-bot/blob/main/fetch_data.py) collector requests Polymarket `prices-history` with `fidelity=1`, producing minute-level price history, while Binance trades are resampled to one-second candles. The backtester then backward-as-of joins those series. This can hold a Polymarket price constant while many Binance seconds pass, manufacturing an apparent cross-venue lag that was not necessarily executable.

The contrarian backtest uses each market's minimum and maximum price across the full window. Because the min and max may occur at different times and are known only after the window ends, this introduces look-ahead and non-simultaneity.

The public [`run_bot.py`](https://github.com/YashSerai/polymarket-bot/blob/main/run_bot.py) has additional correctness problems:

- its live market parser initially looks for separate UP and DOWN markets, whereas current BTC five-minute events contain one binary market with two outcome tokens;
- missing market prices default to `0.50`, which can create false signals;
- paper entry uses the first displayed ask without a depth walk;
- fees are not deducted;
- the signal-to-order delay is not modeled;
- every requested paper order is treated as fully filled;
- resolution uses a Binance five-minute candle rather than the market's authoritative Chainlink rule;
- the arbitrage signal returns direction `both`, but the single-leg `process_trade` path looks for a nonexistent `both_token_id`; the advertised pair trade is not actually represented as two orders;
- broad exception swallowing converts data and parsing failures into missing values or fallback behavior without an auditable rejection reason.

These are not minor conservatism differences. They invalidate the reported economics as evidence for integration.

---

## Strategy-by-strategy audit

## 1. Momentum persistence

### Upstream idea

The upstream [`momentum.py`](https://github.com/YashSerai/polymarket-bot/blob/main/strategies/momentum.py) emits one signal per market using three patterns:

- an absolute BTC move of at least $100 once at least two minutes have elapsed;
- four completed one-minute candles in the same direction;
- three completed one-minute candles in the same direction.

It attaches fixed confidence values such as 0.80, 0.88, 0.93, and 0.96.

### What is worth borrowing

Borrow the **rule shape**, not the values:

- “large move early in the window” is a clear, falsifiable condition;
- “directional persistence across completed subwindows” is an interpretable alternative to a large opaque indicator composite;
- a one-signal-per-market latch is useful for clean candidate counting;
- separate labels for magnitude and persistence allow ablation testing.

This differs enough from our current `late_snipe_composite_v1` to justify a research benchmark. The current preset focuses on the final 5–30 seconds and blends window delta, micro-momentum, acceleration, EMA separation, RSI, volume surge, and tick trend. The proposed benchmark asks a narrower question earlier in the market: **after a sufficiently large move is already visible by about T+120 seconds, does the move persist more often than the executable contract price implies?**

### What must not be borrowed

- Do not call a score “confidence” unless it is a calibrated probability with an out-of-sample reliability table.
- Do not use the upstream fixed probabilities.
- Do not use `$100` as the production threshold. A fixed dollar move changes meaning as BTC's level and volatility regime change.
- Do not use Binance as the authority for direction or resolution.
- Do not enter merely because the outcome direction is likely. Entry requires probability minus executable break-even to be positive after costs.
- Do not infer profitability from win rate.

### Clean-room hypothesis

Define the primary hypothesis before running the study:

> Conditional on a large, persistent, authoritative BTC move early in a five-minute window, the realized probability that the current leader wins exceeds the executable taker break-even probability by enough to survive fees, latency, and slippage.

The null remains:

> The market's executable price already incorporates the visible momentum; the signal does not add positive net edge.

The null is the default and must be actively rejected.

### Proposed strategy identity

Use a visibly unapproved version name:

```text
early_momentum_persistence_v0_RESEARCH_ONLY
```

Do not add this version to any live-eligible list. Initially it should be evaluated by the research layer against stored feature snapshots. If later connected to the engine, its allowed modes should be `observe` and `shadow`; paper activation should be a separate explicit change after offline tests.

### Proposed signal variants

Run variants as predeclared ablations, not as a threshold-mining exercise.

#### Variant M0: literal replication benchmark

Purpose: test the upstream claim as closely as our correct data allows.

- Evaluation time: first observation at or after T+120 seconds.
- Signal: `abs(distanceUsd) >= 100`.
- Direction: sign of authoritative Chainlink distance from the captured price-to-beat.
- Additional requirement: no missing price-to-beat, no stale Chainlink value, no unresolved rule-source ambiguity.
- Entry economics: use the contemporaneous same-side executable ask after simulated latency, not a midpoint or historical candle price.

M0 is intentionally nonstationary. It exists only to answer “does their exact headline rule survive?” It should never become the preferred rule.

#### Variant M1: basis-point magnitude

- Evaluation horizons: T+90, T+120, and T+180 seconds, treated as separate hypotheses.
- Signal grid, fixed in advance: `abs(distanceBps) >= {5, 10, 15, 20}`.
- Direction: Chainlink distance sign.
- Report all thresholds, including those with no apparent edge.
- Correct the family of comparisons using both Bonferroni and Benjamini-Hochberg.

This normalizes for BTC's nominal price but not for the volatility regime.

#### Variant M2: volatility-normalized magnitude

- Signal grid, fixed in advance: `abs(distanceZ) >= {0.5, 1.0, 1.5, 2.0}`.
- `distanceZ = distanceBps / estimated remaining move standard deviation` using only information available at the decision timestamp.
- Require `estRemainingMoveStdBps > 0` and a complete warm-up buffer.
- Report performance by volatility quartile to detect regime concentration.

This should be the primary normalized benchmark because the necessary feature already exists.

#### Variant M3: completed-minute persistence

Construct one-minute bars from the authoritative Chainlink tick stream, aligned to the market window rather than wall-clock exchange candles.

Candidate conditions:

- at least three completed minute bars;
- the first three completed bars have the same non-flat direction;
- optional four-bar variant, evaluated separately;
- the net distance from price-to-beat has the same sign as the bar sequence;
- minimum net magnitude: `abs(distanceZ) >= 0.5` to prevent three microscopic bars from qualifying;
- no price-to-beat crossing within the last 30 seconds, or report crossing count as a stratification variable rather than silently optimizing it.

The tie rule must be explicit: a exactly flat Chainlink close counts as UP for market resolution, but should be treated as flat—not bullish—for candle-persistence feature construction. Otherwise tiny/no-change bars create a systematic UP artifact.

#### Variant M4: persistence plus acceleration ablation

This is not an additional strategy to optimize independently. It tests whether recent acceleration adds information after magnitude:

- base candidate from M2 or M3;
- compare groups where acceleration agrees with direction, is neutral, or disagrees;
- do not gate on acceleration until the stratified result is stable out of sample.

### Necessary features

Most inputs already exist in `FeatureSet`:

- `distanceUsd`
- `distanceBps`
- `distanceZ`
- `velocityBpsPerSec`
- `accelerationBpsPerSec2`
- `crossings120s`
- `lastCrossAgoMs`
- `realizedVolBps`
- `secondsElapsed`
- `secondsRemaining`
- both sides' best bid/ask and depth
- data ages and quality

Only the completed authoritative-minute persistence features are missing. Add them only if M3 is implemented:

```ts
chainlinkCompletedMinuteDirections: Array<"UP" | "DOWN" | "FLAT">;
chainlinkDirectionalRunLength: number;
chainlinkDirectionalRunSide: "UP" | "DOWN" | null;
chainlinkNetMoveBpsByCompletedMinute: number[];
```

If stored inside every `FeatureSet`, keep the arrays bounded to the current five-minute window. An alternative is to compute them only in offline research from reference ticks, avoiding production feature expansion until the result earns it.

### Candidate economics

For each signal and side:

1. capture the signal timestamp;
2. wait the configured simulated latency;
3. read the side's executable asks at activation;
4. walk enough depth for the fixed research stake;
5. calculate exact taker fees at each fill price;
6. record requested, available, and filled shares;
7. calculate the weighted break-even probability;
8. resolve from Chainlink and cross-check Gamma;
9. compute net P&L from actual simulated fills only.

The result must distinguish:

- signal-conditioned outcome rate;
- executable-candidate outcome rate;
- fill-conditioned outcome rate;
- unfilled opportunity outcome rate;
- net P&L conditional on fill;
- opportunity cost from missed fills.

This separation is essential because fill selection is expected to be adverse.

### Statistical acceptance criteria

The strategy remains rejected unless all of the following hold:

- at least 1,000 independent market-level candidates for the chosen final rule;
- at least 300 simulated fills under the conservative execution model;
- walk-forward evaluation only, with thresholds frozen before the test fold;
- positive mean net P&L per filled trade;
- a positive lower confidence bound for aggregate net P&L or mean net return using a market-level bootstrap;
- positive result after current exact fees;
- positive result with one tick worse execution;
- non-negative result at 2x simulated latency;
- no single UTC day contributes more than 20% of total profit;
- positive performance in both halves of the final test period;
- no catastrophic dependence on one price, volatility, time-of-day, or UP/DOWN bucket;
- performance exceeds the market-price baseline, not merely 50% directional accuracy;
- the result survives the registered multiple-testing correction.

Recommended stress matrix:

| Stress | Baseline | Stress 1 | Stress 2 |
|---|---:|---:|---:|
| Signal-to-order latency | 350 ms | 700 ms | 1,400 ms |
| Entry price | observed activation VWAP | +1 tick | +2 ticks |
| Available depth | 100% | 50% | 25% |
| Fee rate | observed schedule | +25% relative | +50% relative |
| Quote age ceiling | 1,000 ms | 500 ms | 250 ms |

The exact baseline latency should also be replaced by the collector's measured empirical distribution once sufficient data exists. A constant delay is only the first approximation.

### Kill criteria

Stop work on momentum persistence if any of the following occurs:

- the market midpoint or executable ask predicts outcomes as well as or better than the model;
- gross signal edge disappears after one tick of slippage;
- apparent profits are concentrated in unfilled candidates;
- performance is positive only before the current fee regime;
- the chosen threshold changes materially across adjacent walk-forward folds;
- a fixed-dollar threshold looks positive but bps/z-score variants do not, indicating regime selection;
- outcome accuracy is high but expected value remains negative because entries are expensive;
- live-paper quote ages show that the opportunity vanishes before activation.

### Expected result

Our current evidence suggests M0–M4 will not produce durable executable edge. That is not a reason to skip a cheap, pre-registered ablation. It is a reason to keep the implementation small and the promotion bar high.

---

## 2. Sum-to-one pair arbitrage

### Upstream idea

The upstream [`arbitrage.py`](https://github.com/YashSerai/polymarket-bot/blob/main/strategies/arbitrage.py) flags a candidate when:

```text
UP ask + DOWN ask < 0.975
```

The threshold is described as leaving room for a flat 2% fee and slippage.

### What is worth borrowing

Borrow the invariant:

> One UP share plus one DOWN share pays exactly one unit at resolution, so jointly executable acquisition cost below one after all costs is a mechanical opportunity.

This is useful as:

- a market-data sanity check;
- a complement-consistency diagnostic;
- a fee-model regression check;
- a book synchronization/latency diagnostic;
- a measurement of how frequently gross optical dislocations survive exact execution costs;
- a way to quantify two-leg residual risk before anyone proposes live pair execution.

The local strategy package already computes a complement inconsistency feature. A dedicated monitor would make that feature economically interpretable.

### What must not be borrowed

- Do not use a flat 2% deduction. Current crypto fees are nonlinear in price and charged per executed leg under the active convention.
- Do not use only the best ask. Joint size is limited by the shallower of both books, and larger size walks both books.
- Do not assume both legs fill atomically.
- Do not report `1 - upAsk - downAsk` as profit.
- Do not assign confidence 1.0; “risk-free payoff if both positions exist” is not “risk-free execution.”
- Do not add a live executor merely because a gross snapshot crosses a threshold.

### Exact economic definition

For equal filled quantity `q`, let:

- `C_up(q)` be exact USDC spent walking the UP asks;
- `C_down(q)` be exact USDC spent walking the DOWN asks;
- `F_up(q)` and `F_down(q)` be exact taker fees for the fills at their level prices;
- `R(q)` be any expected residual liquidation/hedging cost caused by unequal fills;
- guaranteed settlement payout be `q` USDC when equal quantities of both outcomes are held.

Then:

```text
net_pair_pnl(q) = q - C_up(q) - C_down(q) - F_up(q) - F_down(q) - R(q)
```

The candidate is economically positive only if `net_pair_pnl(q) > 0` after conservative rounding.

For top-of-book display only, a per-share approximation is:

```text
net_edge_per_share ~= 1 - p_up - p_down - fee(p_up) - fee(p_down)
```

but the monitor must never use this approximation for its final executable result.

All calculations should use the existing fixed-point domain functions and per-market fee snapshot. No float arithmetic belongs in the final P&L test.

### Proposed monitor identity

```text
pair_arb_observer_v0_RESEARCH_ONLY
```

It should produce observations, not ordinary directional `StrategyDecision` objects, because a pair candidate has two intents, a joint size constraint, and residual-leg state that do not fit the current single-side order path.

### Proposed output record

Each detected gross or net opportunity should record:

```ts
interface PairArbObservation {
  marketId: string;
  observedAtMs: number;
  upBookSourceTsMs: number;
  downBookSourceTsMs: number;
  upBookReceivedTsMs: number;
  downBookReceivedTsMs: number;
  maxBookSkewMs: number;
  feeScheduleVersion: string;
  grossTopOfBookSum6: string;
  grossTopOfBookEdge6: string;
  requestedPairShares6: string;
  jointlyExecutableShares6: string;
  upVwap6: string | null;
  downVwap6: string | null;
  totalFees6: string;
  netEdge6: string;
  netEdgePerShare6: string | null;
  activationLatencyMs: number;
  oneTickWorseNetEdge6: string;
  twoTickWorseNetEdge6: string;
  status:
    | "OPTICAL_ONLY"
    | "NET_POSITIVE_PRE_LATENCY"
    | "NET_POSITIVE_AT_ACTIVATION"
    | "DEPTH_INSUFFICIENT"
    | "BOOK_SKEWED"
    | "FEE_UNKNOWN";
}
```

This can initially live inside a research result artifact rather than a new database table. Add a table only if the event rate or dashboard use justifies it.

### Two-leg execution simulation

Even observe-only research should simulate two order sequences:

1. UP first, then DOWN after the configured inter-order delay;
2. DOWN first, then UP after the same delay.

For each sequence:

- activate the first FAK after signal latency;
- consume available asks up to the pair limit;
- activate the second leg after serialization/inter-order latency;
- cap the second leg to the first leg's fill if possible;
- measure unmatched residual shares;
- value residual shares at an immediate conservative liquidation price or full-loss bound;
- report best, average, and worst ordering results;
- never substitute a stale initial snapshot for the second activation book.

If the platform cannot guarantee atomic multi-leg execution, residual risk is the main result—not a footnote.

### Opportunity metrics

Report:

- count of timestamps with `up best ask + down best ask < 1`;
- count after exact fees;
- count after book walking for each stake size;
- count after 350/700/1,400 ms activation delays;
- total duration of each opportunity, not just sample count;
- median and maximum net edge;
- median jointly executable notional;
- opportunity half-life;
- fraction where both legs remain executable at activation;
- residual exposure distribution;
- results by book timestamp skew;
- results by fee regime and UTC session.

### Acceptance criteria for anything beyond monitoring

Do not design a live pair executor unless observe/paper data first shows:

- at least 300 independently activated, net-positive pair fills;
- positive P&L after residual-leg loss assumptions;
- profitability under both leg orderings;
- positive lower confidence bound under 2x measured latency;
- enough joint notional to matter after operational costs;
- no dependency on stale or time-skewed book snapshots;
- current rules/API support for the intended order semantics;
- a dedicated two-leg state machine, reconciliation path, and kill behavior.

Our existing calibration result—roughly 24 gross seconds among 4.27 million ticks, with fewer after fees—makes promotion unlikely. The monitor is still worthwhile because it can verify that conclusion under current, oracle-labeled, fee-regime-current data.

---

## 3. Strategy tournament / simultaneous shadow evaluation

### Upstream idea

The upstream runner evaluates five strategies in the same market loop and keeps separate nominal bankrolls. This avoids comparing one strategy from Monday with another from Thursday.

### What is worth borrowing

Borrow the paired experimental design:

- one market-data snapshot;
- several deterministic strategy evaluators;
- independent decision records;
- identical execution assumptions;
- independent virtual ledgers;
- paired comparison on the same markets and timestamps.

This is more valuable than running one active preset at a time because market regime is a large confounder.

### What must not be borrowed

- Do not give every heuristic an arbitrary $100 bankroll and compare ending balances without uncertainty.
- Do not allow strategies to fetch their own market data; that creates timestamp and staleness differences.
- Do not let a strategy silently fall back to 0.50 prices.
- Do not mark a strategy as “traded” when it merely emitted a signal or when execution failed.
- Do not share mutable indicator state across markets.
- Do not use Binance resolution labels.

### Proposed architecture

Keep production engine behavior unchanged. Implement tournament evaluation in `apps/research`, consuming immutable stored features/books:

```text
stored feature snapshot
        |
        +--> book baseline
        +--> distance/vol heuristic
        +--> late-snipe composite
        +--> early momentum M0
        +--> early momentum M2
        +--> persistence M3
        +--> contrarian negative control
        +--> pair-arb observer (separate pair result)
```

Each evaluator returns a research decision with:

- strategy version;
- feature snapshot id/timestamp;
- candidate or rejection;
- side, if directional;
- exact rejection checks;
- requested execution style;
- pre-latency quoted economics;
- simulated activation economics;
- fill result;
- resolution;
- P&L.

The same execution simulator configuration must be applied across comparable strategies. Directional takers should use the same stake, latency distribution, quote-age limits, and fee schedule. Maker and taker results must not be ranked without clearly separating execution class.

### Comparison report

For each strategy and pairwise comparison, report:

- candidate count;
- executable count;
- fill count and fill rate;
- win rate with Wilson interval;
- average entry price;
- average break-even probability;
- Brier score and calibration error if a probability exists;
- gross and net P&L;
- P&L per candidate and per fill;
- maximum drawdown under fixed-stake replay;
- result by day and walk-forward fold;
- one-tick and 2x-latency sensitivity;
- paired P&L difference on markets where both strategies acted;
- rejection-reason distribution.

The fixed-stake ledger is for comparability, not a sizing recommendation. Kelly or bankroll-dependent sizing should be analyzed only after edge is established.

### Why this is valuable even if every strategy loses

A paired tournament can establish that:

- a complex composite does not beat a simple distance threshold;
- an apparently high win rate is entirely explained by expensive entry prices;
- one strategy emits more signals but fewer executable fills;
- gross pair dislocations disappear under book skew and fees;
- negative controls correctly lose, increasing trust in the simulator;
- changes in execution modeling affect all strategies consistently.

That is useful research output even when no preset is promoted.

---

## 4. Human-readable rule tags and explanations

### Upstream idea

The upstream signals use compact reason names such as:

- `sniper`
- `momentum_magnitude`
- `momentum_3min`
- `momentum_4min`
- `arb_sum_to_one`

### What is worth borrowing

These names are clearer than a generic “model candidate” when examining hundreds of decisions. Reuse the vocabulary as experiment tags, with versioned definitions.

Recommended tags:

```text
momentum_literal_100usd_t120_v0
momentum_distance_bps_t120_v0
momentum_distance_z_t120_v0
momentum_3_completed_minutes_v0
momentum_4_completed_minutes_v0
momentum_acceleration_agrees_v0
pair_arb_gross_top_of_book_v0
pair_arb_net_depth_adjusted_v0
contrarian_negative_control_v0
```

Each tag must map to a documented, immutable rule. Never reuse a tag after changing a threshold or calculation.

### What must not be borrowed

Do not store prose such as “BTC moved hard, high confidence” without the underlying values. A reason record should include:

- threshold;
- measured value;
- pass/fail;
- timestamp;
- data source and age;
- model/version;
- exact executable price and break-even;
- whether the observation was signal-only, executable, filled, or resolved.

This repository's existing `GateCheck` structure already embodies the correct pattern. The borrowed value is mainly the experiment vocabulary.

---

## Ideas to retain only as negative controls

### Contrarian / mean reversion

The upstream post says contrarian lost every paper trade, and the backtester contains look-ahead. There is no positive integration case.

A deliberately simple contrarian evaluator can nevertheless serve as a **negative control**:

- when current leader ask exceeds a threshold and loser ask falls below a threshold, buy the loser;
- evaluate using synchronized asks at the same timestamp;
- apply exact fees and conservative execution;
- resolve on Chainlink;
- expect negative P&L.

Why keep it at all?

- If this control becomes strongly profitable in a new backtest, suspect leakage, stale prices, or outcome-label errors.
- It quantifies the cost of fighting short-window directional persistence.
- It creates a benchmark for whether an execution-model change has become unrealistically generous.

This control must never be active in the engine or exposed as an operator preset.

### Enhanced technical analysis

The upstream [`enhanced_ta.py`](https://github.com/YashSerai/polymarket-bot/blob/main/strategies/enhanced_ta.py) module fetches Binance candles, order-book imbalance, recent trades, cumulative volume delta, volume delta, walls, EMA, RSI, and related features. The feature ideas are common and already substantially represented by our indicator block and stored book/reference features.

There is no reason to port it because:

- its scores and confidence mapping are heuristic;
- REST polling gives components different timestamps and staleness;
- cumulative volume delta handling can double-count the same recent trades across repeated polls unless trade identity is deduplicated;
- Binance microstructure does not determine Polymarket execution price;
- our 14,226-market walk-forward study already included momentum, volatility, imbalance, depth, quote flips, complement dislocations, and time features, and did not beat the midpoint baseline.

The only useful action is to make sure any future feature study includes a clean ablation table showing whether each indicator adds out-of-sample value beyond market price. No upstream TA code should be copied.

### Sniper / latency-lag strategy

The upstream [`sniper.py`](https://github.com/YashSerai/polymarket-bot/blob/main/strategies/sniper.py) concept overlaps with our late-snipe research question: detect a reference-market move before Polymarket reprices.

The code itself adds nothing useful:

- it polls Binance REST endpoints with multi-second timeouts;
- it uses Binance's one-minute candle open rather than the authoritative Chainlink price-to-beat;
- it assumes a token at or below 0.50 after a 0.03% move is underpriced;
- it assigns confidence by a hand-written linear formula;
- it does not prove the quote survives order latency.

The concept is already covered more rigorously by:

- Chainlink-confirmed direction;
- window delta and micro-momentum;
- late-snipe paper/shadow restrictions;
- real CLOB books;
- activation-time execution;
- the calibration study's late-favorite analysis.

Do not add another sniper preset. Treat M0–M4 as the only new directional experiments from this review.

---

## Explicit do-not-borrow list

The following upstream elements are rejected:

1. **Hard-coded confidence values.** They are scores, not probabilities.
2. **Fixed 2% fee assumption.** Use the discovered per-market schedule and exact nonlinear fee formula.
3. **Best-ask-equals-fill accounting.** Use activation-time book walking and partial fills.
4. **Minute price history as high-frequency execution evidence.** It cannot validate a latency strategy.
5. **Backward-as-of joins without maximum age.** Every joined quote needs a freshness limit.
6. **Contrarian full-window min/max logic.** It is look-ahead and non-simultaneous.
7. **Binance outcome labels.** These markets resolve from Chainlink under the verified rules.
8. **Default/fallback 0.50 prices.** Missing price means reject/fail closed.
9. **Broad exception swallowing.** Data failure must create an auditable health/rejection event.
10. **Single-order representation of a pair trade.** Pair execution requires a dedicated two-leg state machine.
11. **Arbitrary independent bankroll comparison.** Use paired statistics and fixed-stake research ledgers first.
12. **Win-rate-first evaluation.** Expected value relative to entry price is the primary quantity.
13. **One-night sample conclusions.** Require registered walk-forward samples and uncertainty.
14. **Any live execution path.** The current repository intentionally has no signer and no calibrated live model.
15. **Direct source copying.** No upstream license was visible at review time.

---

## Proposed implementation backlog

This is a design backlog, not authorization to implement or arm a strategy.

### Phase 0 — research registration

Create a small machine-readable experiment manifest before computing results:

- exact strategy variant ids;
- threshold grids;
- decision horizons;
- primary metric;
- multiple-testing family;
- training/test fold schedule;
- minimum samples;
- stress scenarios;
- acceptance and kill criteria;
- current git commit and dataset hashes.

Suggested artifact:

```text
data/research/yash-serai-borrow/experiment-manifest.json
```

The primary metric should be net P&L per independent market-level candidate under conservative activation-time execution. Win rate is secondary.

### Phase 1 — offline momentum ablation

Suggested code location:

```text
apps/research/src/momentum-persistence.ts
apps/research/test/momentum-persistence.test.ts
```

Responsibilities:

- load stored features/reference ticks and resolved outcomes;
- construct M0–M4 without future data;
- emit at most one primary candidate per strategy variant per market;
- align activation books after simulated latency;
- calculate executable fills and exact fees;
- produce fold-level and aggregate JSON results;
- generate a Markdown summary from the JSON, not hand-maintained numbers.

Avoid adding it to `packages/strategy` until offline results justify engine integration.

### Phase 2 — pair-arb observer

Suggested code location:

```text
packages/strategy/src/pair-arb.ts
packages/strategy/test/pair-arb.test.ts
apps/research/src/pair-arb-study.ts
```

Pure strategy-layer responsibilities:

- accept two immutable `BookState` snapshots and a fee schedule;
- compute synchronized top-of-book gross edge;
- compute joint depth and exact two-book VWAP;
- calculate exact net edge for a requested share quantity;
- return a structured observation without placing orders.

Research-layer responsibilities:

- enforce maximum book timestamp skew;
- simulate latency and leg ordering;
- aggregate opportunity duration and economics;
- write a reproducible result artifact.

Do not route this through the current single-side `PaperExecutor` without first designing explicit pair semantics.

### Phase 3 — multi-strategy tournament

Suggested code location:

```text
apps/research/src/strategy-tournament.ts
apps/research/test/strategy-tournament.test.ts
```

Start with offline replay. Do not make the production engine evaluate every strategy until the research harness proves useful and resource costs are measured.

The tournament should reuse one feature snapshot and one activation-book timeline for all strategies. Results should include both standalone and paired comparisons.

### Phase 4 — optional shadow integration

Only if Phase 1 shows a result worth collecting prospectively:

- add `early_momentum_persistence_v0_RESEARCH_ONLY` to the preset registry;
- allow only `observe` and `shadow` initially;
- preserve `calibration_required: true`;
- keep model `approvedForLive: false`;
- keep live execution absent;
- persist all failed gates as well as candidates;
- add explicit dashboard labeling: `UNVALIDATED RESEARCH SIGNAL — NOT AN EDGE CLAIM`.

Paper mode should require another deliberate change after sufficient shadow candidates show that activation-time quotes are observable and replayable.

---

## Test plan

## Momentum unit tests

- exactly $100 at T+120 qualifies for M0; $99.999 does not;
- a large move before the registered horizon does not leak a later price into the horizon snapshot;
- UP/DOWN direction comes from Chainlink distance, not Binance;
- missing price-to-beat rejects;
- stale Chainlink rejects;
- flat completed minute is `FLAT` for persistence even though an exact final tie resolves UP;
- three same-direction completed bars qualify for M3;
- two completed bars plus the current incomplete bar do not qualify;
- one contradictory completed bar breaks the run;
- a candidate is emitted at most once per variant per market;
- threshold/version changes create a different experiment id.

## Momentum leakage tests

- mutating ticks after the decision timestamp cannot change the decision;
- outcome is unavailable to the evaluator until resolution;
- book selection uses the first valid snapshot at/after activation, never before signal time;
- a missing activation book produces no fill rather than falling back to the signal-time quote;
- maximum quote age is enforced.

## Pair-arb arithmetic tests

- coherent books with asks summing above one produce no net opportunity;
- gross sum below one can still be net negative after fees;
- depth walking changes VWAP correctly on both books;
- joint size equals the smaller executable equal-share quantity;
- rounding never overstates profit;
- unknown fee schedule fails closed;
- excessive book timestamp skew marks the observation invalid;
- a one-sided fill produces residual exposure, not guaranteed profit;
- reversed leg order can produce a different simulated result;
- one-tick stress is applied to both legs;
- exact equal holdings always produce one-unit payout per pair regardless of outcome.

## Tournament tests

- every strategy receives the same snapshot timestamp;
- strategy-local state cannot affect another strategy;
- candidates and fills are counted separately;
- no-fill candidates contribute zero realized P&L but remain in opportunity statistics;
- paired comparison uses only overlapping eligible markets;
- fixed stake is identical across comparable strategies;
- fees and latency configuration are identical across comparable strategies;
- a deliberately leaky fixture is detected by the leakage test suite;
- contrarian negative control loses on a constructed momentum fixture.

---

## Reporting template

Every study produced from these ideas should begin with the following table:

| Field | Required content |
|---|---|
| Dataset | source, dates, market count, tick count, hash |
| Resolution | Chainlink boundary method and Gamma mismatch count |
| Fee regime | discovered schedules and conventions |
| Candidate definition | immutable version id and thresholds |
| Execution | latency, quote-age limit, depth model, fill model |
| Primary metric | net P&L per market-level candidate |
| Baseline | executable market-price/null strategy |
| Validation | walk-forward fold definition |
| Multiplicity | registered family and corrections |
| Sample size | candidates, executable candidates, fills, resolved fills |
| Stress tests | latency, ticks worse, depth reduction, fees |
| Promotion decision | rejected / continue shadow / eligible for paper review |

Required result tables:

1. signal counts and reasons;
2. signal-conditioned outcome accuracy;
3. executable and fill-conditioned accuracy;
4. entry price and break-even distribution;
5. exact net P&L;
6. day/fold stability;
7. price, side, volatility, and time-bucket breakdown;
8. latency/slippage/depth sensitivity;
9. comparison with book midpoint and existing presets;
10. explicit kill/promote decision against the pre-registered criteria.

Never publish only the best threshold or only the aggregate win rate.

---

## Relationship to the existing calibration study

The current study already gives strong priors:

- a 13-feature walk-forward model including momentum did not beat the midpoint at any tested horizon;
- maker fills were materially adversely selected;
- structural pair arbitrage was virtually absent in gross snapshots and rarer after fees;
- late favorites showed price lag, but the pattern looked like a latency pool with small displayed size;
- extreme-price win rates do not automatically imply positive taker EV.

Therefore these borrowed hypotheses are **incremental checks**, not a new strategic direction.

What M0–M4 add:

- direct reproduction of the upstream's simple early-move rule;
- interpretable rule-based ablations rather than a fitted multivariate model;
- a prospective route to oracle-true, fee-regime-current paper observations.

What the pair-arb observer adds:

- exact, current, depth-aware opportunity-duration telemetry;
- explicit two-leg residual-risk measurement;
- a regression monitor for book synchronization and fee calculations.

Neither addition changes the current conclusion: nothing is live-eligible.

---

## Final recommendation

Take the upstream repository as a source of **experiment names and simple hypotheses**, not code or evidence.

The worthwhile borrow is deliberately small:

1. reproduce the `$100 by T+120s` momentum claim once as M0;
2. test normalized magnitude and completed-minute persistence as M1–M4;
3. measure pair arbitrage with exact two-book economics as an observer;
4. compare all strategies on identical snapshots through a research tournament;
5. keep contrarian as a leakage-sensitive negative control;
6. reject everything unless it beats executable market price in walk-forward, fill-conditioned, post-fee P&L.

Expected engineering value:

- better falsification of social-media strategy claims;
- clearer paired comparisons among our existing and proposed signals;
- improved visibility into complement dislocations and two-leg risk;
- a reusable research harness even if every new hypothesis is killed.

Expected trading value: probably little or none. That is acceptable. A small, well-designed experiment that kills an attractive but false idea is more valuable than importing a profitable-looking simulation built on non-executable assumptions.

**Status after this review:** documentation only; no strategy added, no configuration changed, no paper or live behavior changed.
