import { describe, expect, it } from "vitest";
import { mapResponse } from "../src/live";

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
