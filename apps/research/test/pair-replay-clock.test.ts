import { describe, expect, it } from "vitest";
import {
  PairReplayClock,
  PairReplayClockError,
  deterministicPairReplayId,
  type PairReplayTimer,
} from "../src/pair-replay-clock";

function timer(overrides: Partial<PairReplayTimer> & Pick<PairReplayTimer, "timerId">): PairReplayTimer {
  return {
    timerId: overrides.timerId,
    kind: overrides.kind ?? "RECOVERY",
    scheduledDueMs: overrides.scheduledDueMs ?? 110,
    priority: overrides.priority ?? 2,
    groupId: overrides.groupId ?? "group-a",
    actionSequence: overrides.actionSequence ?? 0,
    payload: overrides.payload ?? {},
  };
}

describe("pair replay virtual clock", () => {
  it("fires earlier timers first and same-millisecond timers only after facts", () => {
    const clock = new PairReplayClock(100);
    clock.schedule(timer({ timerId: "same-late", kind: "RECONCILIATION", scheduledDueMs: 110, priority: 4 }));
    clock.schedule(timer({ timerId: "early", scheduledDueMs: 105 }));
    clock.schedule(timer({ timerId: "same-b", kind: "SERIAL_COMPLEMENT", scheduledDueMs: 110, priority: 1, groupId: "b" }));
    clock.schedule(timer({ timerId: "same-a-2", kind: "SERIAL_COMPLEMENT", scheduledDueMs: 110, priority: 1, groupId: "a", actionSequence: 2 }));
    clock.schedule(timer({ timerId: "same-a-1", kind: "SERIAL_COMPLEMENT", scheduledDueMs: 110, priority: 1, groupId: "a", actionSequence: 1 }));

    expect(clock.advanceBefore(110).map(({ timerId }) => timerId)).toEqual(["early"]);
    expect(clock.nowMs()).toBe(110);
    expect(clock.flushDueAtCurrent().map(({ timerId }) => timerId)).toEqual([
      "same-a-1",
      "same-a-2",
      "same-b",
      "same-late",
    ]);
  });

  it("is idempotent for the same timer and rejects collisions or time travel", () => {
    const clock = new PairReplayClock(10);
    const scheduled = timer({ timerId: "stable", scheduledDueMs: 12 });
    expect(clock.schedule(scheduled)).toBe(clock.schedule({ ...scheduled }));
    expect(() => clock.schedule({ ...scheduled, payload: { changed: true } })).toThrow(PairReplayClockError);
    expect(() => clock.schedule({ ...timer({ timerId: "wrong-priority" }), priority: 0 })).toThrow(PairReplayClockError);
    clock.advanceBefore(12);
    expect(() => clock.advanceBefore(11)).toThrow(PairReplayClockError);
    expect(() => clock.schedule(timer({ timerId: "past", scheduledDueMs: 11 }))).toThrow(PairReplayClockError);
  });

  it("derives stable IDs from namespace, manifest hash, and exact parts", () => {
    const input = { namespace: "trigger" as const, datasetHash: "a".repeat(64), parts: ["market", 7n] };
    expect(deterministicPairReplayId(input)).toBe(deterministicPairReplayId(input));
    expect(deterministicPairReplayId(input)).not.toBe(deterministicPairReplayId({ ...input, parts: ["market", 8n] }));
  });
});
