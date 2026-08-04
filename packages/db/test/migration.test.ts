/**
 * BPAIR-020 migration tests.
 *
 * Verifies the single forward pair migration (0006_*):
 *  1. fresh database: 0000..0006 apply cleanly on PGlite memory://;
 *  2. populated upgrade: a database staged at 0005 with representative legacy
 *     rows upgrades via 0006 with all legacy rows still readable and every new
 *     column present and nullable;
 *  3. idempotency: re-running migrate() is a tracked no-op.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { afterAll, describe, expect, it } from "vitest";
import { makeDb, type DbHandle } from "../src/client";
import * as schema from "../src/schema";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

interface JournalEntry { idx: number; tag: string; }
interface Journal { entries: JournalEntry[]; }

const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as Journal;
const latest = journal.entries[journal.entries.length - 1]!;

async function rows(db: DbHandle["db"], query: ReturnType<typeof sql>): Promise<any[]> {
  const res: any = await db.execute(query);
  return res.rows ?? res;
}

async function appliedMigrationCount(db: DbHandle["db"]): Promise<number> {
  const r = await rows(db, sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
  return Number(r[0].n);
}

const NEW_TABLES = [
  "pair_opportunity_episodes", "pair_book_captures", "pair_paper_accounts",
  "pair_opportunity_observations", "pair_observer_bucket_stats", "pair_order_groups",
  "market_exposure_guards", "pair_group_events", "pair_action_intents",
  "pair_inventory_lots", "pair_inventory_consumptions", "pair_ledger_entries",
  "pair_effect_outbox", "pair_paper_venue_operations", "pair_inbox_evidence",
  "pair_reconciliations", "pair_reconciliation_diffs", "pair_research_runs",
  "pair_research_scenarios", "pair_research_episode_results", "pair_research_artifacts",
  "orderbook_events",
];

describe("fresh database migration (0000..latest)", () => {
  let handle: DbHandle;

  afterAll(async () => { await handle?.close(); });

  it("applies every migration on PGlite memory://", async () => {
    handle = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
    await handle.migrate();
    expect(latest.tag).toMatch(/^0006_/); // this suite exists to cover the pair migration
    expect(await appliedMigrationCount(handle.db)).toBe(journal.entries.length);
  }, 120_000);

  it("creates all Section 18 tables", async () => {
    const r = await rows(handle.db, sql`
      select tablename from pg_tables where schemaname = 'public'`);
    const names = new Set(r.map((x) => x.tablename));
    for (const t of NEW_TABLES) expect(names, `missing table ${t}`).toContain(t);
  });

  it("keeps partial-index WHERE predicates (drizzle-kit generation risk)", async () => {
    const expectPredicate = async (indexname: string, fragment: string) => {
      const r = await rows(handle.db, sql`
        select indexdef from pg_indexes where indexname = ${indexname}`);
      expect(r, `index ${indexname} missing`).toHaveLength(1);
      expect(r[0].indexdef).toContain("WHERE");
      expect(r[0].indexdef).toContain(fragment);
    };
    await expectPredicate("pair_groups_active_market_idx", "SCHEDULED");
    await expectPredicate("market_guards_owner_active_idx", "released_at_ms IS NULL");
    await expectPredicate("pair_episodes_open_market_idx", "closed_at_ms IS NULL");
    await expectPredicate("orders_client_order_id_idx", "client_order_id IS NOT NULL");
    await expectPredicate("orders_effect_id_idx", "effect_id IS NOT NULL");
    await expectPredicate("pair_action_intents_order_intent_idx", "order_intent_id IS NOT NULL");
    await expectPredicate("pair_ledger_fill_idx", "fill_id IS NOT NULL");
    await expectPredicate("pair_research_artifacts_run_level_idx", "scenario_id IS NULL");
    await expectPredicate("constraint_snapshots_token_canonical_idx", "token_id IS NOT NULL");
    await expectPredicate("fee_snapshots_token_canonical_idx", "token_id IS NOT NULL");
  });

  it("wires the composite outbox->action-intent FK onto the composite unique", async () => {
    const uq = await rows(handle.db, sql`
      select conname from pg_constraint
      where conname = 'pair_action_intents_composite_idx' and contype = 'u'`);
    expect(uq).toHaveLength(1);
    const fk = await rows(handle.db, sql`
      select array_length(conkey, 1) as ncols, confrelid::regclass::text as target
      from pg_constraint
      where conname = 'pair_effect_outbox_action_composite_fk' and contype = 'f'`);
    expect(fk).toHaveLength(1);
    expect(Number(fk[0].ncols)).toBe(3);
    expect(fk[0].target).toBe("pair_action_intents");
  });

  it("wires pair_book_captures.data_cutoff_event_id -> orderbook_events.id", async () => {
    const fk = await rows(handle.db, sql`
      select confrelid::regclass::text as target from pg_constraint
      where conname = 'pair_book_captures_data_cutoff_event_id_orderbook_events_id_fk' and contype = 'f'`);
    expect(fk).toHaveLength(1);
    expect(fk[0].target).toBe("orderbook_events");
  });

  it("enforces the orderbook_events envelope uniqueness and accepts inserts", async () => {
    await handle.db.insert(schema.orderbookEvents).values({
      marketId: "m-obe", tokenId: "tok-1", eventKind: "SNAPSHOT",
      connectionEpoch: "epoch-1", envelopeId: "env-1", sequenceInEnvelope: 0,
      sourceTimestampKind: "SOURCE", sourceTsMs: 1_700_000_000_000,
      receivedTsMs: 1_700_000_000_001, payloadHash: "ph-1", payload: { bids: [], asks: [] },
      createdAtMs: 1_700_000_000_002,
    });
    await expect(
      handle.db.insert(schema.orderbookEvents).values({
        marketId: "m-obe", tokenId: "tok-1", eventKind: "DELTA",
        connectionEpoch: "epoch-1", envelopeId: "env-1", sequenceInEnvelope: 0,
        sourceTimestampKind: "RECEIVE_FALLBACK",
        receivedTsMs: 1_700_000_000_003, payloadHash: "ph-2", payload: {},
        createdAtMs: 1_700_000_000_004,
      }),
    ).rejects.toThrow(/orderbook_events_envelope_idx|duplicate key/);
  });
});

describe("populated upgrade 0005 -> 0006", () => {
  const staged = mkdtempSync(path.join(tmpdir(), "b5p-staged-migrations-"));
  let handle: DbHandle;

  afterAll(async () => {
    await handle?.close();
    rmSync(staged, { recursive: true, force: true });
  });

  it("stages a real pre-pair database at migration 0005", async () => {
    const priorEntries = journal.entries.filter((e) => e.idx <= 5);
    expect(priorEntries).toHaveLength(6);
    mkdirSync(path.join(staged, "meta"), { recursive: true });
    for (const e of priorEntries) {
      copyFileSync(path.join(migrationsFolder, `${e.tag}.sql`), path.join(staged, `${e.tag}.sql`));
    }
    writeFileSync(
      path.join(staged, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: priorEntries }, null, 2),
    );

    handle = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
    // apply ONLY 0000..0005 (the schema every deployed database had before the pair release)
    await migratePglite(handle.db as any, { migrationsFolder: staged });
    expect(await appliedMigrationCount(handle.db)).toBe(6);
    // pre-upgrade sanity: the pair world must not exist yet
    const pre = await rows(handle.db, sql`
      select count(*)::int as n from pg_tables where schemaname = 'public' and tablename ~ '^pair_'`);
    expect(Number(pre[0].n)).toBe(0);
    await expect(rows(handle.db, sql`select pair_group_id from orders limit 1`)).rejects.toThrow();
  }, 120_000);

  it("inserts representative legacy rows through the 0005 schema", async () => {
    await handle.db.execute(sql`
      insert into markets (id, event_id, condition_id, slug, question, up_token_id, down_token_id,
        start_epoch, end_epoch, rules_text, rules_hash, resolution_source, rules_name_chainlink,
        tick_size6, min_order_shares6, status, discovered_at_ms, updated_at_ms)
      values ('m-legacy', 'e1', 'c1', 'btc-updown-legacy', 'Up or down?', 'tok-up', 'tok-down',
        1700000000, 1700000300, 'rules', 'rh', 'chainlink', true,
        10000, 5000000, 'RESOLVED', 1700000000000, 1700000300000)`);
    await handle.db.execute(sql`
      insert into decision_snapshots (decision_id, market_id, mode, correlation_id, data, created_at_ms)
      values ('d-legacy', 'm-legacy', 'paper', 'corr-1', '{"kind":"legacy"}', 1700000001000)`);
    await handle.db.execute(sql`
      insert into order_intents (id, decision_id, version, idempotency_key, payload, created_at_ms)
      values ('oi-legacy', 'd-legacy', 1, 'idem-legacy-1', '{}', 1700000001500)`);
    await handle.db.execute(sql`
      insert into orders (id, intent_id, decision_id, market_id, token_id, outcome_side, order_side,
        style, time_in_force, post_only, price6, shares6, filled_shares6, stake6, mode, status,
        created_at_ms, updated_at_ms)
      values ('o-legacy', 'oi-legacy', 'd-legacy', 'm-legacy', 'tok-up', 'UP', 'BUY',
        'taker_fok', 'FOK', false, 480000, 10000000, 10000000, 4800000, 'paper', 'FILLED',
        1700000002000, 1700000003000)`);
    await handle.db.execute(sql`
      insert into order_fills (id, order_id, price6, shares6, fee_usdc6, maker, ts_ms)
      values ('f-legacy', 'o-legacy', 480000, 10000000, 0, false, 1700000002500)`);
    await handle.db.execute(sql`
      insert into positions (id, market_id, mode, outcome_side, shares6, avg_price6, cost6, stake6,
        exit_policy, status, opened_at_ms)
      values ('p-legacy', 'm-legacy', 'paper', 'UP', 10000000, 480000, 4800000, 4800000,
        'hold_to_resolution', 'OPEN', 1700000002500)`);
    await handle.db.execute(sql`
      insert into fee_schedule_snapshots (id, market_id, rate_ppm, taker_only, rebate_rate_ppm, collection, captured_at_ms)
      values ('fee-legacy', 'm-legacy', 10000, true, 0, 'usdc', 1700000000500)`);
    await handle.db.execute(sql`
      insert into constraint_snapshots (id, market_id, tick_size6, min_order_shares6, captured_at_ms)
      values ('con-legacy', 'm-legacy', 10000, 5000000, 1700000000500)`);
    await handle.db.execute(sql`
      insert into orderbook_snapshots (market_id, token_id, bids, asks, source_ts_ms, received_ts_ms)
      values ('m-legacy', 'tok-up', '[["480000","1000000"]]', '[["490000","2000000"]]', 1700000001000, 1700000001010)`);
  });

  it("applies 0006 on the populated database", async () => {
    await handle.migrate(); // full migrations folder: applies exactly the pair migration
    expect(await appliedMigrationCount(handle.db)).toBe(journal.entries.length);
  }, 120_000);

  it("keeps every legacy row readable through the new schema", async () => {
    const order = await handle.db.select().from(schema.orders);
    expect(order).toHaveLength(1);
    expect(order[0]!.id).toBe("o-legacy");
    expect(order[0]!.stake6).toBe(4800000n);
    expect(order[0]!.pairGroupId).toBeNull();
    expect(order[0]!.pairLegId).toBeNull();
    expect(order[0]!.pairAction).toBeNull();
    expect(order[0]!.clientOrderId).toBeNull();
    expect(order[0]!.effectId).toBeNull();
    expect(order[0]!.requestHash).toBeNull();

    const fill = await handle.db.select().from(schema.orderFills);
    expect(fill).toHaveLength(1);
    expect(fill[0]!.feeUsdc6).toBe(0n);
    expect(fill[0]!.feeConvention).toBeNull();
    expect(fill[0]!.feeShares6).toBeNull();
    expect(fill[0]!.netShares6).toBeNull();
    expect(fill[0]!.sourceEvidenceId).toBeNull();
    expect(fill[0]!.receivedAtMs).toBeNull();

    const market = await handle.db.select().from(schema.markets);
    expect(market[0]!.id).toBe("m-legacy");
    const position = await handle.db.select().from(schema.positions);
    expect(position[0]!.shares6).toBe(10000000n);

    const fee = await handle.db.select().from(schema.feeScheduleSnapshots);
    expect(fee[0]!.ratePpm).toBe(10000n);
    expect(fee[0]!.tokenId).toBeNull();
    expect(fee[0]!.canonicalHash).toBeNull();
    expect(fee[0]!.conventionResolverVersion).toBeNull();
    const con = await handle.db.select().from(schema.constraintSnapshots);
    expect(con[0]!.tickSize6).toBe(10000n);
    expect(con[0]!.tokenId).toBeNull();

    const snap = await handle.db.select().from(schema.orderbookSnapshots);
    expect(snap[0]!.connectionEpoch).toBeNull();
    expect(snap[0]!.lastEventId).toBeNull();
  });

  it("added only nullable columns to pre-existing tables", async () => {
    const check = async (table: string, column: string) => {
      const r = await rows(handle.db, sql`
        select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = ${table} and column_name = ${column}`);
      expect(r, `${table}.${column} missing`).toHaveLength(1);
      expect(r[0].is_nullable, `${table}.${column} must be nullable`).toBe("YES");
    };
    for (const c of ["pair_group_id", "pair_leg_id", "pair_action", "client_order_id", "effect_id", "request_hash"]) {
      await check("orders", c);
    }
    for (const c of ["fee_convention", "fee_shares6", "net_shares6", "source_evidence_id", "received_at_ms"]) {
      await check("order_fills", c);
    }
    for (const c of ["token_id", "source", "source_payload_hash", "canonical_hash", "effective_at_ms", "fetched_at_ms", "convention_resolver_version"]) {
      await check("fee_schedule_snapshots", c);
    }
    for (const c of ["token_id", "source", "source_payload_hash", "canonical_hash", "effective_at_ms", "fetched_at_ms"]) {
      await check("constraint_snapshots", c);
    }
    for (const c of ["connection_epoch", "book_version", "last_event_id", "source_timestamp_kind"]) {
      await check("orderbook_snapshots", c);
    }
  });

  it("accepts writes into the new pair tables after the upgrade", async () => {
    await handle.db.insert(schema.pairResearchRuns).values({
      id: "run-1", status: "PENDING", datasetManifestVersion: 1,
      datasetManifestJson: { files: [] }, datasetHash: "dh", codeCommit: "abc123",
      strategyVersion: "pair-v0", baseConfigJson: {}, basePolicyHash: "bp",
      observerOperationalHash: "oo", scenarioMatrixJson: {}, scenarioMatrixHash: "sm",
      seedAlgorithm: "sha256-counter", seedText: "seed", fromMs: 1_700_000_000_000,
      toMs: 1_700_000_300_000, startedAtMs: 1_700_000_400_000, createdAtMs: 1_700_000_400_000,
    });
    const run = await handle.db.select().from(schema.pairResearchRuns);
    expect(run).toHaveLength(1);
    expect(run[0]!.eventCount).toBe(0n); // spec default
    expect(run[0]!.marketCount).toBe(0);

    // outbox composite FK is enforced: an orphan child effect must be rejected
    await expect(
      handle.db.insert(schema.pairEffectOutbox).values({
        id: "fx-orphan", groupId: "no-such-group", actionIntentId: "no-such-intent",
        actionKind: "PARALLEL_INITIAL", actionSequence: 1, effectOrdinal: 0,
        idempotencyKey: "idem-fx", clientOperationId: "cop-fx", requestHash: "rh",
        requestPayload: {}, state: "PENDING", notBeforeMs: 0, deadlineMs: 1,
        createdAtMs: 1, updatedAtMs: 1,
      }),
    ).rejects.toThrow(/foreign key|violates/);
  });
});

describe("idempotency", () => {
  it("re-running migrate() is a no-op", async () => {
    const handle = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
    try {
      await handle.migrate();
      const first = await appliedMigrationCount(handle.db);
      await handle.migrate();
      await handle.migrate();
      expect(await appliedMigrationCount(handle.db)).toBe(first);
      const r = await rows(handle.db, sql`
        select count(*)::int as n from pg_tables where schemaname = 'public' and tablename = 'pair_order_groups'`);
      expect(Number(r[0].n)).toBe(1);
    } finally {
      await handle.close();
    }
  }, 120_000);
});
