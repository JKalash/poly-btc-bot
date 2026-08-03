# Calibration study — BTC 5-minute markets, walk-forward, 2026-08-03

**Question:** can anything beat the market's own price on Polymarket BTC 5-minute up/down markets?
**Data:** kachoio CC0 corpus — 14,226 resolved BTC markets (2026-03-24 → 2026-05-18), 4.27M 1Hz
two-sided top-of-book ticks. **Method:** leakage-safe features at fixed decision horizons
(T-120/90/60/30/10s), logistic + isotonic, walk-forward by UTC day (≥7 train days), evaluated ONLY
out-of-sample against the null: *"I can't beat the market's own price."*
**Reproduce:** `apps/research/py/calibration_study.py` (results JSON: `data/research/kachoio/study_results.json`).

## Result 1 — The null holds. The mid-price wins at every horizon.

12,655 OOS decisions across 49 walk-forward test days, 13 features (spread, imbalance, depth ratio,
momentum ×3, vol, quote flips, complement dislocations, time buckets):

| Horizon | AUC model | AUC mid | Δ | Days model wins | Brier model | Brier mid |
|---|---|---|---|---|---|---|
| T-120s | 0.8823 | **0.8839** | −0.0015 | 20/49 | 0.13921 | 0.13912 |
| T-90s | 0.9158 | **0.9171** | −0.0012 | 16/49 | 0.11677 | 0.11686 |
| T-60s | 0.9450 | **0.9461** | −0.0011 | 17/49 | 0.09306 | 0.09335 |
| T-30s | 0.9749 | **0.9758** | −0.0009 | 14/49 | 0.06046 | 0.06067 |
| T-10s | 0.9893 | **0.9900** | −0.0007 | 19/49 | 0.03366 | 0.03449 |

This exactly replicates openmarket's 15-minute finding (0.838 vs 0.841) on the 5-minute series.
**No calibration artifact ships from this study; `calibrated_logistic` stays empty.** The engine's
refusal to trade on model edge is now a measured result, not a default.

## Result 2 — The spec's ":45 anomaly" is dead out of sample.

This corpus (Mar–May) predates the spec's analysis window (Jun 30–Jul 30), making it a true
out-of-sample test. `:45` Up rate: **52.25%** (CI 49.4–55.1, p_raw 0.20, p_Bonferroni 1.0) vs the
spec's 54.03%. No bucket is significant after correction (best: `:55` at 52.95%, p_Bonf 0.87).
Overall Up rate 50.45%. Minute-of-hour is noise, in both windows, exactly as the spec warned.

## Result 3 — Passive maker fills are toxic: −8.8pts, quantified.

Hypothetical maker joining the best UP bid at T-90s (canceling at T-45s, our engine's defaults),
14,226 markets:

- Level touched: 94.2% of markets; traded strictly through: 76.5%.
- Up wins 50.4% unconditionally — but **only 41.6% conditional on your level trading through**
  (48.1% conditional on touch).

A passive fill costs ~9 points of win probability. This is the adverse-selection mechanism every
live post-mortem in the [Reddit dossier](reddit-5min-bot-ecosystem.md) reported, now measured
directly. Naive passive making in these books is strongly −EV; our conservative paper fill model is
validated in direction and, if anything, still too generous (it fills without repricing the outcome).

## Result 4 — The structural complement arb does not exist.

Buy-both-sides below $1 appears in **0.00056%** of 4.27M ticks (≈24 seconds total, gross; net of
taker fees even fewer). Mean buy-both cost 1.0118 — the complement gap is a ~1.2¢ toll you pay, not
income. Sell-both above $1: similarly nil. "Trade both sides" can only mean passive quoting — which
inherits Result 3's toxicity.

## Result 5 — The one real phenomenon: late-window favorite drift (and why it's probably not yours to take)

Favorites' realized win frequency exceeds their displayed mid, and the gap **grows monotonically
into expiry** — the signature of stale quotes, not static mispricing:

| Horizon | Favorite bias (freq − mid), fav_mid ∈ [0.70, 0.90) |
|---|---|
| T-120s | +2.96pts |
| T-90s | +3.25pts |
| T-60s | +3.95pts |
| T-30s | +5.26pts |
| T-10s | **+7.54pts** |

Ask-adjusted (buy at displayed ask, pay today's 7% taker fee), at T-30s, Wilson lower bound vs
break-even: [0.70,0.80) **+1.99pts**, [0.80,0.85) +0.63, [0.85,0.90) +1.09, [0.90,0.94) **−0.26**,
[0.94,0.98) +0.16. Day-stable: positive on 44/55 days, mean +3.31pts (σ 4.91), first-half +3.67 vs
second-half +2.96.

**Why this is (almost certainly) the HFT latency pool, not retail edge:**

1. **The growth-into-expiry shape** says displayed prices lag true probability precisely when
   convergence accelerates. Whoever lifts the stale ask first captures the gap — and openmarket
   measured that race at **16ms median**. A home connection sees 1Hz snapshots of a pool that
   empties in milliseconds.
2. **Displayed size is tiny:** median ask at the touch in the [0.85,0.94) bucket is ~99 shares
   (~$90; p25 ~$31). The measurable edge exists on double-digit dollars per market.
3. **Label noise eats the extreme buckets:** outcomes in this corpus are inferred from the final
   book tick; 0.87% of ≥0.90 favorites show a final-tick book flip, and post-final-tick reversals
   are invisible entirely. In the ≥0.90 buckets the measured ask-edge (±0.3pts) is inside that
   noise. The [0.70,0.80) +2pt edge is larger than plausible label noise — that bucket is the only
   genuinely open question.
4. **Fee-regime caveat:** this window may predate crypto fees (fee introduction was cited as a
   decay driver by live traders in the dossier). Prices from a fee-free equilibrium tested against
   today's 7% fee overstate today's opportunity.
5. Results 3 and 5 are the same coin: the maker loses 8.8pts to whoever takes the stale quote; the
   taker table shows what the winner of the race collects.

## What changes in our system

- **Nothing is armed.** No model beat the market; no artifact ships. The refusal-to-trade posture is
  now backed by 12,655 out-of-sample decisions of our own, plus openmarket's 727M-row replication.
- **The `late_snipe_composite_v1` preset now has a precise research target:** the open question is
  whether the [0.70,0.80) T-30s ask-edge (+2pts lower bound, pre-latency, pre-size-reality) survives
  *live paper execution with oracle-true labels*. Our engine is the right instrument: it records
  exact Chainlink resolutions (no label noise) and simulates fills adversarially. Run it in paper
  mode; the spec's 300-fill / positive-lower-bound gauntlet decides. Expectation, given Results 3
  and 5: it dies on fill reality. Let the data say so.
- **The collector's value compounds:** every open question above (label-true late calibration,
  fee-regime-current pricing, tie-rule premium) needs post-fee, oracle-labeled data — which only our
  own recorder is producing now.

*Caveats: 1Hz snapshots cannot see intra-second book states or trades; fills are proxied by touch/
trade-through; outcome labels are book-inferred (documented by the dataset author); this corpus is a
single 8-week regime and predates the current fee schedule.*
