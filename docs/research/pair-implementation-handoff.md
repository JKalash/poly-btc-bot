# Pair implementation handoff

## Capability state

- Observer enabled by default: `true`.
- Runtime pair paper scheduling enabled by default: `false`.
- Runtime pair paper scheduling effective state in this handoff: `false` (fail-closed).
- Pair live execution available: `false`; no pair-live type, key, signer, wallet, authenticated order client, or UI control exists.
- Default recovery policy: `NO_AUTO_RECOVERY`.
- Default settlement policy: `HOLD_TO_RESOLUTION`.
- The repository's separately armed directional live path grants no pair authority.

## Source and implementation versions

- Original implementation baseline: `4d955b0` (see `pair-implementation-baseline.md` and deviation D-2).
- Resumed branch base: `b317144`; latest externally created committed checkpoint observed during the run: `066c95c`, plus the final uncommitted lifecycle-adapter worktree.
- Borrowing provenance: `MrFadiAi/Polymarket-bot` revision `82647014e0c355a5684e09666d8a0a522234640d` (MIT), used as engineering input rather than copied execution authority.
- Pair strategy: `complete_set_pair_v0_RESEARCH_ONLY`.
- Pair event/schema version: `1`.
- Replay clock/tie rules: `pair_replay_clock_v1` / `pair_replay_tie_v1`.
- Migration: `0006_furry_nemesis`.

## File manifest

### Added or completed

- Pure pair package: exact codecs/contracts, captures, quotes, sizing/stress/risk, FSM/reducer/invariants, ledger, recovery, settlement, reconciliation, facade, serial dispatch, and capability guards.
- Engine: envelope/capture queue, terms persistence and exact public CLOB terms, observation/episode store and evaluator, isolated account/portfolio, group/outbox/inbox stores, paper pair venue, activation/parallel/recovery/halt/settlement planners, startup reconciliation, observability, subsystem/main composition, and symmetric market-exposure guard.
- API: exact cursor-paginated pair read repository and all twelve authenticated GET-only pair routes.
- Web: `/pairs` overview and `/pairs/groups/:id` causal detail cockpit plus Playwright fixtures.
- Research: secure manifest, virtual clock, causal replay, scenario matrix/runner, episode statistics, report model/artifact writer/CLI, and deterministic validation artifact.
- Documentation: architecture, limitations, threat model, live checklist, operations, implementation status, deviations ledger, and this handoff.

### Explicitly preserved

- Existing directional pricing, paper fill, accounting, FSM, and live-order semantics remain separate from pair economics.
- Directional paper/live creation now participates only in the shared market-ownership invariant; the legacy characterization suites pass.
- No pair code imports or reaches the directional signer/wallet/live adapter.

## Architecture deviations

The append-only deviation ledger is `docs/research/pair-implementation-deviations.md`. It records migration numbering/tooling, local revision drift, internal ledger/planner subpaths, zero-group reconciliation storage, extra settlement-routing events, the deterministic scenario-helper boundary, and stable market-level directional guard ownership. Each entry states its rationale, preserved invariant, and tests.

## Verification commands and exact results

- `pnpm -r test`: 949 tests passed in the first full current-worktree snapshot (76.62 seconds). A final affected-tree rerun follows the lifecycle-adapter audit.
- `pnpm -r typecheck`: 13/13 workspace projects passed (54.55 seconds); affected engine/research/API/web typechecks were rerun after their final edits.
- `pnpm build`: passed (66.65 seconds), including static `/pairs` and dynamic `/pairs/groups/[id]` pages.
- `pnpm --filter @b5p/db test`: migration suite 13/13 passed on PGlite (5.44 seconds), covering fresh `0000` through `0006`, populated `0005` to `0006`, and idempotency.
- `pnpm --filter @b5p/pair-execution test`: 171/171 passed at the pair-package checkpoint.
- `pnpm --filter @b5p/api test`: 66/66 passed; pair route/repository focused coverage is 26/26.
- `pnpm --filter @b5p/research test`: 72/72 passed across 11 files; report-focused coverage is 11/11.
- Pair web Playwright fixtures: overview 4/4 and detail 8/8 passed; production web build passed.
- Directional exposure plus legacy characterization/capability/CAS suites: 49/49 passed.
- Pair capability audit: passes with a non-vacuous engine pair-file scan and negative control.
- `git diff --check` and pair-source TODO/whitespace scans: clean at each completed lane.

PostgreSQL integration was not runnable on this machine: `DATABASE_URL` is unset and Docker is not installed. This is recorded as deviation D-3 and remains a deployment gate; PGlite evidence is not mislabeled as live PostgreSQL evidence.

## Migration evidence

- Empty database: migrations `0000` through `0006` apply successfully.
- Populated upgrade: legacy rows through `0005` survive the additive `0006` upgrade.
- Idempotency/catalog: composite constraints, foreign keys, pair partial uniqueness, exact bigint columns, outbox/inbox, research, account/ledger, and shared market-guard schema assertions pass.
- PostgreSQL: outstanding for the environment reason above. Required command on a PostgreSQL-capable host: `DATABASE_URL=<postgres-url> pnpm --filter @b5p/db migrate`, followed by the DB integration suite.

## Research evidence

- Validation run ID: `synthetic-zero-opportunity-v1`.
- Purpose: generator/reproducibility validation only; it is not empirical trading evidence.
- Markets / UTC days / episodes / activation candidates: `0 / 0 / 0 / 0`.
- Verdict: `REMAIN_OBSERVER_ONLY`.
- JSON: `artifacts/research/pairs/synthetic-zero-opportunity-v1/report.json` — SHA-256 `5c646359a5740996d4b4d795b6feb88376284a8b07b8362ff12634a46b16dbf4`.
- Markdown: `artifacts/research/pairs/synthetic-zero-opportunity-v1/report.md` — SHA-256 `663bf25915dc180a61be9aa7be389809912ae15aee0099b7de15da38ee958c78`.
- Artifact manifest: `artifacts/research/pairs/synthetic-zero-opportunity-v1/artifact-manifest.json` — SHA-256 `eb0341add91f5bbbb49fa6d072b447cd2fb2df46da0e7298831a49d002e2c6f6`.
- Reproduce: `pnpm --filter @b5p/research report:pairs:zero`.
- Rerunning produced byte-identical files and hashes.

No empirical promotion claim is made. A real study still requires at least 300 activation candidates across 30 UTC days, both serial orders, default and 2×p95 latency, stress, residual, reconciliation, clustered-confidence, and human source-evidence review gates.

## Known limitations and gates

- The production facade exists and exposes real durable reads/reconciliation, but runtime paper scheduling remains disabled by `PAIR_LIFECYCLE_ATOMICITY_UNAVAILABLE`. The current store APIs cannot share one transaction across group/event/guard, account reservation/journal, and outbox facts; schedule plans also omit account CAS and complete approved decision/risk facts. Evidence reduction needs one transaction spanning inbox/effect, event/projection, order/fill, lot/ledger, and account projection. Mutation ports throw before writing; no placeholder or no-op success is accepted.
- Public token terms are exact and unauthenticated, but network availability, payload identity, supported fee authority, and freshness continue to fail closed.
- Unknown venue outcomes, residual inventory, and reconciliation mismatches retain cash/inventory ownership and surface manual review; they are never converted into fills or profit.
- The validated report is synthetic and cannot satisfy any empirical promotion gate.
- Live PostgreSQL migration/transaction verification remains outstanding.
- Pair live execution is permanently outside this implementation; enabling it requires a new specification and independent security review.

## Final operating posture

Keep pair observation on, pair paper scheduling off, and pair live unavailable. Use `/pairs` and the generated research reports for evidence review. Do not enable pair paper scheduling until the remaining lifecycle/PostgreSQL gates are closed and a real report satisfies every promotion criterion without weakening sample, confidence, latency, stress, residual, or reconciliation requirements.
