import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDb, type DbHandle } from "@b5p/db";
import {
  MarketExposureGuardStore,
  MarketExposureGuardValidationError,
  type ReleaseMarketExposureGuardInput,
} from "../src/market-exposure-guard-store";

const now = 1_800_000_000_000;
let handle: DbHandle;
let store: MarketExposureGuardStore;

beforeEach(async () => {
  handle = await makeDb({ pgliteDir: "memory://" });
  await handle.migrate();
  store = new MarketExposureGuardStore(handle);
});

afterEach(async () => { await handle.close(); });

describe("market exposure guard acquisition", () => {
  it("treats exact same-owner replay idempotently and rejects a different active owner", async () => {
    const acquired = await store.acquire({
      marketId: "market",
      ownerKind: "PAIR_GROUP",
      ownerId: "pair-1",
      ownerState: "SCHEDULED",
      acquiredAtMs: now,
    });
    expect(acquired).toMatchObject({ kind: "ACQUIRED", guard: { stateVersion: 0, releasedAtMs: null } });
    expect(await store.acquire({
      marketId: "market",
      ownerKind: "PAIR_GROUP",
      ownerId: "pair-1",
      ownerState: "SCHEDULED",
      acquiredAtMs: now + 1,
    })).toMatchObject({ kind: "IDEMPOTENT", guard: { ownerId: "pair-1", stateVersion: 0 } });
    expect(await store.acquire({
      marketId: "market",
      ownerKind: "DIRECTIONAL_ORDER",
      ownerId: "order-1",
      ownerState: "PLANNED",
      acquiredAtMs: now + 1,
    })).toMatchObject({ kind: "CONFLICT", code: "MARKET_ACTIVE", guard: { ownerKind: "PAIR_GROUP", ownerId: "pair-1" } });
  });

  it("prevents one active owner identity from claiming two markets", async () => {
    await store.acquire({ marketId: "market-a", ownerKind: "PAIR_GROUP", ownerId: "pair-1", ownerState: "SCHEDULED", acquiredAtMs: now });
    expect(await store.acquire({
      marketId: "market-b",
      ownerKind: "PAIR_GROUP",
      ownerId: "pair-1",
      ownerState: "SCHEDULED",
      acquiredAtMs: now,
    })).toMatchObject({ kind: "CONFLICT", code: "OWNER_ACTIVE_ELSEWHERE", guard: { marketId: "market-a" } });
  });

  it("allows exactly one winner in a concurrent pair-versus-directional race", async () => {
    const [pair, directional] = await Promise.all([
      store.acquire({ marketId: "race-market", ownerKind: "PAIR_GROUP", ownerId: "pair-race", ownerState: "SCHEDULED", acquiredAtMs: now }),
      store.acquire({ marketId: "race-market", ownerKind: "DIRECTIONAL_ORDER", ownerId: "order-race", ownerState: "PLANNED", acquiredAtMs: now }),
    ]);
    expect([pair.kind, directional.kind].filter((kind) => kind === "ACQUIRED")).toHaveLength(1);
    expect([pair.kind, directional.kind].filter((kind) => kind === "CONFLICT")).toHaveLength(1);
    const row = await store.get("race-market");
    expect(row?.releasedAtMs).toBeNull();
    expect(["pair-race", "order-race"]).toContain(row?.ownerId);
  });
});

describe("market exposure guard compare-and-swap lifecycle", () => {
  it("atomically hands a directional order guard to its resulting position", async () => {
    await store.acquire({ marketId: "market", ownerKind: "DIRECTIONAL_ORDER", ownerId: "order-1", ownerState: "RESTING", acquiredAtMs: now });
    const transition = {
      marketId: "market",
      expectedStateVersion: 0,
      ownerKind: "DIRECTIONAL_ORDER" as const,
      ownerId: "order-1",
      nextOwnerKind: "DIRECTIONAL_POSITION" as const,
      nextOwnerId: "position-1",
      nextOwnerState: "OPEN",
      updatedAtMs: now + 100,
    };
    expect(await store.update(transition)).toMatchObject({
      kind: "UPDATED",
      guard: { ownerKind: "DIRECTIONAL_POSITION", ownerId: "position-1", ownerState: "OPEN", stateVersion: 1 },
    });
    expect(await store.update(transition)).toMatchObject({ kind: "IDEMPOTENT", guard: { stateVersion: 1 } });
    expect(await store.update({
      ...transition,
      ownerId: "different-order",
      expectedStateVersion: 1,
      nextOwnerId: "position-2",
      updatedAtMs: now + 200,
    })).toMatchObject({ kind: "CONFLICT", code: "OWNER_MISMATCH" });
  });

  it("fails closed on a stale version and preserves the committed state", async () => {
    await store.acquire({ marketId: "market", ownerKind: "PAIR_GROUP", ownerId: "pair-1", ownerState: "SCHEDULED", acquiredAtMs: now });
    expect((await store.update({
      marketId: "market",
      expectedStateVersion: 0,
      ownerKind: "PAIR_GROUP",
      ownerId: "pair-1",
      nextOwnerKind: "PAIR_GROUP",
      nextOwnerId: "pair-1",
      nextOwnerState: "SUBMITTING",
      updatedAtMs: now + 100,
    })).kind).toBe("UPDATED");
    expect(await store.update({
      marketId: "market",
      expectedStateVersion: 0,
      ownerKind: "PAIR_GROUP",
      ownerId: "pair-1",
      nextOwnerKind: "PAIR_GROUP",
      nextOwnerId: "pair-1",
      nextOwnerState: "PAIRED",
      updatedAtMs: now + 200,
    })).toMatchObject({ kind: "CONFLICT", code: "STALE_VERSION", guard: { ownerState: "SUBMITTING", stateVersion: 1 } });
  });

  it("releases only an exact owner at an owner-specific terminal state and replays idempotently", async () => {
    await store.acquire({ marketId: "market", ownerKind: "PAIR_GROUP", ownerId: "pair-1", ownerState: "RECONCILING", acquiredAtMs: now });
    expect(await store.release({
      marketId: "market",
      ownerKind: "DIRECTIONAL_ORDER",
      ownerId: "order-1",
      terminalState: "CANCELED",
      expectedStateVersion: 0,
      releasedAtMs: now + 50,
    })).toMatchObject({ kind: "CONFLICT", code: "OWNER_MISMATCH", guard: { ownerId: "pair-1", releasedAtMs: null } });
    const release = {
      marketId: "market",
      ownerKind: "PAIR_GROUP" as const,
      ownerId: "pair-1",
      terminalState: "RECONCILED_SETTLED" as const,
      expectedStateVersion: 0,
      releasedAtMs: now + 100,
    };
    expect(await store.release(release)).toMatchObject({
      kind: "RELEASED",
      guard: { ownerState: "RECONCILED_SETTLED", stateVersion: 1, releasedAtMs: now + 100 },
    });
    expect(await store.release(release)).toMatchObject({ kind: "IDEMPOTENT", guard: { stateVersion: 1 } });
    expect(await store.acquire({
      marketId: "market",
      ownerKind: "DIRECTIONAL_ORDER",
      ownerId: "order-2",
      ownerState: "PLANNED",
      acquiredAtMs: now + 200,
    })).toMatchObject({ kind: "ACQUIRED", guard: { ownerId: "order-2", stateVersion: 2, releasedAtMs: null } });
  });

  it("rejects nonterminal releases at runtime even when an untyped caller bypasses TypeScript", async () => {
    await store.acquire({ marketId: "market", ownerKind: "PAIR_GROUP", ownerId: "pair-1", ownerState: "PAIRED", acquiredAtMs: now });
    const invalid = {
      marketId: "market",
      ownerKind: "PAIR_GROUP",
      ownerId: "pair-1",
      terminalState: "PAIRED",
      expectedStateVersion: 0,
      releasedAtMs: now + 100,
    } as unknown as ReleaseMarketExposureGuardInput;
    await expect(store.release(invalid)).rejects.toBeInstanceOf(MarketExposureGuardValidationError);
    expect(await store.get("market")).toMatchObject({ ownerState: "PAIRED", releasedAtMs: null, stateVersion: 0 });
  });

  it("rolls guard acquisition back with the owning transaction", async () => {
    await expect(store.transaction(async (transactionalGuard) => {
      await transactionalGuard.acquire({
        marketId: "market",
        ownerKind: "PAIR_GROUP",
        ownerId: "pair-1",
        ownerState: "SCHEDULED",
        acquiredAtMs: now,
      });
      throw new Error("owning group insert failed");
    })).rejects.toThrow("owning group insert failed");
    expect(await store.get("market")).toBeNull();
  });
});
