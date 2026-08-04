import { describe, expect, it } from "vitest";
import { canonicalJson, decodeBigIntDecimal, decodeBigIntFields, encodeBigIntDecimal } from "../src/serialization";
import { canonicalObjectHash } from "../src/hashes";
import { effectIdempotencyKey, pairCaptureId, pairGroupId, pairLegId } from "../src/ids";

describe("exact pair serialization", () => {
  it("round-trips integers beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const unsafe = 90_071_992_547_409_931_234_567_890n;
    const encoded = encodeBigIntDecimal(unsafe);
    expect(encoded).toBe("90071992547409931234567890");
    expect(decodeBigIntDecimal(encoded)).toBe(unsafe);
    expect(decodeBigIntFields({ quantity6: encoded }, ["quantity6"])).toEqual({ quantity6: unsafe });
  });

  it.each(["", "01", "+1", "1.0", " 1", "1 ", "-0", "1e6", 1, null])("rejects malformed decimal %j", (value) => {
    expect(() => decodeBigIntDecimal(value)).toThrow(/canonical base-10/);
  });

  it("sorts keys recursively and represents bigints as decimal strings", () => {
    expect(canonicalJson({ z: 2n, a: { y: 3n, x: [1n, "ok"] } })).toBe('{"a":{"x":["1","ok"],"y":"3"},"z":"2"}');
    expect(() => canonicalJson({ bad: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integer/);
    expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/);
  });

  it("hashes and IDs are stable under key order but change with economics", () => {
    const a = { marketId: "m", shares6: 1_000_000n, legs: { up: 490_000n, down: 500_000n } };
    const reordered = { legs: { down: 500_000n, up: 490_000n }, shares6: 1_000_000n, marketId: "m" };
    expect(canonicalObjectHash(a)).toBe(canonicalObjectHash(reordered));
    expect(pairCaptureId(a)).toBe(pairCaptureId(reordered));
    expect(canonicalObjectHash(a)).not.toBe(canonicalObjectHash({ ...a, shares6: 1_000_001n }));

    const group = pairGroupId(a);
    const leg = pairLegId(group, "UP");
    const key = effectIdempotencyKey({ groupId: group, actionKind: "SUBMIT", actionSequence: 1n, effectOrdinal: 0, immutableRequestHash: canonicalObjectHash(a) });
    expect(key).toHaveLength(64);
    expect(key).not.toBe(effectIdempotencyKey({ groupId: group, actionKind: "SUBMIT", actionSequence: 1n, effectOrdinal: 0, immutableRequestHash: canonicalObjectHash({ ...a, shares6: 2n }) }));
    expect(leg).toMatch(/^pleg_[0-9a-f]{32}$/);
  });
});
