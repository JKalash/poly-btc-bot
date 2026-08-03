import { describe, expect, it } from "vitest";
import { LiveClobAdapter, mapResponse } from "../src/live";
import type { OrderRequest } from "../src/execution";

/**
 * #18: placement responses are mapped by ALLOWLIST. Anything the code does not
 * positively recognize as an accepted exchange state must be a rejection —
 * an "unmatched" FOK read as an accepted LIVE order mints a phantom live
 * position that blocks all further trading (max_open_positions: 1).
 */
describe("mapResponse allowlist (#18)", () => {
  it("accepts matched/live/delayed with explicit success", () => {
    expect(mapResponse({ success: true, status: "matched", orderID: "a" }))
      .toMatchObject({ accepted: true, status: "MATCHED", externalId: "a" });
    expect(mapResponse({ success: true, status: "live", orderID: "b" }))
      .toMatchObject({ accepted: true, status: "LIVE" });
    expect(mapResponse({ success: true, status: "delayed", orderID: "c" }))
      .toMatchObject({ accepted: true, status: "DELAYED" });
  });

  it("rejects 'unmatched' (FOK/FAK killed without a fill) even with success: true", () => {
    const r = mapResponse({ success: true, status: "unmatched", orderID: "x" });
    expect(r.accepted).toBe(false);
    expect(r.status).toBe("REJECTED");
    expect(r.reason).toContain("unmatched");
  });

  it("rejects when the success field is missing — never assumed", () => {
    const r = mapResponse({ status: "live", orderID: "y" });
    expect(r.accepted).toBe(false);
    expect(r.status).toBe("REJECTED");
  });

  it("rejects unknown status strings and preserves them in the reason", () => {
    const r = mapResponse({ success: true, status: "quarantined", orderID: "z" });
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("quarantined");
  });

  it("rejects an entirely empty response", () => {
    const r = mapResponse({});
    expect(r.accepted).toBe(false);
    expect(r.status).toBe("REJECTED");
  });

  it("surfaces the exchange errorMsg on failure", () => {
    const r = mapResponse({ success: false, errorMsg: "not enough balance / allowance" });
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("balance");
  });
});

/**
 * #17: Polymarket's 60s GTD security threshold. An order meant to live until T
 * must be submitted with expiration = T + 60s or the exchange kills it a
 * minute early — which destroyed the entire 15-75s live maker resting window.
 */
describe("GTD expiration buffer (#17)", () => {
  const makerReq = (expireAtMs: number): OrderRequest => ({
    idempotencyKey: "k", decisionId: "d", marketId: "m", tokenId: "t",
    outcomeSide: "UP", orderSide: "BUY", style: "maker_post_only",
    timeInForce: "GTD", postOnly: true,
    price6: 550_000n, shares6: 10_000_000n, tickSize6: 10_000n, expireAtMs,
  });

  function stubbedAdapter(capture: (userOrder: Record<string, unknown>) => void): LiveClobAdapter {
    const a = new LiveClobAdapter({ privateKey: "0x" + "1".repeat(64) });
    // bypass init(): inject a fake signed client + module handles
    (a as unknown as { client: unknown }).client = {
      createAndPostOrder: (userOrder: Record<string, unknown>) => {
        capture(userOrder);
        return Promise.resolve({ success: true, status: "live", orderID: "ord-1" });
      },
    };
    (a as unknown as { mods: unknown }).mods = {
      OrderSide: { BUY: "BUY", SELL: "SELL" },
      OrderType: { GTD: "GTD", GTC: "GTC", FOK: "FOK", FAK: "FAK" },
    };
    return a;
  }

  it("adds the 60s security threshold to the requested expiration", async () => {
    let captured: Record<string, unknown> | null = null;
    const adapter = stubbedAdapter((o) => { captured = o; });
    const expireAtMs = Date.now() + 90_000;
    const res = await adapter.submit(makerReq(expireAtMs));
    expect(res.accepted).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.expiration).toBe(Math.floor(expireAtMs / 1000) + 60);
  });

  it("refuses a GTD whose intended expiry already passed, before touching the client", async () => {
    const adapter = stubbedAdapter(() => { throw new Error("client must not be called"); });
    const res = await adapter.submit(makerReq(Date.now() - 1000));
    expect(res.accepted).toBe(false);
    expect(res.status).toBe("REJECTED");
    expect(res.reason).toContain("not in the future");
  });
});
