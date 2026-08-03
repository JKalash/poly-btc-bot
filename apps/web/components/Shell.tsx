"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { u6, useCockpit, type CockpitState } from "../lib/hooks";
import { StateBadge } from "./ui";

const CockpitCtx = createContext<{ state: CockpitState | null; live: boolean }>({ state: null, live: false });
export const useCockpitCtx = () => useContext(CockpitCtx);

const NAV: Array<[string, string]> = [
  ["/", "Cockpit"],
  ["/decisions", "Decisions"],
  ["/orders", "Orders & Positions"],
  ["/pnl", "P&L Analytics"],
  ["/evidence", "Evidence Lab"],
  ["/execution", "Execution Lab"],
  ["/strategy", "Strategy Comparison"],
  ["/timing-lab", "Timing Lab"],
  ["/risk", "Risk Center"],
  ["/config", "Configuration"],
  ["/audit", "Audit & Health"],
  ["/tutorial", "Tutorial"],
];

function Countdown({ endEpoch }: { endEpoch: number | undefined }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  if (!endEpoch) return <span className="text-muted">—</span>;
  const s = Math.max(0, endEpoch - now / 1000);
  const warn = s < 30;
  return (
    <span className={`num font-semibold ${warn ? "text-warning" : "text-ink"}`}>
      {Math.floor(s / 60)}:{String(Math.floor(s % 60)).padStart(2, "0")}
    </span>
  );
}

function UtcClock({ skewMs }: { skewMs: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="text-right">
      <div className="num text-[13px] text-ink">{new Date(now).toISOString().slice(11, 19)} UTC</div>
      <div className="text-[10px] text-muted">skew {skewMs === null ? "?" : `${skewMs}ms`}</div>
    </div>
  );
}

function KillSwitch() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setConfirming(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const fire = async () => {
    setBusy(true);
    try {
      await api("/api/kill", { method: "POST", body: JSON.stringify({ reason: "operator emergency stop (dashboard)" }) });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <>
      <button
        onClick={() => setConfirming(true)}
        className="border border-critical/60 text-critical hover:bg-critical/15 rounded px-3 py-1.5 text-[12px] font-bold tracking-wide"
        title="Emergency stop (Ctrl+Shift+K)"
      >
        ■ EMERGENCY STOP
      </button>
      {confirming && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center" role="dialog" aria-modal>
          <div className="panel p-6 max-w-md">
            <h3 className="text-critical font-bold text-lg mb-2">Emergency stop</h3>
            <p className="text-[13px] mb-1">Immediately disables new orders and attempts to cancel resting orders.</p>
            <p className="text-[13px] text-muted mb-4">Filled positions are NOT market-exited automatically; they will require manual review. This action is written to the audit log.</p>
            <div className="flex gap-3 justify-end">
              <button className="px-3 py-1.5 text-[13px] border border-hairline rounded hover:bg-panel2" onClick={() => setConfirming(false)}>Cancel</button>
              <button className="px-3 py-1.5 text-[13px] font-bold bg-critical text-white rounded disabled:opacity-50" disabled={busy} onClick={() => void fire()}>
                {busy ? "Stopping…" : "STOP TRADING"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const cockpit = useCockpit();
  const s = cockpit.state;

  if (pathname.startsWith("/login")) return <>{children}</>;

  const sessionPnl = s ? Number(s.bankroll.bankroll6) - Number(s.bankroll.sessionPeak6) : 0;

  return (
    <CockpitCtx.Provider value={cockpit}>
      <div className="min-h-screen flex">
        <aside className="w-52 shrink-0 border-r border-hairline bg-panel min-h-screen flex flex-col">
          <div className="px-4 py-4 border-b border-hairline">
            <div className="text-ink font-bold text-[15px]">BTC 5m Console</div>
            <div className="text-[10px] text-muted">Polymarket research &amp; paper trading</div>
          </div>
          <nav className="flex-1 py-2">
            {NAV.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                className={`block px-4 py-2 text-[13px] border-l-2 ${pathname === href ? "border-up text-ink bg-panel2" : "border-transparent text-ink2 hover:text-ink hover:bg-panel2"}`}
              >
                {label}
              </Link>
            ))}
          </nav>
          <div className="px-4 py-3 border-t border-hairline text-[10px] text-muted">
            {s?.engineVersion ?? "engine offline"} · cfg v{s?.configVersion ?? "?"}
          </div>
        </aside>

        <div className="flex-1 min-w-0">
          <header className="sticky top-0 z-40 bg-page/95 backdrop-blur border-b border-hairline px-5 py-2.5 flex items-center gap-5">
            <StateBadge state={s?.mode?.toUpperCase() === "PAPER" ? "PAPER" : (s?.mode?.toUpperCase() ?? "OFFLINE")} label={`MODE: ${s?.mode?.toUpperCase() ?? "OFFLINE"}`} />
            <StateBadge state={s?.engineState ?? "OFFLINE"} />
            {s?.haltReason && <span className="text-critical text-[12px] font-semibold truncate max-w-xs" title={s.haltReason}>⚠ {s.haltReason}</span>}
            <div className="text-[12px]">
              <span className="text-muted">Bankroll </span>
              <span className="num text-ink font-semibold">${u6(s?.bankroll.bankroll6)}</span>
              {s && !s.bankroll.reconciled && <span className="text-warning ml-1">(unreconciled)</span>}
            </div>
            <div className="text-[12px]">
              <span className="text-muted">Session P&amp;L </span>
              <span className={`num font-semibold ${sessionPnl > 0 ? "text-good" : sessionPnl < 0 ? "text-critical" : "text-ink"}`}>
                {sessionPnl >= 0 ? "+" : ""}{(sessionPnl / 1e6).toFixed(2)}
              </span>
            </div>
            <div className="text-[12px]">
              <span className="text-muted">Exposure </span>
              <span className="num text-ink">${u6(s?.bankroll.openExposure6)}</span>
            </div>
            <div className="text-[12px] flex items-center gap-1.5">
              <span className="text-muted">Close in</span>
              <Countdown endEpoch={s?.activeMarket?.endEpoch} />
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              {s && Object.entries(s.feeds).map(([name, f]) => (
                <span key={name} title={`${name}: ${f.ageMs ?? "?"}ms`} className={`inline-flex items-center gap-1 ${f.healthy ? "text-ink2" : "text-critical"}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${f.healthy ? "bg-good" : "bg-critical"}`} aria-hidden />
                  {name.replace("binance_klines", "klines").replace("clob_book", "book")}
                </span>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-4">
              <UtcClock skewMs={s?.clockSkewMs ?? null} />
              <KillSwitch />
            </div>
          </header>
          <main className="p-5">{children}</main>
        </div>
      </div>
    </CockpitCtx.Provider>
  );
}
