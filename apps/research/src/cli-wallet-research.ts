import { makeDb } from "@b5p/db";
import { fmtUsdc } from "@b5p/domain";
import { readFileSync } from "node:fs";
import path from "node:path";

import { workspaceRoot } from "./repro/common";
import { analyzeWallet, parseWalletActivityJson, type WalletAnalysis } from "./wallet-research";
import { persistWalletResearchSnapshot } from "./wallet-research-persist";

/**
 * CLI: R12 wallet-research pipeline — RESEARCH ONLY. Reads a wallet activity
 * JSON document (never the network: any fetcher must write such a file first),
 * runs the honest reconstruction, persists the snapshot idempotently, prints
 * the naive-vs-honest breakdown.
 *
 *   pnpm --filter @b5p/research wallet-research -- <activity.json>
 *   pnpm --filter @b5p/research wallet-research -- --fixture           # committed synthetic fixture 1
 *   pnpm --filter @b5p/research wallet-research -- --fixture=genuine   # contrast fixture
 *   pnpm --filter @b5p/research wallet-research -- --no-persist
 */

const FIXTURES: Record<string, string> = {
  default: "wallet-synthetic.json",
  genuine: "wallet-synthetic-genuine.json",
};

function parseArgs(argv: string[]) {
  const args = { file: null as string | null, fixture: null as string | null, persist: true, configVersion: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue; // pnpm run forwards the separator
    if (a === "--fixture") args.fixture = "default";
    else if (a.startsWith("--fixture=")) args.fixture = a.slice(10);
    else if (a === "--no-persist") args.persist = false;
    else if (a === "--config-version") args.configVersion = Number(argv[++i]);
    else if (a.startsWith("--config-version=")) args.configVersion = Number(a.slice(17));
    else if (!a.startsWith("--")) args.file = a;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
let filePath: string;
if (args.fixture) {
  const name = FIXTURES[args.fixture];
  if (!name) {
    console.error(`unknown fixture "${args.fixture}" (known: ${Object.keys(FIXTURES).join(", ")})`);
    process.exit(2);
  }
  filePath = path.join(workspaceRoot(), "apps", "research", "fixtures", name);
} else if (args.file) {
  filePath = path.resolve(args.file);
} else {
  console.error("usage: wallet-research (<activity.json> | --fixture[=genuine]) [--no-persist] [--config-version N]");
  process.exit(2);
}

const input = parseWalletActivityJson(JSON.parse(readFileSync(filePath, "utf8")));
const a: WalletAnalysis = analyzeWallet(input, { nowMs: Date.now(), configVersion: args.configVersion });
const snap = a.snapshot;

const usd = (v: bigint | null): string => (v === null ? "n/a (data-gated)" : `${v < 0n ? "" : "+"}${fmtUsdc(v)} USDC`);

console.log("[wallet-research] RESEARCH ONLY — observes public claims, does not verify them");
console.log(`  input:    ${filePath}`);
console.log(`  wallet:   ${snap.walletAddress} (source: ${snap.source})`);
console.log(`  window:   ${new Date(snap.observationStartMs).toISOString()} .. ${new Date(snap.observationEndMs).toISOString()}`);
console.log(`  activity: ${snap.tradesCount} trades, ${snap.splitsCount} splits, ${snap.mergesCount} merges, ${snap.redeemsCount} redeems, ${snap.transfersCount} flow records`);
console.log(`  flows:    deposits ${usd(snap.deposits6)}  withdrawals ${usd(snap.withdrawals6)}  transfers in ${usd(snap.transfersIn6)} / out ${usd(snap.transfersOut6)}`);
console.log("  --- naive vs honest ---");
console.log(`  naive apparent profit:      ${usd(a.naiveApparentProfit6)}   <- what a leaderboard shows`);
console.log(`  trading P&L (fees incl.):   ${usd(a.tradingPnl6)}   (fees paid ${fmtUsdc(a.feesPaid6)} USDC)`);
console.log(`  paid incentives:            ${usd(a.incentiveIncome6)}   (rewards ${usd(snap.rewardsPaid6)}, rebates ${usd(snap.rebatesPaid6)}) — NOT trading P&L`);
console.log(`  unrealized at mark:         ${usd(a.unrealizedAtMark6)}   (inventory value ${usd(snap.openPositionsValue6)}, cost basis ${usd(snap.inventoryCostBasis6)})`);
console.log(`  unlabeled transfer net:     ${usd(a.unlabeledTransferNet6)}   <- indistinguishable from winnings to a naive observer`);
console.log("  -----------------------");
console.log(`  evidence label:  ${snap.evidenceLabel}`);
console.log(`  complete interval: ${snap.completeInterval}`);
if (snap.dataGaps) {
  console.log(`  data gaps: ${Object.keys(snap.dataGaps).join(", ")}`);
  console.log(`             ${JSON.stringify(snap.dataGaps)}`);
} else {
  console.log("  data gaps: none");
}

if (args.persist) {
  const handle = await makeDb();
  try {
    await handle.migrate();
    const { id } = await persistWalletResearchSnapshot(handle, snap);
    console.log(`  persisted: ${id} (content-addressed; re-runs upsert the same row)`);
  } finally {
    await handle.close();
  }
} else {
  console.log(`  snapshot id (not persisted): ${snap.id}`);
}
