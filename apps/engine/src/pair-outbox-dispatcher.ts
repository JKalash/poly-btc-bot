import {
  canonicalJsonValue,
  canonicalObjectHash,
  decodeBigIntDecimal,
  type ImmutablePairBookLeg,
  type PairBookCapture,
  type PairBookIntegrity,
  type PairBookLevel,
  type PairBookReference,
  type PairOutcome,
} from "@b5p/pair-execution";
import {
  PaperPairVenueIdempotencyCollisionError,
  PaperPairVenueMalformedResultError,
  PaperPairVenueRequestError,
  paperPairVenueRequestHash,
  type PaperPairEffectEvidence,
  type PaperPairLegRequest,
  type PaperPairOperationKind,
  type PaperPairVenueRequest,
} from "./paper-pair-venue";
import {
  PairStore,
  PairStoreIdempotencyCollisionError,
  type PairEffectOutboxRow,
} from "./pair-store";

export type PairOutboxDispatcherCriticalCode =
  | "INVALID_REQUEST_PAYLOAD"
  | "CLAIM_PROOF_MISSING"
  | "IMMUTABLE_EFFECT_CHANGED"
  | "EVIDENCE_BINDING_COLLISION"
  | "MALFORMED_VENUE_EVIDENCE"
  | "IDEMPOTENCY_COLLISION";

export class PairOutboxDispatcherCriticalError extends Error {
  readonly critical = true as const;

  constructor(
    readonly code: PairOutboxDispatcherCriticalCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PairOutboxDispatcherCriticalError";
  }
}

export interface DurablePaperPairVenuePort {
  executeIdempotently(request: PaperPairVenueRequest): Promise<PaperPairEffectEvidence>;
  observe(clientOperationId: string): Promise<PaperPairEffectEvidence | null>;
}

export interface PairEffectLegalityInput {
  readonly effect: PairEffectOutboxRow;
  readonly request: PaperPairVenueRequest;
  readonly nowMs: number;
  readonly recovery: boolean;
}

/**
 * The lifecycle owner supplies this check. The dispatcher deliberately does
 * not infer halt, deadline, state, risk, or recovery policy from projections.
 */
export type PairEffectLegalityCheck = (input: PairEffectLegalityInput) => Promise<boolean>;

export type PairOutboxDispatchResult =
  | { readonly kind: "IDLE" }
  | { readonly kind: "REQUIRES_RECONCILIATION"; readonly effectId: string; readonly recovery: boolean }
  | {
      readonly kind: "EVIDENCE_INGESTED";
      readonly effectId: string;
      readonly evidenceId: string;
      readonly effectState: "SUCCEEDED" | "TERMINAL_REJECTED" | "OUTCOME_UNKNOWN";
      readonly source: "EXECUTED" | "OBSERVED";
    };

export interface PairOutboxDispatchInput {
  readonly nowMs: number;
  readonly leaseMs: number;
  readonly claimToken: string;
}

function critical(code: PairOutboxDispatcherCriticalCode, message: string, cause?: unknown): PairOutboxDispatcherCriticalError {
  return new PairOutboxDispatcherCriticalError(code, message, cause);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw critical("INVALID_REQUEST_PAYLOAD", `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw critical("INVALID_REQUEST_PAYLOAD", `${path} has unexpected or missing fields`);
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw critical("INVALID_REQUEST_PAYLOAD", `${path} must be a non-empty string`);
  }
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  if (value === null) return null;
  return text(value, path);
}

function safeTime(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw critical("INVALID_REQUEST_PAYLOAD", `${path} must be a non-negative safe integer`);
  }
  return value;
}

function unsignedBigint(value: unknown, path: string): bigint {
  let decoded: bigint;
  try {
    decoded = decodeBigIntDecimal(value, path);
  } catch (error) {
    throw critical("INVALID_REQUEST_PAYLOAD", `${path} must be a canonical integer string`, error);
  }
  if (decoded < 0n) throw critical("INVALID_REQUEST_PAYLOAD", `${path} must be non-negative`);
  return decoded;
}

function literal<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw critical("INVALID_REQUEST_PAYLOAD", `${path} has an unsupported value`);
  }
  return value as T;
}

function decodeLevel(value: unknown, path: string): PairBookLevel {
  const row = object(value, path);
  exactKeys(row, ["price6", "shares6"], path);
  return Object.freeze({
    price6: unsignedBigint(row.price6, `${path}.price6`),
    shares6: unsignedBigint(row.shares6, `${path}.shares6`),
  });
}

function decodeLeg(value: unknown, outcome: PairOutcome, path: string): ImmutablePairBookLeg {
  const row = object(value, path);
  exactKeys(row, [
    "outcome", "tokenId", "bookVersion", "connectionEpoch", "sourceTsMs", "receivedTsMs",
    "exchangeHash", "sourceEventId", "integrity", "bids", "asks",
  ], path);
  if (!Array.isArray(row.bids) || !Array.isArray(row.asks)) {
    throw critical("INVALID_REQUEST_PAYLOAD", `${path} book levels must be arrays`);
  }
  if (literal(row.outcome, ["UP", "DOWN"] as const, `${path}.outcome`) !== outcome) {
    throw critical("INVALID_REQUEST_PAYLOAD", `${path}.outcome does not match its capture side`);
  }
  return Object.freeze({
    outcome,
    tokenId: text(row.tokenId, `${path}.tokenId`),
    bookVersion: unsignedBigint(row.bookVersion, `${path}.bookVersion`),
    connectionEpoch: text(row.connectionEpoch, `${path}.connectionEpoch`),
    sourceTsMs: safeTime(row.sourceTsMs, `${path}.sourceTsMs`),
    receivedTsMs: safeTime(row.receivedTsMs, `${path}.receivedTsMs`),
    exchangeHash: nullableText(row.exchangeHash, `${path}.exchangeHash`),
    sourceEventId: text(row.sourceEventId, `${path}.sourceEventId`),
    integrity: literal(row.integrity, [
      "VERIFIED_SNAPSHOT", "SEQUENCED_CONTIGUOUS", "HASH_CHAIN_VERIFIED", "UNSEQUENCED_AFTER_SNAPSHOT",
    ] as const, `${path}.integrity`) as PairBookIntegrity,
    bids: Object.freeze(row.bids.map((level, index) => decodeLevel(level, `${path}.bids[${index}]`))),
    asks: Object.freeze(row.asks.map((level, index) => decodeLevel(level, `${path}.asks[${index}]`))),
  });
}

function decodeCapture(value: unknown): PairBookCapture {
  const row = object(value, "$.capture");
  exactKeys(row, [
    "captureId", "marketId", "conditionId", "capturedAtMs", "captureSequence", "up", "down",
    "sourceSkewMs", "receiveSkewMs", "captureHash",
  ], "$.capture");
  return Object.freeze({
    captureId: text(row.captureId, "$.capture.captureId") as PairBookCapture["captureId"],
    marketId: text(row.marketId, "$.capture.marketId"),
    conditionId: text(row.conditionId, "$.capture.conditionId"),
    capturedAtMs: safeTime(row.capturedAtMs, "$.capture.capturedAtMs"),
    captureSequence: unsignedBigint(row.captureSequence, "$.capture.captureSequence"),
    up: decodeLeg(row.up, "UP", "$.capture.up"),
    down: decodeLeg(row.down, "DOWN", "$.capture.down"),
    sourceSkewMs: safeTime(row.sourceSkewMs, "$.capture.sourceSkewMs"),
    receiveSkewMs: safeTime(row.receiveSkewMs, "$.capture.receiveSkewMs"),
    captureHash: text(row.captureHash, "$.capture.captureHash"),
  });
}

function decodeBookRef(value: unknown): PairBookReference {
  const row = object(value, "$.leg.bookRef");
  exactKeys(row, ["tokenId", "bookVersion", "connectionEpoch", "sourceEventId", "contentHash"], "$.leg.bookRef");
  return Object.freeze({
    tokenId: text(row.tokenId, "$.leg.bookRef.tokenId"),
    bookVersion: unsignedBigint(row.bookVersion, "$.leg.bookRef.bookVersion"),
    connectionEpoch: text(row.connectionEpoch, "$.leg.bookRef.connectionEpoch"),
    sourceEventId: text(row.sourceEventId, "$.leg.bookRef.sourceEventId"),
    contentHash: text(row.contentHash, "$.leg.bookRef.contentHash"),
  });
}

function decodePaperLeg(value: unknown, operationKind: PaperPairOperationKind): PaperPairLegRequest {
  const row = object(value, "$.leg");
  const buy = operationKind !== "RECOVERY_SELL_FAK";
  exactKeys(row, [
    "outcome", "tokenId", "side", "timeInForce", "amountSemantics", "grossShares6", "limitPrice6",
    buy ? "maximumCashDebit6" : "availableShares6",
    "minimumOrderShares6", "shareLot6", "fee", "bookRef",
  ], "$.leg");
  const fee = object(row.fee, "$.leg.fee");
  exactKeys(fee, ["ratePpm", "collection"], "$.leg.fee");
  const common = {
    outcome: literal(row.outcome, ["UP", "DOWN"] as const, "$.leg.outcome"),
    tokenId: text(row.tokenId, "$.leg.tokenId"),
    side: literal(row.side, ["BUY", "SELL"] as const, "$.leg.side"),
    timeInForce: literal(row.timeInForce, ["FOK", "FAK"] as const, "$.leg.timeInForce"),
    amountSemantics: literal(row.amountSemantics, ["SHARES"] as const, "$.leg.amountSemantics"),
    grossShares6: unsignedBigint(row.grossShares6, "$.leg.grossShares6"),
    limitPrice6: unsignedBigint(row.limitPrice6, "$.leg.limitPrice6"),
    minimumOrderShares6: unsignedBigint(row.minimumOrderShares6, "$.leg.minimumOrderShares6"),
    shareLot6: unsignedBigint(row.shareLot6, "$.leg.shareLot6"),
    fee: Object.freeze({
      ratePpm: unsignedBigint(fee.ratePpm, "$.leg.fee.ratePpm"),
      collection: literal(fee.collection, ["usdc", "shares"] as const, "$.leg.fee.collection"),
    }),
    bookRef: decodeBookRef(row.bookRef),
  };
  return Object.freeze(buy
    ? { ...common, maximumCashDebit6: unsignedBigint(row.maximumCashDebit6, "$.leg.maximumCashDebit6") }
    : { ...common, availableShares6: unsignedBigint(row.availableShares6, "$.leg.availableShares6") });
}

/** Canonical payload form persisted in pair_effect_outbox.request_payload. */
export function encodePaperPairOutboxRequestPayload(request: PaperPairVenueRequest): unknown {
  const calculated = paperPairVenueRequestHash({
    effectId: request.effectId,
    clientOperationId: request.clientOperationId,
    idempotencyKey: request.idempotencyKey,
    operationKind: request.operationKind,
    capture: request.capture,
    leg: request.leg,
  });
  if (calculated !== request.requestHash) {
    throw critical("INVALID_REQUEST_PAYLOAD", "requestHash does not authenticate the immutable paper request");
  }
  return canonicalJsonValue({
    schemaVersion: 1,
    effectId: request.effectId,
    clientOperationId: request.clientOperationId,
    idempotencyKey: request.idempotencyKey,
    operationKind: request.operationKind,
    capture: request.capture,
    leg: request.leg,
  });
}

/** Decode without Number coercion and authenticate every outbox identity. */
export function decodePaperPairOutboxRequest(effect: PairEffectOutboxRow): PaperPairVenueRequest {
  const row = object(effect.requestPayload, "$");
  exactKeys(row, [
    "schemaVersion", "effectId", "clientOperationId", "idempotencyKey", "operationKind", "capture", "leg",
  ], "$");
  if (row.schemaVersion !== 1) throw critical("INVALID_REQUEST_PAYLOAD", "$.schemaVersion must be 1");
  const operationKind = literal(row.operationKind, ["INITIAL_FOK", "RECOVERY_BUY_FOK", "RECOVERY_SELL_FAK"] as const, "$.operationKind");
  const request: PaperPairVenueRequest = Object.freeze({
    effectId: text(row.effectId, "$.effectId"),
    clientOperationId: text(row.clientOperationId, "$.clientOperationId"),
    idempotencyKey: text(row.idempotencyKey, "$.idempotencyKey"),
    requestHash: effect.requestHash,
    operationKind,
    capture: decodeCapture(row.capture),
    leg: decodePaperLeg(row.leg, operationKind),
  });
  if (
    request.effectId !== effect.id || request.clientOperationId !== effect.clientOperationId ||
    request.idempotencyKey !== effect.idempotencyKey
  ) {
    throw critical("EVIDENCE_BINDING_COLLISION", "outbox columns and canonical request identity disagree");
  }
  const calculated = paperPairVenueRequestHash({
    effectId: request.effectId,
    clientOperationId: request.clientOperationId,
    idempotencyKey: request.idempotencyKey,
    operationKind: request.operationKind,
    capture: request.capture,
    leg: request.leg,
  });
  if (calculated !== effect.requestHash) {
    throw critical("INVALID_REQUEST_PAYLOAD", "outbox request hash does not authenticate the canonical request payload");
  }
  return request;
}

function sameImmutableEffect(left: PairEffectOutboxRow, right: PairEffectOutboxRow): boolean {
  return left.id === right.id && left.groupId === right.groupId && left.actionIntentId === right.actionIntentId &&
    left.actionKind === right.actionKind && left.actionSequence === right.actionSequence &&
    left.effectOrdinal === right.effectOrdinal && left.idempotencyKey === right.idempotencyKey &&
    left.clientOperationId === right.clientOperationId && left.requestHash === right.requestHash &&
    canonicalObjectHash(left.requestPayload) === canonicalObjectHash(right.requestPayload);
}

function terminalEffectState(evidence: PaperPairEffectEvidence): "SUCCEEDED" | "TERMINAL_REJECTED" | "OUTCOME_UNKNOWN" {
  const result = evidence.result;
  const expectedVenueState = result.kind === "FILLED" ? "FILLED"
    : result.kind === "NO_FILL" ? "NO_FILL"
      : result.kind === "REJECTED" ? "TERMINAL_REJECTED"
        : result.kind === "PARTIAL_CANCELED" ? "PARTIAL_CANCELED"
          : "OUTCOME_UNKNOWN";
  if (evidence.state !== expectedVenueState || canonicalObjectHash(result) !== evidence.resultHash) {
    throw critical("MALFORMED_VENUE_EVIDENCE", "venue evidence state or result hash is invalid");
  }
  return result.kind === "REJECTED" ? "TERMINAL_REJECTED"
    : result.kind === "UNKNOWN" ? "OUTCOME_UNKNOWN"
      : "SUCCEEDED";
}

function assertEvidenceBinding(effect: PairEffectOutboxRow, request: PaperPairVenueRequest, evidence: PaperPairEffectEvidence): void {
  if (
    evidence.evidenceId.length === 0 || evidence.effectId !== effect.id ||
    evidence.clientOperationId !== effect.clientOperationId || evidence.idempotencyKey !== effect.idempotencyKey ||
    evidence.requestHash !== effect.requestHash || evidence.captureId !== request.capture.captureId ||
    evidence.operationKind !== request.operationKind
  ) {
    throw critical("EVIDENCE_BINDING_COLLISION", "venue evidence does not match the immutable outbox effect");
  }
  if (!Number.isSafeInteger(evidence.computedAtMs) || evidence.computedAtMs < 0) {
    throw critical("MALFORMED_VENUE_EVIDENCE", "venue evidence has an invalid computed time");
  }
}

/**
 * One-shot dispatcher invoked by PairExecution.advance. It owns no clock,
 * timer, retry cadence, or policy. Each method handles at most one effect.
 */
export class PairOutboxDispatcher {
  constructor(
    private readonly store: PairStore,
    private readonly venue: DurablePaperPairVenuePort,
    private readonly isEffectLegal: PairEffectLegalityCheck,
  ) {}

  async dispatchNext(input: PairOutboxDispatchInput): Promise<PairOutboxDispatchResult> {
    const claimed = await this.store.claimNextDueEffect(input);
    if (claimed === null) return { kind: "IDLE" };
    const proof = await this.proveClaim(claimed, input.claimToken);
    const request = decodePaperPairOutboxRequest(proof);
    if (!await this.isEffectLegal({ effect: proof, request, nowMs: input.nowMs, recovery: false })) {
      return { kind: "REQUIRES_RECONCILIATION", effectId: proof.id, recovery: false };
    }
    const finalProof = await this.proveClaim(proof, input.claimToken);
    return this.executeAndIngest(finalProof, request, input.nowMs, "EXECUTED");
  }

  async recoverNextExpired(input: PairOutboxDispatchInput): Promise<PairOutboxDispatchResult> {
    const claimed = await this.store.claimNextExpiredEffect(input);
    if (claimed === null) return { kind: "IDLE" };
    const proof = await this.proveClaim(claimed, input.claimToken);

    let observed: PaperPairEffectEvidence | null;
    try {
      observed = await this.venue.observe(proof.clientOperationId);
    } catch (error) {
      throw this.wrapCriticalVenueError(error);
    }
    const request = decodePaperPairOutboxRequest(proof);
    if (observed !== null) return this.ingest(proof, request, observed, input.nowMs, "OBSERVED");

    if (!await this.isEffectLegal({ effect: proof, request, nowMs: input.nowMs, recovery: true })) {
      return { kind: "REQUIRES_RECONCILIATION", effectId: proof.id, recovery: true };
    }
    const finalProof = await this.proveClaim(proof, input.claimToken);
    const audited = await this.store.markClaimReexecutionAttempt({
      effectId: finalProof.id,
      claimToken: input.claimToken,
      nowMs: input.nowMs,
    });
    if (audited === null || !sameImmutableEffect(finalProof, audited)) {
      throw critical("CLAIM_PROOF_MISSING", "expired effect ownership changed before re-execution");
    }
    return this.executeAndIngest(audited, request, input.nowMs, "EXECUTED");
  }

  private async proveClaim(expected: PairEffectOutboxRow, claimToken: string): Promise<PairEffectOutboxRow> {
    const proof = await this.store.getClaimedEffect({ effectId: expected.id, claimToken });
    if (proof === null) throw critical("CLAIM_PROOF_MISSING", "claimed outbox row does not exist under dispatcher ownership");
    if (!sameImmutableEffect(expected, proof)) {
      throw critical("IMMUTABLE_EFFECT_CHANGED", "immutable outbox effect changed after claim");
    }
    return proof;
  }

  private async executeAndIngest(
    effect: PairEffectOutboxRow,
    request: PaperPairVenueRequest,
    nowMs: number,
    source: "EXECUTED" | "OBSERVED",
  ): Promise<PairOutboxDispatchResult> {
    let evidence: PaperPairEffectEvidence;
    try {
      evidence = await this.venue.executeIdempotently(request);
    } catch (error) {
      throw this.wrapCriticalVenueError(error);
    }
    return this.ingest(effect, request, evidence, nowMs, source);
  }

  private async ingest(
    effect: PairEffectOutboxRow,
    request: PaperPairVenueRequest,
    evidence: PaperPairEffectEvidence,
    nowMs: number,
    source: "EXECUTED" | "OBSERVED",
  ): Promise<PairOutboxDispatchResult> {
    assertEvidenceBinding(effect, request, evidence);
    const effectState = terminalEffectState(evidence);
    const payload = canonicalJsonValue(evidence);
    try {
      await this.store.ingestEvidence({
        id: evidence.evidenceId,
        groupId: effect.groupId,
        effectId: effect.id,
        evidenceKey: `paper-pair:${evidence.evidenceId}`,
        evidenceKind: "PAPER_PAIR_RESULT",
        payloadHash: canonicalObjectHash(payload),
        payload,
        sourceTsMs: evidence.computedAtMs,
        receivedTsMs: nowMs,
        createdAtMs: nowMs,
        effectTerminalState: effectState,
      });
    } catch (error) {
      if (error instanceof PairStoreIdempotencyCollisionError) {
        throw critical("IDEMPOTENCY_COLLISION", "paper evidence collided with a different durable inbox binding", error);
      }
      throw error;
    }
    return {
      kind: "EVIDENCE_INGESTED",
      effectId: effect.id,
      evidenceId: evidence.evidenceId,
      effectState,
      source,
    };
  }

  private wrapCriticalVenueError(error: unknown): Error {
    if (error instanceof PairOutboxDispatcherCriticalError) return error;
    if (error instanceof PaperPairVenueIdempotencyCollisionError) {
      return critical("IDEMPOTENCY_COLLISION", "paper venue idempotency collision", error);
    }
    if (error instanceof PaperPairVenueMalformedResultError || error instanceof PaperPairVenueRequestError) {
      return critical("MALFORMED_VENUE_EVIDENCE", "paper venue rejected the durable request/evidence boundary", error);
    }
    return error instanceof Error ? error : new Error("paper venue failed with a non-error value");
  }
}
