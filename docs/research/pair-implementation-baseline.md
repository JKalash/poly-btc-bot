# Pair-execution implementation baseline (BPAIR-001)

Research-only implementation of `docs/research/mrfadiai-polymarket-bot-borrow-implementation-spec.md`.
This document records the state of the repository at the moment implementation began, so every
later change is attributable and the "definition of done" (spec §27) can be audited against a
known-green starting point.

## Baseline commit

- **HEAD**: `2e395b26ddc72ca7631cfa0cd261d4965cb15d63` (merge of PR #82, `main`)
- **Branch**: `claude/pair-execution-swarm-plan-ln3iju` (created from this HEAD)
- **Date captured**: 2026-08-03

Note: the pre-implementation exploration snapshots referenced commit `6234078`. Between that
snapshot and this baseline, `main` gained: GitHub Actions CI (`.github/workflows/ci.yml`:
typecheck/test/build on PRs; `claude.yml` mention-triggered review), a live position ledger for
live fills, calibration-gate wiring, and migration `0005_bitter_agent_brand.sql`
(`positions.fees6` column). Consequences for the plan:

- The pair schema migration is **0006**, not 0005.
- "No CI" is no longer true — PRs run typecheck/full test/build in Actions.
- Line-number references gathered during exploration are approximate; agents re-verify locally.

## Toolchain

- Node v22.22.2, pnpm 9.15.4, Vitest 2.1.8, drizzle-kit (via `pnpm --filter @b5p/db generate`)
- Packages consumed as raw TS source (`main: src/index.ts`); apps run via `tsx`; build ≈ `tsc --noEmit` + Next build.

## Baseline gate results (all green)

Commands run at HEAD `2e395b2` with `DATABASE_URL` **unset** (see environment notes):

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm -r typecheck` | pass (all 11 packages/apps) |
| Tests | `env -u DATABASE_URL pnpm -r test` | pass — 439 passed, 3 skipped, 0 failed |
| Build | `env -u DATABASE_URL pnpm build` | pass (tsc + Next static build) |

Per-package test counts at baseline: config 5, domain 89, experiments 31, evidence 51, risk 91,
strategy 55, polymarket 5, research 28 (+3 skipped), engine 72, api 40.

## Database state at baseline

- `packages/db/src/schema.ts`: 988 lines, 56 `pgTable` definitions.
- Migrations present: `0000` … `0005` in `packages/db/migrations` (journal-managed by drizzle-kit; never hand-edited).
- Two DB modes via `makeDb()` (`packages/db/src/client.ts`): `DATABASE_URL` → node-postgres, else PGlite.

## Execution-environment notes (gate protocol)

1. **`DATABASE_URL` is set in this sandbox's ambient environment** and points at a Postgres that is
   not running (`127.0.0.1:5432/thepinklink`). Because `makeDb()` prefers `DATABASE_URL` over
   PGlite, the test suite fails with `ECONNREFUSED` unless it is unset. **All gates in this
   implementation run as `env -u DATABASE_URL <command>`.** Verified: with it unset the full suite
   is green; with it set, `apps/engine/test/paper-variants.test.ts` (7) and
   `apps/research/test/wallet-research.test.ts` (1) fail on connection.
2. **Docker daemon is unavailable** in this sandbox, so the spec's docker-compose Postgres cannot be
   used for Postgres-mode migration verification. **Postgres 16.13 is installed locally**
   (`/usr/lib/postgresql/16`) and a throwaway instance runs cleanly under the `postgres` OS user
   (`initdb`/`pg_ctl` in `/var/lib/postgresql/b5p-pg`, port 55432, trust auth). Postgres-mode
   migration verification (spec §18, §25.1) runs against that instance instead. Deviation recorded
   in `pair-implementation-deviations.md` (mechanism only — coverage is equivalent: real
   node-postgres driver, real Postgres 16 server).

## Pre-existing adjacent (do-not-merge) subsystems

Recorded so reviewers do not confuse them with the new pair subsystem (spec §6):

- `apps/engine/src/inventory-cycle.ts` + `paired_quote_cycles` / `paired_legs` / `ctf_operations` /
  `hedge_actions` / `inventory_lots` / `inventory_snapshots` tables (migration 0004): the R10
  inventory-research paired-quote simulator. Distinct from the new `pair_*` tables.
- `packages/risk/src/inventory-risk.ts`: single-leg inventory risk. Pair risk stays inside the new
  package per spec §14/§10.4.
- Directional accounting keys positions by `marketId` alone — pair fills must not touch it (spec §6.2).
