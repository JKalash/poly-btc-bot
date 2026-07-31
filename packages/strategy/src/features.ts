import {
  closingMinuteBucket, dayOfWeekUtc, isQuarterHourClose, isTopOfHourClose,
  sessionLabel, utcHour, type MarketRef, type OutcomeSide,
} from "@b5p/domain";
import { BookState, complementConsistency } from "./book";
import type { IndicatorBlock } from "./indicators";
import { TickBuffer } from "./ticks";

/** Everything the models and gates see. Persisted as a FeatureSnapshot (jsonb). */
export interface FeatureSet {
  tsMs: number;
  // time
  startEpoch: number;
  endEpoch: number;
  secondsElapsed: number;
  secondsRemaining: number;
  utcHour: number;
  closingMinuteBucket: string;
  quarterHourClose: boolean;
  topOfHourClose: boolean;
  dayOfWeek: number;
  session: string;
  // authoritative price
  chainlinkNow: number | null;
  chainlinkAgeMs: number | null;
  priceToBeat: number | null;
  distanceUsd: number | null;
  distanceBps: number | null;
  velocityBpsPerSec: number | null;
  accelerationBpsPerSec2: number | null;
  crossings120s: number;
  lastCrossAgoMs: number | null;
  minAbsDistanceBps120s: number | null;
  // volatility
  realizedVolBps: Record<string, number | null>; // by window
  ewmaVolBpsPerSqrtSec: number | null;
  highLowRangeBps60s: number | null;
  estRemainingMoveStdBps: number | null;
  distanceZ: number | null;
  // cross-feed
  binanceNow: number | null;
  binanceAgeMs: number | null;
  binanceMinusChainlinkUsd: number | null;
  binanceMinusChainlinkBps: number | null;
  chainlinkMedianGapMs: number | null;
  chainlinkMaxGapMs120s: number | null;
  // book (UP token perspective)
  upBestBid: number | null;
  upBestAsk: number | null;
  upMid: number | null;
  upSpread: number | null;
  upMicroprice: number | null;
  upImbalanceTop5: number | null;
  upDepthBidTop5: number | null;
  upDepthAskTop5: number | null;
  downBestBid: number | null;
  downBestAsk: number | null;
  bookAgeMs: number | null;
  complementInconsistency: number | null;
  upQuoteFlips: number;
  lastTradePriceUp: number | null;
  lastTradeAgoMs: number | null;
  // composite indicators (gist integration; Binance-derived, confirmation-only)
  indicators: IndicatorBlock | null;
  // warmup / quality
  warmedUp: boolean;
  dataQualityScore: number;
}

export interface FeatureInputs {
  nowMs: number;
  market: MarketRef;
  chainlink: TickBuffer;
  binance: TickBuffer;
  upBook: BookState;
  downBook: BookState;
  priceToBeat: number | null;
  warmupSeconds: number;
  chainlinkMaxAgeMs: number;
  bookMaxAgeMs: number;
  indicators?: IndicatorBlock | null;
}

const VOL_WINDOWS_S = [5, 10, 15, 30, 60, 120, 300] as const;

export function computeFeatures(inp: FeatureInputs): FeatureSet {
  const { nowMs, market } = inp;
  const nowSec = nowMs / 1000;
  const cl = inp.chainlink.latest();
  const bn = inp.binance.latest();
  const clAge = cl ? nowMs - cl.receivedTsMs : null;
  const bnAge = bn ? nowMs - bn.receivedTsMs : null;

  const distanceUsd = cl && inp.priceToBeat !== null ? cl.value - inp.priceToBeat : null;
  const distanceBps = distanceUsd !== null && inp.priceToBeat ? (distanceUsd / inp.priceToBeat) * 10_000 : null;

  const realizedVolBps: Record<string, number | null> = {};
  for (const w of VOL_WINDOWS_S) realizedVolBps[`${w}s`] = inp.chainlink.realizedVolBps(nowMs, w * 1000);

  const ewma = inp.chainlink.ewmaVolBpsPerSqrtSec(nowMs, 30_000);
  const secondsRemaining = Math.max(0, Math.round(market.endEpoch - nowSec));
  const secondsElapsed = Math.max(0, Math.round(nowSec - market.startEpoch));

  // sqrt-time remaining-move estimate seeded from EWMA vol; empirical calibration
  // must replace this before any probability from it can be trusted (see models.ts).
  const estRemainingMoveStdBps = ewma !== null ? ewma * Math.sqrt(Math.max(0, secondsRemaining)) : null;
  const distanceZ =
    distanceBps !== null && estRemainingMoveStdBps !== null && estRemainingMoveStdBps > 0
      ? distanceBps / estRemainingMoveStdBps
      : null;

  const crossings = inp.priceToBeat !== null
    ? inp.chainlink.crossings(nowMs, 120_000, inp.priceToBeat)
    : { count: 0, lastCrossAgoMs: null, minAbsDistanceBps: null };

  const vel = inp.chainlink.velocityBpsPerSec(nowMs, 10_000);
  const bookAge = inp.upBook.ageMs(nowMs);
  const warmedUp = inp.chainlink.size >= 10 && earliestAgeMs(inp.chainlink, nowMs) >= inp.warmupSeconds * 1000;

  // data-quality score: multiplicative penalties for staleness/gaps/missing pieces
  let quality = 1.0;
  if (clAge === null || clAge > inp.chainlinkMaxAgeMs) quality *= 0.2;
  else quality *= 1 - Math.min(0.3, clAge / (inp.chainlinkMaxAgeMs * 4));
  if (bookAge === null || bookAge > inp.bookMaxAgeMs) quality *= 0.5;
  if (inp.priceToBeat === null) quality *= 0.1;
  if (!warmedUp) quality *= 0.5;

  const f: FeatureSet = {
    tsMs: nowMs,
    startEpoch: market.startEpoch,
    endEpoch: market.endEpoch,
    secondsElapsed,
    secondsRemaining,
    utcHour: utcHour(market.endEpoch),
    closingMinuteBucket: closingMinuteBucket(market.endEpoch),
    quarterHourClose: isQuarterHourClose(market.endEpoch),
    topOfHourClose: isTopOfHourClose(market.endEpoch),
    dayOfWeek: dayOfWeekUtc(market.endEpoch),
    session: sessionLabel(market.endEpoch),
    chainlinkNow: cl?.value ?? null,
    chainlinkAgeMs: clAge,
    priceToBeat: inp.priceToBeat,
    distanceUsd,
    distanceBps,
    velocityBpsPerSec: vel.velocity,
    accelerationBpsPerSec2: vel.acceleration,
    crossings120s: crossings.count,
    lastCrossAgoMs: crossings.lastCrossAgoMs,
    minAbsDistanceBps120s: crossings.minAbsDistanceBps,
    realizedVolBps,
    ewmaVolBpsPerSqrtSec: ewma,
    highLowRangeBps60s: inp.chainlink.highLowRange(nowMs, 60_000)?.rangeBps ?? null,
    estRemainingMoveStdBps,
    distanceZ,
    binanceNow: bn?.value ?? null,
    binanceAgeMs: bnAge,
    binanceMinusChainlinkUsd: cl && bn ? bn.value - cl.value : null,
    binanceMinusChainlinkBps: cl && bn && cl.value > 0 ? ((bn.value - cl.value) / cl.value) * 10_000 : null,
    chainlinkMedianGapMs: inp.chainlink.medianGapMs(nowMs, 60_000),
    chainlinkMaxGapMs120s: inp.chainlink.maxGapMs(nowMs, 120_000),
    upBestBid: p6(inp.upBook.bestBid()),
    upBestAsk: p6(inp.upBook.bestAsk()),
    upMid: p6(inp.upBook.mid()),
    upSpread: p6(inp.upBook.spread()),
    upMicroprice: inp.upBook.microprice(),
    upImbalanceTop5: inp.upBook.imbalance(5),
    upDepthBidTop5: s6(inp.upBook.depthTopN("bid", 5)),
    upDepthAskTop5: s6(inp.upBook.depthTopN("ask", 5)),
    downBestBid: p6(inp.downBook.bestBid()),
    downBestAsk: p6(inp.downBook.bestAsk()),
    bookAgeMs: bookAge,
    complementInconsistency: complementConsistency(inp.upBook, inp.downBook),
    upQuoteFlips: inp.upBook.quoteFlipCount,
    lastTradePriceUp: p6(inp.upBook.lastTradePrice6),
    lastTradeAgoMs: inp.upBook.lastTradeTsMs !== null ? nowMs - inp.upBook.lastTradeTsMs : null,
    indicators: inp.indicators ?? null,
    warmedUp,
    dataQualityScore: Math.max(0, Math.min(1, quality)),
  };
  return f;
}

/** Direction implied by the authoritative distance (never by Binance alone). */
export function chainlinkDirection(f: FeatureSet): OutcomeSide | null {
  if (f.distanceUsd === null) return null;
  // tie (distance exactly 0) resolves UP by market rule (>= is Up)
  return f.distanceUsd >= 0 ? "UP" : "DOWN";
}

function p6(v: bigint | null): number | null {
  return v === null ? null : Number(v) / 1_000_000;
}
function s6(v: bigint | null): number | null {
  return v === null ? null : Number(v) / 1_000_000;
}

function earliestAgeMs(buf: TickBuffer, nowMs: number): number {
  const w = buf.window(nowMs, 24 * 3600 * 1000);
  return w.length === 0 ? 0 : nowMs - w[0]!.sourceTsMs;
}
