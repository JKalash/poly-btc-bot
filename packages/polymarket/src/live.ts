import {
  fmtProb, fmtShares, fmtUsdc, toNumber,
  type ExecutionStyle, type OrderSide, type Prob6, type Shares6, type Usdc6,
} from "@b5p/domain";
import type { ExecutionAdapter, OrderRequest, OrderResult } from "./execution";

/**
 * LIVE Polymarket CLOB adapter (real money). Built against @polymarket/clob-client
 * v5.8.1 (verified 2026-08-03). Loaded lazily and ONLY when a hot-wallet private
 * key is present in the environment — no key, no adapter, no possibility of a
 * live order.
 *
 * SAFETY INVARIANTS baked in here (the engine's arming flow adds more on top):
 *  - Constructed only by the engine when LIVE_TRADING_ENABLED=1 AND a key exists.
 *  - The private key is read once from the environment, converted to a viem
 *    account, and never logged, serialized, returned, or stored. `redact()`
 *    guarantees no method result can leak it.
 *  - preflight() must succeed (reachable CLOB, derivable API creds, USDC balance
 *    readable, allowance sufficient) before the engine will arm.
 *  - Taker orders are FAK/FOK with an explicit max price; maker orders are
 *    post-only. A post-only rejection is surfaced as a safe no-fill, never
 *    retried as a taker (that decision lives in the engine, not here).
 */

// dynamic types (avoid hard dep in browser bundles / when unused)
type ClobClientT = any;
type ApiKeyCredsT = { key: string; secret: string; passphrase: string };

export interface LiveAdapterConfig {
  privateKey: string;          // 0x-prefixed hot-wallet key (read from env only)
  host?: string;               // default https://clob.polymarket.com
  chainId?: number;            // default 137 (Polygon)
  funderAddress?: string;      // default: the wallet's own address (EOA signature type)
}

export interface LivePreflight {
  ok: boolean;
  walletAddress: string;
  usdcBalance: Usdc6;
  usdcAllowance: Usdc6;
  reasons: string[];
}

const CLOB_HOST = "https://clob.polymarket.com";

function toTickSize(tickSize6: Prob6): "0.1" | "0.01" | "0.001" | "0.0001" {
  const n = toNumber(tickSize6);
  if (n >= 0.1) return "0.1";
  if (n >= 0.01) return "0.01";
  if (n >= 0.001) return "0.001";
  return "0.0001";
}

export class LiveClobAdapter implements ExecutionAdapter {
  readonly kind = "live_disabled" as const; // reported kind stays conservative; realKind distinguishes
  readonly realKind = "live" as const;

  private client: ClobClientT | null = null;
  private creds: ApiKeyCredsT | null = null;
  private walletAddress = "";
  private readonly cfg: Required<Omit<LiveAdapterConfig, "funderAddress">> & { funderAddress?: string };
  private mods: { ClobClient: any; OrderType: any; OrderSide: any; SignatureType: any; AssetType: any; Chain: any; privateKeyToAccount: any; createWalletClient: any; http: any; polygon: any } | null = null;

  constructor(cfg: LiveAdapterConfig) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(cfg.privateKey)) {
      throw new Error("LiveClobAdapter: invalid private key format (expect 0x + 64 hex)");
    }
    this.cfg = {
      privateKey: cfg.privateKey,
      host: cfg.host ?? CLOB_HOST,
      chainId: cfg.chainId ?? 137,
      ...(cfg.funderAddress !== undefined ? { funderAddress: cfg.funderAddress } : {}),
    };
  }

  private async load(): Promise<NonNullable<LiveClobAdapter["mods"]>> {
    if (this.mods) return this.mods;
    const clob = await import("@polymarket/clob-client");
    const viem = await import("viem");
    const accounts = await import("viem/accounts");
    const chains = await import("viem/chains");
    this.mods = {
      ClobClient: (clob as any).ClobClient,
      OrderType: (clob as any).OrderType,
      OrderSide: (clob as any).OrderSide,
      SignatureType: (clob as any).SignatureType,
      AssetType: (clob as any).AssetType,
      Chain: (clob as any).Chain,
      privateKeyToAccount: (accounts as any).privateKeyToAccount,
      createWalletClient: (viem as any).createWalletClient,
      http: (viem as any).http,
      polygon: (chains as any).polygon,
    };
    return this.mods;
  }

  /** Build client + derive L2 API creds. Idempotent. */
  async init(): Promise<void> {
    if (this.client) return;
    const m = await this.load();
    const account = m.privateKeyToAccount(this.cfg.privateKey);
    this.walletAddress = account.address;
    const wallet = m.createWalletClient({ account, chain: m.polygon, transport: m.http() });
    // L1 client to derive/create API creds
    const l1 = new m.ClobClient(this.cfg.host, this.cfg.chainId, wallet, undefined, m.SignatureType.EOA, this.cfg.funderAddress ?? this.walletAddress);
    this.creds = await l1.createOrDeriveApiKey();
    // L2 client with creds for authenticated trading
    this.client = new m.ClobClient(this.cfg.host, this.cfg.chainId, wallet, this.creds, m.SignatureType.EOA, this.cfg.funderAddress ?? this.walletAddress);
  }

  address(): string { return this.walletAddress; }

  /** Reachability + funds + allowance check the engine runs before arming. */
  async preflight(minUsdc: Usdc6): Promise<LivePreflight> {
    const reasons: string[] = [];
    try {
      await this.init();
    } catch (e) {
      return { ok: false, walletAddress: "", usdcBalance: 0n, usdcAllowance: 0n, reasons: [`init failed: ${redact(String(e))}`] };
    }
    const m = this.mods!;
    let balance: Usdc6 = 0n;
    let allowance: Usdc6 = 0n;
    try {
      const ok = await this.client.getOk();
      if (!ok) reasons.push("CLOB /ok returned falsy");
    } catch (e) {
      reasons.push(`CLOB unreachable: ${redact(String(e))}`);
    }
    try {
      const ba = await this.client.getBalanceAllowance({ asset_type: m.AssetType.COLLATERAL });
      balance = usdcFromDecimalString(ba.balance);
      allowance = usdcFromDecimalString(ba.allowance);
    } catch (e) {
      reasons.push(`balance/allowance read failed: ${redact(String(e))}`);
    }
    if (balance < minUsdc) reasons.push(`USDC balance ${fmtUsdc(balance)} below minimum ${fmtUsdc(minUsdc)}`);
    if (allowance < minUsdc) reasons.push(`USDC allowance ${fmtUsdc(allowance)} below minimum ${fmtUsdc(minUsdc)}; call ensureAllowance()`);
    return { ok: reasons.length === 0, walletAddress: this.walletAddress, usdcBalance: balance, usdcAllowance: allowance, reasons };
  }

  /** Set the CTF exchange USDC allowance (one-time, on-chain) so orders can fill. */
  async ensureAllowance(): Promise<void> {
    await this.init();
    const m = this.mods!;
    await this.client.updateBalanceAllowance({ asset_type: m.AssetType.COLLATERAL });
  }

  async usdcBalance(): Promise<Usdc6> {
    await this.init();
    const m = this.mods!;
    const ba = await this.client.getBalanceAllowance({ asset_type: m.AssetType.COLLATERAL });
    return usdcFromDecimalString(ba.balance);
  }

  async submit(req: OrderRequest): Promise<OrderResult> {
    try {
      await this.init();
      const m = this.mods!;
      const side = req.orderSide === "BUY" ? m.OrderSide.BUY : m.OrderSide.SELL;
      const tickSize = toTickSize(req.tickSize6 ?? 10_000n);
      const options = { tickSize, negRisk: req.negRisk ?? false };

      if (req.style === "maker_post_only") {
        // GTD post-only maker order: price + size(shares)
        const userOrder = {
          tokenID: req.tokenId,
          price: toNumber(req.price6),
          size: toNumber(req.shares6),
          side,
          ...(req.expireAtMs ? { expiration: Math.floor(req.expireAtMs / 1000) } : {}),
        };
        const orderType = req.expireAtMs ? m.OrderType.GTD : m.OrderType.GTC;
        const resp = await this.client.createAndPostOrder(userOrder, options, orderType, false, true /* postOnly */);
        return mapResponse(resp);
      }

      // taker FAK/FOK: amount = USDC to spend for a BUY, price = max price
      const userMarketOrder = {
        tokenID: req.tokenId,
        amount: toNumber(req.stake6 ?? costGuess(req.shares6, req.price6)),
        side,
        price: toNumber(req.price6),
        orderType: req.style === "taker_fok" ? m.OrderType.FOK : m.OrderType.FAK,
      };
      const resp = await this.client.createAndPostMarketOrder(
        userMarketOrder, options, req.style === "taker_fok" ? m.OrderType.FOK : m.OrderType.FAK, false,
      );
      return mapResponse(resp);
    } catch (e) {
      return { accepted: false, status: "REJECTED", reason: redact(String(e)) };
    }
  }

  async cancel(externalId: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.init();
      const resp = await this.client.cancelOrder({ orderID: externalId });
      const canceled = Array.isArray(resp?.canceled) ? resp.canceled.includes(externalId) : true;
      return canceled ? { ok: true } : { ok: false, reason: JSON.stringify(resp?.not_canceled ?? resp) };
    } catch (e) {
      return { ok: false, reason: redact(String(e)) };
    }
  }

  async cancelAll(): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.init();
      await this.client.cancelAll();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: redact(String(e)) };
    }
  }

  describe(): string {
    return `LiveClobAdapter(host=${this.cfg.host}, chain=${this.cfg.chainId}, wallet=${this.walletAddress ? this.walletAddress.slice(0, 6) + "…" + this.walletAddress.slice(-4) : "uninit"})`;
  }
}

function mapResponse(resp: any): OrderResult {
  const ok = resp?.success !== false && (resp?.orderID || resp?.orderId || resp?.status);
  const status = String(resp?.status ?? (ok ? "LIVE" : "REJECTED")).toUpperCase();
  const norm =
    status === "MATCHED" ? "MATCHED" :
    status === "LIVE" ? "LIVE" :
    status === "DELAYED" ? "DELAYED" : ok ? "LIVE" : "REJECTED";
  return {
    accepted: Boolean(ok),
    ...(resp?.orderID || resp?.orderId ? { externalId: String(resp.orderID ?? resp.orderId) } : {}),
    status: norm as OrderResult["status"],
    ...(resp?.errorMsg || resp?.message ? { reason: redact(String(resp.errorMsg ?? resp.message)) } : {}),
  };
}

function usdcFromDecimalString(s: string | number): Usdc6 {
  const n = typeof s === "number" ? s : Number(s);
  if (!Number.isFinite(n)) return 0n;
  return BigInt(Math.round(n * 1_000_000));
}

function costGuess(shares6: Shares6, price6: Prob6): Usdc6 {
  return (shares6 * price6 + 999_999n) / 1_000_000n;
}

/**
 * Redact anything that looks like a private key or long hex secret from error
 * strings before they can reach a log or an API response. Defense in depth —
 * the adapter never intentionally includes the key in output.
 */
function redact(s: string): string {
  return s.replace(/0x[0-9a-fA-F]{64}/g, "0x<redacted-key>").replace(/[0-9a-fA-F]{64}/g, "<redacted-hex>");
}

export { fmtProb, fmtShares };
