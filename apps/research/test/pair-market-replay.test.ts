import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPairDatasetManifest,
  pairDatasetObjectHash,
} from "../src/pair-dataset-manifest";
import {
  PairMarketReplayError,
  loadPairReplayDataset,
  replayPairMarketDataset,
  type PairReplayBoundaryRecord,
} from "../src/pair-market-replay";
import type { PairReplayTimer } from "../src/pair-replay-clock";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b5p-pair-replay-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function rawEvent(input: {
  id: string;
  marketId?: string;
  tokenId: string | null;
  eventKind: "SNAPSHOT" | "DELTA" | "TRADE" | "CONNECTION_RESET" | "ENVELOPE_BOUNDARY";
  connectionEpoch: string;
  envelopeId: string;
  sequenceInEnvelope: number;
  receivedTsMs: number;
  payload: Record<string, unknown>;
}) {
  return {
    ...input,
    marketId: input.marketId ?? "market-1",
    sourceTsMs: input.receivedTsMs - 1,
    payloadHash: pairDatasetObjectHash(input.payload),
  };
}

function envelope(input: {
  id: number;
  connectionEpoch: string;
  envelopeId: string;
  receivedTsMs: number;
  tokenId: string | null;
  eventKind: "SNAPSHOT" | "DELTA" | "CONNECTION_RESET";
  payload: Record<string, unknown>;
}) {
  return [
    rawEvent({ ...input, id: String(input.id), sequenceInEnvelope: 0 }),
    rawEvent({
      id: String(input.id + 1), tokenId: null, eventKind: "ENVELOPE_BOUNDARY",
      connectionEpoch: input.connectionEpoch, envelopeId: input.envelopeId,
      sequenceInEnvelope: 1, receivedTsMs: input.receivedTsMs, payload: { complete: true },
    }),
  ];
}

function checkpoint(tokenId: string, checkpointId: string) {
  const material = {
    checkpointId,
    marketId: "market-1",
    tokenId,
    lastEventId: "0",
    connectionEpoch: "epoch-0",
    bookVersion: "0",
    sourceTsMs: 89,
    receivedTsMs: 90,
    integrity: "VERIFIED_SNAPSHOT",
    bids: [{ price6: "400000", shares6: "900719925474099312345" }],
    asks: [{ price6: "600000", shares6: "2" }],
  };
  return { ...material, checkpointHash: pairDatasetObjectHash(material) };
}

async function fixture() {
  const root = await temporaryRoot();
  const snapshot = (price: string) => ({
    bookVersion: "1",
    bids: [{ price6: price, shares6: "900719925474099312345" }],
    asks: [{ price6: String(1_000_000 - Number(price)), shares6: "3000000" }],
  });
  const events = [
    ...envelope({ id: 1, connectionEpoch: "epoch-0", envelopeId: "a-up", receivedTsMs: 100, tokenId: "UP", eventKind: "SNAPSHOT", payload: snapshot("450000") }),
    ...envelope({ id: 3, connectionEpoch: "epoch-0", envelopeId: "b-down", receivedTsMs: 100, tokenId: "DOWN", eventKind: "SNAPSHOT", payload: snapshot("500000") }),
    ...envelope({ id: 5, connectionEpoch: "epoch-1", envelopeId: "reset", receivedTsMs: 110, tokenId: null, eventKind: "CONNECTION_RESET", payload: { reason: "reconnect" } }),
    ...envelope({ id: 7, connectionEpoch: "epoch-0", envelopeId: "stale", receivedTsMs: 120, tokenId: "UP", eventKind: "DELTA", payload: { bookVersion: "2", changes: [{ side: "BUY", price6: "450000", size6: "1" }] } }),
    ...envelope({ id: 9, connectionEpoch: "epoch-1", envelopeId: "y-up", receivedTsMs: 130, tokenId: "UP", eventKind: "SNAPSHOT", payload: snapshot("460000") }),
    ...envelope({ id: 11, connectionEpoch: "epoch-1", envelopeId: "z-down", receivedTsMs: 130, tokenId: "DOWN", eventKind: "SNAPSHOT", payload: snapshot("490000") }),
    ...envelope({ id: 13, connectionEpoch: "epoch-1", envelopeId: "gap", receivedTsMs: 140, tokenId: "UP", eventKind: "DELTA", payload: { bookVersion: "5", changes: [{ side: "BUY", price6: "460000", size6: "7" }] } }),
  ];
  await writeFile(join(root, "events.jsonl"), `${events.map((row) => JSON.stringify(row)).join("\n")}\n`);
  await writeFile(join(root, "checkpoints.json"), JSON.stringify([checkpoint("UP", "1"), checkpoint("DOWN", "2")]));
  const manifest = await buildPairDatasetManifest({
    root,
    datasetId: "causal-replay-v1",
    selection: { marketId: "market-1" },
    artifacts: [
      { path: "events.jsonl", role: "MARKET_EVENTS" },
      { path: "checkpoints.json", role: "BOOK_CHECKPOINTS" },
    ],
  });
  return { root, manifest };
}

const initialTimer: PairReplayTimer = {
  timerId: "activation-1",
  kind: "INITIAL_ACTIVATION",
  scheduledDueMs: 105,
  priority: 0,
  groupId: "pair-1",
  actionSequence: 0,
  payload: { action: "activate" },
};

describe("pair market replay", () => {
  it("applies checkpoints and causal envelopes with reconnect and gap barriers deterministically", async () => {
    const { root, manifest } = await fixture();
    const loaded = await loadPairReplayDataset(root, manifest);
    expect(loaded.events[0]!.id).toBe(1n);
    expect(loaded.checkpoints[0]!.bids[0]!.shares6).toBe(900719925474099312345n);

    const run = () => replayPairMarketDataset({
      manifest,
      ...loaded,
      options: {
        initialTimers: [initialTimer],
        onBoundary(record, clock) {
          if (record.envelopeId === "z-down") {
            clock.schedule({
              timerId: "same-ms-reconciliation",
              kind: "RECONCILIATION",
              scheduledDueMs: 130,
              groupId: "pair-1",
              actionSequence: 1,
              payload: { action: "reconcile" },
            });
          }
        },
      },
    });
    const first = run();
    const second = run();

    expect(first.canonicalOutput).toBe(second.canonicalOutput);
    expect(first.outputHash).toBe(second.outputHash);
    expect(first.canonicalOutput).toContain("900719925474099312345");

    const labels = first.records.map((record) => record.kind === "BOUNDARY" ? record.envelopeId : record.timer.timerId);
    expect(labels).toEqual([
      "a-up", "b-down", "activation-1", "reset", "stale", "y-up", "z-down",
      "same-ms-reconciliation", "gap",
    ]);
    const boundaries = first.records.filter((record): record is PairReplayBoundaryRecord => record.kind === "BOUNDARY");
    expect(boundaries.find(({ envelopeId }) => envelopeId === "reset")!.books.every(({ integrity }) => integrity === "INVALID_AFTER_RECONNECT")).toBe(true);
    expect(boundaries.find(({ envelopeId }) => envelopeId === "stale")!.barriers).toContain("DELTA_BLOCKED:UP:epoch-0");
    expect(boundaries.find(({ envelopeId }) => envelopeId === "gap")!.barriers).toContain("BOOK_VERSION_GAP:UP:1->5");
    expect(first.finalBooks.find(({ tokenId }) => tokenId === "UP")).toMatchObject({
      integrity: "GAP_SUSPECTED",
      requiredConnectionEpoch: "epoch-1",
    });
    expect(boundaries[0]!.replayEventId).toMatch(/^pair-replay-event-/);
    expect(boundaries[0]!.triggerId).toMatch(/^pair-replay-trigger-/);
    expect(boundaries[0]!.captureId).toMatch(/^pair-replay-capture-/);
  });

  it("rejects a checkpoint whose semantic hash does not match", async () => {
    const root = await temporaryRoot();
    const bad = { ...checkpoint("UP", "1"), checkpointHash: "0".repeat(64) };
    await writeFile(join(root, "checkpoints.json"), JSON.stringify([bad]));
    const manifest = await buildPairDatasetManifest({
      root,
      datasetId: "bad-checkpoint",
      selection: {},
      artifacts: [{ path: "checkpoints.json", role: "BOOK_CHECKPOINTS" }],
    });

    await expect(loadPairReplayDataset(root, manifest)).rejects.toBeInstanceOf(PairMarketReplayError);
  });

  it("keeps a reconnect epoch barrier for a token first observed after reset", async () => {
    const root = await temporaryRoot();
    const events = [
      ...envelope({
        id: 1, connectionEpoch: "epoch-1", envelopeId: "reset", receivedTsMs: 100,
        tokenId: null, eventKind: "CONNECTION_RESET", payload: { reason: "reconnect" },
      }),
      ...envelope({
        id: 3, connectionEpoch: "epoch-0", envelopeId: "late-stale-snapshot", receivedTsMs: 110,
        tokenId: "UP", eventKind: "SNAPSHOT",
        payload: { bookVersion: "1", bids: [], asks: [] },
      }),
    ];
    await writeFile(join(root, "events.jsonl"), `${events.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const manifest = await buildPairDatasetManifest({
      root,
      datasetId: "reconnect-new-token",
      selection: {},
      artifacts: [{ path: "events.jsonl", role: "MARKET_EVENTS" }],
    });
    const loaded = await loadPairReplayDataset(root, manifest);
    const result = replayPairMarketDataset({ manifest, ...loaded });
    const stale = result.records.find((record): record is PairReplayBoundaryRecord =>
      record.kind === "BOUNDARY" && record.envelopeId === "late-stale-snapshot");

    expect(stale?.barriers).toContain("STALE_SNAPSHOT:UP:epoch-0");
    expect(result.finalBooks).toEqual([]);
  });
});
