import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDb, schema, type DbHandle } from "@b5p/db";
import { PersistedPairTokenTermsProvider, type PairTokenTermsSource } from "../src/pair-token-terms";

const now = 1_800_000_000_000;
let handle: DbHandle;

const source = (change: Partial<{ fee: string; tick: string; minimum: string; collection: string; effectiveAtMs: number; returnedToken: string }> = {}): PairTokenTermsSource => ({
  async fetchTokenTerms({ tokenId }) {
    return {
      tokenId: change.returnedToken ?? tokenId,
      rawFeeRate: change.fee ?? "0.07",
      rawTickSize: change.tick ?? "0.01",
      rawMinimumOrderShares: change.minimum ?? "5",
      rawVenueMetadata: { fee_collection: change.collection ?? "usdc", fee_type: "crypto_fees_v2" },
      source: "fixture-authority",
      effectiveAtMs: change.effectiveAtMs ?? now,
    };
  },
});

const resolver = { version: "fixture-v1", resolve: ({ rawVenueMetadata }: { rawVenueMetadata: Readonly<Record<string, string>> }) => rawVenueMetadata.fee_collection === "usdc" ? ({ kind: "RESOLVED", convention: "USDC" } as const) : rawVenueMetadata.fee_collection === "shares" ? ({ kind: "RESOLVED", convention: "SHARES" } as const) : ({ kind: "UNKNOWN", reason: "unknown fixture" } as const) };

async function seedMarket() {
  await handle.db.insert(schema.markets).values({ id: "m", eventId: "e", conditionId: "c", slug: "s", question: "q", upTokenId: "up", downTokenId: "down", startEpoch: 1, endEpoch: 2, rulesText: "r", rulesHash: "h", resolutionSource: "CHAINLINK", rulesNameChainlink: true, tickSize6: 10_000n, minOrderShares6: 5_000_000n, negRisk: false, status: "ACTIVE", discoveredAtMs: now, updatedAtMs: now });
}

beforeEach(async () => { handle = await makeDb({ pgliteDir: "memory://" }); await handle.migrate(); await seedMarket(); });
afterEach(async () => { await handle.close(); });

describe("persisted pair token terms", () => {
  it("parses both tokens independently from exact strings and persists immutable provenance", async () => {
    const provider = new PersistedPairTokenTermsProvider(handle, source(), resolver, { maximumFeeSnapshotAgeMs: 1000, maximumConstraintSnapshotAgeMs: 1000, nowMs: () => now });
    const result = await provider.currentTerms({ marketId: "m", conditionId: "c", upTokenId: "up", downTokenId: "down", asOfMs: now });
    expect(result).toMatchObject({ kind: "READY", up: { tokenId: "up", fee: { tokenFeeRatePpm: 70_000n, convention: "USDC" }, constraints: { tickSize6: 10_000n, minimumOrderShares6: 5_000_000n } }, down: { tokenId: "down" } });
    const fees = await handle.db.select().from(schema.feeScheduleSnapshots);
    const constraints = await handle.db.select().from(schema.constraintSnapshots);
    expect(fees).toHaveLength(2); expect(constraints).toHaveLength(2);
    expect(new Set(fees.map((row) => row.tokenId))).toEqual(new Set(["up", "down"]));
    expect(fees.every((row) => row.sourcePayloadHash && row.canonicalHash && row.conventionResolverVersion === "fixture-v1")).toBe(true);
  });

  it("reuses rows for identical canonical terms and appends when one token changes", async () => {
    let downTick = "0.01";
    const dynamic: PairTokenTermsSource = { fetchTokenTerms: async ({ tokenId }) => ({ ...(await source({ tick: tokenId === "down" ? downTick : "0.01" }).fetchTokenTerms({ marketId: "m", conditionId: "c", tokenId, asOfMs: now }))! }) };
    const provider = new PersistedPairTokenTermsProvider(handle, dynamic, resolver, { maximumFeeSnapshotAgeMs: 1000, maximumConstraintSnapshotAgeMs: 1000, nowMs: () => now });
    const input = { marketId: "m", conditionId: "c", upTokenId: "up", downTokenId: "down", asOfMs: now };
    await provider.currentTerms(input); await provider.currentTerms(input);
    expect(await handle.db.select().from(schema.constraintSnapshots)).toHaveLength(2);
    downTick = "0.02"; await provider.currentTerms(input);
    const rows = await handle.db.select().from(schema.constraintSnapshots);
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.tokenId === "down").map((row) => row.tickSize6).sort()).toEqual([10_000n, 20_000n]);
  });

  it.each([
    [source({ fee: "0.0700001" }), "FEE_SNAPSHOT_MALFORMED"],
    [source({ returnedToken: "wrong" }), "FEE_SNAPSHOT_TOKEN_MISMATCH"],
    [source({ effectiveAtMs: now - 1001 }), "FEE_SNAPSHOT_STALE"],
    [source({ collection: "mystery" }), "FEE_CONVENTION_UNKNOWN"],
  ] as const)("fails malformed, mismatched, stale, and unknown terms closed", async (fixture, code) => {
    const provider = new PersistedPairTokenTermsProvider(handle, fixture, resolver, { maximumFeeSnapshotAgeMs: 1000, maximumConstraintSnapshotAgeMs: 1000, nowMs: () => now });
    await expect(provider.currentTerms({ marketId: "m", conditionId: "c", upTokenId: "up", downTokenId: "down", asOfMs: now })).resolves.toMatchObject({ kind: "REJECTED", code });
  });

  it("turns transport failure into an ordinary rejection", async () => {
    const provider = new PersistedPairTokenTermsProvider(handle, { fetchTokenTerms: async () => { throw new Error("offline"); } }, resolver, { maximumFeeSnapshotAgeMs: 1000, maximumConstraintSnapshotAgeMs: 1000, nowMs: () => now });
    await expect(provider.currentTerms({ marketId: "m", conditionId: "c", upTokenId: "up", downTokenId: "down", asOfMs: now })).resolves.toMatchObject({ kind: "REJECTED", code: "TERMS_TRANSPORT_FAILURE" });
  });
});
