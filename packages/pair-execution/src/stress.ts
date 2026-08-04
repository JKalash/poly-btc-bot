import { mulDiv, ONE, PPM, type BookLevel, type Ppm, type Prob6, type Shares6, type Usdc6 } from "@b5p/domain";
import type { PairCaptureId, PairDepthStressResult, PairStressResult } from "./contracts";
import {
  composePairQuote,
  quoteDirectBuy,
  type ComposePairQuoteInput,
  type QuoteBookReference,
  type QuoteFeeSnapshot,
} from "./quote";

export interface PairStressLegInput {
  readonly tokenId: string;
  readonly levels: readonly Readonly<BookLevel>[];
  readonly tickSize6: Prob6;
  readonly limitPrice6?: Prob6;
  readonly fee: QuoteFeeSnapshot;
  readonly bookRef: QuoteBookReference;
}

export interface PairStressQuoteInput {
  readonly captureId: PairCaptureId;
  readonly pairGrossShares6: Shares6;
  readonly up: PairStressLegInput;
  readonly down: PairStressLegInput;
  readonly modeledNonrefundableSettlementCost6: Usdc6;
  readonly settlementCashReserve6: Usdc6;
  readonly recoveryCashReserve6: Usdc6;
  readonly operationalRiskHaircut6: Usdc6;
  readonly alreadyNonrefundableOperationalCosts6?: Usdc6;
}

type StressComposeReject = Extract<PairStressResult, { readonly kind: "REJECTED" }>;

function compositionInput(
  input: PairStressQuoteInput,
  upLevels: readonly Readonly<BookLevel>[],
  downLevels: readonly Readonly<BookLevel>[],
): ComposePairQuoteInput | StressComposeReject {
  const up = quoteDirectBuy({
    levels: upLevels,
    requestedShares6: input.pairGrossShares6,
    limitPrice6: input.up.limitPrice6,
    fee: input.up.fee,
    timeInForce: "FOK",
    bookRef: input.up.bookRef,
  });
  if (!up.ok || !up.quote.fullyExecutable) {
    return { kind: "REJECTED", ticksWorse: 1, code: "INSUFFICIENT_UP_DEPTH", description: up.ok ? "UP stressed book cannot fill the requested quantity" : up.detail };
  }
  const down = quoteDirectBuy({
    levels: downLevels,
    requestedShares6: input.pairGrossShares6,
    limitPrice6: input.down.limitPrice6,
    fee: input.down.fee,
    timeInForce: "FOK",
    bookRef: input.down.bookRef,
  });
  if (!down.ok || !down.quote.fullyExecutable) {
    return { kind: "REJECTED", ticksWorse: 1, code: "INSUFFICIENT_DOWN_DEPTH", description: down.ok ? "DOWN stressed book cannot fill the requested quantity" : down.detail };
  }
  return {
    captureId: input.captureId,
    pairGrossShares6: input.pairGrossShares6,
    up: { outcome: "UP", tokenId: input.up.tokenId, quote: up.quote },
    down: { outcome: "DOWN", tokenId: input.down.tokenId, quote: down.quote },
    modeledNonrefundableSettlementCost6: input.modeledNonrefundableSettlementCost6,
    settlementCashReserve6: input.settlementCashReserve6,
    recoveryCashReserve6: input.recoveryCashReserve6,
    operationalRiskHaircut6: input.operationalRiskHaircut6,
    alreadyNonrefundableOperationalCosts6: input.alreadyNonrefundableOperationalCosts6,
  };
}

function shifted(levels: readonly Readonly<BookLevel>[], tick: Prob6, count: 1 | 2): readonly BookLevel[] {
  const delta = tick * BigInt(count);
  return levels.map((level) => Object.freeze({
    price: level.price + delta > ONE ? ONE : level.price + delta,
    size: level.size,
  }));
}

/** Worsen both token books independently by one or two actual token ticks. */
export function quoteTickStress(input: PairStressQuoteInput, ticksWorse: 1 | 2): PairStressResult {
  if (
    (ticksWorse !== 1 && ticksWorse !== 2)
    || typeof input.up.tickSize6 !== "bigint" || input.up.tickSize6 <= 0n || input.up.tickSize6 > ONE
    || typeof input.down.tickSize6 !== "bigint" || input.down.tickSize6 <= 0n || input.down.tickSize6 > ONE
  ) {
    return { kind: "REJECTED", ticksWorse, code: "TICK_SIZE_INVALID", description: "each token tick must be within (0, 1]" };
  }
  const composed = compositionInput(
    input,
    shifted(input.up.levels, input.up.tickSize6, ticksWorse),
    shifted(input.down.levels, input.down.tickSize6, ticksWorse),
  );
  if ("kind" in composed) return { ...composed, ticksWorse };
  const result = composePairQuote(composed);
  if (!result.ok) {
    const code = result.code === "INSUFFICIENT_DOWN_DEPTH" ? "INSUFFICIENT_DOWN_DEPTH" : "INSUFFICIENT_UP_DEPTH";
    return { kind: "REJECTED", ticksWorse, code, description: result.description };
  }
  return Object.freeze({ kind: "EXECUTABLE", ticksWorse, ...result.quote });
}

function scaledDepth(levels: readonly Readonly<BookLevel>[], fraction: Ppm): readonly BookLevel[] {
  const result: BookLevel[] = [];
  for (const level of levels) {
    const size = mulDiv(level.size, fraction, PPM, "floor");
    if (size > 0n) result.push(Object.freeze({ price: level.price, size }));
  }
  return Object.freeze(result);
}

export function quoteDepthStress(input: PairStressQuoteInput, depthFractionPpm: Ppm): PairDepthStressResult {
  if (typeof depthFractionPpm !== "bigint" || depthFractionPpm < 0n || depthFractionPpm > PPM) {
    return { kind: "REJECTED", depthFractionPpm, code: "INSUFFICIENT_UP_DEPTH", description: "depth fraction must be within [0, 1_000_000] ppm" };
  }
  const composed = compositionInput(
    input,
    scaledDepth(input.up.levels, depthFractionPpm),
    scaledDepth(input.down.levels, depthFractionPpm),
  );
  if ("kind" in composed) {
    return {
      kind: "REJECTED",
      depthFractionPpm,
      code: composed.code === "INSUFFICIENT_DOWN_DEPTH" ? "INSUFFICIENT_DOWN_DEPTH" : "INSUFFICIENT_UP_DEPTH",
      description: composed.description,
    };
  }
  const result = composePairQuote(composed);
  if (!result.ok) {
    return {
      kind: "REJECTED",
      depthFractionPpm,
      code: result.code === "INSUFFICIENT_DOWN_DEPTH" ? "INSUFFICIENT_DOWN_DEPTH" : "INSUFFICIENT_UP_DEPTH",
      description: result.description,
    };
  }
  return Object.freeze({ kind: "EXECUTABLE", depthFractionPpm, ...result.quote });
}

export function quoteDepthStressGrid(
  input: PairStressQuoteInput,
  fractionsPpm: readonly Ppm[] = [750_000n, 500_000n, 250_000n],
): readonly PairDepthStressResult[] {
  return Object.freeze(fractionsPpm.map((fraction) => quoteDepthStress(input, fraction)));
}
