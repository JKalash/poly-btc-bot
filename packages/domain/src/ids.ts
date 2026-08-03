import { createHash, randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

/**
 * Deterministic idempotency key from stable intent content + intent version.
 * The seed must describe WHAT is being submitted (market, side, style, price)
 * — never a per-call random id, which would mint a fresh key on every retry
 * and make duplicate detection structurally impossible.
 */
export function idempotencyKey(seed: string, intentVersion: number): string {
  return createHash("sha256").update(`${seed}:${intentVersion}`).digest("hex").slice(0, 32);
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
