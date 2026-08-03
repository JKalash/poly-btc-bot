import { describe, expect, it } from "vitest";
import {
  BRIEF_PATH,
  GIST_COMPOSITE_WEIGHTS,
  GIST_MODES,
  GIST_RAW_REVISION_URL,
  GIST_SOURCE_URL,
  GIST_SYNTHETIC_DELTA_CURVE,
  GIST_THRESHOLDS,
  REDDIT_EXIT_PULLBACK_RECOVERY,
  REDDIT_FAVORED_SIDE_BANDS,
  REDDIT_LAG_ARM_AND_WATCH,
  REDDIT_MOMENTUM_CONTINUATION,
  REDDIT_SOURCE_URL,
  REDDIT_SUSTAINED_RUN,
  REDDIT_TREND_SIDE_BANDS,
  REDDIT_YEARLY_REVERSAL_RATES,
  SOURCE_FIXTURES,
  SOURCE_FIXTURE_VERSION,
  listSourceFixtures,
} from "../src/index";

describe("SOURCE_FIXTURES manifest", () => {
  it("carries every contract export, keyed by its own id", () => {
    const contract = [
      REDDIT_FAVORED_SIDE_BANDS,
      REDDIT_TREND_SIDE_BANDS,
      REDDIT_MOMENTUM_CONTINUATION,
      REDDIT_SUSTAINED_RUN,
      REDDIT_LAG_ARM_AND_WATCH,
      REDDIT_EXIT_PULLBACK_RECOVERY,
      REDDIT_YEARLY_REVERSAL_RATES,
      GIST_COMPOSITE_WEIGHTS,
      GIST_THRESHOLDS,
      GIST_SYNTHETIC_DELTA_CURVE,
      GIST_MODES,
    ];
    for (const f of contract) {
      expect(SOURCE_FIXTURES[f.id as keyof typeof SOURCE_FIXTURES]).toBe(f);
    }
    for (const [key, f] of Object.entries(SOURCE_FIXTURES)) {
      expect(key).toBe(f.id);
    }
    expect(Object.keys(SOURCE_FIXTURES)).toHaveLength(contract.length);
  });

  it("labels every fixture SOURCE_CLAIM_UNVERIFIED — claims, never truth", () => {
    for (const f of listSourceFixtures()) {
      expect(f.label).toBe("SOURCE_CLAIM_UNVERIFIED");
    }
  });

  it("every fixture cites the brief with a section heading and a sane line range", () => {
    for (const f of listSourceFixtures()) {
      expect(f.sourceRef.briefPath).toBe(BRIEF_PATH);
      expect(f.sourceRef.briefSection.length).toBeGreaterThan(0);
      expect(f.sourceRef.briefLines.start).toBeGreaterThan(0);
      expect(f.sourceRef.briefLines.end).toBeGreaterThanOrEqual(f.sourceRef.briefLines.start);
      expect(f.claimText.length).toBeGreaterThan(0);
    }
  });

  it("reddit fixtures cite the reddit URL; gist fixtures cite the gist plus pinned revision", () => {
    for (const f of listSourceFixtures()) {
      if (f.sourceRef.sourceKey === "reddit_efficient_markets_2026") {
        expect(f.sourceRef.url).toBe(REDDIT_SOURCE_URL);
        expect(f.sourceRef.revisionUrl).toBeNull();
      } else {
        expect(f.sourceRef.sourceKey).toBe("archetapp_gist");
        expect(f.sourceRef.url).toBe(GIST_SOURCE_URL);
        expect(f.sourceRef.revisionUrl).toBe(GIST_RAW_REVISION_URL);
        expect(f.sourceRef.revisionUrl).toContain("e45340873b7a2e2f2f3e6663cf77f667e61cc0b7");
      }
    }
  });

  it("pins the fixture-set version the config references", () => {
    expect(SOURCE_FIXTURE_VERSION).toBe("2026-07-31-001");
  });
});

describe("REDDIT_FAVORED_SIDE_BANDS — exact transcription (brief lines 274-283)", () => {
  const d = REDDIT_FAVORED_SIDE_BANDS.data;

  it("claims 4,569 decisions over 4,604 resolved windows with the 0.072 fee parameter", () => {
    expect(d.claimedDecisions).toBe(4569);
    expect(d.claimedResolvedWindows).toBe(4604);
    expect(d.sourceTakerFeeParameterAsPrinted).toBe("0.072");
  });

  it("transcribes all six band rows exactly as printed", () => {
    expect(d.rows).toEqual([
      { band: "0.50–0.55", askMinCents: 50, askMaxCents: 55, n: 466, actualWinRatePctTenths: 498, claimedBreakEvenPctTenths: 543, actualMinusBreakEvenPpTenthsAsPrinted: -45 },
      { band: "0.55–0.60", askMinCents: 55, askMaxCents: 60, n: 604, actualWinRatePctTenths: 571, claimedBreakEvenPctTenths: 593, actualMinusBreakEvenPpTenthsAsPrinted: -21 },
      { band: "0.60–0.65", askMinCents: 60, askMaxCents: 65, n: 671, actualWinRatePctTenths: 605, claimedBreakEvenPctTenths: 642, actualMinusBreakEvenPpTenthsAsPrinted: -37 },
      { band: "0.65–0.70", askMinCents: 65, askMaxCents: 70, n: 636, actualWinRatePctTenths: 626, claimedBreakEvenPctTenths: 691, actualMinusBreakEvenPpTenthsAsPrinted: -65 },
      { band: "0.70–0.80", askMinCents: 70, askMaxCents: 80, n: 1107, actualWinRatePctTenths: 747, claimedBreakEvenPctTenths: 763, actualMinusBreakEvenPpTenthsAsPrinted: -16 },
      { band: "0.80–0.95", askMinCents: 80, askMaxCents: 95, n: 958, actualWinRatePctTenths: 847, claimedBreakEvenPctTenths: 883, actualMinusBreakEvenPpTenthsAsPrinted: -36 },
    ]);
  });

  it("every band underperforms its claimed break-even (the source's efficient-market null)", () => {
    for (const r of d.rows) {
      expect(r.actualWinRatePctTenths).toBeLessThan(r.claimedBreakEvenPctTenths);
    }
  });
});

describe("REDDIT_TREND_SIDE_BANDS — exact transcription (brief lines 297-304)", () => {
  const d = REDDIT_TREND_SIDE_BANDS.data;

  it("transcribes the four rows exactly", () => {
    expect(d.rows).toEqual([
      { band: "0.00–0.45", priceMinCents: 0, priceMaxCents: 45, n: 559, winRatePctTenths: 308 },
      { band: "0.45–0.55", priceMinCents: 45, priceMaxCents: 55, n: 175, winRatePctTenths: 429 },
      { band: "0.55–0.70", priceMinCents: 55, priceMaxCents: 70, n: 263, winRatePctTenths: 586 },
      { band: "0.70–1.00", priceMinCents: 70, priceMaxCents: 100, n: 265, winRatePctTenths: 842 },
    ]);
  });

  it("row counts reconcile to the claimed 1,262 decisions (unlike the favored-side table)", () => {
    expect(d.rows.reduce((a, r) => a + r.n, 0)).toBe(1262);
    expect(d.claimedDecisions).toBe(1262);
  });
});

describe("REDDIT_MOMENTUM_CONTINUATION — exact transcription (brief lines 226-239)", () => {
  const d = REDDIT_MOMENTUM_CONTINUATION.data;

  it("is the 346,094-window ETH one-minute-bar study", () => {
    expect(d.windows).toBe(346094);
    expect(d.asset).toBe("ETH");
    expect(d.barIntervalMinutes).toBe(1);
    expect(d.claimedBarsAsPrinted).toBe("1.73 million");
  });

  it("transcribes the three filter rows exactly, flagging the approximate row", () => {
    expect(d.rows).toEqual([
      { filter: "Any", minPriorMovePpm: null, continuationWinRatePctTenths: 490, approx: true },
      { filter: "At least 0.10%", minPriorMovePpm: 1000, continuationWinRatePctTenths: 480, approx: false },
      { filter: "At least 0.40%", minPriorMovePpm: 4000, continuationWinRatePctTenths: 465, approx: false },
    ]);
  });
});

describe("REDDIT_SUSTAINED_RUN — exact transcription (brief lines 251-257)", () => {
  const d = REDDIT_SUSTAINED_RUN.data;

  it("transcribes the five rows exactly", () => {
    expect(d.rows).toEqual([
      { filter: "At least 2 consecutive same-direction five-minute blocks", minRunBlocks: 2, minTotalMovePpm: null, n: 168815, continuationWinRatePctTenths: 484 },
      { filter: "At least 3", minRunBlocks: 3, minTotalMovePpm: null, n: 81364, continuationWinRatePctTenths: 476 },
      { filter: "At least 4", minRunBlocks: 4, minTotalMovePpm: null, n: 38571, continuationWinRatePctTenths: 464 },
      { filter: "At least 5", minRunBlocks: 5, minTotalMovePpm: null, n: 17856, continuationWinRatePctTenths: 461 },
      { filter: "At least 4 and at least 0.8% total move", minRunBlocks: 4, minTotalMovePpm: 8000, n: 5873, continuationWinRatePctTenths: 448 },
    ]);
  });

  it("shows the claimed monotonic decline in continuation", () => {
    const rates = d.rows.map((r) => r.continuationWinRatePctTenths);
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeLessThan(rates[i - 1]!);
  });
});

describe("REDDIT_LAG_ARM_AND_WATCH — exact transcription (brief lines 198-214)", () => {
  const d = REDDIT_LAG_ARM_AND_WATCH.data;

  it("preserves 5,826 entries, 74.8% resolution, 75.3% ask, reported -0.4pp gap", () => {
    expect(d.entries).toBe(5826);
    expect(d.momentumSideResolutionPctTenths).toBe(748);
    expect(d.observedPolymarketAskPctTenths).toBe(753);
    expect(d.reportedGapPpTenths).toBe(-4);
    expect(d.conclusion).toBe("no fillable lag");
  });

  it("preserves the offset-strategy companion claims", () => {
    expect(d.offsetStrategy).toEqual({
      apparentProfitUsdCentsApprox: 45600,
      structuralOffsetPpmApprox: 1200,
      entryThresholdPpm: 1000,
      profitDisappearedAfterOffsetCorrection: true,
    });
  });
});

describe("REDDIT_EXIT_PULLBACK_RECOVERY — exact transcription (brief lines 331-340)", () => {
  const d = REDDIT_EXIT_PULLBACK_RECOVERY.data;

  it("preserves the winner/loser pullback and recovery numbers", () => {
    expect(d.winnersThatFirstFell).toEqual({ shareOfWinnersPctTenths: 580, dipDepthPctTenthsApprox: 100 });
    expect(d.winnerFirstPullbackAvgPpTenthsApprox).toBe(220);
    expect(d.winnerPullbackRecoveryPctTenths).toBe(970);
    expect(d.loserFirstPullbackAvgPpTenthsApprox).toBe(380);
    expect(d.loserPullbackDepthRatioTenthsApprox).toBe(17);
    expect(d.loserPullbackRecoveryPctTenthsApprox).toBe(320);
    expect(d.breakEvenStopAfterPlus5PctMove).toEqual({ triggerMovePctTenths: 50, netNegativeInOneStudy: true });
  });

  it("loser pullbacks are deeper and recover far less often, as claimed", () => {
    expect(d.loserFirstPullbackAvgPpTenthsApprox).toBeGreaterThan(d.winnerFirstPullbackAvgPpTenthsApprox);
    expect(d.loserPullbackRecoveryPctTenthsApprox).toBeLessThan(d.winnerPullbackRecoveryPctTenths);
  });
});

describe("REDDIT_YEARLY_REVERSAL_RATES — exact transcription (brief lines 457-462)", () => {
  const d = REDDIT_YEARLY_REVERSAL_RATES.data;

  it("transcribes all four years exactly — including the weak 2024 stability warning", () => {
    expect(d.rows).toEqual([
      { year: 2023, reversalRatePctTenths: 538 },
      { year: 2024, reversalRatePctTenths: 516 },
      { year: 2025, reversalRatePctTenths: 545 },
      { year: 2026, reversalRatePctTenths: 546 },
    ]);
    // The brief forbids omitting 2024 (line 471); it must stay the minimum row.
    const min = Math.min(...d.rows.map((r) => r.reversalRatePctTenths));
    expect(min).toBe(516);
  });

  it("stays a disabled, non-live hypothesis with unproven maker fills", () => {
    expect(d.hypothesisId).toBe("extended_move_fade_v1");
    expect(d.makerFillsProven).toBe(false);
    expect(d.condition).toBe("after a strong 20-minute run");
  });
});

describe("GIST_COMPOSITE_WEIGHTS — exact weights and thresholds (brief lines 585-630)", () => {
  const d = GIST_COMPOSITE_WEIGHTS.data;

  it("transcribes the window-delta tiers 7/5/3/1 with exact thresholds", () => {
    expect(d.indicators.windowDelta.tiers).toEqual([
      { asPrinted: "Greater than 0.10%", minAbsMovePpm: 1000, weight: 7 },
      { asPrinted: "Greater than 0.02%", minAbsMovePpm: 200, weight: 5 },
      { asPrinted: "Greater than 0.005%", minAbsMovePpm: 50, weight: 3 },
      { asPrinted: "Greater than 0.001%", minAbsMovePpm: 10, weight: 1 },
    ]);
    expect(d.indicators.windowDelta.earlierWeightAblation).toBe(3);
    expect(d.indicators.windowDelta.dominantFeature).toBe(true);
  });

  it("transcribes the other six indicators exactly", () => {
    expect(d.indicators.microMomentum).toEqual({ weight: 2, lookbackCandles: 2, candleIntervalMinutes: 1 });
    expect(d.indicators.acceleration).toEqual({ weight: 1.5, compareOffsetCandles: 2 });
    expect(d.indicators.emaCrossover).toEqual({ weight: 1, fastPeriod: 9, slowPeriod: 21 });
    expect(d.indicators.rsi).toEqual({
      period: 14, weightMin: 1, weightMax: 2, extremeUpper: 75, extremeLower: 25,
      extremeWeight: 2, neutralWeight: 0, weightOneBandUnspecified: true,
    });
    expect(d.indicators.volumeSurge).toEqual({ weight: 1, recentBars: 3, precedingBars: 3, minRatioTenths: 15 });
    expect(d.indicators.tickTrend).toEqual({
      weight: 2, pollIntervalSeconds: 2, minDirectionalConsistencyPctTenths: 600, minMovePpm: 50,
    });
  });

  it("keeps confidence = min(|score|/7, 1) labeled as a non-probability", () => {
    expect(d.confidenceMapping.divisor).toBe(7);
    expect(d.confidenceMapping.isProbability).toBe(false);
    expect(d.confidenceMapping.domainRename).toBe("score_strength");
  });
});

describe("GIST_THRESHOLDS — signal loop and execution (brief lines 683-721)", () => {
  const d = GIST_THRESHOLDS.data;

  it("transcribes the loop thresholds exactly", () => {
    expect(d.signalLoop).toEqual({
      snipeStartSecondsBeforeClose: 10,
      pollIntervalSeconds: 2,
      scoreJumpFireThreshold: 1.5,
      hardDeadlineSecondsBeforeClose: 5,
      neverSkipsWindow: true,
    });
  });

  it("transcribes the execution constants exactly", () => {
    expect(d.orderExecution).toEqual({
      primaryOrderType: "FOK market buy",
      retryIntervalSeconds: 3,
      fallbackGtcPriceCents: 95,
      claimedMinShares: 5,
      minSpendAtFallbackCents: 475,
    });
    // 5 shares at 0.95 is the printed 4.75 minimum spend — internal consistency.
    expect(d.orderExecution.claimedMinShares * d.orderExecution.fallbackGtcPriceCents)
      .toBe(d.orderExecution.minSpendAtFallbackCents);
  });
});

describe("GIST_SYNTHETIC_DELTA_CURVE — reproduces its specified anchors (brief lines 727-733)", () => {
  const d = GIST_SYNTHETIC_DELTA_CURVE.data;

  it("transcribes the five anchors exactly, including the 0.92–0.97 top range", () => {
    expect(d.anchors).toEqual([
      { asPrinted: "Below 0.005%", kind: "below", absWindowDeltaPpm: 50, priceMinCents: 50, priceMaxCents: 50 },
      { asPrinted: "Around 0.02%", kind: "around", absWindowDeltaPpm: 200, priceMinCents: 55, priceMaxCents: 55 },
      { asPrinted: "Around 0.05%", kind: "around", absWindowDeltaPpm: 500, priceMinCents: 65, priceMaxCents: 65 },
      { asPrinted: "Around 0.10%", kind: "around", absWindowDeltaPpm: 1000, priceMinCents: 80, priceMaxCents: 80 },
      { asPrinted: "At least 0.15%", kind: "at_least", absWindowDeltaPpm: 1500, priceMinCents: 92, priceMaxCents: 97 },
    ]);
  });

  it("is permanently labeled a non-executable synthetic baseline", () => {
    expect(d.mandatoryLabel).toBe("Synthetic pricing baseline — not executable.");
  });
});

describe("GIST_MODES — exact transcription (brief lines 646-673)", () => {
  const d = GIST_MODES.data;

  it("'safe' risks exactly 1/4 per trade at >=30% confidence and admits the ~68% four-loss claim", () => {
    expect(d.safe.riskPerTrade).toEqual({ numerator: 1n, denominator: 4n });
    expect(d.safe.minScoreConfidencePctTenths).toBe(300);
    expect(d.safe.claimedFourLossDrawdownAsPrinted).toBe("approximately 68%");
    expect(d.safe.briefExactFourLossDrawdownAsPrinted).toBe("0.68359375");
    expect(d.safe.labelMisleading).toBe(true);
  });

  it("'aggressive' is >=20% confidence with a self-contradictory sizing description", () => {
    expect(d.aggressive.minScoreConfidencePctTenths).toBe(200);
    expect(d.aggressive.descriptionAmbiguous).toBe(true);
    expect(d.aggressive.liveProfileProhibited).toBe(true);
  });

  it("'degen' is all-in, zero confidence, never skips — a prohibited anti-pattern", () => {
    expect(d.degen.riskPerTrade).toEqual({ numerator: 1n, denominator: 1n });
    expect(d.degen.minScoreConfidencePctTenths).toBe(0);
    expect(d.degen.neverSkips).toBe(true);
    expect(d.degen.prohibitedAntiPattern).toBe(true);
    expect(d.executableLive).toBe(false);
  });
});
