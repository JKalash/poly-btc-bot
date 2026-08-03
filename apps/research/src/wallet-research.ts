import {
  ONE, mulDiv, parseFixed,
  type Prob6, type Shares6, type Usdc6, type WalletResearchSnapshot,
} from "@b5p/domain";
import { newId } from "@b5p/domain/ids";
import { sha256OfCanonicalJson, type EvidenceLabel } from "@b5p/evidence";
import { z } from "zod";

/**
 * R12 wallet-research pipeline — RESEARCH ONLY, pure analysis core.
 *
 * Given a wallet's raw activity records (transfers, trade fills with fees, CTF
 * split/merge/redeem, PAID rewards/rebates) it reconstructs an honest economic
 * breakdown and exposes the brief's thesis: apparent "whale profit" under naive
 * flow accounting is often reward income + an unrealized inventory mark, not
 * trading edge. The decomposition is exact in bigint micro-USDC:
 *
 *   naive_apparent_profit = trading_pnl (fees included)
 *                         + paid_incentives (rewards + rebates)   <- NEVER inside trading_pnl
 *                         + unrealized_at_mark
 *                         + unlabeled_transfer_net_in             <- a naive observer cannot
 *                                                                    tell these from winnings
 *
 * No network calls anywhere in this module. Inputs come from committed JSON
 * fixtures or operator-supplied files; this pipeline OBSERVES public claims,
 * it does not verify them — snapshots therefore carry SOURCE_CLAIM_UNVERIFIED,
 * or DATA_GATED when the reconstruction itself is blocked by missing data.
 * Incomplete records become explicit dataGaps entries, never silent drops.
 */

export const WALLET_ANALYSIS_VERSION = "wallet-research-v1";

// ---------------------------------------------------------------------------
// Typed input (bigint micro-units)
// ---------------------------------------------------------------------------

export type WalletActivityRecord =
  | { kind: "DEPOSIT"; tsMs: number; amount6: Usdc6 }
  | { kind: "WITHDRAWAL"; tsMs: number; amount6: Usdc6 }
  | {
      kind: "TRANSFER_IN" | "TRANSFER_OUT"; tsMs: number; amount6: Usdc6;
      /** Null counterparty => unknownCounterparties data gap. */
      counterparty: string | null;
      /** Null label => unlabeledTransfers data gap (naive accounting counts these as profit). */
      label: string | null;
    }
  | {
      kind: "TRADE"; tsMs: number; marketId: string; tokenId: string;
      side: "BUY" | "SELL"; shares6: Shares6; price6: Prob6; fee6: Usdc6;
      role: "MAKER" | "TAKER" | null;
    }
  | { kind: "SPLIT" | "MERGE"; tsMs: number; marketId: string; amount6: Usdc6; yesTokenId: string; noTokenId: string }
  | { kind: "REDEEM"; tsMs: number; marketId: string; tokenId: string; shares6: Shares6; payout6: Usdc6 }
  | { kind: "REWARD_PAID"; tsMs: number; program: string; epochKey: string | null; amount6: Usdc6 }
  | { kind: "REBATE_PAID"; tsMs: number; epochKey: string | null; amount6: Usdc6 };

export interface WalletClaimProvenance {
  /** The public claim being observed (e.g. "wallet X made $400k"). */
  claimText: string;
  /** Where the claim came from (URL, post, "synthetic fixture", ...). */
  claimSource: string;
  retrievedAtMs: number | null;
}

export interface WalletActivityInput {
  walletAddress: string;
  funderWallet: string | null;
  observationStartMs: number;
  observationEndMs: number;
  /** Data source of the reconstruction (e.g. "synthetic-fixture", "polygonscan+clob"). */
  source: string;
  /** Supplier's assertion that the record set has no history gaps. Never assumed. */
  historyComplete: boolean;
  provenance: WalletClaimProvenance | null;
  /** Mark prices for open positions: tokenId -> Prob6. Missing marks become data gaps. */
  marks: Record<string, Prob6>;
  records: WalletActivityRecord[];
}

// ---------------------------------------------------------------------------
// Raw JSON schema (decimal strings, exact via parseFixed)
// ---------------------------------------------------------------------------

const usdc = z.string().transform((s, ctx) => {
  try {
    const v = parseFixed(s, 6);
    if (v < 0n) throw new Error("negative amount; direction comes from the record kind");
    return v;
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
    return z.NEVER;
  }
});
const shares = usdc; // same 1e6 scale, same non-negativity rule
const price = z.string().transform((s, ctx) => {
  try {
    const v = parseFixed(s, 6);
    if (v < 0n || v > ONE) throw new Error(`price ${s} outside [0,1]`);
    return v;
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
    return z.NEVER;
  }
});

const recordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("DEPOSIT"), tsMs: z.number().int(), amountUsdc: usdc }),
  z.object({ kind: z.literal("WITHDRAWAL"), tsMs: z.number().int(), amountUsdc: usdc }),
  z.object({
    kind: z.enum(["TRANSFER_IN", "TRANSFER_OUT"]), tsMs: z.number().int(), amountUsdc: usdc,
    counterparty: z.string().nullable().default(null), label: z.string().nullable().default(null),
  }),
  z.object({
    kind: z.literal("TRADE"), tsMs: z.number().int(), marketId: z.string(), tokenId: z.string(),
    side: z.enum(["BUY", "SELL"]), shares: shares, price: price, feeUsdc: usdc,
    role: z.enum(["MAKER", "TAKER"]).nullable().default(null),
  }),
  z.object({
    kind: z.enum(["SPLIT", "MERGE"]), tsMs: z.number().int(), marketId: z.string(),
    amountUsdc: usdc, yesTokenId: z.string(), noTokenId: z.string(),
  }),
  z.object({
    kind: z.literal("REDEEM"), tsMs: z.number().int(), marketId: z.string(), tokenId: z.string(),
    shares: shares, payoutUsdc: usdc,
  }),
  z.object({
    kind: z.literal("REWARD_PAID"), tsMs: z.number().int(),
    program: z.string().default("LIQUIDITY_REWARD"), epochKey: z.string().nullable().default(null), amountUsdc: usdc,
  }),
  z.object({ kind: z.literal("REBATE_PAID"), tsMs: z.number().int(), epochKey: z.string().nullable().default(null), amountUsdc: usdc }),
]);

const inputSchema = z.object({
  walletAddress: z.string().min(1),
  funderWallet: z.string().nullable().default(null),
  observationStartMs: z.number().int(),
  observationEndMs: z.number().int(),
  source: z.string().min(1),
  historyComplete: z.boolean().default(false),
  provenance: z.object({
    claimText: z.string(), claimSource: z.string(), retrievedAtMs: z.number().int().nullable().default(null),
  }).nullable().default(null),
  marks: z.record(price).default({}),
  records: z.array(recordSchema),
});

/** Parse a raw activity document (decimal strings) into exact bigint micro-units. Throws on invalid input. */
export function parseWalletActivityJson(raw: unknown): WalletActivityInput {
  const p = inputSchema.parse(raw);
  const records: WalletActivityRecord[] = p.records.map((r) => {
    switch (r.kind) {
      case "DEPOSIT":
      case "WITHDRAWAL":
        return { kind: r.kind, tsMs: r.tsMs, amount6: r.amountUsdc };
      case "TRANSFER_IN":
      case "TRANSFER_OUT":
        return { kind: r.kind, tsMs: r.tsMs, amount6: r.amountUsdc, counterparty: r.counterparty, label: r.label };
      case "TRADE":
        return {
          kind: "TRADE", tsMs: r.tsMs, marketId: r.marketId, tokenId: r.tokenId,
          side: r.side, shares6: r.shares, price6: r.price, fee6: r.feeUsdc, role: r.role,
        };
      case "SPLIT":
      case "MERGE":
        return { kind: r.kind, tsMs: r.tsMs, marketId: r.marketId, amount6: r.amountUsdc, yesTokenId: r.yesTokenId, noTokenId: r.noTokenId };
      case "REDEEM":
        return { kind: "REDEEM", tsMs: r.tsMs, marketId: r.marketId, tokenId: r.tokenId, shares6: r.shares, payout6: r.payoutUsdc };
      case "REWARD_PAID":
        return { kind: "REWARD_PAID", tsMs: r.tsMs, program: r.program, epochKey: r.epochKey, amount6: r.amountUsdc };
      case "REBATE_PAID":
        return { kind: "REBATE_PAID", tsMs: r.tsMs, epochKey: r.epochKey, amount6: r.amountUsdc };
    }
  });
  return {
    walletAddress: p.walletAddress,
    funderWallet: p.funderWallet,
    observationStartMs: p.observationStartMs,
    observationEndMs: p.observationEndMs,
    source: p.source,
    historyComplete: p.historyComplete,
    provenance: p.provenance,
    marks: p.marks,
    records,
  };
}

// ---------------------------------------------------------------------------
// Content-addressed snapshot id
// ---------------------------------------------------------------------------

/** Same wallet + window + records + marks + versions => same id => idempotent persistence. */
export function walletSnapshotId(input: WalletActivityInput, configVersion: number): string {
  const hash = sha256OfCanonicalJson({
    v: WALLET_ANALYSIS_VERSION,
    walletAddress: input.walletAddress,
    observationStartMs: input.observationStartMs,
    observationEndMs: input.observationEndMs,
    records: input.records,
    marks: input.marks,
    configVersion,
  });
  return `wrs-${hash.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  nowMs: number;
  configVersion: number;
}

export interface WalletAnalysis {
  snapshot: WalletResearchSnapshot;
  /** Naive flow-accounting "profit" a leaderboard observer would report; null when marks are missing. */
  naiveApparentProfit6: Usdc6 | null;
  /** Honest components (exact bigint identity with naiveApparentProfit6 when computable). */
  tradingPnl6: Usdc6;
  feesPaid6: Usdc6;
  incentiveIncome6: Usdc6;
  unrealizedAtMark6: Usdc6 | null;
  unlabeledTransferNet6: Usdc6;
  cashDelta6: Usdc6;
}

interface Position { shares6: Shares6; basis6: Usdc6 }

/** Remove `sold` shares from a position at average cost; exact residual accounting (removed+remaining == prior basis). */
function removeAtAverageCost(pos: Position, sold: Shares6): Usdc6 {
  if (sold <= 0n || pos.shares6 <= 0n) return 0n;
  const removed = sold >= pos.shares6 ? pos.basis6 : mulDiv(pos.basis6, sold, pos.shares6, "floor");
  pos.basis6 -= removed;
  pos.shares6 -= sold > pos.shares6 ? pos.shares6 : sold;
  return removed;
}

export function analyzeWallet(input: WalletActivityInput, opts: AnalyzeOptions): WalletAnalysis {
  // Deterministic order: timestamp, then original index for ties.
  const ordered = input.records
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.tsMs - b.r.tsMs) || (a.i - b.i))
    .map((x) => x.r);

  const positions = new Map<string, Position>();
  const pos = (tokenId: string): Position => {
    let p = positions.get(tokenId);
    if (!p) { p = { shares6: 0n, basis6: 0n }; positions.set(tokenId, p); }
    return p;
  };

  let deposits6 = 0n, withdrawals6 = 0n, transfersIn6 = 0n, transfersOut6 = 0n;
  let tradingPnl6 = 0n, feesPaid6 = 0n, rewardsPaid6 = 0n, rebatesPaid6 = 0n;
  let unlabeledTransferNet6 = 0n, cashDelta6 = 0n;
  let tradesCount = 0, splitsCount = 0, mergesCount = 0, redeemsCount = 0, transfersCount = 0;

  const unlabeledTransfers: Array<Record<string, unknown>> = [];
  const unknownCounterparties: Array<Record<string, unknown>> = [];
  const positionUnderflows: Array<Record<string, unknown>> = [];
  const outOfWindowRecords: Array<Record<string, unknown>> = [];

  for (const r of ordered) {
    if (r.tsMs < input.observationStartMs || r.tsMs > input.observationEndMs) {
      // Processed anyway (dropping would fabricate a cleaner wallet), but the gap is recorded.
      outOfWindowRecords.push({ kind: r.kind, tsMs: r.tsMs });
    }
    switch (r.kind) {
      case "DEPOSIT":
        transfersCount++; deposits6 += r.amount6; cashDelta6 += r.amount6;
        break;
      case "WITHDRAWAL":
        transfersCount++; withdrawals6 += r.amount6; cashDelta6 -= r.amount6;
        break;
      case "TRANSFER_IN":
      case "TRANSFER_OUT": {
        transfersCount++;
        const signed = r.kind === "TRANSFER_IN" ? r.amount6 : -r.amount6;
        cashDelta6 += signed;
        if (r.kind === "TRANSFER_IN") transfersIn6 += r.amount6; else transfersOut6 += r.amount6;
        if (r.label === null) {
          unlabeledTransferNet6 += signed;
          unlabeledTransfers.push({ tsMs: r.tsMs, direction: r.kind === "TRANSFER_IN" ? "IN" : "OUT", amount6: r.amount6.toString(), counterparty: r.counterparty });
        }
        if (r.counterparty === null) {
          unknownCounterparties.push({ tsMs: r.tsMs, kind: r.kind, amount6: r.amount6.toString() });
        }
        break;
      }
      case "TRADE": {
        tradesCount++;
        const notional6 = mulDiv(r.shares6, r.price6, ONE, "floor");
        feesPaid6 += r.fee6;
        tradingPnl6 -= r.fee6; // fees are a trading cost the moment they are paid
        if (r.side === "BUY") {
          const p = pos(r.tokenId);
          p.shares6 += r.shares6; p.basis6 += notional6;
          cashDelta6 -= notional6 + r.fee6;
        } else {
          const p = pos(r.tokenId);
          if (r.shares6 > p.shares6) {
            positionUnderflows.push({ tokenId: r.tokenId, tsMs: r.tsMs, missingShares6: (r.shares6 - p.shares6).toString(), op: "TRADE_SELL" });
          }
          const removed = removeAtAverageCost(p, r.shares6);
          tradingPnl6 += notional6 - removed;
          cashDelta6 += notional6 - r.fee6;
        }
        break;
      }
      case "SPLIT": {
        splitsCount++;
        cashDelta6 -= r.amount6;
        // amount6 micro-USDC mints amount6 micro-shares of each leg; cost split exactly across legs.
        const yesBasis = r.amount6 / 2n;
        const yes = pos(r.yesTokenId); yes.shares6 += r.amount6; yes.basis6 += yesBasis;
        const no = pos(r.noTokenId); no.shares6 += r.amount6; no.basis6 += r.amount6 - yesBasis;
        break;
      }
      case "MERGE": {
        mergesCount++;
        cashDelta6 += r.amount6;
        let removed = 0n;
        for (const tokenId of [r.yesTokenId, r.noTokenId]) {
          const p = pos(tokenId);
          if (r.amount6 > p.shares6) {
            positionUnderflows.push({ tokenId, tsMs: r.tsMs, missingShares6: (r.amount6 - p.shares6).toString(), op: "MERGE" });
          }
          removed += removeAtAverageCost(p, r.amount6);
        }
        tradingPnl6 += r.amount6 - removed; // CTF round trips are P&L-neutral by construction
        break;
      }
      case "REDEEM": {
        redeemsCount++;
        cashDelta6 += r.payout6;
        const p = pos(r.tokenId);
        if (r.shares6 > p.shares6) {
          positionUnderflows.push({ tokenId: r.tokenId, tsMs: r.tsMs, missingShares6: (r.shares6 - p.shares6).toString(), op: "REDEEM" });
        }
        const removed = removeAtAverageCost(p, r.shares6);
        tradingPnl6 += r.payout6 - removed;
        break;
      }
      case "REWARD_PAID":
        // PAID incentive income — kept strictly OUT of tradingPnl6.
        rewardsPaid6 += r.amount6; cashDelta6 += r.amount6;
        break;
      case "REBATE_PAID":
        rebatesPaid6 += r.amount6; cashDelta6 += r.amount6;
        break;
    }
  }

  // ---- open inventory at mark --------------------------------------------
  let inventoryCostBasis6 = 0n;
  let openPositionsValue6: Usdc6 | null = 0n;
  const missingPriceMarks: Array<Record<string, unknown>> = [];
  const sortedOpen = [...positions.entries()].filter(([, p]) => p.shares6 > 0n).sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [tokenId, p] of sortedOpen) {
    inventoryCostBasis6 += p.basis6;
    const mark = input.marks[tokenId];
    if (mark === undefined) {
      missingPriceMarks.push({ tokenId, shares6: p.shares6.toString(), basis6: p.basis6.toString() });
      openPositionsValue6 = null;
    } else if (openPositionsValue6 !== null) {
      openPositionsValue6 += mulDiv(p.shares6, mark, ONE, "floor");
    }
  }
  const unrealizedAtMark6 = openPositionsValue6 === null ? null : openPositionsValue6 - inventoryCostBasis6;

  // ---- naive vs honest ----------------------------------------------------
  const incentiveIncome6 = rewardsPaid6 + rebatesPaid6;
  // Naive observer: cash delta + inventory at mark - flows they can SEE are external
  // (labeled deposits/withdrawals/transfers). Unlabeled transfers stay inside and
  // inflate apparent profit. Exact identity, asserted in tests:
  //   naive == tradingPnl6 + incentiveIncome6 + unrealizedAtMark6 + unlabeledTransferNet6
  const naiveApparentProfit6 = unrealizedAtMark6 === null
    ? null
    : tradingPnl6 + incentiveIncome6 + unrealizedAtMark6 + unlabeledTransferNet6;

  // ---- data gaps: explicit, never silently dropped ------------------------
  const gaps: Record<string, unknown> = {};
  if (missingPriceMarks.length > 0) gaps.missingPriceMarks = missingPriceMarks;
  if (unlabeledTransfers.length > 0) gaps.unlabeledTransfers = unlabeledTransfers;
  if (unknownCounterparties.length > 0) gaps.unknownCounterparties = unknownCounterparties;
  if (positionUnderflows.length > 0) gaps.positionUnderflows = positionUnderflows;
  if (outOfWindowRecords.length > 0) gaps.outOfWindowRecords = outOfWindowRecords;
  if (!input.historyComplete) gaps.historyCompletenessUnasserted = "supplier did not assert a gap-free record set";
  const hasGaps = Object.keys(gaps).length > 0;

  // Blocking gaps break the reconstruction itself -> DATA_GATED. Otherwise the
  // snapshot is an observation of an unverified public claim, never a verification.
  const blocked = missingPriceMarks.length > 0 || positionUnderflows.length > 0;
  const evidenceLabel: EvidenceLabel = blocked ? "DATA_GATED" : "SOURCE_CLAIM_UNVERIFIED";

  const s = (v: bigint | null): string | null => (v === null ? null : v.toString());
  const snapshot: WalletResearchSnapshot = {
    id: walletSnapshotId(input, opts.configVersion),
    correlationId: newId(),
    walletAddress: input.walletAddress,
    funderWallet: input.funderWallet,
    observationStartMs: input.observationStartMs,
    observationEndMs: input.observationEndMs,
    completeInterval: input.historyComplete && !hasGaps,
    tradesCount, splitsCount, mergesCount, redeemsCount, transfersCount,
    deposits6, withdrawals6, transfersIn6, transfersOut6,
    tradingPnl6,
    rebatesPaid6, rewardsPaid6,
    openPositionsValue6,
    inventoryCostBasis6,
    timeWeightedCapital6: null, // not computed by v1; never estimated
    attribution: {
      analysisVersion: WALLET_ANALYSIS_VERSION,
      identity: "naiveApparentProfit6 = tradingPnl6 + incentiveIncome6 + unrealizedAtMark6 + unlabeledTransferNet6",
      naiveApparentProfit6: s(naiveApparentProfit6),
      tradingPnl6: s(tradingPnl6),
      feesPaid6: s(feesPaid6),
      incentiveIncome6: s(incentiveIncome6),
      rewardsPaid6: s(rewardsPaid6),
      rebatesPaid6: s(rebatesPaid6),
      unrealizedAtMark6: s(unrealizedAtMark6),
      unlabeledTransferNet6: s(unlabeledTransferNet6),
      cashDelta6: s(cashDelta6),
      ...(input.provenance ? { claimProvenance: { ...input.provenance } } : {}),
    },
    dataGaps: hasGaps ? gaps : null,
    evidenceLabel,
    source: input.source,
    capturedAtMs: opts.nowMs,
    configVersion: opts.configVersion,
  };

  return {
    snapshot,
    naiveApparentProfit6,
    tradingPnl6,
    feesPaid6,
    incentiveIncome6,
    unrealizedAtMark6,
    unlabeledTransferNet6,
    cashDelta6,
  };
}
