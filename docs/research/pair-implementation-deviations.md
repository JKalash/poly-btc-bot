# Pair implementation deviations ledger

Per spec §25.1 rule 10 (`docs/research/mrfadiai-polymarket-bot-borrow-implementation-spec.md`): every material deviation from the brief is recorded here with rationale, the invariant preserved, and the tests that cover it. Single writer: the implementation coordinator. Append-only.

| # | Spec reference | Deviation | Rationale | Invariant preserved | Tests |
|---|---|---|---|---|---|
| D-1 | §10.6, BPAIR-020 | Pair migration is `0006_*`, not the next-after-`0004` the brief's snapshot implied; upstream `0005_bitter_agent_brand.sql` (adds `positions.fees6`) landed before this work began. | Repository advanced past the brief's audited revision. | One forward migration for the pair schema; no history rewrite. | Migration tests (BPAIR-020). |
| D-2 | §6.5 | Local baseline is `4d955b0` (origin/main `2e395b2` + tutorial-seed fix), not `908a978` recorded in the brief. Batch-B live-path fixes (real live position ledger, content-seeded `idempotencyKey`, provenance/health fixes) and GitHub Actions CI are present. | Repository advanced during brief preparation and again during planning. | All §3 authority rules re-verified against the actual tree; pair isolation tests target the current live-path symbols. | BPAIR-003 guard tests; baseline doc. |
