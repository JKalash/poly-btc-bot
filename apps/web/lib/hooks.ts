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

/** Live cockpit: WebSocket (ticket auth) with automatic polling fallback. */
export function useCockpit(): { state: CockpitState | null; live: boolean } {
  const [state, setState] = useState<CockpitState | null>(null);
  const [live, setLive] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const poll = () => {
      api<CockpitState>("/api/state").then((s) => { if (!stopped) setState(s); }).catch(() => undefined);
    };

    const connect = async () => {
      try {
        const { ticket } = await api<{ ticket: string }>("/api/ws-ticket");
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const wsUrl = `${proto}://127.0.0.1:8787/api/ws?ticket=${ticket}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data as string) as { channel: string; payload: CockpitState };
            if (msg.channel === "cockpit" && !stopped) { setState(msg.payload); setLive(true); }
          } catch { /* ignore */ }
        };
        ws.onclose = () => { setLive(false); };
        ws.onerror = () => { setLive(false); };
      } catch {
        setLive(false);
      }
    };

    poll();
    void connect();
    pollTimer = setInterval(poll, 2000); // belt-and-suspenders: WS may drop silently
    return () => {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      wsRef.current?.close();
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
