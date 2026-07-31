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
  `OPERATOR_PASSWORD_HASH` in `.env`, restart. Sessions are memory-only and die with the API.
- "Forget credentials": remove the two variables from `.env`; nothing else stores them.

## Database

- Embedded data lives in `./data/pglite` (gitignored). Delete the directory for a factory reset,
  then `pnpm db:migrate && pnpm db:seed`.
- Postgres mode: standard `pg_dump`; no plaintext secrets are ever written to the database.
- Retention defaults (spec): raw ticks 90d, book snapshots 30d, aggregates/decisions/audit forever.
  Compaction jobs are not yet implemented — see `docs/limitations.md`.
