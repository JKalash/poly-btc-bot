import { schema, type DbHandle } from "@b5p/db";
import { canonicalJsonValue, canonicalObjectHash, type PairGroupId } from "@b5p/pair-execution";
import {
  PAIR_LEDGER_ACCOUNTS,
  assertBalancedJournal,
  consumeInventoryFifo,
  createInventoryLot,
  fundingJournal,
  inventoryHoldings,
  releaseCashReservationJournal,
  replayPairLedger,
  reserveCashJournal,
  type JournalContext,
  type PairInventoryConsumption,
  type PairInventoryConsumptionKind,
  type PairInventoryLot,
  type PairLedgerAccount,
  type PairLedgerEntry,
  type PairLedgerJournal,
  type PairLedgerProjection,
} from "@b5p/pair-execution/internal/ledger";
import { and, asc, eq, inArray } from "drizzle-orm";

export type PairPaperAccountRow = typeof schema.pairPaperAccounts.$inferSelect;
export type PairInventoryLotRow = typeof schema.pairInventoryLots.$inferSelect;
export type PairInventoryConsumptionRow = typeof schema.pairInventoryConsumptions.$inferSelect;
export type PairLedgerEntryRow = typeof schema.pairLedgerEntries.$inferSelect;

export interface CreatePairAccountInput {
  readonly id: string;
  readonly sessionKey: string;
  readonly accountModel?: "ISOLATED_PAIR_PAPER";
  readonly sourceConfigVersion: number;
  readonly sourceBankrollSnapshotId?: bigint | null;
  readonly startingCash6: bigint;
  readonly dailyBucketUtc: string;
  readonly createdAtMs: number;
}

export type CreatePairAccountResult =
  | { readonly kind: "CREATED"; readonly account: PairPaperAccountRow }
  | { readonly kind: "DUPLICATE"; readonly account: PairPaperAccountRow };

export interface AppendPairAccountMutationInput {
  readonly accountId: string;
  readonly expectedStateVersion: number;
  readonly expectedEventSequence: number;
  readonly journal: PairLedgerJournal;
  readonly lots?: readonly PairInventoryLot[];
  readonly consumptions?: readonly PairInventoryConsumption[];
}

export type AppendPairAccountMutationResult =
  | { readonly kind: "APPLIED"; readonly account: PairPaperAccountRow }
  | { readonly kind: "DUPLICATE"; readonly account: PairPaperAccountRow }
  | { readonly kind: "CONFLICT"; readonly current: PairPaperAccountRow | null };

export interface AppendReservationInput {
  readonly accountId: string;
  readonly groupId: PairGroupId;
  readonly eventId: string;
  readonly journalId: string;
  readonly amount6: bigint;
  readonly expectedStateVersion: number;
  readonly expectedEventSequence: number;
  readonly occurredAtMs: number;
  readonly recordedAtMs: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface AppendFifoConsumptionInput {
  readonly accountId: string;
  readonly groupId: PairGroupId;
  readonly tokenId: string;
  readonly shares6: bigint;
  readonly eventId: string;
  readonly consumptionKind: PairInventoryConsumptionKind;
  readonly createdAtMs: number;
  readonly expectedStateVersion: number;
  readonly expectedEventSequence: number;
  readonly buildJournal: (allocation: {
    readonly consumptions: readonly PairInventoryConsumption[];
    readonly allocatedPrincipalCost6: bigint;
    readonly allocatedBuyCashFee6: bigint;
  }) => PairLedgerJournal;
}

export type AppendFifoConsumptionResult =
  | (AppendPairAccountMutationResult & { readonly consumptions?: readonly PairInventoryConsumption[] })
  | { readonly kind: "INSUFFICIENT_INVENTORY"; readonly availableShares6: bigint; readonly requestedShares6: bigint };

export interface PairAccountState {
  readonly account: PairPaperAccountRow;
  readonly ledgerEntries: readonly PairLedgerEntry[];
  readonly ledger: PairLedgerProjection;
  readonly lots: readonly PairInventoryLot[];
  readonly consumptions: readonly PairInventoryConsumption[];
  readonly holdingsByToken: Readonly<Record<string, bigint>>;
}

export class PairAccountStoreError extends Error {}
export class PairAccountValidationError extends PairAccountStoreError {}
export class PairAccountIdempotencyCollisionError extends PairAccountStoreError {
  readonly code = "PAIR_ACCOUNT_IDEMPOTENCY_COLLISION" as const;
}
export class PairAccountProjectionDriftError extends PairAccountStoreError {
  readonly code = "PAIR_ACCOUNT_PROJECTION_DRIFT" as const;
}

function assertIdentity(value: string, label: string): void {
  if (value.length === 0) throw new PairAccountValidationError(`${label} must be non-empty`);
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PairAccountValidationError(`${label} must be a non-negative safe integer`);
  }
}

function journalContext(input: AppendReservationInput, causationKind: string): JournalContext {
  return {
    journalId: input.journalId,
    pairAccountId: input.accountId,
    groupId: input.groupId,
    causationEventId: input.eventId,
    causationKind,
    occurredAtMs: input.occurredAtMs,
    recordedAtMs: input.recordedAtMs,
    metadata: input.metadata,
  };
}

function rowToLedgerEntry(row: PairLedgerEntryRow): PairLedgerEntry {
  if (!(PAIR_LEDGER_ACCOUNTS as readonly string[]).includes(row.account)) {
    throw new PairAccountProjectionDriftError(`unknown persisted ledger account ${row.account}`);
  }
  return {
    entryId: row.id as PairLedgerEntry["entryId"],
    journalId: row.journalId,
    lineNumber: row.lineNumber,
    pairAccountId: row.pairAccountId,
    groupId: row.groupId as PairGroupId | null,
    causationEventId: row.eventId,
    causationKind: "PERSISTED",
    account: row.account as PairLedgerAccount,
    assetId: row.assetId,
    amount6: row.amount6,
    inventoryLotId: row.inventoryLotId,
    inventoryConsumptionId: row.inventoryConsumptionId,
    orderId: row.orderId,
    fillId: row.fillId,
    occurredAtMs: row.occurredAtMs,
    recordedAtMs: row.recordedAtMs,
    schemaVersion: 1,
    metadata: Object.freeze({ ...(row.metadata as Record<string, string>) }),
  };
}

function rowToLot(row: PairInventoryLotRow): PairInventoryLot {
  return createInventoryLot({
    lotId: row.id,
    groupId: row.groupId as PairGroupId,
    marketId: row.marketId,
    tokenId: row.tokenId,
    outcome: row.outcome as PairInventoryLot["outcome"],
    sourceFillId: row.sourceFillId,
    grossShares6: row.grossShares6,
    netShares6: row.netShares6,
    principalCost6: row.principalCost6,
    cashFee6: row.cashFee6,
    shareFee6: row.shareFee6,
    acquiredAtMs: row.acquiredAtMs,
  });
}

function rowToConsumption(row: PairInventoryConsumptionRow): PairInventoryConsumption {
  return Object.freeze({
    consumptionId: row.id,
    lotId: row.lotId,
    groupId: row.groupId as PairGroupId,
    eventId: row.eventId,
    consumptionKind: row.consumptionKind as PairInventoryConsumptionKind,
    shares6: row.shares6,
    allocatedPrincipalCost6: row.allocatedPrincipalCost6,
    allocatedBuyCashFee6: row.allocatedBuyCashFee6,
    createdAtMs: row.createdAtMs,
  });
}

function persistentJournalShape(entries: readonly PairLedgerEntry[]): unknown {
  return entries.map((entry) => ({
    id: entry.entryId,
    journalId: entry.journalId,
    lineNumber: entry.lineNumber,
    pairAccountId: entry.pairAccountId,
    groupId: entry.groupId,
    eventId: entry.causationEventId,
    account: entry.account,
    assetId: entry.assetId,
    amount6: entry.amount6,
    inventoryLotId: entry.inventoryLotId,
    inventoryConsumptionId: entry.inventoryConsumptionId,
    orderId: entry.orderId,
    fillId: entry.fillId,
    metadata: entry.metadata,
    occurredAtMs: entry.occurredAtMs,
    recordedAtMs: entry.recordedAtMs,
  }));
}

function deriveCashMovements(entries: readonly PairLedgerEntry[]): { debits6: bigint; credits6: bigint } {
  const journals = new Map<string, { groupId: PairGroupId | null; cashChange6: bigint }>();
  for (const entry of entries) {
    const prior = journals.get(entry.journalId) ?? { groupId: entry.groupId, cashChange6: 0n };
    if (entry.account === "ASSET_CASH_AVAILABLE" || entry.account === "ASSET_CASH_RESERVED") {
      prior.cashChange6 += entry.amount6;
    }
    journals.set(entry.journalId, prior);
  }
  let debits6 = 0n;
  let credits6 = 0n;
  for (const value of journals.values()) {
    if (value.groupId === null) continue; // account funding is capital, not trading cash flow
    if (value.cashChange6 < 0n) debits6 -= value.cashChange6;
    else credits6 += value.cashChange6;
  }
  return { debits6, credits6 };
}

function validateJournalForAccount(accountId: string, journal: PairLedgerJournal): void {
  assertIdentity(journal.journalId, "journal id");
  if (journal.entries.length === 0) throw new PairAccountValidationError("journal must contain entries");
  assertBalancedJournal(journal);
  for (const [index, entry] of journal.entries.entries()) {
    if (entry.journalId !== journal.journalId || entry.lineNumber !== index) {
      throw new PairAccountValidationError("journal lines must be contiguous and belong to the journal");
    }
    if (entry.pairAccountId !== accountId) throw new PairAccountValidationError("journal belongs to another pair account");
    if (entry.schemaVersion !== 1) throw new PairAccountValidationError("unsupported pair ledger schema version");
  }
  const groupIds = new Set(journal.entries.map((entry) => entry.groupId));
  const eventIds = new Set(journal.entries.map((entry) => entry.causationEventId));
  if (groupIds.size !== 1 || eventIds.size !== 1) {
    throw new PairAccountValidationError("one journal cannot cross group or causation boundaries");
  }
}

function validateAccountIdentity(existing: PairPaperAccountRow, input: CreatePairAccountInput): void {
  if (existing.id !== input.id || existing.accountModel !== (input.accountModel ?? "ISOLATED_PAIR_PAPER") ||
      existing.sourceConfigVersion !== input.sourceConfigVersion || existing.startingCash6 !== input.startingCash6 ||
      existing.sourceBankrollSnapshotId !== (input.sourceBankrollSnapshotId ?? null) || existing.dailyBucketUtc !== input.dailyBucketUtc) {
    throw new PairAccountIdempotencyCollisionError("session key is bound to different immutable account parameters");
  }
}

/** Durable, isolated pair-paper cash, inventory-lot, and balanced-ledger adapter. */
export class PairAccountStore {
  constructor(private readonly handle: DbHandle) {}

  async createAccount(input: CreatePairAccountInput): Promise<CreatePairAccountResult> {
    assertIdentity(input.id, "account id");
    assertIdentity(input.sessionKey, "session key");
    assertIdentity(input.dailyBucketUtc, "daily UTC bucket");
    assertNonNegativeSafeInteger(input.sourceConfigVersion, "source config version");
    assertNonNegativeSafeInteger(input.createdAtMs, "creation time");
    if (input.startingCash6 <= 0n) throw new PairAccountValidationError("starting cash must be positive");

    return this.handle.db.transaction(async (tx) => {
      const prior = await tx.select().from(schema.pairPaperAccounts)
        .where(eq(schema.pairPaperAccounts.sessionKey, input.sessionKey)).limit(1);
      if (prior[0] !== undefined) {
        validateAccountIdentity(prior[0], input);
        return { kind: "DUPLICATE" as const, account: prior[0] };
      }

      const journal = fundingJournal({
        journalId: `pair-account-funding:${input.id}`,
        pairAccountId: input.id,
        groupId: null,
        causationEventId: null,
        causationKind: "PAIR_ACCOUNT_FUNDED",
        occurredAtMs: input.createdAtMs,
        recordedAtMs: input.createdAtMs,
        metadata: { sessionKey: input.sessionKey },
      }, input.startingCash6);

      const inserted = await tx.insert(schema.pairPaperAccounts).values({
        id: input.id,
        accountModel: input.accountModel ?? "ISOLATED_PAIR_PAPER",
        sessionKey: input.sessionKey,
        sourceConfigVersion: input.sourceConfigVersion,
        sourceBankrollSnapshotId: input.sourceBankrollSnapshotId ?? null,
        startingCash6: input.startingCash6,
        cashAvailable6: input.startingCash6,
        cashReserved6: 0n,
        cashDebits6: 0n,
        cashCredits6: 0n,
        realizedPnl6: 0n,
        peakCash6: input.startingCash6,
        sessionDrawdown6: 0n,
        dailyRealizedPnl6: 0n,
        dailyBucketUtc: input.dailyBucketUtc,
        eventSequence: 1,
        stateVersion: 1,
        reconciliationStatus: "NOT_STARTED",
        createdAtMs: input.createdAtMs,
        updatedAtMs: input.createdAtMs,
      }).returning();
      await tx.insert(schema.pairLedgerEntries).values(journal.entries.map((entry) => ({
        id: entry.entryId,
        pairAccountId: entry.pairAccountId,
        groupId: entry.groupId,
        journalId: entry.journalId,
        eventId: entry.causationEventId,
        lineNumber: entry.lineNumber,
        account: entry.account,
        assetId: entry.assetId,
        amount6: entry.amount6,
        inventoryLotId: entry.inventoryLotId,
        inventoryConsumptionId: entry.inventoryConsumptionId,
        orderId: entry.orderId,
        fillId: entry.fillId,
        metadata: canonicalJsonValue(entry.metadata) as never,
        occurredAtMs: entry.occurredAtMs,
        recordedAtMs: entry.recordedAtMs,
      })));
      return { kind: "CREATED" as const, account: inserted[0]! };
    });
  }

  async appendReservation(input: AppendReservationInput): Promise<AppendPairAccountMutationResult> {
    return this.appendMutation({
      accountId: input.accountId,
      expectedStateVersion: input.expectedStateVersion,
      expectedEventSequence: input.expectedEventSequence,
      journal: reserveCashJournal(journalContext(input, "PAIR_CASH_RESERVED"), input.amount6),
    });
  }

  async releaseReservation(input: AppendReservationInput): Promise<AppendPairAccountMutationResult> {
    return this.appendMutation({
      accountId: input.accountId,
      expectedStateVersion: input.expectedStateVersion,
      expectedEventSequence: input.expectedEventSequence,
      journal: releaseCashReservationJournal(journalContext(input, "PAIR_CASH_RESERVATION_RELEASED"), input.amount6),
    });
  }

  async appendFifoConsumption(input: AppendFifoConsumptionInput): Promise<AppendFifoConsumptionResult> {
    const inventory = await this.loadInventory(input.accountId, input.groupId);
    const allocation = consumeInventoryFifo({
      lots: inventory.lots,
      existingConsumptions: inventory.consumptions,
      groupId: input.groupId,
      tokenId: input.tokenId,
      shares6: input.shares6,
      eventId: input.eventId,
      consumptionKind: input.consumptionKind,
      createdAtMs: input.createdAtMs,
    });
    if (!allocation.ok) {
      return { kind: "INSUFFICIENT_INVENTORY", availableShares6: allocation.availableShares6, requestedShares6: allocation.requestedShares6 };
    }
    const result = await this.appendMutation({
      accountId: input.accountId,
      expectedStateVersion: input.expectedStateVersion,
      expectedEventSequence: input.expectedEventSequence,
      journal: input.buildJournal(allocation),
      consumptions: allocation.consumptions,
    });
    return { ...result, consumptions: result.kind === "CONFLICT" ? undefined : allocation.consumptions };
  }

  async appendMutation(input: AppendPairAccountMutationInput): Promise<AppendPairAccountMutationResult> {
    assertIdentity(input.accountId, "account id");
    assertNonNegativeSafeInteger(input.expectedStateVersion, "expected state version");
    assertNonNegativeSafeInteger(input.expectedEventSequence, "expected event sequence");
    validateJournalForAccount(input.accountId, input.journal);
    const newLots = [...(input.lots ?? [])];
    const newConsumptions = [...(input.consumptions ?? [])];
    for (const lot of newLots) createInventoryLot({ ...lot, totalCashCost6: undefined } as never);

    return this.handle.db.transaction(async (tx) => {
      const persistedJournalRows = await tx.select().from(schema.pairLedgerEntries)
        .where(eq(schema.pairLedgerEntries.journalId, input.journal.journalId))
        .orderBy(asc(schema.pairLedgerEntries.lineNumber));
      if (persistedJournalRows.length > 0) {
        const persisted = persistedJournalRows.map(rowToLedgerEntry);
        if (canonicalObjectHash(persistentJournalShape(persisted)) !== canonicalObjectHash(persistentJournalShape(input.journal.entries))) {
          throw new PairAccountIdempotencyCollisionError("journal id is bound to different immutable entries");
        }
        const account = await tx.select().from(schema.pairPaperAccounts)
          .where(eq(schema.pairPaperAccounts.id, input.accountId)).limit(1);
        if (account[0] === undefined) throw new PairAccountProjectionDriftError("journal exists without its pair account");
        return { kind: "DUPLICATE" as const, account: account[0] };
      }

      const accountRows = await tx.select().from(schema.pairPaperAccounts)
        .where(eq(schema.pairPaperAccounts.id, input.accountId)).limit(1);
      const account = accountRows[0];
      if (account === undefined || account.stateVersion !== input.expectedStateVersion || account.eventSequence !== input.expectedEventSequence) {
        return { kind: "CONFLICT" as const, current: account ?? null };
      }

      const journalGroupId = input.journal.entries[0]!.groupId;
      if (journalGroupId === null) throw new PairAccountValidationError("only account creation may post a group-less journal");
      const groupRows = await tx.select().from(schema.pairOrderGroups)
        .where(eq(schema.pairOrderGroups.id, journalGroupId)).limit(1);
      const group = groupRows[0];
      if (group === undefined || group.pairAccountId !== input.accountId) {
        throw new PairAccountValidationError("journal group does not belong to the pair account");
      }

      for (const lot of newLots) {
        if (lot.groupId !== journalGroupId || lot.marketId !== group.marketId) {
          throw new PairAccountValidationError("inventory lot crosses its journal group or market boundary");
        }
      }

      const persistedLotRows = await tx.select().from(schema.pairInventoryLots)
        .where(eq(schema.pairInventoryLots.groupId, journalGroupId))
        .orderBy(asc(schema.pairInventoryLots.acquiredAtMs), asc(schema.pairInventoryLots.id));
      const allLots = [...persistedLotRows.map(rowToLot), ...newLots];
      const lotIds = allLots.map((lot) => lot.lotId);
      const persistedConsumptionRows = lotIds.length === 0 ? [] : await tx.select().from(schema.pairInventoryConsumptions)
        .where(inArray(schema.pairInventoryConsumptions.lotId, lotIds))
        .orderBy(asc(schema.pairInventoryConsumptions.createdAtMs), asc(schema.pairInventoryConsumptions.id));
      const existingConsumptions = persistedConsumptionRows.map(rowToConsumption);
      this.validateFifoConsumptions(journalGroupId, input.journal, allLots, existingConsumptions, newConsumptions);

      const knownLots = new Map(allLots.map((lot) => [lot.lotId, lot]));
      const knownConsumptions = new Set([...existingConsumptions, ...newConsumptions].map((item) => item.consumptionId));
      for (const entry of input.journal.entries) {
        if (entry.inventoryLotId !== null && !knownLots.has(entry.inventoryLotId)) {
          throw new PairAccountValidationError(`ledger entry references unknown inventory lot ${entry.inventoryLotId}`);
        }
        if (entry.inventoryConsumptionId !== null && !knownConsumptions.has(entry.inventoryConsumptionId)) {
          throw new PairAccountValidationError(`ledger entry references unknown inventory consumption ${entry.inventoryConsumptionId}`);
        }
      }

      const priorRows = await tx.select().from(schema.pairLedgerEntries)
        .where(eq(schema.pairLedgerEntries.pairAccountId, input.accountId))
        .orderBy(asc(schema.pairLedgerEntries.recordedAtMs), asc(schema.pairLedgerEntries.journalId), asc(schema.pairLedgerEntries.lineNumber));
      const allEntries = [...priorRows.map(rowToLedgerEntry), ...input.journal.entries];
      const replay = replayPairLedger(allEntries);
      if (replay.cashAvailable6 < 0n || replay.cashReserved6 < 0n) {
        throw new PairAccountValidationError("account mutation would make available or reserved cash negative");
      }
      const movements = deriveCashMovements(allEntries);
      const accountCash6 = replay.accountCash6;
      const peakCash6 = accountCash6 > account.peakCash6 ? accountCash6 : account.peakCash6;
      const nextVersion = input.expectedStateVersion + 1;
      const nextSequence = input.expectedEventSequence + 1;
      const updated = await tx.update(schema.pairPaperAccounts).set({
        cashAvailable6: replay.cashAvailable6,
        cashReserved6: replay.cashReserved6,
        cashDebits6: movements.debits6,
        cashCredits6: movements.credits6,
        realizedPnl6: replay.terminalRealizedPnl6,
        peakCash6,
        sessionDrawdown6: peakCash6 - accountCash6,
        dailyRealizedPnl6: replay.terminalRealizedPnl6,
        eventSequence: nextSequence,
        stateVersion: nextVersion,
        reconciliationStatus: "PENDING",
        updatedAtMs: Math.max(...input.journal.entries.map((entry) => entry.recordedAtMs)),
      }).where(and(
        eq(schema.pairPaperAccounts.id, input.accountId),
        eq(schema.pairPaperAccounts.stateVersion, input.expectedStateVersion),
        eq(schema.pairPaperAccounts.eventSequence, input.expectedEventSequence),
      )).returning();
      if (updated[0] === undefined) {
        const current = await tx.select().from(schema.pairPaperAccounts)
          .where(eq(schema.pairPaperAccounts.id, input.accountId)).limit(1);
        return { kind: "CONFLICT" as const, current: current[0] ?? null };
      }

      if (newLots.length > 0) {
        await tx.insert(schema.pairInventoryLots).values(newLots.map((lot) => ({
          id: lot.lotId,
          groupId: lot.groupId,
          marketId: lot.marketId,
          tokenId: lot.tokenId,
          outcome: lot.outcome,
          sourceFillId: lot.sourceFillId,
          grossShares6: lot.grossShares6,
          netShares6: lot.netShares6,
          principalCost6: lot.principalCost6,
          cashFee6: lot.cashFee6,
          shareFee6: lot.shareFee6,
          acquiredAtMs: lot.acquiredAtMs,
          createdAtMs: lot.acquiredAtMs,
        })));
      }
      if (newConsumptions.length > 0) {
        await tx.insert(schema.pairInventoryConsumptions).values(newConsumptions.map((item) => ({
          id: item.consumptionId,
          lotId: item.lotId,
          groupId: item.groupId,
          eventId: item.eventId,
          consumptionKind: item.consumptionKind,
          shares6: item.shares6,
          allocatedPrincipalCost6: item.allocatedPrincipalCost6,
          allocatedBuyCashFee6: item.allocatedBuyCashFee6,
          createdAtMs: item.createdAtMs,
        })));
      }
      await tx.insert(schema.pairLedgerEntries).values(input.journal.entries.map((entry) => ({
        id: entry.entryId,
        pairAccountId: entry.pairAccountId,
        groupId: entry.groupId,
        journalId: entry.journalId,
        eventId: entry.causationEventId,
        lineNumber: entry.lineNumber,
        account: entry.account,
        assetId: entry.assetId,
        amount6: entry.amount6,
        inventoryLotId: entry.inventoryLotId,
        inventoryConsumptionId: entry.inventoryConsumptionId,
        orderId: entry.orderId,
        fillId: entry.fillId,
        metadata: canonicalJsonValue(entry.metadata) as never,
        occurredAtMs: entry.occurredAtMs,
        recordedAtMs: entry.recordedAtMs,
      })));
      return { kind: "APPLIED" as const, account: updated[0] };
    });
  }

  async loadState(accountId: string): Promise<PairAccountState | null> {
    const state = await this.loadAuthoritativeState(accountId);
    if (state === null) return null;
    const { account, ledger } = state;
    if (ledger.cashAvailable6 !== account.cashAvailable6 || ledger.cashReserved6 !== account.cashReserved6 ||
        ledger.terminalRealizedPnl6 !== account.realizedPnl6) {
      throw new PairAccountProjectionDriftError("pair account projection differs from its immutable ledger replay");
    }
    return state;
  }

  /**
   * Load immutable ledger/lot truth without trusting the mutable account
   * projection. Reconciliation is the sole consumer allowed to use this path.
   */
  async loadAuthoritativeState(accountId: string): Promise<PairAccountState | null> {
    const rows = await this.handle.db.select().from(schema.pairPaperAccounts)
      .where(eq(schema.pairPaperAccounts.id, accountId)).limit(1);
    const account = rows[0];
    if (account === undefined) return null;
    const ledgerRows = await this.handle.db.select().from(schema.pairLedgerEntries)
      .where(eq(schema.pairLedgerEntries.pairAccountId, accountId))
      .orderBy(asc(schema.pairLedgerEntries.recordedAtMs), asc(schema.pairLedgerEntries.journalId), asc(schema.pairLedgerEntries.lineNumber));
    const ledgerEntries = ledgerRows.map(rowToLedgerEntry);
    const ledger = replayPairLedger(ledgerEntries);
    const inventory = await this.loadInventory(accountId);
    return {
      account,
      ledgerEntries,
      ledger,
      lots: inventory.lots,
      consumptions: inventory.consumptions,
      holdingsByToken: inventoryHoldings(inventory.lots, inventory.consumptions),
    };
  }

  private async loadInventory(accountId: string, groupId?: PairGroupId): Promise<{
    readonly lots: readonly PairInventoryLot[];
    readonly consumptions: readonly PairInventoryConsumption[];
  }> {
    const groups = await this.handle.db.select({ id: schema.pairOrderGroups.id }).from(schema.pairOrderGroups)
      .where(groupId === undefined
        ? eq(schema.pairOrderGroups.pairAccountId, accountId)
        : and(eq(schema.pairOrderGroups.pairAccountId, accountId), eq(schema.pairOrderGroups.id, groupId)));
    const groupIds = groups.map(({ id }) => id);
    if (groupIds.length === 0) return { lots: [], consumptions: [] };
    const lotRows = await this.handle.db.select().from(schema.pairInventoryLots)
      .where(inArray(schema.pairInventoryLots.groupId, groupIds))
      .orderBy(asc(schema.pairInventoryLots.acquiredAtMs), asc(schema.pairInventoryLots.id));
    const lots = lotRows.map(rowToLot);
    if (lots.length === 0) return { lots, consumptions: [] };
    const consumptionRows = await this.handle.db.select().from(schema.pairInventoryConsumptions)
      .where(inArray(schema.pairInventoryConsumptions.lotId, lots.map((lot) => lot.lotId)))
      .orderBy(asc(schema.pairInventoryConsumptions.createdAtMs), asc(schema.pairInventoryConsumptions.id));
    return { lots, consumptions: consumptionRows.map(rowToConsumption) };
  }

  private validateFifoConsumptions(
    groupId: PairGroupId,
    journal: PairLedgerJournal,
    lots: readonly PairInventoryLot[],
    existing: readonly PairInventoryConsumption[],
    appended: readonly PairInventoryConsumption[],
  ): void {
    if (appended.length === 0) return;
    const lotById = new Map(lots.map((lot) => [lot.lotId, lot]));
    const journalEventId = journal.entries[0]!.causationEventId;
    const buckets = new Map<string, PairInventoryConsumption[]>();
    for (const item of appended) {
      const lot = lotById.get(item.lotId);
      if (lot === undefined || lot.groupId !== groupId || item.groupId !== groupId) {
        throw new PairAccountValidationError("inventory consumption crosses group ownership");
      }
      if (item.eventId !== journalEventId) throw new PairAccountValidationError("consumption causation differs from its journal");
      const key = `${item.eventId}\u0000${item.consumptionKind}\u0000${lot.tokenId}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(item);
      buckets.set(key, bucket);
    }
    for (const bucket of buckets.values()) {
      const first = bucket[0]!;
      const lot = lotById.get(first.lotId)!;
      const expected = consumeInventoryFifo({
        lots,
        existingConsumptions: existing,
        groupId,
        tokenId: lot.tokenId,
        shares6: bucket.reduce((sum, item) => sum + item.shares6, 0n),
        eventId: first.eventId,
        consumptionKind: first.consumptionKind,
        createdAtMs: first.createdAtMs,
        consumptionId: (candidate) => bucket.find((item) => item.lotId === candidate.lotId)?.consumptionId ?? "",
      });
      if (!expected.ok || canonicalObjectHash(expected.consumptions) !== canonicalObjectHash(bucket)) {
        throw new PairAccountValidationError("inventory consumptions do not match exact group-local FIFO allocation");
      }
    }
  }
}
