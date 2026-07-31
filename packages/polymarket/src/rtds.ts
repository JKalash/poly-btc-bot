import { z } from "zod";
import type { ReferenceTick } from "@b5p/domain";
import { ReconnectingWs, type WsStatus } from "./ws-base";

/**
 * Polymarket Real-Time Data Service client.
 * Payload shapes verified against live capture 2026-07-31:
 *  update:    { connection_id?, payload: { symbol, timestamp, value, full_accuracy_value? }, timestamp, topic, type: "update" }
 *  backfill:  { payload: { data: [{timestamp, value}...], symbol }, timestamp, topic, type: "subscribe" }
 * Routing is by TOPIC (crypto_prices -> binance, crypto_prices_chainlink -> chainlink);
 * the server's symbol labels are not trusted for routing.
 */

const UpdatePayload = z.object({
  symbol: z.string(),
  timestamp: z.number(),
  value: z.number(),
  full_accuracy_value: z.string().optional(),
});

const BackfillPayload = z.object({
  symbol: z.string().optional(),
  data: z.array(z.object({ timestamp: z.number(), value: z.number() })),
});

const Envelope = z.object({
  topic: z.string(),
  type: z.string(),
  timestamp: z.number().optional(),
  payload: z.unknown(),
});

export interface RtdsCallbacks {
  onTick: (tick: ReferenceTick) => void;
  onStatus?: (status: WsStatus, detail?: string) => void;
  /** server envelope timestamp minus local receive time — clock-skew signal */
  onClockSample?: (skewMs: number) => void;
}

export const RTDS_URL = "wss://ws-live-data.polymarket.com";

export class RtdsClient {
  private ws: ReconnectingWs;

  constructor(private readonly cb: RtdsCallbacks, url: string = RTDS_URL) {
    this.ws = new ReconnectingWs({
      url,
      name: "rtds",
      pingIntervalMs: 5000,
      onStatus: (s, d) => cb.onStatus?.(s, d),
      onOpen: (send) => {
        send(JSON.stringify({
          action: "subscribe",
          subscriptions: [
            { topic: "crypto_prices", type: "*", filters: "btcusdt" },
            { topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol: "btc/usd" }) },
          ],
        }));
      },
      onMessage: (data, receivedTsMs) => this.handle(data, receivedTsMs),
    });
  }

  start(): void { this.ws.start(); }
  stop(): void { this.ws.stop(); }
  ageMs(now?: number): number | null { return this.ws.ageMs(now); }
  get reconnectCount(): number { return this.ws.reconnectCount; }

  private handle(data: string, receivedTsMs: number): void {
    let json: unknown;
    try { json = JSON.parse(data); } catch { return; }
    const env = Envelope.safeParse(json);
    if (!env.success) return;
    const source: ReferenceTick["source"] =
      env.data.topic === "crypto_prices_chainlink" ? "chainlink" : "binance";

    if (typeof env.data.timestamp === "number") {
      this.cb.onClockSample?.(env.data.timestamp - receivedTsMs);
    }

    if (env.data.type === "update") {
      const p = UpdatePayload.safeParse(env.data.payload);
      if (!p.success) return;
      this.cb.onTick({
        source,
        symbol: p.data.symbol,
        value: p.data.value,
        ...(p.data.full_accuracy_value !== undefined
          ? { fullAccuracyValue: fullAccuracyToDecimalString(p.data.full_accuracy_value) }
          : {}),
        sourceTsMs: p.data.timestamp,
        receivedTsMs,
      });
      return;
    }
    if (env.data.type === "subscribe") {
      const p = BackfillPayload.safeParse(env.data.payload);
      if (!p.success) return;
      for (const d of p.data.data) {
        this.cb.onTick({
          source,
          symbol: p.data.symbol ?? (source === "chainlink" ? "btc/usd" : "btcusdt"),
          value: d.value,
          sourceTsMs: d.timestamp,
          receivedTsMs,
        });
      }
    }
  }
}

/** "64709288059102280000000" (1e18 scale) -> "64709.28805910228" exactly. */
export function fullAccuracyToDecimalString(v: string): string {
  if (!/^\d+$/.test(v)) return v;
  const padded = v.padStart(19, "0");
  const intPart = padded.slice(0, -18).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(-18).replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : intPart;
}
