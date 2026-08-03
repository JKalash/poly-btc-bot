// @b5p/pair-execution/events — Durable domain event definitions and schema versions.
// Owning spec: docs/research/mrfadiai-polymarket-bot-borrow-implementation-spec.md §10.1 (file responsibilities); implementing task: BPAIR-038 (§26).
// Binding constraints (spec §3, §7.2): exact-bigint economics only (no JS `number` for money/size),
// fail-closed on any missing/stale/inconsistent input, and no path to live execution.
// Placeholder stub from BPAIR-030 — the owning task replaces this file wholesale.

export {};
