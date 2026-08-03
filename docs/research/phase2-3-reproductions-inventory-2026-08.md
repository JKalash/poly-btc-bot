# Phases 2+3 — Source reproductions, Evidence Lab, inventory/CTF simulation (2026-08-03)

Implements the remaining two phases of the refinement brief (`2026-07-31-001-initial-refinement.md`).
Phase 1 (execution truth + calibration gate) is documented in
`phase1-execution-calibration-2026-08.md`. Everything below is landed and tested.

## Phase 2 — every source claim encoded, reproduced, or honestly gated

**Fixtures (`packages/evidence/src/fixtures/`).** Every numeric table from the Reddit analysis and
the Archetapp gist is transcribed exactly, labeled `SOURCE_CLAIM_UNVERIFIED`, with brief-line
provenance. The three mandated discrepancy detectors fire with exact arithmetic:
- Favored-side band counts sum **4,442** vs the claimed **4,569** → 127 missing decisions.
- The lag section's visible 74.8 − 75.3 = **−0.5pp** vs its reported −0.4pp.
- The gist "safe" 25%-risk four-loss drawdown: exactly **175/256 = 68.359375% lost** (bigint rationals).
Transcription surfaced a **third** discrepancy the brief did not list: the 0.55–0.60 favored band
prints −2.1pp while its own columns give −2.2pp (`detectBandRowDiffInconsistencies`).

**Reproductions (R1–R8, R11)** — preregistered, manifest-checksummed, deterministic
(content-addressed definition/run ids; identical result checksums across CLI invocations); Python
slices data, TS computes verdicts via `@b5p/experiments`; results persist to the experiment tables
and as labeled evidence rows. Ledger: **24 REPRODUCED_MATCH, 10 REPRODUCED_MISMATCH, 8 DATA_GATED**
across 9 experiments, 326 observations. `pnpm --filter @b5p/research repro`. Highlights:
- **R3**: 14,212 T-270 decisions; 4/6 favored bands below the fee break-even (source said 6/6; the
  two positive bands are annotated as the calibration study's late-drift artifact). The 127-gap is
  **answered**: extreme-price exclusion (ask ≥ 0.95) reproduces the source's 2.78% exclusion rate
  only at ~T-210..T-180 decision times; missing books / ambiguous favorites / side-convention flips
  are ruled out. Maker joins re-measure fill-conditioned adverse selection at −7.5 to −3.8pts.
- **R7**: the gist composite's `score_strength` used as a probability scores Brier **0.185 vs 0.082**
  for the raw book mid on identical rows — "score strength is not probability" is now a measurement.
  Ablation confirms window-delta dominance (hit rate 0.857 → 0.651 when removed).
- **R2/R4**: BTC continuation declines with run length (0.483→0.443), matching the source's ETH
  shape; trend-side bands match 4/4 — but the cheap side is priced, not discounted.
- **R5/R6**: the full entry-time surface T-180→T-5 (fees, fills, break-even, reversal hazard) — its
  21 CI-positive late touch-EV points carry the latency-pool attribution and are marked NOT
  tradable; all 14 exit policies underperform hold-to-resolution.
- **R8**: 2026 reversal rate 55.34% (CI 52.4–58.3) contains the source's 54.6% — but the fade side
  costs 0.538, taker EV −1.1%/trade: the "~4pp edge at 0.50 zero-fee" framing is a
  REPRODUCED_MISMATCH. `extended_move_fade_v1` exists as a code-enforced non-live preset
  (paper/shadow; live structurally rejected in preset, config literal, and validateConfig).
- **R1/R11**: feed-lag INCONCLUSIVE on 3 days of collector data (structural-correction cut just
  missed); the ETH multi-year claims and the commenter's 3% ROI method remain DATA_GATED, each
  naming the exact missing dataset.

**Evidence Lab (`/evidence`)** renders the ledger with mismatches and data-gated claims as
prominent as matches, claimed-vs-reproduced comparisons, sample reconciliation, preregistration
details, and dataset-manifest checksum status. Deployments boot-seed the locally-computed ledger
(`apps/api/seeds/research-seed.json`) since the source datasets never ship.

## Phase 3 — inventory/CTF market-making as a governed simulation

**Domain + DB** (`packages/domain/src/inventory.ts`, migration 0004, 11 tables): the R10
paired-cycle machine (PLANNED→…→RECONCILED + side states, per-leg machine) with pure validators; a
graph-search test proves every path to RECONCILED passes hedge-or-cancel/both-legs (or explicit
FAILED_RECONCILIATION). `isRiskFree(cycle, legs)` is false for every open-leg combination.
Rebate and liquidity-reward accruals are separate ledgers whose `realized: true` is
**unrepresentable** off PAID (discriminated union).

**Simulator (`apps/engine`)** — paper/shadow ONLY; the only live-MM surface is
`DisabledLiveMarketMakingAdapter`, which refuses everything, and the simulator constructor throws
outside paper/shadow. OFF by default (`inventory_research.enabled: false`). Models split/merge/
redeem with gas, latency, and failure probability; post-only two-sided quoting; Poisson fill
hazard; one-leg risk with a 2s unhedged budget; hedge-or-cancel; exact bigint P&L; deterministic
per correlation-id seed. Pre-trade EV accepts only module-branded realized income — unpaid rewards
cannot enter EV at compile time, and forged objects throw.

**Risk (`packages/risk/src/inventory-risk.ts`)** — 12 hard-reject codes (open-leg-never-risk-free,
reward-needed-for-EV, one-leg duration/exposure, pending-CTF value, cancel-uncertainty, inventory
caps, operational-loss stop, source-claim allocation, live-paired refusal). None are cleared by
live arming (set-difference proof extended without touching the Phase-1 assertions); the inventory
context provably cannot alter sizing. Config: `inventory_risk` (limits — single source of truth)
and `inventory_research` (simulation knobs); `live_paired_allowed` and `*_in_pretrade_ev` are zod
literals.

**Inventory Lab (`/inventory`)** — cycle funnel, open-leg risk panel ("A split position is not
risk-free while a leg is open"), the two accrual ledgers side by side ("Rewards are revenue only
when paid"), CTF operations with UNKNOWN outcomes flagged, believed/exchange/on-chain
reconciliation, feed-basis/boundary panel. **R12** wallet-research pipeline separates naive flow
accounting from trading P&L vs paid incentives on committed fixtures.

## Verification

Full repo green after integrating the parallel bug-discovery PRs (#72/#73): typecheck, lint, and
the test suites across all packages; migrations 0002–0004 idempotent on PGlite; deployment
boot-seeds calibration + research provenance and was verified in-VM (guards 401, labs render,
live disarmed). The paper late-snipe experiment continues untouched.
