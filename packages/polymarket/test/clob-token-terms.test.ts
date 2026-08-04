import { describe, expect, it, vi } from "vitest";
import {
  FetchPublicClobTermsTransport,
  POLYMARKET_CLOB_V2_USDC_TAKER_FEE_CONTRACT,
  PublicClobTokenTermsSource,
  exactBasisPointsToRate,
  type PublicClobTermsTransport,
} from "../src/clob-token-terms";

const NOW = 1_800_000_000_000;
const book = (tokenId: string, conditionId = "condition", tick = "0.010000", minimum = "5.000001") => JSON.stringify({
  market: conditionId,
  asset_id: tokenId,
  timestamp: String(NOW),
  hash: "hash",
  bids: [],
  asks: [],
  min_order_size: minimum,
  tick_size: tick,
  neg_risk: false,
  last_trade_price: "0.5",
});

function transport(responses: Readonly<Record<string, { status?: number; body: string }>>): PublicClobTermsTransport {
  return {
    async get(path) {
      const response = responses[path];
      if (!response) throw new Error(`unexpected path ${path}`);
      return { status: response.status ?? 200, body: response.body };
    },
  };
}

function sourceFor(tokenId: string, overrides: {
  bookBody?: string;
  feeBody?: string;
  nowMs?: () => number;
  contract?: typeof POLYMARKET_CLOB_V2_USDC_TAKER_FEE_CONTRACT | undefined;
} = {}) {
  return new PublicClobTokenTermsSource({
    transport: transport({
      [`/book?token_id=${tokenId}`]: { body: overrides.bookBody ?? book(tokenId) },
      [`/fee-rate?token_id=${tokenId}`]: { body: overrides.feeBody ?? "{\"base_fee\":30}" },
    }),
    nowMs: overrides.nowMs ?? (() => NOW),
    ...(overrides.contract === undefined && "contract" in overrides ? {} : {
      feeCollectionContract: overrides.contract ?? POLYMARKET_CLOB_V2_USDC_TAKER_FEE_CONTRACT,
    }),
  });
}

const request = (tokenId: string, asOfMs = NOW) => ({ marketId: "market", conditionId: "condition", tokenId, asOfMs });

describe("public CLOB token terms", () => {
  it("preserves tick/minimum strings and converts the integer bps lexeme exactly", async () => {
    const source = sourceFor("token", { feeBody: "{ \"base_fee\" : 30 }" });
    const terms = await source.fetchTokenTerms(request("token"));
    expect(terms).toMatchObject({
      tokenId: "token",
      rawTickSize: "0.010000",
      rawMinimumOrderShares: "5.000001",
      rawFeeRate: "0.003",
      rawVenueMetadata: {
        fee_collection: "usdc",
        fee_rate_basis_points: "30",
        fee_collection_contract_version: POLYMARKET_CLOB_V2_USDC_TAKER_FEE_CONTRACT.version,
      },
    });
    expect(exactBasisPointsToRate("0")).toBe("0");
    expect(exactBasisPointsToRate("1")).toBe("0.0001");
    expect(exactBasisPointsToRate("9999")).toBe("0.9999");
    expect(exactBasisPointsToRate("10000")).toBe("1");
  });

  it.each([
    ["numeric constraints", JSON.stringify({ market: "condition", asset_id: "token", tick_size: 0.01, min_order_size: 5 }), "{\"base_fee\":30}"],
    ["over-precision tick", book("token", "condition", "0.0000001"), "{\"base_fee\":30}"],
    ["string fee", book("token"), "{\"base_fee\":\"30\"}"],
    ["fractional fee", book("token"), "{\"base_fee\":30.5}"],
    ["extra fee fields", book("token"), "{\"base_fee\":30,\"other\":1}"],
    ["out of range fee", book("token"), "{\"base_fee\":10001}"],
    ["unsafe-sized fee integer", book("token"), "{\"base_fee\":9007199254740993123456789}"],
  ])("rejects malformed %s responses", async (_label, bookBody, feeBody) => {
    await expect(sourceFor("token", { bookBody, feeBody }).fetchTokenTerms(request("token"))).rejects.toThrow();
  });

  it("fails closed when the fee collection authority is absent or unsupported", async () => {
    const absent = new PublicClobTokenTermsSource({
      transport: transport({
        "/book?token_id=token": { body: book("token") },
        "/fee-rate?token_id=token": { body: "{\"base_fee\":30}" },
      }),
      nowMs: () => NOW,
    });
    await expect(absent.fetchTokenTerms(request("token"))).resolves.toBeNull();
    expect(absent.health({ tokenIds: ["token"], asOfMs: NOW, maximumFeeAgeMs: 1_000, maximumConstraintAgeMs: 1_000 }))
      .toMatchObject({ feeTermsHealthy: false, constraintTermsHealthy: true, lastFeeSnapshotAtMs: null });

    const unsupported = new PublicClobTokenTermsSource({
      transport: transport({
        "/book?token_id=token": { body: book("token") },
        "/fee-rate?token_id=token": { body: "{\"base_fee\":30}" },
      }),
      nowMs: () => NOW,
      feeCollectionContract: { version: "unsupported-v1", resolve: () => null },
    });
    await expect(unsupported.fetchTokenTerms(request("token"))).resolves.toBeNull();
  });

  it("rejects a token or condition mismatch without contaminating requested-token health", async () => {
    const source = sourceFor("up", { bookBody: book("down") });
    await expect(source.fetchTokenTerms(request("up"))).rejects.toThrow(/token mismatch/);
    expect(source.health({ tokenIds: ["up"], asOfMs: NOW, maximumFeeAgeMs: 1_000, maximumConstraintAgeMs: 1_000 }))
      .toMatchObject({ feeTermsHealthy: false, constraintTermsHealthy: false });

    const conditionMismatch = sourceFor("up", { bookBody: book("up", "other-condition") });
    await expect(conditionMismatch.fetchTokenTerms(request("up"))).rejects.toThrow(/condition mismatch/);
  });

  it("requires every current token and expires each successful token independently", async () => {
    let now = NOW;
    const dynamic = new PublicClobTokenTermsSource({
      transport: transport({
        "/book?token_id=up": { body: book("up") },
        "/fee-rate?token_id=up": { body: "{\"base_fee\":30}" },
        "/book?token_id=down": { body: book("down") },
        "/fee-rate?token_id=down": { body: "{\"base_fee\":30}" },
      }),
      nowMs: () => now,
      feeCollectionContract: POLYMARKET_CLOB_V2_USDC_TAKER_FEE_CONTRACT,
    });
    await dynamic.fetchTokenTerms(request("up", now));
    expect(dynamic.health({ tokenIds: ["up", "down"], asOfMs: now, maximumFeeAgeMs: 100, maximumConstraintAgeMs: 100 }))
      .toMatchObject({ requiredTokenCount: 2, feeTermsHealthy: false, constraintTermsHealthy: false });
    now += 50;
    await dynamic.fetchTokenTerms(request("down", now));
    expect(dynamic.health({ tokenIds: ["up", "down"], asOfMs: now, maximumFeeAgeMs: 100, maximumConstraintAgeMs: 100 }))
      .toMatchObject({ feeTermsHealthy: true, constraintTermsHealthy: true, lastFeeSnapshotAtMs: NOW });
    now += 51;
    expect(dynamic.health({ tokenIds: ["up", "down"], asOfMs: now, maximumFeeAgeMs: 100, maximumConstraintAgeMs: 100 }))
      .toMatchObject({ feeTermsHealthy: false, constraintTermsHealthy: false });
  });

  it("uses only an unauthenticated GET transport", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const publicTransport = new FetchPublicClobTermsTransport(fetchImpl as typeof fetch, "https://clob.example");
    await publicTransport.get("/book?token_id=t");
    expect(fetchImpl).toHaveBeenCalledWith("https://clob.example/book?token_id=t", {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
    });
  });
});
