import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDb, schema, type DbHandle } from "@b5p/db";
import { BookState } from "@b5p/strategy";
import { buildPairCapture, type PairBookCapture, type PairTokenTerms } from "@b5p/pair-execution";
import { PairObservationStore, shouldPersistNegativeControl, type RecordPairEvaluationInput } from "../src/pair-observation-store";

const now = 1_800_000_000_000;
let handle: DbHandle;
let capture: PairBookCapture;

const terms = (outcome: "UP" | "DOWN", tokenId: string): PairTokenTerms => ({
  outcome, tokenId,
  constraints: { snapshotId: `constraint-${tokenId}`, tokenId, tickSize6: 10_000n, minimumOrderShares6: 1_000_000n, effectiveAtMs: now, fetchedAtMs: now, source: "fixture", canonicalHash: `ch-${tokenId}` },
  fee: { snapshotId: `fee-${tokenId}`, tokenId, tokenFeeRatePpm: 70_000n, convention: "USDC", conventionResolverVersion: "v1", effectiveAtMs: now, fetchedAtMs: now, source: "fixture", canonicalHash: `fh-${tokenId}` },
});
const upTerms = terms("UP", "up");
const downTerms = terms("DOWN", "down");

function makeView(tokenId: string) {
  const book = new BookState(tokenId, "m");
  book.applySnapshot([{ price: "0.48", size: "2" }], [{ price: "0.49", size: "2" }], now, now, { connectionEpoch: "e1", sourceEventId: `snapshot-${tokenId}`, marketId: "m" });
  return book.snapshot();
}

const baseEvaluation = (triggerId: string, episodeState: RecordPairEvaluationInput["episodeState"]): RecordPairEvaluationInput => ({
  marketId: "m", conditionId: "c", strategyVersion: "complete_set_pair_v0_RESEARCH_ONLY", mode: "observe",
  triggerKind: "CLOB_ENVELOPE", triggerId, capture, upTerms, downTerms, policyHash: "policy",
  observerOperationalHash: "ops", configVersion: 1, requestedCashCap6: 10_000_000n,
  observedAtMs: now, episodeState, episodeCooloffMs: 1_000, negativeControlSamplePpm: 0n,
  minimumAskSum6: 980_000n, selectedPairShares6: 1_000_000n,
  grossTopOfBookEdge6: 20_000n, grossWalkEdge6: 20_000n, netPreLatencyPnl6: 10_000n,
  netPreLatencyEdgePpm: 10_000n, oneTickWorsePnl6: 5_000n, twoTicksWorsePnl6: null,
  worstCaseResidualLoss6: 500_000n, operationalRiskHaircut6: 1_000n,
  rejectionCodes: [], captureSummary: { sequence: capture.captureSequence },
  quote: { pnl6: 10_000n }, decision: { kind: episodeState ?? "OUTSIDE" }, depthStress: [{ fractionPpm: 750_000n }],
  funnel: { completeEnvelopes: true, validSynchronizedCaptures: true, evaluatedCaptures: true, prefilterCaptures: episodeState !== null, grossDislocations: episodeState !== null, fullDepthExecutable: true, feePositive: true, stressPositive: true },
});

beforeEach(async () => {
  handle = await makeDb({ pgliteDir: "memory://" });
  await handle.migrate();
  const built = buildPairCapture({ marketId: "m", conditionId: "c", expectedUpTokenId: "up", expectedDownTokenId: "down", capturedAtMs: now, captureSequence: 1n, mode: "observe", policy: { maximumBookAgeMs: 500, maximumSourceSkewMs: 100, maximumReceiveSkewMs: 100, maximumFutureTimestampMs: 250 }, up: makeView("up"), down: makeView("down") });
  if (built.kind !== "ACCEPTED") throw new Error("fixture capture rejected");
  capture = built.capture;
});
afterEach(async () => { await handle.close(); });

describe("pair observation store", () => {
  it("materializes an immutable exact-string capture idempotently", async () => {
    const store = new PairObservationStore(handle);
    const input = { capture, captureKind: "SIGNAL" as const, upTerms, downTerms, createdAtMs: now };
    await store.persistCapture(input); await store.persistCapture(input);
    const rows = await handle.db.select().from(schema.pairBookCaptures);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: capture.captureId, captureHash: capture.captureHash, upFeeSnapshotId: "fee-up", downConstraintSnapshotId: "constraint-down" });
    expect(rows[0]!.upLevelsJson).toMatchObject({ asks: [{ price6: "490000", shares6: "2000000" }] });
  });

  it("clusters episode transitions and remains idempotent across store restart", async () => {
    const store = new PairObservationStore(handle);
    await store.persistCapture({ capture, captureKind: "SIGNAL", upTerms, downTerms, createdAtMs: now });
    const gross = baseEvaluation("env-1", "GROSS_DISLOCATION");
    const first = await store.recordEvaluation(gross);
    expect(first.kind).toBe("INSERTED");
    expect(await store.recordEvaluation(gross)).toMatchObject({ kind: "DUPLICATE" });

    const restarted = new PairObservationStore(handle);
    const eligible = { ...baseEvaluation("env-2", "NET_ELIGIBLE"), observedAtMs: now + 10 };
    expect((await restarted.recordEvaluation(eligible)).kind).toBe("INSERTED");
    expect((await restarted.recordEvaluation(eligible)).kind).toBe("DUPLICATE");

    const episodes = await handle.db.select().from(schema.pairOpportunityEpisodes);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ state: "NET_ELIGIBLE", envelopeCount: 2n, eligibleEnvelopeCount: 1n, minimumAskSum6: 980_000n, maximumSignalNetPnl6: 10_000n });
    expect(await handle.db.select().from(schema.pairOpportunityObservations)).toHaveLength(2);
    const buckets = await handle.db.select().from(schema.pairObserverBucketStats);
    expect(buckets[0]).toMatchObject({ completeEnvelopes: 2n, evaluatedCaptures: 2n, grossDislocations: 2n });
  });

  it("closes an episode only after the cooloff interval", async () => {
    const store = new PairObservationStore(handle);
    await store.persistCapture({ capture, captureKind: "SIGNAL", upTerms, downTerms, createdAtMs: now });
    await store.recordEvaluation(baseEvaluation("env-open", "GROSS_DISLOCATION"));
    const early = { ...baseEvaluation("env-early", null), observedAtMs: now + 999 };
    expect((await store.recordEvaluation(early)).kind).toBe("SAMPLED_OUT");
    expect((await handle.db.select().from(schema.pairOpportunityEpisodes))[0]!.closedAtMs).toBeNull();
    const closed = { ...baseEvaluation("env-close", null), observedAtMs: now + 1_000 };
    expect((await store.recordEvaluation(closed)).kind).toBe("INSERTED");
    expect((await handle.db.select().from(schema.pairOpportunityEpisodes))[0]).toMatchObject({ state: "CLOSED", closeReason: "COOLOFF", closedAtMs: now + 1_000 });
  });

  it("samples controls deterministically from the canonical first 64 hash bits", () => {
    const input = { strategyVersion: "s", policyHash: "p", marketId: "m", triggerId: "e", captureHash: "c" };
    expect(shouldPersistNegativeControl({ ...input, thresholdPpm: 0n })).toBe(false);
    expect(shouldPersistNegativeControl({ ...input, thresholdPpm: 1_000_000n })).toBe(true);
    expect(shouldPersistNegativeControl({ ...input, thresholdPpm: 123_456n })).toBe(shouldPersistNegativeControl({ ...input, thresholdPpm: 123_456n }));
  });
});
