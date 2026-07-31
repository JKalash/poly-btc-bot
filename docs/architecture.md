# Architecture decision record

## Verified-at-build facts (2026-07-31)

- Gamma event slugs follow `btc-updown-5m-{unix_start_epoch}` (300s-aligned); series id `10684`,
  slug `btc-up-or-down-5m`. Verified live.
- Live fee schedule on an active market: `feeType: crypto_fees_v2`,
  `{ rate: 0.07, takerOnly: true, rebateRate: 0.2 }`; tick size 0.01; min order 5 shares.
- Resolution rule confirmed: **Up if final ≥ start** (a tie resolves Up) on the Chainlink BTC/USD
  Data Stream (`https://data.chain.link/streams/btc-usd`) — spot markets explicitly excluded.
- RTDS WebSocket (`wss://ws-live-data.polymarket.com`): `PING` every 5s; Chainlink updates ~1/s with
  `full_accuracy_value` (1e18-scaled decimal string) plus a history backfill on subscribe.
  Payload shapes captured live and encoded in `packages/polymarket` zod schemas.
- CLOB market WS (`wss://ws-subscriptions-clob.polymarket.com/ws/market`): initial ARRAY of book
  snapshots, `price_change` level updates carrying `best_bid/best_ask`, `PING` every 5s (current
  docs; the spec said 10s).
- **Fee-collection discrepancy**: the spec's formulas assume buy fees are collected in shares;
  current docs state USDC at settlement. Both conventions are implemented exactly
  (`packages/domain/src/fees.ts`); config selects (`paper.fee_collection_convention`, default
  `usdc`). Break-even at 0.95 differs only in the 5th decimal (95.333% vs 95.334%).

## Key decisions

1. **Money is integer micro-units (`bigint`), not a decimal library.** Prices are micro-probability
   (0..1e6), USDC/shares micro-scaled, rates ppm. `mulDiv` with explicit rounding (fees round up,
   payouts round down) makes every calculation exact and auditable; `decimal.js` was unnecessary.
   Floats appear only in statistics/features/display.
2. **Embedded dev mode.** No Docker on the target machine, so the canonical Postgres/Redis path is
   supplemented by PGlite (real Postgres compiled to WASM, in-process) + an in-process event bus,
   with the engine embedded in the API process (`EMBED_ENGINE=1`). PGlite is single-connection,
   which forces the shared-handle design. `DATABASE_URL` switches to the split-process deployment.
3. **Internal packages are consumed as TypeScript source** (tsx at runtime, Next transpilation,
   strict `tsc --noEmit` per package). No per-package build artifacts to drift. Turborepo dropped —
   pnpm workspaces suffice at this scale.
4. **No live signing path.** The spec asks for a live adapter behind a disabled flag; this release
   ships a `DisabledLiveAdapter` that refuses everything and NO wallet/key handling anywhere.
   Rationale: no model in the build is calibrated, therefore live eligibility is unreachable
   anyway, and the safest key management code is code that does not exist. The execution adapter
   interface is the seam where a future signer plugs in, behind the full arming flow.
5. **Conservative paper fills.** Unconditional fill simulation systematically overstates maker P&L
   (fills arrive exactly when flow is toxic). The default queue model joins the back of the
   displayed queue at activation (post-simulated-latency), requires printed trades at-or-through
   the price, and post-only orders that would cross at activation are rejected, never converted.
6. **Models are honest about calibration.** The book baseline is the null model (its probability IS
   the market price — it can never show edge by construction). The distance/vol heuristic (t(3) on
   standardized distance) and the gist composite are labeled UNCALIBRATED, carry wide uncertainty,
   and are paper/shadow-only. `calibrated_logistic` refuses to run until research produces a
   walk-forward artifact. Consequently the engine trades paper rarely and live never — by design.
7. **Price-to-beat is self-captured and cross-checked.** The engine records the last authoritative
   Chainlink tick at each 300s boundary (exact `full_accuracy_value` string). Continuity check:
   window N's final value must equal window N+1's price-to-beat (same stream, same instant);
   divergence beyond 1bp flags the market and blocks entries. Local resolutions are cross-checked
   against official Gamma outcomes; any mismatch **halts the engine**.
8. **Discovery by slug enumeration** rather than list pagination: deterministic, resumable,
   parallelizable, immune to pagination drift. Used both for live discovery (current + next
   windows) and historical backfill.
9. **Gist integration (operator request).** The PolymarketBot gist's 7-indicator composite is a
   first-class strategy preset (`late_snipe_composite_v1`) with the dominant window-delta weight —
   but Chainlink must confirm direction (markets resolve on Chainlink, not Binance), it is
   paper/shadow-only in code, and its probability mapping is explicitly uncalibrated. The gist's
   sizing modes exist as paper-only ruin simulations; its "degen" all-in mode is structurally
   unreachable from any armed path (the spec's absolute 10% cap and no-all-in rules are
   non-negotiable).

## Engine state machines

Market instance: `DISCOVERED → WARMING → OBSERVING → CANDIDATE → RISK_APPROVED → ORDER_PENDING →
RESTING → PARTIAL/FILLED → RESOLVED → RECONCILED`, with `REJECTED/CANCELED/HALTED/STALE` side
paths. Engine: `BOOTING → RECONCILING → (READ_ONLY | PAPER | SHADOW) ⇄ DEGRADED/HALTED`; the
LIVE_* states exist in the FSM but are unreachable in this release. Transition tables live in
`packages/domain/src/state.ts` and are enforced (illegal transitions throw/log).

## Where edge could actually live (and how this build measures it)

The spec's own data shows no minute-of-hour edge after correction, and external research found no
cross-feed edge after costs. The remaining candidates, in order of plausibility:

1. **Fill-conditioned maker outcomes** — adverse selection is the whole game; fill probability and
   win probability are negatively correlated by construction. The build separates
   signal-conditioned from fill-conditioned results end to end.
2. **The fee-wedge dead zone** — at extreme prices the taker break-even exceeds the price
   (95.33 vs 95), so quotes can sit "wrong" by up to the wedge with no arbitrage correcting them.
   Observed extreme prices are therefore biased probability estimates in an unknown direction —
   the calibration-by-price-bucket study is the highest-value research artifact this system can
   produce.
3. **The tie rule** — `≥` resolves Up, so dead-flat windows carry a structural Up premium.
   Chainlink's stream is high-precision (exact ties are rare) but the premium conditional on very
   low realized vol is measurable in the Timing Lab data and is a research question, not an
   assumed edge.
