import { describe, expect, it } from "vitest";
import type { PairEventId, PairGroupId, PairLegId } from "../src/contracts";
import { PAIR_EVENT_TYPES, type PairGroupEvent, type PairEventType } from "../src/events";
import { reducePairGroup, reducePairGroupOrThrow, replayPairGroup } from "../src/reducer";
import { PAIR_GROUP_STATES, type PairGroupAggregate } from "../src/states";
import { PAIR_TRANSITION_MATRIX, pairTransitionRule } from "../src/transitions";

const groupId = "group-1" as PairGroupId;
let sequence = 0;

function resetSequence(): void { sequence = 0; }

function e<Type extends PairEventType>(type: Type, payload: Extract<PairGroupEvent, { type: Type }>["payload"], at = 1_000 + sequence): Extract<PairGroupEvent, { type: Type }> {
  sequence += 1;
  return {
    type,
    schemaVersion: 1,
    eventId: `event-${sequence}` as PairEventId,
    groupId,
    causationId: `cause-${sequence}`,
    occurredAtMs: at,
    payload,
  } as Extract<PairGroupEvent, { type: Type }>;
}

function created(dispatchModel: "PARALLEL" | "UP_THEN_DOWN" | "DOWN_THEN_UP" = "PARALLEL"): PairGroupEvent {
  return e("PAIR_GROUP_CREATED", {
    dispatchModel,
    upLegId: "leg-up" as PairLegId,
    downLegId: "leg-down" as PairLegId,
    targetGrossShares6: 10n,
    approvedCashCap6: 20n,
    approvedResidualLoss6: 10n,
  });
}

function apply(aggregate: PairGroupAggregate | null, event: PairGroupEvent): PairGroupAggregate {
  return reducePairGroupOrThrow(aggregate, event);
}

function activate(dispatchModel: "PARALLEL" | "UP_THEN_DOWN" | "DOWN_THEN_UP" = "PARALLEL"): PairGroupAggregate {
  let aggregate = apply(null, created(dispatchModel));
  aggregate = apply(aggregate, e("PAIR_CASH_RESERVED", { reservedCash6: 20n }));
  aggregate = apply(aggregate, e("PAIR_ACTIVATION_STARTED", {}));
  aggregate = apply(aggregate, e("PAIR_ACTIVATION_APPROVED", {}));
  return aggregate;
}

function planAndClaim(aggregate: PairGroupAggregate, outcome: "UP" | "DOWN"): PairGroupAggregate {
  aggregate = apply(aggregate, e("PAIR_LEG_PLANNED", { outcome, requestedGrossShares6: 10n }));
  aggregate = apply(aggregate, e("PAIR_LEG_EFFECT_ENQUEUED", { outcome, effectId: `effect-${outcome}` }));
  return apply(aggregate, e("PAIR_LEG_DISPATCH_CLAIMED", { outcome, effectId: `effect-${outcome}`, actualDispatchAtMs: 2_000 + sequence }));
}

function recordResult(aggregate: PairGroupAggregate, outcome: "UP" | "DOWN", result: "FILLED" | "NO_FILL" | "REJECTED" | "CANCELED"): PairGroupAggregate {
  aggregate = apply(aggregate, e("PAIR_LEG_RESULT_RECORDED", {
    outcome,
    evidenceKey: `result-${outcome}`,
    result,
    filledGrossShares6: result === "FILLED" ? 10n : 0n,
  }));
  if (result === "FILLED") {
    aggregate = apply(aggregate, e("PAIR_FILL_RECORDED", {
      outcome,
      evidenceKey: `fill-${outcome}`,
      grossShares6: 10n,
      netShares6: 10n,
      cashDebit6: 4n,
    }));
  }
  return aggregate;
}

function pairedAggregate(): PairGroupAggregate {
  let aggregate = activate();
  aggregate = planAndClaim(aggregate, "UP");
  aggregate = planAndClaim(aggregate, "DOWN");
  aggregate = recordResult(aggregate, "UP", "FILLED");
  aggregate = recordResult(aggregate, "DOWN", "FILLED");
  return apply(aggregate, e("PAIR_CLASSIFIED_PAIRED", {}));
}

function upResidualAggregate(): PairGroupAggregate {
  let aggregate = activate();
  aggregate = planAndClaim(aggregate, "UP");
  aggregate = planAndClaim(aggregate, "DOWN");
  aggregate = recordResult(aggregate, "UP", "FILLED");
  aggregate = recordResult(aggregate, "DOWN", "REJECTED");
  return apply(aggregate, e("PAIR_CLASSIFIED_RESIDUAL", {}));
}

describe("pair transition matrix", () => {
  it("explicitly classifies every state/event cross-product", () => {
    expect(Object.keys(PAIR_TRANSITION_MATRIX)).toEqual([...PAIR_GROUP_STATES]);
    for (const state of PAIR_GROUP_STATES) {
      expect(Object.keys(PAIR_TRANSITION_MATRIX[state])).toEqual([...PAIR_EVENT_TYPES]);
      for (const type of PAIR_EVENT_TYPES) {
        expect(["LEGAL", "ILLEGAL"]).toContain(pairTransitionRule(state, type).disposition);
        expect(pairTransitionRule(state, type).note.length).toBeGreaterThan(0);
      }
    }
    expect(PAIR_GROUP_STATES.length * PAIR_EVENT_TYPES.length).toBe(19 * 41);
  });

  it("snapshots the documented legal matrix", () => {
    expect(Object.fromEntries(PAIR_GROUP_STATES.map((state) => [
      state,
      PAIR_EVENT_TYPES.filter((type) => pairTransitionRule(state, type).disposition === "LEGAL"),
    ]))).toMatchSnapshot();
  });

  it("makes group creation illegal after every existing group state", () => {
    for (const state of PAIR_GROUP_STATES) expect(pairTransitionRule(state, "PAIR_GROUP_CREATED").disposition).toBe("ILLEGAL");
  });

  it("has the reducer explicitly reject every illegal matrix cell", () => {
    resetSequence();
    const base = apply(null, created());
    let checked = 0;
    for (const state of PAIR_GROUP_STATES) {
      for (const type of PAIR_EVENT_TYPES) {
        if (pairTransitionRule(state, type).disposition !== "ILLEGAL") continue;
        checked += 1;
        const event = {
          type,
          schemaVersion: 1,
          eventId: `matrix-${state}-${type}` as PairEventId,
          groupId,
          causationId: `matrix-cause-${state}-${type}`,
          occurredAtMs: 50_000,
          payload: {},
        } as PairGroupEvent;
        const result = reducePairGroup({ ...base, state }, event);
        expect(result.kind, `${state}/${type}`).toBe("ILLEGAL");
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe("pair reducer", () => {
  it("explicitly rejects events before creation, unknown event kinds, and unsupported versions", () => {
    resetSequence();
    expect(reducePairGroup(null, e("PAIR_HALTED", { reason: "global halt" })).kind).toBe("ILLEGAL");
    const aggregate = apply(null, created());
    const unknown = { ...e("PAIR_SCHEDULED", {}), type: "PAIR_SILENTLY_IGNORE_ME" } as unknown as PairGroupEvent;
    const wrongVersion = { ...e("PAIR_SCHEDULED", {}), schemaVersion: 2 } as unknown as PairGroupEvent;
    const unknownResult = reducePairGroup(aggregate, unknown);
    const versionResult = reducePairGroup(aggregate, wrongVersion);
    expect(unknownResult.kind).toBe("ILLEGAL");
    expect(versionResult.kind).toBe("ILLEGAL");
    if (unknownResult.kind !== "ILLEGAL" || versionResult.kind !== "ILLEGAL") throw new Error("expected explicit boundary rejection");
    expect(unknownResult.reason).toContain("unknown pair event type");
    expect(versionResult.reason).toContain("unsupported pair event schema version");
  });

  it("runs activation rejection through reconciled-flat closure", () => {
    resetSequence();
    let aggregate = apply(null, created());
    aggregate = apply(aggregate, e("PAIR_CASH_RESERVED", { reservedCash6: 12n }));
    aggregate = apply(aggregate, e("PAIR_ACTIVATION_STARTED", {}));
    aggregate = apply(aggregate, e("PAIR_ACTIVATION_REJECTED", { reasonCodes: ["BOOK_STALE"] }));
    aggregate = apply(aggregate, e("PAIR_RECONCILIATION_STARTED", {}));
    aggregate = apply(aggregate, e("PAIR_RESERVATION_RELEASED", { releasedCash6: 12n }));
    aggregate = apply(aggregate, e("PAIR_RECONCILIATION_OK", { terminalState: "RECONCILED_FLAT" }));
    aggregate = apply(aggregate, e("PAIR_GROUP_CLOSED", { terminalState: "RECONCILED_FLAT" }));
    expect(aggregate.state).toBe("RECONCILED_FLAT");
    expect(aggregate.closedAtMs).not.toBeNull();
    expect(aggregate.reconciliationStatus).toBe("HEALTHY");
  });

  it("keeps the first parallel terminal leg SUBMITTING, then pairs and virtually merges", () => {
    resetSequence();
    let aggregate = activate();
    aggregate = planAndClaim(aggregate, "UP");
    aggregate = planAndClaim(aggregate, "DOWN");
    aggregate = recordResult(aggregate, "UP", "FILLED");
    expect(aggregate.state).toBe("SUBMITTING");
    expect(aggregate.upHeldShares6).toBe(10n);
    aggregate = recordResult(aggregate, "DOWN", "FILLED");
    aggregate = apply(aggregate, e("PAIR_CLASSIFIED_PAIRED", {}));
    expect(aggregate.state).toBe("PAIRED");
    aggregate = apply(aggregate, e("PAIR_SETTLEMENT_STARTED", {}));
    aggregate = apply(aggregate, e("PAIR_VIRTUAL_MERGE_ENQUEUED", { effectId: "merge-1" }));
    aggregate = apply(aggregate, e("PAIR_VIRTUAL_MERGE_CONFIRMED", { evidenceKey: "merge-result-1", cashCredit6: 10n }));
    aggregate = apply(aggregate, e("PAIR_RESERVATION_RELEASED", { releasedCash6: 20n }));
    aggregate = apply(aggregate, e("PAIR_RECONCILIATION_OK", { terminalState: "RECONCILED_SETTLED" }));
    expect(aggregate.state).toBe("RECONCILED_SETTLED");
    expect(aggregate.settled).toBe(true);
    expect(aggregate.upHeldShares6).toBe(0n);
    expect(aggregate.downHeldShares6).toBe(0n);
  });

  it("classifies two zero-fill terminal legs only after both are known", () => {
    resetSequence();
    let aggregate = activate();
    aggregate = planAndClaim(aggregate, "UP");
    aggregate = planAndClaim(aggregate, "DOWN");
    aggregate = recordResult(aggregate, "UP", "REJECTED");
    expect(aggregate.state).toBe("SUBMITTING");
    const premature = reducePairGroup(aggregate, e("PAIR_CLASSIFIED_NO_INITIAL_FILL", {}));
    expect(premature.kind).toBe("ILLEGAL");
    aggregate = recordResult(aggregate, "DOWN", "REJECTED");
    aggregate = apply(aggregate, e("PAIR_CLASSIFIED_NO_INITIAL_FILL", {}));
    expect(aggregate.state).toBe("NO_INITIAL_FILL");
  });

  it.each([
    ["UP", "DOWN"],
    ["DOWN", "UP"],
  ] as const)("classifies a %s fill with a %s rejection as the correct residual", (filled, rejected) => {
    resetSequence();
    let aggregate = activate();
    aggregate = planAndClaim(aggregate, "UP");
    aggregate = planAndClaim(aggregate, "DOWN");
    aggregate = recordResult(aggregate, filled, "FILLED");
    aggregate = recordResult(aggregate, rejected, "REJECTED");
    aggregate = apply(aggregate, e("PAIR_CLASSIFIED_RESIDUAL", {}));
    expect(aggregate.state).toBe("RESIDUAL");
    expect(aggregate.residualSide).toBe(filled);
    expect(aggregate.residualShares6).toBe(10n);
    aggregate = apply(aggregate, e("PAIR_RECOVERY_ALTERNATIVES_CAPTURED", { eligibleAttempt: false }));
    aggregate = apply(aggregate, e("PAIR_RECOVERY_SKIPPED", { reason: "default policy" }));
    expect(aggregate.state).toBe("AWAITING_RESOLUTION");
  });

  it("handles an unknown initial result followed by late evidence", () => {
    resetSequence();
    let aggregate = activate();
    aggregate = planAndClaim(aggregate, "UP");
    aggregate = planAndClaim(aggregate, "DOWN");
    aggregate = apply(aggregate, e("PAIR_LEG_OUTCOME_UNKNOWN", { outcome: "UP", evidenceKey: "unknown-up" }));
    expect(aggregate.state).toBe("OUTCOME_UNKNOWN");
    aggregate = apply(aggregate, e("PAIR_RECONCILIATION_STARTED", {}));
    aggregate = recordResult(aggregate, "UP", "FILLED");
    aggregate = recordResult(aggregate, "DOWN", "REJECTED");
    aggregate = apply(aggregate, e("PAIR_CLASSIFIED_RESIDUAL", {}));
    expect(aggregate.state).toBe("RESIDUAL");
  });

  it("completes a missing leg once and returns recovered equal holdings to PAIRED", () => {
    resetSequence();
    let aggregate = upResidualAggregate();
    aggregate = apply(aggregate, e("PAIR_RECOVERY_ALTERNATIVES_CAPTURED", { eligibleAttempt: true }));
    expect(aggregate.state).toBe("RECOVERY_PENDING");
    aggregate = apply(aggregate, e("PAIR_RECOVERY_EFFECT_ENQUEUED", { effectId: "recovery-1" }));
    expect(aggregate.state).toBe("RECOVERING");
    aggregate = apply(aggregate, e("PAIR_RECOVERY_RESULT_RECORDED", {
      evidenceKey: "recovery-result-1",
      upHeldShares6: 10n,
      downHeldShares6: 10n,
      cashDebit6: 4n,
      cashCredit6: 0n,
      currentWorstCaseLoss6: 0n,
    }));
    expect(aggregate.state).toBe("PAIRED");
    expect(aggregate.recoveryAttempts).toBe(1);
    const second = reducePairGroup(aggregate, e("PAIR_RECOVERY_EFFECT_ENQUEUED", { effectId: "recovery-2" }));
    expect(second.kind).toBe("ILLEGAL");
  });

  it("retains smaller residual inventory after a partial recovery liquidation", () => {
    resetSequence();
    let aggregate = upResidualAggregate();
    aggregate = apply(aggregate, e("PAIR_RECOVERY_ALTERNATIVES_CAPTURED", { eligibleAttempt: true }));
    aggregate = apply(aggregate, e("PAIR_RECOVERY_EFFECT_ENQUEUED", { effectId: "recovery-sell" }));
    aggregate = apply(aggregate, e("PAIR_RECOVERY_RESULT_RECORDED", {
      evidenceKey: "recovery-partial",
      upHeldShares6: 4n,
      downHeldShares6: 0n,
      cashDebit6: 0n,
      cashCredit6: 2n,
      currentWorstCaseLoss6: 4n,
    }));
    expect(aggregate.state).toBe("AWAITING_RESOLUTION");
    expect(aggregate.residualSide).toBe("UP");
    expect(aggregate.residualShares6).toBe(4n);
  });

  it("retains recovery uncertainty until terminal evidence arrives", () => {
    resetSequence();
    let aggregate = upResidualAggregate();
    aggregate = apply(aggregate, e("PAIR_RECOVERY_ALTERNATIVES_CAPTURED", { eligibleAttempt: true }));
    aggregate = apply(aggregate, e("PAIR_RECOVERY_EFFECT_ENQUEUED", { effectId: "recovery-unknown" }));
    aggregate = apply(aggregate, e("PAIR_RECOVERY_OUTCOME_UNKNOWN", { evidenceKey: "recovery-timeout" }));
    expect(aggregate.state).toBe("RECOVERY_OUTCOME_UNKNOWN");
    expect(aggregate.reconciliationStatus).toBe("PENDING");
    aggregate = apply(aggregate, e("PAIR_RECOVERY_RESULT_RECORDED", {
      evidenceKey: "recovery-terminal",
      upHeldShares6: 0n,
      downHeldShares6: 0n,
      cashDebit6: 0n,
      cashCredit6: 4n,
      currentWorstCaseLoss6: 0n,
    }));
    expect(aggregate.state).toBe("RECONCILING");
  });

  it("defers a matched pair to resolution under hold policy", () => {
    resetSequence();
    let aggregate = pairedAggregate();
    aggregate = apply(aggregate, e("PAIR_SETTLEMENT_STARTED", {}));
    aggregate = apply(aggregate, e("PAIR_SETTLEMENT_DEFERRED", { reason: "hold policy" }));
    expect(aggregate.state).toBe("AWAITING_RESOLUTION");
    aggregate = apply(aggregate, e("PAIR_RESOLUTION_APPLIED", { resolutionId: "resolution-pair", cashCredit6: 10n }));
    expect(aggregate.state).toBe("RECONCILING");
    expect(aggregate.settled).toBe(true);
    expect(aggregate.cashCredits6).toBe(10n);
  });

  it("retains paired tokens when a virtual merge fails", () => {
    resetSequence();
    let aggregate = pairedAggregate();
    aggregate = apply(aggregate, e("PAIR_SETTLEMENT_STARTED", {}));
    aggregate = apply(aggregate, e("PAIR_VIRTUAL_MERGE_ENQUEUED", { effectId: "merge-fail" }));
    aggregate = apply(aggregate, e("PAIR_VIRTUAL_MERGE_FAILED", { evidenceKey: "merge-failure", reason: "simulated" }));
    expect(aggregate.state).toBe("AWAITING_RESOLUTION");
    expect(aggregate.upHeldShares6).toBe(10n);
    expect(aggregate.downHeldShares6).toBe(10n);
  });

  it.each([0n, 10n])("applies authoritative residual resolution with payout %s", (cashCredit6) => {
    resetSequence();
    let aggregate = upResidualAggregate();
    aggregate = apply(aggregate, e("PAIR_RECOVERY_ALTERNATIVES_CAPTURED", { eligibleAttempt: false }));
    aggregate = apply(aggregate, e("PAIR_RECOVERY_SKIPPED", { reason: "hold" }));
    aggregate = apply(aggregate, e("PAIR_RESOLUTION_APPLIED", { resolutionId: `resolution-${cashCredit6}`, cashCredit6 }));
    expect(aggregate.state).toBe("RECONCILING");
    expect(aggregate.cashCredits6).toBe(cashCredit6);
    expect(aggregate.upHeldShares6).toBe(0n);
  });

  it("rebuilds projection fields and routes an irreparable diff to manual review", () => {
    resetSequence();
    let aggregate = apply(null, created());
    aggregate = apply(aggregate, e("PAIR_ACTIVATION_STARTED", {}));
    aggregate = apply(aggregate, e("PAIR_ACTIVATION_REJECTED", { reasonCodes: ["NO_BOOK"] }));
    aggregate = apply(aggregate, e("PAIR_RECONCILIATION_STARTED", {}));
    aggregate = apply(aggregate, e("PAIR_PROJECTION_REBUILT", {
      upHeldShares6: 0n,
      downHeldShares6: 0n,
      reservedCash6: 0n,
      cashDebits6: 0n,
      cashCredits6: 0n,
      currentWorstCaseLoss6: 0n,
    }));
    expect(aggregate.state).toBe("RECONCILING");
    aggregate = apply(aggregate, e("PAIR_RECONCILIATION_MISMATCH", { diffCodes: ["MISSING_FILL"] }));
    expect(aggregate.state).toBe("MANUAL_REVIEW");
    expect(aggregate.haltReason).toContain("MISSING_FILL");
  });

  it("prevents a serial sibling dispatch after first-leg zero fill", () => {
    resetSequence();
    let aggregate = activate("UP_THEN_DOWN");
    aggregate = planAndClaim(aggregate, "UP");
    aggregate = apply(aggregate, e("PAIR_LEG_PLANNED", { outcome: "DOWN", requestedGrossShares6: 10n }));
    aggregate = recordResult(aggregate, "UP", "NO_FILL");
    aggregate = apply(aggregate, e("PAIR_LEG_SKIPPED", { outcome: "DOWN", reason: "first leg had zero fill" }));
    aggregate = apply(aggregate, e("PAIR_CLASSIFIED_NO_INITIAL_FILL", {}));
    const result = reducePairGroup(aggregate, e("PAIR_LEG_EFFECT_ENQUEUED", { outcome: "DOWN", effectId: "forbidden" }));
    expect(result.kind).toBe("ILLEGAL");
    expect(result.aggregate?.state).toBe("MANUAL_REVIEW");
  });

  it("persists and consumes the exact serial complement due time", () => {
    resetSequence();
    let aggregate = activate("UP_THEN_DOWN");
    aggregate = planAndClaim(aggregate, "UP");
    aggregate = apply(aggregate, e("PAIR_LEG_PLANNED", { outcome: "DOWN", requestedGrossShares6: 10n }));
    aggregate = recordResult(aggregate, "UP", "FILLED");
    aggregate = apply(aggregate, e("PAIR_SERIAL_COMPLEMENT_SCHEDULED", { outcome: "DOWN", dueAtMs: 5_000 }, 3_000));
    expect(aggregate.nextActionAtMs).toBe(5_000);
    const tooSoon = reducePairGroup(aggregate, e("PAIR_SERIAL_COMPLEMENT_DUE", { outcome: "DOWN", dueAtMs: 5_000 }, 4_999));
    expect(tooSoon.kind).toBe("ILLEGAL");
    aggregate = apply(aggregate, e("PAIR_SERIAL_COMPLEMENT_DUE", { outcome: "DOWN", dueAtMs: 5_000 }, 5_000));
    expect(aggregate.nextActionAtMs).toBeNull();
  });

  it("deduplicates exact delivery without changing projection or event count", () => {
    resetSequence();
    const create = created();
    const aggregate = apply(null, create);
    const result = reducePairGroup(aggregate, create);
    expect(result.kind).toBe("DUPLICATE");
    if (result.kind !== "DUPLICATE") throw new Error("expected duplicate");
    expect(result.aggregate).toBe(aggregate);
    expect(result.aggregate.eventCount).toBe(1);
  });

  it("deduplicates the same semantic event under a new delivery envelope", () => {
    resetSequence();
    let aggregate = apply(null, created());
    const reserved = e("PAIR_CASH_RESERVED", { reservedCash6: 10n });
    aggregate = apply(aggregate, reserved);
    const redelivery = {
      ...reserved,
      eventId: "redelivery-id" as PairEventId,
      occurredAtMs: reserved.occurredAtMs + 100,
    };
    const result = reducePairGroup(aggregate, redelivery);
    expect(result.kind).toBe("DUPLICATE");
    if (result.kind !== "DUPLICATE") throw new Error("expected semantic duplicate");
    expect(result.aggregate).toBe(aggregate);
    expect(result.aggregate.eventCount).toBe(2);
    expect(result.duplicateKey).toBe(`causation:${reserved.causationId}`);
  });

  it("rejects an event-id collision and halts the nonterminal group", () => {
    resetSequence();
    const create = created();
    const aggregate = apply(null, create);
    const collision = { ...create, payload: { ...create.payload, targetGrossShares6: 11n } } as PairGroupEvent;
    const result = reducePairGroup(aggregate, collision);
    expect(result.kind).toBe("ILLEGAL");
    if (result.kind !== "ILLEGAL") throw new Error("expected illegal collision");
    expect(result.aggregate?.state).toBe("MANUAL_REVIEW");
    expect(result.reason).toContain("event id collision");
  });

  it("records partial-FOK external evidence, then halts for manual review", () => {
    resetSequence();
    let aggregate = activate();
    aggregate = planAndClaim(aggregate, "UP");
    const result = reducePairGroup(aggregate, e("PAIR_LEG_RESULT_RECORDED", {
      outcome: "UP",
      evidenceKey: "bad-partial",
      result: "FILLED",
      filledGrossShares6: 5n,
    }));
    expect(result.kind).toBe("APPLIED");
    if (result.kind !== "APPLIED") throw new Error("expected partial evidence to be applied");
    expect(result.aggregate.state).toBe("MANUAL_REVIEW");
    expect(result.aggregate.upLeg.filledGrossShares6).toBe(5n);
    expect(result.aggregate.invariantBreachCodes).toContain("INITIAL_FOK_NOT_ALL_OR_ZERO");
  });

  it("records cap-breaking external evidence and halts instead of discarding it", () => {
    resetSequence();
    let aggregate = activate();
    aggregate = planAndClaim(aggregate, "UP");
    aggregate = apply(aggregate, e("PAIR_LEG_RESULT_RECORDED", { outcome: "UP", evidenceKey: "up-result", result: "FILLED", filledGrossShares6: 10n }));
    const result = reducePairGroup(aggregate, e("PAIR_FILL_RECORDED", {
      outcome: "UP",
      evidenceKey: "up-fill",
      grossShares6: 10n,
      netShares6: 10n,
      cashDebit6: 21n,
      safetyBreach: true,
    }));
    expect(result.kind).toBe("APPLIED");
    if (result.kind !== "APPLIED") throw new Error("expected safety evidence to be applied");
    expect(result.aggregate.cashDebits6).toBe(21n);
    expect(result.aggregate.state).toBe("MANUAL_REVIEW");
    expect(result.aggregate.haltedAtMs).not.toBeNull();
    expect(result.aggregate.invariantBreachCodes).toContain("CASH_CAP_EXCEEDED");
  });

  it("makes halt idempotent while retaining the first audit reason/timestamp", () => {
    resetSequence();
    const aggregate = apply(null, created());
    const first = e("PAIR_HALTED", { reason: "operator" }, 9_000);
    const halted = apply(aggregate, first);
    const again = reducePairGroup(halted, e("PAIR_HALTED", { reason: "different" }, 10_000));
    expect(again.kind).toBe("DUPLICATE");
    if (again.kind !== "DUPLICATE") throw new Error("expected duplicate halt");
    expect(again.aggregate.haltedAtMs).toBe(9_000);
    expect(again.aggregate.haltReason).toBe("operator");
  });

  it("replays a stream deterministically", () => {
    resetSequence();
    const events = [created(), e("PAIR_CASH_RESERVED", { reservedCash6: 10n }), e("PAIR_SCHEDULED", {})];
    expect(replayPairGroup(events)).toEqual(replayPairGroup(events));
  });
});
