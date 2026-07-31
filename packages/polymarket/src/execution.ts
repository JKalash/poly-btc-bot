import type { ExecutionStyle, OrderSide, OutcomeSide, TimeInForce } from "@b5p/domain";

/**
 * Execution adapter interface. The paper simulator (apps/engine) and the
 * disabled live adapter implement this. A future live adapter must implement
 * it behind the arming flow — this release ships NO live signing path at all:
 * no private key handling exists anywhere in the codebase, by design.
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
  expireAtMs?: number;
}

export interface OrderResult {
  accepted: boolean;
  externalId?: string;
  status: "LIVE" | "MATCHED" | "DELAYED" | "REJECTED";
  reason?: string;
}

export interface ExecutionAdapter {
  readonly kind: "paper" | "shadow" | "live_disabled";
  submit(req: OrderRequest): Promise<OrderResult>;
  cancel(externalId: string): Promise<{ ok: boolean; reason?: string }>;
}

/** The only "live" adapter in this release. Refuses everything, loudly. */
export class DisabledLiveAdapter implements ExecutionAdapter {
  readonly kind = "live_disabled" as const;
  async submit(): Promise<OrderResult> {
    return { accepted: false, status: "REJECTED", reason: "LIVE TRADING IS DISABLED IN THIS RELEASE. No signing path exists. See docs/live-trading-checklist.md." };
  }
  async cancel(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: false, reason: "LIVE TRADING IS DISABLED IN THIS RELEASE." };
  }
}
