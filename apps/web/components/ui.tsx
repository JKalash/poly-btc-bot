"use client";

import type { ReactNode } from "react";

export function Card({ title, children, right, className = "" }: { title?: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between px-4 py-2.5 border-b border-hairline">
          <h2 className="text-[12px] uppercase tracking-wider text-muted font-medium">{title}</h2>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "critical" | "warning" | undefined }) {
  const toneCls = tone === "good" ? "text-good" : tone === "critical" ? "text-critical" : tone === "warning" ? "text-warning" : "text-ink";
  return (
    <div className="px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-xl font-semibold num ${toneCls}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

const STATE_TONE: Record<string, string> = {
  PAPER: "bg-up/15 text-up border-up/40",
  SHADOW: "bg-warning/15 text-warning border-warning/40",
  READ_ONLY: "bg-panel2 text-ink2 border-hairline",
  OBSERVE: "bg-panel2 text-ink2 border-hairline",
  HALTED: "bg-critical/15 text-critical border-critical/50",
  DEGRADED: "bg-serious/15 text-serious border-serious/50",
  LIVE_ARMED: "bg-critical/15 text-critical border-critical/50",
  OFFLINE: "bg-panel2 text-muted border-hairline",
};

export function StateBadge({ state, label }: { state: string; label?: string }) {
  const cls = STATE_TONE[state] ?? "bg-panel2 text-ink2 border-hairline";
  return (
    <span className={`inline-flex items-center gap-1.5 border rounded px-2 py-0.5 text-[12px] font-semibold tracking-wide ${cls}`}>
      {(state === "HALTED" || state === "DEGRADED") && <span aria-hidden>⚠</span>}
      {label ?? state}
    </span>
  );
}

export function SideTag({ side }: { side: string | null }) {
  if (!side) return <span className="text-muted">—</span>;
  return <span className={`font-semibold ${side === "UP" ? "text-up" : "text-down"}`}>{side}</span>;
}

export function Check({ pass }: { pass: boolean }) {
  return pass
    ? <span className="text-good" aria-label="pass">✓</span>
    : <span className="text-critical" aria-label="fail">✕</span>;
}

/** Thin single-hue meter (sequential blue), 4px rounded end, baseline-anchored. */
export function Meter({ value, max = 1, className = "" }: { value: number; max?: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={`h-[6px] bg-grid rounded-sm overflow-hidden ${className}`} role="img" aria-label={`${(value).toFixed(3)} of ${max}`}>
      <div className="h-full bg-up rounded-r-[4px]" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Th({ children }: { children: ReactNode }) { return <th className="th">{children}</th>; }
export function Td({ children, className = "" }: { children: ReactNode; className?: string }) { return <td className={`td ${className}`}>{children}</td>; }

export function Empty({ text }: { text: string }) {
  return <div className="text-muted text-[13px] py-6 text-center">{text}</div>;
}
