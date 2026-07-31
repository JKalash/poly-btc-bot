"use client";

import { useState } from "react";
import { useCockpitCtx } from "../../components/Shell";
import { Card, Th, Td } from "../../components/ui";

/**
 * Risk Center. Profiles are displayed from their canonical in-code definitions;
 * the editor path goes through /config (validated, versioned, and clamped by
 * the absolute 10% safety cap in code).
 */

const PROFILES = [
  { name: "paper_exploration", base: "simulated stake", cap: "no economic cap (paper only)", session: "—", daily: "—", consec: "—", live: false },
  { name: "aggressive", base: "2%", cap: "5%", session: "8%", daily: "12%", consec: "3", live: true },
  { name: "very_aggressive", base: "5%", cap: "10%", session: "15%", daily: "20%", consec: "2", live: true },
  { name: "custom", base: "configurable", cap: "clamped to 10% absolute", session: "cfg", daily: "cfg", consec: "cfg", live: false },
];

function lossStreakTable(frac: number): Array<{ n: number; remaining: number }> {
  return [1, 2, 3, 5, 10].map((n) => ({ n, remaining: Math.pow(1 - frac, n) * 100 }));
}

export default function RiskPage() {
  const { state: s } = useCockpitCtx();
  const [ackText, setAckText] = useState("");
  const [frac, setFrac] = useState(0.10);
  const [target, setTarget] = useState(0.01);
  const [price, setPrice] = useState(0.95);
  const required = (target * price) / (1 - price);
  const acked = ackText.trim() === "I understand a 10% stake can lose 10% of my bankroll in five minutes";

  return (
    <div className="grid grid-cols-2 gap-4">
      <Card title={`Risk profiles · active: ${s?.profile ?? "…"}`}>
        <table className="w-full">
          <thead><tr><Th>Profile</Th><Th>Base</Th><Th>Per-market cap</Th><Th>Session stop</Th><Th>Daily stop</Th><Th>Consec-loss stop</Th><Th>Live-capable</Th></tr></thead>
          <tbody>
            {PROFILES.map((p) => (
              <tr key={p.name} className={p.name === s?.profile ? "bg-panel2" : ""}>
                <Td className={`font-semibold ${p.name === s?.profile ? "text-ink" : ""}`}>{p.name}</Td>
                <Td className="num">{p.base}</Td><Td className="num">{p.cap}</Td>
                <Td className="num">{p.session}</Td><Td className="num">{p.daily}</Td><Td className="num">{p.consec}</Td>
                <Td>{p.live ? "yes (release-gated)" : "no"}</Td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] text-muted mt-3">
          Live trading is disabled in this release regardless of profile: no signing path exists in the codebase.
          Profile switching and custom limits go through Configuration (validated, versioned, absolute 10% cap enforced in code and tests).
          No martingale, no averaging down, no auto re-arm, no all-in preset — these are non-configurable.
        </p>
      </Card>

      <Card title="Very-aggressive acknowledgement (spec-mandated friction)">
        <p className="text-[13px] text-ink2 mb-2">
          A 10% stake is genuinely extreme: <span className="num text-warning font-semibold">five full losses leave ~59%</span> of starting
          capital, <span className="num text-warning font-semibold">ten leave ~35%</span>. The consecutive-loss stop (2) halts sooner, but only if you let it.
        </p>
        <label className="text-[12px] text-muted block mb-1">Type: “I understand a 10% stake can lose 10% of my bankroll in five minutes”</label>
        <input value={ackText} onChange={(e) => setAckText(e.target.value)}
          className="w-full bg-page border border-hairline rounded px-3 py-2 text-[13px] text-ink mb-2 focus:outline-none focus:border-warning" />
        <div className={`text-[12px] font-semibold ${acked ? "text-good" : "text-muted"}`}>
          {acked ? "✓ Acknowledged for this session (activation still requires a config change)" : "Not acknowledged"}
        </div>
      </Card>

      <Card title="Drawdown simulator — consecutive full losses">
        <div className="flex items-center gap-3 mb-3 text-[13px]">
          <label className="text-muted">Stake fraction</label>
          <input type="range" min={0.01} max={0.10} step={0.01} value={frac} onChange={(e) => setFrac(Number(e.target.value))} className="w-48" />
          <span className="num text-ink font-semibold">{(frac * 100).toFixed(0)}%</span>
          <span className="text-muted text-[11px]">(the slider stops at the absolute 10% cap — there is no higher setting)</span>
        </div>
        <table className="w-full max-w-sm">
          <thead><tr><Th>Consecutive losses</Th><Th>Bankroll remaining</Th></tr></thead>
          <tbody>
            {lossStreakTable(frac).map((r) => (
              <tr key={r.n}>
                <Td className="num">{r.n}</Td>
                <Td className={`num font-semibold ${r.remaining < 70 ? "text-warning" : "text-ink"}`}>{r.remaining.toFixed(1)}%</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Target-return calculator (display only — targets never authorize risk)">
        <div className="flex items-center gap-4 mb-3 text-[13px]">
          <label className="text-muted">Target</label>
          <select value={target} onChange={(e) => setTarget(Number(e.target.value))} className="bg-page border border-hairline rounded px-2 py-1">
            {[0.005, 0.01, 0.02].map((t) => <option key={t} value={t}>{(t * 100).toFixed(1)}%</option>)}
          </select>
          <label className="text-muted">at price</label>
          <select value={price} onChange={(e) => setPrice(Number(e.target.value))} className="bg-page border border-hairline rounded px-2 py-1">
            {[0.55, 0.65, 0.75, 0.8, 0.85, 0.9, 0.95].map((p) => <option key={p} value={p}>{p.toFixed(2)}</option>)}
          </select>
        </div>
        <div className="text-[14px]">
          Required stake: <span className={`num font-bold ${required > 0.10 ? "text-critical" : "text-ink"}`}>{(required * 100).toFixed(2)}% of bankroll</span>
        </div>
        {required > 0.10 && (
          <p className="text-critical text-[13px] font-semibold mt-2">
            Target profit requires risk above your configured cap. At {price.toFixed(2)}, a {(target * 100).toFixed(0)}% target needs {(required * 100).toFixed(0)}% at risk — the request is refused, not resized.
          </p>
        )}
        <p className="text-[11px] text-muted mt-3">
          A fixed “1% every five minutes” compounds to ≈{(Math.pow(1.01, 288)).toFixed(0)}× per day — mathematically incompatible with bounded risk. Position sizing happens after edge validation, never because a target “needs” it.
        </p>
      </Card>

      <Card title="Paper sizing simulations (gist modes)" className="col-span-2">
        <p className="text-[13px] text-ink2 mb-2">
          The PolymarketBot gist's sizing modes are available <span className="font-semibold text-ink">in paper mode only</span> (config → paper.sizing_simulation), so their ruin dynamics can be observed on simulated money:
        </p>
        <ul className="text-[12px] space-y-1 text-ink2 list-disc pl-5">
          <li><span className="font-mono text-ink">gist_safe</span> — 25% of bankroll per trade. 2.5× above the absolute live cap; ~10 consecutive losses ≈ 5.6% of capital left.</li>
          <li><span className="font-mono text-ink">gist_aggressive</span> — all profits above principal, every trade.</li>
          <li><span className="font-mono text-ink">gist_degen</span> — the entire simulated bankroll every 5 minutes. This is a ruin demonstration: one loss is terminal. It exists so that fact is experienced on paper, not discovered live.</li>
        </ul>
        <p className="text-[11px] text-muted mt-2">These modes are structurally unreachable from shadow/live paths. The armed-path maximum remains 10% per market, in code and covered by tests.</p>
      </Card>
    </div>
  );
}
