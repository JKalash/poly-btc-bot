import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configVersions, makeDb, type DbHandle } from "@b5p/db";
import { getLocalBus } from "../src/bus";
import { Engine } from "../src/engine";

/**
 * Regression: config rows persisted BEFORE a schema extension must gain the
 * new blocks' defaults on load. A raw cast left strategy.extended_move_fade
 * undefined and crashed evaluateMarket every step in production (2026-08-03).
 */
describe("stored config predating schema extensions", () => {
  let db: DbHandle;
  let engine: Engine;

  beforeEach(async () => {
    db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
    await db.migrate();
  });

  afterEach(async () => {
    engine?.stop();
    await db.close();
  });

  it("fills defaults for blocks the stored row lacks and steps without error", async () => {
    // A config shaped like the pre-refinement deployment: no extended_move_fade,
    // no inventory_risk / inventory_research, no calibrated paths.
    await db.db.insert(configVersions).values({
      config: {
        app: { mode: "paper" },
        strategy: { active_version: "book_distance_v1" },
        risk: { profile: "paper_exploration" },
      },
      actor: "test:legacy-row",
      active: true,
      changedPaths: [],
      createdAtMs: 1,
    });
    engine = new Engine(db, getLocalBus(), "paper");
    await engine.start(1_000_000);

    expect(engine.cfg.strategy.extended_move_fade).toBeDefined();
    expect(engine.cfg.strategy.extended_move_fade.minimum_run_blocks).toBe(4);
    expect(engine.cfg.inventory_risk).toBeDefined();
    expect(engine.cfg.inventory_research.enabled).toBe(false);

    await expect(engine.step(1_000_500)).resolves.not.toThrow();
  });
});
