import { describe, expect, it } from "vitest";
import type { MarketRef, ReferenceTick } from "@b5p/domain";
import {
  evaluateArtifactPromotion, sealArtifactText, type CalibrationArtifact,
} from "@b5p/experiments";
import {
  BookState, MODELS, TickBuffer, computeFeatures, computeSignalQuantities,
  createCalibratedLogisticModel, takerBreakEvenProbability,
} from "../src/index";

/* ------------------------------------------------------------- feature fix */

const T0 = 1_785_000_000_000;

function tick(offsetSec: number, value: number): ReferenceTick {
  return { source: "chainlink", symbol: "btc/usd", value, sourceTsMs: T0 + offsetSec * 1000, receivedTsMs: T0 + offsetSec * 1000 + 40 };
}

function warmBuffer(base: number): TickBuffer {
  const buf = new TickBuffer();
  for (let s = -180; s <= 0; s++) buf.push(tick(s, base + 5 * Math.sin(s * 1.7)));
  return buf;
}

const market: MarketRef = {
  marketId: "m1", eventId: "e1", conditionId: "0xc", slug: "btc-updown-5m-test",
  upTokenId: "up-token", downTokenId: "down-token",
  startEpoch: Math.floor(T0 / 1000) - 210, endEpoch: Math.floor(T0 / 1000) + 90,
};

function features(upBid = "0.55", upAsk = "0.56") {
  const up = new BookState("up-token");
  up.applySnapshot([{ price: upBid, size: "500" }], [{ price: upAsk, size: "400" }], T0 - 200, T0 - 150);
  const down = new BookState("down-token");
  down.applySnapshot([{ price: "0.43", size: "450" }], [{ price: "0.45", size: "350" }], T0 - 200, T0 - 150);
  return computeFeatures({
    nowMs: T0, market, chainlink: warmBuffer(64100), binance: warmBuffer(64104),
    upBook: up, downBook: down, priceToBeat: 64000, warmupSeconds: 120,
    chainlinkMaxAgeMs: 1500, bookMaxAgeMs: 1000,
  });
}

/* --------------------------------------------------------- artifact fixture */

type ArtifactSansChecksum = Omit<CalibrationArtifact, "artifactChecksum">;

function artifactDoc(overrides: Partial<ArtifactSansChecksum> = {}): ArtifactSansChecksum {
  const metrics = { brier: 0.118, logLoss: 0.39, ece: 0.021, n: 5200 };
  return {
    schemaVersion: 1,
    id: "cal-strategy-test",
    modelKey: "calibrated_logistic",
    version: "calibrated_logistic_v1_test",
    kind: "logistic",
    featureNames: ["mid", "spread", "dist_half", "quarter"],
    coefficients: { intercept: 0.0, weights: { mid: 2.0, spread: -0.3, dist_half: 0.8, quarter: 0.01 } },
    standardization: {
      mid: { mean: 0.5, std: 0.2 }, spread: { mean: 0.02, std: 0.01 },
      dist_half: { mean: 0, std: 0.2 }, quarter: { mean: 0.25, std: 0.43 },
    },
    foldPlan: { nFolds: 6, embargoMs: 60_000, purge: true, minTrainSamples: 500 },
    foldsRealized: 6,
    perFoldVsNull: [],
    oofModel: metrics,
    oofMidNull: { brier: 0.121, logLoss: 0.4, ece: 0.03, n: 5200 },
    fits: [
      { method: "isotonic", curve: [{ x: 0.02, y: 0.03 }, { x: 0.5, y: 0.5 }, { x: 0.98, y: 0.97 }], platt: null, metrics },
      { method: "platt", curve: null, platt: { a: -4.2, b: 2.1 }, metrics: { ...metrics, brier: 0.119 } },
    ],
    selectedMethod: "isotonic",
    netEv: {
      perCost: { mean: 0.031, ciLo: 0.012, ciHi: 0.05, n: 4100 },
      frictions: { feeRate: 0.07, spreadIncluded: true, latencyProbPenalty: 0.005, adverseSelectionProbPenalty: 0.088 },
      signalRule: "taker favored side at ask, all OOF decisions",
    },
    dataset: { manifestId: "dm-test", manifestChecksum: "c".repeat(64), rows: 6000 },
    trainedAtMs: T0,
    codeVersion: "test",
    ...overrides,
  };
}

function sealed(overrides: Partial<ArtifactSansChecksum> = {}): string {
  return sealArtifactText(JSON.stringify({ ...artifactDoc(overrides), artifactChecksum: "" }));
}

const promoOpts = { strategyVersion: "book_distance_v1", mode: "live" as const, decidedBy: "test", nowMs: T0 };

/* ------------------------------------------------------------------- tests */

describe("calibratedLogisticModel — artifact-backed approval ladder", () => {
  it("without an artifact: estimates nothing, approved for NOTHING", () => {
    const m = createCalibratedLogisticModel({ useEnv: false });
    expect(m.approvedForPaper).toBe(false);
    expect(m.approvedForLive).toBe(false);
    expect(m.estimate(features())).toBeNull();
    expect(m.version).toContain("NO_ARTIFACT");
  });

  it("with a valid sealed artifact: paper-approved, live still refused without a promotion decision", () => {
    const m = createCalibratedLogisticModel({ artifactText: sealed(), useEnv: false });
    expect(m.state.loadError).toBeNull();
    expect(m.approvedForPaper).toBe(true);
    expect(m.approvedForLive).toBe(false);
    const est = m.estimate(features())!;
    expect(est).not.toBeNull();
    const p = Number(est.probability) / 1e6;
    expect(p).toBeGreaterThan(0.5); // mid 0.555 above threshold -> calibrated p above 0.5
    expect(p).toBeLessThan(1);
    expect(est.approvedForLive).toBe(false);
    expect(est.modelVersion).toBe("calibrated_logistic_v1_test");
  });

  it("HASH-TAMPER: a modified artifact is rejected — no paper approval, no estimates", () => {
    const tampered = sealed().replace('"mid":2', '"mid":9');
    const m = createCalibratedLogisticModel({ artifactText: tampered, useEnv: false });
    expect(m.approvedForPaper).toBe(false);
    expect(m.approvedForLive).toBe(false);
    expect(m.state.loadError).toMatch(/checksum mismatch/);
    expect(m.estimate(features())).toBeNull();
  });

  it("approvedForLive ONLY with a passing promotion decision for this exact artifact", () => {
    const text = sealed();
    const passing = evaluateArtifactPromotion({ artifactText: text, ...promoOpts });
    expect(passing.approved).toBe(true);
    const m = createCalibratedLogisticModel({ artifactText: text, promotion: passing, useEnv: false });
    expect(m.approvedForLive).toBe(true);
    expect(m.estimate(features())!.approvedForLive).toBe(true);
  });

  it("a FAILING promotion decision (the honest kachoio outcome) never yields live approval", () => {
    const text = sealed({
      netEv: {
        perCost: { mean: -0.055, ciLo: -0.062, ciHi: -0.048, n: 4100 },
        frictions: { feeRate: 0.07, spreadIncluded: true, latencyProbPenalty: 0.005, adverseSelectionProbPenalty: 0.088 },
        signalRule: "taker favored side at ask, all OOF decisions",
      },
    });
    const failing = evaluateArtifactPromotion({ artifactText: text, ...promoOpts });
    expect(failing.approved).toBe(false);
    const m = createCalibratedLogisticModel({ artifactText: text, promotion: failing, useEnv: false });
    expect(m.approvedForPaper).toBe(true); // the artifact is real evidence
    expect(m.approvedForLive).toBe(false); // the economics failed
  });

  it("a FORGED persisted decision claiming approved:true does not re-derive and is refused", () => {
    const failingText = sealed({
      netEv: {
        perCost: { mean: -0.055, ciLo: -0.062, ciHi: -0.048, n: 4100 },
        frictions: { feeRate: 0.07, spreadIncluded: true, latencyProbPenalty: 0.005, adverseSelectionProbPenalty: 0.088 },
        signalRule: "taker favored side at ask, all OOF decisions",
      },
    });
    const honest = evaluateArtifactPromotion({ artifactText: failingText, ...promoOpts });
    const forged = { ...honest, approved: true, reasons: [] };
    const m = createCalibratedLogisticModel({ artifactText: failingText, promotion: forged, useEnv: false });
    expect(m.approvedForLive).toBe(false);
    expect(m.state.promotionError).toMatch(/does not re-derive/);
  });

  it("a decision for a DIFFERENT artifact is refused", () => {
    const text = sealed();
    const passing = evaluateArtifactPromotion({ artifactText: text, ...promoOpts });
    const otherText = sealed({ id: "cal-other", version: "calibrated_logistic_v2_test" });
    const m = createCalibratedLogisticModel({ artifactText: otherText, promotion: passing, useEnv: false });
    expect(m.approvedForLive).toBe(false);
    expect(m.state.promotionError).toMatch(/different (artifact id|model version)/);
  });

  it("an artifact naming unmappable features is refused at load, not silently mis-scored", () => {
    const m = createCalibratedLogisticModel({
      artifactText: sealed({
        featureNames: ["mid", "order_flow_toxicity"],
        coefficients: { intercept: 0, weights: { mid: 1, order_flow_toxicity: 2 } },
        standardization: { mid: { mean: 0.5, std: 0.2 }, order_flow_toxicity: { mean: 0, std: 1 } },
      }),
      useEnv: false,
    });
    expect(m.approvedForPaper).toBe(false);
    expect(m.state.loadError).toMatch(/order_flow_toxicity/);
  });

  it("gbm artifacts are research-only: never scored at runtime", () => {
    const m = createCalibratedLogisticModel({
      artifactText: sealed({ kind: "gbm", coefficients: null, standardization: null }),
      useEnv: false,
    });
    expect(m.approvedForPaper).toBe(false);
    expect(m.state.loadError).toMatch(/research-only/);
  });
});

describe("ANTI-PATTERN: an uncalibrated composite score can never reach Kelly sizing or live approval", () => {
  it("every registry model without a promoted artifact reports approvedForLive === false", () => {
    for (const [key, model] of Object.entries(MODELS)) {
      expect(model.approvedForLive, `model ${key} must not be live-approved`).toBe(false);
    }
  });

  it("the composite model is paper-only and its estimates are flagged not-for-live", () => {
    const composite = MODELS.binance_composite!;
    expect(composite.version).toContain("UNCALIBRATED");
    expect(composite.approvedForPaper).toBe(true);
    expect(composite.approvedForLive).toBe(false);
  });

  it("score_strength without model_probability yields NULL expected values — a score cannot fabricate EV", () => {
    const q = computeSignalQuantities({
      side: "UP", style: "taker_fak", entryPrice: 0.93, feeRate: 0.07,
      marketProbability: 0.93, modelProbability: null, conservativeProbability: null,
      scoreStrength: 0.99, // maximally confident composite score
      fillProbability: 1, latencyProbPenalty: 0.005, adverseSelectionProbPenalty: 0.088,
    });
    expect(q.scoreStrength).toBe(0.99);
    expect(q.expectedValueIfFilled).toBeNull();
    expect(q.expectedValuePerSignal).toBeNull();
    expect(q.conservativeProbability).toBeNull(); // nothing for Kelly to size on
  });
});

describe("signal quantities — the eight stay distinct", () => {
  it("taker break-even rises above price by the fee wedge", () => {
    expect(takerBreakEvenProbability(0.5, 0.07)).toBeCloseTo(0.5175, 6);
    expect(takerBreakEvenProbability(1, 0.07)).toBe(1);
  });

  it("computes all eight quantities for a calibrated maker signal", () => {
    const q = computeSignalQuantities({
      side: "UP", style: "maker_post_only", entryPrice: 0.55, feeRate: 0.07,
      marketProbability: 0.555, modelProbability: 0.70, conservativeProbability: 0.62,
      scoreStrength: null, fillProbability: 0.765, // measured trade-through rate
      latencyProbPenalty: 0.005, adverseSelectionProbPenalty: 0.088, // measured -8.8pt
    });
    expect(q.marketProbability).toBe(0.555);
    expect(q.modelProbability).toBe(0.70);
    expect(q.conservativeProbability).toBe(0.62);
    expect(q.effectiveBreakEvenProbability).toBe(0.55); // maker BE = price
    // p adjusted: 0.70 - 0.005 - 0.088 = 0.607 -> EV = 0.607/0.55 - 1
    expect(q.expectedValueIfFilled).toBeCloseTo(0.607 / 0.55 - 1, 9);
    expect(q.expectedValuePerSignal).toBeCloseTo(0.765 * (0.607 / 0.55 - 1), 9);
  });

  it("adverse selection applies to maker fills, fees to taker entries — never conflated", () => {
    const maker = computeSignalQuantities({
      side: "UP", style: "maker_post_only", entryPrice: 0.55, feeRate: 0.07,
      marketProbability: 0.555, modelProbability: 0.6, conservativeProbability: null,
      scoreStrength: null, fillProbability: 0.5, latencyProbPenalty: 0, adverseSelectionProbPenalty: 0.088,
    });
    const taker = computeSignalQuantities({
      side: "UP", style: "taker_fak", entryPrice: 0.56, feeRate: 0.07,
      marketProbability: 0.56, modelProbability: 0.6, conservativeProbability: null,
      scoreStrength: null, fillProbability: 1, latencyProbPenalty: 0, adverseSelectionProbPenalty: 0.088,
    });
    // maker: adverse selection knocks p down, but BE stays at price
    expect(maker.effectiveBreakEvenProbability).toBe(0.55);
    expect(maker.expectedValueIfFilled).toBeCloseTo((0.6 - 0.088) / 0.55 - 1, 9);
    // taker: full p, but BE inflated by the fee wedge
    expect(taker.effectiveBreakEvenProbability).toBeCloseTo(takerBreakEvenProbability(0.56, 0.07), 9);
    expect(taker.expectedValueIfFilled).toBeCloseTo(0.6 / takerBreakEvenProbability(0.56, 0.07) - 1, 9);
  });

  it("no entry price -> no break-even, no EV; unknown fill -> conditional EV only", () => {
    const q = computeSignalQuantities({
      side: "DOWN", style: "maker_post_only", entryPrice: null, feeRate: 0.07,
      marketProbability: 0.4, modelProbability: 0.5, conservativeProbability: 0.45,
      scoreStrength: null, fillProbability: null, latencyProbPenalty: 0, adverseSelectionProbPenalty: 0,
    });
    expect(q.effectiveBreakEvenProbability).toBeNull();
    expect(q.expectedValueIfFilled).toBeNull();
    expect(q.expectedValuePerSignal).toBeNull();
    const q2 = computeSignalQuantities({
      side: "UP", style: "maker_post_only", entryPrice: 0.5, feeRate: 0.07,
      marketProbability: 0.5, modelProbability: 0.6, conservativeProbability: 0.55,
      scoreStrength: null, fillProbability: null, latencyProbPenalty: 0, adverseSelectionProbPenalty: 0,
    });
    expect(q2.expectedValueIfFilled).not.toBeNull();
    expect(q2.expectedValuePerSignal).toBeNull(); // unknown fill probability stays unknown
  });
});
