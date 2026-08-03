# Karl — BTC 5-min Polymarket conversation record

**Date:** 2026-08-03 (WhatsApp, 09:50–10:28)
**Participants:** Karl Kalash, Joe
**Context:** Joe walked Karl through this repo (strategy, gates, feeds). Karl — who independently
built and live-tested a bot on the same BTC Up/Down 5-minute markets — pushed back, shared his own
measurements, and the conversation converged on this repo's null result from the opposite
(empirical/microstructure) direction.

---

## Part 1 — Every Karl message, verbatim, in order

### Opening challenge

```
[09:50:14] Bro bas you didn't answer my question
[09:50:14] What's the execution strategy?
[09:50:14] Everything you mentioned eltelak I've already done
[09:50:16] The live streams, the order books, etc
[09:50:33] Bas what's the logic behind the trades?
```

Follow-up questions (relayed by Joe, timestamps not captured):

```
You said there are gates that need to be passed, what are they?
also why the binance feed
(If it still uses chainlink data in the rules ma bt 3ouz binance)
```

### Pushback on the Binance/Chainlink explanation

```
[09:56]    Bro bas here's the thing
[09:57]    I ran a test over the course 48 hours consecutively
[09:57]    I was pulling 2 streams of data
[09:57]    Chainlink live pricing
[09:58]    1 data point every 0.03 seconds
[09:58:44] Bro wrong wrong
[09:58:52] This is Claude some bs
[09:59]    You cannot perform chart analysis on a 5 min window it's extremely inaccurate
[09:59]    Not statistically significant at all
```

### On indicators, and setting up his findings

```
[10:02]    Re: rsi, ema, fibonaci levels, etc
[10:02]    Sorry was buying food
[10:02]    Which makes binance useless
[10:02]    Am ellak scratch that bro
[10:03]    Useless delay
[10:03]    Khaline kafilak what I tested
[10:03]    Give me 2 min aal ad hbb
```

### His test setup

```
[10:08:19] What's the market mid?
[10:08:57] Ok so? 😂 we're saying the same thing
[10:09:05] Bas baad ma fasartelak shu 3melet
[10:09:22] I was paying for chainlink's api bro          (edited)
[10:09:48] Anw so I ran this at super high granularity
[10:09:50] PLUS
[10:10:32] Pulling the live books from Poly kamen at the same interval
[10:10:44] Bids, asks, depth, etc for EACH SIDE
[10:11:08] And ofc the Price to Beat
[10:11:31] The conclusion will make all of that very simple to you
```

### Finding #1 — book efficiency

```
[10:13:02] The Up/Down share pricing reflects the exact BTC price relative to threshold down to
           the 0.3 second latency (and probably even more if I dug deeper)
[10:13:08] In other words
[10:13:37] You can just use the pricing of those shares to dictate how close you are to that
           threshold
[10:13:47] And it's going to be as accurate as chainlink's love stream
[10:16:54] Live*
[10:16:56] In other words, don't attempt to price those shares more accurately than the market
           already is
[10:16:57] Because it does it very very efficiently
[10:16:59] Yaane if you see that a share price for UP is 92, it really means there's a 92% chance
           it's going to end UP. And if pricing is already that accurate, you don't have an edge
           over the market in terms of PRICING differently
```

### His verdict

```
[10:20:17] I think this strategy is a losing battle sade2ne
[10:20:17] I spent so much time on it we're never going to beat hedge funds
[10:20:17] If you think of another direction barke ykoun fi shi bas what you're trying to do is
           BASICALLY a pricing exercise, and then you trade when you spot a pricing inaccuracy
```

### Findings #2 and #3 — live experiments and the ghost-book problem

```
[10:21:33] Just to double down, I also did something else
[10:21:39] 2 things actually just to prove the randomness of this market
[10:28:07] Over the course of a whole week I would only buy shares that are priced OVER 93, in the
           remaining 10 seconds of a window
[10:28:07] My ending PnL was basically 0
[10:28:07] Then I ran another test over the course of a week where I would place a limit buy at
           50c for Up shares on every single window
[10:28:08] After a week PnL was also basically 0
[10:28:08] This shit is literally a coin toss
[10:28:09] Ah and one more thing
[10:28:09] When I was running that pricing strategy (with gates, conditions, etc), I also tried to
           do it with stop loss to avoid losing my whole bet in case market flips in the last
           couple of seconds
[10:28:09] Bas when you take into account that a ghost book can happen at any moment, it renders
           SLs (and even TPs) completely useless
```

---

## Part 2 — Agent analysis: takeaways

### Karl's four empirical findings, mapped to this repo

| # | Karl's finding (live, real money/feeds) | This repo's corresponding result | Status |
|---|---|---|---|
| 1 | Book reprices vs Chainlink within **~0.3s** (measured at ~33Hz on the **paid Chainlink Data Streams API**, time-aligned with Poly books + price-to-beat) | Calibration study (14,226 markets): mid beats every model at every horizon; `models.ts` book baseline is the null model ("its probability IS the market price") | **Mutually confirming** — he measured the mechanism, the study measured the outcome |
| 2 | One week buying only >93¢ favorites in the last 10s → **PnL ≈ 0** | Study: late favorite drift is real (~1pt underpricing) but maker fills cost ~8.8pts adverse selection | **Consistent** — breaking even *after taker fees* at 93¢ implies favorites win slightly >93%, i.e. the drift exists and fees/spread confiscate exactly all of it |
| 3 | One week of limit buys at 50¢ UP on every window → **PnL ≈ 0** | `models.ts` explicitly flags the tie-rule premium ("≥ resolves Up" → structural UP lean) as an **open research question** | **New data** — Karl's test answers the open question: no exploitable tie premium at 50¢ |
| 4 | Ghost books make stop losses and take profits **useless** in the final seconds | Architecture decision 5: conservative queue-model fills, post-only never converted, and **no SL/TP concept anywhere** — position size is the stop | **Validates the design** — independently discovered the same constraint that shaped the repo |

### Corrections Karl forced (he was right, we were wrong)

1. **"Chainlink is a slow oracle" — wrong for this market.** These markets resolve on the
   Chainlink BTC/USD **Data Stream**, not the on-chain push feed. Polymarket's RTDS rebroadcasts
   it at ~1/s (verified in `docs/architecture.md`); the paid Data Streams API Karl used delivers
   ~0.03s ticks. The deviation-threshold/heartbeat framing applies only to legacy on-chain feeds.
2. **Binance is not load-bearing.** The core model (distance z-score) is 100% Chainlink: distance,
   vol EWMA, velocity, crossings (`packages/strategy/src/features.ts`). Binance feeds only the
   confirmation-only composite indicators and a divergence sanity check. Karl's "ma bt3ouz
   Binance" is essentially correct; the honest residual reasons are volume data (Chainlink has
   none) and the sub-second lead — which finding #1 shows is unexploitable at retail anyway.
3. **5-minute chart analysis (RSI/EMA/fib) is noise.** Matches the repo's own stance — the
   composite model is labeled UNCALIBRATED, paper/shadow-only — and after this conversation the
   case for keeping it even as "confirmation garnish" is weak.

### The combined case (why the null result is now strong)

Four independent lines of evidence, different methods, same conclusion:

1. **Statistical** — this repo's walk-forward study on 14,226 resolved markets (out-of-sample,
   Wilson intervals, multiple-comparison corrections): the mid beats every model at every horizon.
2. **Mechanistic** — Karl's 33Hz measurement: the book tracks the settlement feed within ~0.3s,
   which *explains* why no slower model can find mispricing.
3. **Behavioral** — Karl's two week-long live experiments, both ≈ 0 PnL (real orders, real fills,
   no simulation assumptions).
4. **Ecosystem** — `docs/research/reddit-5min-bot-ecosystem.md`: three unrelated builders
   replicating the same null result.

**Conclusion: the BTC 5-minute Up/Down market is efficiently priced to sub-second latency and
calibrated to within ~1 point. There is no pricing edge, no chart edge, and no timing edge at
retail speed. The residual anomaly (late favorite drift) is real but smaller than the cost of
capturing it. Whatever edge exists belongs to the latency pool (colocated, on the paid feed) or
to the exchange collecting fees.**

### Known limits of the claim (honesty section)

- Karl's week-long tests are ~2,000 windows each; "PnL basically 0" is consistent with a true
  edge anywhere in roughly ±2%. They rule out a *large* edge; the 14k-market study rules out the
  small one. Neither alone suffices — together they do.
- The 0.3s latency figure assumes his Chainlink capture and book capture shared a clock. Plausible,
  unverified. He suspects the true latency is even lower ("probably even more if I dug deeper").
- Scope is **this market only** — the single most HFT-saturated product on the platform. Nothing
  here proves hourly/daily markets, complement arb, or knowledge-edge event markets are dead.

### Open threads / possible next directions (from the conversation)

- **Longer-horizon markets** (hourly/daily Up/Down): thinner HFT presence, speed matters less.
- **Complement arbitrage**: the engine already computes `complementInconsistency` (UP+DOWN vs $1);
  worth measuring whether the sum ever drops below 1 minus fees on less-watched markets.
- **Event markets** where information, not latency, is the edge.
- **Karl's datasets are valuable**: the 48h 33Hz capture (Chainlink Data Streams + synced books +
  price-to-beat) could directly measure the repricing-latency distribution this repo's study only
  inferred, and his two week-long PnL logs are independent live confirmation worth archiving.

### One-line summary

Karl live-tested his way to the exact conclusion this repo backtested its way to: **the 5-minute
market is a fee-collecting coin toss at retail speed** — and the two bodies of evidence are
stronger together than either alone.
