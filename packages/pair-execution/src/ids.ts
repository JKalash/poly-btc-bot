import { sha256Hex } from "@b5p/domain/ids";
import type { PairCaptureId, PairEventId, PairGroupId, PairLegId, PairObservationId } from "./contracts";
import { canonicalJson } from "./serialization";

function deterministicId(prefix: string, input: unknown): string {
  return `${prefix}_${sha256Hex(canonicalJson(input)).slice(0, 32)}`;
}

export const pairCaptureId = (input: unknown): PairCaptureId => deterministicId("pcap", input) as PairCaptureId;
export const pairObservationId = (input: unknown): PairObservationId => deterministicId("pobs", input) as PairObservationId;
export const pairGroupId = (input: unknown): PairGroupId => deterministicId("pgrp", input) as PairGroupId;
export const pairLegId = (groupId: PairGroupId, outcome: "UP" | "DOWN"): PairLegId => deterministicId("pleg", { groupId, outcome }) as PairLegId;
export const pairEventId = (groupId: PairGroupId, sequence: bigint, kind: string): PairEventId => deterministicId("pevt", { groupId, kind, sequence }) as PairEventId;
export const pairClientOrderId = (legId: PairLegId, activation: number): string => deterministicId("pord", { activation, legId });

export function groupIdempotencyKey(input: {
  readonly strategyVersion: string; readonly marketId: string; readonly episodeId: string;
  readonly policyHash: string; readonly scheduledActivationBucket: number;
}): string {
  return sha256Hex(canonicalJson(input));
}

export function effectIdempotencyKey(input: {
  readonly groupId: PairGroupId; readonly actionKind: string; readonly actionSequence: bigint;
  readonly effectOrdinal: number; readonly immutableRequestHash: string;
}): string {
  return sha256Hex(canonicalJson(input));
}
