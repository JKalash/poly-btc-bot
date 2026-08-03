import { z } from "zod";
import { ReconnectingWs, type WsStatus } from "./ws-base";

/**
 * CLOB market-channel WebSocket. Message shapes verified against live capture
 * 2026-07-31:
 *  - initial: ARRAY of book snapshots {market, asset_id, timestamp, hash, bids, asks}
 *  - price_change: {market, price_changes: [{asset_id, price, size, side, best_bid, best_ask, hash}], timestamp}
 *  - last_trade_price: {market, asset_id, price, side, size?, timestamp} (event_type when present)
 *  - tick_size_change: {market, asset_id, old_tick_size, new_tick_size, timestamp}
 * Some payloads carry event_type, some are recognized by shape; parse both ways.
 */

// Plain non-negative decimal strings only: rejects scientific notation,
// leading-dot, empty and negative values AT THE BOUNDARY (safeParse drops the
// message) instead of letting them throw deep inside book/engine mutation.
const decimalString = z.string().regex(/^\d+(\.\d+)?$/);

const Level = z.object({ price: decimalString, size: decimalString });

const BookMsg = z.object({
  event_type: z.literal("book").optional(),
  market: z.string(),
  asset_id: z.string(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  hash: z.string().optional(),
  bids: z.array(Level),
  asks: z.array(Level),
});

const PriceChangeMsg = z.object({
  event_type: z.literal("price_change").optional(),
  market: z.string(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  price_changes: z.array(z.object({
    asset_id: z.string(),
    price: decimalString,
    size: decimalString,
    side: z.enum(["BUY", "SELL"]),
    hash: z.string().optional(),
    best_bid: z.string().optional(),
    best_ask: z.string().optional(),
  })),
});

const LastTradeMsg = z.object({
  event_type: z.literal("last_trade_price"),
  market: z.string(),
  asset_id: z.string(),
  price: decimalString,
  side: z.enum(["BUY", "SELL"]).optional(),
  size: decimalString.optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
});

const TickSizeMsg = z.object({
  event_type: z.literal("tick_size_change"),
  market: z.string(),
  asset_id: z.string(),
  old_tick_size: z.string().optional(),
  new_tick_size: z.string(),
  timestamp: z.union([z.string(), z.number()]).optional(),
});

export interface ClobWsCallbacks {
  onBook: (msg: z.infer<typeof BookMsg>, receivedTsMs: number) => void;
  onPriceChange: (msg: z.infer<typeof PriceChangeMsg>, receivedTsMs: number) => void;
  onLastTrade: (msg: z.infer<typeof LastTradeMsg>, receivedTsMs: number) => void;
  onTickSizeChange?: (msg: z.infer<typeof TickSizeMsg>, receivedTsMs: number) => void;
  onStatus?: (status: WsStatus, detail?: string) => void;
}

export const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export class ClobMarketWs {
  private ws: ReconnectingWs;
  private assetIds: string[] = [];

  constructor(private readonly cb: ClobWsCallbacks, url: string = CLOB_WS_URL) {
    this.ws = new ReconnectingWs({
      url,
      name: "clob-market",
      pingIntervalMs: 5000,
      onStatus: (s, d) => cb.onStatus?.(s, d),
      onOpen: (send) => {
        if (this.assetIds.length > 0) {
          send(JSON.stringify({ assets_ids: this.assetIds, type: "market" }));
        }
      },
      onMessage: (data, ts) => this.handle(data, ts),
    });
  }

  start(): void { this.ws.start(); }
  stop(): void { this.ws.stop(); }
  ageMs(now?: number): number | null { return this.ws.ageMs(now); }
  get reconnectCount(): number { return this.ws.reconnectCount; }

  /**
   * Replace the subscription set. Genuinely reconnect-based: the documented
   * market-channel contract consumes the subscription at connection start, and
   * whether a repeated full-list payload takes effect mid-connection is
   * server-version-dependent — this bot gets a NEW token pair every 5 minutes,
   * so betting the entire book feed on unverified repeat-subscribe semantics
   * would risk zero book data for every post-connect window. Reconnecting also
   * sheds expired assets instead of accumulating them for hours.
   */
  setAssets(assetIds: string[]): void {
    const same = assetIds.length === this.assetIds.length && assetIds.every((a, i) => this.assetIds[i] === a);
    this.assetIds = [...assetIds];
    if (!same) {
      this.ws.restart("subscription set changed");
    }
  }

  private handle(data: string, receivedTsMs: number): void {
    let json: unknown;
    try { json = JSON.parse(data); } catch { return; }
    const items = Array.isArray(json) ? json : [json];
    for (const item of items) this.dispatch(item, receivedTsMs);
  }

  private dispatch(item: unknown, receivedTsMs: number): void {
    if (typeof item !== "object" || item === null) return;
    const et = (item as { event_type?: string }).event_type;
    if (et === "last_trade_price") {
      const m = LastTradeMsg.safeParse(item);
      if (m.success) this.cb.onLastTrade(m.data, receivedTsMs);
      return;
    }
    if (et === "tick_size_change") {
      const m = TickSizeMsg.safeParse(item);
      if (m.success) this.cb.onTickSizeChange?.(m.data, receivedTsMs);
      return;
    }
    if (et === "price_change" || "price_changes" in item) {
      const m = PriceChangeMsg.safeParse(item);
      if (m.success) this.cb.onPriceChange(m.data, receivedTsMs);
      return;
    }
    if (et === "book" || ("bids" in item && "asks" in item && "asset_id" in item)) {
      const m = BookMsg.safeParse(item);
      if (m.success) this.cb.onBook(m.data, receivedTsMs);
      return;
    }
  }
}

export function tsToMs(ts: string | number | undefined, fallback: number): number {
  if (ts === undefined) return fallback;
  const n = typeof ts === "string" ? Number(ts) : ts;
  if (!Number.isFinite(n)) return fallback;
  // heuristics: seconds vs ms
  return n > 10_000_000_000 ? n : n * 1000;
}

export type { BookMsg, PriceChangeMsg, LastTradeMsg, TickSizeMsg };
