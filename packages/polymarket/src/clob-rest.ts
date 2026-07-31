import { z } from "zod";

/** Minimal public CLOB REST client (no auth): book snapshots for reconciliation and midpoint checks. */

const CLOB_BASE = "https://clob.polymarket.com";

const RestBook = z.object({
  market: z.string().optional(),
  asset_id: z.string().optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  hash: z.string().optional(),
  bids: z.array(z.object({ price: z.string(), size: z.string() })).default([]),
  asks: z.array(z.object({ price: z.string(), size: z.string() })).default([]),
});

export type RestBookSnapshot = z.infer<typeof RestBook>;

export class ClobRestClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base: string = CLOB_BASE,
  ) {}

  async getBook(tokenId: string): Promise<RestBookSnapshot> {
    const res = await this.fetchImpl(`${this.base}/book?token_id=${tokenId}`);
    if (!res.ok) throw new Error(`clob /book HTTP ${res.status}`);
    return RestBook.parse(await res.json());
  }

  async ok(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.base}/ok`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
