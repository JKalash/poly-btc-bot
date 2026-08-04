import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDb, schema, type DbHandle } from "@b5p/db";
import type { PairReconciliationPort } from "@b5p/pair-execution";
import {
  PAIR_LIFECYCLE_ATOMICITY_BLOCKERS,
  PairLifecycleAtomicityUnavailableError,
  createAtomicityBlockedPairExecutionDependencies,
} from "../src/pair-lifecycle-adapter";
import { PairStore } from "../src/pair-store";

let db: DbHandle;

beforeEach(async () => {
  db = await makeDb({ pgliteDir: "memory://" });
  await db.migrate();
});

afterEach(async () => db.close());

const reconciliation: PairReconciliationPort = {
  reconcile: async () => ({
    inspectedGroupCount: 0,
    healthyGroupCount: 0,
    repairedGroupCount: 0,
    pendingGroupCount: 0,
    manualReviewGroupCount: 0,
  }),
};

function dependencies() {
  const groups = new PairStore(db);
  return createAtomicityBlockedPairExecutionDependencies({ db, groups, reconciliation });
}

describe("production pair lifecycle atomicity boundary", () => {
  it("exposes the exact enabling refactor instead of advertising fake transactionality", () => {
    expect(PAIR_LIFECYCLE_ATOMICITY_BLOCKERS).toHaveLength(4);
    expect(PAIR_LIFECYCLE_ATOMICITY_BLOCKERS.join(" ")).toContain("shared Db executor");
    expect(PAIR_LIFECYCLE_ATOMICITY_BLOCKERS.join(" ")).toContain("ledger journals");
  });

  it("uses real empty-store reads and reconciliation without inventing lifecycle facts", async () => {
    const deps = dependencies();
    await expect(deps.store.listDueWork(1_800_000_000_000)).resolves.toEqual([]);
    await expect(deps.store.listActiveGroups()).resolves.toEqual([]);
    await expect(deps.store.getGroup("missing" as never)).resolves.toBeNull();
    await expect(deps.effects.ingestAvailableEvidence(1_800_000_000_000)).resolves.toBe(0);
    await expect(deps.reconciliation.reconcile(1_800_000_000_000)).resolves.toMatchObject({ inspectedGroupCount: 0 });
  });

  it("fails before any schedule mutation when an atomic group+reservation commit is requested", async () => {
    const deps = dependencies();
    await expect(deps.store.commitSchedule({} as never)).rejects.toBeInstanceOf(PairLifecycleAtomicityUnavailableError);
    expect(await db.db.select().from(schema.pairOrderGroups)).toEqual([]);
    expect(await db.db.select().from(schema.pairGroupEvents)).toEqual([]);
    expect(await db.db.select().from(schema.pairLedgerEntries)).toEqual([]);
    expect(await db.db.select().from(schema.pairEffectOutbox)).toEqual([]);
  });

  it("halts an empty store without effects but refuses to partially halt a non-empty target set", async () => {
    const deps = dependencies();
    await expect(deps.store.commitHalt({ nowMs: 1, correlationId: "halt", reason: "stop" })).resolves.toEqual({
      haltedGroupCount: 0,
      alreadyHaltedGroupCount: 0,
      effects: [],
    });
    await expect(deps.store.commitHalt({
      nowMs: 1,
      correlationId: "halt-one",
      reason: "stop",
      groupIds: ["group" as never],
    })).rejects.toBeInstanceOf(PairLifecycleAtomicityUnavailableError);
  });
});
