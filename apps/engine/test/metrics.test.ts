import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "../src/metrics";

describe("MetricsRegistry", () => {
  it("renders gauges and counters in prometheus text format", () => {
    const r = new MetricsRegistry();
    r.gauge("b5p_capture_queue_depth", "Capture queue current depth", 42);
    r.counterTotal("b5p_capture_overflows_total", "Capture records dropped on overflow", 3);
    const text = r.render();
    expect(text).toContain("# HELP b5p_capture_queue_depth Capture queue current depth");
    expect(text).toContain("# TYPE b5p_capture_queue_depth gauge");
    expect(text).toContain("b5p_capture_queue_depth 42");
    expect(text).toContain("# TYPE b5p_capture_overflows_total counter");
    expect(text).toContain("b5p_capture_overflows_total 3");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("labels are sorted, escaped, and updatable per label set", () => {
    const r = new MetricsRegistry();
    r.gauge("b5p_feed_age_seconds", "age", 1.5, { feed: "clob" });
    r.gauge("b5p_feed_age_seconds", "age", 9, { feed: "rtds" });
    r.gauge("b5p_feed_age_seconds", "age", 2.5, { feed: "clob" }); // overwrite
    const text = r.render();
    expect(text).toContain('b5p_feed_age_seconds{feed="clob"} 2.5');
    expect(text).toContain('b5p_feed_age_seconds{feed="rtds"} 9');
    expect(text.match(/feed="clob"/g)).toHaveLength(1);

    const esc = new MetricsRegistry();
    esc.gauge("m", "h", 1, { detail: 'say "hi"\\path\nnext' });
    expect(esc.render()).toContain('m{detail="say \\"hi\\"\\\\path\\nnext"} 1');
  });

  it("one-hot state flip zeroes the previous label", () => {
    const r = new MetricsRegistry();
    const states = ["PAPER", "HALTED"] as const;
    for (const s of states) r.gauge("b5p_engine_state", "one-hot", s === "PAPER" ? 1 : 0, { state: s });
    for (const s of states) r.gauge("b5p_engine_state", "one-hot", s === "HALTED" ? 1 : 0, { state: s });
    const text = r.render();
    expect(text).toContain('b5p_engine_state{state="PAPER"} 0');
    expect(text).toContain('b5p_engine_state{state="HALTED"} 1');
  });

  it("clear removes a labeled sample; non-finite values are never emitted", () => {
    const r = new MetricsRegistry();
    r.gauge("b5p_feed_age_seconds", "age", 5, { feed: "binance" });
    r.clear("b5p_feed_age_seconds", { feed: "binance" });
    expect(r.render()).not.toContain("binance");
    r.gauge("bad", "h", Number.NaN);
    r.gauge("bad", "h", Number.POSITIVE_INFINITY);
    expect(r.render()).not.toContain("bad");
  });
});
