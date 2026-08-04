import { ABSOLUTE_MAX_RISK_FRACTION, type AppConfig } from "@b5p/config";
import { parseFixed } from "@b5p/domain";
import { canonicalObjectHash, type PairCapabilityAuthority, type PairPolicySnapshot } from "@b5p/pair-execution";

export interface PairObserverOperationalSnapshot {
  readonly observerFlushIntervalMs: number;
  readonly captureQueueCapacity: number;
  readonly marketEventBatchSize: number;
  readonly checkpointIntervalMs: number;
  readonly reconcileIntervalMs: number;
  readonly algorithmVersion: "pair_observer_ops_v1";
  readonly operationalHash: string;
}

const fixed6 = (value: string): bigint => parseFixed(value, 6);

export function buildPairPolicySnapshot(config: AppConfig, configVersion: number, sourceVersion: string): PairPolicySnapshot {
  const pair = config.pair;
  const withoutHash: Omit<PairPolicySnapshot, "policyHash"> = {
    strategyVersion: pair.strategy_version,
    route: pair.route,
    observerEnabled: pair.observer_enabled,
    paperSchedulingEnabled: pair.paper_execution_enabled,
    liveExecutionAvailable: false,
    dispatchModel: pair.dispatch_model,
    activationLatencyMs: pair.activation_latency_ms,
    interLegDelayMs: pair.inter_leg_delay_ms,
    activationQuoteTtlMs: pair.activation_quote_ttl_ms,
    settlementPolicy: pair.settlement_policy,
    modeledSettlementDelayMs: pair.modeled_settlement_delay_ms,
    modeledSettlementCost6: fixed6(pair.modeled_settlement_cost_usdc),
    settlementCashReserve6: fixed6(pair.settlement_cash_reserve_usdc),
    recoveryPolicy: pair.recovery_policy,
    maximumRecoveryAttempts: pair.maximum_recovery_attempts,
    recoveryDeadlineMs: pair.recovery_deadline_ms,
    recoveryReserve6: fixed6(pair.recovery_reserve_usdc),
    maximumBookAgeMs: pair.maximum_book_age_ms,
    maximumSourceSkewMs: pair.maximum_source_skew_ms,
    maximumReceiveSkewMs: pair.maximum_receive_skew_ms,
    maximumFutureTimestampMs: pair.maximum_future_timestamp_ms,
    maximumFeeSnapshotAgeMs: pair.maximum_fee_snapshot_age_ms,
    maximumConstraintSnapshotAgeMs: pair.maximum_constraint_snapshot_age_ms,
    minimumNetPnl6: fixed6(pair.minimum_net_pnl_usdc),
    minimumNetReturnPpm: fixed6(pair.minimum_net_return),
    operationalRiskHaircut6: fixed6(pair.operational_risk_haircut_usdc),
    maximumCashFractionPpm: fixed6(pair.maximum_cash_fraction),
    maximumResidualLossFractionPpm: fixed6(pair.maximum_residual_loss_fraction),
    maximumAggregateReservedFractionPpm: fixed6(pair.maximum_aggregate_reserved_fraction),
    maximumAggregateResidualLossFractionPpm: fixed6(pair.maximum_aggregate_residual_loss_fraction),
    maximumPairDailyLossFractionPpm: fixed6(pair.maximum_pair_daily_loss_fraction),
    maximumPairSessionDrawdownFractionPpm: fixed6(pair.maximum_pair_session_drawdown_fraction),
    maximumActivePairGroups: pair.maximum_active_pair_groups,
    pairShareLot6: fixed6(pair.pair_share_lot),
    maximumPairShares6: pair.maximum_pair_shares === undefined ? null : fixed6(pair.maximum_pair_shares),
    requireOneTickStressPositive: pair.require_one_tick_stress_positive,
    requireTwoTickStressPositive: pair.require_two_tick_stress_positive,
    depthStressFractionsPpm: pair.depth_stress_fractions.map(fixed6) as [bigint, bigint, bigint],
    entryCutoffSeconds: pair.entry_cutoff_seconds,
    episodeCooloffMs: pair.episode_cooloff_ms,
    negativeControlSamplePpm: BigInt(pair.negative_control_sample_ppm),
    unknownResultTimeoutMs: pair.unknown_result_timeout_ms,
    hardRiskConstant: {
      name: "ABSOLUTE_MAX_RISK_FRACTION",
      valuePpm: fixed6(ABSOLUTE_MAX_RISK_FRACTION),
      sourceVersion,
    },
    configVersion,
  };
  return Object.freeze({ ...withoutHash, policyHash: canonicalObjectHash(withoutHash) });
}

export function buildPairObserverOperationalSnapshot(config: AppConfig): PairObserverOperationalSnapshot {
  const payload = {
    observerFlushIntervalMs: config.pair.observer_flush_interval_ms,
    captureQueueCapacity: config.pair.capture_queue_capacity,
    marketEventBatchSize: config.pair.market_event_batch_size,
    checkpointIntervalMs: config.pair.checkpoint_interval_ms,
    reconcileIntervalMs: config.pair.reconcile_interval_ms,
    algorithmVersion: "pair_observer_ops_v1" as const,
  };
  return Object.freeze({ ...payload, operationalHash: canonicalObjectHash(payload) });
}

export function buildPairCapabilityAuthority(config: AppConfig, configVersion: number, sourceVersion: string): PairCapabilityAuthority {
  const policy = buildPairPolicySnapshot(config, configVersion, sourceVersion);
  return Object.freeze({
    observerEnabled: policy.observerEnabled,
    paperSchedulingEnabled: policy.paperSchedulingEnabled,
    liveExecutionAvailable: false,
    configVersion,
    policy,
  });
}
