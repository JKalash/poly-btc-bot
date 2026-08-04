/** Event-driven, per-market serialized observer scheduler (spec §20.4–20.6). */

export type PairRuntimeTrigger =
  | { readonly kind: "CLOB_ENVELOPE"; readonly id: string }
  | { readonly kind: "FALLBACK_TIMER"; readonly id: string }
  | { readonly kind: "REPLAY_EVENT"; readonly id: string };

export interface PairObserverEvaluation {
  readonly marketId: string;
  readonly trigger: PairRuntimeTrigger;
}

export interface PairObserverRuntimeOptions {
  readonly maximumMarkets: number;
  readonly evaluate: (input: PairObserverEvaluation) => Promise<void>;
  readonly onHealth: (code: "PAIR_RUNTIME_CAPACITY_EXCEEDED" | "PAIR_RUNTIME_EVALUATION_FAILED", detail: Readonly<Record<string, unknown>>) => void;
}

interface MarketWork {
  running: boolean;
  scheduled: boolean;
  pending: PairRuntimeTrigger | null;
  lastProcessedKey: string | null;
  waiters: Array<() => void>;
}

const triggerKey = (trigger: PairRuntimeTrigger): string => `${trigger.kind}:${trigger.id}`;

export class PairObserverRuntime {
  private readonly markets = new Map<string, MarketWork>();

  constructor(private readonly options: PairObserverRuntimeOptions) {
    if (!Number.isSafeInteger(options.maximumMarkets) || options.maximumMarkets <= 0) throw new RangeError("maximumMarkets must be a positive integer");
  }

  registerMarket(marketId: string): boolean {
    if (this.markets.has(marketId)) return true;
    if (this.markets.size >= this.options.maximumMarkets) {
      this.options.onHealth("PAIR_RUNTIME_CAPACITY_EXCEEDED", Object.freeze({ marketId, maximumMarkets: this.options.maximumMarkets }));
      return false;
    }
    this.markets.set(marketId, { running: false, scheduled: false, pending: null, lastProcessedKey: null, waiters: [] });
    return true;
  }

  unregisterMarket(marketId: string): boolean {
    const work = this.markets.get(marketId);
    if (work === undefined || work.running || work.pending !== null) return false;
    this.markets.delete(marketId);
    return true;
  }

  /** Coalesce dirtiness to the newest complete trigger; never evaluate inside an envelope loop. */
  markDirty(marketId: string, trigger: PairRuntimeTrigger): "SCHEDULED" | "COALESCED" | "DUPLICATE" | "UNREGISTERED" {
    const work = this.markets.get(marketId);
    if (work === undefined) return "UNREGISTERED";
    const key = triggerKey(trigger);
    if (work.lastProcessedKey === key || (work.pending !== null && triggerKey(work.pending) === key)) return "DUPLICATE";
    const coalesced = work.running || work.pending !== null;
    work.pending = Object.freeze({ ...trigger });
    if (!work.running && !work.scheduled) {
      work.scheduled = true;
      queueMicrotask(() => { void this.pump(marketId, work); });
    }
    return coalesced ? "COALESCED" : "SCHEDULED";
  }

  async whenIdle(marketId: string): Promise<void> {
    const work = this.markets.get(marketId);
    if (work === undefined || (!work.running && !work.scheduled && work.pending === null)) return;
    await new Promise<void>((resolve) => work.waiters.push(resolve));
  }

  status(): { readonly registeredMarkets: number; readonly busyMarkets: number; readonly pendingMarkets: number } {
    let busyMarkets = 0;
    let pendingMarkets = 0;
    for (const work of this.markets.values()) {
      if (work.running) busyMarkets++;
      if (work.pending !== null) pendingMarkets++;
    }
    return Object.freeze({ registeredMarkets: this.markets.size, busyMarkets, pendingMarkets });
  }

  private async pump(marketId: string, work: MarketWork): Promise<void> {
    work.scheduled = false;
    if (work.running) return;
    work.running = true;
    try {
      while (work.pending !== null) {
        const trigger = work.pending;
        work.pending = null;
        try {
          await this.options.evaluate(Object.freeze({ marketId, trigger }));
          work.lastProcessedKey = triggerKey(trigger);
        } catch (error) {
          this.options.onHealth("PAIR_RUNTIME_EVALUATION_FAILED", Object.freeze({
            marketId, triggerKind: trigger.kind, triggerId: trigger.id,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    } finally {
      work.running = false;
      if (work.pending !== null && !work.scheduled) {
        work.scheduled = true;
        queueMicrotask(() => { void this.pump(marketId, work); });
      } else {
        const waiters = work.waiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }
}
