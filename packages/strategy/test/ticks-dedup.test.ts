import { describe, expect, it } from "vitest";
import { TickBuffer } from "../src/ticks";
import type { ReferenceTick } from "@b5p/domain";

const tick = (tsMs: number, value: number): ReferenceTick => ({
  source: "chainlink", symbol: "btc/usd", value, sourceTsMs: tsMs, receivedTsMs: tsMs + 20,
});

/**
 * #45: RTDS replays a backfill array on every (re)subscribe. Without dedup the
 * overlap region double-inserts, and the duplicate zero-gaps collapse
 * medianGapMs to 0 for the whole retention window after each reconnect.
 */
describe("TickBuffer dedup (#45)", () => {
  it("drops exact (sourceTsMs, value) duplicates from reconnect backfill", () => {
    const buf = new TickBuffer();
    const base = 1_700_000_000_000;
    for (let i = 0; i < 61; i++) buf.push(tick(base + i * 1000, 64_000 + i));
    expect(buf.size).toBe(61);
    // reconnect: the same 61 ticks replayed
    for (let i = 0; i < 61; i++) buf.push(tick(base + i * 1000, 64_000 + i));
    expect(buf.size).toBe(61); // not 122
    expect(buf.medianGapMs(base + 61_000, 60_000)).toBe(1000); // not 0
  });

  it("keeps a genuinely new tick that shares a timestamp with a different value", () => {
    const buf = new TickBuffer();
    const base = 1_700_000_000_000;
    buf.push(tick(base, 64_000));
    buf.push(tick(base + 1000, 64_001));
    buf.push(tick(base, 63_999)); // same ts, different value: distinct observation
    expect(buf.size).toBe(3);
  });

  it("still accepts out-of-order non-duplicate ticks and keeps sort order", () => {
    const buf = new TickBuffer();
    const base = 1_700_000_000_000;
    buf.push(tick(base + 2000, 2));
    buf.push(tick(base + 1000, 1));
    expect(buf.size).toBe(2);
    expect(buf.atOrBefore(base + 1500)!.value).toBe(1);
    expect(buf.latest()!.value).toBe(2);
  });
});
