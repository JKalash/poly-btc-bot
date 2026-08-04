import { ONE, type BookLevel } from "@b5p/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  aggregatePairRisk,
  buildCandidateFrontier,
  composePairQuote,
  evaluatePairRisk,
  pairSizeObjectiveV1,
  quoteDepthStressGrid,
  quoteDirectBuy,
  quoteTickStress,
  selectBestPairCandidate,
  type ComposePairQuoteInput,
  type PairCaptureId,
  type PairPolicySnapshot,
  type PairPortfolioSnapshot,
  type PairQuoteEconomics,
  type PairStressQuoteInput,
  type PairStressResult,
  type QuoteBookReference,
} from "../src/index";

const CAPTURE = "capture-economics" as PairCaptureId;
const REF: QuoteBookReference = {
  tokenId: "token",
  bookVersion: 1n,
  connectionEpoch: "epoch-1",
  sourceEventId: "event-1",
  contentHash: "hash-1",
};

function leg(tokenId: string, price: bigint, ratePpm = 0n, collection = "usdc") {
  const result = quoteDirectBuy({
    levels: [{ price, size: 20n * ONE }],
    requestedShares6: ONE,
    fee: { ratePpm, collection },
    timeInForce: "FOK",
    bookRef: { ...REF, tokenId },
  });
  if (!result.ok) throw new Error(result.detail);
  return result.quote;
}

function compose(overrides: Partial<ComposePairQuoteInput> = {}): PairQuoteEconomics {
  const result = composePairQuote({
    captureId: CAPTURE,
    pairGrossShares6: ONE,
    up: { outcome: "UP", tokenId: "up", quote: leg("up", 450_000n) },
    down: { outcome: "DOWN", tokenId: "down", quote: leg("down", 450_000n) },
    modeledNonrefundableSettlementCost6: 0n,
    settlementCashReserve6: 0n,
    recoveryCashReserve6: 0n,
    operationalRiskHaircut6: 0n,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.description);
  return result.quote;
}

describe("BPAIR-034 pair composition", () => {
  it("uses token-specific cash fees and can turn gross-positive economics negative", () => {
    const up = leg("up", 490_000n, 200_000n);
    const down = leg("down", 490_000n, 300_000n);
    const quote = compose({
      up: { outcome: "UP", tokenId: "up", quote: up },
      down: { outcome: "DOWN", tokenId: "down", quote: down },
    });
    expect(quote.grossWalkEdge6).toBe(20_000n);
    expect(quote.totalFeeCash6).toBe(up.feeCash6 + down.feeCash6);
    expect(quote.netPnl6).toBeLessThan(0n);
  });

  it("values only the smaller share-fee net balance and preserves residual inventory", () => {
    const up = leg("up", 450_000n, 70_000n, "shares");
    const down = leg("down", 450_000n, 30_000n, "shares");
    const quote = compose({
      up: { outcome: "UP", tokenId: "up", quote: up },
      down: { outcome: "DOWN", tokenId: "down", quote: down },
    });
    expect(quote.guaranteedPayout6).toBe(up.receivedNetShares6);
    expect(quote.residualUpShares6).toBe(0n);
    expect(quote.residualDownShares6).toBe(down.receivedNetShares6 - up.receivedNetShares6);
    expect(quote.totalFeeCash6).toBe(0n);
  });

  it("keeps refundable reservations out of P&L and includes them in aggregate reserved cash", () => {
    const quote = compose({
      settlementCashReserve6: 7n,
      recoveryCashReserve6: 11n,
      operationalRiskHaircut6: 13n,
      modeledNonrefundableSettlementCost6: 17n,
    });
    expect(quote.netPnl6).toBe(ONE - 900_000n - 17n - 13n);
    expect(quote.reservedCash6).toBe(900_000n + 7n + 11n);
  });
});

describe("BPAIR-035 frontier and objective", () => {
  it("deduplicates level/cap breakpoints, lot-aligns, and respects smaller depth", () => {
    const upAsks: BookLevel[] = [{ price: 400_000n, size: 1_200_000n }, { price: 500_000n, size: 1_800_000n }];
    const downAsks: BookLevel[] = [{ price: 400_000n, size: 2_000_000n }, { price: 500_000n, size: 2_000_000n }];
    const result = buildCandidateFrontier({
      upAsks,
      downAsks,
      pairShareLot6: 500_000n,
      minimumOrderShares6: 400_001n,
      cashCapQuantity6: 2_600_000n,
      residualCapQuantity6: 2_600_000n,
    });
    expect(result).toEqual({ ok: true, candidates6: [500_000n, 1_000_000n, 2_000_000n, 2_500_000n, 3_000_000n] });
  });

  it("applies every objective tie-break in the documented direction", () => {
    const small = compose();
    const larger = { ...small, pairGrossShares6: 2n * ONE, reservedCash6: small.reservedCash6 + 1n };
    const selected = selectBestPairCandidate([
      { quote: larger, oneTickWorseNetPnl6: 1n },
      { quote: small, oneTickWorseNetPnl6: 1n },
    ]);
    expect(selected?.quote).toBe(small);
    expect(pairSizeObjectiveV1({ quote: small, oneTickWorseNetPnl6: 2n }, { quote: small, oneTickWorseNetPnl6: 1n })).toBe(-1);
  });
});

function stressInput(): PairStressQuoteInput {
  return {
    captureId: CAPTURE,
    pairGrossShares6: ONE,
    up: { tokenId: "up", levels: [{ price: 450_000n, size: 2n * ONE }], tickSize6: 10_000n, fee: { ratePpm: 70_000n, collection: "usdc" }, bookRef: { ...REF, tokenId: "up" } },
    down: { tokenId: "down", levels: [{ price: 450_000n, size: 2n * ONE }], tickSize6: 20_000n, fee: { ratePpm: 30_000n, collection: "usdc" }, bookRef: { ...REF, tokenId: "down" } },
    modeledNonrefundableSettlementCost6: 0n,
    settlementCashReserve6: 0n,
    recoveryCashReserve6: 0n,
    operationalRiskHaircut6: 0n,
  };
}

describe("BPAIR-036 exact stress", () => {
  it("worsens each leg by its own tick, clips at one, and recomputes fees", () => {
    const result = quoteTickStress(stressInput(), 1);
    expect(result.kind).toBe("EXECUTABLE");
    if (result.kind !== "EXECUTABLE") return;
    expect(result.up.worstPrice6).toBe(460_000n);
    expect(result.down.worstPrice6).toBe(470_000n);
    expect(result.totalFeeCash6).toBe(result.up.feeCash6 + result.down.feeCash6);

    const clipped = quoteTickStress({
      ...stressInput(),
      up: { ...stressInput().up, levels: [{ price: 999_999n, size: 2n * ONE }] },
    }, 2);
    expect(clipped.kind === "EXECUTABLE" ? clipped.up.worstPrice6 : null).toBe(ONE);
  });

  it("floors every depth level and reports explicit stressed depth failure", () => {
    const [at75, at50, at25] = quoteDepthStressGrid(stressInput());
    expect(at75?.kind).toBe("EXECUTABLE");
    expect(at50?.kind).toBe("EXECUTABLE");
    expect(at25).toMatchObject({ kind: "REJECTED", depthFractionPpm: 250_000n, code: "INSUFFICIENT_UP_DEPTH" });
  });
});

const POLICY: PairPolicySnapshot = {
  strategyVersion: "complete_set_pair_v0_RESEARCH_ONLY", route: "DIRECT_BUY_BOTH",
  observerEnabled: true, paperSchedulingEnabled: true, liveExecutionAvailable: false,
  dispatchModel: "PARALLEL", activationLatencyMs: 0, interLegDelayMs: 0, activationQuoteTtlMs: 1_000,
  settlementPolicy: "HOLD_TO_RESOLUTION", modeledSettlementDelayMs: 0, modeledSettlementCost6: 0n, settlementCashReserve6: 0n,
  recoveryPolicy: "NO_AUTO_RECOVERY", maximumRecoveryAttempts: 0, recoveryDeadlineMs: 0, recoveryReserve6: 0n,
  maximumBookAgeMs: 1_000, maximumSourceSkewMs: 100, maximumReceiveSkewMs: 100, maximumFutureTimestampMs: 100,
  maximumFeeSnapshotAgeMs: 1_000, maximumConstraintSnapshotAgeMs: 1_000,
  minimumNetPnl6: 0n, minimumNetReturnPpm: 0n, operationalRiskHaircut6: 0n,
  maximumCashFractionPpm: 100_000n, maximumResidualLossFractionPpm: 100_000n,
  maximumAggregateReservedFractionPpm: 100_000n, maximumAggregateResidualLossFractionPpm: 100_000n,
  maximumPairDailyLossFractionPpm: 20_000n, maximumPairSessionDrawdownFractionPpm: 20_000n,
  maximumActivePairGroups: 1, pairShareLot6: ONE, maximumPairShares6: null,
  requireOneTickStressPositive: true, requireTwoTickStressPositive: true,
  depthStressFractionsPpm: [750_000n, 500_000n, 250_000n], entryCutoffSeconds: 30,
  episodeCooloffMs: 1_000, negativeControlSamplePpm: 0n, unknownResultTimeoutMs: 1_000,
  hardRiskConstant: { name: "ABSOLUTE_MAX_RISK_FRACTION", valuePpm: 100_000n, sourceVersion: "v1" },
  configVersion: 1, policyHash: "policy-hash",
};

function portfolio(overrides: Partial<PairPortfolioSnapshot> = {}): PairPortfolioSnapshot {
  return {
    snapshotId: "portfolio", referenceBankroll6: 100n * ONE, pairAccountCashBalance6: 100n * ONE,
    pairCashReserved6: 0n, pairPendingSettlementReserved6: 0n, pairCashAvailable6: 100n * ONE,
    directionalFreeCash6: 100n * ONE, sharedCapAvailable6: 100n * ONE, globalAppMode: "paper",
    directionalLiveArmed: false, activePairGroupCount: 0, aggregatePairWorstCaseLoss6: 0n,
    pairDailyRealizedPnl6: 0n, pairSessionPeakCash6: 100n * ONE,
    activeDirectionalMarketIds: [], openDirectionalMarketIds: [], activePairMarketIds: [],
    reconciledAtMs: 1, healthy: true, hash: "portfolio-hash", ...overrides,
  };
}

function positiveStress(quote: PairQuoteEconomics): PairStressResult {
  return { kind: "EXECUTABLE", ticksWorse: 1, ...quote, netPnl6: 1n };
}

describe("BPAIR-037 pure aggregate risk", () => {
  it("tracks current and monotonic peak loss without crediting residual inventory", () => {
    expect(aggregatePairRisk({ upHeldShares6: 3n * ONE, downHeldShares6: 2n * ONE, netCashDebit6: 2_500_000n, pendingNonrefundableCosts6: 10n, previousPeakWorstCaseLoss6: 600_000n })).toEqual({
      matchedShares6: 2n * ONE, residualShares6: ONE, currentWorstCaseLoss6: 500_010n, peakWorstCaseLoss6: 600_000n,
    });
  });

  it("accepts the exact aggregate cap and rejects one micro above it", () => {
    const quote = { ...compose(), reservedCash6: 10n * ONE, worstSingleLegLoss6: 5n * ONE, upOnlyWorstLoss6: 5n * ONE, downOnlyWorstLoss6: 5n * ONE };
    const one = positiveStress(quote);
    const approved = evaluatePairRisk({ marketId: "m", quoteHash: "q", quote, oneTickWorse: one, twoTicksWorse: { ...one, ticksWorse: 2 }, portfolio: portfolio(), policy: POLICY, nowMs: 1, permitId: "permit", secondsRemaining: 31 });
    expect(approved.kind).toBe("APPROVED");

    const rejected = evaluatePairRisk({ marketId: "m", quoteHash: "q", quote: { ...quote, reservedCash6: 10n * ONE + 1n }, oneTickWorse: one, twoTicksWorse: { ...one, ticksWorse: 2 }, portfolio: portfolio(), policy: POLICY, nowMs: 1, permitId: "permit", secondsRemaining: 31 });
    expect(rejected.kind === "REJECTED" ? rejected.reasons.map((r) => r.code) : []).toContain("AGGREGATE_CASH_CAP_EXCEEDED");
  });

  it("fails closed on live/armed mode and portfolio conflicts", () => {
    const quote = compose();
    const one = positiveStress(quote);
    const result = evaluatePairRisk({ marketId: "m", quoteHash: "q", quote, oneTickWorse: one, twoTicksWorse: { ...one, ticksWorse: 2 }, portfolio: portfolio({ globalAppMode: "live", directionalLiveArmed: true, activeDirectionalMarketIds: ["m"] }), policy: POLICY, nowMs: 1, permitId: "permit", secondsRemaining: 31 });
    expect(result.kind === "REJECTED" ? result.reasons.map((r) => r.code) : []).toEqual(expect.arrayContaining(["MODE_UNSUPPORTED", "DIRECTIONAL_ORDER_CONFLICT"]));
  });

  it("never approves aggregate cash above the exact configured cap", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: ONE, max: 1_000_000n * ONE }),
      fc.bigInt({ min: 0n, max: 100_000n }),
      (bankroll6, capPpm) => {
        const exactCap6 = bankroll6 * capPpm / 1_000_000n;
        const policy = { ...POLICY, maximumCashFractionPpm: capPpm, maximumAggregateReservedFractionPpm: capPpm };
        const base = compose();
        const quote = { ...base, reservedCash6: exactCap6, worstSingleLegLoss6: 0n, upOnlyWorstLoss6: 0n, downOnlyWorstLoss6: 0n };
        const one = positiveStress(quote);
        const snapshot = portfolio({
          referenceBankroll6: bankroll6,
          pairAccountCashBalance6: bankroll6,
          pairCashAvailable6: bankroll6,
          directionalFreeCash6: bankroll6,
          sharedCapAvailable6: bankroll6,
          pairSessionPeakCash6: bankroll6,
        });
        const exact = evaluatePairRisk({ marketId: "m", quoteHash: "q", quote, oneTickWorse: one, twoTicksWorse: { ...one, ticksWorse: 2 }, portfolio: snapshot, policy, nowMs: 1, permitId: "p", secondsRemaining: 31 });
        expect(exact.kind).toBe("APPROVED");
        const above = evaluatePairRisk({ marketId: "m", quoteHash: "q", quote: { ...quote, reservedCash6: exactCap6 + 1n }, oneTickWorse: one, twoTicksWorse: { ...one, ticksWorse: 2 }, portfolio: snapshot, policy, nowMs: 1, permitId: "p", secondsRemaining: 31 });
        expect(above.kind).toBe("REJECTED");
        if (above.kind === "REJECTED") expect(above.reasons.map((reason) => reason.code)).toContain("AGGREGATE_CASH_CAP_EXCEEDED");
      },
    ), { numRuns: 100 });
  });
});
