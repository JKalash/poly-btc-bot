/**
 * Minimal process-global Prometheus text-format registry. No dependencies.
 *
 * The engine (embedded in the API process on Fly — EMBED_ENGINE=1) pushes
 * gauges/counters here on a timer; the API renders them at GET /metrics for
 * the org-private Prometheus (monitoring/fly/prometheus in the mono-repo).
 * In split-process mode the API's render only carries API-side metrics; the
 * engine process would need its own listener — deliberately out of scope
 * while production runs embedded.
 *
 * Counters are exported as ABSOLUTE monotonic totals (set, not increment):
 * every source here (capture queue, ws reconnect counts) already maintains
 * its own lifetime total, and re-exporting those directly cannot drift.
 */

type MetricType = "gauge" | "counter";

interface Metric {
  readonly type: MetricType;
  readonly help: string;
  /** serialized label set -> value */
  readonly values: Map<string, number>;
}

function serializeLabels(labels?: Readonly<Record<string, string>>): string {
  if (!labels) return "";
  const parts = Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`);
  return parts.length === 0 ? "" : `{${parts.join(",")}}`;
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  set(name: string, type: MetricType, help: string, value: number, labels?: Readonly<Record<string, string>>): void {
    if (!Number.isFinite(value)) return; // never emit NaN/Infinity samples
    let m = this.metrics.get(name);
    if (m === undefined) {
      m = { type, help, values: new Map() };
      this.metrics.set(name, m);
    }
    m.values.set(serializeLabels(labels), value);
  }

  gauge(name: string, help: string, value: number, labels?: Readonly<Record<string, string>>): void {
    this.set(name, "gauge", help, value, labels);
  }

  /** Absolute monotonic total (see module doc). */
  counterTotal(name: string, help: string, total: number, labels?: Readonly<Record<string, string>>): void {
    this.set(name, "counter", help, total, labels);
  }

  /** Remove one labeled sample (e.g. a feed that reports null age). */
  clear(name: string, labels?: Readonly<Record<string, string>>): void {
    this.metrics.get(name)?.values.delete(serializeLabels(labels));
  }

  render(): string {
    const out: string[] = [];
    for (const name of [...this.metrics.keys()].sort()) {
      const m = this.metrics.get(name)!;
      if (m.values.size === 0) continue;
      out.push(`# HELP ${name} ${m.help}`);
      out.push(`# TYPE ${name} ${m.type}`);
      for (const [labels, value] of [...m.values.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        out.push(`${name}${labels} ${value}`);
      }
    }
    return out.join("\n") + "\n";
  }
}

/** Process-wide registry: engine writes, API route reads (same process when embedded). */
export const metricsRegistry = new MetricsRegistry();

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
