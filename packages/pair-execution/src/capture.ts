import { ONE, type BookLevel } from "@b5p/domain";
import { canonicalBookHash, isObserverEligibleIntegrity, isPaperEligibleIntegrity, type ImmutableBookView } from "@b5p/strategy";
import type { ImmutablePairBookLeg, PairBookCapture, PairOutcome, PairRejection, PairRunMode } from "./contracts";
import { pairCaptureHash } from "./hashes";
import { pairCaptureId } from "./ids";

export interface PairCapturePolicy {
  readonly maximumBookAgeMs: number;
  readonly maximumSourceSkewMs: number;
  readonly maximumReceiveSkewMs: number;
  readonly maximumFutureTimestampMs: number;
}

export interface BuildPairCaptureInput {
  readonly marketId: string;
  readonly conditionId: string;
  readonly expectedUpTokenId: string;
  readonly expectedDownTokenId: string;
  readonly capturedAtMs: number;
  readonly captureSequence: bigint;
  readonly mode: PairRunMode;
  readonly policy: PairCapturePolicy;
  readonly up: ImmutableBookView | null;
  readonly down: ImmutableBookView | null;
}

export type PairCaptureResult =
  | { readonly kind: "ACCEPTED"; readonly capture: PairBookCapture }
  | { readonly kind: "REJECTED"; readonly reasons: readonly PairRejection[] };

const reason = (code: PairRejection["code"], description: string): PairRejection => Object.freeze({ code, description });

function validateLevels(levels: readonly Readonly<BookLevel>[], direction: "ASC" | "DESC", label: string): PairRejection[] {
  const reasons: PairRejection[] = [];
  let previous: bigint | null = null;
  for (const level of levels) {
    if (typeof level.price !== "bigint" || typeof level.size !== "bigint" || level.price <= 0n || level.price > ONE || level.size <= 0n) {
      reasons.push(reason("BOOK_CONTINUITY_UNVERIFIED", `${label} contains a malformed level`));
      break;
    }
    if (previous !== null && (direction === "ASC" ? level.price <= previous : level.price >= previous)) {
      reasons.push(reason("BOOK_CONTINUITY_UNVERIFIED", `${label} levels are not strictly ${direction === "ASC" ? "ascending" : "descending"}`));
      break;
    }
    previous = level.price;
  }
  return reasons;
}

function validateTime(view: ImmutableBookView, nowMs: number, policy: PairCapturePolicy): PairRejection[] {
  const reasons: PairRejection[] = [];
  if (!Number.isSafeInteger(view.sourceTsMs) || view.sourceTsMs <= 0) {
    reasons.push(reason("BOOK_SOURCE_TIMESTAMP_MISSING", `${view.tokenId} has no authentic source timestamp`));
  } else {
    const sourceAge = nowMs - view.sourceTsMs;
    if (sourceAge < -policy.maximumFutureTimestampMs) reasons.push(reason("BOOK_SOURCE_TIMESTAMP_TOO_FAR_FUTURE", `${view.tokenId} source timestamp is too far in the future`));
    if (sourceAge > policy.maximumBookAgeMs) reasons.push(reason("BOOK_SOURCE_STALE", `${view.tokenId} source timestamp is stale`));
  }
  if (!Number.isSafeInteger(view.receivedTsMs) || view.receivedTsMs <= 0) {
    reasons.push(reason("BOOK_RECEIVE_STALE", `${view.tokenId} has no valid local receive timestamp`));
  } else {
    const receiveAge = nowMs - view.receivedTsMs;
    if (receiveAge < -policy.maximumFutureTimestampMs) reasons.push(reason("BOOK_RECEIVE_TIMESTAMP_TOO_FAR_FUTURE", `${view.tokenId} receive timestamp is too far in the future`));
    if (receiveAge > policy.maximumBookAgeMs) reasons.push(reason("BOOK_RECEIVE_STALE", `${view.tokenId} receive timestamp is stale`));
  }
  return reasons;
}

function immutableLeg(view: ImmutableBookView, outcome: PairOutcome): ImmutablePairBookLeg {
  const bids = Object.freeze(view.bids.map((level) => Object.freeze({ price6: level.price, shares6: level.size })));
  const asks = Object.freeze(view.asks.map((level) => Object.freeze({ price6: level.price, shares6: level.size })));
  return Object.freeze({
    outcome,
    tokenId: view.tokenId,
    bookVersion: view.bookVersion,
    connectionEpoch: view.connectionEpoch,
    sourceTsMs: view.sourceTsMs,
    receivedTsMs: view.receivedTsMs,
    exchangeHash: view.exchangeHash,
    sourceEventId: view.sourceEventId,
    integrity: view.integrity as ImmutablePairBookLeg["integrity"],
    bids,
    asks,
  });
}

/** Build an immutable paired capture or a stable ordinary-invalidity union. */
export function buildPairCapture(input: BuildPairCaptureInput): PairCaptureResult {
  const reasons: PairRejection[] = [];
  if (input.up === null) reasons.push(reason("UP_BOOK_MISSING", "UP book is missing"));
  if (input.down === null) reasons.push(reason("DOWN_BOOK_MISSING", "DOWN book is missing"));
  if (input.up === null || input.down === null) return Object.freeze({ kind: "REJECTED", reasons: Object.freeze(reasons) });
  const { up, down } = input;

  if (up.tokenId !== input.expectedUpTokenId || down.tokenId !== input.expectedDownTokenId || up.marketId !== input.marketId || down.marketId !== input.marketId) {
    reasons.push(reason("BOOK_CONTINUITY_UNVERIFIED", "book token or market identity does not match current metadata"));
  }
  for (const view of [up, down]) {
    if (view.connectionEpoch === "" || view.integrity === "INVALID_AFTER_RECONNECT") {
      reasons.push(reason("BOOK_INVALID_AFTER_RECONNECT", `${view.tokenId} lacks a current-epoch snapshot`));
    } else if (view.integrity === "GAP_SUSPECTED") {
      reasons.push(reason("BOOK_GAP_SUSPECTED", `${view.tokenId} continuity has a suspected gap`));
    } else if (!isObserverEligibleIntegrity(view.integrity)) {
      reasons.push(reason("BOOK_CONTINUITY_UNVERIFIED", `${view.tokenId} integrity is not observer eligible`));
    } else if (input.mode === "paper" && !isPaperEligibleIntegrity(view.integrity)) {
      reasons.push(reason("BOOK_CONTINUITY_UNVERIFIED", `${view.tokenId} unsequenced continuity is observer-only`));
    }
    if (view.asks.length === 0) reasons.push(reason("BOOK_EMPTY_ASKS", `${view.tokenId} has no direct-buy ask`));
    reasons.push(...validateLevels(view.bids, "DESC", `${view.tokenId} bids`));
    reasons.push(...validateLevels(view.asks, "ASC", `${view.tokenId} asks`));
    reasons.push(...validateTime(view, input.capturedAtMs, input.policy));
  }
  if (up.connectionEpoch !== down.connectionEpoch) reasons.push(reason("BOOK_INVALID_AFTER_RECONNECT", "UP and DOWN books are from different connection epochs"));
  const sourceSkewMs = Math.abs(up.sourceTsMs - down.sourceTsMs);
  const receiveSkewMs = Math.abs(up.receivedTsMs - down.receivedTsMs);
  if (sourceSkewMs > input.policy.maximumSourceSkewMs) reasons.push(reason("BOOK_SOURCE_SKEW", "UP/DOWN source timestamp skew exceeds policy"));
  if (receiveSkewMs > input.policy.maximumReceiveSkewMs) reasons.push(reason("BOOK_RECEIVE_SKEW", "UP/DOWN receive timestamp skew exceeds policy"));

  if (reasons.length > 0) return Object.freeze({ kind: "REJECTED", reasons: Object.freeze(reasons) });

  const upLeg = immutableLeg(up, "UP");
  const downLeg = immutableLeg(down, "DOWN");
  const hashInput = {
    marketId: input.marketId,
    conditionId: input.conditionId,
    capturedAtMs: input.capturedAtMs,
    captureSequence: input.captureSequence,
    up: { ...upLeg, contentHash: canonicalBookHash(up) },
    down: { ...downLeg, contentHash: canonicalBookHash(down) },
    sourceSkewMs,
    receiveSkewMs,
  };
  const captureHash = pairCaptureHash(hashInput);
  return Object.freeze({
    kind: "ACCEPTED",
    capture: Object.freeze({
      captureId: pairCaptureId({ captureHash }),
      marketId: input.marketId,
      conditionId: input.conditionId,
      capturedAtMs: input.capturedAtMs,
      captureSequence: input.captureSequence,
      up: upLeg,
      down: downLeg,
      sourceSkewMs,
      receiveSkewMs,
      captureHash,
    }),
  });
}
