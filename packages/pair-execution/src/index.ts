// @b5p/pair-execution — research-only paired-execution (complete-set) subsystem.
// Owning spec: docs/research/mrfadiai-polymarket-bot-borrow-implementation-spec.md §10.1; scaffold task: BPAIR-030 (§26).
//
// Public barrel. Per §10.1 the barrel exports ONLY the facade, immutable public
// commands/results/views, and required port types. It must NEVER re-export
// `reducer`, `ledger`, `transitions`, or any mutation helper.
//
// Capability boundary (spec §3, absolute): this package must never depend on or
// reach @b5p/polymarket, the live adapter/controller, wallets, signing, or any
// on-chain mutation path. Enforced by test/capability-guard.test.ts (BPAIR-003).

export * from "./contracts";
export * from "./create-pair-execution";
export * from "./pair-execution";

// Internal-only modules (no barrel export; see §10.1):
// quote, sizing, stress, risk, capture, reducer, states, transitions, invariants,
// ledger, reconciliation, recovery, settlement, events, ids, hashes, serialization.
