/**
 * Promotion gate CLI: evaluate a sealed CalibrationArtifact against the
 * promotion criteria and print/persist the StrategyPromotionDecision.
 *
 * The decision is the AUTHORITATIVE gate output — the engine consults the
 * persisted decision, never re-derives it silently. A failing decision is a
 * first-class result: with the 2026-08 study's null, FAILING is the expected
 * honest outcome.
 *
 * Usage:
 *   pnpm --filter @b5p/research promote -- --artifact <artifact.json> \
 *     [--strategy-version book_distance_v1] [--mode live] [--out decision.json] \
 *     [--min-samples 300] [--max-ece 0.05] [--min-net-ev-lower-ci 0]
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  DEFAULT_PROMOTION_CRITERIA, evaluateArtifactPromotion, type PromotionMode,
} from "@b5p/experiments";

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const artifactPath = arg("artifact");
if (!artifactPath) {
  console.error("usage: cli-promote --artifact <sealed-artifact.json> [--out decision.json]");
  process.exit(2);
}

let artifactText: string | null = null;
try {
  artifactText = readFileSync(artifactPath, "utf8");
} catch {
  console.error(`artifact not readable at ${artifactPath} — evaluating as ABSENT (which fails, honestly)`);
}

const criteria = {
  minSamples: Number(arg("min-samples", String(DEFAULT_PROMOTION_CRITERIA.minSamples))),
  maxEce: Number(arg("max-ece", String(DEFAULT_PROMOTION_CRITERIA.maxEce))),
  minNetEvLowerCi: Number(arg("min-net-ev-lower-ci", String(DEFAULT_PROMOTION_CRITERIA.minNetEvLowerCi))),
};

const decision = evaluateArtifactPromotion({
  artifactText,
  criteria,
  strategyVersion: arg("strategy-version", "book_distance_v1")!,
  mode: (arg("mode", "live") as PromotionMode),
  decidedBy: "cli-promote",
  nowMs: Date.now(),
});

console.log(JSON.stringify(decision, null, 2));
console.log(`\npromotion: ${decision.approved ? "PASS — model may be promoted" : "FAIL — model must not trade"}`);
for (const r of decision.reasons) console.log(`  - ${r}`);

const out = arg("out");
if (out) {
  writeFileSync(out, JSON.stringify(decision, null, 2));
  console.log(`decision written: ${out}`);
}
