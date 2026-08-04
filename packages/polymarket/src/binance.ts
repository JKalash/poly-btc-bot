import { z } from "zod";
import type { Candle } from "@b5p/strategy";

/**
 * Binance klines REST poller (public data, no auth). Used for the gist's
 * candle indicators (EMA/RSI/volume surge). 1-second interval gives the
 * window-open price and second-level volume.
 * Binance is DIAGNOSTIC/CONFIRMATION data only — never the resolution source.
 */

const KlineRow = z.tuple([
  z.number(),                    // open time ms
  z.string(), z.string(), z.string(), z.string(), // o h l c
  z.string(),                    // volume
]).rest(z.unknown());

const BINANCE_BASE = "https://api.binance.com";

export async function fetchKlines1s(opts: {
  symbol?: string;
  limit?: number;
  fetchImpl?: typeof fetch;
  base?: string;
  timeoutMs?: number;
}): Promise<Candle[]> {
  const { symbol = "BTCUSDT", limit = 600, fetchImpl = fetch, base = BINANCE_BASE, timeoutMs = 4000 } = opts;
  const res = await fetchImpl(`${base}/api/v3/klines?symbol=${symbol}&interval=1s&limit=${limit}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`binance klines HTTP ${res.status}`);
  const rows = z.array(KlineRow).parse(await res.json());
  return rows.map((r) => ({
    openTimeMs: r[0],
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }));
}

export class BinanceKlinesPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private candles: Candle[] = [];
  lastFetchTsMs = 0;
  lastError: string | null = null;

  constructor(
    private readonly opts: {
      symbol?: string;
      pollIntervalMs?: number;
      limit?: number;
      fetchImpl?: typeof fetch;
      onUpdate?: (candles: Candle[]) => void;
      onError?: (err: string) => void;
    } = {},
  ) {}

  private consecutiveErrors = 0;
  private lastErrorLogMs = 0;

  private inFlight = false;

  start(): void {
    const interval = this.opts.pollIntervalMs ?? 5000;
    const tick = async () => {
      // No overlap: a slow poll must never race a fast later poll and clobber
      // fresh candles with stale ones stamped as new. The fetch timeout stays
      // under the poll interval, so the guard cannot wedge the poller.
      if (this.inFlight) return;
      // geo-blocked or persistently failing endpoints (e.g. HTTP 451 from US
      // hosts) back off to one attempt per 10 minutes and one warning per hour;
      // the engine falls back to Chainlink-synthesized candles meanwhile.
      if (this.consecutiveErrors >= 3 && Date.now() - this.lastFailMs < 600_000) return;
      this.inFlight = true;
      try {
        const kl = await fetchKlines1s({
          ...(this.opts.symbol !== undefined ? { symbol: this.opts.symbol } : {}),
          ...(this.opts.limit !== undefined ? { limit: this.opts.limit } : {}),
          ...(this.opts.fetchImpl !== undefined ? { fetchImpl: this.opts.fetchImpl } : {}),
          timeoutMs: Math.max(1000, interval - 1000),
        });
        this.candles = kl;
        this.lastFetchTsMs = Date.now();
        this.lastError = null;
        this.consecutiveErrors = 0;
        this.opts.onUpdate?.(kl);
      } catch (e) {
        this.lastError = String(e);
        this.consecutiveErrors += 1;
        this.lastFailMs = Date.now();
        if (Date.now() - this.lastErrorLogMs > 3_600_000 || this.consecutiveErrors <= 3) {
          this.lastErrorLogMs = Date.now();
          this.opts.onError?.(this.lastError);
        }
      } finally {
        this.inFlight = false;
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), interval);
  }

  private lastFailMs = 0;

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  latest(): Candle[] { return this.candles; }
  ageMs(now = Date.now()): number | null {
    return this.lastFetchTsMs === 0 ? null : now - this.lastFetchTsMs;
  }
}
