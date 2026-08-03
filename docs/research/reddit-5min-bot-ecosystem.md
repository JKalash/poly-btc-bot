# The r/algotrading Polymarket 5-minute bot ecosystem — full research dossier

**Source thread:** [\[Update 2\] I was bored so i though of making a 5-min polymarket bot. Here's the progress so far after 4 weeks.](https://www.reddit.com/r/algotrading/comments/1u0cz4n/) — u/Orphis\_, r/algotrading, June 2026.

**Retrieved:** 2026-08-03, via public Redlib mirror (reddit.com blocks non-authenticated fetches). All quotes
verbatim from the archived pages. This dossier covers the full three-post series, the comment-section
intelligence, every dataset/codebase the ecosystem has published, and what all of it means for this repo.

**TL;DR: the thread is an independent, multi-party replication of this repo's central design thesis.**
Three separate builders (the OP, the `kachoio` dataset author, the `openmarket` author) built serious
5-or-15-minute Polymarket BTC bots with ML models and realistic execution simulation, and all three
arrived at the same terminal finding: *model accuracy survives; executable edge does not.* One of them
is literally the arXiv paper our build spec cited as its "research warning." The thread also hands us
the single most valuable thing we lacked: **months of recorded order-book history, free**.

---

## 1. The post series (u/Orphis_)

### 1a. Original post — ["I was bored so i though of making a 5-min polymarket bot" (2 weeks in)](https://www.reddit.com/r/algotrading/comments/1tpu2nz/)

Stack built in two weeks: paper-live validation loops, execution realism modeling, slippage stress
testing, rolling economic validation, drift monitoring, latency instrumentation, quote freshness
analysis, regime analysis, conditional-edge research, readiness gating, dashboard. No live execution,
no wallets, no keys. (Convergent evolution: this is nearly our architecture, independently derived.)

Key findings, verbatim numbers:

- "The broad baseline strategy initially looked mildly profitable under naive assumptions, but
  **progressively died as execution realism increased**."
- Realistic PnL slightly negative; conservative/harsh/catastrophic assumptions strongly negative.
- "**Edge dies with ~0.01 additional slippage**" — i.e. one tick of friction kills the whole strategy.
- "Prediction latency wasn't the bottleneck at all" (inference ~100ms). The actual bottlenecks:
  collection latency, quote freshness, stale-tail risk, execution-path quality.
- **Quote freshness: median ~1.5s, but p95 exploded to ~67s in tail-risk scenarios.** The book you
  think you see is not the book you trade against, precisely when it matters.
- Readiness score fell 60 → 38 as realism increased, driven by medium-volatility conditions,
  bearish/DOWN setups, and tighter-spread environments.

### 1b. [Update 1 (2 weeks)](https://www.reddit.com/r/algotrading/comments/1tv6vug/) — "The broad strategy is dead"

- **177 finalized paper trades.** Aggregate PnL negative once realistic execution applied: "A lot of
  what initially looked profitable was just execution optimism."
- **Dominant rejection reason was `price_too_high`, not latency.** (Identical to our engine's
  observed behavior: candidates blocked by price/edge gates, not by speed.)
- One narrow conditional family survived — `medium_volatility_plus_bearish`: 15 trades,
  realistic +0.835 / conservative −0.264 / harsh −0.324. OP's own read: possibly a small-sample
  artifact. A larger family (`bearish_short_term_only`, ~76 trades) stayed "slightly profitable."
- The question OP asked the sub: how do you distinguish a genuine rare conditional edge from a
  small-sample illusion? (Answer that stuck, from u/PapersWithBacktest, §3.)

### 1c. [Update 2 (4 weeks) — the linked post: the 5-minute bot is killed](https://www.reddit.com/r/algotrading/comments/1u0cz4n/)

Verbatim, the core verdict:

> "Most opportunities were getting blocked by: high contract prices, tiny theoretical edges, spread
> friction, market microstructure issues. Even when predictions looked decent, **there wasn't enough
> room between prediction accuracy and execution costs to create a reliable trading system. The
> closer I got to production realism, the less attractive the strategy became.** … The project wasn't
> failing because of bugs. **It was failing because the economics weren't there.**"

Pivot to a **15-minute bot**, currently research-only and deliberately blocked from paper AND live:

- 196 unique BTC 15-minute markets collected; 11,932 labeled observations; 99.7% label coverage;
  195 resolved markets. Labels only from explicit market resolution data — never inferred from price.
- Stated research question: "can the market outcome be predicted at all in a leakage-safe environment?"
- Planned gauntlet before any paper trade: walk-forward validation, regime analysis, feature
  importance, edge stability, out-of-sample evaluation. "If not, I'll kill this version."

---

## 2. Comment-section intelligence (the best part of the thread)

### u/File-Environmental — the XGBoost live post-mortem (identified as the `kachoio` dataset author, §4a)

> "I built an XGB model to estimate the correct implied probability at a given time … coded in Rust …
> backtested against a month of data — 1s order book snapshots of the BTC 5min markets. **The bot did
> well on paper (fees included) but not as good in practice and it lost me several hundred bucks.**
> … the fees were eating any potential profit it could earn anyway."

The autopsy details, which are the empirical heart of the whole thread:

- "**About a third of the trades didn't go through.** If I had a history of these I would've been able
  to check whether they were the high value trades that were driving up the ROI." — i.e. suspected
  **fill-selection bias**: the fills you don't get are disproportionately the profitable ones.
- "**Polymarket is probably 1-2 seconds slower to react to price swings that happen in Binance**,
  which is not as easy to exploit when other traders have already factored this in their bots."
- "1s order book snapshots is certainly not granular enough to truly evaluate a strategy."

### u/gregyoung14 — the `openmarket` author (15-minute markets, same conclusion)

> "I built exactly this, for 15 Minute BTC Markets, in Rust, and arrived at the exact same conclusion.
> I literally just open sourced the entire codebase and all **97gb of Data** collected from Binance and
> PolyMarket order book ticker data."

> "I had a strong win rate for a week or two at **around 64%** but I was getting burned on the contract
> value and limited returns. I thought maybe training on ms orderbook data from polymarket I'd find a
> pattern there, paired with the realtime price data from binance, but no. Nothing significant.
> **Technical Analysis alone I don't think it's possible to win enough to cover the fluctuations in
> contract price.** Now a strategy around capturing both sides, sub 47c contracts, and arbitraging a
> point or two, could be something worth exploring."

(64% directional win rate and still unprofitable — because the contract price already charges you for
the win probability. This is the fee-wedge/price-in-the-way problem in one sentence.)

### u/Glass_Molasses_5429 — the RL/HMM warning

> "Over 10k markets of tick by tick full orderbook data here, tested multiple truly legit strategies
> (PPO/HMM hybrids). Could observe **a couple edges appearing sporadically and getting crushed by bots
> entering to just hammer them down** and get burned because of the lack of liquidity."
> Example account cited: [a burned bot wallet](https://polymarket.com/@0x56991cfb6c8062e5a06ae10ccf240463bdfac4b4-1779235666088?tab=activity).
> "…you are essentially the average Joe betting on the existence of an edge without factoring in
> execution risk properly."

Edges in this market are *self-extinguishing*: visible edge attracts bots, which both compete it away
and get burned on the thin liquidity while doing so.

### The two principles worth framing (verbatim)

- u/CODE_HEIST: "**Killing the first version is probably the most important part of the update.**
  Short-horizon prediction markets punish hidden assumptions fast: latency, fill quality, stale
  signals, fees, and whether the market is already pricing the obvious move. Keep separating model
  accuracy from executable edge, because those are very different things."
- u/PapersWithBacktest: "'dataset health 99/100' and 'research readiness 100/100' are data-quality
  scores, not edge scores. The only number that decides whether this version lives is out-of-sample
  PnL net of realistic fills, measured against that market-price baseline. **Define one null
  hypothesis — 'I can't beat the market's own price' — and if walk-forward can't reject it, kill it
  without sentiment.**"
- u/StationImmediate530 (the market-maker's take): "next 5/15 mins up down is a literal coin toss,
  therefore the edge is trading both sides and managing inventory."
- u/Artelj: "For us retail traders those markets are a **systems engineering problem not an
  alpha/edge problem**."
- u/xmot7 (on the 15-min pivot): 196 markets ≈ 2 days of data — "Anything your llm tells you it
  finds on that dataset is pure hallucination." u/valbolt concurred: could be "a specific market
  regime that disappears next week."

---

## 3. The resource map — datasets and code this ecosystem published

### 4a. The `kachoio` free 5-minute order-book dataset ⭐ (most actionable for us)

[Announcement thread](https://www.reddit.com/r/algotrading/comments/1u8fsg7/) ·
[write-up](https://kacho.io/polymarket-5min-crypto-dataset) ·
[Hugging Face](https://huggingface.co/datasets/kachoio/polymarket-5-minute-crypto-up-down-markets) ·
[Kaggle](https://www.kaggle.com/datasets/kachoio/polymarket-5-minute-updown-markets)

- **~89,000 resolved 5-minute markets, ~26.8M once-per-second top-of-book samples.** BTC (24 Mar–18
  May 2026, ~15,700 markets) + ETH/SOL/XRP/DOGE/HYPE/BNB (5 Apr–18 May). **CC0, Parquet, ~725MB.**
- Schema: per-market (`condition_id`, window start/end, inferred outcome, volume/liquidity at
  discovery, token ids, tick count) + per-second ticks (best bid/ask and sizes for Up AND Down,
  bid-side depth within 5¢).
- Caveats the author documents: outcome inferred from final bid (not on-chain), ask-side depth absent,
  volume is discovery-time, 1Hz best-effort, ~20 windows lost per coin to collector outages.
- Author's own result with it: backtest "3–5% ROI after fees" → **live loss ~$600** (stale odds +
  adverse selection). The dataset exists *because* the strategy died.

### 4b. `gregyoung14/openmarket` — the 15-minute research platform (97GB, Rust, Apache-2.0)

[Repo](https://github.com/gregyoung14/openmarket) · HF: `gregyoung14/openmarket-btc-polymarket`

- 17 Rust crates, ~17.8k LOC: WS collectors (Binance ticks + Polymarket books), millisecond
  cross-venue synchronizer, feature/signal engines, **walk-forward calibration pipeline**, replay
  backtester, Parquet exporters. 109-day window (Mar–Jul 2026), **727M unified rows**, 2.9M paired
  cross-venue events. Now in "archival shutdown" (v0.5.2) as a frozen public research record, with an
  arXiv paper — **this is the same "OpenMarket research warning" (arXiv 2607.26245) our build spec
  cites.** The circle closes: the spec's cautionary citation and this Reddit commenter are one project.
- **The four numbers that matter:**
  - Polymarket book events lag Binance moves by **median 16ms** (heavy tails); quote responses to
    large Binance moves at **median 347ms** collector-clock latency. The latency race is decided in
    tens of milliseconds — unreachable from a home connection.
  - **91.9% of spreads are one tick wide** — there is almost no spread to earn, and no room to improve
    a quote without crossing.
  - Their calibrated model: **0.838 AUC out-of-sample — beaten by the naive mid-price prior at
    0.841.** The market's own price is the best predictor of the outcome. This is the strongest
    empirical validation of our `book_baseline` null-model design that exists anywhere.
  - Simulated economics: **−0.116 PnL per trade** under stated fees/slippage, *despite* 261,889
    candidate "+EV" trades identified. +EV candidates in aggregate lost money — fill selection and
    friction, quantified at scale.

### 4c. PMXT — the L2 archive that was shut down

[Shutdown announcement](https://www.reddit.com/r/algotrading/comments/1vc2qt7/) ·
[collector script](https://github.com/pmxt-dev/polymarket-orderbook-collector)

"We've been asked to shut down archive.pmxt.dev." Free L2 tick history (previously ~2 months of depth
data, per thread comments) is gone; the collection script survives. Two signals: (1) **historical
depth data is scarce and getting scarcer** — our own recorder is the only reliable source going
forward; (2) someone with leverage (plausibly Polymarket) is actively discouraging public
order-book archives.

### 4d. `kachence/polymm` + the cross-venue arb post-mortems (esports, not BTC — but the best execution lessons in the thread ecosystem)

[Repo (MIT)](https://github.com/kachence/polymm) ·
[3-month retro](https://www.reddit.com/r/algotrading/comments/1u17e2v/) ·
[directional-residual post-mortem](https://www.reddit.com/r/algotrading/comments/1ujsw6m/)

Strategy: de-vig sharp sportsbook odds → fair value; post passive limits on Polymarket esports at
≥7% edge; hedge the pair. **Passive-only is forced**: crossing these wide books wipes the edge.
Results over 3 months, 3,858 fills, ~$96k volume: **arb +$8,293, forced unhedged residual −$3,184,
net ~+$5k**, then decay killed it (monthly win rate 50.2% → 48.3% → 43.4% as competition arrived and
fees were introduced; Feb +$2,506 → Mar +$390 → off).

Why a book of "+7% edge" residual legs *lost* $3,184 — quantified adverse selection:

- **Stale quotes**: fair values up to 30 min stale (scraped, not API). Across 2,555 matches the true
  line moved ≥5 points pre-match in ~⅓ of them (CoD median jump 10.9pp!). "The only orders that
  lifted mine were the ones that already knew it was wrong."
- **An unvalidated transformation**: Shin's de-vig method, adopted because "the AI suggested it, it
  sounded sophisticated, I never checked." Month-by-month natural experiment showed it silently
  overpriced favorites (favourites ROI ~1.5% with it, 11.7–45% without).
- Plus a sign-flip bug that held the wrong team for a while.

Lessons that generalize to BTC 5-min: every quote is an option you sell to better-informed flow;
every untested transformation is a silent P&L leak; passive fills arrive precisely when you're wrong.

### 4e. Unverified press claims (context, not evidence)

Trade-press items surfaced while researching (e.g. [MEXC news](https://www.mexc.com/news/408299),
[another](https://www.mexc.com/news/701290)) claim things like a bot turning "$63 into ~$131,000 in a
month" and "~9,000 trades netting ~$150k in small arbitrage spreads" on 5-minute markets, and note
that 5–15-minute up/down contracts now account for **over half of Polymarket/Kalshi crypto volume**,
with HFT firms exploiting latency gaps. Treat the P&L claims as unaudited marketing; the volume-share
and HFT-presence claims are consistent with everything above.

---

## 4. Synthesis — what this changes for OUR system

### Confirmed (no action needed, confidence upgraded)

1. **The null-model design is vindicated empirically.** openmarket's calibrated model (0.838 AUC)
   lost to the raw mid-price (0.841). Our `book_baseline`-as-null-hypothesis and the
   "conservative probability must beat effective break-even" gate are exactly the right architecture.
   PapersWithBacktest's phrasing is now our official test: *"I can't beat the market's own price"
   must be rejected out-of-sample before anything trades.*
2. **Conservative fill modeling is not pessimism, it's realism.** Two independent live accounts
   (kachoio −$600, polymm −$3,184 residual) plus "⅓ of trades didn't go through, probably the good
   ones" justify our queue-behind/trades-must-print paper model. If anything our model is still too
   kind: we don't yet model *which* fills fail (selection), only whether queue volume printed.
3. **The 1–2s Binance→Polymarket lag exists and is already monetized by faster players** (16ms/347ms
   medians in openmarket's data). Our decision not to chase the latency race is correct; a home
   setup competes on research, not speed.
4. **The three-builder failure pattern matches our engine's live behavior** (it refuses to trade,
   dominated by price/edge rejections — same as OP's `price_too_high`). Our system reaching the same
   verdict via the same mechanism is a successful replication, not a malfunction.

### New facts worth acting on

5. **⭐ Ingest the kachoio dataset.** This fills our single biggest gap: recorded book history we
   didn't capture ourselves. ~15,700 BTC 5-min markets with 1Hz two-sided top-of-book + outcomes.
   Concrete uses, in priority order:
   - **Calibration-by-price study**: realized outcome frequency vs quoted price by seconds-remaining
     bucket — the fee-wedge dead-zone question ("are extreme late prices biased?") answered on ~16k
     markets instead of waiting months. Directly feeds the late-snipe preset's walk-forward gate.
   - **Timing Lab backfill at book level** (we only have outcomes from Gamma; this adds spreads,
     depth and quote dynamics per minute bucket).
   - **Tie-rule premium measurement**: P(final == start) and Up-rate conditional on realized vol.
   - **Paper-executor validation**: replay our conservative fill model against real book evolution.
   - Caveats to respect: outcome inferred from final bid (cross-check vs our Gamma outcomes),
     no ask-side depth, 1Hz ceiling.
6. **Mine `openmarket` before building our own calibration pipeline from scratch.** Their
   walk-forward calibration pipeline (Rust, Apache-2.0) and 727M-row millisecond dataset are exactly
   the artifact our `calibrated_logistic` slot is waiting for. Even a straight replication of their
   0.838-vs-0.841 result on our features would complete our validation story.
7. **The 15-minute question is now half-answered.** The OP pivoted 5m→15m hoping for better
   economics; gregyoung14 already ran the full experiment on 15m and got the same null. If we ever
   extend to 15-minute markets (the engine's discovery/slug machinery generalizes trivially), it is
   to *test* his result, not to escape the 5-minute conclusion.
8. **The only strategy family with a live-verified positive number in this entire ecosystem is
   passive two-sided/cross-venue structure capture** (polymm's arb leg: +$8.3k) — and it decayed to
   zero within 3 months and imported a toxic directional residual. StationImmediate530's "trade both
   sides and manage inventory" and gregyoung14's "both sides sub-47c, arb a point or two" point the
   same direction. If we ever add a strategy version worth researching next, it's a **two-sided
   inventory/complement-consistency maker study** (our `complementConsistency` feature is the seed) —
   entered, as always, through the paper→walk-forward gauntlet, with adverse selection as the null
   explanation to defeat.
9. **Data collection urgency is real.** PMXT was shut down on request; kachoio's window ended in
   May; openmarket is frozen. Public archives keep dying. Our engine's own recorder (ticks + books +
   trades, running whenever `pnpm dev` is up) may be one of the few continuously-collected private
   BTC-5m book histories. Keep it running; it appreciates.
10. **Import the polymm process lessons as governance rules** (they map to features we already
    have — use them): every transformation A/B-validated before adoption (our config versioning +
    walk-forward requirement), no silent "sophisticated" adjustments (Shin's-method lesson), and
    sign conventions covered by tests (their sign-flip bug; our domain tests pin side/direction math).

### Sharpened warnings

11. **Small-sample conditional "edges" are the main psychological trap.** OP's
    `medium_volatility_plus_bearish` (15 trades, positive only under the friendliest assumptions) is
    exactly the pattern our research standards (≥1,000 candidates, ≥300 fills, BH/Bonferroni,
    positive lower confidence bound) exist to kill. The thread shows the trap catching a smart,
    careful builder in real time.
12. **Edges here are reflexive**: Glass_Molasses watched edges get "hammered down" by arriving bots
    that then burned themselves on the thin book. Any edge we ever validate should be assumed to have
    a short half-life and monitored with rolling-window stability (already in the Timing Lab spec).

---

## 5. Deep comparison: `openmarket` vs this repo

Repo facts (checked 2026-08-03): created 2026-07-01, frozen at v0.5.2, Apache-2.0, 13 crates
(collectors for Binance + Polymarket, recorder, synchronizer, signal/execution engines,
paper-executor, backtester, trainer, exporters), CI + Docker + `paper/` sources, 2 stars.
Corpus: 109-day publication window over a 93-day event span (2026-02-12 → 05-15), 727M unified
rows, 605.6M Polymarket ticks, 62.3M Binance trades, 4,450 markets tracked (2,251 modelable),
2.94M explicit cross-venue lag pairs. Model v0.2.1: 43 features, 357,390 rows, **559 walk-forward
windows**, OOS AUC 0.8377 vs naive mid prior 0.8405, negative simulated economics.

**Different species, same conclusion.** openmarket is a *frozen dataset + paper* — the finished
science of one experiment. This repo is a *living trading-operations system* — the instrument for
running that class of experiment continuously, safely, with an operator in the loop. They are
complementary, not competitors.

| Dimension | openmarket | this repo |
|---|---|---|
| Goal | Reproducible research record; explicit "not a trading bot" | Operating console: observe/paper/research, execution-shaped |
| Market | BTC 15-minute binaries | BTC 5-minute binaries |
| Status | Archived, data ends 2026-05-15 | Live; collecting whenever running |
| Data | 727M rows, millisecond, frozen | Own capture (young) + seeded stats; can ingest their corpus + kachoio |
| Resolution source | Binance-paired features; no oracle feed | **Records the Chainlink resolution stream itself** (exact `full_accuracy_value`, boundary capture, tie rule) — enables oracle/boundary studies they cannot do |
| Models | Calibrated GBM-class, 559-window walk-forward, honest null result | Null model + labeled-uncalibrated heuristics; calibration slot deliberately empty |
| Execution realism | Backtest fees/slippage; negative economics reported | Live paper executor: latency, post-only-would-cross rejection, queue-behind fills, FAK cap logic |
| Risk & safety | None needed (never trades) | Full risk engine, absolute 10% cap, kill switch, decision snapshots, audit, arming governance |
| Money math | Research floats | Exact bigint micro-units, both fee conventions |
| Ops surface | Notebooks, Parquet, paper | Dashboard, API, config versioning, health/audit |
| Reproducibility polish | CI, CITATION, Docker, HF releases — better than ours | Dev-grade monorepo with 147 tests |

**Where they are simply ahead of us:** they *finished* the experiment we built scaffolding for. The
0.8377-vs-0.8405 walk-forward comparison over 559 windows is precisely the "beat the market's own
price" null test our `calibrated_logistic` gate is waiting on — they ran it, at scale, and published
the negative. Their lead–lag methodology (per-day transport-delay envelopes bounding clock drift to
≤6ms; source-clock vs collector-clock separation) is more rigorous than our RTDS-envelope skew
estimate. And 91.9%-one-tick spreads is a stylized fact we should treat as ambient truth: there is
rarely room to improve a quote without crossing, so maker P&L is decided by queue position and
adverse selection — which is exactly what our conservative fill model assumes.

**Where we are ahead of them:** everything operational. They have no risk engine, no execution
governance, no live safety story, no oracle capture, no product — because they never intended to
trade. We capture the actual settlement feed (Chainlink), which their Binance-only pairing cannot
see; boundary/tie/final-print questions are answerable only on our side. And we are still
collecting, on the 5-minute series their corpus doesn't cover, after every public archive in this
ecosystem has gone dark.

**Concrete borrowings, ranked:** (1) run their pipeline/data (or replicate their AUC-vs-mid test)
as the canonical implementation of our walk-forward gate before writing our own trainer; (2) adopt
their source-clock/collector-clock separation for our latency instrumentation; (3) retrain their
43-feature recipe on 5-minute data (kachoio corpus + our capture) — that produces the calibration
artifact our engine's empty slot demands; (4) copy their reproducibility furniture (CITATION,
release manifests) when we publish anything.

## 6. Reference index

| Resource | Link |
|---|---|
| Update 2 (source thread) | https://www.reddit.com/r/algotrading/comments/1u0cz4n/ |
| Update 1 | https://www.reddit.com/r/algotrading/comments/1tv6vug/ |
| Original post | https://www.reddit.com/r/algotrading/comments/1tpu2nz/ |
| kachoio dataset write-up | https://kacho.io/polymarket-5min-crypto-dataset |
| kachoio dataset (HF) | https://huggingface.co/datasets/kachoio/polymarket-5-minute-crypto-up-down-markets |
| kachoio dataset (Kaggle) | https://www.kaggle.com/datasets/kachoio/polymarket-5-minute-updown-markets |
| openmarket repo (code + 97GB data + paper) | https://github.com/gregyoung14/openmarket |
| openmarket dataset (HF) | https://huggingface.co/datasets/gregyoung14/openmarket-btc-polymarket |
| OpenMarket arXiv (cited by our spec) | https://arxiv.org/abs/2607.26245 |
| polymm MM/arb bot (MIT) | https://github.com/kachence/polymm |
| Cross-venue arb retro | https://www.reddit.com/r/algotrading/comments/1u17e2v/ |
| Adverse-selection post-mortem | https://www.reddit.com/r/algotrading/comments/1ujsw6m/ |
| PMXT shutdown + collector script | https://www.reddit.com/r/algotrading/comments/1vc2qt7/ · https://github.com/pmxt-dev/polymarket-orderbook-collector |
| Dataset announcement thread | https://www.reddit.com/r/algotrading/comments/1u8fsg7/ |
| Burned-bot wallet example | https://polymarket.com/@0x56991cfb6c8062e5a06ae10ccf240463bdfac4b4-1779235666088?tab=activity |
| Press claims (unverified) | https://www.mexc.com/news/408299 · https://www.mexc.com/news/701290 |

*Retrieved 2026-08-03 via Redlib mirrors after reddit.com blocked direct access; archive services
(PullPush/Arctic Shift) had not yet indexed the thread. Quotes are verbatim from the mirrored pages;
numbers are as reported by their authors and unaudited unless noted.*
