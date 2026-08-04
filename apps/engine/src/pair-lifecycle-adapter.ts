import { schema, type DbHandle } from "@b5p/db";
import {
  type PairCommittedEffect,
  type PairDueWork,
  type PairExecutionDependencies,
  type PairGroupId,
  type PairGroupView,
  type HaltPairsCommand,
  type PairReconciliationPort,
} from "@b5p/pair-execution";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ACTIVE_PAIR_GROUP_STATES, type PairOrderGroupRow, type PairStore } from "./pair-store";

export const PAIR_LIFECYCLE_ATOMICITY_BLOCKERS = Object.freeze([
  "PairStore.createGroup and PairStore.appendEvent open private transactions and accept no shared Db executor",
  "PairAccountStore.appendReservation and PairAccountStore.appendMutation open private transactions and accept no shared Db executor",
  "PairSchedulePlan omits pair-account state/event CAS versions and the complete approved decision/risk facts",
  "PairStore.ingestEvidence cannot atomically append group events, order/fill facts, inventory lots, ledger journals, and account projection changes",
] as const);

export class PairLifecycleAtomicityUnavailableError extends Error {
  readonly code = "PAIR_LIFECYCLE_ATOMICITY_UNAVAILABLE" as const;
  readonly blockers = PAIR_LIFECYCLE_ATOMICITY_BLOCKERS;

  constructor(operation: string) {
    super(`${operation} is disabled: the current store contracts cannot commit all required pair lifecycle facts in one database transaction`);
    this.name = "PairLifecycleAtomicityUnavailableError";
  }
}

function groupView(row: PairOrderGroupRow): PairGroupView {
  return Object.freeze({
    groupId: row.id as PairGroupId,
    marketId: row.marketId,
    state: row.state,
    halted: row.haltedAtMs !== null,
    activateAtMs: row.activateAtMs,
    nextActionAtMs: row.nextActionAtMs,
    reservedCash6: row.reservedCash6,
    upHeldShares6: row.upHeldShares6,
    downHeldShares6: row.downHeldShares6,
    reconciliationStatus: row.reconciliationStatus as PairGroupView["reconciliationStatus"],
    stateVersion: row.stateVersion,
  });
}

function dueKind(state: string): PairDueWork["kind"] {
  if (state === "SCHEDULED" || state === "ACTIVATING" || state === "ACTIVATION_REJECTED") return "ACTIVATION";
  if (state === "RESIDUAL" || state === "RECOVERY_PENDING" || state === "RECOVERING") return "RECOVERY";
  if (state === "PAIRED" || state === "AWAITING_SETTLEMENT" || state === "MERGE_PENDING") return "SETTLEMENT";
  return "TIMEOUT";
}

/**
 * Maximal production composition supported by the current store contracts.
 * Reads and reconciliation are real. Every economic mutation that needs a
 * cross-store transaction fails before its first write; returning a pretend
 * success here would make paper scheduling unsafe.
 */
export function createAtomicityBlockedPairExecutionDependencies(input: {
  readonly db: DbHandle;
  readonly groups: PairStore;
  readonly reconciliation: PairReconciliationPort;
}): PairExecutionDependencies {
  const blocked = (operation: string): never => { throw new PairLifecycleAtomicityUnavailableError(operation); };
  return Object.freeze({
    economics: Object.freeze({
      evaluate: async () => blocked("facade economics/observation translation"),
    }),
    observations: Object.freeze({
      record: async () => blocked("facade observation recording"),
    }),
    account: Object.freeze({
      approveSchedule: async () => blocked("pair account schedule approval"),
    }),
    activation: Object.freeze({
      prepareSchedule: async () => blocked("pair schedule preparation"),
      prepareDueWork: async () => blocked("pair due-work planning"),
    }),
    store: Object.freeze({
      commitSchedule: async () => blocked("atomic group/reservation schedule commit"),
      async listDueWork(nowMs: number): Promise<readonly PairDueWork[]> {
        const rows = await input.groups.findDueGroups(nowMs);
        return Object.freeze(rows.map((row) => {
          const kind = dueKind(row.state);
          const dueAtMs = row.nextActionAtMs ?? row.activateAtMs;
          return Object.freeze({
            workId: `${row.id}:${row.stateVersion}:${kind}:${dueAtMs}`,
            groupId: row.id as PairGroupId,
            kind,
            dueAtMs,
            halted: row.haltedAtMs !== null,
            stateVersion: row.stateVersion,
          });
        }));
      },
      commitDuePlan: async () => blocked("atomic causal due-work commit"),
      async commitHalt(command: HaltPairsCommand) {
        const requested = command.groupIds === undefined
          ? await input.db.db.select({ id: schema.pairOrderGroups.id }).from(schema.pairOrderGroups)
            .where(inArray(schema.pairOrderGroups.state, [...ACTIVE_PAIR_GROUP_STATES]))
          : command.groupIds.map((id: PairGroupId) => ({ id }));
        if (requested.length === 0) {
          return { haltedGroupCount: 0, alreadyHaltedGroupCount: 0, effects: Object.freeze([]) };
        }
        return blocked("atomic halt facts and unclaimed-effect cancellation");
      },
      async getGroup(groupId: PairGroupId): Promise<PairGroupView | null> {
        const row = await input.groups.getGroup(groupId);
        return row === null ? null : groupView(row);
      },
      async listActiveGroups(): Promise<readonly PairGroupView[]> {
        const rows = await input.db.db.select().from(schema.pairOrderGroups)
          .where(inArray(schema.pairOrderGroups.state, [...ACTIVE_PAIR_GROUP_STATES]));
        return Object.freeze(rows.map(groupView));
      },
    }),
    effects: Object.freeze({
      async dispatchCommitted(effects: readonly PairCommittedEffect[]): Promise<void> {
        if (effects.length > 0) blocked("dispatch of lifecycle effects without an atomic causal commit adapter");
      },
      async ingestAvailableEvidence(): Promise<number> {
        const pending = await input.db.db.select({ id: schema.pairInboxEvidence.id })
          .from(schema.pairInboxEvidence)
          .where(and(isNull(schema.pairInboxEvidence.processedAtMs), eq(schema.pairInboxEvidence.evidenceKind, "PAPER_PAIR_RESULT")))
          .limit(1);
        if (pending.length > 0) blocked("atomic evidence/group/fill/ledger/lot reduction");
        return 0;
      },
    }),
    reconciliation: input.reconciliation,
  });
}
