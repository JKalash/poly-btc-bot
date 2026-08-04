import { describe, expect, it } from "vitest";
import { ABSOLUTE_MAX_RISK_FRACTION, DEFAULT_CONFIG, diffConfigs, validateConfig } from "../src/index";

describe("config schema", () => {
  it("defaults: paper mode, maker-only, taker disabled, live disabled", () => {
    expect(DEFAULT_CONFIG.app.mode).toBe("paper");
    expect(DEFAULT_CONFIG.strategy.maker_only).toBe(true);
    expect(DEFAULT_CONFIG.strategy.allow_taker).toBe(false);
    expect(DEFAULT_CONFIG.live.enabled).toBe(false);
    expect(DEFAULT_CONFIG.risk.no_martingale).toBe(true);
    expect(DEFAULT_CONFIG.pair.observer_enabled).toBe(true);
    expect(DEFAULT_CONFIG.pair.paper_execution_enabled).toBe(false);
    expect(DEFAULT_CONFIG.pair.live_execution_enabled).toBe(false);
  });

  it("refuses risk above the absolute 10% safety cap", () => {
    expect(ABSOLUTE_MAX_RISK_FRACTION).toBe("0.10");
    const r = validateConfig({ risk: { max_risk_fraction: "0.25", base_risk_fraction: "0.05" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.path).toBe("risk.max_risk_fraction");
  });

  it("refuses live.enabled = true (literal false in this release)", () => {
    const r = validateConfig({ live: { enabled: true } });
    expect(r.ok).toBe(false);
  });

  it("refuses martingale-style flags", () => {
    expect(validateConfig({ risk: { no_martingale: false } }).ok).toBe(false);
  });

  it("validates pair policy with exact decimal comparisons", () => {
    expect(validateConfig({ pair: { maximum_cash_fraction: "0.100001" } }).ok).toBe(false);
    expect(validateConfig({ pair: { maximum_cash_fraction: "0.1" } }).ok).toBe(true);
    expect(validateConfig({ pair: {
      maximum_cash_fraction: "0.02",
      maximum_residual_loss_fraction: "0.020001",
    } }).ok).toBe(false);
    expect(validateConfig({ pair: {
      maximum_aggregate_reserved_fraction: "0.02",
      maximum_aggregate_residual_loss_fraction: "0.020001",
    } }).ok).toBe(false);
  });

  it("fails closed for unsafe pair scheduling and policy combinations", () => {
    expect(validateConfig({ pair: { paper_execution_enabled: true, observer_enabled: false } }).ok).toBe(false);
    expect(validateConfig({ pair: { live_execution_enabled: true } }).ok).toBe(false);
    expect(validateConfig({ pair: { settlement_policy: "PAPER_VIRTUAL_MERGE" } }).ok).toBe(false);
    expect(validateConfig({ pair: {
      recovery_policy: "PAPER_COMPLETE_MISSING_LEG",
      maximum_recovery_attempts: 1,
      recovery_reserve_usdc: "1",
    } }).ok).toBe(false);
    expect(validateConfig({ pair: {
      paper_execution_enabled: true,
      recovery_policy: "PAPER_COMPLETE_MISSING_LEG",
      maximum_recovery_attempts: 1,
      recovery_reserve_usdc: "1",
    } }).ok).toBe(true);
  });

  it("rejects invalid pair timing, lot, recovery, and depth relationships", () => {
    expect(validateConfig({ pair: { observer_flush_interval_ms: 501 } }).ok).toBe(false);
    expect(validateConfig({ pair: { activation_quote_ttl_ms: 501 } }).ok).toBe(false);
    expect(validateConfig({ pair: { pair_share_lot: "0" } }).ok).toBe(false);
    expect(validateConfig({ pair: { pair_share_lot: "1", maximum_pair_shares: "0.5" } }).ok).toBe(false);
    expect(validateConfig({ pair: { maximum_recovery_attempts: 1 } }).ok).toBe(false);
    expect(validateConfig({ pair: { depth_stress_fractions: ["0.50", "0.75", "0.25"] } }).ok).toBe(false);
    expect(validateConfig({ pair: { depth_stress_fractions: ["1", "0.5", "0.000001"] } }).ok).toBe(true);
  });

  it("diffs configs by dot path", () => {
    const d = diffConfigs(DEFAULT_CONFIG, { ...DEFAULT_CONFIG, risk: { ...DEFAULT_CONFIG.risk, profile: "aggressive" } });
    expect(d).toEqual([{ path: "risk.profile", from: "paper_exploration", to: "aggressive" }]);
  });
});
