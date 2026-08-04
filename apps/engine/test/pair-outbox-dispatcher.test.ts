import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDb, schema, type DbHandle } from "@b5p/db";
import {
  canonicalJsonValue,
  pairCaptureHash,
  pairCaptureId,
  type ImmutablePairBookLeg,
  type PairBookCapture,
} from "@b5p/pair-execution";
import { canonicalBookHash } from "@b5p/strategy";
import { sql } from "drizzle-orm";
import {
  PairOutboxDispatcher,
  PairOutboxDispatcherCriticalError,
  encodePaperPairOutboxRequestPayload,
  type DurablePaperPairVenuePort,
} from "../src/pair-outbox-dispatcher";
import { PairStore } from "../src/pair-store";
import {
  InMemoryPaperPairOperationStore,
  PaperPairVenue,
  paperPairBookReference,
  paperPairVenueRequestHash,
  type PaperPairVenueRequest,
} from "../src/paper-pair-venue";

const now = 1_800_000_000_000;
let handle: DbHandle;
let store: PairStore;

beforeEach(async () => {
  handle = await makeDb({ pgliteDir: "memory://" });
  await handle.migrate();
  // Dispatcher tests isolate the outbox/inbox boundary; aggregate FK parent
  // creation is covered by pair-store.test.ts.
  await handle.db.execute(sql.raw("SET session_replication_role = replica"));
  store = new PairStore(handle);
});

afterEach(async () => { await handle.close(); });

function capture(): PairBookCapture {
  const up: ImmutablePairBookLeg = Object.freeze({
    outcome: "UP", tokenId: "up", bookVersion: 11n, connectionEpoch: "epoch", sourceTsMs: now,
    receivedTsMs: now, exchangeHash: null, sourceEventId: "up-event", integrity: "VERIFIED_SNAPSHOT",
    bids: Object.freeze([{ price6: 390_000n, shares6: 1_000_000n }]),
    asks: Object.freeze([{ price6: 400_000n, shares6: 1_000_000n }]),
  });
  const down: ImmutablePairBookLeg = Object.freeze({
    outcome: "DOWN", tokenId: "down", bookVersion: 12n, connectionEpoch: "epoch", sourceTsMs: now,
    receivedTsMs: now, exchangeHash: null, sourceEventId: "down-event", integrity: "VERIFIED_SNAPSHOT",
    bids: Object.freeze([{ price6: 580_000n, shares6: 1_000_000n }]),
    asks: Object.freeze([{ price6: 500_000n, shares6: 1_000_000n }]),
  });
  const localHash = (leg: ImmutablePairBookLeg) => canonicalBookHash({
    tokenId: leg.tokenId, marketId: "market", bookVersion: leg.bookVersion, connectionEpoch: leg.connectionEpoch,
    sourceTsMs: leg.sourceTsMs, receivedTsMs: leg.receivedTsMs, exchangeHash: leg.exchangeHash,
    sourceEventId: leg.sourceEventId, integrity: leg.integrity,
    bids: leg.bids.map((x) => ({ price: x.price6, size: x.shares6 })),
    asks: leg.asks.map((x) => ({ price: x.price6, size: x.shares6 })),
  });
  const captureHash = pairCaptureHash({
    marketId: "market", conditionId: "condition", capturedAtMs: now, captureSequence: 7n,
    up: { ...up, contentHash: localHash(up) }, down: { ...down, contentHash: localHash(down) },
    sourceSkewMs: 0, receiveSkewMs: 0,
  });
  return Object.freeze({
    captureId: pairCaptureId({ captureHash }), marketId: "market", conditionId: "condition",
    capturedAtMs: now, captureSequence: 7n, up, down, sourceSkewMs: 0, receiveSkewMs: 0, captureHash,
  });
}

function request(effectId = "effect"): PaperPairVenueRequest {
  const c = capture();
  const base: Omit<PaperPairVenueRequest, "requestHash"> = {
    effectId,
    clientOperationId: `client-${effectId}`,
    idempotencyKey: `idem-${effectId}`,
    operationKind: "INITIAL_FOK",
    capture: c,
    leg: {
      outcome: "UP", tokenId: "up", side: "BUY", timeInForce: "FOK", amountSemantics: "SHARES",
      grossShares6: 1_000_000n, limitPrice6: 400_000n, maximumCashDebit6: 500_000n,
      minimumOrderShares6: 1_000_000n, shareLot6: 1_000_000n,
      fee: { ratePpm: 0n, collection: "usdc" }, bookRef: paperPairBookReference(c, "UP"),
    },
  };
  return Object.freeze({ ...base, requestHash: paperPairVenueRequestHash(base) });
}

async function seedEffect(input: {
  readonly request?: PaperPairVenueRequest;
  readonly requestPayload?: unknown;
  readonly state?: "PENDING" | "CLAIMED";
  readonly claimToken?: string | null;
  readonly claimedAtMs?: number | null;
  readonly claimExpiresAtMs?: number | null;
  readonly attemptCount?: number;
} = {}): Promise<PaperPairVenueRequest> {
  const venueRequest = input.request ?? request();
  await handle.db.insert(schema.pairEffectOutbox).values({
    id: venueRequest.effectId,
    groupId: "group",
    actionIntentId: "action",
    actionKind: "INITIAL_BUY_UP",
    actionSequence: 1,
    effectOrdinal: 0,
    idempotencyKey: venueRequest.idempotencyKey,
    clientOperationId: venueRequest.clientOperationId,
    requestHash: venueRequest.requestHash,
    requestPayload: (input.requestPayload ?? encodePaperPairOutboxRequestPayload(venueRequest)) as never,
    state: input.state ?? "PENDING",
    notBeforeMs: now,
    deadlineMs: now + 10_000,
    claimToken: input.claimToken ?? null,
    claimedAtMs: input.claimedAtMs ?? null,
    claimExpiresAtMs: input.claimExpiresAtMs ?? null,
    attemptCount: input.attemptCount ?? 0,
    createdAtMs: now,
    updatedAtMs: now,
  });
  return venueRequest;
}

describe("pair outbox dispatcher", () => {
  it("claims a committed PENDING effect, proves it exists, executes once, and atomically links terminal evidence", async () => {
    await seedEffect();
    const paper = new PaperPairVenue(new InMemoryPaperPairOperationStore(), { now: () => now + 2 });
    let calls = 0;
    const venue: DurablePaperPairVenuePort = {
      executeIdempotently: async (venueRequest) => {
        calls++;
        expect(await store.getEffect(venueRequest.effectId)).toMatchObject({
          state: "CLAIMED", claimToken: "worker", attemptCount: 1,
        });
        return paper.executeIdempotently(venueRequest);
      },
      observe: (clientOperationId) => paper.observe(clientOperationId),
    };
    const dispatcher = new PairOutboxDispatcher(store, venue, async () => true);
    await expect(dispatcher.dispatchNext({ nowMs: now, leaseMs: 100, claimToken: "worker" })).resolves.toMatchObject({
      kind: "EVIDENCE_INGESTED", effectId: "effect", effectState: "SUCCEEDED", source: "EXECUTED",
    });
    expect(calls).toBe(1);
    expect(await store.getEffect("effect")).toMatchObject({ state: "SUCCEEDED", resultEvidenceId: expect.stringMatching(/^ppvo_/) });
    expect(await handle.db.select().from(schema.pairInboxEvidence)).toHaveLength(1);
    await expect(dispatcher.dispatchNext({ nowMs: now + 1, leaseMs: 100, claimToken: "worker-2" })).resolves.toEqual({ kind: "IDLE" });
    expect(calls).toBe(1);
  });

  it("observes an expired claim before doing anything else and never retries durable UNKNOWN evidence", async () => {
    const venueRequest = await seedEffect({
      state: "CLAIMED", claimToken: "dead-worker", claimedAtMs: now - 200,
      claimExpiresAtMs: now - 1, attemptCount: 1,
    });
    const paper = new PaperPairVenue(new InMemoryPaperPairOperationStore(), {
      now: () => now - 50,
      script: () => ({ kind: "TIMEOUT" }),
    });
    const unknown = await paper.executeIdempotently(venueRequest);
    expect(unknown.state).toBe("OUTCOME_UNKNOWN");
    const order: string[] = [];
    const venue: DurablePaperPairVenuePort = {
      observe: async (clientOperationId) => { order.push("observe"); return paper.observe(clientOperationId); },
      executeIdempotently: async (value) => { order.push("execute"); return paper.executeIdempotently(value); },
    };
    const dispatcher = new PairOutboxDispatcher(store, venue, async () => { order.push("legality"); return true; });
    await expect(dispatcher.recoverNextExpired({ nowMs: now, leaseMs: 100, claimToken: "recovery" })).resolves.toMatchObject({
      kind: "EVIDENCE_INGESTED", effectState: "OUTCOME_UNKNOWN", source: "OBSERVED",
    });
    expect(order).toEqual(["observe"]);
    expect(await store.getEffect("effect")).toMatchObject({ state: "OUTCOME_UNKNOWN", attemptCount: 1 });
    await expect(dispatcher.recoverNextExpired({ nowMs: now + 1_000, leaseMs: 100, claimToken: "later" })).resolves.toEqual({ kind: "IDLE" });
  });

  it("never steals a live claim and re-executes an expired absent operation only after injected legality permits", async () => {
    await seedEffect({
      state: "CLAIMED", claimToken: "live-worker", claimedAtMs: now,
      claimExpiresAtMs: now + 50, attemptCount: 1,
    });
    const paper = new PaperPairVenue(new InMemoryPaperPairOperationStore(), { now: () => now + 200 });
    let legal = false;
    let observes = 0;
    let executes = 0;
    const venue: DurablePaperPairVenuePort = {
      observe: async (clientOperationId) => { observes++; return paper.observe(clientOperationId); },
      executeIdempotently: async (value) => { executes++; return paper.executeIdempotently(value); },
    };
    const dispatcher = new PairOutboxDispatcher(store, venue, async () => legal);
    await expect(dispatcher.recoverNextExpired({ nowMs: now + 49, leaseMs: 100, claimToken: "too-early" })).resolves.toEqual({ kind: "IDLE" });
    expect(observes).toBe(0);

    await expect(dispatcher.recoverNextExpired({ nowMs: now + 50, leaseMs: 100, claimToken: "recovery-1" })).resolves.toEqual({
      kind: "REQUIRES_RECONCILIATION", effectId: "effect", recovery: true,
    });
    expect({ observes, executes }).toEqual({ observes: 1, executes: 0 });
    expect(await store.getEffect("effect")).toMatchObject({ state: "CLAIMED", claimToken: "recovery-1", attemptCount: 1 });

    legal = true;
    await expect(dispatcher.recoverNextExpired({ nowMs: now + 150, leaseMs: 100, claimToken: "recovery-2" })).resolves.toMatchObject({
      kind: "EVIDENCE_INGESTED", effectState: "SUCCEEDED", source: "EXECUTED",
    });
    expect({ observes, executes }).toEqual({ observes: 2, executes: 1 });
    expect(await store.getEffect("effect")).toMatchObject({ state: "SUCCEEDED", attemptCount: 2 });
  });

  it("fails critically on lossy/non-canonical payloads before a venue call", async () => {
    const venueRequest = request();
    const payload = encodePaperPairOutboxRequestPayload(venueRequest) as Record<string, unknown>;
    const badLeg = { ...(payload.leg as Record<string, unknown>), grossShares6: 1_000_000 };
    await seedEffect({ request: venueRequest, requestPayload: canonicalJsonValue({ ...payload, leg: badLeg }) });
    let calls = 0;
    const venue: DurablePaperPairVenuePort = {
      observe: async () => null,
      executeIdempotently: async () => { calls++; throw new Error("must not execute"); },
    };
    const dispatcher = new PairOutboxDispatcher(store, venue, async () => true);
    await expect(dispatcher.dispatchNext({ nowMs: now, leaseMs: 100, claimToken: "worker" })).rejects.toMatchObject({
      name: "PairOutboxDispatcherCriticalError", code: "INVALID_REQUEST_PAYLOAD", critical: true,
    });
    expect(calls).toBe(0);
  });

  it("fails critically when observed evidence is bound to another immutable request", async () => {
    const venueRequest = await seedEffect({
      state: "CLAIMED", claimToken: "dead-worker", claimedAtMs: now - 200,
      claimExpiresAtMs: now - 1, attemptCount: 1,
    });
    const paper = new PaperPairVenue(new InMemoryPaperPairOperationStore(), { now: () => now - 10 });
    const evidence = await paper.executeIdempotently(venueRequest);
    let executions = 0;
    const dispatcher = new PairOutboxDispatcher(store, {
      observe: async () => ({ ...evidence, requestHash: "different-hash" }),
      executeIdempotently: async () => { executions++; return evidence; },
    }, async () => true);
    await expect(dispatcher.recoverNextExpired({ nowMs: now, leaseMs: 100, claimToken: "recovery" })).rejects.toBeInstanceOf(PairOutboxDispatcherCriticalError);
    expect(executions).toBe(0);
    expect(await store.getEffect("effect")).toMatchObject({ state: "CLAIMED", resultEvidenceId: null });
  });
});
