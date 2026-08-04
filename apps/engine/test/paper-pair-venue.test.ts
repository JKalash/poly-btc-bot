import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeDb, schema, type DbHandle } from "@b5p/db";
import { pairCaptureHash, pairCaptureId, type ImmutablePairBookLeg, type PairBookCapture } from "@b5p/pair-execution";
import { canonicalBookHash } from "@b5p/strategy";
import { sql } from "drizzle-orm";
import {
  DbPaperPairOperationStore,
  InMemoryPaperPairOperationStore,
  PaperPairVenue,
  PaperPairVenueIdempotencyCollisionError,
  PaperPairVenueMalformedResultError,
  PaperPairVenueRequestError,
  paperPairBookReference,
  paperPairVenueRequestHash,
  type PaperPairVenueRequest,
  type PaperPairVenueScript,
} from "../src/paper-pair-venue";

const now = 1_800_000_000_000;

function capture(): PairBookCapture {
  const up: ImmutablePairBookLeg = Object.freeze({
    outcome: "UP", tokenId: "up", bookVersion: 11n, connectionEpoch: "epoch", sourceTsMs: now,
    receivedTsMs: now, exchangeHash: null, sourceEventId: "up-event", integrity: "VERIFIED_SNAPSHOT",
    bids: Object.freeze([{ price6: 390_000n, shares6: 1_000_000n }]),
    asks: Object.freeze([{ price6: 400_000n, shares6: 1_000_000n }, { price6: 500_000n, shares6: 2_000_000n }]),
  });
  const down: ImmutablePairBookLeg = Object.freeze({
    outcome: "DOWN", tokenId: "down", bookVersion: 12n, connectionEpoch: "epoch", sourceTsMs: now,
    receivedTsMs: now, exchangeHash: null, sourceEventId: "down-event", integrity: "VERIFIED_SNAPSHOT",
    bids: Object.freeze([{ price6: 580_000n, shares6: 1_000_000n }]),
    asks: Object.freeze([{ price6: 100_000n, shares6: 100_000_000n }]),
  });
  const localHash = (leg: ImmutablePairBookLeg) => canonicalBookHash({
    tokenId: leg.tokenId, marketId: "m", bookVersion: leg.bookVersion, connectionEpoch: leg.connectionEpoch,
    sourceTsMs: leg.sourceTsMs, receivedTsMs: leg.receivedTsMs, exchangeHash: leg.exchangeHash,
    sourceEventId: leg.sourceEventId, integrity: leg.integrity,
    bids: leg.bids.map((x) => ({ price: x.price6, size: x.shares6 })),
    asks: leg.asks.map((x) => ({ price: x.price6, size: x.shares6 })),
  });
  const captureHash = pairCaptureHash({ marketId: "m", conditionId: "c", capturedAtMs: now, captureSequence: 7n,
    up: { ...up, contentHash: localHash(up) }, down: { ...down, contentHash: localHash(down) }, sourceSkewMs: 0, receiveSkewMs: 0 });
  return Object.freeze({
    captureId: pairCaptureId({ captureHash }), marketId: "m", conditionId: "c", capturedAtMs: now,
    captureSequence: 7n, sourceSkewMs: 0, receiveSkewMs: 0, captureHash,
    up, down,
  });
}

function request(overrides: Partial<Omit<PaperPairVenueRequest, "requestHash">> = {}): PaperPairVenueRequest {
  const c = (overrides.capture as PairBookCapture | undefined) ?? capture();
  const base: Omit<PaperPairVenueRequest, "requestHash"> = {
    effectId: "effect-1", clientOperationId: "client-1", idempotencyKey: "idem-1",
    operationKind: "INITIAL_FOK", capture: c,
    leg: {
      outcome: "UP", tokenId: "up", side: "BUY", timeInForce: "FOK", amountSemantics: "SHARES",
      grossShares6: 3_000_000n, limitPrice6: 500_000n, maximumCashDebit6: 2_000_000n,
      minimumOrderShares6: 1_000_000n, shareLot6: 1_000_000n,
      fee: { ratePpm: 70_000n, collection: "usdc" }, bookRef: paperPairBookReference(c, "UP"),
    },
    ...overrides,
  };
  return Object.freeze({ ...base, requestHash: paperPairVenueRequestHash(base) });
}

type VenueFactory = (script?: PaperPairVenueScript) => { venue: PaperPairVenue; restart(): PaperPairVenue };

function contract(name: string, factory: VenueFactory, lifecycle?: {
  readonly setup: () => Promise<void>;
  readonly reset: () => Promise<void>;
  readonly teardown: () => Promise<void>;
}): void {
  describe(`${name} paper-pair venue contract`, () => {
    if (lifecycle !== undefined) {
      beforeAll(lifecycle.setup, 15_000);
      beforeEach(lifecycle.reset);
      afterAll(lifecycle.teardown);
    }
    it("walks only the immutable direct-token asks and emits exact per-level FOK fills", async () => {
      const { venue } = factory();
      const evidence = await venue.executeIdempotently(request());
      expect(evidence.state).toBe("FILLED");
      expect(evidence.result.kind).toBe("FILLED");
      if (evidence.result.kind !== "FILLED") return;
      expect(evidence.result.quote.levels).toHaveLength(2);
      expect(evidence.result.quote.levels.map((x) => [x.price6, x.grossShares6])).toEqual([
        [400_000n, 1_000_000n], [500_000n, 2_000_000n],
      ]);
      expect(evidence.result.quote.principal6).toBe(1_400_000n);
      expect(evidence.result.quote.feeCash6).toBeGreaterThan(0n);
      expect(evidence.result.quote.bookRef.tokenId).toBe("up");
    });

    it("applies the declared fee convention per level and fails closed for unsupported sell-share fees", async () => {
      const { venue } = factory();
      const base = request();
      const shareFee = request({
        effectId: "effect-share-fee", clientOperationId: "client-share-fee", idempotencyKey: "idem-share-fee",
        leg: { ...base.leg, fee: { ratePpm: 70_000n, collection: "shares" } },
      });
      const bought = await venue.submitInitialFok(shareFee);
      expect(bought.result.kind).toBe("FILLED");
      if (bought.result.kind === "FILLED") {
        expect(bought.result.quote.feeCash6).toBe(0n);
        expect(bought.result.quote.feeShares6).toBeGreaterThan(0n);
        expect(bought.result.quote.receivedNetShares6).toBeLessThan(bought.result.quote.filledGrossShares6);
      }

      const c = capture();
      const { maximumCashDebit6: _maximumCashDebit6, ...sellLeg } = base.leg;
      const unsupportedSell = request({
        effectId: "effect-sell-share-fee", clientOperationId: "client-sell-share-fee", idempotencyKey: "idem-sell-share-fee",
        operationKind: "RECOVERY_SELL_FAK", capture: c,
        leg: { ...sellLeg, outcome: "DOWN", tokenId: "down", side: "SELL", timeInForce: "FAK", grossShares6: 1_000_000n,
          limitPrice6: 500_000n, availableShares6: 1_000_000n, fee: { ratePpm: 70_000n, collection: "shares" },
          bookRef: paperPairBookReference(c, "DOWN") },
      });
      expect((await venue.submitRecovery(unsupportedSell)).result).toMatchObject({ kind: "REJECTED", code: "REJECTED_CONSTRAINT" });
    });

    it("makes FOK all-or-zero for depth, limit, and exact debit cap failures", async () => {
      for (const [suffix, leg, code] of [
        ["depth", { grossShares6: 4_000_000n }, "NO_FILL_INSUFFICIENT_DEPTH"],
        ["limit", { limitPrice6: 450_000n }, "NO_FILL_LIMIT"],
        ["cap", { maximumCashDebit6: 1_399_999n }, "NO_FILL_CASH_CAP"],
      ] as const) {
        const { venue } = factory();
        const original = request();
        const r = request({
          effectId: `effect-${suffix}`, clientOperationId: `client-${suffix}`, idempotencyKey: `idem-${suffix}`,
          leg: { ...original.leg, ...leg },
        });
        const evidence = await venue.executeIdempotently(r);
        expect(evidence.result).toEqual({ kind: "NO_FILL", code });
      }
    });

    it("uses bids for recovery FAK and preserves an exact partial-canceled result", async () => {
      const { venue } = factory();
      const c = capture();
      const base = request();
      const { maximumCashDebit6: _maximumCashDebit6, ...sellLeg } = base.leg;
      const r = request({
        effectId: "effect-sell", clientOperationId: "client-sell", idempotencyKey: "idem-sell",
        operationKind: "RECOVERY_SELL_FAK", capture: c,
        leg: {
          ...sellLeg, outcome: "DOWN", tokenId: "down", side: "SELL", timeInForce: "FAK",
          grossShares6: 2_000_000n, limitPrice6: 500_000n,
          availableShares6: 2_000_000n, fee: { ratePpm: 70_000n, collection: "usdc" },
          bookRef: paperPairBookReference(c, "DOWN"),
        },
      });
      const evidence = await venue.executeIdempotently(r);
      expect(evidence.state).toBe("PARTIAL_CANCELED");
      expect(evidence.result.kind).toBe("PARTIAL_CANCELED");
      if (evidence.result.kind === "PARTIAL_CANCELED") {
        expect(evidence.result.quote.filledGrossShares6).toBe(1_000_000n);
        expect(evidence.result.quote.unfilledGrossShares6).toBe(1_000_000n);
        expect(evidence.result.quote.levels[0]!.price6).toBe(580_000n);
      }
    });

    it("fails closed on constraint and immutable-reference mismatches", async () => {
      const { venue } = factory();
      const base = request();
      const badLot = request({ effectId: "e-lot", clientOperationId: "c-lot", idempotencyKey: "i-lot", leg: { ...base.leg, grossShares6: 2_500_000n } });
      expect((await venue.executeIdempotently(badLot)).result).toMatchObject({ kind: "REJECTED", code: "REJECTED_CONSTRAINT" });

      const stale = request({
        effectId: "e-stale", clientOperationId: "c-stale", idempotencyKey: "i-stale",
        leg: { ...base.leg, bookRef: { ...base.leg.bookRef, bookVersion: 999n } },
      });
      expect((await venue.executeIdempotently(stale)).result).toMatchObject({ kind: "REJECTED", code: "REJECTED_STALE_EVIDENCE" });
    });

    it("durably binds stable client/effect ids and returns the stored outcome on retry/restart", async () => {
      let scriptCalls = 0;
      const setup = factory(() => { scriptCalls++; return { kind: "USE_BOOK" }; });
      const r = request();
      const first = await setup.venue.executeIdempotently(r);
      const duplicate = await setup.venue.executeIdempotently(r);
      const observed = await setup.restart().observe(r.clientOperationId);
      expect(duplicate).toEqual(first);
      expect(observed).toEqual(first);
      expect(first.effectId).toBe("effect-1");
      expect(first.evidenceId).toMatch(/^ppvo_[a-f0-9]{32}$/);
      expect(scriptCalls).toBe(1);
    });

    it("rejects duplicate client or idempotency identities with a different immutable hash", async () => {
      const { venue } = factory();
      await venue.executeIdempotently(request());
      const changedByClient = request({ effectId: "different-effect" });
      await expect(venue.executeIdempotently(changedByClient)).rejects.toBeInstanceOf(PaperPairVenueIdempotencyCollisionError);
      const changedByIdem = request({ clientOperationId: "different-client", effectId: "different-effect" });
      await expect(venue.executeIdempotently(changedByIdem)).rejects.toBeInstanceOf(PaperPairVenueIdempotencyCollisionError);
    });

    it("persists scripted reject and unknown, but rejects malformed script output at the boundary", async () => {
      const rejected = factory(() => ({ kind: "REJECT", code: "fixture" })).venue;
      const rejectRequest = request({ effectId: "effect-reject", clientOperationId: "client-reject", idempotencyKey: "idem-reject" });
      expect((await rejected.executeIdempotently(rejectRequest)).result).toMatchObject({ kind: "REJECTED", code: "REJECTED_SCRIPTED" });

      const unknownSetup = factory(() => ({ kind: "TIMEOUT" }));
      const unknownRequest = request({ effectId: "effect-unknown", clientOperationId: "client-unknown", idempotencyKey: "idem-unknown" });
      const unknown = await unknownSetup.venue.executeIdempotently(unknownRequest);
      expect(unknown).toMatchObject({ state: "OUTCOME_UNKNOWN", result: { kind: "UNKNOWN", reason: "UNKNOWN_SIMULATED_TIMEOUT" } });
      expect(await unknownSetup.restart().observe("client-unknown")).toEqual(unknown);

      const malformed = factory(() => ({ kind: "FILLED", fills: "not-an-array" })).venue;
      const malformedRequest = request({ effectId: "effect-malformed", clientOperationId: "client-malformed", idempotencyKey: "idem-malformed" });
      await expect(malformed.executeIdempotently(malformedRequest)).rejects.toBeInstanceOf(PaperPairVenueMalformedResultError);
      expect(await malformed.observe("client-malformed")).toBeNull();
    });

    it("rejects a caller hash that does not authenticate the complete immutable request", async () => {
      const { venue } = factory();
      await expect(venue.executeIdempotently({ ...request(), requestHash: "wrong" })).rejects.toBeInstanceOf(PaperPairVenueRequestError);
    });
  });
}

contract("deterministic in-memory", (script) => {
  const store = new InMemoryPaperPairOperationStore();
  return { venue: new PaperPairVenue(store, { now: () => now + 1, script }), restart: () => new PaperPairVenue(store, { now: () => now + 2, script }) };
});

let contractHandle: DbHandle;
contract("engine-composed durable", (script) => {
  const store = new DbPaperPairOperationStore(contractHandle);
  return { venue: new PaperPairVenue(store, { now: () => now + 1, script }), restart: () => new PaperPairVenue(new DbPaperPairOperationStore(contractHandle), { now: () => now + 2, script }) };
}, {
  setup: async () => {
    contractHandle = await makeDb({ pgliteDir: "memory://" });
    await contractHandle.migrate();
    await contractHandle.db.execute(sql.raw("SET session_replication_role = replica"));
  },
  reset: async () => { await contractHandle.db.delete(schema.pairPaperVenueOperations); },
  teardown: async () => { await contractHandle.close(); },
});

describe("DbPaperPairOperationStore", () => {
  it("commits the operation/result atomically and observes it after closing and reopening PGlite", async () => {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), "b5p-pair-venue-")), "pglite");
    const firstHandle = await makeDb({ pgliteDir: dir });
    await firstHandle.migrate();
    // This test isolates the venue-owned table. The referenced capture/effect
    // are coordinator fixtures whose insertion graph is tested separately.
    await firstHandle.db.execute(sql.raw("SET session_replication_role = replica"));
    const firstVenue = new PaperPairVenue(new DbPaperPairOperationStore(firstHandle), { now: () => now + 3 });
    const evidence = await firstVenue.executeIdempotently(request());
    await firstHandle.close();

    const reopened = await makeDb({ pgliteDir: dir });
    const restartedVenue = new PaperPairVenue(new DbPaperPairOperationStore(reopened), { now: () => now + 99 });
    expect(await restartedVenue.observe("client-1")).toEqual(evidence);
    expect(await restartedVenue.executeIdempotently(request())).toEqual(evidence);
    await reopened.close();
  }, 15_000);
});
