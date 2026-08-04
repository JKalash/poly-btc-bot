import { canonicalJson } from "./serialization";
import { isPairEventType, pairEventDedupeKeys, type PairGroupCreatedEvent, type PairGroupEvent } from "./events";
import { validatePairGroupInvariants } from "./invariants";
import {
  bothInitialLegsTerminal,
  deriveInventory,
  isTerminalPairGroupState,
  pairLeg,
  type PairGroupAggregate,
  type PairLegProjection,
} from "./states";
import { pairTransitionRule } from "./transitions";

export type PairReduceResult =
  | { readonly kind: "APPLIED"; readonly aggregate: PairGroupAggregate }
  | { readonly kind: "DUPLICATE"; readonly aggregate: PairGroupAggregate; readonly duplicateKey: string }
  | { readonly kind: "ILLEGAL"; readonly aggregate: PairGroupAggregate | null; readonly reason: string };

export class IllegalPairTransitionError extends Error {
  constructor(
    readonly event: PairGroupEvent,
    readonly aggregate: PairGroupAggregate | null,
    message: string,
  ) {
    super(message);
    this.name = "IllegalPairTransitionError";
  }
}

function eventFingerprint(event: PairGroupEvent): string {
  return canonicalJson(event);
}

/** Fingerprint economic meaning, not delivery-envelope metadata. */
function dedupeFingerprint(event: PairGroupEvent): string {
  return canonicalJson({
    type: event.type,
    schemaVersion: event.schemaVersion,
    groupId: event.groupId,
    payload: event.payload,
  });
}

function initialLeg(legId: PairLegProjection["legId"], outcome: "UP" | "DOWN"): PairLegProjection {
  return {
    legId,
    outcome,
    state: "PLANNED",
    requestedGrossShares6: 0n,
    filledGrossShares6: 0n,
    receivedNetShares6: 0n,
    cashDebit6: 0n,
    effectId: null,
    resultEvidenceKey: null,
    fillEvidenceKey: null,
    actualDispatchAtMs: null,
  };
}

function createAggregate(event: PairGroupCreatedEvent): PairGroupAggregate {
  return {
    groupId: event.groupId,
    state: "SCHEDULED",
    stateVersion: 1,
    eventCount: 1,
    dispatchModel: event.payload.dispatchModel,
    upLeg: initialLeg(event.payload.upLegId, "UP"),
    downLeg: initialLeg(event.payload.downLegId, "DOWN"),
    targetGrossShares6: event.payload.targetGrossShares6,
    approvedCashCap6: event.payload.approvedCashCap6,
    approvedResidualLoss6: event.payload.approvedResidualLoss6,
    reservedCash6: 0n,
    cashDebits6: 0n,
    cashCredits6: 0n,
    upHeldShares6: 0n,
    downHeldShares6: 0n,
    matchedShares6: 0n,
    residualSide: null,
    residualShares6: 0n,
    currentWorstCaseLoss6: 0n,
    peakWorstCaseLoss6: 0n,
    nextActionAtMs: null,
    recoveryAttempts: 0,
    haltedAtMs: null,
    haltReason: null,
    reconciliationStatus: "NOT_STARTED",
    closedAtMs: null,
    settled: false,
    safetyBreachRecorded: false,
    invariantBreachCodes: [],
    appliedEventIds: Object.freeze({ [event.eventId]: eventFingerprint(event) }),
    appliedDedupeKeys: Object.freeze(Object.fromEntries(pairEventDedupeKeys(event).map((key) => [key, dedupeFingerprint(event)]))),
  };
}

function replaceLeg(aggregate: PairGroupAggregate, leg: PairLegProjection): PairGroupAggregate {
  return leg.outcome === "UP" ? { ...aggregate, upLeg: leg } : { ...aggregate, downLeg: leg };
}

function withInventory(
  aggregate: PairGroupAggregate,
  upHeldShares6: bigint,
  downHeldShares6: bigint,
  currentWorstCaseLoss6 = aggregate.currentWorstCaseLoss6,
): PairGroupAggregate {
  return {
    ...aggregate,
    upHeldShares6,
    downHeldShares6,
    ...deriveInventory(upHeldShares6, downHeldShares6),
    currentWorstCaseLoss6,
    peakWorstCaseLoss6: currentWorstCaseLoss6 > aggregate.peakWorstCaseLoss6
      ? currentWorstCaseLoss6
      : aggregate.peakWorstCaseLoss6,
  };
}

function illegal(aggregate: PairGroupAggregate | null, event: PairGroupEvent, reason: string): PairReduceResult {
  if (aggregate === null || isTerminalPairGroupState(aggregate.state)) return { kind: "ILLEGAL", aggregate, reason };
  return {
    kind: "ILLEGAL",
    reason,
    aggregate: {
      ...aggregate,
      state: "MANUAL_REVIEW",
      stateVersion: aggregate.stateVersion + 1,
      haltedAtMs: aggregate.haltedAtMs ?? event.occurredAtMs,
      haltReason: aggregate.haltReason ?? `ILLEGAL_EVENT_ORDER: ${reason}`,
      reconciliationStatus: "MISMATCH",
    },
  };
}

function requireCondition(
  condition: boolean,
  aggregate: PairGroupAggregate,
  event: PairGroupEvent,
  reason: string,
): PairReduceResult | null {
  return condition ? null : illegal(aggregate, event, reason);
}

function applyEvent(aggregate: PairGroupAggregate, event: Exclude<PairGroupEvent, PairGroupCreatedEvent>): PairReduceResult | PairGroupAggregate {
  switch (event.type) {
    case "PAIR_CASH_RESERVED":
      return { ...aggregate, reservedCash6: event.payload.reservedCash6 };
    case "PAIR_SCHEDULED":
      return aggregate;
    case "PAIR_ACTIVATION_STARTED":
      return aggregate.haltedAtMs === null
        ? { ...aggregate, state: "ACTIVATING" }
        : illegal(aggregate, event, "a halted group cannot begin activation");
    case "PAIR_ACTIVATION_REJECTED":
      return { ...aggregate, state: "ACTIVATION_REJECTED" };
    case "PAIR_ACTIVATION_APPROVED":
      return aggregate.haltedAtMs === null
        ? { ...aggregate, state: "SUBMITTING" }
        : illegal(aggregate, event, "a halted group cannot approve activation");
    case "PAIR_LEG_PLANNED": {
      const leg = pairLeg(aggregate, event.payload.outcome);
      const failed = requireCondition(leg.state === "PLANNED", aggregate, event, `${leg.outcome} leg is already ${leg.state}`);
      if (failed) return failed;
      return replaceLeg(aggregate, { ...leg, requestedGrossShares6: event.payload.requestedGrossShares6 });
    }
    case "PAIR_LEG_EFFECT_ENQUEUED": {
      if (aggregate.haltedAtMs !== null) return illegal(aggregate, event, "a halted group cannot enqueue a leg effect");
      const leg = pairLeg(aggregate, event.payload.outcome);
      const failed = requireCondition(leg.state === "PLANNED" && leg.requestedGrossShares6 > 0n, aggregate, event, `${leg.outcome} leg effect requires a positive planned quantity`);
      if (failed) return failed;
      return replaceLeg(aggregate, { ...leg, state: "EFFECT_PENDING", effectId: event.payload.effectId });
    }
    case "PAIR_LEG_EFFECT_CANCELED_UNCLAIMED":
    case "PAIR_LEG_EFFECT_EXPIRED_UNCLAIMED": {
      const leg = pairLeg(aggregate, event.payload.outcome);
      const failed = requireCondition(leg.state === "EFFECT_PENDING" && leg.effectId === event.payload.effectId, aggregate, event, `${leg.outcome} leg effect is not pending`);
      if (failed) return failed;
      return replaceLeg(aggregate, { ...leg, state: "CANCELED" });
    }
    case "PAIR_LEG_DISPATCH_CLAIMED": {
      if (aggregate.haltedAtMs !== null) return illegal(aggregate, event, "an unclaimed effect cannot be claimed after halt");
      const leg = pairLeg(aggregate, event.payload.outcome);
      const failed = requireCondition(leg.state === "EFFECT_PENDING" && leg.effectId === event.payload.effectId, aggregate, event, `${leg.outcome} leg effect is not claimable`);
      if (failed) return failed;
      return replaceLeg(aggregate, { ...leg, state: "DISPATCH_CLAIMED", actualDispatchAtMs: event.payload.actualDispatchAtMs });
    }
    case "PAIR_LEG_RESULT_RECORDED": {
      const leg = pairLeg(aggregate, event.payload.outcome);
      const failed = requireCondition(
        leg.state === "EFFECT_PENDING" || leg.state === "DISPATCH_CLAIMED" || leg.state === "DISPATCHED" || leg.state === "UNKNOWN",
        aggregate,
        event,
        `${leg.outcome} leg cannot record a result from ${leg.state}`,
      );
      if (failed) return failed;
      const next = replaceLeg(aggregate, {
        ...leg,
        state: event.payload.result,
        resultEvidenceKey: event.payload.evidenceKey,
        filledGrossShares6: event.payload.filledGrossShares6,
      });
      const fokMismatch = event.payload.result === "FILLED"
        ? event.payload.filledGrossShares6 !== leg.requestedGrossShares6 || event.payload.filledGrossShares6 <= 0n
        : event.payload.filledGrossShares6 !== 0n;
      return fokMismatch
        ? {
            ...next,
            state: "MANUAL_REVIEW",
            haltedAtMs: aggregate.haltedAtMs ?? event.occurredAtMs,
            haltReason: aggregate.haltReason ?? "INITIAL_FOK_EVIDENCE_MISMATCH",
            reconciliationStatus: "MISMATCH",
            invariantBreachCodes: [...aggregate.invariantBreachCodes, "INITIAL_FOK_NOT_ALL_OR_ZERO"],
          }
        : next;
    }
    case "PAIR_FILL_RECORDED": {
      const leg = pairLeg(aggregate, event.payload.outcome);
      const failed = requireCondition(leg.state === "FILLED" && leg.fillEvidenceKey === null, aggregate, event, `${leg.outcome} fill has no new terminal FILLED result`);
      if (failed) return failed;
      let next = replaceLeg(aggregate, {
        ...leg,
        fillEvidenceKey: event.payload.evidenceKey,
        filledGrossShares6: event.payload.grossShares6,
        receivedNetShares6: event.payload.netShares6,
        cashDebit6: event.payload.cashDebit6,
      });
      next = withInventory(
        next,
        next.upHeldShares6 + (event.payload.outcome === "UP" ? event.payload.netShares6 : 0n),
        next.downHeldShares6 + (event.payload.outcome === "DOWN" ? event.payload.netShares6 : 0n),
      );
      return {
        ...next,
        cashDebits6: next.cashDebits6 + event.payload.cashDebit6,
        safetyBreachRecorded: next.safetyBreachRecorded || event.payload.safetyBreach === true,
      };
    }
    case "PAIR_LEG_OUTCOME_UNKNOWN": {
      const leg = pairLeg(aggregate, event.payload.outcome);
      const failed = requireCondition(
        leg.state === "EFFECT_PENDING" || leg.state === "DISPATCH_CLAIMED" || leg.state === "DISPATCHED",
        aggregate,
        event,
        `${leg.outcome} leg cannot become unknown from ${leg.state}`,
      );
      if (failed) return failed;
      return replaceLeg({ ...aggregate, state: "OUTCOME_UNKNOWN", reconciliationStatus: "PENDING" }, {
        ...leg,
        state: "UNKNOWN",
        resultEvidenceKey: event.payload.evidenceKey,
      });
    }
    case "PAIR_SERIAL_COMPLEMENT_SCHEDULED": {
      const leg = pairLeg(aggregate, event.payload.outcome);
      const sibling = event.payload.outcome === "UP" ? aggregate.downLeg : aggregate.upLeg;
      const failed = requireCondition(
        aggregate.dispatchModel !== "PARALLEL" && leg.state === "PLANNED" && sibling.state === "FILLED" && sibling.fillEvidenceKey !== null,
        aggregate,
        event,
        "serial complement requires a durable first-leg fill and a planned sibling",
      );
      if (failed) return failed;
      return { ...aggregate, nextActionAtMs: event.payload.dueAtMs };
    }
    case "PAIR_SERIAL_COMPLEMENT_DUE": {
      const failed = requireCondition(
        aggregate.nextActionAtMs === event.payload.dueAtMs && event.occurredAtMs >= event.payload.dueAtMs,
        aggregate,
        event,
        "serial complement due event does not match the durable due time",
      );
      if (failed) return failed;
      return { ...aggregate, nextActionAtMs: null };
    }
    case "PAIR_SERIAL_COMPLEMENT_REJECTED": {
      const leg = pairLeg(aggregate, event.payload.outcome);
      const failed = requireCondition(leg.state === "PLANNED", aggregate, event, "only an unsent planned complement can be rejected");
      if (failed) return failed;
      return replaceLeg({ ...aggregate, state: "RESIDUAL", nextActionAtMs: null }, { ...leg, state: "SKIPPED" });
    }
    case "PAIR_INVENTORY_RECOMPUTED":
      return {
        ...withInventory(aggregate, event.payload.upHeldShares6, event.payload.downHeldShares6, event.payload.currentWorstCaseLoss6),
        safetyBreachRecorded: aggregate.safetyBreachRecorded || event.payload.safetyBreach === true,
      };
    case "PAIR_LEG_SKIPPED": {
      const leg = pairLeg(aggregate, event.payload.outcome);
      const failed = requireCondition(leg.state === "PLANNED", aggregate, event, "only an unsent planned leg can be skipped");
      if (failed) return failed;
      return replaceLeg(aggregate, { ...leg, state: "SKIPPED" });
    }
    case "PAIR_CLASSIFIED_NO_INITIAL_FILL": {
      const failed = requireCondition(bothInitialLegsTerminal(aggregate) && aggregate.upHeldShares6 === 0n && aggregate.downHeldShares6 === 0n, aggregate, event, "no-fill classification requires two terminal legs and zero holdings");
      return failed ?? { ...aggregate, state: "NO_INITIAL_FILL" };
    }
    case "PAIR_CLASSIFIED_PAIRED": {
      const failed = requireCondition(
        (bothInitialLegsTerminal(aggregate) || aggregate.state === "RECOVERING" || aggregate.state === "RECOVERY_OUTCOME_UNKNOWN")
          && aggregate.upHeldShares6 > 0n
          && aggregate.upHeldShares6 === aggregate.downHeldShares6,
        aggregate,
        event,
        "paired classification requires proven equal positive holdings and terminal intended legs",
      );
      return failed ?? { ...aggregate, state: "PAIRED" };
    }
    case "PAIR_CLASSIFIED_RESIDUAL": {
      const failed = requireCondition(
        (bothInitialLegsTerminal(aggregate) || aggregate.state === "RECOVERING" || aggregate.state === "RECOVERY_OUTCOME_UNKNOWN")
          && aggregate.upHeldShares6 !== aggregate.downHeldShares6,
        aggregate,
        event,
        "residual classification requires proven unequal holdings and terminal intended legs",
      );
      return failed ?? { ...aggregate, state: "RESIDUAL" };
    }
    case "PAIR_SETTLEMENT_STARTED":
      return { ...aggregate, state: "AWAITING_SETTLEMENT" };
    case "PAIR_SETTLEMENT_DEFERRED":
      return { ...aggregate, state: "AWAITING_RESOLUTION" };
    case "PAIR_RECOVERY_ALTERNATIVES_CAPTURED":
      return event.payload.eligibleAttempt
        ? { ...aggregate, state: "RECOVERY_PENDING" }
        : aggregate;
    case "PAIR_RECOVERY_SKIPPED":
      return { ...aggregate, state: "AWAITING_RESOLUTION" };
    case "PAIR_RECOVERY_EFFECT_ENQUEUED":
      return aggregate.haltedAtMs === null
        ? { ...aggregate, state: "RECOVERING", recoveryAttempts: aggregate.recoveryAttempts + 1 }
        : illegal(aggregate, event, "a halted group cannot enqueue recovery");
    case "PAIR_RECOVERY_RESULT_RECORDED": {
      let next = withInventory(aggregate, event.payload.upHeldShares6, event.payload.downHeldShares6, event.payload.currentWorstCaseLoss6);
      next = {
        ...next,
        cashDebits6: next.cashDebits6 + event.payload.cashDebit6,
        cashCredits6: next.cashCredits6 + event.payload.cashCredit6,
        safetyBreachRecorded: next.safetyBreachRecorded || event.payload.safetyBreach === true,
      };
      const state = next.upHeldShares6 === 0n && next.downHeldShares6 === 0n
        ? "RECONCILING"
        : next.upHeldShares6 === next.downHeldShares6
          ? "PAIRED"
          : "AWAITING_RESOLUTION";
      return { ...next, state, reconciliationStatus: state === "RECONCILING" ? "PENDING" : next.reconciliationStatus };
    }
    case "PAIR_RECOVERY_OUTCOME_UNKNOWN":
      return { ...aggregate, state: "RECOVERY_OUTCOME_UNKNOWN", reconciliationStatus: "PENDING" };
    case "PAIR_VIRTUAL_MERGE_ENQUEUED":
      return aggregate.haltedAtMs === null
        ? { ...aggregate, state: "MERGE_PENDING" }
        : illegal(aggregate, event, "a halted group cannot enqueue a virtual merge");
    case "PAIR_VIRTUAL_MERGE_CONFIRMED":
      return {
        ...withInventory(aggregate, 0n, 0n),
        state: "RECONCILING",
        cashCredits6: aggregate.cashCredits6 + event.payload.cashCredit6,
        settled: true,
        reconciliationStatus: "PENDING",
      };
    case "PAIR_VIRTUAL_MERGE_FAILED":
      return { ...aggregate, state: "AWAITING_RESOLUTION" };
    case "PAIR_VIRTUAL_MERGE_OUTCOME_UNKNOWN":
      return { ...aggregate, state: "MERGE_OUTCOME_UNKNOWN", reconciliationStatus: "PENDING" };
    case "PAIR_RESOLUTION_APPLIED":
      return {
        ...withInventory(aggregate, 0n, 0n),
        state: "RECONCILING",
        cashCredits6: aggregate.cashCredits6 + event.payload.cashCredit6,
        settled: true,
        reconciliationStatus: "PENDING",
      };
    case "PAIR_RESERVATION_RELEASED": {
      const failed = requireCondition(event.payload.releasedCash6 <= aggregate.reservedCash6, aggregate, event, "reservation release exceeds reserved cash");
      return failed ?? { ...aggregate, reservedCash6: aggregate.reservedCash6 - event.payload.releasedCash6 };
    }
    case "PAIR_RECONCILIATION_STARTED":
      return aggregate.state === "OUTCOME_UNKNOWN" || aggregate.state === "RECOVERY_OUTCOME_UNKNOWN" || aggregate.state === "MERGE_OUTCOME_UNKNOWN"
        ? { ...aggregate, reconciliationStatus: "PENDING" }
        : { ...aggregate, state: "RECONCILING", reconciliationStatus: "PENDING" };
    case "PAIR_PROJECTION_REBUILT":
      return {
        ...withInventory(aggregate, event.payload.upHeldShares6, event.payload.downHeldShares6, event.payload.currentWorstCaseLoss6),
        reservedCash6: event.payload.reservedCash6,
        cashDebits6: event.payload.cashDebits6,
        cashCredits6: event.payload.cashCredits6,
        safetyBreachRecorded: aggregate.safetyBreachRecorded || event.payload.safetyBreach === true,
      };
    case "PAIR_RECONCILIATION_OK": {
      const failed = requireCondition(
        aggregate.upHeldShares6 === 0n
          && aggregate.downHeldShares6 === 0n
          && aggregate.reservedCash6 === 0n
          && (event.payload.terminalState === "RECONCILED_FLAT" || aggregate.settled),
        aggregate,
        event,
        "terminal reconciliation requires zero holdings and reservation",
      );
      return failed ?? {
        ...aggregate,
        state: event.payload.terminalState,
        reconciliationStatus: "HEALTHY",
      };
    }
    case "PAIR_RECONCILIATION_MISMATCH":
      return {
        ...aggregate,
        state: "MANUAL_REVIEW",
        haltedAtMs: aggregate.haltedAtMs ?? event.occurredAtMs,
        haltReason: aggregate.haltReason ?? `RECONCILIATION_MISMATCH: ${event.payload.diffCodes.join(",")}`,
        reconciliationStatus: "MISMATCH",
      };
    case "PAIR_HALTED":
      return {
        ...aggregate,
        state: aggregate.state === "SCHEDULED" || aggregate.state === "ACTIVATION_REJECTED" || aggregate.state === "NO_INITIAL_FILL"
          ? "RECONCILING"
          : aggregate.state,
        haltedAtMs: event.occurredAtMs,
        haltReason: event.payload.reason,
        reconciliationStatus: aggregate.state === "SCHEDULED" || aggregate.state === "ACTIVATION_REJECTED" || aggregate.state === "NO_INITIAL_FILL"
          ? "PENDING"
          : aggregate.reconciliationStatus,
      };
    case "PAIR_GROUP_CLOSED": {
      const failed = requireCondition(aggregate.state === event.payload.terminalState, aggregate, event, "closed terminal state does not match aggregate");
      return failed ?? { ...aggregate, closedAtMs: event.occurredAtMs };
    }
  }
}

const EXTERNAL_EVIDENCE_EVENTS = new Set<PairGroupEvent["type"]>([
  "PAIR_LEG_RESULT_RECORDED",
  "PAIR_FILL_RECORDED",
  "PAIR_INVENTORY_RECOMPUTED",
  "PAIR_RECOVERY_RESULT_RECORDED",
  "PAIR_VIRTUAL_MERGE_CONFIRMED",
  "PAIR_RESOLUTION_APPLIED",
  "PAIR_PROJECTION_REBUILT",
]);

function withInvariantBreach(
  aggregate: PairGroupAggregate,
  event: PairGroupEvent,
  codes: readonly string[],
): PairGroupAggregate {
  return {
    ...aggregate,
    state: "MANUAL_REVIEW",
    haltedAtMs: aggregate.haltedAtMs ?? event.occurredAtMs,
    haltReason: aggregate.haltReason ?? `INVARIANT_BREACH: ${codes.join(",")}`,
    reconciliationStatus: "MISMATCH",
    invariantBreachCodes: [...new Set([...aggregate.invariantBreachCodes, ...codes])],
  };
}

export function reducePairGroup(aggregate: PairGroupAggregate | null, event: PairGroupEvent): PairReduceResult {
  if (!isPairEventType(event.type as string)) return illegal(aggregate, event, `unknown pair event type: ${String(event.type)}`);
  if (event.schemaVersion !== 1) return illegal(aggregate, event, `unsupported pair event schema version: ${String(event.schemaVersion)}`);
  if (aggregate === null) {
    if (event.type !== "PAIR_GROUP_CREATED") return illegal(null, event, `${event.type} cannot precede PAIR_GROUP_CREATED`);
    const created = createAggregate(event);
    const violations = validatePairGroupInvariants(created);
    return violations.length === 0
      ? { kind: "APPLIED", aggregate: created }
      : { kind: "ILLEGAL", aggregate: null, reason: violations.map(({ code }) => code).join(",") };
  }

  if (aggregate.groupId !== event.groupId) return illegal(aggregate, event, "event groupId does not match aggregate groupId");

  const fingerprint = eventFingerprint(event);
  const eventIdFingerprint = aggregate.appliedEventIds[event.eventId];
  if (eventIdFingerprint !== undefined) {
    return eventIdFingerprint === fingerprint
      ? { kind: "DUPLICATE", aggregate, duplicateKey: `event:${event.eventId}` }
      : illegal(aggregate, event, `event id collision for ${event.eventId}`);
  }

  if (event.type === "PAIR_HALTED" && aggregate.haltedAtMs !== null) {
    return { kind: "DUPLICATE", aggregate, duplicateKey: "semantic:PAIR_HALTED" };
  }

  for (const key of pairEventDedupeKeys(event)) {
    const oldFingerprint = aggregate.appliedDedupeKeys[key];
    if (oldFingerprint !== undefined) {
      return oldFingerprint === dedupeFingerprint(event)
        ? { kind: "DUPLICATE", aggregate, duplicateKey: key }
        : illegal(aggregate, event, `idempotency key collision for ${key}`);
    }
  }

  if (event.type === "PAIR_GROUP_CREATED") return illegal(aggregate, event, "PAIR_GROUP_CREATED is legal only as the first event");
  const transition = pairTransitionRule(aggregate.state, event.type);
  if (transition.disposition === "ILLEGAL") return illegal(aggregate, event, transition.note);

  const applied = applyEvent(aggregate, event);
  if ("kind" in applied) return applied;

  const semanticFingerprint = dedupeFingerprint(event);
  const dedupeEntries = pairEventDedupeKeys(event).map((key) => [key, semanticFingerprint] as const);
  let next: PairGroupAggregate = {
    ...applied,
    stateVersion: aggregate.stateVersion + 1,
    eventCount: aggregate.eventCount + 1,
    appliedEventIds: Object.freeze({ ...aggregate.appliedEventIds, [event.eventId]: fingerprint }),
    appliedDedupeKeys: Object.freeze({ ...aggregate.appliedDedupeKeys, ...Object.fromEntries(dedupeEntries) }),
  };
  if (next.safetyBreachRecorded && next.state !== "MANUAL_REVIEW") {
    next = withInvariantBreach(next, event, ["SAFETY_BREACH_RECORDED"]);
  }
  const violations = validatePairGroupInvariants(next);
  if (violations.length > 0) {
    if (!EXTERNAL_EVIDENCE_EVENTS.has(event.type)) {
      return illegal(aggregate, event, violations.map(({ code }) => code).join(","));
    }
    next = withInvariantBreach(next, event, violations.map(({ code }) => code));
  }
  return {
    kind: "APPLIED",
    aggregate: next,
  };
}

export function reducePairGroupOrThrow(aggregate: PairGroupAggregate | null, event: PairGroupEvent): PairGroupAggregate {
  const result = reducePairGroup(aggregate, event);
  if (result.kind === "ILLEGAL") throw new IllegalPairTransitionError(event, result.aggregate, result.reason);
  return result.aggregate;
}

export function replayPairGroup(events: readonly PairGroupEvent[]): PairGroupAggregate {
  let aggregate: PairGroupAggregate | null = null;
  for (const event of events) aggregate = reducePairGroupOrThrow(aggregate, event);
  if (aggregate === null) throw new TypeError("cannot replay an empty pair event stream");
  return aggregate;
}
