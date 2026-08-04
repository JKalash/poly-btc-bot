# Pair implementation baseline (BPAIR-001)

Recorded at the start of the pair-execution implementation, per spec §26.1 `BPAIR-001` (`docs/research/mrfadiai-polymarket-bot-borrow-implementation-spec.md`).

## Revision

- Branch: `pair-execution`, created 2026-08-03.
- Base commit: `4d955b0` = origin/main `2e395b2` (PR #82) + local commit "research: make tutorial seed idempotent per-row".
- Worktree: clean at branch creation.
- The brief's recorded snapshot (`908a978`) predates 13 upstream commits (batch-B live-path fixes, GitHub Actions CI) and migration `0005_bitter_agent_brand.sql`. See deviations D-1/D-2 in `pair-implementation-deviations.md`.

## Toolchain

- Node `v22.21.1`, pnpm `9.15.4` (workspace globs `apps/*`, `packages/*`).
- TypeScript 5.7.x via shared `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, ESM, no emit); packages consumed as raw TS source; apps run via `tsx`.
- Vitest 2.1.8, default config, tests in `<pkg>/test/*.test.ts`; fast-check 3.23.2 in domain/risk/experiments/engine.
- CI: `.github/workflows/ci.yml` (typecheck, test, build on PRs; Fly deploy on main).

## Database modes

- `makeDb()` in `packages/db/src/client.ts`: `DATABASE_URL` set → node-postgres; unset → PGlite (`PGLITE_DIR` or `<root>/data/pglite`; tests use `memory://`).
- Migrations: drizzle-kit generated (`pnpm --filter @b5p/db generate`), applied by `handle.migrate()`; 6 migrations `0000`–`0005` at baseline. The pair migration will be `0006`.

## Baseline command results (all green)

| Command | Result |
|---|---|
| `pnpm -r typecheck` | exit 0, no errors |
| `pnpm test` | exit 0 — config 5, domain 89, experiments 31, evidence 51, risk 91, strategy 55, polymarket 5, research 31, engine 72, api 40 tests passed (470 total, 36 files) |

No pre-existing failures: any future red is a regression introduced by this work.

## Wiring gaps confirmed at baseline (per spec §6.3)

- `market_trade_ticks`, `constraint_snapshots`, `fee_schedule_snapshots`: declared in schema, zero inserts anywhere in the tree.
- `orderbook_snapshots`: inserted only by the execution-research buffered persister, not by a general capture path.
- CLOB `price_change` envelopes are delivered whole by `ClobMarketWs` but fanned out per level at the engine boundary (`apps/engine/src/main.ts`), so book updates are transiently torn with no version/epoch/integrity tracking in `BookState`.

## Package dependency graph (baseline)

`domain` ← {evidence, experiments, risk, strategy(+experiments), polymarket(+strategy)}; apps: engine ← {config, db, domain, polymarket, risk, strategy}; api ← {config, db, domain, engine, research}; research ← {config, db, domain, evidence, experiments, polymarket}; web standalone (Next 15). `@polymarket/clob-client` + `viem` live only in `packages/polymarket`.
