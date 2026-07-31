/** Deterministic state machines. Transitions outside these tables throw. */

export const MARKET_STATES = [
  "DISCOVERED", "WARMING", "OBSERVING", "CANDIDATE", "RISK_APPROVED",
  "ORDER_PENDING", "RESTING", "PARTIAL", "FILLED", "RESOLVED", "RECONCILED",
  "REJECTED", "CANCELED", "HALTED", "STALE",
] as const;
export type MarketInstanceState = (typeof MARKET_STATES)[number];

const ACTIVE: MarketInstanceState[] = [
  "DISCOVERED", "WARMING", "OBSERVING", "CANDIDATE", "RISK_APPROVED", "ORDER_PENDING", "RESTING", "PARTIAL",
];

export const MARKET_TRANSITIONS: Record<MarketInstanceState, readonly MarketInstanceState[]> = {
  DISCOVERED: ["WARMING", "HALTED", "STALE", "RESOLVED"],
  WARMING: ["OBSERVING", "HALTED", "STALE", "RESOLVED"],
  OBSERVING: ["CANDIDATE", "RESOLVED", "HALTED", "STALE"],
  CANDIDATE: ["RISK_APPROVED", "REJECTED", "OBSERVING", "RESOLVED", "HALTED", "STALE"],
  RISK_APPROVED: ["ORDER_PENDING", "OBSERVING", "RESOLVED", "HALTED", "STALE"],
  ORDER_PENDING: ["RESTING", "REJECTED", "OBSERVING", "HALTED", "STALE"],
  RESTING: ["PARTIAL", "FILLED", "CANCELED", "RESOLVED", "HALTED", "STALE"],
  PARTIAL: ["FILLED", "CANCELED", "RESOLVED", "HALTED", "STALE"],
  FILLED: ["RESOLVED", "HALTED", "STALE"],
  REJECTED: ["OBSERVING", "RESOLVED", "STALE", "HALTED"],
  CANCELED: ["OBSERVING", "RESOLVED", "STALE", "HALTED"],
  RESOLVED: ["RECONCILED"],
  RECONCILED: [],
  HALTED: ["OBSERVING", "RESOLVED", "STALE"],
  STALE: ["OBSERVING", "RESOLVED", "HALTED"],
};

export const ENGINE_STATES = [
  "BOOTING", "READ_ONLY", "PAPER", "SHADOW", "LIVE_DISARMED", "LIVE_ARMING", "LIVE_ARMED",
  "HALTED", "RECONCILING", "DEGRADED",
] as const;
export type EngineState = (typeof ENGINE_STATES)[number];

export const ENGINE_TRANSITIONS: Record<EngineState, readonly EngineState[]> = {
  BOOTING: ["RECONCILING", "READ_ONLY", "HALTED", "DEGRADED"],
  RECONCILING: ["READ_ONLY", "PAPER", "SHADOW", "LIVE_DISARMED", "HALTED", "DEGRADED"],
  READ_ONLY: ["PAPER", "SHADOW", "LIVE_DISARMED", "HALTED", "DEGRADED", "RECONCILING"],
  PAPER: ["READ_ONLY", "SHADOW", "LIVE_DISARMED", "HALTED", "DEGRADED", "RECONCILING"],
  SHADOW: ["READ_ONLY", "PAPER", "LIVE_DISARMED", "HALTED", "DEGRADED", "RECONCILING"],
  LIVE_DISARMED: ["LIVE_ARMING", "READ_ONLY", "PAPER", "SHADOW", "HALTED", "DEGRADED", "RECONCILING"],
  LIVE_ARMING: ["LIVE_ARMED", "LIVE_DISARMED", "HALTED", "DEGRADED"],
  LIVE_ARMED: ["LIVE_DISARMED", "HALTED", "DEGRADED", "RECONCILING"],
  HALTED: ["RECONCILING", "READ_ONLY", "DEGRADED"],
  DEGRADED: ["RECONCILING", "READ_ONLY", "HALTED"],
};

export function canTransition<S extends string>(table: Record<S, readonly S[]>, from: S, to: S): boolean {
  return (table[from] ?? []).includes(to);
}

export function assertTransition<S extends string>(table: Record<S, readonly S[]>, from: S, to: S, label: string): void {
  if (!canTransition(table, from, to)) {
    throw new Error(`illegal ${label} transition ${from} -> ${to}`);
  }
}

export const isActiveMarketState = (s: MarketInstanceState): boolean => ACTIVE.includes(s);

/** Any live-capable state loses its armed status on these events (spec: restart, credential change, integrity failure, ...). */
export const DISARM_EVENTS = [
  "restart", "deployment", "credential_change", "data_integrity_failure",
  "reconciliation_mismatch", "kill_switch", "fee_schedule_change", "risk_limit_breach",
] as const;
export type DisarmEvent = (typeof DISARM_EVENTS)[number];
