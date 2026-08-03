/**
 * `@b5p/pair-execution` — deep package owning paired-order (UP+DOWN
 * complete-set) research behavior: paired-book validation, exact quoting and
 * joint sizing, pair risk, durable group/leg state, paper FOK execution,
 * residual/recovery handling, matched-pair settlement simulation, ledger,
 * reconciliation, and deterministic read views.
 *
 * ## Research-only capability boundary (spec §9.4 — absolute)
 *
 * The complete set of pair run modes this package can ever express is:
 *
 *     export type PairRunMode = "observe" | "paper";
 *
 * The modes `live` and `shadow` are intentionally absent. This package's
 * maximum behavior is prospective paper execution. Adding a real or
 * authenticated mode later must require a source-code change, a separate
 * architecture review, a new adapter, and a new RFC; it must never be
 * achievable by editing environment variables.
 *
 * Hard boundaries enforced by `test/capability-guard.test.ts` (a permanent CI
 * tripwire) and by `apps/engine/test/pair-capability-guard.test.ts`:
 *
 * - dependencies are exactly `@b5p/domain` + `@b5p/strategy`; no venue SDK,
 *   wallet, database, or schema-validation dependency may ever be added;
 * - no import may reach `apps/`, `packages/polymarket`, or the repository's
 *   existing directional live signing/transaction path;
 * - no source file may reference hot-wallet or live-arming environment
 *   variables, or the directional live controller/adapter types;
 * - no on-chain transaction may be built, signed, or broadcast, and no
 *   authenticated CLOB submission may be added (spec §3, rules 1–5).
 *
 * NOTE: the barrel is intentionally minimal for now — exports are appended by
 * contracts work (BPAIR-031). Internal modules (reducer, ledger, transitions,
 * mutation helpers) must never be exported through this barrel (spec §10.1).
 */

/**
 * Compile-time capability declaration. Observation and durable paper
 * execution are the only capabilities this package will ever advertise;
 * consumers must treat any other requested mode as unsupported.
 */
export const PAIR_EXECUTION_CAPABILITY = {
  modes: ["observe", "paper"],
} as const;
