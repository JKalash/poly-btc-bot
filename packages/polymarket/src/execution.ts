import type { ExecutionStyle, OrderSide, OutcomeSide, TimeInForce } from "@b5p/domain";

/**
 * Execution adapter interface. Implemented by the paper simulator
 * (apps/engine), the legacy DisabledLiveAdapter stub, and the REAL
 * `LiveClobAdapter` (./live.ts) — this release DOES ship a live signing path.
 * It is inert unless a hot-wallet key is configured AND the operator arms the
 * engine with a typed acknowledgement for a bounded TTL; see
 * docs/live-trading.md and apps/engine/src/live.ts (LiveController).
 */

export interface OrderRequest {
  idempotencyKey: string;
  decisionId: string;
  marketId: string;
  tokenId: string;
  outcomeSide: OutcomeSide;
  orderSide: OrderSide;
  style: ExecutionStyle;
  timeInForce: TimeInForce;
  postOnly: boolean;
  price6: bigint;
  shares6: bigint;
  /** USDC to spend (BUY market orders); the exchange fills up to this amount. */
  stake6?: bigint;
  tickSize6?: bigint;
  negRisk?: boolean;
  expireAtMs?: number;
}

export interface OrderResult {
  accepted: boolean;
  externalId?: string;
  status: "LIVE" | "MATCHED" | "DELAYED" | "REJECTED";
  reason?: string;
}

export interface ExecutionAdapter {
  readonly kind: "paper" | "shadow" | "live" | "live_disabled";
  submit(req: OrderRequest): Promise<OrderResult>;
  cancel(externalId: string): Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Legacy always-refusing stub, kept for deployments that want a hard-off
 * adapter. NOTE: it is NOT "the only live adapter" — the real signing path is
 * `LiveClobAdapter` in ./live.ts, gated by the arming flow.
 */
export class DisabledLiveAdapter implements ExecutionAdapter {
  readonly kind = "live_disabled" as const;
  async submit(): Promise<OrderResult> {
    return { accepted: false, status: "REJECTED", reason: "Live trading is disabled for this adapter. The real live path requires the arming flow; see docs/live-trading.md." };
  }
  async cancel(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: false, reason: "Live trading is disabled for this adapter." };
  }
}
