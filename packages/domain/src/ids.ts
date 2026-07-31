import { createHash, randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

/** Deterministic idempotency key from decision id + intent version. */
export function idempotencyKey(decisionId: string, intentVersion: number): string {
  return createHash("sha256").update(`${decisionId}:${intentVersion}`).digest("hex").slice(0, 32);
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
