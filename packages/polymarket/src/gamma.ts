import { z } from "zod";
import { slotStartEpoch } from "@b5p/domain";

/**
 * Gamma discovery client for the BTC 5-minute series.
 * Verified live 2026-07-31: series id 10684, slug btc-up-or-down-5m,
 * event slug convention btc-updown-5m-{300s-aligned unix start epoch},
 * feeSchedule { rate: 0.07, takerOnly: true, rebateRate: 0.2 }, tick 0.01, min size 5.
 *
 * Discovery is primarily by deterministic slug enumeration (robust, resumable);
 * series-id keyset listing is the fallback for bulk history.
 */

const GAMMA_BASE = "https://gamma-api.polymarket.com";

const GammaMarketSchema = z.object({
  id: z.string(),
  question: z.string(),
  conditionId: z.string(),
  slug: z.string(),
  description: z.string().default(""),
  resolutionSource: z.string().default(""),
  endDate: z.string(),
  eventStartTime: z.string().optional(),
  outcomes: z.string(), // JSON '["Up", "Down"]'
  outcomePrices: z.string().optional(),
  clobTokenIds: z.string().optional(), // JSON '[upToken, downToken]'
  orderPriceMinTickSize: z.number().optional(),
  orderMinSize: z.number().optional(),
  negRisk: z.boolean().optional(),
  active: z.boolean().optional(),
  closed: z.boolean().optional(),
  acceptingOrders: z.boolean().optional(),
  volumeNum: z.number().optional(),
  volume: z.union([z.string(), z.number()]).optional(),
  bestBid: z.number().optional(),
  bestAsk: z.number().optional(),
  feesEnabled: z.boolean().optional(),
  feeType: z.string().optional(),
  feeSchedule: z.object({
    exponent: z.number().optional(),
    rate: z.number(),
    takerOnly: z.boolean().optional(),
    rebateRate: z.number().optional(),
  }).optional(),
  umaResolutionStatuses: z.string().optional(),
}).passthrough();

const GammaEventSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().default(""),
  resolutionSource: z.string().default(""),
  endDate: z.string(),
  active: z.boolean().optional(),
  closed: z.boolean().optional(),
  markets: z.array(GammaMarketSchema).default([]),
  series: z.array(z.object({ id: z.string(), slug: z.string().optional() }).passthrough()).optional(),
}).passthrough();

export type GammaEvent = z.infer<typeof GammaEventSchema>;
export type GammaMarket = z.infer<typeof GammaMarketSchema>;

export interface ParsedFiveMinMarket {
  eventId: string;
  marketId: string;
  conditionId: string;
  slug: string;
  question: string;
  description: string;
  resolutionSource: string;
  startEpoch: number;
  endEpoch: number;
  upTokenId: string;
  downTokenId: string;
  tickSize: number;
  minOrderSize: number;
  negRisk: boolean;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  bestBid: number | null;
  bestAsk: number | null;
  volumeUsd: number | null;
  outcomePrices: [number, number] | null; // [up, down] once resolved these hit 1/0
  feeSchedule: { rate: number; takerOnly: boolean; rebateRate: number; feeType: string | null } | null;
  rulesNameChainlink: boolean;
  raw: GammaMarket;
}

export class GammaClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base: string = GAMMA_BASE,
    /** Per-request deadline. These are small JSON responses; a black-holed
     * request must fail fast — the discovery loop is serialized behind a
     * guard, so one unbounded fetch stalls ALL market discovery. */
    private readonly timeoutMs: number = 5000,
  ) {}

  private async getJson(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`gamma ${path} -> HTTP ${res.status}`);
    return res.json();
  }

  slugForSlot(slugPrefix: string, slotEpoch: number): string {
    return `${slugPrefix}${slotEpoch}`;
  }

  async fetchEventBySlug(slug: string): Promise<GammaEvent | null> {
    const raw = await this.getJson(`/events?slug=${encodeURIComponent(slug)}`);
    const arr = z.array(GammaEventSchema).parse(raw);
    return arr[0] ?? null;
  }

  /** Current + next N market windows by deterministic slug enumeration. */
  async discoverWindows(slugPrefix: string, nowEpochSec: number, aheadWindows: number): Promise<ParsedFiveMinMarket[]> {
    const currentSlot = slotStartEpoch(nowEpochSec);
    const out: ParsedFiveMinMarket[] = [];
    for (let i = 0; i <= aheadWindows; i++) {
      const slot = currentSlot + i * 300;
      const ev = await this.fetchEventBySlug(this.slugForSlot(slugPrefix, slot));
      if (!ev) continue;
      const parsed = parseFiveMinMarket(ev);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /** Historical resolved events by slug enumeration over an epoch range (inclusive), oldest first. */
  async *enumerateResolved(slugPrefix: string, fromEpoch: number, toEpoch: number, opts: { batchDelayMs?: number } = {}): AsyncGenerator<ParsedFiveMinMarket> {
    for (let slot = slotStartEpoch(fromEpoch); slot <= toEpoch; slot += 300) {
      const ev = await this.fetchEventBySlug(this.slugForSlot(slugPrefix, slot));
      if (ev) {
        const parsed = parseFiveMinMarket(ev);
        if (parsed && parsed.closed) yield parsed;
      }
      if (opts.batchDelayMs) await new Promise((r) => setTimeout(r, opts.batchDelayMs));
    }
  }
}

export function parseFiveMinMarket(ev: GammaEvent): ParsedFiveMinMarket | null {
  const m = ev.markets[0];
  if (!m) return null;

  // slug epoch is the window start, 300s aligned
  const epochMatch = /-(\d{9,11})$/.exec(m.slug);
  const startEpoch = epochMatch ? Number(epochMatch[1]) : NaN;
  const endEpoch = Number.isFinite(startEpoch) ? startEpoch + 300 : Math.floor(Date.parse(m.endDate) / 1000);
  if (!Number.isFinite(startEpoch)) return null;

  let up = "";
  let down = "";
  try {
    const outcomes = z.array(z.string()).parse(JSON.parse(m.outcomes));
    const tokens = m.clobTokenIds ? z.array(z.string()).parse(JSON.parse(m.clobTokenIds)) : [];
    const upIdx = outcomes.findIndex((o) => o.toLowerCase() === "up");
    const downIdx = outcomes.findIndex((o) => o.toLowerCase() === "down");
    if (upIdx >= 0 && tokens[upIdx]) up = tokens[upIdx]!;
    if (downIdx >= 0 && tokens[downIdx]) down = tokens[downIdx]!;
  } catch {
    // token ids can be absent pre-activation; caller decides whether that matters
  }

  let outcomePrices: [number, number] | null = null;
  if (m.outcomePrices) {
    try {
      const prices = z.array(z.string()).parse(JSON.parse(m.outcomePrices)).map(Number);
      const outcomes = z.array(z.string()).parse(JSON.parse(m.outcomes));
      const upIdx = outcomes.findIndex((o) => o.toLowerCase() === "up");
      const downIdx = outcomes.findIndex((o) => o.toLowerCase() === "down");
      if (upIdx >= 0 && downIdx >= 0) outcomePrices = [prices[upIdx]!, prices[downIdx]!];
    } catch { /* ignore */ }
  }

  const text = `${m.description} ${m.resolutionSource}`.toLowerCase();
  const rulesNameChainlink = text.includes("chainlink") && text.includes("btc");

  return {
    eventId: ev.id,
    marketId: m.id,
    conditionId: m.conditionId,
    slug: m.slug,
    question: m.question,
    description: m.description,
    resolutionSource: m.resolutionSource,
    startEpoch,
    endEpoch,
    upTokenId: up,
    downTokenId: down,
    tickSize: m.orderPriceMinTickSize ?? 0.01,
    minOrderSize: m.orderMinSize ?? 5,
    negRisk: m.negRisk ?? false,
    active: m.active ?? false,
    closed: m.closed ?? false,
    acceptingOrders: m.acceptingOrders ?? false,
    bestBid: m.bestBid ?? null,
    bestAsk: m.bestAsk ?? null,
    volumeUsd: m.volumeNum ?? (m.volume !== undefined ? Number(m.volume) : null),
    outcomePrices,
    feeSchedule: m.feeSchedule
      ? {
          rate: m.feeSchedule.rate,
          takerOnly: m.feeSchedule.takerOnly ?? true,
          rebateRate: m.feeSchedule.rebateRate ?? 0,
          feeType: m.feeType ?? null,
        }
      : null,
    rulesNameChainlink,
    raw: m,
  };
}

/** Resolved outcome from outcomePrices: UP if up price rounds to 1. */
export function resolvedOutcome(m: ParsedFiveMinMarket): "UP" | "DOWN" | null {
  if (!m.closed || !m.outcomePrices) return null;
  const [upP, downP] = m.outcomePrices;
  if (upP > 0.99 && downP < 0.01) return "UP";
  if (downP > 0.99 && upP < 0.01) return "DOWN";
  return null;
}
