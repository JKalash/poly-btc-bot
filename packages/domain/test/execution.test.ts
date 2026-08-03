import { describe, expect, it } from "vitest";
import {
  EXECUTION_TIMELINE_STATES, EXECUTION_TIMELINE_TRANSITIONS, IDEMPOTENT_REPLAY_STATES,
  assertValidTransition, classifyTransition, isIdempotentReplay, isTerminalTimelineState,
  isValidTransition,
} from "../src/index";
import type { ExecutionTimelineState } from "../src/index";

describe("execution timeline transitions", () => {
  it("accepts the full maker happy path", () => {
    const path: ExecutionTimelineState[] = [
      "DECISION_SNAPSHOT", "INTENT_CREATED", "RISK_APPROVED", "SIGN_STARTED",
      "SENT", "EXCHANGE_ACK", "RESTING", "PARTIAL_FILL", "FILLED", "BALANCE_RECONCILED",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(isValidTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it("accepts immediate-fill and cancel paths", () => {
    expect(isValidTransition("EXCHANGE_ACK", "FILLED")).toBe(true);
    expect(isValidTransition("RESTING", "CANCEL_REQUESTED")).toBe(true);
    expect(isValidTransition("CANCEL_REQUESTED", "CANCEL_CONFIRMED")).toBe(true);
    // a fill can race the cancel
    expect(isValidTransition("CANCEL_REQUESTED", "FILLED")).toBe(true);
    expect(isValidTransition("CANCEL_REQUESTED", "PARTIAL_FILL")).toBe(true);
    expect(isValidTransition("CANCEL_CONFIRMED", "BALANCE_RECONCILED")).toBe(true);
    // repeated partial fills are a legal advance
    expect(isValidTransition("PARTIAL_FILL", "PARTIAL_FILL")).toBe(true);
  });

  it("treats REJECTED as safe no-fill incl. post-only crossing, reconcilable", () => {
    expect(isValidTransition("SENT", "REJECTED")).toBe(true);          // exchange reject / post-only would cross
    expect(isValidTransition("SIGN_STARTED", "REJECTED")).toBe(true);  // local sign failure, safe
    expect(isValidTransition("INTENT_CREATED", "REJECTED")).toBe(true);
    expect(isValidTransition("REJECTED", "BALANCE_RECONCILED")).toBe(true);
    // rejected orders never fill or rest
    expect(isValidTransition("REJECTED", "FILLED")).toBe(false);
    expect(isValidTransition("REJECTED", "RESTING")).toBe(false);
  });

  it("UNKNOWN_OUTCOME must be followed ONLY by BALANCE_RECONCILED (no retry before reconcile)", () => {
    expect(EXECUTION_TIMELINE_TRANSITIONS.UNKNOWN_OUTCOME).toEqual(["BALANCE_RECONCILED"]);
    for (const to of EXECUTION_TIMELINE_STATES) {
      expect(isValidTransition("UNKNOWN_OUTCOME", to)).toBe(to === "BALANCE_RECONCILED");
    }
    // in particular: no re-sign, no re-send, no fresh intent from the ambiguous state
    expect(isValidTransition("UNKNOWN_OUTCOME", "SIGN_STARTED")).toBe(false);
    expect(isValidTransition("UNKNOWN_OUTCOME", "SENT")).toBe(false);
    expect(isValidTransition("UNKNOWN_OUTCOME", "INTENT_CREATED")).toBe(false);
  });

  it("BALANCE_RECONCILED is terminal; a retry is a NEW attempt, not a transition", () => {
    expect(isTerminalTimelineState("BALANCE_RECONCILED")).toBe(true);
    for (const to of EXECUTION_TIMELINE_STATES) {
      expect(isValidTransition("BALANCE_RECONCILED", to)).toBe(false);
    }
  });

  it("rejects skipping the risky boundary", () => {
    expect(isValidTransition("DECISION_SNAPSHOT", "SENT")).toBe(false);
    expect(isValidTransition("INTENT_CREATED", "SENT")).toBe(false);
    expect(isValidTransition("RISK_APPROVED", "SENT")).toBe(false); // must sign first
    expect(isValidTransition("SENT", "FILLED")).toBe(false);        // must ack first
    expect(isValidTransition("FILLED", "RESTING")).toBe(false);     // no going back
  });

  it("assertValidTransition throws with a descriptive message", () => {
    expect(() => assertValidTransition("FILLED", "SENT")).toThrow(/FILLED -> SENT/);
    expect(() => assertValidTransition("RESTING", "PARTIAL_FILL")).not.toThrow();
  });
});

describe("duplicate-delivery idempotence", () => {
  it("classifies duplicate acks and resting confirmations as DUPLICATE, not INVALID", () => {
    expect(isIdempotentReplay("EXCHANGE_ACK", "EXCHANGE_ACK")).toBe(true);
    expect(isIdempotentReplay("RESTING", "RESTING")).toBe(true);
    expect(classifyTransition("EXCHANGE_ACK", "EXCHANGE_ACK")).toBe("DUPLICATE");
    expect(classifyTransition("RESTING", "RESTING")).toBe("DUPLICATE");
  });

  it("does not treat other self-loops as idempotent replays", () => {
    // PARTIAL_FILL -> PARTIAL_FILL is a legal ADVANCE (a new partial), deduped by event id upstream
    expect(classifyTransition("PARTIAL_FILL", "PARTIAL_FILL")).toBe("ADVANCE");
    expect(IDEMPOTENT_REPLAY_STATES.has("PARTIAL_FILL")).toBe(false);
    // terminal / one-shot states never replay silently
    expect(classifyTransition("FILLED", "FILLED")).toBe("INVALID");
    expect(classifyTransition("SENT", "SENT")).toBe("INVALID");
    expect(classifyTransition("BALANCE_RECONCILED", "BALANCE_RECONCILED")).toBe("INVALID");
  });

  it("classifies legal advances and garbage correctly", () => {
    expect(classifyTransition("SENT", "EXCHANGE_ACK")).toBe("ADVANCE");
    expect(classifyTransition("SENT", "UNKNOWN_OUTCOME")).toBe("ADVANCE");
    expect(classifyTransition("UNKNOWN_OUTCOME", "SENT")).toBe("INVALID");
  });
});

describe("transition table integrity", () => {
  it("covers every state and only references known states", () => {
    const known = new Set<string>(EXECUTION_TIMELINE_STATES);
    for (const s of EXECUTION_TIMELINE_STATES) {
      const targets = EXECUTION_TIMELINE_TRANSITIONS[s];
      expect(targets, `missing table entry for ${s}`).toBeDefined();
      for (const t of targets) expect(known.has(t), `${s} -> ${t} references unknown state`).toBe(true);
    }
  });

  it("every non-terminal state can eventually reach a terminal state", () => {
    const terminal = EXECUTION_TIMELINE_STATES.filter(isTerminalTimelineState);
    expect(terminal).toEqual(["BALANCE_RECONCILED"]);
    // BFS from each state must reach BALANCE_RECONCILED
    for (const start of EXECUTION_TIMELINE_STATES) {
      const seen = new Set<ExecutionTimelineState>([start]);
      const queue: ExecutionTimelineState[] = [start];
      let reaches = start === "BALANCE_RECONCILED";
      while (queue.length > 0 && !reaches) {
        const cur = queue.shift()!;
        for (const next of EXECUTION_TIMELINE_TRANSITIONS[cur]) {
          if (next === "BALANCE_RECONCILED") { reaches = true; break; }
          if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
      }
      expect(reaches, `${start} cannot reach BALANCE_RECONCILED`).toBe(true);
    }
  });
});
