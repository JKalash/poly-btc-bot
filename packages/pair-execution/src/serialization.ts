/** Exact JSON codecs used at pair persistence and API boundaries. */

const CANONICAL_INTEGER = /^(?:0|-[1-9]\d*|[1-9]\d*)$/;

export type JsonScalar = null | boolean | number | string;
export type CanonicalJsonValue = JsonScalar | readonly CanonicalJsonValue[] | { readonly [key: string]: CanonicalJsonValue };

export function encodeBigIntDecimal(value: bigint): string {
  return value.toString(10);
}

export function decodeBigIntDecimal(value: unknown, label = "bigint"): bigint {
  if (typeof value !== "string" || !CANONICAL_INTEGER.test(value) || value === "-0") {
    throw new TypeError(`${label} must be a canonical base-10 integer string`);
  }
  return BigInt(value);
}

/**
 * Convert an object into its canonical JSON-safe form. Keys are sorted,
 * bigint values become decimal strings, and ambiguous/lossy values reject.
 */
export function canonicalJsonValue(value: unknown, path = "$"): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return encodeBigIntDecimal(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${path} number must be a safe integer`);
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, index) => canonicalJsonValue(item, `${path}[${index}]`)));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must be a plain object`);
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) throw new TypeError(`${path}.${key} must not be undefined`);
      out[key] = canonicalJsonValue(item, `${path}.${key}`);
    }
    return Object.freeze(out);
  }
  throw new TypeError(`${path} contains unsupported ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

/** Decode selected object fields from persisted decimal strings, fail-closed. */
export function decodeBigIntFields<const K extends string>(
  value: Readonly<Record<string, unknown>>,
  fields: readonly K[],
): Record<K, bigint> {
  const out = {} as Record<K, bigint>;
  for (const field of fields) out[field] = decodeBigIntDecimal(value[field], field);
  return out;
}
