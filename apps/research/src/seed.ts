import {
  auditEvents, configVersions, decisionSnapshots, engineKv, markets, orderFills,
  orderIntents, orders, pnlRecords, positions, resolutions, timingBucketStatistics, type DbHandle,
} from "@b5p/db";
import { DEFAULT_CONFIG } from "@b5p/config";
import { wilsonInterval } from "@b5p/domain";
import { eq } from "drizzle-orm";

/**
 * Seeds:
 *  1. The specification's empirical minute-of-hour findings (30-day + 7-day),
 *     labeled source "seed" so the Timing Lab renders them before any live
 *     backfill exists. The :45 anomaly is explicitly labeled unconfirmed.
 *  2. The 95-cent late-favorite tutorial case — a WINNING trade that was a
 *     bad decision — as a complete decision->order->fill->resolution chain.
 *  3. A default active config version (if none).
 */

const SEED_RUN_ID = "00000000-0000-4000-8000-00000000feed";

const THIRTY_DAY_TABLE: Array<[string, number, number, number]> = [
  // bucket, N, upRate, medianAbsMoveBps
  ["00", 720, 0.5000, 3.45],
  ["05", 719, 0.4687, 5.63],
  ["10", 719, 0.4937, 4.97],
  ["15", 720, 0.5028, 4.74],
  ["20", 720, 0.4764, 5.55],
  ["25", 720, 0.5222, 5.69],
  ["30", 719, 0.5132, 4.25],
  ["35", 720, 0.5014, 5.70],
  ["40", 720, 0.4792, 4.91],
  ["45", 720, 0.5403, 4.70],
  ["50", 720, 0.5153, 4.48],
  ["55", 720, 0.4986, 4.73],
];

export async function seedAll(db: DbHandle): Promise<void> {
  const nowMs = Date.now();

  // --- 1. config bootstrap
  const cfgRows = await db.db.select().from(configVersions).where(eq(configVersions.active, true));
  if (cfgRows.length === 0) {
    await db.db.insert(configVersions).values({
      config: DEFAULT_CONFIG, actor: "seed", active: true, changedPaths: [], createdAtMs: nowMs,
    });
  }

  // --- 2. timing lab seed rows (30-day)
  const existing = await db.db.select().from(timingBucketStatistics).where(eq(timingBucketStatistics.runId, SEED_RUN_ID));
  if (existing.length === 0) {
    const pRawByBucket: Record<string, number | null> = { "45": 0.0276 };
    for (const [bucket, n, rate, med] of THIRTY_DAY_TABLE) {
      const up = Math.round(n * rate);
      const w = wilsonInterval(up, n);
      await db.db.insert(timingBucketStatistics).values({
        id: `${SEED_RUN_ID.slice(0, -2)}${bucket}`,
        runId: SEED_RUN_ID,
        source: "seed",
        windowDays: 30,
        bucket,
        n,
        up,
        upRate: rate,
        wilsonLo: w.lo,
        wilsonHi: w.hi,
        pRaw: pRawByBucket[bucket] ?? null,
        pBonferroni: pRawByBucket[bucket] != null ? Math.min(1, pRawByBucket[bucket]! * 12) : null,
        pBh: null,
        medianAbsMoveBps: med,
        meanAbsMoveBps: null,
        p90AbsMoveBps: null,
        medianVolume: null,
        meta: {
          note: "Seeded from the specification's 30-day analysis (2026-06-30..2026-07-30, 8637 markets). The :45 bucket is NOT significant after Bonferroni (p≈0.332).",
          globalChi2: { chi2: 13.05, df: 11, p: 0.289 },
          quarterVsOther: { z: 1.72, p: 0.0855 },
        },
        computedAtMs: nowMs,
      });
    }
    const extras: Array<[string, number, number, number | null, number | null, Record<string, unknown>]> = [
      ["quarter", 2879, 0.5141, 4.25, 0.0855, { meanAbsMoveBps: 6.44, p90AbsMoveBps: 14.48, medianVolume: 71_600, rankTestP: 6.6e-11 }],
      ["other", 5758, 0.4944, 5.18, 0.0855, { meanAbsMoveBps: 7.35, p90AbsMoveBps: 16.33, medianVolume: 74_900 }],
      ["all", 8637, 0.5010, 4.87, null, {}],
    ];
    for (const [bucket, n, rate, med, pRaw, meta] of extras) {
      const up = Math.round(n * rate);
      const w = wilsonInterval(up, n);
      await db.db.insert(timingBucketStatistics).values({
        id: `${SEED_RUN_ID.slice(0, -4)}30${bucket.slice(0, 2)}`,
        runId: SEED_RUN_ID, source: "seed", windowDays: 30, bucket, n, up, upRate: rate,
        wilsonLo: w.lo, wilsonHi: w.hi, pRaw, pBonferroni: null, pBh: null,
        medianAbsMoveBps: med,
        meanAbsMoveBps: (meta.meanAbsMoveBps as number) ?? null,
        p90AbsMoveBps: (meta.p90AbsMoveBps as number) ?? null,
        medianVolume: (meta.medianVolume as number) ?? null,
        meta, computedAtMs: nowMs,
      });
    }
    // 7-day partial view (spec): the :45 run is a monitoring candidate, not a signal
    const seven: Array<[string, number, number, number | null]> = [
      ["all", 2016, 0.4985, null],
      ["quarter", 672, 0.5283, 0.0587],
      ["other", 1344, 0.4836, 0.0587],
      ["15", 168, 0.4940, null],
      ["45", 168, 0.5893, 0.014],
    ];
    for (const [bucket, n, rate, pRaw] of seven) {
      const up = Math.round(n * rate);
      const w = wilsonInterval(up, n);
      await db.db.insert(timingBucketStatistics).values({
        id: `${SEED_RUN_ID.slice(0, -4)}07${bucket.slice(0, 2)}`,
        runId: SEED_RUN_ID, source: "seed", windowDays: 7, bucket, n, up, upRate: rate,
        wilsonLo: w.lo, wilsonHi: w.hi, pRaw,
        pBonferroni: bucket === "45" ? 0.168 : null, pBh: null,
        medianAbsMoveBps: null, meanAbsMoveBps: null, p90AbsMoveBps: null, medianVolume: null,
        meta: { note: bucket === "45" ? "UNCONFIRMED / likely selection-sensitive. Monitoring candidate only." : "seeded 7-day view", globalP: 0.489 },
        computedAtMs: nowMs,
      });
    }
  }

  // --- 3. the 95-cent tutorial case
  await seedTutorial(db, nowMs);
}

const T = {
  market: "seed-tutorial-market",
  decision: "00000000-0000-4000-8000-0000000000d1",
  intent: "00000000-0000-4000-8000-0000000000i1".replace("i", "a"),
  order: "00000000-0000-4000-8000-0000000000o1".replace("o", "b"),
  fill: "00000000-0000-4000-8000-0000000000f1",
  position: "00000000-0000-4000-8000-0000000000c1",
  resolution: "00000000-0000-4000-8000-0000000000e1",
};

async function seedTutorial(db: DbHandle, nowMs: number): Promise<void> {
  const found = await db.db.select().from(markets).where(eq(markets.id, T.market));
  if (found.length > 0) return;

  // a deterministic past market window (2026-07-29 14:35:00 UTC)
  const startEpoch = 1785335700;
  const endEpoch = startEpoch + 300;
  await db.db.insert(markets).values({
    id: T.market,
    eventId: "seed-tutorial-event",
    conditionId: "0xseedtutorial",
    slug: `btc-updown-5m-${startEpoch}`,
    question: "TUTORIAL: Bitcoin Up or Down (seeded example)",
    upTokenId: "seed-up-token",
    downTokenId: "seed-down-token",
    startEpoch,
    endEpoch,
    rulesText: "Seeded tutorial market. Resolves Up if the final Chainlink BTC/USD value is >= the starting value.",
    rulesHash: "seed",
    resolutionSource: "https://data.chain.link/streams/btc-usd",
    rulesNameChainlink: true,
    tickSize6: 10_000n,
    minOrderShares6: 5_000_000n,
    negRisk: false,
    status: "RECONCILED",
    outcome: "UP",
    priceToBeatText: "64180.55",
    priceToBeatSource: "seed",
    priceToBeatCapturedAtMs: startEpoch * 1000,
    discoveredAtMs: nowMs,
    updatedAtMs: nowMs,
  });

  const decisionData = {
    tutorial: true,
    title: "A winning trade that was a terrible decision",
    narrative: [
      "839 shares of UP bought as a taker at 0.95 with ~30 seconds remaining.",
      "Cost: 797.05 USDC. Taker fee at the live crypto schedule (7%, f*p*(1-p)): ~2.79 USDC.",
      "Effective break-even probability: ~95.33% — ABOVE the 95c price.",
      "Gross profit if it wins: 41.95 USDC before fees, ~39.16 after fees.",
      "One full loss erases ~19 identical gross wins — more after fees.",
      "It won. The outcome was good; the decision was bad. Outcome quality and decision quality are different things.",
    ],
    intent: { side: "UP", style: "taker_fok", price: "0.95", sharesRequested: "839", stake: "799.839675", maxLoss: "799.839675" },
    effectiveBreakEven: "0.953325",
    lossErasesWins: 19,
    mode: "paper",
  };
  await db.db.insert(decisionSnapshots).values({
    decisionId: T.decision,
    marketId: T.market,
    mode: "paper",
    correlationId: "tutorial",
    data: decisionData,
    createdAtMs: (endEpoch - 30) * 1000,
  });
  await db.db.insert(orderIntents).values({
    id: T.intent, decisionId: T.decision, version: 1, idempotencyKey: "seed-tutorial-idem",
    payload: { tutorial: true }, createdAtMs: (endEpoch - 30) * 1000,
  });
  await db.db.insert(orders).values({
    id: T.order, intentId: T.intent, decisionId: T.decision, marketId: T.market,
    tokenId: "seed-up-token", outcomeSide: "UP", orderSide: "BUY", style: "taker_fok",
    timeInForce: "FOK", postOnly: false,
    price6: 950_000n, shares6: 839_000_000n, filledShares6: 839_000_000n,
    stake6: 799_839_675n, mode: "paper", status: "MATCHED",
    statusReason: "tutorial seed", createdAtMs: (endEpoch - 30) * 1000, updatedAtMs: (endEpoch - 29) * 1000,
  });
  await db.db.insert(orderFills).values({
    id: T.fill, orderId: T.order, price6: 950_000n, shares6: 839_000_000n,
    feeUsdc6: 2_789_675n, maker: false, tsMs: (endEpoch - 29) * 1000,
  });
  await db.db.insert(positions).values({
    id: T.position, marketId: T.market, decisionId: T.decision, mode: "paper",
    outcomeSide: "UP", shares6: 839_000_000n, avgPrice6: 950_000n,
    cost6: 797_050_000n, stake6: 799_839_675n, exitPolicy: "hold_to_resolution",
    status: "RESOLVED", outcome: "UP", pnl6: 39_160_325n,
    openedAtMs: (endEpoch - 29) * 1000, resolvedAtMs: endEpoch * 1000,
  });
  await db.db.insert(resolutions).values({
    id: T.resolution, marketId: T.market, outcome: "UP",
    priceToBeatText: "64180.55", finalValueText: "64201.12", officialOutcome: "UP",
    mismatch: false, source: "seed", resolvedAtMs: endEpoch * 1000,
  });
  await db.db.insert(pnlRecords).values({
    id: T.decision.replace("d1", "91"), mode: "paper", marketId: T.market, positionId: T.position,
    gross6: 41_950_000n, fees6: 2_789_675n, rebates6: 0n, net6: 39_160_325n,
    meta: { tutorial: true }, createdAtMs: endEpoch * 1000,
  });
  await db.db.insert(engineKv).values({
    key: "tutorial_95c",
    value: decisionData,
    updatedAtMs: nowMs,
  }).onConflictDoNothing();
  await db.db.insert(auditEvents).values({
    category: "seed", action: "tutorial_seeded", actor: "seed", correlationId: "tutorial",
    data: { decisionId: T.decision }, createdAtMs: nowMs,
  });
}
