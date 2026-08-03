"use client";

import { useState } from "react";
import { Empty } from "./ui";

/**
 * Dependency-free charts (HTML + inline SVG) following the validated reference
 * dataviz palette already used by the tailwind theme (dark-surface steps).
 * Single-series marks use categorical slot 1 (blue #3987e5 = theme `up`),
 * validated ≥3:1 on the dark surface. Text always wears text tokens, never the
 * series color. Every chart has a table-view twin rendered by its page.
 */

const VIZ = {
  surface: "#1a1a19",  // panel
  grid: "#2c2c2a",
  baseline: "#383835",
  ink: "#ffffff",
  ink2: "#c3c2b7",
  muted: "#898781",
  series1: "#3987e5",
} as const;

/** Round a positive number up to a clean tick ceiling (1/2/2.5/5 × 10^k). */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const m = v / base;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return step * base;
}

// ---------------------------------------------------------------------------
// Horizontal bar rows (funnel + generic counts). Bar-table hybrid: the value
// column doubles as the direct label, so nothing is ever clipped inside a bar.
// ---------------------------------------------------------------------------

export interface BarRowDatum {
  label: string;
  count: number;
  /** Secondary right-hand annotation, e.g. "% of top". */
  sub?: string;
  /** Muted row (side/terminal states rather than the main path). */
  dim?: boolean;
}

export function HBarRows({ rows, emptyText }: { rows: BarRowDatum[]; emptyText: string }) {
  if (rows.length === 0 || rows.every((r) => r.count === 0)) return <Empty text={emptyText} />;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div>
      {rows.map((r) => (
        <div
          key={r.label}
          className="group flex items-center gap-3 min-h-[24px]"
          title={`${r.label}: ${r.count.toLocaleString("en-US")}${r.sub ? ` (${r.sub})` : ""}`}
        >
          <div className="w-44 shrink-0 text-[11px] uppercase tracking-wider text-muted text-right truncate">{r.label}</div>
          <div className="flex-1 relative h-[14px]" aria-hidden>
            {r.count > 0 && (
              <div
                className={`absolute inset-y-0 left-0 rounded-r-[4px] transition-[filter] group-hover:brightness-125 ${r.dim ? "bg-up/40" : "bg-up"}`}
                style={{ width: `max(2px, ${(r.count / max) * 100}%)` }}
              />
            )}
          </div>
          <div className="w-16 shrink-0 num text-[13px] text-ink text-right">{r.count.toLocaleString("en-US")}</div>
          <div className="w-14 shrink-0 num text-[11px] text-muted text-right">{r.sub ?? ""}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Latency waterfall: cumulative p50 offsets along the send path, p90 whisker.
// ---------------------------------------------------------------------------

export interface LatencyStageDatum {
  stage: string;
  n: number;
  p50Us: number;
  p90Us: number;
  /** Cumulative start offset in µs (0 for independent stages). */
  offsetUs: number;
  /** Independent stage (not part of the cumulative path). */
  independent?: boolean;
}

export function LatencyWaterfall({ stages, emptyText }: { stages: LatencyStageDatum[]; emptyText: string }) {
  const present = stages.filter((s) => s.n > 0);
  if (present.length === 0) return <Empty text={emptyText} />;
  const domain = niceCeil(Math.max(...present.map((s) => s.offsetUs + Math.max(s.p90Us, s.p50Us)), 1));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * domain);
  const x = (us: number) => `${(us / domain) * 100}%`;
  const fmt = (us: number) => (us === 0 ? "0" : us >= 1000 ? `${(us / 1000).toFixed(us >= 10_000 ? 0 : 1)}ms` : `${Math.round(us)}µs`);
  return (
    <div>
      {present.map((s) => (
        <div key={s.stage} className="group flex items-center gap-3 min-h-[24px]"
          title={`${s.stage}: p50 ${fmt(s.p50Us)} · p90 ${fmt(s.p90Us)} · n=${s.n}`}>
          <div className="w-24 shrink-0 text-[11px] uppercase tracking-wider text-muted text-right">
            {s.stage}{s.independent && <span className="normal-case tracking-normal"> *</span>}
          </div>
          <div className="flex-1 relative h-[14px]">
            {/* hairline gridlines behind the marks */}
            {ticks.slice(1).map((t) => (
              <div key={t} className="absolute inset-y-[-5px] w-px" style={{ left: x(t), background: VIZ.grid }} aria-hidden />
            ))}
            {/* p50 bar: square at its start, 4px rounded data-end */}
            <div
              className="absolute inset-y-0 bg-up rounded-r-[4px] transition-[filter] group-hover:brightness-125"
              style={{ left: x(s.offsetUs), width: `max(2px, calc(${x(Math.max(s.p50Us, 1))}))` }}
              aria-hidden
            />
            {/* p90 whisker */}
            {s.p90Us > s.p50Us && (
              <div
                className="absolute top-1/2 -translate-y-1/2 h-[2px] bg-up/45"
                style={{ left: `calc(${x(s.offsetUs + s.p50Us)})`, width: `calc(${x(s.p90Us - s.p50Us)})` }}
                aria-hidden
              />
            )}
          </div>
          <div className="w-20 shrink-0 num text-[13px] text-ink text-right">{fmt(s.p50Us)}</div>
          <div className="w-20 shrink-0 num text-[11px] text-muted text-right">p90 {fmt(s.p90Us)}</div>
        </div>
      ))}
      <div className="flex items-center gap-3 mt-1">
        <div className="w-24 shrink-0" />
        <div className="flex-1 relative h-4">
          {ticks.map((t) => (
            <span key={t} className="absolute -translate-x-1/2 text-[10px] text-muted num" style={{ left: x(t) }}>{fmt(t)}</span>
          ))}
        </div>
        <div className="w-20 shrink-0" />
        <div className="w-20 shrink-0" />
      </div>
      <p className="text-[11px] text-muted mt-2">
        Bar = median (p50), offset cumulatively along the SIGN → SEND → ACK path; whisker → p90.
        * CANCEL and BOOK_FEED are independent stages, drawn from zero.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markout curve: single-series line over ordered horizons, zero baseline.
// ---------------------------------------------------------------------------

export interface MarkoutPoint {
  label: string;
  /** Display value in cents of price per share (signed; negative = adverse). */
  valueCents: number;
  n: number;
}

const W = 640, H = 230, PAD_L = 52, PAD_R = 40, PAD_T = 16, PAD_B = 30;

export function MarkoutCurve({ points, emptyText }: { points: MarkoutPoint[]; emptyText: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return <Empty text={emptyText} />;

  const vals = points.map((p) => p.valueCents);
  const rawMax = Math.max(0, ...vals);
  const rawMin = Math.min(0, ...vals);
  const span = Math.max(rawMax - rawMin, 0.01);
  const yMax = rawMax + span * 0.15;
  const yMin = rawMin - span * 0.15;
  const xAt = (i: number) => PAD_L + (points.length === 1 ? 0 : (i * (W - PAD_L - PAD_R)) / (points.length - 1));
  const yAt = (v: number) => PAD_T + ((yMax - v) * (H - PAD_T - PAD_B)) / (yMax - yMin);

  const tickStep = niceCeil((yMax - yMin) / 4);
  const yTicks: number[] = [];
  for (let t = Math.ceil(yMin / tickStep) * tickStep; t <= yMax + 1e-9; t += tickStep) yTicks.push(Number(t.toFixed(6)));

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(p.valueCents).toFixed(1)}`).join(" ");
  const last = points[points.length - 1]!;
  const lastY = yAt(last.valueCents);
  const slotW = (W - PAD_L - PAD_R) / Math.max(points.length - 1, 1);

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
        aria-label={`Average post-fill markout by horizon, ${points.map((p) => `${p.label} ${p.valueCents.toFixed(2)} cents`).join(", ")}`}>
        {/* gridlines */}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={yAt(t)} y2={yAt(t)} stroke={VIZ.grid} strokeWidth="1" />
            <text x={PAD_L - 8} y={yAt(t) + 3.5} textAnchor="end" fontSize="10" fill={VIZ.muted}>
              {t > 0 ? "+" : ""}{t.toFixed(tickStep < 0.01 ? 3 : tickStep < 1 ? 2 : 1)}¢
            </text>
          </g>
        ))}
        {/* zero line (the adverse boundary) */}
        {yMin < 0 && yMax > 0 && (
          <line x1={PAD_L} x2={W - PAD_R} y1={yAt(0)} y2={yAt(0)} stroke={VIZ.muted} strokeWidth="1" />
        )}
        {/* x labels */}
        {points.map((p, i) => (
          <text key={p.label} x={xAt(i)} y={H - 8} textAnchor="middle" fontSize="10" fill={VIZ.muted}>{p.label}</text>
        ))}
        {/* series line */}
        <path d={path} fill="none" stroke={VIZ.series1} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {/* markers with a 2px surface ring */}
        {points.map((p, i) => (
          <circle key={p.label} cx={xAt(i)} cy={yAt(p.valueCents)} r={hover === i ? 5.5 : 4.5}
            fill={VIZ.series1} stroke={VIZ.surface} strokeWidth="2" />
        ))}
        {/* direct label at the endpoint only */}
        <text x={Math.min(xAt(points.length - 1), W - PAD_R)} y={lastY < PAD_T + 18 ? lastY + 16 : lastY - 10}
          textAnchor="end" fontSize="11" fill={VIZ.ink} fontWeight="600">
          {last.valueCents > 0 ? "+" : ""}{last.valueCents.toFixed(Math.abs(last.valueCents) < 0.005 && last.valueCents !== 0 ? 3 : 2)}¢
        </text>
        {/* hover hit columns (≥24px targets) */}
        {points.map((p, i) => (
          <rect key={p.label} x={xAt(i) - slotW / 2} y={0} width={slotW} height={H} fill="transparent"
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
        ))}
      </svg>
      {hover !== null && points[hover] && (
        <div
          className="absolute pointer-events-none bg-panel2 border border-hairline rounded px-2.5 py-1.5 text-[12px] shadow-lg"
          style={{
            left: `${(xAt(hover) / W) * 100}%`,
            top: `${(yAt(points[hover].valueCents) / H) * 100}%`,
            transform: `translate(${hover > points.length / 2 ? "-105%" : "8px"}, -110%)`,
          }}
        >
          <div className="num text-ink font-semibold">
            {points[hover].valueCents > 0 ? "+" : ""}{points[hover].valueCents.toFixed(2)}¢ / share
          </div>
          <div className="text-muted flex items-center gap-1.5">
            <span className="inline-block w-3 h-[2px]" style={{ background: VIZ.series1 }} aria-hidden />
            {points[hover].label} · n={points[hover].n}
          </div>
        </div>
      )}
    </div>
  );
}
