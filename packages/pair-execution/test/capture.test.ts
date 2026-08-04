import { describe, expect, it } from "vitest";
import { BookState, type ImmutableBookView } from "@b5p/strategy";
import { buildPairCapture } from "../src/capture";

const now = 1_800_000_000_000;
const policy = { maximumBookAgeMs: 500, maximumSourceSkewMs: 100, maximumReceiveSkewMs: 100, maximumFutureTimestampMs: 250 };

function view(tokenId: string, sourceTsMs = now, receivedTsMs = now): ImmutableBookView {
  const book = new BookState(tokenId, "market");
  book.applySnapshot([{ price: "0.49", size: "2" }], [{ price: "0.50", size: "3" }], sourceTsMs, receivedTsMs, {
    connectionEpoch: "epoch", sourceEventId: `snap-${tokenId}`, exchangeHash: `hash-${tokenId}`, marketId: "market",
  });
  return book.snapshot();
}

function capture(up: ImmutableBookView | null, down: ImmutableBookView | null, mode: "observe" | "paper" = "observe") {
  return buildPairCapture({ marketId: "market", conditionId: "condition", expectedUpTokenId: "up", expectedDownTokenId: "down", capturedAtMs: now, captureSequence: 1n, mode, policy, up, down });
}

describe("paired book capture validation", () => {
  it("accepts current same-epoch immutable books and is detached from later mutation", () => {
    const upBook = new BookState("up", "market");
    upBook.applySnapshot([], [{ price: "0.49", size: "1" }], now, now, { connectionEpoch: "epoch", marketId: "market" });
    const up = upBook.snapshot();
    const result = capture(up, view("down"));
    expect(result.kind).toBe("ACCEPTED");
    if (result.kind !== "ACCEPTED") return;
    const hash = result.capture.captureHash;
    upBook.applyLevelUpdate("0.49", "9", "SELL", now + 1, now + 1);
    expect(result.capture.up.asks[0]!.shares6).toBe(1_000_000n);
    expect(result.capture.captureHash).toBe(hash);
    expect(Object.isFrozen(result.capture.up.asks)).toBe(true);
  });

  it("rejects missing books and current-epoch asymmetry", () => {
    expect(capture(null, null)).toMatchObject({ kind: "REJECTED", reasons: [{ code: "UP_BOOK_MISSING" }, { code: "DOWN_BOOK_MISSING" }] });
    const stale = { ...view("down"), connectionEpoch: "old" };
    const result = capture(view("up"), stale);
    expect(result.kind).toBe("REJECTED");
    if (result.kind === "REJECTED") expect(result.reasons.map((r) => r.code)).toContain("BOOK_INVALID_AFTER_RECONNECT");
  });

  it("allows unsequenced books for observe but rejects them for paper", () => {
    const book = new BookState("up", "market");
    book.applySnapshot([], [{ price: "0.49", size: "1" }], now, now, { connectionEpoch: "epoch", marketId: "market" });
    book.applyEnvelope([{ price: "0.49", size: "2", side: "SELL" }], now, now, { connectionEpoch: "epoch" });
    expect(capture(book.snapshot(), view("down"), "observe").kind).toBe("ACCEPTED");
    const paper = capture(book.snapshot(), view("down"), "paper");
    expect(paper.kind).toBe("REJECTED");
    if (paper.kind === "REJECTED") expect(paper.reasons.map((r) => r.code)).toContain("BOOK_CONTINUITY_UNVERIFIED");
  });

  it("uses inclusive source/receive age, future, and skew bounds", () => {
    expect(capture(view("up", now - 500, now - 500), view("down", now - 400, now - 400)).kind).toBe("ACCEPTED");
    expect(capture(view("up", now + 250, now + 250), view("down", now + 150, now + 150)).kind).toBe("ACCEPTED");
    for (const [up, down, code] of [
      [view("up", now - 501), view("down", now - 500), "BOOK_SOURCE_STALE"],
      [view("up", now, now - 501), view("down", now, now - 500), "BOOK_RECEIVE_STALE"],
      [view("up", now + 251), view("down", now + 250), "BOOK_SOURCE_TIMESTAMP_TOO_FAR_FUTURE"],
      [view("up", now, now + 251), view("down", now, now + 250), "BOOK_RECEIVE_TIMESTAMP_TOO_FAR_FUTURE"],
      [view("up", now), view("down", now - 101), "BOOK_SOURCE_SKEW"],
      [view("up", now, now), view("down", now, now - 101), "BOOK_RECEIVE_SKEW"],
    ] as const) {
      const result = capture(up, down);
      expect(result.kind).toBe("REJECTED");
      if (result.kind === "REJECTED") expect(result.reasons.map((r) => r.code)).toContain(code);
    }
  });

  it("rejects missing source timestamp and empty direct-buy asks", () => {
    const missingTs = { ...view("up"), sourceTsMs: 0 };
    const emptyAsks = { ...view("down"), asks: [] };
    const result = capture(missingTs, emptyAsks);
    expect(result.kind).toBe("REJECTED");
    if (result.kind === "REJECTED") {
      expect(result.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["BOOK_SOURCE_TIMESTAMP_MISSING", "BOOK_EMPTY_ASKS"]));
    }
  });

  it("is canonical across repeated construction", () => {
    const first = capture(view("up"), view("down"));
    const second = capture(view("up"), view("down"));
    expect(first).toEqual(second);
  });
});
