import { schema, type Db, type DbHandle } from "@b5p/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  MarketExposureGuardStore,
  type MarketExposureGuardRow,
} from "./market-exposure-guard-store";

const ACTIVE_ORDER_STATES = ["PENDING", "LIVE", "DELAYED", "PARTIAL"] as const;

export class DirectionalExposureConflictError extends Error {
  readonly code = "DIRECTIONAL_MARKET_OWNERSHIP_CONFLICT" as const;
  override readonly name = "DirectionalExposureConflictError";
}

/** One stable aggregate owner permits existing same-market directional orders. */
export function directionalMarketOwnerId(marketId: string): string {
  if (marketId.trim().length === 0) throw new TypeError("marketId must be non-empty");
  return `directional_market:${marketId}`;
}

function conflict(marketId: string, guard: MarketExposureGuardRow | null): never {
  throw new DirectionalExposureConflictError(
    guard?.ownerKind === "PAIR_GROUP"
      ? `${marketId} is owned by pair group ${guard.ownerId}`
      : `${marketId} has incompatible active owner ${guard?.ownerKind ?? "unknown"}:${guard?.ownerId ?? "unknown"}`,
  );
}

export class DirectionalExposureCoordinator {
  constructor(private readonly handle: DbHandle) {}

  transaction<T>(work: (guard: MarketExposureGuardStore, executor: Db) => Promise<T>): Promise<T> {
    return new MarketExposureGuardStore(this.handle).transaction(work);
  }

  /** Claim before persisting a directional order intent. Pair ownership always blocks. */
  async claimOrder(guard: MarketExposureGuardStore, marketId: string, nowMs: number): Promise<void> {
    const ownerId = directionalMarketOwnerId(marketId);
    const current = await guard.get(marketId);
    if (current?.releasedAtMs === null) {
      if (current.ownerId !== ownerId || current.ownerKind === "PAIR_GROUP") conflict(marketId, current);
      return; // same directional aggregate: multiple orders retain one owner
    }
    const result = await guard.acquire({
      marketId,
      ownerKind: "DIRECTIONAL_ORDER",
      ownerId,
      ownerState: "ACTIVE",
      acquiredAtMs: Math.max(nowMs, current?.updatedAtMs ?? 0),
    });
    if (result.kind === "CONFLICT") conflict(marketId, result.guard);
  }

  /**
   * Recompute aggregate ownership from durable directional truth. A matched
   * fill without an OPEN/RESOLVED position is intentionally retained as
   * reconciliation-required: crashes never create an unguarded exposure.
   */
  async reconcile(guard: MarketExposureGuardStore, executor: Db, marketId: string, nowMs: number): Promise<void> {
    const ownerId = directionalMarketOwnerId(marketId);
    const [orders, openPositions, resolvedPositions] = await Promise.all([
      executor.select().from(schema.orders).where(and(
        eq(schema.orders.marketId, marketId),
        isNull(schema.orders.pairGroupId),
      )),
      executor.select().from(schema.positions).where(and(
        eq(schema.positions.marketId, marketId), eq(schema.positions.status, "OPEN"), gt(schema.positions.shares6, 0n),
      )),
      executor.select().from(schema.positions).where(and(
        eq(schema.positions.marketId, marketId), eq(schema.positions.status, "RESOLVED"),
      )),
    ]);
    const activeOrders = orders.filter((row) => (ACTIVE_ORDER_STATES as readonly string[]).includes(row.status));
    const filledOrders = orders.filter((row) => row.filledShares6 > 0n || row.status === "MATCHED");
    const latestResolutionMs = resolvedPositions.reduce(
      (latest, row) => Math.max(latest, row.resolvedAtMs ?? -1),
      -1,
    );
    // A historical RESOLVED position only closes fills from that lifecycle.
    // If a later fill/order update exists, retain ownership until its own
    // position is durably OPEN or RESOLVED. This is deliberately conservative
    // for legacy MATCHED rows whose fill evidence may be incomplete.
    const hasUnresolvedFill = filledOrders.some((row) => row.updatedAtMs > latestResolutionMs);
    let current = await guard.get(marketId);
    const needsOwner = openPositions.length > 0 || activeOrders.length > 0 || hasUnresolvedFill;
    if (current?.releasedAtMs === null && (current.ownerKind === "PAIR_GROUP" || current.ownerId !== ownerId)) {
      if (needsOwner) conflict(marketId, current);
      return;
    }
    if (current === null || current.releasedAtMs !== null) {
      if (!needsOwner) return;
      const kind = openPositions.length > 0 ? "DIRECTIONAL_POSITION" : "DIRECTIONAL_ORDER";
      const acquired = await guard.acquire({
        marketId, ownerKind: kind, ownerId,
        ownerState: openPositions.length > 0 ? "OPEN" : activeOrders.length > 0 ? "ACTIVE" : "FILL_RECONCILIATION_REQUIRED",
        acquiredAtMs: Math.max(nowMs, current?.updatedAtMs ?? 0),
      });
      if (acquired.kind === "CONFLICT") conflict(marketId, acquired.guard);
      current = acquired.guard;
    }
    if (openPositions.length > 0) {
      await this.updateIfNeeded(guard, current, "DIRECTIONAL_POSITION", "OPEN", nowMs);
      return;
    }
    if (activeOrders.length > 0) {
      await this.updateIfNeeded(guard, current, "DIRECTIONAL_ORDER", "ACTIVE", nowMs);
      return;
    }
    if (hasUnresolvedFill) {
      await this.updateIfNeeded(guard, current, current.ownerKind === "DIRECTIONAL_POSITION" ? "DIRECTIONAL_POSITION" : "DIRECTIONAL_ORDER", "FILL_RECONCILIATION_REQUIRED", nowMs);
      return;
    }
    if (current.ownerKind === "DIRECTIONAL_POSITION") {
      const released = await guard.release({
        marketId, ownerKind: "DIRECTIONAL_POSITION", ownerId,
        terminalState: "FLAT", expectedStateVersion: current.stateVersion, releasedAtMs: Math.max(nowMs, current.updatedAtMs),
      });
      if (released.kind === "CONFLICT" && released.code !== "ALREADY_RELEASED") conflict(marketId, released.guard);
      return;
    }
    const statuses = new Set(orders.map((row) => row.status));
    const terminalState = statuses.has("REJECTED") ? "REJECTED"
      : statuses.has("CANCELED") ? "CANCELED"
        : statuses.has("EXPIRED") ? "EXPIRED" : "NO_FILL";
    const released = await guard.release({
      marketId, ownerKind: "DIRECTIONAL_ORDER", ownerId,
      terminalState, expectedStateVersion: current.stateVersion, releasedAtMs: Math.max(nowMs, current.updatedAtMs),
    });
    if (released.kind === "CONFLICT" && released.code !== "ALREADY_RELEASED") conflict(marketId, released.guard);
  }

  async reconcileMarkets(executor: Db, marketIds: readonly string[], nowMs: number): Promise<void> {
    const guard = new MarketExposureGuardStore(this.handle, executor);
    for (const marketId of new Set(marketIds)) await this.reconcile(guard, executor, marketId, nowMs);
  }

  private async updateIfNeeded(
    guard: MarketExposureGuardStore,
    current: MarketExposureGuardRow,
    nextOwnerKind: "DIRECTIONAL_ORDER" | "DIRECTIONAL_POSITION",
    nextOwnerState: string,
    nowMs: number,
  ): Promise<void> {
    if (current.ownerKind === nextOwnerKind && current.ownerState === nextOwnerState) return;
    const result = await guard.update({
      marketId: current.marketId,
      expectedStateVersion: current.stateVersion,
      ownerKind: current.ownerKind as "DIRECTIONAL_ORDER" | "DIRECTIONAL_POSITION",
      ownerId: current.ownerId,
      nextOwnerKind,
      nextOwnerId: current.ownerId,
      nextOwnerState,
      updatedAtMs: Math.max(nowMs, current.updatedAtMs),
    });
    if (result.kind === "CONFLICT") conflict(current.marketId, result.guard);
  }
}
