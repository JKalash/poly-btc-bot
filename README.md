# BTC Five-Minute Polymarket Command Center

A locally runnable system for **observing, researching, paper-trading and backtesting** Polymarket's
BTC Up-or-Down five-minute markets. **A real-money live path exists in this release** — it boots
disarmed and stays inert unless a hot-wallet key is configured, `LIVE_TRADING_ENABLED` is set, and
an operator arms it with a typed acknowledgement for a bounded TTL (`docs/live-trading.md`). Treat
wallet/key hygiene and the arming controls as live-fire safety equipment, not dead code. The
system's primary job is to **refuse trades lacking auditable edge**, expose the exact risk of
approved trades, and make it impossible to confuse a lucky win with a good decision.

> A winning trade can still be a terrible decision. Open the **Tutorial** page after first run.

## Quick start (zero-install dev mode — no Docker required)

```bash
pnpm install          # or: pnpm bootstrap (install + migrate + seed)
pnpm db:migrate       # applies migrations to embedded PGlite under ./data/pglite
pnpm db:seed          # seeds the Timing Lab tables + the 95-cent tutorial case
pnpm dev              # starts API (engine embedded) + web dashboard
```

Open **http://localhost:3000** and sign in with the dev credentials `operator` / `operator`
(change them: `pnpm --filter @b5p/api hash-password -- <password>` → `OPERATOR_PASSWORD_HASH` in `.env`).

The engine immediately connects to live public Polymarket feeds (Gamma discovery, CLOB order-book
WebSocket, Chainlink + Binance RTDS) and starts evaluating paper decisions in the default
`paper_exploration` profile. **It will mostly refuse to trade** — that is correct behavior: no
model in this build is calibrated, so the conservative-edge gate rarely clears. Warm-up alone
takes 2 minutes of Chainlink history.

### Canonical mode (Postgres + Redis, separate processes)

```bash
pnpm infra:up                       # docker compose: postgres:16, redis:7
cp .env.example .env                # set DATABASE_URL + REDIS_URL (see file)
pnpm db:migrate && pnpm db:seed
pnpm dev                            # now runs api + engine + web as separate processes
```

## Commands

| Command | What |
|---|---|
| `pnpm dev` | full stack (embedded or split depending on `DATABASE_URL`) |
| `pnpm test` | unit + integration tests across every package |
| `pnpm test:e2e` | Playwright smoke test (needs `npx playwright install chromium` + running stack) |
| `pnpm build` | typecheck everything + production Next.js build |
| `pnpm typecheck` / `pnpm lint` | strict TS across the monorepo |
| `pnpm db:migrate` / `pnpm db:seed` | schema + seeded research/tutorial data |
| `pnpm research:backfill -- hours=24` | ingest resolved markets from Gamma + recompute Timing Lab |
| `pnpm infra:up` / `pnpm infra:down` | Postgres + Redis via Docker |

## What's inside

```
apps/engine      market discovery, feeds, features, gates, risk, paper executor, resolution, halts
apps/api         Fastify: auth (scrypt+CSRF), REST, WebSocket relay, kill switch
apps/web         Next.js dark ops console: cockpit, decision inspector, Timing Lab, risk center…
apps/research    Gamma slug-enumeration backfill, timing statistics, seeds
packages/domain  exact fixed-point money math, fees/EV/Kelly, state machines, statistics
packages/risk    pure risk engine: every rejection rule, profiles, absolute 10% cap
packages/strategy features, order books, probability models, gist composite indicators, presets
packages/polymarket Gamma/CLOB-WS/RTDS/Binance adapters (payloads verified live 2026-07-31)
packages/config  zod schema, validation, versioned config with diffs
packages/db      drizzle schema + migrations; Postgres or embedded PGlite
```

The repository also contains an isolated UP+DOWN paired-opportunity observer and counterfactual
paper research stack. It captures complete public-book envelopes, quotes both legs with exact
fixed-point arithmetic, records residual and reconciliation evidence, supports deterministic
replay, and exposes read-only `/api/pairs/*` and `/pairs` views. Pair live execution does not
exist, and production pair paper scheduling remains fail-closed until every exact-data,
accounting, lifecycle, and startup gate is healthy.

## Non-negotiables (enforced in code, covered by tests)

- Paper mode by default; **live trading disarmed by default** — real orders require a configured
  hot-wallet key, `LIVE_TRADING_ENABLED=true`, and a typed operator acknowledgement with a bounded
  TTL; any halt or kill immediately disarms.
- Absolute per-market risk cap **10%**; no martingale, no averaging down, no all-in preset, no auto re-arm.
- Decimal/fixed-point arithmetic for all money (`bigint` micro-units); floats only for display/statistics.
- Every order decision persisted as an immutable snapshot **before** any order exists.
- Pair research is structurally no-live: no key/signing dependency and no API or dashboard mutation.
- Post-only maker orders that would cross are rejected safely, never converted to takers.
- Stale Chainlink/book data, unknown price-to-beat, unknown fee schedule, clock drift → fail closed.
- Chainlink is authoritative (rules verified per market); Binance is diagnostic/confirmation only.
- Minute-of-hour patterns are displayed with Wilson intervals + Bonferroni/BH corrections and are
  never standalone signals. The Timing Lab shows: *outcome skew is not trading edge unless price
  fails to reflect it.*

## Live-mode warnings

This release **can trade live once explicitly armed**. Before configuring a wallet or arming, read
`docs/live-trading.md`, `docs/live-trading-checklist.md` and `docs/threat-model.md`. The very-aggressive profile is
genuinely extreme (five full 10% losses ≈ 59% of capital remaining) and requires a typed
acknowledgement. Polymarket enforces [geographic restrictions](https://help.polymarket.com/en/articles/13364163-geographic-restrictions) —
verify your jurisdiction before funding anything.

## Docs

- `docs/architecture.md` — decisions and deviations from the build spec
- `docs/operations.md` — runbooks (start/stop, halts, kill switch, backfill)
- `docs/threat-model.md`
- `docs/live-trading-checklist.md`
- `docs/limitations.md` — explicit list of what is stubbed or partial
- `docs/deploy.md` — VPS/Fly deployment for gap-free 24/7 collection
- `docs/live-trading.md` — how to configure a wallet, arm, and place REAL orders (disarmed by default)
- `docs/research/calibration-study-2026-08.md` — walk-forward study on 14,226 real markets: the
  mid-price beats our model at every horizon; maker fills cost −8.8pts; the late favorite drift is
  real but is the HFT latency pool
- `docs/research/reddit-5min-bot-ecosystem.md` — dossier on the r/algotrading 5-min bot ecosystem:
  three independent builders replicating this repo's null result, plus free order-book datasets
  (~26.8M ticks CC0; 727M rows Apache-2.0) usable for our calibration studies
