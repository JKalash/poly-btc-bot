import { describe, expect, it } from "vitest";
import { AppConfigSchema } from "@b5p/config";
import { buildPairCapabilityAuthority, buildPairObserverOperationalSnapshot, buildPairPolicySnapshot } from "../src/pair-policy";

describe("immutable pair policy snapshots", () => {
  it("converts every economic decimal to exact bigint and hashes the complete policy", () => {
    const config = AppConfigSchema.parse({ pair: { maximum_cash_fraction: "0.020001", modeled_settlement_cost_usdc: "0.000001", maximum_pair_shares: "12.345678" } });
    const policy = buildPairPolicySnapshot(config, 7, "commit-abc");
    expect(policy).toMatchObject({
      maximumCashFractionPpm: 20_001n, modeledSettlementCost6: 1n,
      maximumPairShares6: 12_345_678n, configVersion: 7,
      liveExecutionAvailable: false,
      hardRiskConstant: { name: "ABSOLUTE_MAX_RISK_FRACTION", valuePpm: 100_000n, sourceVersion: "commit-abc" },
    });
    expect(policy.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("changes the policy hash for economic/timing/capability changes but not operational mechanics", () => {
    const base = AppConfigSchema.parse({});
    const hash = buildPairPolicySnapshot(base, 1, "v").policyHash;
    expect(buildPairPolicySnapshot(AppConfigSchema.parse({ pair: { minimum_net_pnl_usdc: "0.02" } }), 1, "v").policyHash).not.toBe(hash);
    expect(buildPairPolicySnapshot(AppConfigSchema.parse({ pair: { activation_latency_ms: 351 } }), 1, "v").policyHash).not.toBe(hash);
    expect(buildPairPolicySnapshot(AppConfigSchema.parse({ pair: { capture_queue_capacity: 99 } }), 1, "v").policyHash).toBe(hash);
    expect(buildPairObserverOperationalSnapshot(AppConfigSchema.parse({ pair: { capture_queue_capacity: 99 } })).operationalHash).not.toBe(buildPairObserverOperationalSnapshot(base).operationalHash);
  });

  it("constructs authority with pair-live structurally unavailable", () => {
    const authority = buildPairCapabilityAuthority(AppConfigSchema.parse({}), 3, "v");
    expect(authority).toMatchObject({ observerEnabled: true, paperSchedulingEnabled: false, liveExecutionAvailable: false, configVersion: 3 });
    expect(Object.keys(authority)).not.toContain("liveExecutionEnabled");
  });
});
