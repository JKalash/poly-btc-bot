# Operations runbook

## Start / stop

- `pnpm dev` — embedded mode (PGlite, engine inside API) unless `DATABASE_URL` is set.
- Ctrl-C stops everything; the engine cancels nothing on the exchange (there is nothing live) and
  conservatively cancels its own orphaned paper orders on the next start ("restart reconciliation").
- Logs are JSON lines on stdout/stderr; `LOG_LEVEL=debug` for verbosity.

## The engine halted — what now?

1. Read the reason in the header badge and Audit & Health page (`halt` events are `critical`).
2. Typical causes: Chainlink/CLOB staleness, database write failure, **resolution mismatch**
   (local Chainlink-derived outcome ≠ official Gamma outcome — investigate before anything else;
   this means the authoritative-data replica cannot be trusted).
3. Fix the cause, then press **“Manual review done — re-arm engine”** on Audit & Health (or
   `POST /api/resume`). There is deliberately no auto re-arm.

## Pair observer and counterfactual account

- Open `/pairs` for the read-only pair research cockpit. Every pair page is labeled
  `RESEARCH / COUNTERFACTUAL PAPER ONLY`; there is no pair execution control.
- `PAIR_TERMS_STALE` means exact per-token fee or constraint evidence is unavailable/stale.
  Observation capture continues where safe, but scheduling stays disabled. Do not substitute
  displayed floating-point Gamma values.
- `PAIR_SUBSYSTEM_UNWIRED` means audited lifecycle/effect ports are incomplete. This is the safe
  production default during the observer study.
- `PAIR_RECONCILIATION_MISMATCH`, unknown outcomes, residual inventory, or manual-review counts
  require evidence review. Never edit group state, fills, P&L, or ledger rows through the database.
- Replay/report runs operate in an isolated research account/namespace and must preserve their
  dataset manifest, hashes, code revision, scenario hash, and reproduction command.

## Emergency stop

- Button on every page (header) or `Ctrl+Shift+K`. Requires confirmation.
- Disables new orders, attempts cancellation of resting paper orders, writes audit + kill-switch
  rows. Filled positions are listed for manual review — never auto-exited.

## Timing Lab refresh / backfill

- Dashboard: Timing Lab → "Refresh from Gamma" (choose hours; ~12 requests/min against Gamma).
- CLI for larger windows: `pnpm research:backfill -- hours=168` (7 days ≈ 2000 requests; be polite).
- Statistics recompute over 7/14/30d windows automatically after backfill.

## Credentials

- Password: `pnpm --filter @b5p/api hash-password -- 'new-password'` → put output in
  `OPERATOR_PASSWORD_HASH` in `.env`, restart. Normal sessions are memory-only and die with the API;
  remembered 30-day sessions survive restarts only when `SESSION_SECRET` is stable.
- "Forget credentials": remove the two variables from `.env`; nothing else stores them.

## Database

- Embedded data lives in `./data/pglite` (gitignored). Delete the directory for a factory reset,
  then `pnpm db:migrate && pnpm db:seed`.
- Postgres mode: standard `pg_dump`; no plaintext secrets are ever written to the database.
- Retention defaults (spec): raw ticks 90d, book snapshots 30d, aggregates/decisions/audit forever.
  Compaction jobs are not yet implemented — see `docs/limitations.md`.
