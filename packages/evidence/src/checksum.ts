import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

/**
 * Canonical JSON: deterministic serialization for checksumming.
 *  - object keys sorted lexicographically at every depth
 *  - bigint -> decimal string (mirrors the repo's jsonSafe convention)
 *  - undefined properties dropped; undefined in arrays -> null (JSON semantics)
 *  - no whitespace
 * Two semantically equal values always produce the same string, so the same
 * sha256 — regardless of key insertion order or bigint vs string typing drift.
 */
export function canonicalJson(v: unknown): string {
  return stringify(v);
}

function stringify(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "number":
      if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number ${v}`);
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "bigint":
      return JSON.stringify(v.toString());
    case "undefined":
      return "null";
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x) => stringify(x)).join(",")}]`;
      const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, val]) => val !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stringify(val)}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof v}`);
  }
}

export function sha256OfCanonicalJson(v: unknown): string {
  return createHash("sha256").update(canonicalJson(v)).digest("hex");
}

/** Streamed file checksum (Parquet/CSV datasets are too large for readFile). */
export async function sha256OfFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const { size } = await stat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path);
    s.on("data", (chunk) => hash.update(chunk));
    s.on("end", resolve);
    s.on("error", reject);
  });
  return { sha256: hash.digest("hex"), bytes: size };
}
