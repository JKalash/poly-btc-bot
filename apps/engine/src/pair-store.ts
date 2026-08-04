import { schema, type Db, type DbHandle } from "@b5p/db";
import { canonicalJsonValue, canonicalObjectHash } from "@b5p/pair-execution";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { MarketExposureGuardStore, type MarketExposureGuardConflictCode } from "./market-exposure-guard-store";

export const ACTIVE_PAIR_GROUP_STATES = [
  "SCHEDULED", "ACTIVATING", "ACTIVATION_REJECTED", "SUBMITTING", "OUTCOME_UNKNOWN",
  "NO_INITIAL_FILL", "PAIRED", "RESIDUAL", "RECOVERY_PENDING", "RECOVERING",
  "RECOVERY_OUTCOME_UNKNOWN", "AWAITING_SETTLEMENT", "MERGE_PENDING",
  "MERGE_OUTCOME_UNKNOWN", "AWAITING_RESOLUTION", "RECONCILING", "MANUAL_REVIEW",
] as const;
const ACTIVE_PAIR_GROUP_STATE_VALUES: string[] = [...ACTIVE_PAIR_GROUP_STATES];

export type PairOrderGroupRow = typeof schema.pairOrderGroups.$inferSelect;
export type PairOrderGroupInsert = typeof schema.pairOrderGroups.$inferInsert;
export type PairEffectOutboxRow = typeof schema.pairEffectOutbox.$inferSelect;
export type PairInboxEvidenceRow = typeof schema.pairInboxEvidence.$inferSelect;

export type PairProjectionPatch = Readonly<Partial<Omit<PairOrderGroupInsert,
  "id" | "marketId" | "conditionId" | "strategyVersion" | "mode" | "idempotencyKey" |
  "requestHash" | "createdAtMs" | "stateVersion" | "eventSequence"
>>>;

export interface PairEventAppend {
  readonly id: string;
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly causationId: string;
  readonly correlationId: string;
  readonly payload: unknown;
  readonly occurredAtMs: number;
  readonly recordedAtMs: number;
}

export interface PairEffectEnqueue {
  readonly id: string;
  readonly actionIntentId: string;
  readonly actionKind: string;
  readonly actionSequence: number;
  readonly effectOrdinal: number;
  readonly idempotencyKey: string;
  readonly clientOperationId: string;
  readonly requestHash: string;
  readonly requestPayload: unknown;
  readonly notBeforeMs: number;
  readonly deadlineMs: number;
  readonly createdAtMs: number;
}

export interface AppendPairEventInput {
  readonly groupId: string;
  readonly expectedStateVersion: number;
  readonly expectedEventSequence: number;
  readonly event: PairEventAppend;
  readonly projection: PairProjectionPatch;
  /** Effects are inserted in the event/projection transaction, never afterward. */
  readonly effects?: readonly PairEffectEnqueue[];
}

export type AppendPairEventResult =
  | { readonly kind: "APPLIED"; readonly stateVersion: number; readonly eventSequence: number }
  | { readonly kind: "DUPLICATE"; readonly stateVersion: number; readonly eventSequence: number }
  | { readonly kind: "CONFLICT"; readonly current: PairOrderGroupRow | null };

export type CreatePairGroupResult =
  | { readonly kind: "CREATED"; readonly group: PairOrderGroupRow }
  | { readonly kind: "DUPLICATE"; readonly group: PairOrderGroupRow }
  | { readonly kind: "ACTIVE_MARKET_CONFLICT"; readonly active: PairOrderGroupRow }
  | {
      readonly kind: "MARKET_EXPOSURE_CONFLICT";
      readonly code: MarketExposureGuardConflictCode;
      readonly ownerKind: string | null;
      readonly ownerId: string | null;
    };

export interface PairInboxEvidenceInput {
  readonly id: string;
  readonly groupId: string;
  readonly effectId?: string | null;
  readonly evidenceKey: string;
  readonly evidenceKind: string;
  readonly payloadHash: string;
  readonly payload: unknown;
  readonly sourceTsMs?: number | null;
  readonly receivedTsMs: number;
  readonly createdAtMs: number;
  /** When present, linking the result and updating the effect are atomic with inbox insert. */
  readonly effectTerminalState?: "SUCCEEDED" | "TERMINAL_REJECTED" | "OUTCOME_UNKNOWN";
}

export type IngestPairEvidenceResult =
  | { readonly kind: "INSERTED"; readonly evidence: PairInboxEvidenceRow }
  | { readonly kind: "DUPLICATE"; readonly evidence: PairInboxEvidenceRow };

export class PairStoreError extends Error {}
export class PairStoreValidationError extends PairStoreError {}
export class PairStoreIdempotencyCollisionError extends PairStoreError {
  readonly code = "IDEMPOTENCY_HASH_COLLISION" as const;
}

function assertIdentity(value: string, label: string): void {
  if (value.length === 0) throw new PairStoreValidationError(`${label} must be non-empty`);
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new PairStoreValidationError(`${label} must be a non-negative safe integer`);
}

function sameEvent(row: typeof schema.pairGroupEvents.$inferSelect, groupId: string, event: PairEventAppend): boolean {
  return row.id === event.id && row.groupId === groupId && row.eventType === event.eventType &&
    row.eventSchemaVersion === event.eventSchemaVersion && row.causationId === event.causationId &&
    row.correlationId === event.correlationId && row.occurredAtMs === event.occurredAtMs &&
    row.recordedAtMs === event.recordedAtMs &&
    canonicalObjectHash(row.payload) === canonicalObjectHash(event.payload);
}

function validateEffect(effect: PairEffectEnqueue): void {
  assertIdentity(effect.id, "effect id");
  assertIdentity(effect.actionIntentId, "action intent id");
  assertIdentity(effect.idempotencyKey, "effect idempotency key");
  assertIdentity(effect.clientOperationId, "client operation id");
  assertIdentity(effect.requestHash, "request hash");
  assertNonNegativeSafeInteger(effect.actionSequence, "action sequence");
  assertNonNegativeSafeInteger(effect.effectOrdinal, "effect ordinal");
  assertNonNegativeSafeInteger(effect.notBeforeMs, "not-before time");
  assertNonNegativeSafeInteger(effect.deadlineMs, "deadline");
  if (effect.deadlineMs < effect.notBeforeMs) throw new PairStoreValidationError("effect deadline precedes not-before time");
}

/** Durable PostgreSQL/PGlite store for the pair event projection and effect boundary. */
export class PairStore {
  constructor(private readonly handle: DbHandle) {}

  async createGroup(candidate: PairOrderGroupInsert): Promise<CreatePairGroupResult> {
    assertIdentity(candidate.id, "group id");
    assertIdentity(candidate.idempotencyKey, "group idempotency key");
    assertIdentity(candidate.requestHash, "group request hash");
    return this.handle.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const sameKey = await tx.select().from(schema.pairOrderGroups)
        .where(eq(schema.pairOrderGroups.idempotencyKey, candidate.idempotencyKey)).limit(1);
      if (sameKey[0] !== undefined) {
        if (sameKey[0].requestHash !== candidate.requestHash || sameKey[0].id !== candidate.id) {
          throw new PairStoreIdempotencyCollisionError("group idempotency key is bound to a different immutable request");
        }
        return { kind: "DUPLICATE" as const, group: sameKey[0] };
      }

      const activeRows = await tx.select().from(schema.pairOrderGroups).where(and(
        eq(schema.pairOrderGroups.marketId, candidate.marketId),
        inArray(schema.pairOrderGroups.state, ACTIVE_PAIR_GROUP_STATE_VALUES),
      )).orderBy(asc(schema.pairOrderGroups.createdAtMs), asc(schema.pairOrderGroups.id)).limit(1);
      if (activeRows[0] !== undefined) return { kind: "ACTIVE_MARKET_CONFLICT" as const, active: activeRows[0] };

      const guard = new MarketExposureGuardStore(this.handle, tx);
      const currentGuard = await guard.get(candidate.marketId);
      if (currentGuard?.releasedAtMs === null && currentGuard.ownerKind === "PAIR_GROUP") {
        const ownerRows = await tx.select({ state: schema.pairOrderGroups.state }).from(schema.pairOrderGroups)
          .where(eq(schema.pairOrderGroups.id, currentGuard.ownerId)).limit(1);
        const terminalState = ownerRows[0]?.state;
        if (terminalState === "RECONCILED_FLAT" || terminalState === "RECONCILED_SETTLED") {
          const released = await guard.release({
            marketId: candidate.marketId,
            ownerKind: "PAIR_GROUP",
            ownerId: currentGuard.ownerId,
            expectedStateVersion: currentGuard.stateVersion,
            terminalState,
            releasedAtMs: candidate.createdAtMs,
          });
          if (released.kind === "CONFLICT") throw new PairStoreError(`failed to release terminal pair market guard: ${released.code}`);
        }
      }
      const acquired = await guard.acquire({
        marketId: candidate.marketId,
        ownerKind: "PAIR_GROUP",
        ownerId: candidate.id,
        ownerState: candidate.state,
        acquiredAtMs: candidate.createdAtMs,
      });
      if (acquired.kind === "CONFLICT") {
        return {
          kind: "MARKET_EXPOSURE_CONFLICT" as const,
          code: acquired.code,
          ownerKind: acquired.guard?.ownerKind ?? null,
          ownerId: acquired.guard?.ownerId ?? null,
        };
      }

      const inserted = await tx.insert(schema.pairOrderGroups).values(candidate)
        .onConflictDoNothing().returning();
      if (inserted[0] !== undefined) return { kind: "CREATED" as const, group: inserted[0] };
      const racedKey = await tx.select().from(schema.pairOrderGroups)
        .where(eq(schema.pairOrderGroups.idempotencyKey, candidate.idempotencyKey)).limit(1);
      if (racedKey[0] !== undefined && racedKey[0].requestHash === candidate.requestHash && racedKey[0].id === candidate.id) {
        return { kind: "DUPLICATE" as const, group: racedKey[0] };
      }
      throw new PairStoreError("group insert conflicted with an unknown unique identity");
    });
  }

  async getGroup(groupId: string): Promise<PairOrderGroupRow | null> {
    const rows = await this.handle.db.select().from(schema.pairOrderGroups)
      .where(eq(schema.pairOrderGroups.id, groupId)).limit(1);
    return rows[0] ?? null;
  }

  async findActiveGroupForMarket(marketId: string): Promise<PairOrderGroupRow | null> {
    const rows = await this.handle.db.select().from(schema.pairOrderGroups).where(and(
      eq(schema.pairOrderGroups.marketId, marketId),
      inArray(schema.pairOrderGroups.state, ACTIVE_PAIR_GROUP_STATE_VALUES),
    )).orderBy(asc(schema.pairOrderGroups.createdAtMs), asc(schema.pairOrderGroups.id)).limit(1);
    return rows[0] ?? null;
  }

  async findDueGroups(nowMs: number, limit = 100): Promise<readonly PairOrderGroupRow[]> {
    assertNonNegativeSafeInteger(nowMs, "now");
    assertNonNegativeSafeInteger(limit, "limit");
    if (limit === 0) return [];
    return this.handle.db.select().from(schema.pairOrderGroups).where(and(
      inArray(schema.pairOrderGroups.state, ACTIVE_PAIR_GROUP_STATE_VALUES),
      lte(schema.pairOrderGroups.nextActionAtMs, nowMs),
    )).orderBy(asc(schema.pairOrderGroups.nextActionAtMs), asc(schema.pairOrderGroups.createdAtMs), asc(schema.pairOrderGroups.id)).limit(limit);
  }

  async appendEvent(input: AppendPairEventInput): Promise<AppendPairEventResult> {
    assertIdentity(input.groupId, "group id");
    assertIdentity(input.event.id, "event id");
    assertIdentity(input.event.causationId, "causation id");
    assertNonNegativeSafeInteger(input.expectedStateVersion, "expected state version");
    assertNonNegativeSafeInteger(input.expectedEventSequence, "expected event sequence");
    if (input.event.eventSchemaVersion <= 0) throw new PairStoreValidationError("event schema version must be positive");
    for (const effect of input.effects ?? []) validateEffect(effect);

    return this.handle.db.transaction(async (tx) => {
      const prior = await tx.select().from(schema.pairGroupEvents).where(and(
        eq(schema.pairGroupEvents.groupId, input.groupId),
        eq(schema.pairGroupEvents.causationId, input.event.causationId),
      )).limit(1);
      if (prior[0] !== undefined) {
        if (!sameEvent(prior[0], input.groupId, input.event)) {
          throw new PairStoreIdempotencyCollisionError("event causation id is bound to different event content");
        }
        const current = await tx.select({ stateVersion: schema.pairOrderGroups.stateVersion, eventSequence: schema.pairOrderGroups.eventSequence })
          .from(schema.pairOrderGroups).where(eq(schema.pairOrderGroups.id, input.groupId)).limit(1);
        if (current[0] === undefined) throw new PairStoreError("event exists without its group projection");
        return { kind: "DUPLICATE" as const, ...current[0] };
      }

      const nextSequence = input.expectedEventSequence + 1;
      const nextVersion = input.expectedStateVersion + 1;
      const updated = await tx.update(schema.pairOrderGroups).set({
        ...input.projection,
        stateVersion: nextVersion,
        eventSequence: nextSequence,
        updatedAtMs: input.event.recordedAtMs,
      }).where(and(
        eq(schema.pairOrderGroups.id, input.groupId),
        eq(schema.pairOrderGroups.stateVersion, input.expectedStateVersion),
        eq(schema.pairOrderGroups.eventSequence, input.expectedEventSequence),
      )).returning();

      if (updated[0] === undefined) {
        const rows = await tx.select().from(schema.pairOrderGroups)
          .where(eq(schema.pairOrderGroups.id, input.groupId)).limit(1);
        return { kind: "CONFLICT" as const, current: rows[0] ?? null };
      }

      await tx.insert(schema.pairGroupEvents).values({
        id: input.event.id, groupId: input.groupId, sequence: nextSequence,
        eventType: input.event.eventType, eventSchemaVersion: input.event.eventSchemaVersion,
        causationId: input.event.causationId, correlationId: input.event.correlationId,
        payload: canonicalJsonValue(input.event.payload) as never,
        occurredAtMs: input.event.occurredAtMs, recordedAtMs: input.event.recordedAtMs,
      });

      if ((input.effects?.length ?? 0) > 0) {
        await tx.insert(schema.pairEffectOutbox).values(input.effects!.map((effect) => ({
          id: effect.id, groupId: input.groupId, actionIntentId: effect.actionIntentId,
          actionKind: effect.actionKind, actionSequence: effect.actionSequence,
          effectOrdinal: effect.effectOrdinal, idempotencyKey: effect.idempotencyKey,
          clientOperationId: effect.clientOperationId, requestHash: effect.requestHash,
          requestPayload: canonicalJsonValue(effect.requestPayload) as never,
          state: "PENDING", notBeforeMs: effect.notBeforeMs, deadlineMs: effect.deadlineMs,
          attemptCount: 0, createdAtMs: effect.createdAtMs, updatedAtMs: effect.createdAtMs,
        })));
      }
      if (input.projection.state === "RECONCILED_FLAT" || input.projection.state === "RECONCILED_SETTLED") {
        const guard = new MarketExposureGuardStore(this.handle, tx as unknown as Db);
        const current = await guard.findActiveByOwner("PAIR_GROUP", input.groupId);
        if (current !== null) {
          const released = await guard.release({
            marketId: current.marketId,
            ownerKind: "PAIR_GROUP",
            ownerId: input.groupId,
            expectedStateVersion: current.stateVersion,
            terminalState: input.projection.state,
            releasedAtMs: input.event.recordedAtMs,
          });
          if (released.kind === "CONFLICT") throw new PairStoreError(`failed to release terminal pair market guard: ${released.code}`);
        }
      }
      return { kind: "APPLIED" as const, stateVersion: nextVersion, eventSequence: nextSequence };
    });
  }

  async listEvents(groupId: string): Promise<readonly (typeof schema.pairGroupEvents.$inferSelect)[]> {
    return this.handle.db.select().from(schema.pairGroupEvents)
      .where(eq(schema.pairGroupEvents.groupId, groupId)).orderBy(asc(schema.pairGroupEvents.sequence));
  }

  async findDueEffects(nowMs: number, limit = 100): Promise<readonly PairEffectOutboxRow[]> {
    assertNonNegativeSafeInteger(nowMs, "now");
    assertNonNegativeSafeInteger(limit, "limit");
    if (limit === 0) return [];
    return this.handle.db.select().from(schema.pairEffectOutbox).where(and(
      eq(schema.pairEffectOutbox.state, "PENDING"),
      lte(schema.pairEffectOutbox.notBeforeMs, nowMs),
      lte(sql`${nowMs}`, schema.pairEffectOutbox.deadlineMs),
      isNull(schema.pairEffectOutbox.claimToken),
    )).orderBy(asc(schema.pairEffectOutbox.notBeforeMs), asc(schema.pairEffectOutbox.createdAtMs), asc(schema.pairEffectOutbox.id)).limit(limit);
  }

  async getEffect(effectId: string): Promise<PairEffectOutboxRow | null> {
    assertIdentity(effectId, "effect id");
    const rows = await this.handle.db.select().from(schema.pairEffectOutbox)
      .where(eq(schema.pairEffectOutbox.id, effectId)).limit(1);
    return rows[0] ?? null;
  }

  /** Re-read proof used immediately before a venue call. */
  async getClaimedEffect(input: { readonly effectId: string; readonly claimToken: string }): Promise<PairEffectOutboxRow | null> {
    assertIdentity(input.effectId, "effect id");
    assertIdentity(input.claimToken, "claim token");
    const rows = await this.handle.db.select().from(schema.pairEffectOutbox).where(and(
      eq(schema.pairEffectOutbox.id, input.effectId),
      eq(schema.pairEffectOutbox.state, "CLAIMED"),
      eq(schema.pairEffectOutbox.claimToken, input.claimToken),
    )).limit(1);
    return rows[0] ?? null;
  }

  /** Portable lease claim: candidate read plus a state/token compare-and-swap. */
  async claimNextDueEffect(input: { readonly nowMs: number; readonly leaseMs: number; readonly claimToken: string }): Promise<PairEffectOutboxRow | null> {
    assertNonNegativeSafeInteger(input.nowMs, "claim time");
    assertNonNegativeSafeInteger(input.leaseMs, "lease duration");
    assertIdentity(input.claimToken, "claim token");
    if (input.leaseMs === 0 || !Number.isSafeInteger(input.nowMs + input.leaseMs)) {
      throw new PairStoreValidationError("lease must be positive and end at a safe integer time");
    }
    const candidates = await this.findDueEffects(input.nowMs, 16);
    for (const candidate of candidates) {
      const claimed = await this.handle.db.update(schema.pairEffectOutbox).set({
        state: "CLAIMED", claimToken: input.claimToken, claimedAtMs: input.nowMs,
        claimExpiresAtMs: input.nowMs + input.leaseMs,
        attemptCount: sql`${schema.pairEffectOutbox.attemptCount} + 1`, updatedAtMs: input.nowMs,
      }).where(and(
        eq(schema.pairEffectOutbox.id, candidate.id), eq(schema.pairEffectOutbox.state, "PENDING"),
        isNull(schema.pairEffectOutbox.claimToken), lte(schema.pairEffectOutbox.notBeforeMs, input.nowMs),
        lte(sql`${input.nowMs}`, schema.pairEffectOutbox.deadlineMs),
      )).returning();
      if (claimed[0] !== undefined) return claimed[0];
    }
    return null;
  }

  async findExpiredClaims(nowMs: number, limit = 100): Promise<readonly PairEffectOutboxRow[]> {
    assertNonNegativeSafeInteger(nowMs, "now");
    assertNonNegativeSafeInteger(limit, "limit");
    if (limit === 0) return [];
    return this.handle.db.select().from(schema.pairEffectOutbox).where(and(
      eq(schema.pairEffectOutbox.state, "CLAIMED"), lte(schema.pairEffectOutbox.claimExpiresAtMs, nowMs),
    )).orderBy(asc(schema.pairEffectOutbox.claimExpiresAtMs), asc(schema.pairEffectOutbox.id)).limit(limit);
  }

  /**
   * Transfer ownership of one expired lease with an exact compare-and-swap.
   * A live lease is never eligible, and a concurrent recovery winner prevents
   * all other workers from observing or re-executing under stale ownership.
   */
  async claimNextExpiredEffect(input: { readonly nowMs: number; readonly leaseMs: number; readonly claimToken: string }): Promise<PairEffectOutboxRow | null> {
    assertNonNegativeSafeInteger(input.nowMs, "recovery claim time");
    assertNonNegativeSafeInteger(input.leaseMs, "recovery lease duration");
    assertIdentity(input.claimToken, "recovery claim token");
    if (input.leaseMs === 0 || !Number.isSafeInteger(input.nowMs + input.leaseMs)) {
      throw new PairStoreValidationError("recovery lease must be positive and end at a safe integer time");
    }
    const candidates = await this.findExpiredClaims(input.nowMs, 16);
    for (const candidate of candidates) {
      if (candidate.claimToken === null || candidate.claimExpiresAtMs === null) {
        throw new PairStoreError("claimed effect is missing durable lease identity");
      }
      const claimed = await this.handle.db.update(schema.pairEffectOutbox).set({
        claimToken: input.claimToken,
        claimedAtMs: input.nowMs,
        claimExpiresAtMs: input.nowMs + input.leaseMs,
        updatedAtMs: input.nowMs,
      }).where(and(
        eq(schema.pairEffectOutbox.id, candidate.id),
        eq(schema.pairEffectOutbox.state, "CLAIMED"),
        eq(schema.pairEffectOutbox.claimToken, candidate.claimToken),
        eq(schema.pairEffectOutbox.claimExpiresAtMs, candidate.claimExpiresAtMs),
        lte(schema.pairEffectOutbox.claimExpiresAtMs, input.nowMs),
      )).returning();
      if (claimed[0] !== undefined) return claimed[0];
    }
    return null;
  }

  /** Audit an actual expired-claim re-execution, after observe and legality. */
  async markClaimReexecutionAttempt(input: { readonly effectId: string; readonly claimToken: string; readonly nowMs: number }): Promise<PairEffectOutboxRow | null> {
    assertIdentity(input.effectId, "effect id");
    assertIdentity(input.claimToken, "claim token");
    assertNonNegativeSafeInteger(input.nowMs, "re-execution time");
    const rows = await this.handle.db.update(schema.pairEffectOutbox).set({
      attemptCount: sql`${schema.pairEffectOutbox.attemptCount} + 1`,
      updatedAtMs: input.nowMs,
    }).where(and(
      eq(schema.pairEffectOutbox.id, input.effectId),
      eq(schema.pairEffectOutbox.state, "CLAIMED"),
      eq(schema.pairEffectOutbox.claimToken, input.claimToken),
    )).returning();
    return rows[0] ?? null;
  }

  async ingestEvidence(input: PairInboxEvidenceInput): Promise<IngestPairEvidenceResult> {
    assertIdentity(input.id, "evidence id");
    assertIdentity(input.evidenceKey, "evidence key");
    assertIdentity(input.payloadHash, "payload hash");
    if (canonicalObjectHash(input.payload) !== input.payloadHash) {
      throw new PairStoreValidationError("evidence payload hash does not match canonical payload");
    }
    return this.handle.db.transaction(async (tx) => {
      const inserted = await tx.insert(schema.pairInboxEvidence).values({
        id: input.id, groupId: input.groupId, effectId: input.effectId ?? null,
        evidenceKey: input.evidenceKey, evidenceKind: input.evidenceKind,
        payloadHash: input.payloadHash, payload: canonicalJsonValue(input.payload) as never,
        sourceTsMs: input.sourceTsMs ?? null, receivedTsMs: input.receivedTsMs,
        createdAtMs: input.createdAtMs,
      }).onConflictDoNothing().returning();

      let evidence = inserted[0];
      let kind: "INSERTED" | "DUPLICATE" = "INSERTED";
      if (evidence === undefined) {
        kind = "DUPLICATE";
        const prior = await tx.select().from(schema.pairInboxEvidence)
          .where(eq(schema.pairInboxEvidence.evidenceKey, input.evidenceKey)).limit(1);
        evidence = prior[0];
        if (evidence === undefined) throw new PairStoreError("evidence insert conflicted without an existing evidence key");
        if (evidence.payloadHash !== input.payloadHash || evidence.groupId !== input.groupId || evidence.effectId !== (input.effectId ?? null)) {
          throw new PairStoreIdempotencyCollisionError("evidence key is bound to different payload or causal identity");
        }
      }

      if (input.effectId !== undefined && input.effectId !== null && input.effectTerminalState !== undefined) {
        const linked = await tx.update(schema.pairEffectOutbox).set({
          resultEvidenceId: evidence.id, state: input.effectTerminalState, updatedAtMs: input.receivedTsMs,
        }).where(and(
          eq(schema.pairEffectOutbox.id, input.effectId), eq(schema.pairEffectOutbox.groupId, input.groupId),
          or(isNull(schema.pairEffectOutbox.resultEvidenceId), eq(schema.pairEffectOutbox.resultEvidenceId, evidence.id)),
        )).returning();
        if (linked[0] === undefined) throw new PairStoreIdempotencyCollisionError("effect is missing, belongs to another group, or is linked to different evidence");
      }
      return { kind, evidence };
    });
  }

  async markEvidenceProcessed(input: { readonly evidenceKey: string; readonly processedAtMs: number; readonly processingResult: string }): Promise<boolean> {
    const updated = await this.handle.db.update(schema.pairInboxEvidence).set({
      processedAtMs: input.processedAtMs, processingResult: input.processingResult,
    }).where(and(eq(schema.pairInboxEvidence.evidenceKey, input.evidenceKey), isNull(schema.pairInboxEvidence.processedAtMs)))
      .returning();
    return updated[0] !== undefined;
  }
}
