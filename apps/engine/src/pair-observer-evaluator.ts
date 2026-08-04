import { ONE, type BookLevel, type Shares6, type Usdc6 } from "@b5p/domain";
import {
  buildCandidateFrontier,
  buildPairCapture,
  canonicalObjectHash,
  composePairQuote,
  evaluatePairRisk,
  finalizePairQuote,
  quoteDepthStressGrid,
  quoteDirectBuy,
  quoteTickStress,
  selectBestPairCandidate,
  type PairBookCapture,
  type PairPolicySnapshot,
  type PairPortfolioSnapshot,
  type PairQuote,
  type PairRejection,
  type PairRejectionCode,
  type PairRiskDecision,
  type PairRunMode,
  type PairTokenTerms,
  type PairTokenTermsProvider,
  type QuoteRejectReason,
} from "@b5p/pair-execution";
import { canonicalBookHash, type ImmutableBookView } from "@b5p/strategy";
import {
  PairObservationStore,
  type PairEpisodeState,
  type RecordPairEvaluationResult,
} from "./pair-observation-store";
import {
  PairObserverRuntime,
  type PairObserverEvaluation,
  type PairRuntimeTrigger,
} from "./pair-runtime";

export interface PairObserverMarket {
  readonly marketId: string;
  readonly conditionId: string;
  readonly upTokenId: string;
  readonly downTokenId: string;
  readonly mode: PairRunMode;
}

export interface PairObserverBookSource {
  readonly books: ReadonlyMap<string, { snapshot(): ImmutableBookView }>;
}

export interface PairObserverEvaluatorOptions {
  readonly engine: PairObserverBookSource;
  readonly terms: PairTokenTermsProvider;
  readonly observations: PairObservationStore;
  readonly policy: () => PairPolicySnapshot;
  readonly observerOperationalHash: () => string;
  readonly portfolio: (input: { readonly marketId: string; readonly asOfMs: number }) => Promise<PairPortfolioSnapshot>;
  readonly requestedCashCap6: (input: { readonly marketId: string; readonly portfolio: PairPortfolioSnapshot; readonly policy: PairPolicySnapshot }) => Usdc6;
  readonly secondsRemaining?: (input: { readonly marketId: string; readonly asOfMs: number }) => number | undefined;
  /** Diagnostic near-miss band from `pair.prefilter_band_usdc_per_share`. */
  readonly prefilterBand6: Usdc6;
  readonly maximumMarkets: number;
  readonly nowMs?: () => number;
  readonly captureSequence?: (input: PairObserverEvaluation) => bigint;
  readonly onHealth: (
    code: "PAIR_RUNTIME_CAPACITY_EXCEEDED" | "PAIR_RUNTIME_EVALUATION_FAILED",
    detail: Readonly<Record<string, unknown>>,
  ) => void;
  readonly onResult?: (result: PairObserverResult) => void;
}

export type PairObserverRejectPhase = "CAPABILITY" | "CAPTURE" | "TERMS" | "PREFILTER" | "PORTFOLIO" | "QUOTE";

export interface PairObserverRejectedResult {
  readonly kind: "REJECTED";
  readonly marketId: string;
  readonly trigger: PairRuntimeTrigger;
  readonly phase: PairObserverRejectPhase;
  readonly reasons: readonly PairRejection[];
  readonly captureId: string | null;
  readonly observation: RecordPairEvaluationResult | null;
}

export interface PairObserverEvaluatedResult {
  readonly kind: "EVALUATED";
  readonly marketId: string;
  readonly trigger: PairRuntimeTrigger;
  readonly captureId: string;
  readonly observation: RecordPairEvaluationResult;
  readonly episodeState: PairEpisodeState | null;
  readonly selectedQuoteHash: string | null;
  readonly selectedPairShares6: Shares6 | null;
  /** Counterfactual economics/risk eligibility; capability flags are reported separately. */
  readonly counterfactualEligible: boolean;
  readonly paperSchedulingPermitted: boolean;
  readonly rejectionCodes: readonly PairRejectionCode[];
}

export type PairObserverResult = PairObserverRejectedResult | PairObserverEvaluatedResult;

interface EvaluatedCandidate {
  readonly quote: PairQuote;
  readonly risk: PairRiskDecision;
  readonly counterfactualReasons: readonly PairRejection[];
}

const pairReason = (code: PairRejectionCode, description: string): PairRejection => Object.freeze({ code, description });

function uniqueReasons(reasons: readonly PairRejection[]): readonly PairRejection[] {
  const seen = new Set<PairRejectionCode>();
  return Object.freeze(reasons.filter((item) => !seen.has(item.code) && seen.add(item.code)));
}

function bookLevels(levels: PairBookCapture["up"]["asks"]): readonly BookLevel[] {
  return Object.freeze(levels.map((level) => Object.freeze({ price: level.price6, size: level.shares6 })));
}

function bookReference(leg: PairBookCapture["up"], marketId: string) {
  const view: ImmutableBookView = {
    tokenId: leg.tokenId,
    marketId,
    bookVersion: leg.bookVersion,
    connectionEpoch: leg.connectionEpoch,
    sourceTsMs: leg.sourceTsMs,
    receivedTsMs: leg.receivedTsMs,
    exchangeHash: leg.exchangeHash,
    sourceEventId: leg.sourceEventId,
    integrity: leg.integrity,
    bids: leg.bids.map((level) => ({ price: level.price6, size: level.shares6 })),
    asks: leg.asks.map((level) => ({ price: level.price6, size: level.shares6 })),
  };
  return Object.freeze({
    tokenId: leg.tokenId,
    bookVersion: leg.bookVersion,
    connectionEpoch: leg.connectionEpoch,
    sourceEventId: leg.sourceEventId,
    contentHash: canonicalBookHash(view),
  });
}

function fee(terms: PairTokenTerms) {
  return Object.freeze({ ratePpm: terms.fee.tokenFeeRatePpm, collection: terms.fee.convention.toLowerCase() });
}

function quoteRejection(outcome: "UP" | "DOWN", reason: QuoteRejectReason, detail: string): PairRejection {
  const code: PairRejectionCode = reason === "FEE_SNAPSHOT_MISSING"
    ? "FEE_SNAPSHOT_MISSING"
    : reason === "FEE_CONVENTION_UNKNOWN"
      ? "FEE_CONVENTION_UNKNOWN"
      : reason === "UNSUPPORTED_SELL_FEE_COLLECTION"
        ? "UNSUPPORTED_SELL_FEE_COLLECTION"
        : reason === "MALFORMED_BOOK"
          ? "BOOK_CONTINUITY_UNVERIFIED"
          : "NO_EXECUTABLE_SIZE";
  return pairReason(code, `${outcome}: ${detail}`);
}

function quoteCandidate(input: {
  readonly capture: PairBookCapture;
  readonly upTerms: PairTokenTerms;
  readonly downTerms: PairTokenTerms;
  readonly policy: PairPolicySnapshot;
  readonly quantity6: Shares6;
}): PairQuote | PairRejection {
  const upLevels = bookLevels(input.capture.up.asks);
  const downLevels = bookLevels(input.capture.down.asks);
  const upBookRef = bookReference(input.capture.up, input.capture.marketId);
  const downBookRef = bookReference(input.capture.down, input.capture.marketId);
  const up = quoteDirectBuy({
    levels: upLevels,
    requestedShares6: input.quantity6,
    fee: fee(input.upTerms),
    timeInForce: "FOK",
    bookRef: upBookRef,
  });
  if (!up.ok || !up.quote.fullyExecutable) {
    return up.ok
      ? pairReason("INSUFFICIENT_UP_DEPTH", "UP direct-buy depth is insufficient")
      : quoteRejection("UP", up.reason, up.detail);
  }
  const down = quoteDirectBuy({
    levels: downLevels,
    requestedShares6: input.quantity6,
    fee: fee(input.downTerms),
    timeInForce: "FOK",
    bookRef: downBookRef,
  });
  if (!down.ok || !down.quote.fullyExecutable) {
    return down.ok
      ? pairReason("INSUFFICIENT_DOWN_DEPTH", "DOWN direct-buy depth is insufficient")
      : quoteRejection("DOWN", down.reason, down.detail);
  }
  const composition = composePairQuote({
    captureId: input.capture.captureId,
    pairGrossShares6: input.quantity6,
    up: { outcome: "UP", tokenId: input.capture.up.tokenId, quote: up.quote },
    down: { outcome: "DOWN", tokenId: input.capture.down.tokenId, quote: down.quote },
    modeledNonrefundableSettlementCost6: input.policy.modeledSettlementCost6,
    settlementCashReserve6: input.policy.settlementCashReserve6,
    recoveryCashReserve6: input.policy.recoveryReserve6,
    operationalRiskHaircut6: input.policy.operationalRiskHaircut6,
  });
  if (!composition.ok) return pairReason(composition.code, composition.description);
  const stressInput = {
    captureId: input.capture.captureId,
    pairGrossShares6: input.quantity6,
    up: {
      tokenId: input.capture.up.tokenId,
      levels: upLevels,
      tickSize6: input.upTerms.constraints.tickSize6,
      fee: fee(input.upTerms),
      bookRef: upBookRef,
    },
    down: {
      tokenId: input.capture.down.tokenId,
      levels: downLevels,
      tickSize6: input.downTerms.constraints.tickSize6,
      fee: fee(input.downTerms),
      bookRef: downBookRef,
    },
    modeledNonrefundableSettlementCost6: input.policy.modeledSettlementCost6,
    settlementCashReserve6: input.policy.settlementCashReserve6,
    recoveryCashReserve6: input.policy.recoveryReserve6,
    operationalRiskHaircut6: input.policy.operationalRiskHaircut6,
  } as const;
  const oneTickWorse = quoteTickStress(stressInput, 1);
  const twoTicksWorse = quoteTickStress(stressInput, 2);
  const depthStress = quoteDepthStressGrid(stressInput, input.policy.depthStressFractionsPpm);
  return finalizePairQuote({ captureId: input.capture.captureId, economics: composition.quote, oneTickWorse, twoTicksWorse, depthStress });
}

function economicReasons(quote: PairQuote, policy: PairPolicySnapshot, requestedCashCap6: Usdc6): readonly PairRejection[] {
  const reasons: PairRejection[] = [];
  if (quote.reservedCash6 > requestedCashCap6) reasons.push(pairReason("AGGREGATE_CASH_CAP_EXCEEDED", "quote exceeds the observer request cash cap"));
  if (quote.grossWalkEdge6 <= 0n) reasons.push(pairReason("GROSS_EDGE_NON_POSITIVE", "walked direct-buy principal has no positive gross edge"));
  if (quote.netPnl6 < policy.minimumNetPnl6) reasons.push(pairReason("NET_PNL_BELOW_MINIMUM", "quote net P&L is below policy"));
  if (quote.netReturnPpm < policy.minimumNetReturnPpm) reasons.push(pairReason("NET_RETURN_BELOW_MINIMUM", "quote net return is below policy"));
  if (policy.requireOneTickStressPositive && (quote.oneTickWorse.kind !== "EXECUTABLE" || quote.oneTickWorse.netPnl6 <= 0n)) {
    reasons.push(pairReason("ONE_TICK_STRESS_FAILED", "one-tick-worse quote is unavailable or nonpositive"));
  }
  if (policy.requireTwoTickStressPositive && (quote.twoTicksWorse.kind !== "EXECUTABLE" || quote.twoTicksWorse.netPnl6 <= 0n)) {
    reasons.push(pairReason("TWO_TICK_STRESS_FAILED", "two-tick-worse quote is unavailable or nonpositive"));
  }
  return Object.freeze(reasons);
}

function requestedCapQuantity(input: {
  readonly capture: PairBookCapture;
  readonly upTerms: PairTokenTerms;
  readonly downTerms: PairTokenTerms;
  readonly policy: PairPolicySnapshot;
  readonly cashCap6: Usdc6;
}): Shares6 {
  const upDepth = input.capture.up.asks.reduce((sum, level) => sum + level.shares6, 0n);
  const downDepth = input.capture.down.asks.reduce((sum, level) => sum + level.shares6, 0n);
  let high = upDepth < downDepth ? upDepth : downDepth;
  if (input.policy.maximumPairShares6 !== null && input.policy.maximumPairShares6 < high) high = input.policy.maximumPairShares6;
  const lot = input.policy.pairShareLot6;
  high = (high / lot) * lot;
  let low = 0n;
  let highLots = high / lot;
  let lowLots = 0n;
  while (highLots - lowLots > 1n) {
    const midLots = (lowLots + highLots) / 2n;
    const result = quoteCandidate({ ...input, quantity6: midLots * lot });
    if ("quoteHash" in result && result.reservedCash6 <= input.cashCap6) {
      lowLots = midLots;
      low = midLots * lot;
    } else {
      highLots = midLots;
    }
  }
  if (high > 0n) {
    const result = quoteCandidate({ ...input, quantity6: high });
    if ("quoteHash" in result && result.reservedCash6 <= input.cashCap6) return high;
  }
  return low;
}

function triggerSequence(input: PairObserverEvaluation): bigint {
  // Stable across replay/restart for a normalized trigger. It is an opaque
  // capture ordering key; production composition should inject the durable
  // market-event sequence when available.
  return BigInt(`0x${canonicalObjectHash({ marketId: input.marketId, trigger: input.trigger }).slice(0, 15)}`);
}

/**
 * Observer-only end-to-end composition. It has no order, reservation, venue,
 * wallet, or live adapter dependency: its strongest effect is immutable
 * capture/observation persistence.
 */
export class PairObserverEvaluator {
  readonly runtime: PairObserverRuntime;
  private readonly markets = new Map<string, PairObserverMarket>();
  private readonly disabledMarkets = new Set<string>();
  private readonly nowMs: () => number;

  constructor(private readonly options: PairObserverEvaluatorOptions) {
    if (typeof options.prefilterBand6 !== "bigint" || options.prefilterBand6 < 0n) throw new RangeError("prefilterBand6 must be a non-negative bigint");
    this.nowMs = options.nowMs ?? Date.now;
    this.runtime = new PairObserverRuntime({
      maximumMarkets: options.maximumMarkets,
      evaluate: (input) => this.evaluate(input),
      onHealth: (code, detail) => {
        if (code === "PAIR_RUNTIME_EVALUATION_FAILED" && typeof detail.marketId === "string") {
          this.disabledMarkets.add(detail.marketId);
        }
        options.onHealth(code, detail);
      },
    });
  }

  registerMarket(market: PairObserverMarket): boolean {
    if (market.marketId.length === 0 || market.conditionId.length === 0 || market.upTokenId.length === 0 || market.downTokenId.length === 0) return false;
    if (!this.runtime.registerMarket(market.marketId)) return false;
    this.disabledMarkets.delete(market.marketId);
    this.markets.set(market.marketId, Object.freeze({ ...market }));
    return true;
  }

  unregisterMarket(marketId: string): boolean {
    if (!this.runtime.unregisterMarket(marketId)) return false;
    this.disabledMarkets.delete(marketId);
    this.markets.delete(marketId);
    return true;
  }

  markDirty(marketId: string, trigger: PairRuntimeTrigger) {
    return this.runtime.markDirty(marketId, trigger);
  }

  whenIdle(marketId: string): Promise<void> {
    return this.runtime.whenIdle(marketId);
  }

  private emit(result: PairObserverResult): void {
    this.options.onResult?.(result);
  }

  private reject(input: PairObserverEvaluation, phase: PairObserverRejectPhase, reasons: readonly PairRejection[], captureId: string | null = null, observation: RecordPairEvaluationResult | null = null): void {
    this.emit(Object.freeze({ kind: "REJECTED", marketId: input.marketId, trigger: input.trigger, phase, reasons: uniqueReasons(reasons), captureId, observation }));
  }

  private async evaluate(input: PairObserverEvaluation): Promise<void> {
    const market = this.markets.get(input.marketId);
    if (market === undefined || this.disabledMarkets.has(input.marketId)) return;
    const policy = this.options.policy();
    if (!policy.observerEnabled) {
      this.reject(input, "CAPABILITY", [pairReason("PAIR_FEATURE_DISABLED", "pair observer is disabled by policy")]);
      return;
    }

    // Both snapshots are taken synchronously before the first await, after the
    // complete envelope dirty marker. This is the atomic two-token boundary.
    const upView = this.options.engine.books.get(market.upTokenId)?.snapshot() ?? null;
    const downView = this.options.engine.books.get(market.downTokenId)?.snapshot() ?? null;
    const observedAtMs = this.nowMs();
    const captureResult = buildPairCapture({
      marketId: market.marketId,
      conditionId: market.conditionId,
      expectedUpTokenId: market.upTokenId,
      expectedDownTokenId: market.downTokenId,
      capturedAtMs: observedAtMs,
      captureSequence: (this.options.captureSequence ?? triggerSequence)(input),
      mode: market.mode,
      policy,
      up: upView,
      down: downView,
    });
    if (captureResult.kind === "REJECTED") {
      this.reject(input, "CAPTURE", captureResult.reasons);
      return;
    }
    const capture = captureResult.capture;

    const terms = await this.options.terms.currentTerms({
      marketId: market.marketId,
      conditionId: market.conditionId,
      upTokenId: market.upTokenId,
      downTokenId: market.downTokenId,
      asOfMs: observedAtMs,
    });
    if (terms.kind === "REJECTED") {
      this.reject(input, "TERMS", [pairReason(terms.code, terms.detail)], capture.captureId);
      return;
    }
    await this.options.observations.persistCapture({
      capture,
      captureKind: "SIGNAL",
      dataCutoffEnvelopeId: input.trigger.kind === "CLOB_ENVELOPE" ? input.trigger.id : null,
      upTerms: terms.up,
      downTerms: terms.down,
      createdAtMs: observedAtMs,
    });

    const minimumAskSum6 = capture.up.asks[0]!.price6 + capture.down.asks[0]!.price6;
    const grossTopOfBookEdge6 = ONE - minimumAskSum6;
    const prefilter = minimumAskSum6 <= ONE + this.options.prefilterBand6;
    if (!prefilter) {
      const observation = await this.record(input, market, policy, capture, terms.up, terms.down, {
        requestedCashCap6: 0n,
        observedAtMs,
        episodeState: null,
        minimumAskSum6,
        grossTopOfBookEdge6,
        rejectionCodes: [],
        funnel: { prefilter: false, gross: false, fullDepth: false, feePositive: false, stressPositive: false },
      });
      this.emit(Object.freeze({
        kind: "EVALUATED", marketId: input.marketId, trigger: input.trigger, captureId: capture.captureId,
        observation, episodeState: null, selectedQuoteHash: null, selectedPairShares6: null,
        counterfactualEligible: false, paperSchedulingPermitted: false, rejectionCodes: [],
      }));
      return;
    }

    let portfolio: PairPortfolioSnapshot;
    try {
      portfolio = await this.options.portfolio({ marketId: market.marketId, asOfMs: observedAtMs });
    } catch (error) {
      const reasons = [pairReason("PORTFOLIO_UNRECONCILED", error instanceof Error ? error.message : "pair portfolio snapshot failed")];
      const observation = await this.record(input, market, policy, capture, terms.up, terms.down, {
        requestedCashCap6: 0n, observedAtMs, episodeState: grossTopOfBookEdge6 > 0n ? "GROSS_DISLOCATION" : null,
        minimumAskSum6, grossTopOfBookEdge6, rejectionCodes: reasons.map((item) => item.code),
        funnel: { prefilter: true, gross: grossTopOfBookEdge6 > 0n, fullDepth: false, feePositive: false, stressPositive: false },
      });
      this.reject(input, "PORTFOLIO", reasons, capture.captureId, observation);
      return;
    }
    const requestedCashCap6 = this.options.requestedCashCap6({ marketId: market.marketId, portfolio, policy });
    if (typeof requestedCashCap6 !== "bigint" || requestedCashCap6 < 0n) throw new RangeError("requestedCashCap6 provider returned an invalid value");
    const capQuantity6 = requestedCapQuantity({ capture, upTerms: terms.up, downTerms: terms.down, policy, cashCap6: requestedCashCap6 });
    const frontier = buildCandidateFrontier({
      upAsks: bookLevels(capture.up.asks), downAsks: bookLevels(capture.down.asks),
      pairShareLot6: policy.pairShareLot6,
      upMinimumOrderShares6: terms.up.constraints.minimumOrderShares6,
      downMinimumOrderShares6: terms.down.constraints.minimumOrderShares6,
      cashCapQuantity6: capQuantity6,
      maximumPairShares6: policy.maximumPairShares6,
    });
    const failures: PairRejection[] = [];
    const evaluated: EvaluatedCandidate[] = [];
    if (!frontier.ok) failures.push(pairReason("NO_EXECUTABLE_SIZE", frontier.detail));
    else for (const quantity6 of frontier.candidates6) {
      const quoted = quoteCandidate({ capture, upTerms: terms.up, downTerms: terms.down, policy, quantity6 });
      if (!("quoteHash" in quoted)) {
        failures.push(quoted);
        continue;
      }
      const economics = economicReasons(quoted, policy, requestedCashCap6);
      const risk = evaluatePairRisk({
        marketId: market.marketId,
        quoteHash: quoted.quoteHash,
        quote: quoted,
        oneTickWorse: quoted.oneTickWorse,
        twoTicksWorse: quoted.twoTicksWorse,
        portfolio,
        policy,
        nowMs: observedAtMs,
        permitId: `observer_${quoted.quoteHash.slice(0, 32)}`,
        secondsRemaining: this.options.secondsRemaining?.({ marketId: market.marketId, asOfMs: observedAtMs }),
      });
      const riskReasons = risk.kind === "REJECTED" ? risk.reasons : [];
      // Feature activation is not an economic rejection in observer mode. It
      // remains part of the real scheduling decision below.
      const counterfactualRiskReasons = riskReasons.filter((item) => item.code !== "PAPER_EXECUTION_DISABLED");
      evaluated.push(Object.freeze({ quote: quoted, risk, counterfactualReasons: uniqueReasons([...economics, ...counterfactualRiskReasons]) }));
    }
    const eligible = evaluated.filter((item) => item.counterfactualReasons.length === 0);
    const pool = eligible.length > 0 ? eligible : evaluated;
    const best = selectBestPairCandidate(pool.map((item) => ({
      quote: item.quote,
      oneTickWorseNetPnl6: item.quote.oneTickWorse.kind === "EXECUTABLE" ? item.quote.oneTickWorse.netPnl6 : -(2n ** 62n),
    })));
    const selected = best === null ? null : pool.find((item) => item.quote.quoteHash === (best.quote as PairQuote).quoteHash) ?? null;
    const rejectionReasons = selected === null ? uniqueReasons(failures.length > 0 ? failures : [pairReason("NO_EXECUTABLE_SIZE", "no candidate quantity was executable")]) : selected.counterfactualReasons;
    const counterfactualEligible = selected !== null && rejectionReasons.length === 0;
    const paperSchedulingPermitted = counterfactualEligible && selected!.risk.kind === "APPROVED" && market.mode === "paper";
    const episodeState: PairEpisodeState | null = counterfactualEligible ? "NET_ELIGIBLE" : grossTopOfBookEdge6 > 0n ? "GROSS_DISLOCATION" : null;
    const observation = await this.record(input, market, policy, capture, terms.up, terms.down, {
      requestedCashCap6, observedAtMs, episodeState, minimumAskSum6, grossTopOfBookEdge6,
      selected: selected?.quote ?? null,
      decision: selected?.risk ?? { kind: "REJECTED", reasons: rejectionReasons },
      rejectionCodes: rejectionReasons.map((item) => item.code),
      funnel: {
        prefilter: true,
        gross: grossTopOfBookEdge6 > 0n,
        fullDepth: evaluated.length > 0,
        feePositive: evaluated.some((item) => item.quote.netPnl6 > 0n),
        stressPositive: evaluated.some((item) => item.quote.oneTickWorse.kind === "EXECUTABLE" && item.quote.oneTickWorse.netPnl6 > 0n),
      },
    });
    this.emit(Object.freeze({
      kind: "EVALUATED", marketId: input.marketId, trigger: input.trigger, captureId: capture.captureId,
      observation, episodeState, selectedQuoteHash: selected?.quote.quoteHash ?? null,
      selectedPairShares6: selected?.quote.pairGrossShares6 ?? null, counterfactualEligible,
      paperSchedulingPermitted, rejectionCodes: Object.freeze(rejectionReasons.map((item) => item.code)),
    }));
  }

  private record(
    input: PairObserverEvaluation,
    market: PairObserverMarket,
    policy: PairPolicySnapshot,
    capture: PairBookCapture,
    upTerms: PairTokenTerms,
    downTerms: PairTokenTerms,
    evaluation: {
      readonly requestedCashCap6: Usdc6;
      readonly observedAtMs: number;
      readonly episodeState: PairEpisodeState | null;
      readonly minimumAskSum6: bigint;
      readonly grossTopOfBookEdge6: bigint;
      readonly selected?: PairQuote | null;
      readonly decision?: unknown;
      readonly rejectionCodes: readonly PairRejectionCode[];
      readonly funnel: { readonly prefilter: boolean; readonly gross: boolean; readonly fullDepth: boolean; readonly feePositive: boolean; readonly stressPositive: boolean };
    },
  ): Promise<RecordPairEvaluationResult> {
    const quote = evaluation.selected ?? null;
    return this.options.observations.recordEvaluation({
      marketId: market.marketId, conditionId: market.conditionId, strategyVersion: policy.strategyVersion,
      mode: market.mode, triggerKind: input.trigger.kind, triggerId: input.trigger.id, capture, upTerms, downTerms,
      policyHash: policy.policyHash, observerOperationalHash: this.options.observerOperationalHash(), configVersion: policy.configVersion,
      requestedCashCap6: evaluation.requestedCashCap6, observedAtMs: evaluation.observedAtMs,
      episodeState: evaluation.episodeState, episodeCooloffMs: policy.episodeCooloffMs,
      negativeControlSamplePpm: policy.negativeControlSamplePpm, minimumAskSum6: evaluation.minimumAskSum6,
      selectedPairShares6: quote?.pairGrossShares6 ?? null, grossTopOfBookEdge6: evaluation.grossTopOfBookEdge6,
      grossWalkEdge6: quote?.grossWalkEdge6 ?? null, netPreLatencyPnl6: quote?.netPnl6 ?? null,
      netPreLatencyEdgePpm: quote?.netReturnPpm ?? null,
      oneTickWorsePnl6: quote?.oneTickWorse.kind === "EXECUTABLE" ? quote.oneTickWorse.netPnl6 : null,
      twoTicksWorsePnl6: quote?.twoTicksWorse.kind === "EXECUTABLE" ? quote.twoTicksWorse.netPnl6 : null,
      worstCaseResidualLoss6: quote?.worstSingleLegLoss6 ?? null,
      operationalRiskHaircut6: policy.operationalRiskHaircut6,
      rejectionCodes: evaluation.rejectionCodes,
      captureSummary: {
        captureId: capture.captureId, captureSequence: capture.captureSequence,
        upBookVersion: capture.up.bookVersion, downBookVersion: capture.down.bookVersion,
        sourceSkewMs: capture.sourceSkewMs, receiveSkewMs: capture.receiveSkewMs,
      },
      quote,
      decision: evaluation.decision ?? { kind: "OUTSIDE_PREFILTER" },
      depthStress: quote?.depthStress ?? null,
      funnel: {
        completeEnvelopes: input.trigger.kind === "CLOB_ENVELOPE",
        validSynchronizedCaptures: true,
        evaluatedCaptures: true,
        prefilterCaptures: evaluation.funnel.prefilter,
        grossDislocations: evaluation.funnel.gross,
        fullDepthExecutable: evaluation.funnel.fullDepth,
        feePositive: evaluation.funnel.feePositive,
        stressPositive: evaluation.funnel.stressPositive,
      },
    });
  }
}
