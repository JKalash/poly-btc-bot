import { describe, expect, it, vi } from "vitest";
import { PairObserverRuntime, type PairObserverEvaluation } from "../src/pair-runtime";

describe("pair observer runtime scheduler", () => {
  it("evaluates once after a complete envelope dirty mark and deduplicates delivery", async () => {
    const seen: PairObserverEvaluation[] = [];
    const runtime = new PairObserverRuntime({ maximumMarkets: 2, evaluate: async (input) => { seen.push(input); }, onHealth: vi.fn() });
    runtime.registerMarket("m");
    expect(runtime.markDirty("m", { kind: "CLOB_ENVELOPE", id: "e1" })).toBe("SCHEDULED");
    expect(runtime.markDirty("m", { kind: "CLOB_ENVELOPE", id: "e1" })).toBe("DUPLICATE");
    await runtime.whenIdle("m");
    expect(seen).toEqual([{ marketId: "m", trigger: { kind: "CLOB_ENVELOPE", id: "e1" } }]);
    expect(runtime.markDirty("m", { kind: "CLOB_ENVELOPE", id: "e1" })).toBe("DUPLICATE");
  });

  it("serializes each market and coalesces rapid dirtiness to the newest trigger", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new PairObserverRuntime({ maximumMarkets: 1, evaluate: async ({ trigger }) => { seen.push(trigger.id); if (trigger.id === "e1") await gate; }, onHealth: vi.fn() });
    runtime.registerMarket("m");
    runtime.markDirty("m", { kind: "CLOB_ENVELOPE", id: "e1" });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(runtime.markDirty("m", { kind: "CLOB_ENVELOPE", id: "e2" })).toBe("COALESCED");
    expect(runtime.markDirty("m", { kind: "CLOB_ENVELOPE", id: "e3" })).toBe("COALESCED");
    release();
    await runtime.whenIdle("m");
    expect(seen).toEqual(["e1", "e3"]);
  });

  it("isolates evaluator failures and continues with later work", async () => {
    const health = vi.fn();
    const seen: string[] = [];
    const runtime = new PairObserverRuntime({ maximumMarkets: 1, evaluate: async ({ trigger }) => { seen.push(trigger.id); if (trigger.id === "bad") throw new Error("fixture"); }, onHealth: health });
    runtime.registerMarket("m");
    runtime.markDirty("m", { kind: "CLOB_ENVELOPE", id: "bad" });
    await runtime.whenIdle("m");
    runtime.markDirty("m", { kind: "FALLBACK_TIMER", id: "timer" });
    await runtime.whenIdle("m");
    expect(seen).toEqual(["bad", "timer"]);
    expect(health).toHaveBeenCalledWith("PAIR_RUNTIME_EVALUATION_FAILED", expect.objectContaining({ marketId: "m", triggerId: "bad" }));
  });

  it("bounds registered markets and rejects unregistered dirtiness", () => {
    const health = vi.fn();
    const runtime = new PairObserverRuntime({ maximumMarkets: 1, evaluate: async () => {}, onHealth: health });
    expect(runtime.registerMarket("m1")).toBe(true);
    expect(runtime.registerMarket("m2")).toBe(false);
    expect(runtime.markDirty("m2", { kind: "CLOB_ENVELOPE", id: "e" })).toBe("UNREGISTERED");
    expect(health).toHaveBeenCalledWith("PAIR_RUNTIME_CAPACITY_EXCEEDED", expect.objectContaining({ marketId: "m2" }));
  });
});
