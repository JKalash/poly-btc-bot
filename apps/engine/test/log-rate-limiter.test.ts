import { describe, expect, it } from "vitest";
import { LogRateLimiter } from "../src/log-rate-limiter";

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("LogRateLimiter", () => {
  it("emits the first occurrence immediately", () => {
    const limiter = new LogRateLimiter(1_000, clock().now);
    expect(limiter.take("a")).toEqual({ suppressed: 0, total: 1 });
  });

  it("suppresses everything else inside the window", () => {
    const c = clock();
    const limiter = new LogRateLimiter(1_000, c.now);
    limiter.take("a");
    for (let i = 0; i < 500; i++) expect(limiter.take("a")).toBeNull();
  });

  it("reports the suppressed count on the next emission", () => {
    const c = clock();
    const limiter = new LogRateLimiter(1_000, c.now);
    limiter.take("a");
    for (let i = 0; i < 9; i++) limiter.take("a");
    c.advance(1_000);
    expect(limiter.take("a")).toEqual({ suppressed: 9, total: 11 });
  });

  it("resets the suppressed count after each emission", () => {
    const c = clock();
    const limiter = new LogRateLimiter(1_000, c.now);
    limiter.take("a");
    limiter.take("a");
    c.advance(1_000);
    expect(limiter.take("a")).toEqual({ suppressed: 1, total: 3 });
    c.advance(1_000);
    expect(limiter.take("a")).toEqual({ suppressed: 0, total: 4 });
  });

  it("tracks keys independently", () => {
    const limiter = new LogRateLimiter(1_000, clock().now);
    expect(limiter.take("a")).not.toBeNull();
    expect(limiter.take("b")).not.toBeNull();
    expect(limiter.take("a")).toBeNull();
  });

  it("bounds emissions under sustained load", () => {
    const c = clock();
    const limiter = new LogRateLimiter(10_000, c.now);
    let emitted = 0;
    // 250 envelopes/second rejected for 13 minutes, the observed production rate.
    for (let i = 0; i < 250 * 60 * 13; i++) {
      if (limiter.take("reject:mkt:OVERFLOW") !== null) emitted++;
      c.advance(4);
    }
    expect(emitted).toBeLessThanOrEqual(80);
  });

  it("forgets a key on request", () => {
    const limiter = new LogRateLimiter(1_000, clock().now);
    limiter.take("a");
    expect(limiter.take("a")).toBeNull();
    limiter.forget("a");
    expect(limiter.take("a")).toEqual({ suppressed: 0, total: 1 });
  });

  it("rejects a nonsense window", () => {
    expect(() => new LogRateLimiter(0)).toThrow(RangeError);
    expect(() => new LogRateLimiter(-1)).toThrow(RangeError);
  });
});
