import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PairEventId, PairGroupId, PairLegId } from "../src/contracts";
import type { PairGroupCreatedEvent } from "../src/events";
import { PairInvariantError, assertPairGroupInvariants, validatePairGroupInvariants } from "../src/invariants";
import { reducePairGroupOrThrow } from "../src/reducer";
import { deriveInventory, type PairGroupAggregate } from "../src/states";

function baseAggregate(): PairGroupAggregate {
  const created: PairGroupCreatedEvent = {
    type: "PAIR_GROUP_CREATED",
    schemaVersion: 1,
    eventId: "event-created" as PairEventId,
    groupId: "group" as PairGroupId,
    causationId: "create",
    occurredAtMs: 1,
    payload: {
      dispatchModel: "PARALLEL",
      upLegId: "up" as PairLegId,
      downLegId: "down" as PairLegId,
      targetGrossShares6: 10n,
      approvedCashCap6: 100n,
      approvedResidualLoss6: 100n,
    },
  };
  return reducePairGroupOrThrow(null, created);
}

function codes(aggregate: PairGroupAggregate): readonly string[] {
  return validatePairGroupInvariants(aggregate).map(({ code }) => code);
}

describe("pair aggregate invariants", () => {
  it("accepts the freshly-created canonical projection", () => {
    expect(validatePairGroupInvariants(baseAggregate())).toEqual([]);
    expect(() => assertPairGroupInvariants(baseAggregate())).not.toThrow();
  });

  it("derives matched and residual inventory exactly for randomized non-negative holdings", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 0n, max: 10_000_000_000n }),
      fc.bigInt({ min: 0n, max: 10_000_000_000n }),
      (up, down) => {
        const derived = deriveInventory(up, down);
        expect(derived.matchedShares6).toBe(up < down ? up : down);
        expect(derived.residualShares6).toBe(up > down ? up - down : down - up);
        expect(derived.residualSide).toBe(up > down ? "UP" : down > up ? "DOWN" : null);
      },
    ));
  });

  it("detects randomized matched/residual projection corruption", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 0n, max: 1_000_000n }),
      fc.bigInt({ min: 0n, max: 1_000_000n }),
      fc.bigInt({ min: 1n, max: 1_000n }),
      (up, down, delta) => {
        const derived = deriveInventory(up, down);
        const corrupted: PairGroupAggregate = {
          ...baseAggregate(),
          upHeldShares6: up,
          downHeldShares6: down,
          matchedShares6: derived.matchedShares6 + delta,
          residualSide: derived.residualSide,
          residualShares6: derived.residualShares6,
        };
        expect(codes(corrupted)).toContain("MATCHED_PROJECTION_MISMATCH");
      },
    ));
  });

  it("detects quantity, cap, lifecycle, and terminal corruption", () => {
    const base = baseAggregate();
    const cases: readonly [PairGroupAggregate, string][] = [
      [{ ...base, reservedCash6: -1n }, "RESERVATION_NEGATIVE"],
      [{ ...base, reservedCash6: 101n }, "RESERVATION_CAP_EXCEEDED"],
      [{ ...base, cashDebits6: 101n }, "CASH_CAP_EXCEEDED"],
      [{ ...base, currentWorstCaseLoss6: 101n, peakWorstCaseLoss6: 101n }, "WORST_LOSS_CAP_EXCEEDED"],
      [{ ...base, upHeldShares6: -1n }, "INVENTORY_NEGATIVE"],
      [{ ...base, upLeg: { ...base.upLeg, requestedGrossShares6: 10n, filledGrossShares6: 11n } }, "LEG_FILL_EXCEEDS_REQUEST"],
      [{ ...base, upLeg: { ...base.upLeg, state: "FILLED", effectId: "effect", resultEvidenceKey: "result", requestedGrossShares6: 10n, filledGrossShares6: 5n } }, "INITIAL_FOK_NOT_ALL_OR_ZERO"],
      [{ ...base, state: "PAIRED" }, "CLASSIFICATION_BEFORE_LEGS_TERMINAL"],
      [{ ...base, state: "RECONCILED_FLAT", reconciliationStatus: "HEALTHY", upHeldShares6: 1n }, "FLAT_TERMINAL_HAS_EXPOSURE"],
      [{ ...base, state: "RECONCILED_SETTLED", reconciliationStatus: "HEALTHY" }, "SETTLED_TERMINAL_NOT_SETTLED"],
      [{ ...base, closedAtMs: 10 }, "CLOSED_STATE_NOT_TERMINAL"],
      [{ ...base, haltedAtMs: 10, haltReason: null }, "HALT_FIELDS_INCONSISTENT"],
      [{ ...base, stateVersion: 2 }, "PROJECTION_VERSION_MISMATCH"],
      [{ ...base, nextActionAtMs: 10 }, "NEXT_ACTION_LIFECYCLE_INVALID"],
      [{ ...base, closedAtMs: -1 }, "TIMESTAMP_INVALID"],
      [{ ...base, downLeg: { ...base.downLeg, effectId: "same" }, upLeg: { ...base.upLeg, effectId: "same" } }, "LEG_EFFECT_IDS_NOT_DISTINCT"],
    ];
    for (const [aggregate, expectedCode] of cases) expect(codes(aggregate), expectedCode).toContain(expectedCode);
  });

  it("throws one structured error containing every detected breach", () => {
    const aggregate = { ...baseAggregate(), reservedCash6: -1n, upHeldShares6: -1n };
    expect(() => assertPairGroupInvariants(aggregate)).toThrow(PairInvariantError);
    try {
      assertPairGroupInvariants(aggregate);
    } catch (error) {
      expect(error).toBeInstanceOf(PairInvariantError);
      expect((error as PairInvariantError).violations.map(({ code }) => code)).toEqual(expect.arrayContaining(["RESERVATION_NEGATIVE", "INVENTORY_NEGATIVE"]));
    }
  });

  it("requires a recorded safety breach to be halted in manual review", () => {
    const aggregate = { ...baseAggregate(), safetyBreachRecorded: true };
    expect(codes(aggregate)).toContain("SAFETY_BREACH_NOT_HALTED");
  });
});
