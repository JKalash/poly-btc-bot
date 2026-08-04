/**
 * Narrow engine-only reconciliation surface. This is deliberately not part of
 * the public barrel: runtime startup may replay persisted events, while normal
 * consumers cannot drive the aggregate reducer directly.
 */
export {
  comparePairReconciliation,
  type ComparePairReconciliationInput,
  type PairAdapterObservation,
  type PairEffectReconciliationRecord,
  type PairFillReconciliationRecord,
  type PairOrderReconciliationRecord,
  type PairReconciliationDiff,
  type PairReconciliationResult,
  type PairStoredProjection,
} from "./reconciliation";
export {
  reducePairGroupOrThrow,
  replayPairGroup,
  type PairReduceResult,
} from "./reducer";
export type { PairGroupEvent, PairEventType } from "./events";
export type { PairGroupAggregate } from "./states";
