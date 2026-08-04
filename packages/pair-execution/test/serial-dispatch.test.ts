import { describe, expect, it } from "vitest";
import type { PairCaptureId, PairGroupId, PairObservationId } from "../src/contracts";
import {
  applySerialComplementResult,
  applySerialInitialResult,
  planSerialActivation,
  planSerialComplement,
  type SerialActivationPlan,
  type SerialComplementScheduled,
  type SerialDispatchModel,
  type SerialZeroFillResult,
} from "../src/serial-dispatch";

const groupId = "pgrp_serial" as PairGroupId;
const observationId = "pobs_serial" as PairObservationId;
const activationCaptureId = "pcap_activation" as PairCaptureId;
const complementCaptureId = "pcap_complement" as PairCaptureId;

function activation(model: SerialDispatchModel): SerialActivationPlan {
  return planSerialActivation({
    groupId,
    dispatchModel: model,
    observationId,
    activationDecisionId: "decision-activation",
    activationCaptureId,
    activationQuoteHash: "quote-activation",
    actionSequence: 4,
    targetGrossShares6: 10_000_000n,
  });
}

function scheduled(model: SerialDispatchModel): SerialComplementScheduled {
  const result = applySerialInitialResult(activation(model), {
    kind: "FILLED",
    evidenceKey: "first-fill",
    actualDispatchAtMs: 10_250,
    filledGrossShares6: 10_000_000n,
    receivedNetShares6: 10_000_000n,
    cashDebit6: 4_100_000n,
  }, 375);
  if (result.kind !== "SERIAL_COMPLEMENT_SCHEDULED") throw new Error(`unexpected ${result.kind}`);
  return result;
}

function approvedComplement(state: SerialComplementScheduled) {
  const result = planSerialComplement({
    scheduled: state,
    decisionAtMs: state.complementDueAtMs + 20,
    actionSequence: 5,
    decision: {
      kind: "APPROVED",
      permitId: "permit-complement",
      requestedGrossShares6: 10_000_000n,
      asOf: {
        captureId: complementCaptureId,
        captureCapturedAtMs: state.complementDueAtMs + 10,
        causalCutoffMs: state.complementDueAtMs + 15,
        quoteCaptureId: complementCaptureId,
        quoteHash: "quote-complement",
      },
    },
  });
  if (result.kind !== "SERIAL_COMPLEMENT_READY") throw new Error(`unexpected ${result.kind}`);
  return result;
}

describe("serial activation planning", () => {
  it.each([
    ["UP_THEN_DOWN", "UP", "DOWN"],
    ["DOWN_THEN_UP", "DOWN", "UP"],
  ] as const)("%s commits only the %s first effect and leaves %s unpriced", (model, first, second) => {
    const result = activation(model);
    expect(result.firstOutcome).toBe(first);
    expect(result.complementOutcome).toBe(second);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({
      outcome: first,
      actionKind: "SERIAL_FIRST_FOK",
      captureId: activationCaptureId,
      effectOrdinal: 0,
    });
    expect(result.complement).toEqual({ state: "PLANNED", effectId: null, decisionId: null });
    expect(result.effects.some((effect) => effect.outcome === second)).toBe(false);
  });

  it.each(["NO_FILL", "REJECTED", "CANCELED"] as const)(
    "terminal first-leg %s skips the sibling with no second effect",
    (kind: SerialZeroFillResult) => {
      const result = applySerialInitialResult(activation("UP_THEN_DOWN"), {
        kind,
        evidenceKey: `first-${kind}`,
        actualDispatchAtMs: 10_250,
        filledGrossShares6: 0n,
      }, 375);
      expect(result).toMatchObject({
        kind: "SERIAL_NO_INITIAL_FILL",
        firstOutcome: "UP",
        complementOutcome: "DOWN",
        complementState: "SKIPPED",
        reason: kind,
        effects: [],
      });
    },
  );

  it("blocks the sibling when first-leg evidence is unknown", () => {
    const result = applySerialInitialResult(activation("DOWN_THEN_UP"), {
      kind: "UNKNOWN",
      evidenceKey: "first-unknown",
      actualDispatchAtMs: 10_250,
    }, 375);
    expect(result).toEqual({
      kind: "SERIAL_BLOCKED_UNKNOWN",
      groupId,
      unknownOutcome: "DOWN",
      blockedOutcome: "UP",
      evidenceKey: "first-unknown",
      effects: [],
    });
  });

  it("derives the exact durable complement due time from actual first dispatch", () => {
    const result = scheduled("UP_THEN_DOWN");
    expect(result.firstActualDispatchAtMs).toBe(10_250);
    expect(result.complementDueAtMs).toBe(10_625);
    expect(result.complementOutcome).toBe("DOWN");
  });
});

describe("serial complement decision and result", () => {
  it("uses a new causal capture and quote for its own deterministic decision and effect", () => {
    const state = scheduled("UP_THEN_DOWN");
    const result = approvedComplement(state);
    expect(result.effects).toHaveLength(1);
    expect(result).toMatchObject({
      decisionAtMs: state.complementDueAtMs + 20,
      decisionCaptureId: complementCaptureId,
      decisionQuoteHash: "quote-complement",
      causalCutoffMs: state.complementDueAtMs + 15,
    });
    expect(result.effects[0]).toMatchObject({
      outcome: "DOWN",
      actionKind: "SERIAL_COMPLEMENT_FOK",
      permitId: "permit-complement",
      captureId: complementCaptureId,
      quoteHash: "quote-complement",
      effectOrdinal: 0,
    });
    expect(result.decisionId).not.toBe(state.activation.activationDecisionId);
    expect(result.effects[0].effectId).not.toBe(state.activation.effects[0].effectId);
  });

  it("turns a complement decision rejection into the proven first-leg residual", () => {
    const state = scheduled("DOWN_THEN_UP");
    const result = planSerialComplement({
      scheduled: state,
      decisionAtMs: 10_700,
      actionSequence: 5,
      decision: {
        kind: "REJECTED",
        reasonCodes: ["INSUFFICIENT_UP_DEPTH"],
        asOf: {
          captureId: complementCaptureId,
          captureCapturedAtMs: 10_650,
          causalCutoffMs: 10_680,
          quoteCaptureId: complementCaptureId,
          quoteHash: "quote-complement-rejected",
        },
      },
    });
    expect(result).toMatchObject({
      kind: "SERIAL_RESIDUAL",
      residualOutcome: "DOWN",
      skippedOutcome: "UP",
      decisionCaptureId: complementCaptureId,
      decisionQuoteHash: "quote-complement-rejected",
      reasonCodes: ["INSUFFICIENT_UP_DEPTH"],
      effects: [],
    });
  });

  it("rejects a stale activation capture, future capture, mismatched quote, or upward resize", () => {
    const state = scheduled("UP_THEN_DOWN");
    const base = {
      scheduled: state,
      decisionAtMs: 10_700,
      actionSequence: 5,
      decision: {
        kind: "APPROVED" as const,
        permitId: "permit",
        requestedGrossShares6: 10_000_000n,
        asOf: {
          captureId: complementCaptureId,
          captureCapturedAtMs: 10_650,
          causalCutoffMs: 10_680,
          quoteCaptureId: complementCaptureId,
          quoteHash: "quote-complement",
        },
      },
    };
    expect(() => planSerialComplement({
      ...base,
      decision: { ...base.decision, asOf: { ...base.decision.asOf, captureId: activationCaptureId, quoteCaptureId: activationCaptureId } },
    })).toThrow("requires a new capture identity");
    expect(() => planSerialComplement({
      ...base,
      decision: { ...base.decision, asOf: { ...base.decision.asOf, captureCapturedAtMs: 10_690 } },
    })).toThrow("not causally as-of");
    expect(() => planSerialComplement({
      ...base,
      decision: { ...base.decision, asOf: { ...base.decision.asOf, quoteCaptureId: "pcap_other" as PairCaptureId } },
    })).toThrow("different capture");
    expect(() => planSerialComplement({
      ...base,
      decision: { ...base.decision, requestedGrossShares6: 10_000_001n },
    })).toThrow("cannot resize upward");
  });

  it("classifies complement fill, terminal zero-fill, and unknown without another effect", () => {
    const state = scheduled("UP_THEN_DOWN");
    const plan = approvedComplement(state);
    expect(applySerialComplementResult(state, plan, {
      kind: "FILLED",
      evidenceKey: "complement-fill",
      filledGrossShares6: 10_000_000n,
      receivedNetShares6: 10_000_000n,
      cashDebit6: 5_700_000n,
    })).toMatchObject({ kind: "SERIAL_PAIRED", firstOutcome: "UP", complementOutcome: "DOWN" });
    expect(applySerialComplementResult(state, plan, {
      kind: "NO_FILL",
      evidenceKey: "complement-no-fill",
      filledGrossShares6: 0n,
    })).toMatchObject({ kind: "SERIAL_RESIDUAL", residualOutcome: "UP", failedOutcome: "DOWN" });
    expect(applySerialComplementResult(state, plan, {
      kind: "UNKNOWN",
      evidenceKey: "complement-unknown",
    })).toMatchObject({ kind: "SERIAL_BLOCKED_UNKNOWN", unknownOutcome: "DOWN" });
  });
});

describe("serial symmetry and restart determinism", () => {
  it("keeps UP-first and DOWN-first behavior symmetric under outcome exchange", () => {
    for (const [model, first, second] of [
      ["UP_THEN_DOWN", "UP", "DOWN"],
      ["DOWN_THEN_UP", "DOWN", "UP"],
    ] as const) {
      const firstPlan = activation(model);
      const state = scheduled(model);
      const secondPlan = approvedComplement(state);
      expect(firstPlan.firstOutcome).toBe(first);
      expect(firstPlan.complementOutcome).toBe(second);
      expect(firstPlan.effects.map((effect) => effect.outcome)).toEqual([first]);
      expect(secondPlan.effects.map((effect) => effect.outcome)).toEqual([second]);
      expect(state.complementDueAtMs - state.firstActualDispatchAtMs).toBe(375);
    }
  });

  it("reconstructs byte-for-byte deterministic plans after restart", () => {
    const before = activation("DOWN_THEN_UP");
    const after = activation("DOWN_THEN_UP");
    expect(after).toEqual(before);
    const beforeSchedule = scheduled("DOWN_THEN_UP");
    const afterSchedule = scheduled("DOWN_THEN_UP");
    expect(afterSchedule).toEqual(beforeSchedule);
    const beforeComplement = approvedComplement(beforeSchedule);
    const afterComplement = approvedComplement(afterSchedule);
    expect(afterComplement).toEqual(beforeComplement);
    expect(afterComplement.planHash).toBe(beforeComplement.planHash);
    expect(afterComplement.effects[0].idempotencyKey).toBe(beforeComplement.effects[0].idempotencyKey);
  });
});
