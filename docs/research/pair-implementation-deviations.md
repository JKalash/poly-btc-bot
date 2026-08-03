# Pair-execution implementation deviations ledger

Running record of every deliberate deviation from
`docs/research/mrfadiai-polymarket-bot-borrow-implementation-spec.md`, per §25.1 rule 10.
Each entry states the spec requirement, the deviation, the reason, and the re-verification plan
(if any). Append-only; maintained by the implementation coordinator from agent reports.

| # | Spec ref | Requirement | Deviation | Reason | Re-verification |
| --- | --- | --- | --- | --- | --- |
| D-001 | §18, §25.1 | Postgres-mode migration verification via dockerized Postgres (`infra/docker-compose.yml`) | Verified against a locally-started PostgreSQL 16.13 instance (`initdb`/`pg_ctl` under the `postgres` OS user, port 55432) — Docker daemon unavailable in the implementation sandbox | Environment limitation; coverage equivalent (real node-postgres driver against a real Postgres 16 server) | None needed; optionally re-run via docker-compose on a Docker-capable host |
| D-002 | §26 BPAIR-020 | Pair schema migration expected as `0005_*` | Pair migration is `0006_*` — `main` gained `0005_bitter_agent_brand.sql` (`positions.fees6`) before implementation started | Upstream repo moved between spec authoring and implementation | None — numbering only |
