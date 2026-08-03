import { gistRef, type SourceFixture } from "./provenance";

/**
 * Archetapp gist seven-indicator composite: exact weights and thresholds.
 *
 * Provenance: 2026-07-31-001-initial-refinement.fable,
 * "## Seven-indicator composite", lines 577-641 (window-delta tiers 585-590,
 * indicators 594-627, confidence mapping 628-630); signal-loop and execution
 * thresholds from "## Gist signal loop" lines 683-699 and "## Gist order
 * execution" lines 702-721.
 *
 * The composite is `gist_composite_v1`: an UNCALIBRATED signed score (positive
 * = Up). Its "confidence" is min(|score| / 7, 1) — a normalized score, NOT a
 * probability, and it may not enter EV or Kelly formulas (brief lines 632-639).
 *
 * Weight values (7, 5, 3, 2, 1.5, 1) are exactly representable in binary
 * floating point, so plain numbers are safe here; no money is involved.
 *
 * AMBIGUITY (transcribed, not resolved): RSI is described as "Weight 1–2" with
 * extremes (>75 or <25) receiving 2 and neutral receiving 0; the band that
 * receives weight 1 is never specified by the source.
 */

export interface WindowDeltaTier {
  /** Absolute window move threshold exactly as printed. */
  asPrinted: string;
  /** Threshold in parts-per-million of price (0.10% = 1000; 0.001% = 10). */
  minAbsMovePpm: number;
  weight: number;
}

export interface GistCompositeWeightsData {
  scoreConvention: "positive means Up, negative means Down";
  indicators: {
    /** 1. Window delta — the dominant feature. */
    windowDelta: {
      tiers: WindowDeltaTier[];
      /** The guide raised this weight from 3 to 5–7 after noisy indicators overruled clear direction. */
      earlierWeightAblation: 3;
      dominantFeature: true;
    };
    /** 2. Micro momentum: direction of the last two one-minute candles. */
    microMomentum: { weight: 2; lookbackCandles: 2; candleIntervalMinutes: 1 };
    /** 3. Acceleration: latest candle move vs the move two candles earlier. */
    acceleration: { weight: 1.5; compareOffsetCandles: 2 };
    /** 4. EMA crossover: EMA 9 versus EMA 21. */
    emaCrossover: { weight: 1; fastPeriod: 9; slowPeriod: 21 };
    /** 5. RSI: period 14; extremes get 2; neutral gets 0; weight-1 band unspecified. */
    rsi: {
      period: 14;
      weightMin: 1;
      weightMax: 2;
      extremeUpper: 75;
      extremeLower: 25;
      extremeWeight: 2;
      neutralWeight: 0;
      /** The source never defines which RSI values receive weight 1. */
      weightOneBandUnspecified: true;
    };
    /** 6. Volume surge: recent 3-bar avg volume >= 1.5x preceding 3-bar avg confirms direction. */
    volumeSurge: {
      weight: 1;
      recentBars: 3;
      precedingBars: 3;
      /** Ratio threshold in tenths (1.5x = 15) to keep the fixture float-free. */
      minRatioTenths: 15;
    };
    /** 7. Real-time tick trend: 2s polling, >=60% directional consistency, >0.005% move. */
    tickTrend: {
      weight: 2;
      pollIntervalSeconds: 2;
      minDirectionalConsistencyPctTenths: 600; // 60% = 600
      minMovePpm: 50; // 0.005% = 50 ppm
    };
  };
  /** confidence = min(abs(score) / 7, 1) — a normalized score, not a probability. */
  confidenceMapping: {
    formulaAsPrinted: "confidence = min(abs(score) / 7, 1)";
    divisor: 7;
    isProbability: false;
    domainRename: "score_strength";
  };
}

export const GIST_COMPOSITE_WEIGHTS: SourceFixture<GistCompositeWeightsData> = {
  id: "gist_composite_weights_v1",
  title: "Archetapp gist seven-indicator composite weights (gist_composite_v1)",
  label: "SOURCE_CLAIM_UNVERIFIED",
  claimText:
    "A signed composite of seven weighted indicators (window delta tiered 7/5/3/1 as the " +
    "dominant feature; micro momentum 2; acceleration 1.5; EMA 9/21 crossover 1; RSI 14 " +
    "at 1–2; volume surge 1; tick trend 2) with confidence = min(|score|/7, 1).",
  sourceRef: gistRef(
    "seven_indicator_composite_weights",
    "## Seven-indicator composite",
    { start: 577, end: 641 },
  ),
  data: {
    scoreConvention: "positive means Up, negative means Down",
    indicators: {
      windowDelta: {
        tiers: [
          { asPrinted: "Greater than 0.10%", minAbsMovePpm: 1000, weight: 7 },
          { asPrinted: "Greater than 0.02%", minAbsMovePpm: 200, weight: 5 },
          { asPrinted: "Greater than 0.005%", minAbsMovePpm: 50, weight: 3 },
          { asPrinted: "Greater than 0.001%", minAbsMovePpm: 10, weight: 1 },
        ],
        earlierWeightAblation: 3,
        dominantFeature: true,
      },
      microMomentum: { weight: 2, lookbackCandles: 2, candleIntervalMinutes: 1 },
      acceleration: { weight: 1.5, compareOffsetCandles: 2 },
      emaCrossover: { weight: 1, fastPeriod: 9, slowPeriod: 21 },
      rsi: {
        period: 14,
        weightMin: 1,
        weightMax: 2,
        extremeUpper: 75,
        extremeLower: 25,
        extremeWeight: 2,
        neutralWeight: 0,
        weightOneBandUnspecified: true,
      },
      volumeSurge: { weight: 1, recentBars: 3, precedingBars: 3, minRatioTenths: 15 },
      tickTrend: {
        weight: 2,
        pollIntervalSeconds: 2,
        minDirectionalConsistencyPctTenths: 600,
        minMovePpm: 50,
      },
    },
    confidenceMapping: {
      formulaAsPrinted: "confidence = min(abs(score) / 7, 1)",
      divisor: 7,
      isProbability: false,
      domainRename: "score_strength",
    },
  },
};

/**
 * Loop-level and execution-level thresholds (mode-independent). Per-mode
 * confidence minimums live in GIST_MODES; per-indicator thresholds live in
 * GIST_COMPOSITE_WEIGHTS.
 */
export interface GistThresholdsData {
  signalLoop: {
    /** Loop starts at T-10 seconds before window close. */
    snipeStartSecondsBeforeClose: 10;
    /** Analyzes every two seconds. */
    pollIntervalSeconds: 2;
    /** Fires immediately when the score jumps by at least 1.5. */
    scoreJumpFireThreshold: 1.5;
    /** Otherwise uses the best observed signal by a T-5 hard deadline. */
    hardDeadlineSecondsBeforeClose: 5;
    /** The loop never skips a window (prohibited outside the reproduction sandbox). */
    neverSkipsWindow: true;
  };
  orderExecution: {
    /** Primary FOK market buy for an exact dollar amount. */
    primaryOrderType: "FOK market buy";
    /** Retry every three seconds until the window closes (brief prohibits blind retries). */
    retryIntervalSeconds: 3;
    /** Fallback GTC buy price when the favored token has no asks, in cents (0.95 = 95). */
    fallbackGtcPriceCents: 95;
    /** Claimed minimum five shares. */
    claimedMinShares: 5;
    /** "4.75 minimum spend at 0.95", in cents. */
    minSpendAtFallbackCents: 475;
  };
}

export const GIST_THRESHOLDS: SourceFixture<GistThresholdsData> = {
  id: "gist_thresholds_v1",
  title: "Archetapp gist signal-loop and order-execution thresholds",
  label: "SOURCE_CLAIM_UNVERIFIED",
  claimText:
    "Signal loop: start T-10s, poll every 2s, fire on score jump >= 1.5 or mode " +
    "threshold, forced best-seen trade by T-5s, never skip. Execution: FOK market buy, " +
    "3s retries, fallback GTC at 0.95, minimum 5 shares (4.75 minimum spend).",
  sourceRef: gistRef(
    "signal_loop_and_execution_thresholds",
    "## Gist signal loop / ## Gist order execution",
    { start: 683, end: 721 },
  ),
  data: {
    signalLoop: {
      snipeStartSecondsBeforeClose: 10,
      pollIntervalSeconds: 2,
      scoreJumpFireThreshold: 1.5,
      hardDeadlineSecondsBeforeClose: 5,
      neverSkipsWindow: true,
    },
    orderExecution: {
      primaryOrderType: "FOK market buy",
      retryIntervalSeconds: 3,
      fallbackGtcPriceCents: 95,
      claimedMinShares: 5,
      minSpendAtFallbackCents: 475,
    },
  },
};
