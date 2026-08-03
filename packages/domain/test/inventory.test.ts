import { describe, expect, it } from "vitest";
import {
  ACCRUAL_STATES, ACCRUAL_TRANSITIONS, CLOSED_LEG_STATES,
  CTF_OPERATION_STATES, CTF_OPERATION_TRANSITIONS,
  PAIRED_CYCLE_STATES, PAIRED_CYCLE_TRANSITIONS,
  PAIRED_LEG_STATES, PAIRED_LEG_TRANSITIONS,
  assertValidAccrualTransition, assertValidCycleTransition, assertValidLegTransition,
  isConsistentAccrualStatus, isLegOpen, isRealizedAccrual, isRiskFree,
  isTerminalAccrualState, isTerminalCycleState, isValidAccrualTransition,
  isValidCtfTransition, isValidCycleTransition, isValidLegTransition,
  paidAccrualStatus, unrealizedAccrualStatus,
} from "../src/index";
import type { AccrualState, PairedCycleState, PairedLegState } from "../src/index";

// -- helpers ---------------------------------------------------------------

/** All states reachable from `start`, optionally treating `blocked` states as removed. */
function reachable(
  start: PairedCycleState,
  blocked: ReadonlySet<PairedCycleState> = new Set(),
): Set<PairedCycleState> {
  const seen = new Set<PairedCycleState>([start]);
  const queue: PairedCycleState[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of PAIRED_CYCLE_TRANSITIONS[cur]) {
      if (blocked.has(next) || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

const leg = (state: PairedLegState) => ({ state });
const cycle = (state: PairedCycleState) => ({ state });

// -- paired-cycle machine --------------------------------------------------

describe("paired-cycle transitions (R10)", () => {
  it("contains the ten required main-path states verbatim", () => {
    const main: PairedCycleState[] = [
      "PLANNED", "INVENTORY_PREFLIGHT", "SPLIT_PENDING", "INVENTORY_READY",
      "QUOTING_BOTH", "ONE_LEG_FILLED", "HEDGE_OR_CANCEL", "BOTH_LEGS_FILLED",
      "MERGE_OR_SETTLE", "RECONCILED",
    ];
    for (const s of main) expect(PAIRED_CYCLE_STATES).toContain(s);
  });

  it("accepts the full split-sell happy path through a one-leg fill", () => {
    const path: PairedCycleState[] = [
      "PLANNED", "INVENTORY_PREFLIGHT", "SPLIT_PENDING", "INVENTORY_READY",
      "QUOTING_BOTH", "ONE_LEG_FILLED", "HEDGE_OR_CANCEL", "BOTH_LEGS_FILLED",
      "MERGE_OR_SETTLE", "RECONCILED",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(isValidCycleTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it("accepts near-simultaneous both-leg fills and inventory reuse", () => {
    expect(isValidCycleTransition("QUOTING_BOTH", "BOTH_LEGS_FILLED")).toBe(true);
    expect(isValidCycleTransition("ONE_LEG_FILLED", "BOTH_LEGS_FILLED")).toBe(true); // sibling fills naturally
    expect(isValidCycleTransition("INVENTORY_PREFLIGHT", "INVENTORY_READY")).toBe(true); // reuse, no split
    expect(isValidCycleTransition("QUOTING_BOTH", "INVENTORY_READY")).toBe(true); // clean zero-fill abort
    expect(isValidCycleTransition("MERGE_OR_SETTLE", "MERGE_PENDING")).toBe(true);
    expect(isValidCycleTransition("MERGE_PENDING", "RECONCILED")).toBe(true);
  });

  it("ONE_LEG_FILLED cannot jump to RECONCILED or MERGE_OR_SETTLE directly", () => {
    expect(isValidCycleTransition("ONE_LEG_FILLED", "RECONCILED")).toBe(false);
    expect(isValidCycleTransition("ONE_LEG_FILLED", "MERGE_OR_SETTLE")).toBe(false);
    expect(isValidCycleTransition("ONE_LEG_FILLED", "REWARD_PENDING")).toBe(false);
    expect(() => assertValidCycleTransition("ONE_LEG_FILLED", "RECONCILED")).toThrow(/ONE_LEG_FILLED -> RECONCILED/);
  });

  it("EVERY path ONE_LEG_FILLED -> RECONCILED passes HEDGE_OR_CANCEL, BOTH_LEGS_FILLED, or an explicit FAILED_RECONCILIATION", () => {
    // remove the three legal resolutions from the graph: RECONCILED must become unreachable
    const blocked = new Set<PairedCycleState>(["HEDGE_OR_CANCEL", "BOTH_LEGS_FILLED", "FAILED_RECONCILIATION"]);
    expect(reachable("ONE_LEG_FILLED", blocked).has("RECONCILED")).toBe(false);
    // and blocking only the two CLEAN resolutions leaves just the explicit-failure escape
    const cleanBlocked = new Set<PairedCycleState>(["HEDGE_OR_CANCEL", "BOTH_LEGS_FILLED"]);
    const viaFailure = reachable("ONE_LEG_FILLED", cleanBlocked);
    expect(viaFailure.has("RECONCILED")).toBe(true); // only via FAILED_RECONCILIATION (manual repair)
    expect(viaFailure.has("FAILED_RECONCILIATION")).toBe(true);
    expect(viaFailure.has("MERGE_OR_SETTLE")).toBe(false); // no clean wind-down without hedge/completion
  });

  it("HALTED with an open leg cannot silently wind down: only HEDGE_OR_CANCEL or FAILED_RECONCILIATION", () => {
    expect([...PAIRED_CYCLE_TRANSITIONS.HALTED].sort()).toEqual(["FAILED_RECONCILIATION", "HEDGE_OR_CANCEL"]);
  });

  it("RECONCILED is the sole terminal state and every state reaches it", () => {
    expect(PAIRED_CYCLE_STATES.filter(isTerminalCycleState)).toEqual(["RECONCILED"]);
    for (const start of PAIRED_CYCLE_STATES) {
      expect(reachable(start).has("RECONCILED"), `${start} cannot reach RECONCILED`).toBe(true);
    }
  });

  it("transition table covers every state and only references known states", () => {
    const known = new Set<string>(PAIRED_CYCLE_STATES);
    for (const s of PAIRED_CYCLE_STATES) {
      const targets = PAIRED_CYCLE_TRANSITIONS[s];
      expect(targets, `missing table entry for ${s}`).toBeDefined();
      for (const t of targets) expect(known.has(t), `${s} -> ${t} references unknown state`).toBe(true);
    }
  });

  it("FAILED_RECONCILIATION only resolves to RECONCILED (manual repair), never back into trading", () => {
    expect(PAIRED_CYCLE_TRANSITIONS.FAILED_RECONCILIATION).toEqual(["RECONCILED"]);
  });
});

// -- per-leg machine -------------------------------------------------------

describe("paired-leg transitions (side states PARTIAL_LEG + UNHEDGED)", () => {
  it("accepts quote -> partial -> unhedged -> hedged and repeated partials", () => {
    expect(isValidLegTransition("PLANNED", "QUOTED")).toBe(true);
    expect(isValidLegTransition("QUOTED", "PARTIAL_LEG")).toBe(true);
    expect(isValidLegTransition("PARTIAL_LEG", "PARTIAL_LEG")).toBe(true); // subsequent partials
    expect(isValidLegTransition("PARTIAL_LEG", "UNHEDGED")).toBe(true);
    expect(isValidLegTransition("UNHEDGED", "HEDGED")).toBe(true);
    expect(isValidLegTransition("UNHEDGED", "SETTLED")).toBe(true); // deliberate hold to resolution
    expect(isValidLegTransition("HEDGED", "SETTLED")).toBe(true);   // pair carried to resolution
  });

  it("a partially filled leg can never become CANCELED (net fill cannot vanish)", () => {
    expect(isValidLegTransition("PARTIAL_LEG", "CANCELED")).toBe(false);
    expect(PAIRED_LEG_TRANSITIONS.PARTIAL_LEG).not.toContain("CANCELED");
    expect(() => assertValidLegTransition("PARTIAL_LEG", "CANCELED")).toThrow(/PARTIAL_LEG -> CANCELED/);
  });

  it("closed legs never reopen", () => {
    for (const closed of CLOSED_LEG_STATES) {
      for (const to of PAIRED_LEG_STATES) {
        if (closed === "HEDGED" && to === "SETTLED") continue; // only legal closed-to-closed move
        expect(isValidLegTransition(closed, to), `${closed} -> ${to}`).toBe(false);
      }
    }
  });

  it("leg table covers every state and only references known states", () => {
    const known = new Set<string>(PAIRED_LEG_STATES);
    for (const s of PAIRED_LEG_STATES) {
      for (const t of PAIRED_LEG_TRANSITIONS[s]) {
        expect(known.has(t), `${s} -> ${t} references unknown state`).toBe(true);
      }
    }
  });

  it("isLegOpen: open for PLANNED/QUOTED/PARTIAL_LEG/UNHEDGED, closed for HEDGED/CANCELED/SETTLED", () => {
    for (const s of PAIRED_LEG_STATES) {
      expect(isLegOpen(leg(s)), s).toBe(!CLOSED_LEG_STATES.has(s));
    }
  });
});

// -- isRiskFree ------------------------------------------------------------

describe("isRiskFree (split-sell is NEVER risk-free while a leg is open)", () => {
  it("is false in EVERY cycle state whenever ANY leg is open — exhaustive", () => {
    const openLegStates = PAIRED_LEG_STATES.filter((s) => !CLOSED_LEG_STATES.has(s));
    for (const cs of PAIRED_CYCLE_STATES) {
      for (const ls of openLegStates) {
        expect(isRiskFree(cycle(cs), [leg("HEDGED"), leg(ls)]), `${cs} with open leg ${ls}`).toBe(false);
      }
    }
  });

  it("is false before RECONCILED even with every leg closed — exhaustive", () => {
    const closedLegs = [leg("HEDGED"), leg("SETTLED"), leg("CANCELED")];
    for (const cs of PAIRED_CYCLE_STATES) {
      if (cs === "RECONCILED") continue;
      expect(isRiskFree(cycle(cs), closedLegs), cs).toBe(false);
    }
    // in particular the tempting ones:
    expect(isRiskFree(cycle("BOTH_LEGS_FILLED"), closedLegs)).toBe(false); // merge not reconciled yet
    expect(isRiskFree(cycle("MERGE_PENDING"), closedLegs)).toBe(false);    // merge in flight
    expect(isRiskFree(cycle("REWARD_PENDING"), closedLegs)).toBe(false);   // unpaid accrual outstanding
  });

  it("is true ONLY for RECONCILED with all legs closed (or trivially no legs)", () => {
    expect(isRiskFree(cycle("RECONCILED"), [leg("HEDGED"), leg("HEDGED")])).toBe(true);
    expect(isRiskFree(cycle("RECONCILED"), [leg("SETTLED"), leg("SETTLED")])).toBe(true);
    expect(isRiskFree(cycle("RECONCILED"), [leg("CANCELED"), leg("CANCELED")])).toBe(true);
    expect(isRiskFree(cycle("RECONCILED"), [])).toBe(true); // abandoned at PLANNED, nothing ever done
    // exhaustive contrapositive: risk-free implies RECONCILED + zero open legs
    for (const cs of PAIRED_CYCLE_STATES) {
      for (const ls of PAIRED_LEG_STATES) {
        const rf = isRiskFree(cycle(cs), [leg(ls)]);
        if (rf) {
          expect(cs).toBe("RECONCILED");
          expect(isLegOpen(leg(ls))).toBe(false);
        }
      }
    }
  });
});

// -- accrual machine -------------------------------------------------------

describe("accrual state machine (realized ONLY at PAID)", () => {
  it("accepts the happy path EXPECTED -> ACCRUED -> PENDING -> PAID", () => {
    const path: AccrualState[] = ["EXPECTED", "ACCRUED", "PENDING", "PAID"];
    for (let i = 0; i < path.length - 1; i++) {
      expect(isValidAccrualTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it("PAID is terminal and reachable ONLY from PENDING — exhaustive", () => {
    expect(isTerminalAccrualState("PAID")).toBe(true);
    expect(ACCRUAL_STATES.filter(isTerminalAccrualState)).toEqual(["PAID"]);
    for (const from of ACCRUAL_STATES) {
      expect(isValidAccrualTransition(from, "PAID"), `${from} -> PAID`).toBe(from === "PENDING");
    }
    // no estimated amount can jump the queue
    expect(isValidAccrualTransition("EXPECTED", "PAID")).toBe(false);
    expect(isValidAccrualTransition("ACCRUED", "PAID")).toBe(false);
    expect(isValidAccrualTransition("DISPUTED", "PAID")).toBe(false); // dispute must re-enter first
    expect(() => assertValidAccrualTransition("EXPECTED", "PAID")).toThrow(/EXPECTED -> PAID/);
  });

  it("DISPUTED is reachable from every non-terminal state and re-enters via ACCRUED/PENDING", () => {
    expect(isValidAccrualTransition("EXPECTED", "DISPUTED")).toBe(true);
    expect(isValidAccrualTransition("ACCRUED", "DISPUTED")).toBe(true);
    expect(isValidAccrualTransition("PENDING", "DISPUTED")).toBe(true);
    expect(isValidAccrualTransition("PAID", "DISPUTED")).toBe(false); // paid stays paid
    expect([...ACCRUAL_TRANSITIONS.DISPUTED].sort()).toEqual(["ACCRUED", "PENDING"]);
  });

  it("status constructors keep realized structurally tied to PAID", () => {
    const paid = paidAccrualStatus(1_250_000n, 1754200000000);
    expect(paid.state).toBe("PAID");
    expect(paid.realized).toBe(true);
    expect(paid.paidAmount6).toBe(1_250_000n);
    expect(isRealizedAccrual(paid)).toBe(true);

    for (const s of ["EXPECTED", "ACCRUED", "PENDING", "DISPUTED"] as const) {
      const u = unrealizedAccrualStatus(s);
      expect(u.realized).toBe(false);
      expect(u.paidAmount6).toBeNull();
      expect(u.paidAtMs).toBeNull();
      expect(isRealizedAccrual(u)).toBe(false);
    }
    // runtime guard mirrors the type-level exclusion
    expect(() => unrealizedAccrualStatus("PAID" as never)).toThrow(/PAID/);
  });

  it("isConsistentAccrualStatus rejects every flattened-row lie about realization", () => {
    // realized outside PAID
    expect(isConsistentAccrualStatus({ state: "PENDING", realized: true, paidAmount6: null, paidAtMs: null })).toBe(false);
    expect(isConsistentAccrualStatus({ state: "EXPECTED", realized: true, paidAmount6: 5n, paidAtMs: 1 })).toBe(false);
    // PAID without realization or paid fields
    expect(isConsistentAccrualStatus({ state: "PAID", realized: false, paidAmount6: 5n, paidAtMs: 1 })).toBe(false);
    expect(isConsistentAccrualStatus({ state: "PAID", realized: true, paidAmount6: null, paidAtMs: 1 })).toBe(false);
    expect(isConsistentAccrualStatus({ state: "PAID", realized: true, paidAmount6: 5n, paidAtMs: null })).toBe(false);
    // paid fields leaking onto unrealized rows
    expect(isConsistentAccrualStatus({ state: "ACCRUED", realized: false, paidAmount6: 5n, paidAtMs: null })).toBe(false);
    expect(isConsistentAccrualStatus({ state: "DISPUTED", realized: false, paidAmount6: null, paidAtMs: 1 })).toBe(false);
    // the two consistent shapes
    expect(isConsistentAccrualStatus({ state: "PAID", realized: true, paidAmount6: 5n, paidAtMs: 1 })).toBe(true);
    expect(isConsistentAccrualStatus({ state: "PENDING", realized: false, paidAmount6: null, paidAtMs: null })).toBe(true);
  });
});

// -- CTF operations --------------------------------------------------------

describe("CTF operation transitions (gas/latency/partial modeling)", () => {
  it("accepts submit -> confirm, partial -> confirm, and UNKNOWN resolution", () => {
    expect(isValidCtfTransition("PLANNED", "SUBMITTED")).toBe(true);
    expect(isValidCtfTransition("SUBMITTED", "CONFIRMED")).toBe(true);
    expect(isValidCtfTransition("SUBMITTED", "PARTIALLY_CONFIRMED")).toBe(true);
    expect(isValidCtfTransition("PARTIALLY_CONFIRMED", "CONFIRMED")).toBe(true);
    expect(isValidCtfTransition("SUBMITTED", "UNKNOWN")).toBe(true);
    expect(isValidCtfTransition("UNKNOWN", "CONFIRMED")).toBe(true); // via on-chain reconciliation only
  });

  it("cannot confirm without submitting and never resubmits from UNKNOWN", () => {
    expect(isValidCtfTransition("PLANNED", "CONFIRMED")).toBe(false);
    expect(isValidCtfTransition("PLANNED", "UNKNOWN")).toBe(false);
    expect(isValidCtfTransition("UNKNOWN", "SUBMITTED")).toBe(false);
    expect(isValidCtfTransition("CONFIRMED", "SUBMITTED")).toBe(false);
    expect(CTF_OPERATION_TRANSITIONS.CONFIRMED).toEqual([]);
    expect(CTF_OPERATION_TRANSITIONS.FAILED).toEqual([]);
  });

  it("table integrity", () => {
    const known = new Set<string>(CTF_OPERATION_STATES);
    for (const s of CTF_OPERATION_STATES) {
      for (const t of CTF_OPERATION_TRANSITIONS[s]) {
        expect(known.has(t), `${s} -> ${t} references unknown state`).toBe(true);
      }
    }
  });
});
