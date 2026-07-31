import { describe, expect, it } from "vitest";
import { ABSOLUTE_MAX_RISK_FRACTION, DEFAULT_CONFIG, diffConfigs, validateConfig } from "../src/index";

describe("config schema", () => {
  it("defaults: paper mode, maker-only, taker disabled, live disabled", () => {
    expect(DEFAULT_CONFIG.app.mode).toBe("paper");
    expect(DEFAULT_CONFIG.strategy.maker_only).toBe(true);
    expect(DEFAULT_CONFIG.strategy.allow_taker).toBe(false);
    expect(DEFAULT_CONFIG.live.enabled).toBe(false);
    expect(DEFAULT_CONFIG.risk.no_martingale).toBe(true);
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

  it("diffs configs by dot path", () => {
    const d = diffConfigs(DEFAULT_CONFIG, { ...DEFAULT_CONFIG, risk: { ...DEFAULT_CONFIG.risk, profile: "aggressive" } });
    expect(d).toEqual([{ path: "risk.profile", from: "paper_exploration", to: "aggressive" }]);
  });
});
