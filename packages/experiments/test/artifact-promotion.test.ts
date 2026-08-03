import { describe, expect, it } from "vitest";
import {
  parseCalibrationArtifact, sealArtifactText, selectedFit, verifyArtifactText,
  type CalibrationArtifact,
} from "../src/artifacts";
import {
  DEFAULT_PROMOTION_CRITERIA, evaluateArtifactPromotion, promotionEvidenceFromArtifact,
} from "../src/promotion";
import type { ExperimentObservation } from "../src/types";

/* ---------------------------------------------------------------- fixtures */

type ArtifactSansChecksum = Omit<CalibrationArtifact, "artifactChecksum">;

function baseArtifact(overrides: Partial<ArtifactSansChecksum> = {}): ArtifactSansChecksum {
  const metrics = { brier: 0.118, logLoss: 0.39, ece: 0.021, n: 5200 };
  return {
    schemaVersion: 1,
    id: "cal-test-0001",
    modelKey: "calibrated_logistic",
    version: "calibrated_logistic_v1_test",
    kind: "logistic",
    featureNames: ["mid", "spread", "dist_half", "quarter"],
    coefficients: { intercept: 0.01, weights: { mid: 2.1, spread: -0.4, dist_half: 0.9, quarter: 0.02 } },
    standardization: {
      mid: { mean: 0.5, std: 0.21 },
      spread: { mean: 0.02, std: 0.012 },
      dist_half: { mean: 0.0, std: 0.21 },
      quarter: { mean: 0.25, std: 0.43 },
    },
    foldPlan: { nFolds: 6, embargoMs: 60_000, purge: true, minTrainSamples: 500 },
    foldsRealized: 6,
    perFoldVsNull: [
      { fold: 0, n: 850, brierModel: 0.121, brierMid: 0.124, logLossModel: 0.4, logLossMid: 0.41 },
      { fold: 1, n: 870, brierModel: 0.117, brierMid: 0.12, logLossModel: 0.39, logLossMid: 0.4 },
    ],
    oofModel: metrics,
    oofMidNull: { brier: 0.121, logLoss: 0.4, ece: 0.03, n: 5200 },
    fits: [
      { method: "isotonic", curve: [{ x: 0.05, y: 0.03 }, { x: 0.5, y: 0.5 }, { x: 0.95, y: 0.97 }], platt: null, metrics },
      { method: "platt", curve: null, platt: { a: -4.2, b: 2.1 }, metrics: { ...metrics, brier: 0.119 } },
    ],
    selectedMethod: "isotonic",
    netEv: {
      perCost: { mean: 0.031, ciLo: 0.012, ciHi: 0.05, n: 4100 },
      frictions: { feeRate: 0.07, spreadIncluded: true, latencyProbPenalty: 0.005, adverseSelectionProbPenalty: 0.088 },
      signalRule: "taker favored side at ask, all OOF decisions",
    },
    dataset: { manifestId: "dm-test", manifestChecksum: "c".repeat(64), rows: 6000 },
    trainedAtMs: 1_785_000_000_000,
    codeVersion: "test",
    ...overrides,
  };
}

export function sealedArtifactText(overrides: Partial<ArtifactSansChecksum> = {}): string {
  const doc = { ...baseArtifact(overrides), artifactChecksum: "" };
  return sealArtifactText(JSON.stringify(doc));
}

/** The honest kachoio-shaped outcome: the null held, net EV lower CI is negative. */
function failingNetEvOverrides(): Partial<ArtifactSansChecksum> {
  return {
    netEv: {
      perCost: { mean: -0.055, ciLo: -0.062, ciHi: -0.048, n: 4100 },
      frictions: { feeRate: 0.07, spreadIncluded: true, latencyProbPenalty: 0.005, adverseSelectionProbPenalty: 0.088 },
      signalRule: "taker favored side at ask, all OOF decisions",
    },
  };
}

/* ------------------------------------------------------------------- seals */

describe("artifact sealing and verification", () => {
  it("round-trips: sealed text verifies and parses", () => {
    const text = sealedArtifactText();
    expect(verifyArtifactText(text).ok).toBe(true);
    const parsed = parseCalibrationArtifact(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.artifact!.modelKey).toBe("calibrated_logistic");
    expect(selectedFit(parsed.artifact!).method).toBe("isotonic");
  });

  it("HASH-TAMPER: modifying any byte after sealing is rejected", () => {
    const text = sealedArtifactText();
    // tamper with a numeric value (make netEv look better)
    const tampered = text.replace('"ciLo":0.012', '"ciLo":0.912');
    expect(tampered).not.toBe(text);
    expect(verifyArtifactText(tampered).ok).toBe(false);
    const parsed = parseCalibrationArtifact(tampered);
    expect(parsed.ok).toBe(false);
    expect(parsed.reasons.join(" ")).toMatch(/checksum mismatch/);
  });

  it("rejects a re-sealed forgery only if the checksum disagrees — but tampering the checksum itself also fails", () => {
    const text = sealedArtifactText();
    const forgedChecksum = text.replace(/"artifactChecksum":"[0-9a-f]{10}/, '"artifactChecksum":"deadbeef00');
    expect(verifyArtifactText(forgedChecksum).ok).toBe(false);
  });

  it("rejects text with zero or multiple checksum fields", () => {
    expect(verifyArtifactText("{}").ok).toBe(false);
    const text = sealedArtifactText();
    const doubled = text.replace("{", `{"artifactChecksum":"${"a".repeat(64)}",`);
    expect(verifyArtifactText(doubled).ok).toBe(false);
  });

  it("structurally validates: logistic artifact without coefficients is rejected", () => {
    const text = sealedArtifactText({ coefficients: null });
    const parsed = parseCalibrationArtifact(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.reasons.join(" ")).toMatch(/coefficients/);
  });
});

/* --------------------------------------------------------------- promotion */

describe("evaluateArtifactPromotion — the live gate", () => {
  const opts = { strategyVersion: "book_distance_v1", mode: "live" as const, decidedBy: "test", nowMs: 1_785_000_000_000 };

  it("approves ONLY a hash-valid artifact with positive lower-CI net EV and all frictions", () => {
    const d = evaluateArtifactPromotion({ artifactText: sealedArtifactText(), ...opts });
    expect(d.reasons).toEqual([]);
    expect(d.approved).toBe(true);
    expect(d.modelVersion).toBe("calibrated_logistic_v1_test");
    expect(d.calibrationArtifactId).toBe("cal-test-0001");
  });

  it("NO ARTIFACT -> no live approval, ever", () => {
    const d = evaluateArtifactPromotion({ artifactText: null, ...opts });
    expect(d.approved).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/no walk-forward calibration artifact/);
  });

  it("the honest kachoio outcome: valid artifact, NEGATIVE lower-CI net EV -> promotion FAILS", () => {
    const d = evaluateArtifactPromotion({ artifactText: sealedArtifactText(failingNetEvOverrides()), ...opts });
    expect(d.approved).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/lower 95% CI/);
    // the artifact itself is fine — only the economics fail
    expect(d.calibrationArtifactId).toBe("cal-test-0001");
  });

  it("a positive MEAN with a non-positive lower CI still fails", () => {
    const d = evaluateArtifactPromotion({
      artifactText: sealedArtifactText({
        netEv: {
          perCost: { mean: 0.04, ciLo: -0.001, ciHi: 0.081, n: 4100 },
          frictions: { feeRate: 0.07, spreadIncluded: true, latencyProbPenalty: 0.005, adverseSelectionProbPenalty: 0.088 },
          signalRule: "taker favored side at ask, all OOF decisions",
        },
      }),
      ...opts,
    });
    expect(d.approved).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/not sufficient/);
  });

  it("tampered artifact -> failing decision with checksum reason (never an exception)", () => {
    const tampered = sealedArtifactText().replace('"ciLo":0.012', '"ciLo":0.912');
    const d = evaluateArtifactPromotion({ artifactText: tampered, ...opts });
    expect(d.approved).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/checksum mismatch/);
    expect(d.calibrationArtifactId).toBeNull();
  });

  it("missing frictions in the artifact fail the gate", () => {
    const d = evaluateArtifactPromotion({
      artifactText: sealedArtifactText({
        netEv: {
          perCost: { mean: 0.03, ciLo: 0.01, ciHi: 0.05, n: 4100 },
          frictions: { feeRate: 0.07, spreadIncluded: true, latencyProbPenalty: 0, adverseSelectionProbPenalty: 0 },
          signalRule: "taker favored side at ask, all OOF decisions",
        },
      }),
      ...opts,
    });
    expect(d.approved).toBe(false);
    expect(d.reasons.join("\n")).toMatch(/latency/);
    expect(d.reasons.join("\n")).toMatch(/adverse-selection/);
  });

  it("null net-EV bounds (no signals) fail with a finite-number reason", () => {
    const d = evaluateArtifactPromotion({
      artifactText: sealedArtifactText({
        netEv: {
          perCost: { mean: null, ciLo: null, ciHi: null, n: 0 },
          frictions: { feeRate: 0.07, spreadIncluded: true, latencyProbPenalty: 0.005, adverseSelectionProbPenalty: 0.088 },
          signalRule: "taker favored side at ask, all OOF decisions",
        },
      }),
      ...opts,
    });
    expect(d.approved).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/finite/);
  });

  it("supplemental observations can veto but never rescue", () => {
    const veto: ExperimentObservation = {
      id: "obs1", runId: "run1", metric: "net_ev_per_cost", scope: "live_paper",
      value: -0.02, valueText: null, n: 400, ciLo: -0.03, ciHi: -0.01, detail: null, createdAtMs: 0,
    };
    const vetoed = evaluateArtifactPromotion({ artifactText: sealedArtifactText(), observations: [veto], ...opts });
    expect(vetoed.approved).toBe(false);
    expect(vetoed.reasons.join(" ")).toMatch(/live_paper/);

    const rescue: ExperimentObservation = { ...veto, id: "obs2", ciLo: 0.5, ciHi: 0.9, value: 0.7 };
    const failedArtifact = evaluateArtifactPromotion({
      artifactText: sealedArtifactText(failingNetEvOverrides()), observations: [rescue], ...opts,
    });
    expect(failedArtifact.approved).toBe(false); // glowing observation cannot override the artifact
  });

  it("derived evidence carries walk-forward provenance from the fold plan", () => {
    const parsed = parseCalibrationArtifact(sealedArtifactText());
    const ev = promotionEvidenceFromArtifact(parsed.artifact!);
    expect(ev.walkForward.purged).toBe(true);
    expect(ev.walkForward.embargoMs).toBe(60_000);
    expect(ev.walkForward.folds).toBe(6);
    expect(ev.frictions).toEqual({
      feesIncluded: true, spreadIncluded: true, latencyIncluded: true, adverseSelectionIncluded: true,
    });
  });

  it("default criteria demand a positive lower CI, 300+ samples, ece <= 0.05", () => {
    expect(DEFAULT_PROMOTION_CRITERIA).toEqual({ minSamples: 300, maxEce: 0.05, minNetEvLowerCi: 0 });
  });
});
