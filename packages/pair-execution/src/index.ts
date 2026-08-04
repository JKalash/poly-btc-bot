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
 * The barrel exposes contracts and pure construction/economics helpers only.
 * Internal reducers, ledger mutation, transitions, and adapter helpers must
 * never be exported through it (spec §10.1).
 */

/**
 * Compile-time capability declaration. Observation and durable paper
 * execution are the only capabilities this package will ever advertise;
 * consumers must treat any other requested mode as unsupported.
 */
export const PAIR_EXECUTION_CAPABILITY = {
  modes: ["observe", "paper"],
} as const;

export * from "./contracts";
export { createPairExecution, PairExecutionConfigurationError } from "./create-pair-execution";
export * from "./serialization";
export * from "./hashes";
export * from "./ids";
export * from "./capture";

// Pure, unauthenticated economics surface. Stateful reducers, ledger mutation,
// and adapter internals must never be exported from this package barrel.
export {
  composePairQuote,
  finalizePairQuote,
  quoteDirectBuy,
  quoteDirectSell,
  type ComposePairQuoteInput,
  type ComposePairQuoteResult,
  type FinalizePairQuoteInput,
  type DirectBuyQuoteRequest,
  type DirectLegQuote,
  type DirectSellQuoteRequest,
  type PairLevelFill,
  type QuoteBookReference,
  type QuoteFeeSnapshot,
  type QuoteOk,
  type QuoteOrderSide,
  type QuoteReject,
  type QuoteRejectReason,
  type QuoteResult,
  type QuoteTimeInForce,
  type PairQuoteLegInput,
} from "./quote";

export {
  PAIR_SIZE_OBJECTIVE_VERSION,
  buildCandidateFrontier,
  lotBoundedQuantity,
  pairSizeObjectiveV1,
  selectBestPairCandidate,
  type CandidateFrontierInput,
  type CandidateFrontierResult,
  type PairSizeCandidate,
} from "./sizing";

export {
  quoteDepthStress,
  quoteDepthStressGrid,
  quoteTickStress,
  type PairStressLegInput,
  type PairStressQuoteInput,
} from "./stress";

export {
  aggregatePairRisk,
  evaluatePairRisk,
  type AggregatePairRiskState,
  type AggregatePairRiskStateInput,
  type EvaluatePairRiskInput,
} from "./risk";

export {
  calculateRecoveryAlternatives,
  selectRecoveryAction,
  type RecoveryAlternative,
  type RecoveryAlternativeKind,
  type RecoveryAlternativesInput,
  type RecoveryBookInput,
  type RecoverySelection,
  type RecoverySelectionInput,
} from "./recovery";
