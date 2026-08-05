/**
 * Aggregating rate limiter for high-frequency log lines.
 *
 * A per-event warning is fine until the event is "the queue is rejecting
 * everything", at which point the logging itself becomes part of the overload:
 * every rejected envelope produced a line, and rejection is cheap, so the log
 * volume peaks exactly when the process has least headroom.
 *
 * This emits the first occurrence in a window immediately, then suppresses the
 * rest and reports the suppressed count on the next emission — so the signal
 * survives at bounded cost.
 */
export interface RateLimitedEmission {
  /** Occurrences suppressed since the previous emission (0 on the first). */
  readonly suppressed: number;
  /** Total occurrences observed for this key, including this one. */
  readonly total: number;
}

interface KeyState {
  windowStartedAtMs: number;
  suppressed: number;
  total: number;
}

export class LogRateLimiter {
  private readonly state = new Map<string, KeyState>();

  constructor(
    private readonly windowMs: number,
    private readonly nowMs: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new RangeError("window must be a positive integer");
  }

  /**
   * Returns emission details when the caller should log, or null when this
   * occurrence is suppressed.
   */
  take(key: string): RateLimitedEmission | null {
    const now = this.nowMs();
    const existing = this.state.get(key);
    if (existing === undefined) {
      this.state.set(key, { windowStartedAtMs: now, suppressed: 0, total: 1 });
      return Object.freeze({ suppressed: 0, total: 1 });
    }
    existing.total++;
    if (now - existing.windowStartedAtMs >= this.windowMs) {
      const suppressed = existing.suppressed;
      existing.windowStartedAtMs = now;
      existing.suppressed = 0;
      return Object.freeze({ suppressed, total: existing.total });
    }
    existing.suppressed++;
    return null;
  }

  /** Drop retained counters for a key (e.g. when a market is unregistered). */
  forget(key: string): void {
    this.state.delete(key);
  }

  reset(): void {
    this.state.clear();
  }
}
