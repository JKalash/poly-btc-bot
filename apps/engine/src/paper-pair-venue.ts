/**
 * Dedicated prospective pair-paper venue (BPAIR-070).
 *
 * This module deliberately has no relationship to the directional
 * `PaperExecutor` or any authenticated execution adapter.  It consumes an
 * immutable pair capture, performs exact direct-book matching through the
 * pure pair quote functions, and commits the complete result to the durable
 * paper-operation store before returning it.
 */
import { schema, type DbHandle } from "@b5p/db";
import {
  canonicalJsonValue,
  canonicalObjectHash,
  immutableRequestHash,
  pairCaptureId,
  pairCaptureHash,
  quoteDirectBuy,
  quoteDirectSell,
  type DirectLegQuote,
  type PairBookCapture,
  type PairBookReference,
  type PairOutcome,
  type QuoteFeeSnapshot,
} from "@b5p/pair-execution";
import { canonicalBookHash, type ImmutableBookView } from "@b5p/strategy";
import { and, eq, or } from "drizzle-orm";

export type PaperPairOperationKind = "INITIAL_FOK" | "RECOVERY_BUY_FOK" | "RECOVERY_SELL_FAK";
export type PaperPairOperationState = "FILLED" | "NO_FILL" | "TERMINAL_REJECTED" | "PARTIAL_CANCELED" | "OUTCOME_UNKNOWN";

export interface PaperPairLegRequest {
  readonly outcome: PairOutcome;
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly timeInForce: "FOK" | "FAK";
  readonly amountSemantics: "SHARES";
  readonly grossShares6: bigint;
  readonly limitPrice6: bigint;
  /** BUY debit cap. Required for both initial and recovery BUY requests. */
  readonly maximumCashDebit6?: bigint;
  /** Exact inventory proof. Required for recovery SELL requests. */
  readonly availableShares6?: bigint;
  readonly minimumOrderShares6: bigint;
  readonly shareLot6: bigint;
  readonly fee: QuoteFeeSnapshot;
  readonly bookRef: PairBookReference;
}

export interface PaperPairVenueRequest {
  readonly effectId: string;
  /** Durable venue identity; persisted in pair_paper_venue_operations.client_order_id. */
  readonly clientOperationId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly operationKind: PaperPairOperationKind;
  readonly capture: PairBookCapture;
  readonly leg: PaperPairLegRequest;
}

export type PaperPairResult =
  | { readonly kind: "FILLED"; readonly quote: DirectLegQuote }
  | { readonly kind: "NO_FILL"; readonly code: "NO_FILL_INSUFFICIENT_DEPTH" | "NO_FILL_LIMIT" | "NO_FILL_CASH_CAP" }
  | { readonly kind: "REJECTED"; readonly code: "REJECTED_CONSTRAINT" | "REJECTED_STALE_EVIDENCE" | "REJECTED_SCRIPTED"; readonly detail: string }
  | { readonly kind: "PARTIAL_CANCELED"; readonly quote: DirectLegQuote }
  | { readonly kind: "UNKNOWN"; readonly reason: "UNKNOWN_SIMULATED_TIMEOUT" };

export interface PaperPairEffectEvidence {
  readonly evidenceId: string;
  readonly effectId: string;
  readonly clientOperationId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly captureId: string;
  readonly operationKind: PaperPairOperationKind;
  readonly state: PaperPairOperationState;
  readonly result: PaperPairResult;
  readonly resultHash: string;
  readonly computedAtMs: number;
}

export interface StoredPaperPairOperation {
  readonly id: string;
  readonly effectId: string;
  readonly clientOperationId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly captureId: string;
  readonly operationKind: PaperPairOperationKind;
  readonly state: PaperPairOperationState;
  readonly requestPayload: unknown;
  readonly resultPayload: unknown;
  readonly resultHash: string;
  readonly computedAtMs: number;
  readonly createdAtMs: number;
}

export interface PaperPairOperationStore {
  commit(operation: StoredPaperPairOperation): Promise<StoredPaperPairOperation>;
  findByClientOperationId(clientOperationId: string): Promise<StoredPaperPairOperation | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<StoredPaperPairOperation | null>;
}

export interface PaperPairVenuePort {
  submitInitialFok(request: PaperPairVenueRequest): Promise<PaperPairEffectEvidence>;
  submitRecovery(request: PaperPairVenueRequest): Promise<PaperPairEffectEvidence>;
  observe(request: string | { readonly clientOperationId: string }): Promise<PaperPairEffectEvidence | null>;
}

export class PaperPairVenueError extends Error {}
export class PaperPairVenueRequestError extends PaperPairVenueError {}
export class PaperPairVenueMalformedResultError extends PaperPairVenueError {}
export class PaperPairVenueIdempotencyCollisionError extends PaperPairVenueError {
  readonly code = "IDEMPOTENCY_HASH_COLLISION" as const;
}

export type ScriptedPaperPairDecision =
  | { readonly kind: "USE_BOOK" }
  | { readonly kind: "REJECT"; readonly code?: string; readonly detail?: string }
  | { readonly kind: "TIMEOUT" };

export type PaperPairVenueScript = (request: Readonly<PaperPairVenueRequest>) => unknown;

const USE_BOOK: ScriptedPaperPairDecision = Object.freeze({ kind: "USE_BOOK" });

function requestPayload(request: PaperPairVenueRequest): unknown {
  const { requestHash: _requestHash, ...payload } = request;
  return canonicalJsonValue({ schemaVersion: 1, ...payload });
}

/** Hash only immutable economic/capture identity, never process-local time. */
export function paperPairVenueRequestHash(request: Omit<PaperPairVenueRequest, "requestHash">): string {
  return immutableRequestHash({ schemaVersion: 1, ...request });
}

/** Canonical reference accepted by this venue for one leg of a pair capture. */
export function paperPairBookReference(capture: PairBookCapture, outcome: PairOutcome): PairBookReference {
  const leg = outcome === "UP" ? capture.up : capture.down;
  return Object.freeze({
    tokenId: leg.tokenId,
    bookVersion: leg.bookVersion,
    connectionEpoch: leg.connectionEpoch,
    sourceEventId: leg.sourceEventId,
    contentHash: captureLegContentHash(capture, outcome),
  });
}

function captureLegView(capture: PairBookCapture, outcome: PairOutcome): ImmutableBookView {
  const leg = outcome === "UP" ? capture.up : capture.down;
  return {
    tokenId: leg.tokenId, marketId: capture.marketId, bookVersion: leg.bookVersion,
    connectionEpoch: leg.connectionEpoch, sourceTsMs: leg.sourceTsMs, receivedTsMs: leg.receivedTsMs,
    exchangeHash: leg.exchangeHash, sourceEventId: leg.sourceEventId, integrity: leg.integrity,
    bids: leg.bids.map((level) => ({ price: level.price6, size: level.shares6 })),
    asks: leg.asks.map((level) => ({ price: level.price6, size: level.shares6 })),
  };
}

function captureLegContentHash(capture: PairBookCapture, outcome: PairOutcome): string {
  return canonicalBookHash(captureLegView(capture, outcome));
}

function recomputeCaptureHash(capture: PairBookCapture): string {
  return pairCaptureHash({
    marketId: capture.marketId, conditionId: capture.conditionId, capturedAtMs: capture.capturedAtMs,
    captureSequence: capture.captureSequence,
    up: { ...capture.up, contentHash: captureLegContentHash(capture, "UP") },
    down: { ...capture.down, contentHash: captureLegContentHash(capture, "DOWN") },
    sourceSkewMs: capture.sourceSkewMs, receiveSkewMs: capture.receiveSkewMs,
  });
}

function stableEvidenceId(input: Pick<PaperPairVenueRequest, "clientOperationId" | "idempotencyKey" | "requestHash">): string {
  return `ppvo_${canonicalObjectHash(input).slice(0, 32)}`;
}

function operationState(result: PaperPairResult): PaperPairOperationState {
  switch (result.kind) {
    case "FILLED": return "FILLED";
    case "NO_FILL": return "NO_FILL";
    case "REJECTED": return "TERMINAL_REJECTED";
    case "PARTIAL_CANCELED": return "PARTIAL_CANCELED";
    case "UNKNOWN": return "OUTCOME_UNKNOWN";
  }
}

function assertIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) throw new PaperPairVenueRequestError(`${label} must be non-empty`);
}

function rejectConstraint(detail: string): PaperPairResult {
  return Object.freeze({ kind: "REJECTED", code: "REJECTED_CONSTRAINT", detail });
}

function validateRequest(request: PaperPairVenueRequest): PaperPairResult | null {
  assertIdentity(request.effectId, "effectId");
  assertIdentity(request.clientOperationId, "clientOperationId");
  assertIdentity(request.idempotencyKey, "idempotencyKey");
  assertIdentity(request.requestHash, "requestHash");
  const calculatedHash = paperPairVenueRequestHash({
    effectId: request.effectId,
    clientOperationId: request.clientOperationId,
    idempotencyKey: request.idempotencyKey,
    operationKind: request.operationKind,
    capture: request.capture,
    leg: request.leg,
  });
  if (calculatedHash !== request.requestHash) {
    throw new PaperPairVenueRequestError(`requestHash does not match immutable request (${calculatedHash})`);
  }

  const capture = request.capture;
  if (capture.captureHash !== recomputeCaptureHash(capture) || capture.captureId !== pairCaptureId({ captureHash: capture.captureHash })) {
    return Object.freeze({ kind: "REJECTED", code: "REJECTED_STALE_EVIDENCE", detail: "capture id/hash identity mismatch" });
  }
  const capturedLeg = request.leg.outcome === "UP" ? capture.up : capture.down;
  const expectedRef = paperPairBookReference(capture, request.leg.outcome);
  if (
    capturedLeg.outcome !== request.leg.outcome || capturedLeg.tokenId !== request.leg.tokenId ||
    request.leg.bookRef.tokenId !== expectedRef.tokenId || request.leg.bookRef.bookVersion !== expectedRef.bookVersion ||
    request.leg.bookRef.connectionEpoch !== expectedRef.connectionEpoch || request.leg.bookRef.sourceEventId !== expectedRef.sourceEventId ||
    request.leg.bookRef.contentHash !== expectedRef.contentHash
  ) {
    return Object.freeze({ kind: "REJECTED", code: "REJECTED_STALE_EVIDENCE", detail: "leg book reference does not match immutable capture" });
  }

  const l = request.leg;
  if (l.amountSemantics !== "SHARES") return rejectConstraint("amount semantics must be SHARES");
  if (typeof l.grossShares6 !== "bigint" || l.grossShares6 <= 0n) return rejectConstraint("gross shares must be positive");
  if (typeof l.shareLot6 !== "bigint" || l.shareLot6 <= 0n || l.grossShares6 % l.shareLot6 !== 0n) return rejectConstraint("gross shares must be an exact positive share lot multiple");
  if (typeof l.minimumOrderShares6 !== "bigint" || l.minimumOrderShares6 <= 0n || l.grossShares6 < l.minimumOrderShares6) return rejectConstraint("minimum order shares not met");
  if (l.fee === null || typeof l.fee !== "object") return rejectConstraint("fee snapshot is required");

  if (request.operationKind === "INITIAL_FOK" || request.operationKind === "RECOVERY_BUY_FOK") {
    if (l.side !== "BUY" || l.timeInForce !== "FOK") return rejectConstraint("FOK buy operation requires BUY/FOK");
    if (typeof l.maximumCashDebit6 !== "bigint" || l.maximumCashDebit6 < 0n) return rejectConstraint("FOK buy requires a non-negative maximum cash debit");
  } else if (request.operationKind === "RECOVERY_SELL_FAK") {
    if (l.side !== "SELL" || l.timeInForce !== "FAK") return rejectConstraint("recovery sell operation requires SELL/FAK");
    if (typeof l.availableShares6 !== "bigint" || l.availableShares6 < l.grossShares6) return rejectConstraint("recovery sell requires sufficient proven inventory");
  } else {
    return rejectConstraint("unsupported operation kind");
  }
  return null;
}

function noFillCode(request: PaperPairVenueRequest): Extract<PaperPairResult, { kind: "NO_FILL" }>["code"] {
  const leg = request.leg;
  const captured = leg.outcome === "UP" ? request.capture.up : request.capture.down;
  const levels = leg.side === "BUY" ? captured.asks : captured.bids;
  let withinLimit = 0n;
  for (const level of levels) {
    if (leg.side === "BUY" ? level.price6 > leg.limitPrice6 : level.price6 < leg.limitPrice6) break;
    withinLimit += level.shares6;
  }
  if (withinLimit < leg.grossShares6) {
    const allDepth = levels.reduce((sum, level) => sum + level.shares6, 0n);
    return allDepth >= leg.grossShares6 ? "NO_FILL_LIMIT" : "NO_FILL_INSUFFICIENT_DEPTH";
  }
  return "NO_FILL_CASH_CAP";
}

function computeBookResult(request: PaperPairVenueRequest): PaperPairResult {
  const l = request.leg;
  const captured = l.outcome === "UP" ? request.capture.up : request.capture.down;
  const result = l.side === "BUY"
    ? quoteDirectBuy({
        levels: captured.asks.map((x) => ({ price: x.price6, size: x.shares6 })),
        requestedShares6: l.grossShares6,
        limitPrice6: l.limitPrice6,
        cashCap6: l.maximumCashDebit6,
        fee: l.fee,
        timeInForce: l.timeInForce,
        bookRef: l.bookRef,
      })
    : quoteDirectSell({
        levels: captured.bids.map((x) => ({ price: x.price6, size: x.shares6 })),
        requestedShares6: l.grossShares6,
        availableShares6: l.availableShares6!,
        limitPrice6: l.limitPrice6,
        fee: l.fee,
        timeInForce: l.timeInForce,
        bookRef: l.bookRef,
      });
  if (!result.ok) return rejectConstraint(`${result.reason}: ${result.detail}`);
  const q = result.quote;
  if (q.filledGrossShares6 === l.grossShares6) return Object.freeze({ kind: "FILLED", quote: q });
  if (q.filledGrossShares6 === 0n) return Object.freeze({ kind: "NO_FILL", code: noFillCode(request) });
  if (l.timeInForce !== "FAK") throw new PaperPairVenueMalformedResultError("FOK matcher returned a partial fill");
  return Object.freeze({ kind: "PARTIAL_CANCELED", quote: q });
}

function scriptedResult(request: PaperPairVenueRequest, value: unknown): PaperPairResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperPairVenueMalformedResultError("paper script must return a decision object");
  }
  const decision = value as Record<string, unknown>;
  if (decision.kind === "USE_BOOK" && Object.keys(decision).length === 1) return computeBookResult(request);
  if (decision.kind === "TIMEOUT" && Object.keys(decision).length === 1) {
    return Object.freeze({ kind: "UNKNOWN", reason: "UNKNOWN_SIMULATED_TIMEOUT" });
  }
  if (decision.kind === "REJECT") {
    if (decision.code !== undefined && typeof decision.code !== "string") throw new PaperPairVenueMalformedResultError("scripted reject code must be a string");
    if (decision.detail !== undefined && typeof decision.detail !== "string") throw new PaperPairVenueMalformedResultError("scripted reject detail must be a string");
    return Object.freeze({ kind: "REJECTED", code: "REJECTED_SCRIPTED", detail: decision.detail ?? decision.code ?? "scripted rejection" });
  }
  throw new PaperPairVenueMalformedResultError(`unsupported scripted paper result kind ${String(decision.kind)}`);
}

function assertStoredBinding(existing: StoredPaperPairOperation, candidate: StoredPaperPairOperation): void {
  if (
    existing.clientOperationId !== candidate.clientOperationId || existing.idempotencyKey !== candidate.idempotencyKey ||
    existing.requestHash !== candidate.requestHash || existing.effectId !== candidate.effectId ||
    existing.captureId !== candidate.captureId || existing.operationKind !== candidate.operationKind
  ) {
    throw new PaperPairVenueIdempotencyCollisionError("client operation/idempotency key is already bound to a different immutable request");
  }
}

function evidenceFromStored(row: StoredPaperPairOperation): PaperPairEffectEvidence {
  const result = decodeResult(row.resultPayload);
  const actualHash = canonicalObjectHash(result);
  if (actualHash !== row.resultHash || operationState(result) !== row.state) {
    throw new PaperPairVenueMalformedResultError("stored paper result failed hash/state validation");
  }
  return Object.freeze({
    evidenceId: row.id, effectId: row.effectId, clientOperationId: row.clientOperationId,
    idempotencyKey: row.idempotencyKey, requestHash: row.requestHash, captureId: row.captureId,
    operationKind: row.operationKind, state: row.state, result, resultHash: row.resultHash,
    computedAtMs: row.computedAtMs,
  });
}

function bigintField(record: Record<string, unknown>, field: string): bigint {
  const value = record[field];
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) throw new PaperPairVenueMalformedResultError(`stored ${field} is not a canonical non-negative integer`);
  return BigInt(value);
}

function decodeQuote(value: unknown): DirectLegQuote {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PaperPairVenueMalformedResultError("stored quote is malformed");
  const q = value as Record<string, unknown>;
  if (!Array.isArray(q.levels) || q.bookRef === null || typeof q.bookRef !== "object") throw new PaperPairVenueMalformedResultError("stored quote evidence is incomplete");
  const levels = q.levels.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new PaperPairVenueMalformedResultError("stored level is malformed");
    const l = item as Record<string, unknown>;
    return Object.freeze({ price6: bigintField(l, "price6"), grossShares6: bigintField(l, "grossShares6"), cashPrincipal6: bigintField(l, "cashPrincipal6"), feeCash6: bigintField(l, "feeCash6"), feeShares6: bigintField(l, "feeShares6"), netShares6: bigintField(l, "netShares6") });
  });
  const nullableBigint = (field: string): bigint | null => q[field] === null ? null : bigintField(q, field);
  const b = q.bookRef as Record<string, unknown>;
  if (typeof b.tokenId !== "string" || typeof b.bookVersion !== "string" || typeof b.connectionEpoch !== "string" || typeof b.sourceEventId !== "string" || typeof b.contentHash !== "string") throw new PaperPairVenueMalformedResultError("stored book reference is malformed");
  return Object.freeze({
    side: q.side as "BUY" | "SELL",
    requestedGrossShares6: bigintField(q, "requestedGrossShares6"), filledGrossShares6: bigintField(q, "filledGrossShares6"),
    receivedNetShares6: bigintField(q, "receivedNetShares6"), unfilledGrossShares6: bigintField(q, "unfilledGrossShares6"),
    levels: Object.freeze(levels), principal6: bigintField(q, "principal6"), feeCash6: bigintField(q, "feeCash6"), feeShares6: bigintField(q, "feeShares6"),
    topOfBookPrice6: nullableBigint("topOfBookPrice6"), worstPrice6: nullableBigint("worstPrice6"), averagePrice6: nullableBigint("averagePrice6"),
    impactFromTop6: nullableBigint("impactFromTop6"), fullyExecutable: q.fullyExecutable === true,
    bookRef: Object.freeze({ tokenId: b.tokenId, bookVersion: BigInt(b.bookVersion), connectionEpoch: b.connectionEpoch, sourceEventId: b.sourceEventId, contentHash: b.contentHash }),
  });
}

function decodeResult(value: unknown): PaperPairResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PaperPairVenueMalformedResultError("stored result is malformed");
  const r = value as Record<string, unknown>;
  if (r.kind === "FILLED") return Object.freeze({ kind: "FILLED", quote: decodeQuote(r.quote) });
  if (r.kind === "PARTIAL_CANCELED") return Object.freeze({ kind: "PARTIAL_CANCELED", quote: decodeQuote(r.quote) });
  if (r.kind === "NO_FILL" && (r.code === "NO_FILL_INSUFFICIENT_DEPTH" || r.code === "NO_FILL_LIMIT" || r.code === "NO_FILL_CASH_CAP")) return Object.freeze({ kind: "NO_FILL", code: r.code });
  if (r.kind === "REJECTED" && (r.code === "REJECTED_CONSTRAINT" || r.code === "REJECTED_STALE_EVIDENCE" || r.code === "REJECTED_SCRIPTED") && typeof r.detail === "string") return Object.freeze({ kind: "REJECTED", code: r.code, detail: r.detail });
  if (r.kind === "UNKNOWN" && r.reason === "UNKNOWN_SIMULATED_TIMEOUT") return Object.freeze({ kind: "UNKNOWN", reason: r.reason });
  throw new PaperPairVenueMalformedResultError("stored result discriminant is invalid");
}

export class PaperPairVenue implements PaperPairVenuePort {
  constructor(
    private readonly store: PaperPairOperationStore,
    private readonly options: { readonly now?: () => number; readonly script?: PaperPairVenueScript } = {},
  ) {}

  async executeIdempotently(request: PaperPairVenueRequest): Promise<PaperPairEffectEvidence> {
    const validation = validateRequest(request);
    const [byClient, byIdempotency] = await Promise.all([
      this.store.findByClientOperationId(request.clientOperationId),
      this.store.findByIdempotencyKey(request.idempotencyKey),
    ]);
    const prior = byClient ?? byIdempotency;
    if (prior !== null) {
      const binding = {
        ...prior,
        effectId: request.effectId,
        clientOperationId: request.clientOperationId,
        idempotencyKey: request.idempotencyKey,
        requestHash: request.requestHash,
        captureId: request.capture.captureId,
        operationKind: request.operationKind,
      };
      assertStoredBinding(prior, binding);
      if (byClient !== null && byIdempotency !== null && byClient.id !== byIdempotency.id) {
        throw new PaperPairVenueIdempotencyCollisionError("client operation and idempotency key refer to different operations");
      }
      return evidenceFromStored(prior);
    }
    const result = validation ?? scriptedResult(request, this.options.script?.(request) ?? USE_BOOK);
    const computedAtMs = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(computedAtMs) || computedAtMs < 0) throw new PaperPairVenueRequestError("computed time must be a non-negative safe integer");
    const encodedResult = canonicalJsonValue(result);
    const operation: StoredPaperPairOperation = Object.freeze({
      id: stableEvidenceId(request), effectId: request.effectId, clientOperationId: request.clientOperationId,
      idempotencyKey: request.idempotencyKey, requestHash: request.requestHash, captureId: request.capture.captureId,
      operationKind: request.operationKind, state: operationState(result), requestPayload: requestPayload(request),
      resultPayload: encodedResult, resultHash: canonicalObjectHash(result), computedAtMs, createdAtMs: computedAtMs,
    });
    return evidenceFromStored(await this.store.commit(operation));
  }

  async submitInitialFok(request: PaperPairVenueRequest): Promise<PaperPairEffectEvidence> {
    if (request.operationKind !== "INITIAL_FOK") throw new PaperPairVenueRequestError("submitInitialFok requires INITIAL_FOK");
    return this.executeIdempotently(request);
  }

  async submitRecovery(request: PaperPairVenueRequest): Promise<PaperPairEffectEvidence> {
    if (request.operationKind !== "RECOVERY_BUY_FOK" && request.operationKind !== "RECOVERY_SELL_FAK") {
      throw new PaperPairVenueRequestError("submitRecovery requires a recovery operation kind");
    }
    return this.executeIdempotently(request);
  }

  async observe(request: string | { readonly clientOperationId: string }): Promise<PaperPairEffectEvidence | null> {
    const clientOperationId = typeof request === "string" ? request : request.clientOperationId;
    assertIdentity(clientOperationId, "clientOperationId");
    const row = await this.store.findByClientOperationId(clientOperationId);
    return row === null ? null : evidenceFromStored(row);
  }
}

/** Deterministic contract implementation for unit tests and replay. */
export class InMemoryPaperPairOperationStore implements PaperPairOperationStore {
  private readonly byClient = new Map<string, StoredPaperPairOperation>();
  private readonly byIdempotency = new Map<string, StoredPaperPairOperation>();

  async commit(candidate: StoredPaperPairOperation): Promise<StoredPaperPairOperation> {
    const existingClient = this.byClient.get(candidate.clientOperationId);
    const existingIdem = this.byIdempotency.get(candidate.idempotencyKey);
    if (existingClient !== undefined) assertStoredBinding(existingClient, candidate);
    if (existingIdem !== undefined) assertStoredBinding(existingIdem, candidate);
    const existing = existingClient ?? existingIdem;
    if (existing !== undefined) return existing;
    this.byClient.set(candidate.clientOperationId, candidate);
    this.byIdempotency.set(candidate.idempotencyKey, candidate);
    return candidate;
  }

  async findByClientOperationId(clientOperationId: string): Promise<StoredPaperPairOperation | null> {
    return this.byClient.get(clientOperationId) ?? null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<StoredPaperPairOperation | null> {
    return this.byIdempotency.get(idempotencyKey) ?? null;
  }
}

/** PostgreSQL/PGlite adapter for the durable pair_paper_venue_operations row. */
export class DbPaperPairOperationStore implements PaperPairOperationStore {
  constructor(private readonly handle: DbHandle) {}

  async commit(candidate: StoredPaperPairOperation): Promise<StoredPaperPairOperation> {
    return this.handle.db.transaction(async (tx) => {
      const prior = await tx.select().from(schema.pairPaperVenueOperations).where(or(
        eq(schema.pairPaperVenueOperations.clientOrderId, candidate.clientOperationId),
        eq(schema.pairPaperVenueOperations.idempotencyKey, candidate.idempotencyKey),
      ));
      for (const row of prior) assertStoredBinding(fromDbRow(row), candidate);
      if (prior[0] !== undefined) return fromDbRow(prior[0]);

      await tx.insert(schema.pairPaperVenueOperations).values({
        id: candidate.id, clientOrderId: candidate.clientOperationId, effectId: candidate.effectId,
        idempotencyKey: candidate.idempotencyKey, requestHash: candidate.requestHash, captureId: candidate.captureId,
        operationKind: candidate.operationKind, state: candidate.state,
        requestPayload: candidate.requestPayload as never, resultPayload: candidate.resultPayload as never,
        resultHash: candidate.resultHash, computedAtMs: candidate.computedAtMs, createdAtMs: candidate.createdAtMs,
      }).onConflictDoNothing();

      const committed = await tx.select().from(schema.pairPaperVenueOperations).where(and(
        eq(schema.pairPaperVenueOperations.clientOrderId, candidate.clientOperationId),
        eq(schema.pairPaperVenueOperations.idempotencyKey, candidate.idempotencyKey),
      )).limit(1);
      if (committed[0] === undefined) throw new PaperPairVenueIdempotencyCollisionError("concurrent client operation/idempotency collision");
      const stored = fromDbRow(committed[0]);
      assertStoredBinding(stored, candidate);
      return stored;
    });
  }

  async findByClientOperationId(clientOperationId: string): Promise<StoredPaperPairOperation | null> {
    const rows = await this.handle.db.select().from(schema.pairPaperVenueOperations)
      .where(eq(schema.pairPaperVenueOperations.clientOrderId, clientOperationId)).limit(1);
    return rows[0] === undefined ? null : fromDbRow(rows[0]);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<StoredPaperPairOperation | null> {
    const rows = await this.handle.db.select().from(schema.pairPaperVenueOperations)
      .where(eq(schema.pairPaperVenueOperations.idempotencyKey, idempotencyKey)).limit(1);
    return rows[0] === undefined ? null : fromDbRow(rows[0]);
  }
}

function fromDbRow(row: typeof schema.pairPaperVenueOperations.$inferSelect): StoredPaperPairOperation {
  return Object.freeze({
    id: row.id, effectId: row.effectId, clientOperationId: row.clientOrderId,
    idempotencyKey: row.idempotencyKey, requestHash: row.requestHash, captureId: row.captureId,
    operationKind: row.operationKind as PaperPairOperationKind, state: row.state as PaperPairOperationState,
    requestPayload: row.requestPayload, resultPayload: row.resultPayload, resultHash: row.resultHash,
    computedAtMs: row.computedAtMs, createdAtMs: row.createdAtMs,
  });
}
