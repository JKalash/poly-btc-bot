import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256OfCanonicalJson, sha256OfFile } from "../src/checksum";
import { EVIDENCE_LABELS, isEvidenceLabel } from "../src/labels";

describe("canonicalJson", () => {
  it("is independent of key insertion order at every depth", () => {
    const a = { b: 1, a: { d: [1, 2], c: "x" } };
    const b = { a: { c: "x", d: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(sha256OfCanonicalJson(a)).toBe(sha256OfCanonicalJson(b));
  });

  it("serializes bigint as decimal string (matches jsonSafe convention)", () => {
    expect(canonicalJson({ v: 1_000_000n })).toBe('{"v":"1000000"}');
    expect(sha256OfCanonicalJson({ v: 1_000_000n })).toBe(sha256OfCanonicalJson({ v: "1000000" }));
  });

  it("drops undefined object properties but keeps null", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson([undefined, 1])).toBe("[null,1]");
  });

  it("preserves array order (arrays are semantically ordered)", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("rejects non-finite numbers rather than silently corrupting the checksum", () => {
    expect(() => canonicalJson({ v: NaN })).toThrow();
    expect(() => canonicalJson({ v: Infinity })).toThrow();
  });

  it("produces a stable, known digest for a fixture", () => {
    // Pin the canonical form so accidental serializer changes fail loudly.
    expect(canonicalJson({ z: 1, a: [true, "s"] })).toBe('{"a":[true,"s"],"z":1}');
  });
});

describe("sha256OfFile", () => {
  it("checksums file bytes and reports size", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "b5p-evidence-"));
    const p = path.join(dir, "fixture.csv");
    writeFileSync(p, "ts,price\n1,2\n");
    const r = await sha256OfFile(p);
    expect(r.bytes).toBe(13);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    const r2 = await sha256OfFile(p);
    expect(r2.sha256).toBe(r.sha256);
  });
});

describe("evidence labels", () => {
  it("contains the required lifecycle labels", () => {
    for (const l of [
      "SOURCE_CLAIM_UNVERIFIED", "OFFICIAL_CURRENT_AT_RETRIEVAL", "REPRODUCED_MATCH",
      "REPRODUCED_MISMATCH", "DATA_GATED", "INTERNAL_HYPOTHESIS", "LIVE_VALIDATED",
      "REJECTED_ANTI_PATTERN",
    ]) {
      expect(EVIDENCE_LABELS).toContain(l);
      expect(isEvidenceLabel(l)).toBe(true);
    }
    expect(isEvidenceLabel("TRUSTED")).toBe(false);
  });
});
