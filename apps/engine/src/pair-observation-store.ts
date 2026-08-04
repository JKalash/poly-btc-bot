import { schema, type DbHandle } from "@b5p/db";
import {
  canonicalJsonValue,
  canonicalObjectHash,
  pairObservationId,
  type PairBookCapture,
  type PairObservationId,
  type PairRejectionCode,
  type PairTokenTerms,
} from "@b5p/pair-execution";
import { and, eq, isNull, sql } from "drizzle-orm";

export type PairEpisodeState = "GROSS_DISLOCATION" | "NET_ELIGIBLE" | "PAPER_SCHEDULED" | "ACTIVATION_SURVIVED" | "ACTIVATION_FAILED";
export type PairCaptureKind = "SIGNAL" | "ACTIVATION_PARALLEL" | "ACTIVATION_FIRST_LEG" | "ACTIVATION_SECOND_LEG" | "RECOVERY_EVALUATION" | "SETTLEMENT_EVALUATION" | "RECONCILIATION_OBSERVATION" | "REPLAY_COUNTERFACTUAL";

export interface PersistPairCaptureInput {
  readonly capture: PairBookCapture;
  readonly captureKind: PairCaptureKind;
  readonly dataCutoffEventId?: bigint | null;
  readonly dataCutoffEnvelopeId?: string | null;
  readonly upTerms: PairTokenTerms;
  readonly downTerms: PairTokenTerms;
  readonly createdAtMs: number;
}

export interface PairFunnelIncrement {
  readonly completeEnvelopes: boolean;
  readonly validSynchronizedCaptures: boolean;
  readonly evaluatedCaptures: boolean;
  readonly prefilterCaptures: boolean;
  readonly grossDislocations: boolean;
  readonly fullDepthExecutable: boolean;
  readonly feePositive: boolean;
  readonly stressPositive: boolean;
}

export interface RecordPairEvaluationInput {
  readonly marketId: string;
  readonly conditionId: string;
  readonly strategyVersion: string;
  readonly mode: "observe" | "paper";
  readonly triggerKind: "CLOB_ENVELOPE" | "FALLBACK_TIMER" | "REPLAY_EVENT";
  readonly triggerId: string;
  readonly capture: PairBookCapture;
  readonly upTerms: PairTokenTerms;
  readonly downTerms: PairTokenTerms;
  readonly policyHash: string;
  readonly observerOperationalHash: string;
  readonly configVersion: number;
  readonly requestedCashCap6: bigint;
  readonly observedAtMs: number;
  readonly episodeState: PairEpisodeState | null;
  readonly episodeCooloffMs: number;
  readonly negativeControlSamplePpm: bigint;
  readonly minimumAskSum6: bigint | null;
  readonly selectedPairShares6: bigint | null;
  readonly grossTopOfBookEdge6: bigint | null;
  readonly grossWalkEdge6: bigint | null;
  readonly netPreLatencyPnl6: bigint | null;
  readonly netPreLatencyEdgePpm: bigint | null;
  readonly oneTickWorsePnl6: bigint | null;
  readonly twoTicksWorsePnl6: bigint | null;
  readonly worstCaseResidualLoss6: bigint | null;
  readonly operationalRiskHaircut6: bigint | null;
  readonly rejectionCodes: readonly PairRejectionCode[];
  readonly captureSummary: unknown;
  readonly quote: unknown | null;
  readonly decision: unknown;
  readonly depthStress: unknown | null;
  readonly funnel: PairFunnelIncrement;
}

export type RecordPairEvaluationResult =
  | { readonly kind: "INSERTED"; readonly observationId: PairObservationId; readonly episodeId: string | null }
  | { readonly kind: "SAMPLED_OUT"; readonly episodeId: string | null }
  | { readonly kind: "DUPLICATE"; readonly observationId: string; readonly episodeId: string | null };

const BUCKET_WIDTH_MS = 60_000;

export function shouldPersistNegativeControl(input: {
  readonly strategyVersion: string; readonly policyHash: string; readonly marketId: string;
  readonly triggerId: string; readonly captureHash: string; readonly thresholdPpm: bigint;
}): boolean {
  if (input.thresholdPpm <= 0n) return false;
  if (input.thresholdPpm >= 1_000_000n) return true;
  const hash = canonicalObjectHash({ strategyVersion: input.strategyVersion, policyHash: input.policyHash, marketId: input.marketId, envelopeId: input.triggerId, captureHash: input.captureHash });
  const sample = BigInt(`0x${hash.slice(0, 16)}`) % 1_000_000n;
  return sample < input.thresholdPpm;
}

export class PairObservationStore {
  constructor(private readonly handle: DbHandle) {}

  async persistCapture(input: PersistPairCaptureInput): Promise<string> {
    const c = input.capture;
    const upLocalHash = canonicalObjectHash(c.up);
    const downLocalHash = canonicalObjectHash(c.down);
    const levels = (leg: typeof c.up) => canonicalJsonValue({ bids: leg.bids, asks: leg.asks });
    const { captureId: _captureId, ...capturePayload } = c;
    const canonicalPayload = canonicalJsonValue(capturePayload);
    await this.handle.db.insert(schema.pairBookCaptures).values({
      id: c.captureId, marketId: c.marketId, conditionId: c.conditionId, captureKind: input.captureKind,
      capturedAtMs: c.capturedAtMs, dataCutoffEventId: input.dataCutoffEventId ?? null,
      dataCutoffEnvelopeId: input.dataCutoffEnvelopeId ?? null, captureSequence: c.captureSequence,
      upTokenId: c.up.tokenId, upBookVersion: c.up.bookVersion, upConnectionEpoch: c.up.connectionEpoch,
      upIntegrity: c.up.integrity, upSourceTsMs: c.up.sourceTsMs, upReceivedTsMs: c.up.receivedTsMs,
      upSourceEventId: c.up.sourceEventId || null, upExchangeHash: c.up.exchangeHash,
      upLocalHash, upLevelsJson: levels(c.up),
      downTokenId: c.down.tokenId, downBookVersion: c.down.bookVersion, downConnectionEpoch: c.down.connectionEpoch,
      downIntegrity: c.down.integrity, downSourceTsMs: c.down.sourceTsMs, downReceivedTsMs: c.down.receivedTsMs,
      downSourceEventId: c.down.sourceEventId || null, downExchangeHash: c.down.exchangeHash,
      downLocalHash, downLevelsJson: levels(c.down), sourceSkewMs: c.sourceSkewMs, receiveSkewMs: c.receiveSkewMs,
      upFeeSnapshotId: input.upTerms.fee.snapshotId, downFeeSnapshotId: input.downTerms.fee.snapshotId,
      upConstraintSnapshotId: input.upTerms.constraints.snapshotId, downConstraintSnapshotId: input.downTerms.constraints.snapshotId,
      canonicalPayload, captureHash: c.captureHash, createdAtMs: input.createdAtMs,
    }).onConflictDoNothing();
    return c.captureId;
  }

  async recordEvaluation(input: RecordPairEvaluationInput): Promise<RecordPairEvaluationResult> {
    return this.handle.db.transaction(async (tx) => {
      const duplicate = await tx.select({ id: schema.pairOpportunityObservations.id, episodeId: schema.pairOpportunityObservations.episodeId })
        .from(schema.pairOpportunityObservations).where(and(
          eq(schema.pairOpportunityObservations.strategyVersion, input.strategyVersion),
          eq(schema.pairOpportunityObservations.policyHash, input.policyHash),
          eq(schema.pairOpportunityObservations.mode, input.mode),
          eq(schema.pairOpportunityObservations.triggerKind, input.triggerKind),
          eq(schema.pairOpportunityObservations.triggerId, input.triggerId),
          eq(schema.pairOpportunityObservations.captureHash, input.capture.captureHash),
        )).limit(1);
      if (duplicate[0] !== undefined) return Object.freeze({ kind: "DUPLICATE" as const, observationId: duplicate[0].id, episodeId: duplicate[0].episodeId });

      const openRows = await tx.select().from(schema.pairOpportunityEpisodes).where(and(
        eq(schema.pairOpportunityEpisodes.marketId, input.marketId),
        eq(schema.pairOpportunityEpisodes.strategyVersion, input.strategyVersion),
        isNull(schema.pairOpportunityEpisodes.closedAtMs),
      )).limit(1);
      let open = openRows[0];
      let episodeId: string | null = open?.id ?? null;
      let stateChanged = false;
      if (input.episodeState === null) {
        if (open !== undefined && input.observedAtMs - open.lastObservedAtMs >= input.episodeCooloffMs) {
          await tx.update(schema.pairOpportunityEpisodes).set({ closedAtMs: input.observedAtMs, closeReason: "COOLOFF", state: "CLOSED", updatedAtMs: input.observedAtMs }).where(eq(schema.pairOpportunityEpisodes.id, open.id));
          episodeId = open.id;
          open = undefined;
          stateChanged = true;
        }
      } else if (open === undefined) {
        episodeId = `pepi_${canonicalObjectHash({ marketId: input.marketId, strategyVersion: input.strategyVersion, firstObservedAtMs: input.observedAtMs, triggerId: input.triggerId }).slice(0, 32)}`;
        await tx.insert(schema.pairOpportunityEpisodes).values({
          id: episodeId, marketId: input.marketId, strategyVersion: input.strategyVersion, state: input.episodeState,
          firstObservedAtMs: input.observedAtMs, lastObservedAtMs: input.observedAtMs,
          minimumAskSum6: input.minimumAskSum6, maximumSignalNetPnl6: input.netPreLatencyPnl6,
          maximumActivationNetPnl6: null, envelopeCount: 1n, eligibleEnvelopeCount: input.episodeState === "NET_ELIGIBLE" ? 1n : 0n,
          scheduledGroupCount: input.episodeState === "PAPER_SCHEDULED" ? 1 : 0,
          createdAtMs: input.observedAtMs, updatedAtMs: input.observedAtMs,
        });
        stateChanged = true;
      } else {
        stateChanged = open.state !== input.episodeState;
        const minAsk = input.minimumAskSum6 === null ? open.minimumAskSum6 : open.minimumAskSum6 === null ? input.minimumAskSum6 : input.minimumAskSum6 < open.minimumAskSum6 ? input.minimumAskSum6 : open.minimumAskSum6;
        const maxPnl = input.netPreLatencyPnl6 === null ? open.maximumSignalNetPnl6 : open.maximumSignalNetPnl6 === null ? input.netPreLatencyPnl6 : input.netPreLatencyPnl6 > open.maximumSignalNetPnl6 ? input.netPreLatencyPnl6 : open.maximumSignalNetPnl6;
        await tx.update(schema.pairOpportunityEpisodes).set({
          state: input.episodeState, lastObservedAtMs: input.observedAtMs, minimumAskSum6: minAsk,
          maximumSignalNetPnl6: maxPnl, envelopeCount: open.envelopeCount + 1n,
          eligibleEnvelopeCount: open.eligibleEnvelopeCount + (input.episodeState === "NET_ELIGIBLE" ? 1n : 0n),
          scheduledGroupCount: open.scheduledGroupCount + (input.episodeState === "PAPER_SCHEDULED" && open.state !== "PAPER_SCHEDULED" ? 1 : 0),
          updatedAtMs: input.observedAtMs,
        }).where(eq(schema.pairOpportunityEpisodes.id, open.id));
      }

      const sampledNegative = input.episodeState === null && shouldPersistNegativeControl({
        strategyVersion: input.strategyVersion, policyHash: input.policyHash, marketId: input.marketId,
        triggerId: input.triggerId, captureHash: input.capture.captureHash, thresholdPpm: input.negativeControlSamplePpm,
      });
      const shouldPersist = stateChanged || input.episodeState !== null || sampledNegative || input.rejectionCodes.length > 0;
      await this.incrementBucket(tx, input, sampledNegative);
      if (!shouldPersist) return Object.freeze({ kind: "SAMPLED_OUT" as const, episodeId });

      const observationId = pairObservationId({ strategyVersion: input.strategyVersion, policyHash: input.policyHash, mode: input.mode, triggerKind: input.triggerKind, triggerId: input.triggerId, captureHash: input.capture.captureHash });
      await tx.insert(schema.pairOpportunityObservations).values({
        id: observationId, episodeId, marketId: input.marketId, conditionId: input.conditionId,
        strategyVersion: input.strategyVersion, mode: input.mode,
        observationKind: input.episodeState ?? "SAMPLED_NEGATIVE_CONTROL", triggerKind: input.triggerKind,
        triggerId: input.triggerId, captureId: input.capture.captureId, captureHash: input.capture.captureHash,
        upFeeSnapshotId: input.upTerms.fee.snapshotId, downFeeSnapshotId: input.downTerms.fee.snapshotId,
        upConstraintSnapshotId: input.upTerms.constraints.snapshotId, downConstraintSnapshotId: input.downTerms.constraints.snapshotId,
        policyHash: input.policyHash, observerOperationalHash: input.observerOperationalHash, configVersion: input.configVersion,
        requestedCashCap6: input.requestedCashCap6, selectedPairShares6: input.selectedPairShares6,
        grossTopOfBookEdge6: input.grossTopOfBookEdge6, grossWalkEdge6: input.grossWalkEdge6,
        netPreLatencyPnl6: input.netPreLatencyPnl6, netPreLatencyEdgePpm: input.netPreLatencyEdgePpm,
        oneTickWorsePnl6: input.oneTickWorsePnl6, twoTicksWorsePnl6: input.twoTicksWorsePnl6,
        worstCaseResidualLoss6: input.worstCaseResidualLoss6, operationalRiskHaircut6: input.operationalRiskHaircut6,
        depthStressJson: input.depthStress === null ? null : canonicalJsonValue(input.depthStress),
        primaryRejectionCode: input.rejectionCodes[0] ?? null, rejectionCodes: [...input.rejectionCodes],
        captureSummaryJson: canonicalJsonValue(input.captureSummary), quoteJson: input.quote === null ? null : canonicalJsonValue(input.quote),
        decisionJson: canonicalJsonValue(input.decision), observedAtMs: input.observedAtMs, createdAtMs: input.observedAtMs,
      });
      return Object.freeze({ kind: "INSERTED" as const, observationId, episodeId });
    });
  }

  private async incrementBucket(
    tx: Parameters<Parameters<DbHandle["db"]["transaction"]>[0]>[0],
    input: RecordPairEvaluationInput,
    sampledNegative: boolean,
  ): Promise<void> {
    const bucketStartMs = Math.floor(input.observedAtMs / BUCKET_WIDTH_MS) * BUCKET_WIDTH_MS;
    const key = and(
      eq(schema.pairObserverBucketStats.bucketStartMs, bucketStartMs),
      eq(schema.pairObserverBucketStats.bucketWidthMs, BUCKET_WIDTH_MS),
      eq(schema.pairObserverBucketStats.strategyVersion, input.strategyVersion),
      eq(schema.pairObserverBucketStats.policyHash, input.policyHash),
      eq(schema.pairObserverBucketStats.marketId, input.marketId),
    );
    const existing = await tx.select().from(schema.pairObserverBucketStats).where(key).limit(1);
    const rejectionCounts = Object.fromEntries(input.rejectionCodes.map((code) => [code, 1]));
    if (existing[0] === undefined) {
      await tx.insert(schema.pairObserverBucketStats).values({
        bucketStartMs, bucketWidthMs: BUCKET_WIDTH_MS, strategyVersion: input.strategyVersion,
        policyHash: input.policyHash, marketId: input.marketId,
        completeEnvelopes: input.funnel.completeEnvelopes ? 1n : 0n,
        validSynchronizedCaptures: input.funnel.validSynchronizedCaptures ? 1n : 0n,
        evaluatedCaptures: input.funnel.evaluatedCaptures ? 1n : 0n,
        prefilterCaptures: input.funnel.prefilterCaptures ? 1n : 0n,
        grossDislocations: input.funnel.grossDislocations ? 1n : 0n,
        fullDepthExecutable: input.funnel.fullDepthExecutable ? 1n : 0n,
        feePositive: input.funnel.feePositive ? 1n : 0n,
        stressPositive: input.funnel.stressPositive ? 1n : 0n,
        sampledNegativeRows: sampledNegative ? 1n : 0n,
        rejectionCountsJson: rejectionCounts, updatedAtMs: input.observedAtMs,
      });
      return;
    }
    const priorCounts = existing[0].rejectionCountsJson as Record<string, number>;
    for (const code of input.rejectionCodes) priorCounts[code] = (priorCounts[code] ?? 0) + 1;
    await tx.update(schema.pairObserverBucketStats).set({
      completeEnvelopes: sql`${schema.pairObserverBucketStats.completeEnvelopes} + ${input.funnel.completeEnvelopes ? 1n : 0n}`,
      validSynchronizedCaptures: sql`${schema.pairObserverBucketStats.validSynchronizedCaptures} + ${input.funnel.validSynchronizedCaptures ? 1n : 0n}`,
      evaluatedCaptures: sql`${schema.pairObserverBucketStats.evaluatedCaptures} + ${input.funnel.evaluatedCaptures ? 1n : 0n}`,
      prefilterCaptures: sql`${schema.pairObserverBucketStats.prefilterCaptures} + ${input.funnel.prefilterCaptures ? 1n : 0n}`,
      grossDislocations: sql`${schema.pairObserverBucketStats.grossDislocations} + ${input.funnel.grossDislocations ? 1n : 0n}`,
      fullDepthExecutable: sql`${schema.pairObserverBucketStats.fullDepthExecutable} + ${input.funnel.fullDepthExecutable ? 1n : 0n}`,
      feePositive: sql`${schema.pairObserverBucketStats.feePositive} + ${input.funnel.feePositive ? 1n : 0n}`,
      stressPositive: sql`${schema.pairObserverBucketStats.stressPositive} + ${input.funnel.stressPositive ? 1n : 0n}`,
      sampledNegativeRows: sql`${schema.pairObserverBucketStats.sampledNegativeRows} + ${sampledNegative ? 1n : 0n}`,
      rejectionCountsJson: priorCounts, updatedAtMs: input.observedAtMs,
    }).where(key);
  }
}
