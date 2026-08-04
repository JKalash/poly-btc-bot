import { schema, type Db, type DbHandle } from "@b5p/db";
import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";

export const MARKET_EXPOSURE_OWNER_KINDS = [
  "DIRECTIONAL_ORDER",
  "DIRECTIONAL_POSITION",
  "PAIR_GROUP",
] as const;

export type MarketExposureOwnerKind = (typeof MARKET_EXPOSURE_OWNER_KINDS)[number];
export type MarketExposureGuardRow = typeof schema.marketExposureGuards.$inferSelect;

export type TerminalMarketExposureOwner =
  | {
      readonly ownerKind: "DIRECTIONAL_ORDER";
      readonly terminalState: "CANCELED" | "REJECTED" | "EXPIRED" | "NO_FILL";
    }
  | { readonly ownerKind: "DIRECTIONAL_POSITION"; readonly terminalState: "FLAT" }
  | {
      readonly ownerKind: "PAIR_GROUP";
      readonly terminalState: "RECONCILED_FLAT" | "RECONCILED_SETTLED";
    };

export interface AcquireMarketExposureGuardInput {
  readonly marketId: string;
  readonly ownerKind: MarketExposureOwnerKind;
  readonly ownerId: string;
  readonly ownerState: string;
  readonly acquiredAtMs: number;
}

export interface UpdateMarketExposureGuardInput {
  readonly marketId: string;
  readonly expectedStateVersion: number;
  readonly ownerKind: MarketExposureOwnerKind;
  readonly ownerId: string;
  readonly nextOwnerKind: MarketExposureOwnerKind;
  readonly nextOwnerId: string;
  readonly nextOwnerState: string;
  readonly updatedAtMs: number;
}

export type ReleaseMarketExposureGuardInput = TerminalMarketExposureOwner & {
  readonly marketId: string;
  readonly ownerId: string;
  readonly expectedStateVersion: number;
  readonly releasedAtMs: number;
};

export type MarketExposureGuardConflictCode =
  | "MARKET_ACTIVE"
  | "OWNER_ACTIVE_ELSEWHERE"
  | "OWNER_MISMATCH"
  | "STALE_VERSION"
  | "ALREADY_RELEASED"
  | "NOT_FOUND"
  | "TIME_REGRESSION";

export type MarketExposureGuardAcquireResult =
  | { readonly kind: "ACQUIRED"; readonly guard: MarketExposureGuardRow }
  | { readonly kind: "IDEMPOTENT"; readonly guard: MarketExposureGuardRow }
  | { readonly kind: "CONFLICT"; readonly code: MarketExposureGuardConflictCode; readonly guard: MarketExposureGuardRow | null };

export type MarketExposureGuardUpdateResult =
  | { readonly kind: "UPDATED"; readonly guard: MarketExposureGuardRow }
  | { readonly kind: "IDEMPOTENT"; readonly guard: MarketExposureGuardRow }
  | { readonly kind: "CONFLICT"; readonly code: MarketExposureGuardConflictCode; readonly guard: MarketExposureGuardRow | null };

export type MarketExposureGuardReleaseResult =
  | { readonly kind: "RELEASED"; readonly guard: MarketExposureGuardRow }
  | { readonly kind: "IDEMPOTENT"; readonly guard: MarketExposureGuardRow }
  | { readonly kind: "CONFLICT"; readonly code: MarketExposureGuardConflictCode; readonly guard: MarketExposureGuardRow | null };

export class MarketExposureGuardValidationError extends Error {
  override readonly name = "MarketExposureGuardValidationError";
}

function assertIdentity(value: string, label: string): void {
  if (value.trim().length === 0) throw new MarketExposureGuardValidationError(`${label} must not be empty`);
}

function assertTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MarketExposureGuardValidationError(`${label} must be a non-negative safe integer`);
  }
}

function assertVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MarketExposureGuardValidationError("expectedStateVersion must be a non-negative safe integer");
  }
}

function assertOwnerKind(value: string): asserts value is MarketExposureOwnerKind {
  if (!(MARKET_EXPOSURE_OWNER_KINDS as readonly string[]).includes(value)) {
    throw new MarketExposureGuardValidationError(`unsupported ownerKind ${value}`);
  }
}

const TERMINAL_STATES: Readonly<Record<MarketExposureOwnerKind, readonly string[]>> = Object.freeze({
  DIRECTIONAL_ORDER: Object.freeze(["CANCELED", "REJECTED", "EXPIRED", "NO_FILL"]),
  DIRECTIONAL_POSITION: Object.freeze(["FLAT"]),
  PAIR_GROUP: Object.freeze(["RECONCILED_FLAT", "RECONCILED_SETTLED"]),
});

function assertTerminalState(ownerKind: MarketExposureOwnerKind, terminalState: string): void {
  if (!TERMINAL_STATES[ownerKind].includes(terminalState)) {
    throw new MarketExposureGuardValidationError(`${terminalState} is not terminal for ${ownerKind}`);
  }
}

function sameOwner(
  row: MarketExposureGuardRow,
  ownerKind: MarketExposureOwnerKind,
  ownerId: string,
): boolean {
  return row.ownerKind === ownerKind && row.ownerId === ownerId;
}

function isActive(row: MarketExposureGuardRow): boolean {
  return row.releasedAtMs === null;
}

function ownerUniqueConflict(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.includes("market_guards_owner_active_idx") ||
    (message.includes("duplicate key") && message.includes("owner_kind") && message.includes("owner_id"));
}

/**
 * One shared database CAS implementation for both directional and pair paths.
 * Use `transaction` when guard mutation must commit with its owning order,
 * position, or pair-group mutation.
 */
export class MarketExposureGuardStore {
  constructor(
    private readonly handle: DbHandle,
    private readonly executor: Db = handle.db,
  ) {}

  async transaction<T>(work: (guard: MarketExposureGuardStore, executor: Db) => Promise<T>): Promise<T> {
    return this.handle.db.transaction(async (tx) => {
      const executor = tx as unknown as Db;
      return work(new MarketExposureGuardStore(this.handle, executor), executor);
    });
  }

  async get(marketId: string): Promise<MarketExposureGuardRow | null> {
    assertIdentity(marketId, "marketId");
    return this.readMarket(marketId);
  }

  async findActiveByOwner(ownerKind: MarketExposureOwnerKind, ownerId: string): Promise<MarketExposureGuardRow | null> {
    assertIdentity(ownerId, "ownerId");
    const rows = await this.executor.select().from(schema.marketExposureGuards).where(and(
      eq(schema.marketExposureGuards.ownerKind, ownerKind),
      eq(schema.marketExposureGuards.ownerId, ownerId),
      isNull(schema.marketExposureGuards.releasedAtMs),
    )).limit(1);
    return rows[0] ?? null;
  }

  async acquire(input: AcquireMarketExposureGuardInput): Promise<MarketExposureGuardAcquireResult> {
    assertIdentity(input.marketId, "marketId");
    assertIdentity(input.ownerId, "ownerId");
    assertIdentity(input.ownerState, "ownerState");
    assertOwnerKind(input.ownerKind);
    assertTime(input.acquiredAtMs, "acquiredAtMs");
    const inserted = await this.executor.insert(schema.marketExposureGuards).values({
      marketId: input.marketId,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      ownerState: input.ownerState,
      stateVersion: 0,
      acquiredAtMs: input.acquiredAtMs,
      updatedAtMs: input.acquiredAtMs,
      releasedAtMs: null,
    }).onConflictDoNothing().returning();
    if (inserted[0] !== undefined) return { kind: "ACQUIRED", guard: inserted[0] };

    const current = await this.readMarket(input.marketId);
    if (current === null) {
      const elsewhere = await this.findActiveByOwner(input.ownerKind, input.ownerId);
      return { kind: "CONFLICT", code: "OWNER_ACTIVE_ELSEWHERE", guard: elsewhere };
    }
    if (isActive(current)) {
      if (sameOwner(current, input.ownerKind, input.ownerId)) return { kind: "IDEMPOTENT", guard: current };
      return { kind: "CONFLICT", code: "MARKET_ACTIVE", guard: current };
    }
    if (input.acquiredAtMs < current.updatedAtMs) {
      return { kind: "CONFLICT", code: "TIME_REGRESSION", guard: current };
    }
    const elsewhere = await this.findActiveByOwner(input.ownerKind, input.ownerId);
    if (elsewhere !== null) return { kind: "CONFLICT", code: "OWNER_ACTIVE_ELSEWHERE", guard: elsewhere };

    try {
      const claimed = await this.executor.update(schema.marketExposureGuards).set({
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        ownerState: input.ownerState,
        stateVersion: current.stateVersion + 1,
        acquiredAtMs: input.acquiredAtMs,
        updatedAtMs: input.acquiredAtMs,
        releasedAtMs: null,
      }).where(and(
        eq(schema.marketExposureGuards.marketId, input.marketId),
        eq(schema.marketExposureGuards.stateVersion, current.stateVersion),
        isNotNull(schema.marketExposureGuards.releasedAtMs),
        lte(schema.marketExposureGuards.updatedAtMs, input.acquiredAtMs),
      )).returning();
      if (claimed[0] !== undefined) return { kind: "ACQUIRED", guard: claimed[0] };
    } catch (error) {
      if (!ownerUniqueConflict(error)) throw error;
      const owner = await this.findActiveByOwner(input.ownerKind, input.ownerId);
      return { kind: "CONFLICT", code: "OWNER_ACTIVE_ELSEWHERE", guard: owner };
    }
    const raced = await this.readMarket(input.marketId);
    if (raced !== null && isActive(raced) && sameOwner(raced, input.ownerKind, input.ownerId)) {
      return { kind: "IDEMPOTENT", guard: raced };
    }
    return { kind: "CONFLICT", code: "MARKET_ACTIVE", guard: raced };
  }

  async update(input: UpdateMarketExposureGuardInput): Promise<MarketExposureGuardUpdateResult> {
    assertIdentity(input.marketId, "marketId");
    assertIdentity(input.ownerId, "ownerId");
    assertIdentity(input.nextOwnerId, "nextOwnerId");
    assertIdentity(input.nextOwnerState, "nextOwnerState");
    assertOwnerKind(input.ownerKind);
    assertOwnerKind(input.nextOwnerKind);
    assertVersion(input.expectedStateVersion);
    assertTime(input.updatedAtMs, "updatedAtMs");
    const before = await this.readMarket(input.marketId);
    const conflict = this.classifyExpected(before, input.expectedStateVersion, input.ownerKind, input.ownerId, input.updatedAtMs);
    if (conflict !== null) {
      if (
        before !== null && isActive(before) &&
        before.stateVersion === input.expectedStateVersion + 1 &&
        sameOwner(before, input.nextOwnerKind, input.nextOwnerId) &&
        before.ownerState === input.nextOwnerState
      ) return { kind: "IDEMPOTENT", guard: before };
      return conflict;
    }
    if (
      before!.ownerKind === input.nextOwnerKind &&
      before!.ownerId === input.nextOwnerId &&
      before!.ownerState === input.nextOwnerState
    ) return { kind: "IDEMPOTENT", guard: before! };

    try {
      const updated = await this.executor.update(schema.marketExposureGuards).set({
        ownerKind: input.nextOwnerKind,
        ownerId: input.nextOwnerId,
        ownerState: input.nextOwnerState,
        stateVersion: input.expectedStateVersion + 1,
        updatedAtMs: input.updatedAtMs,
      }).where(and(
        eq(schema.marketExposureGuards.marketId, input.marketId),
        eq(schema.marketExposureGuards.stateVersion, input.expectedStateVersion),
        eq(schema.marketExposureGuards.ownerKind, input.ownerKind),
        eq(schema.marketExposureGuards.ownerId, input.ownerId),
        isNull(schema.marketExposureGuards.releasedAtMs),
        lte(schema.marketExposureGuards.updatedAtMs, input.updatedAtMs),
      )).returning();
      if (updated[0] !== undefined) return { kind: "UPDATED", guard: updated[0] };
    } catch (error) {
      if (!ownerUniqueConflict(error)) throw error;
      const owner = await this.findActiveByOwner(input.nextOwnerKind, input.nextOwnerId);
      return { kind: "CONFLICT", code: "OWNER_ACTIVE_ELSEWHERE", guard: owner };
    }
    return this.classifyUpdateRace(input);
  }

  async release(input: ReleaseMarketExposureGuardInput): Promise<MarketExposureGuardReleaseResult> {
    assertIdentity(input.marketId, "marketId");
    assertIdentity(input.ownerId, "ownerId");
    assertOwnerKind(input.ownerKind);
    assertTerminalState(input.ownerKind, input.terminalState);
    assertVersion(input.expectedStateVersion);
    assertTime(input.releasedAtMs, "releasedAtMs");
    const before = await this.readMarket(input.marketId);
    if (
      before !== null && !isActive(before) && sameOwner(before, input.ownerKind, input.ownerId) &&
      before.ownerState === input.terminalState && before.stateVersion === input.expectedStateVersion + 1
    ) return { kind: "IDEMPOTENT", guard: before };
    const conflict = this.classifyExpected(before, input.expectedStateVersion, input.ownerKind, input.ownerId, input.releasedAtMs);
    if (conflict !== null) return conflict;
    const released = await this.executor.update(schema.marketExposureGuards).set({
      ownerState: input.terminalState,
      stateVersion: input.expectedStateVersion + 1,
      updatedAtMs: input.releasedAtMs,
      releasedAtMs: input.releasedAtMs,
    }).where(and(
      eq(schema.marketExposureGuards.marketId, input.marketId),
      eq(schema.marketExposureGuards.stateVersion, input.expectedStateVersion),
      eq(schema.marketExposureGuards.ownerKind, input.ownerKind),
      eq(schema.marketExposureGuards.ownerId, input.ownerId),
      isNull(schema.marketExposureGuards.releasedAtMs),
      lte(schema.marketExposureGuards.updatedAtMs, input.releasedAtMs),
    )).returning();
    if (released[0] !== undefined) return { kind: "RELEASED", guard: released[0] };
    const raced = await this.readMarket(input.marketId);
    if (
      raced !== null && !isActive(raced) && sameOwner(raced, input.ownerKind, input.ownerId) &&
      raced.ownerState === input.terminalState && raced.stateVersion === input.expectedStateVersion + 1
    ) return { kind: "IDEMPOTENT", guard: raced };
    return this.classifyExpected(raced, input.expectedStateVersion, input.ownerKind, input.ownerId, input.releasedAtMs)
      ?? { kind: "CONFLICT", code: "STALE_VERSION", guard: raced };
  }

  private async readMarket(marketId: string): Promise<MarketExposureGuardRow | null> {
    const rows = await this.executor.select().from(schema.marketExposureGuards)
      .where(eq(schema.marketExposureGuards.marketId, marketId)).limit(1);
    return rows[0] ?? null;
  }

  private classifyExpected(
    current: MarketExposureGuardRow | null,
    expectedVersion: number,
    ownerKind: MarketExposureOwnerKind,
    ownerId: string,
    atMs: number,
  ): { readonly kind: "CONFLICT"; readonly code: MarketExposureGuardConflictCode; readonly guard: MarketExposureGuardRow | null } | null {
    if (current === null) return { kind: "CONFLICT", code: "NOT_FOUND", guard: null };
    if (!isActive(current)) return { kind: "CONFLICT", code: "ALREADY_RELEASED", guard: current };
    if (!sameOwner(current, ownerKind, ownerId)) return { kind: "CONFLICT", code: "OWNER_MISMATCH", guard: current };
    if (current.stateVersion !== expectedVersion) return { kind: "CONFLICT", code: "STALE_VERSION", guard: current };
    if (atMs < current.updatedAtMs) return { kind: "CONFLICT", code: "TIME_REGRESSION", guard: current };
    return null;
  }

  private async classifyUpdateRace(input: UpdateMarketExposureGuardInput): Promise<MarketExposureGuardUpdateResult> {
    const current = await this.readMarket(input.marketId);
    if (
      current !== null && isActive(current) && current.stateVersion === input.expectedStateVersion + 1 &&
      sameOwner(current, input.nextOwnerKind, input.nextOwnerId) && current.ownerState === input.nextOwnerState
    ) return { kind: "IDEMPOTENT", guard: current };
    return this.classifyExpected(current, input.expectedStateVersion, input.ownerKind, input.ownerId, input.updatedAtMs)
      ?? { kind: "CONFLICT", code: "STALE_VERSION", guard: current };
  }
}
