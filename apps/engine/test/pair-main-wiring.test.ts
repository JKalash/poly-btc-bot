import { describe, expect, it } from "vitest";
import type { PersistedMarketDataEvent } from "@b5p/db";
import { releasePersistedPairObserverBoundaries } from "../src/main";

function event(input: { id: bigint; envelopeId: string; kind?: "DELTA" | "ENVELOPE_BOUNDARY" }): PersistedMarketDataEvent {
  return {
    id: input.id,
    marketId: "market",
    tokenId: input.kind === "ENVELOPE_BOUNDARY" ? null : "up",
    eventKind: input.kind ?? "ENVELOPE_BOUNDARY",
    connectionEpoch: "epoch",
    envelopeId: input.envelopeId,
    sequenceInEnvelope: input.kind === "DELTA" ? 0 : 1,
    sourceEventId: null,
    sourceTsMs: 10,
    sourceTimestampKind: "SOURCE",
    receivedTsMs: 11,
    exchangeHash: null,
    payload: {},
    payloadHash: "hash",
    createdAtMs: 11,
  };
}

describe("BPAIR-081 persisted observer release gate", () => {
  it("does not expose dirty work until the durable envelope boundary and publishes its exact row id first", () => {
    const pending = new Map([["envelope", { marketId: "market", envelopeId: "envelope" }]]);
    const sequences = new Map<string, bigint>();
    const calls: string[] = [];

    expect(releasePersistedPairObserverBoundaries({
      persisted: [event({ id: 40n, envelopeId: "envelope", kind: "DELTA" })],
      pending,
      durableSequences: sequences,
      maximumRetainedSequences: 10,
      markDirty: () => { throw new Error("delta must not release observer work"); },
    })).toBe(0);
    expect(pending.has("envelope")).toBe(true);

    expect(releasePersistedPairObserverBoundaries({
      persisted: [event({ id: 41n, envelopeId: "envelope" })],
      pending,
      durableSequences: sequences,
      maximumRetainedSequences: 10,
      markDirty: (marketId, envelopeId) => {
        expect(sequences.get(envelopeId)).toBe(41n);
        calls.push(`${marketId}/${envelopeId}`);
        return "SCHEDULED";
      },
    })).toBe(1);
    expect(calls).toEqual(["market/envelope"]);
    expect(pending.size).toBe(0);
    expect(sequences.get("envelope")).toBe(41n);
  });

  it("drops unregistered releases and bounds coalesced durable sequence retention", () => {
    const pending = new Map([
      ["old", { marketId: "old-market", envelopeId: "old" }],
      ["new", { marketId: "market", envelopeId: "new" }],
    ]);
    const sequences = new Map<string, bigint>();
    expect(releasePersistedPairObserverBoundaries({
      persisted: [event({ id: 1n, envelopeId: "old" }), event({ id: 2n, envelopeId: "new" })],
      pending,
      durableSequences: sequences,
      maximumRetainedSequences: 1,
      markDirty: (marketId) => marketId === "old-market" ? "UNREGISTERED" : "COALESCED",
    })).toBe(1);
    expect(pending.size).toBe(0);
    expect([...sequences.entries()]).toEqual([["new", 2n]]);
  });
});
