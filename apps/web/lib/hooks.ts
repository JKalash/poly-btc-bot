"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export function useApi<T>(path: string, intervalMs = 0): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<T>(path).then((d) => { setData(d); setError(null); }).catch((e) => setError(String(e.message ?? e)));
  }, [path]);
  useEffect(() => {
    load();
    if (intervalMs > 0) {
      const t = setInterval(load, intervalMs);
      return () => clearInterval(t);
    }
    return undefined;
  }, [load, intervalMs]);
  return { data, error, reload: load };
}

export interface CockpitState {
  ts: number;
  engineState: string;
  mode: string;
  engineVersion: string;
  configVersion: number;
  haltReason: string | null;
  profile: string;
  strategyVersion: string;
  sizingSimulation: string;
  bankroll: {
    bankroll6: string;
    sessionStart6: string;
    sessionPeak6: string;
    dailyPeak6: string;
    consecutiveLosses: number;
    openPositions: number;
    openExposure6: string;
    reconciled: boolean;
  };
  feeds: Record<string, { ageMs: number | null; healthy: boolean }>;
  clockSkewMs: number | null;
  chainlinkNow: { value: number; ageMs: number } | null;
  activeMarket: {
    slug: string;
    marketId: string;
    startEpoch: number;
    endEpoch: number;
    secondsRemaining: number;
    state: string;
    priceToBeat: string | null;
    ptbConsistent: boolean;
    rulesVerified: boolean;
    distanceUsd: number | null;
    distanceBps: number | null;
    distanceZ: number | null;
    upBestBid: number | null;
    upBestAsk: number | null;
    downBestBid: number | null;
    downBestAsk: number | null;
    spread: number | null;
    volatilityEwma: number | null;
    indicators: Record<string, number | string | null> | null;
    gate: { candidate: boolean; side: string | null; checks: Array<{ name: string; pass: boolean; value: string; requirement: string }> } | null;
    lastRejectionReasons: Array<{ code: string; message: string }>;
    dataQuality: number | null;
  } | null;
  nextMarket: { slug: string; startEpoch: number } | null;
  restingOrders: Array<{ id: string; marketId: string; side: string; style: string; price6: string; shares6: string; filled6: string; status: string; queueAhead6: string }>;
  openPositions: Array<{ id: string; marketId: string; side: string; shares6: string; cost6: string; stake6: string }>;
}

/**
 * Runtime shape guard for cockpit payloads. /api/state serves an OFFLINE
 * fallback ({ engineState: "OFFLINE", note }) when no engine has ever
 * published state — it has no bankroll/feeds, and rendering it as a full
 * CockpitState crashed the Shell (reading `bankroll6` of undefined). Only a
 * payload carrying the objects the Shell dereferences may become state.
 */
function isCockpitState(v: unknown): v is CockpitState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as { bankroll?: unknown; feeds?: unknown };
  return (
    typeof s.bankroll === "object" && s.bankroll !== null &&
    typeof s.feeds === "object" && s.feeds !== null
  );
}

/** Live cockpit: WebSocket (ticket auth) with automatic polling fallback. */
export function useCockpit(): { state: CockpitState | null; live: boolean } {
  const [state, setState] = useState<CockpitState | null>(null);
  const [live, setLive] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelayMs = 1_000;

    const poll = () => {
      // OFFLINE fallback / partial payloads fail the shape guard and leave
      // state null — the Shell renders its own OFFLINE presentation for null.
      api<unknown>("/api/state").then((s) => { if (!stopped && isCockpitState(s)) setState(s); }).catch(() => undefined);
    };

    const scheduleReconnect = () => {
      if (stopped || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
      }, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    };

    const connect = async () => {
      try {
        const { ticket } = await api<{ ticket: string }>("/api/ws-ticket");
        if (stopped) return;
        const proto = location.protocol === "https:" ? "wss" : "ws";
        // Same-origin by default: the dashboard proxies /api/* to the API
        // service (next.config rewrites), so the socket follows
        // window.location wherever the app is served. The Next DEV server does
        // not proxy WebSocket upgrades, so dev falls back to the API's local
        // address (kept in the CSP connect-src for exactly this case).
        const host = process.env.NODE_ENV === "development" ? "127.0.0.1:8787" : location.host;
        const wsUrl = `${proto}://${host}/api/ws?ticket=${ticket}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data as string) as { channel: string; payload: unknown };
            if (msg.channel === "cockpit" && !stopped && isCockpitState(msg.payload)) {
              retryDelayMs = 1_000;
              setState(msg.payload);
              setLive(true);
            }
          } catch { /* ignore */ }
        };
        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null;
          if (!stopped) {
            setLive(false);
            scheduleReconnect();
          }
        };
        // scheduleReconnect is idempotent, so error + close cannot create two
        // timers even on browsers that report both events.
        ws.onerror = () => {
          if (!stopped) {
            setLive(false);
            scheduleReconnect();
          }
          ws.close();
        };
      } catch {
        if (!stopped) {
          setLive(false);
          scheduleReconnect();
        }
      }
    };

    poll();
    void connect();
    pollTimer = setInterval(poll, 2000); // belt-and-suspenders: WS may drop silently
    return () => {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      if (retryTimer) clearTimeout(retryTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  return { state, live };
}

export const u6 = (v: string | null | undefined, dp = 2): string => {
  if (v === null || v === undefined) return "—";
  const n = Number(v) / 1e6;
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

export const fmtTs = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z" : "—";
