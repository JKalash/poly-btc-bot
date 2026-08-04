import { sha256Hex } from "@b5p/domain/ids";
import { canonicalJson } from "./serialization";

export function canonicalObjectHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export const pairCaptureHash = canonicalObjectHash;
export const pairPolicyHash = canonicalObjectHash;
export const pairPlanHash = canonicalObjectHash;
export const pairPortfolioHash = canonicalObjectHash;
export const immutableRequestHash = canonicalObjectHash;
