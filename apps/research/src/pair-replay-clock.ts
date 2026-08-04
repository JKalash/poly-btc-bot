import { pairDatasetObjectHash } from "./pair-dataset-manifest";

export const PAIR_REPLAY_TIMER_PRIORITIES = {
  INITIAL_ACTIVATION: 0,
  SERIAL_COMPLEMENT: 1,
  RECOVERY: 2,
  VIRTUAL_SETTLEMENT: 3,
  RECONCILIATION: 4,
} as const;

export type PairReplayTimerKind = keyof typeof PAIR_REPLAY_TIMER_PRIORITIES;

export interface PairReplayTimer {
  readonly timerId: string;
  readonly kind: PairReplayTimerKind;
  readonly scheduledDueMs: number;
  readonly priority: number;
  readonly groupId: string;
  readonly actionSequence: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export class PairReplayClockError extends Error {}

function safeTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new PairReplayClockError(`${label} must be a non-negative safe integer`);
}

function timerCompare(a: PairReplayTimer, b: PairReplayTimer): number {
  return a.scheduledDueMs - b.scheduledDueMs
    || a.priority - b.priority
    || a.groupId.localeCompare(b.groupId)
    || a.actionSequence - b.actionSequence
    || a.timerId.localeCompare(b.timerId);
}

export function deterministicPairReplayId(input: {
  readonly namespace: "timer" | "trigger" | "capture" | "event";
  readonly datasetHash: string;
  readonly parts: readonly (string | number | bigint | null)[];
}): string {
  return `pair-replay-${input.namespace}-${pairDatasetObjectHash(input).slice(0, 32)}`;
}

/** Monotonic virtual clock implementing the timer portion of pair_replay_tie_v1. */
export class PairReplayClock {
  private currentMs: number;
  private readonly timers = new Map<string, PairReplayTimer>();

  constructor(startMs: number) {
    safeTime(startMs, "startMs");
    this.currentMs = startMs;
  }

  nowMs(): number { return this.currentMs; }

  schedule(input: Omit<PairReplayTimer, "priority"> & { readonly priority?: number }): PairReplayTimer {
    safeTime(input.scheduledDueMs, "scheduledDueMs");
    if (input.scheduledDueMs < this.currentMs) throw new PairReplayClockError("timer cannot be scheduled in the virtual past");
    if (!Number.isSafeInteger(input.actionSequence) || input.actionSequence < 0) throw new PairReplayClockError("actionSequence must be non-negative");
    if (input.timerId.length === 0 || input.groupId.length === 0) throw new PairReplayClockError("timerId and groupId must be non-empty");
    const canonicalPriority = PAIR_REPLAY_TIMER_PRIORITIES[input.kind];
    if (canonicalPriority === undefined) throw new PairReplayClockError(`unsupported timer kind: ${input.kind}`);
    const priority = input.priority ?? canonicalPriority;
    if (!Number.isSafeInteger(priority) || priority < 0) throw new PairReplayClockError("timer priority must be non-negative");
    if (priority !== canonicalPriority) throw new PairReplayClockError(`timer priority does not match kind: ${input.kind}`);
    const timer = Object.freeze({ ...input, priority });
    const prior = this.timers.get(timer.timerId);
    if (prior !== undefined) {
      if (pairDatasetObjectHash(prior) !== pairDatasetObjectHash(timer)) throw new PairReplayClockError(`timer id collision: ${timer.timerId}`);
      return prior;
    }
    this.timers.set(timer.timerId, timer);
    return timer;
  }

  /** Advance to an event time, firing only timers strictly before it. */
  advanceBefore(eventTimeMs: number): readonly PairReplayTimer[] {
    safeTime(eventTimeMs, "eventTimeMs");
    if (eventTimeMs < this.currentMs) throw new PairReplayClockError("virtual clock cannot move backwards");
    const fired = this.takeDue((timer) => timer.scheduledDueMs < eventTimeMs);
    this.currentMs = eventTimeMs;
    return fired;
  }

  /** Fire same-millisecond timers after all causal facts/envelopes at now. */
  flushDueAtCurrent(): readonly PairReplayTimer[] {
    return this.takeDue((timer) => timer.scheduledDueMs <= this.currentMs);
  }

  /** Finish the run in deterministic due order. */
  drain(): readonly PairReplayTimer[] {
    const all = [...this.timers.values()].sort(timerCompare);
    this.timers.clear();
    if (all.length > 0) this.currentMs = Math.max(this.currentMs, all[all.length - 1]!.scheduledDueMs);
    return Object.freeze(all);
  }

  private takeDue(predicate: (timer: PairReplayTimer) => boolean): readonly PairReplayTimer[] {
    const due = [...this.timers.values()].filter(predicate).sort(timerCompare);
    for (const timer of due) this.timers.delete(timer.timerId);
    return Object.freeze(due);
  }
}
