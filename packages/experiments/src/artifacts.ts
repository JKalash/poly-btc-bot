import { createHash } from "node:crypto";
import type { FoldPlan } from "./folds";

/**
 * Model + calibration artifact metadata. The artifact FILE (JSON emitted by
 * the Python trainer) is the source of truth; these types describe it on both
 * sides of the TS/Python boundary. `artifactChecksum` is sha256 over the
 * canonical JSON of the artifact payload (everything except the checksum
 * fields themselves), so tampering or drift is detectable at load time.
 */

export type ModelKind = "logistic" | "gbm";
export type CalibrationMethod = "isotonic" | "platt";

export interface ModelArtifactMeta {
  id: string;
  /** Registry key, e.g. "calibrated_logistic". */
  modelKey: string;
  /** Full version string, e.g. "calibrated_logistic_v1_2026-08". */
  version: string;
  kind: ModelKind;
  featureNames: string[];
  /** Logistic: intercept + per-feature coefficients. GBM: opaque (Python-side only). */
  coefficients: { intercept: number; weights: Record<string, number> } | null;
  /** Feature standardization applied before the linear term. */
  standardization: Record<string, { mean: number; std: number }> | null;
  datasetManifestIds: string[];
  foldPlan: FoldPlan;
  trainedAtMs: number;
  codeVersion: string;
  artifactChecksum: string;
}

export interface CalibrationCurvePoint {
  /** Raw model score/probability. */
  x: number;
  /** Calibrated probability. */
  y: number;
}

export interface CalibrationMetrics {
  brier: number;
  logLoss: number;
  /** Expected calibration error over equal-count bins. */
  ece: number;
  n: number;
}

export interface CalibrationArtifactMeta {
  id: string;
  modelArtifactId: string;
  method: CalibrationMethod;
  /** Isotonic: piecewise-linear curve points. Platt: two-parameter sigmoid. */
  curve: CalibrationCurvePoint[] | null;
  platt: { a: number; b: number } | null;
  /** Out-of-fold (walk-forward) metrics — never in-sample. */
  metrics: CalibrationMetrics;
  perFoldMetrics: Array<CalibrationMetrics & { fold: number }>;
  createdAtMs: number;
  codeVersion: string;
  artifactChecksum: string;
}

/** Apply a calibration artifact to a raw probability. Pure; used by @b5p/strategy. */
export function applyCalibration(art: Pick<CalibrationArtifactMeta, "method" | "curve" | "platt">, raw: number): number {
  const x = Math.min(1, Math.max(0, raw));
  if (art.method === "platt") {
    if (!art.platt) throw new Error("applyCalibration: platt artifact missing parameters");
    return 1 / (1 + Math.exp(art.platt.a * x + art.platt.b));
  }
  const curve = art.curve;
  if (!curve || curve.length === 0) throw new Error("applyCalibration: isotonic artifact missing curve");
  if (x <= curve[0]!.x) return curve[0]!.y;
  const last = curve[curve.length - 1]!;
  if (x >= last.x) return last.y;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]!;
    const b = curve[i]!;
    if (x <= b.x) {
      const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return last.y;
}

/* ------------------------------------------------------------------------ *
 * Combined trainer-emitted artifact (single JSON file).
 *
 * The Python trainer (apps/research/py/train_calibrated_model.py) emits ONE
 * sealed JSON document per training run. The TS runtime consumes it read-only.
 *
 * SEALING SCHEME (shared TS/Python contract):
 *   The document contains exactly one top-level `"artifactChecksum":"<hex>"`
 *   field. The checksum is sha256 over the EXACT BYTES of the serialized
 *   document with the checksum value replaced by the empty string. Verification
 *   therefore never re-serializes floats (Python and JS number formatting
 *   differ), it only blanks the checksum substring in the raw text. Any byte
 *   of tampering — numbers, keys, whitespace — breaks the seal.
 * ------------------------------------------------------------------------ */

export interface FoldScoreVsNull {
  fold: number;
  n: number;
  /** Calibrated model, out-of-fold. */
  brierModel: number;
  logLossModel: number;
  /** Mid-price null on the SAME rows — the score the model must beat. */
  brierMid: number;
  logLossMid: number;
}

export interface CalibrationFit {
  method: CalibrationMethod;
  /** Isotonic: piecewise-linear knots. */
  curve: CalibrationCurvePoint[] | null;
  /** Platt: p = 1 / (1 + exp(a*x + b)). */
  platt: { a: number; b: number } | null;
  /** Metrics of this calibration on walk-forward OUT-OF-FOLD predictions. */
  metrics: CalibrationMetrics;
}

export interface NetEvFrictions {
  /** Taker fee rate (crypto_fees_v2: 0.07). */
  feeRate: number;
  /** Entry priced at the executable side (ask), not the mid. */
  spreadIncluded: boolean;
  /** Probability points removed for quote-latency drift between decision and fill. */
  latencyProbPenalty: number;
  /** Probability points removed for adverse selection (measured −8.8pt on maker fills). */
  adverseSelectionProbPenalty: number;
}

export interface NetEvEstimate {
  /** Net expected value per unit cost over out-of-fold hypothetical trades. */
  perCost: { mean: number | null; ciLo: number | null; ciHi: number | null; n: number };
  frictions: NetEvFrictions;
  /** Preregistered decision rule that generated the hypothetical trades. */
  signalRule: string;
}

/** The single sealed document the trainer emits and the runtime loads. */
export interface CalibrationArtifact {
  schemaVersion: 1;
  id: string;
  /** Registry key, e.g. "calibrated_logistic". */
  modelKey: string;
  /** Full version string, e.g. "calibrated_logistic_v1_2026-08-03". */
  version: string;
  kind: ModelKind;
  featureNames: string[];
  /** Logistic: intercept + per-feature coefficients on STANDARDIZED features. GBM: null (research-only). */
  coefficients: { intercept: number; weights: Record<string, number> } | null;
  standardization: Record<string, { mean: number; std: number }> | null;
  foldPlan: FoldPlan;
  /** Folds that actually met minTrainSamples (may be < foldPlan.nFolds — report, never hide). */
  foldsRealized: number;
  perFoldVsNull: FoldScoreVsNull[];
  /** Pooled out-of-fold metrics: calibrated model and the mid-price null. */
  oofModel: CalibrationMetrics;
  oofMidNull: CalibrationMetrics;
  /** Both calibrations are fitted and recorded; `selectedMethod` names the winner. */
  fits: CalibrationFit[];
  selectedMethod: CalibrationMethod;
  netEv: NetEvEstimate;
  dataset: { manifestId: string | null; manifestChecksum: string; rows: number };
  trainedAtMs: number;
  codeVersion: string;
  artifactChecksum: string;
}

const CHECKSUM_FIELD_EMPTY = '"artifactChecksum":""';
const CHECKSUM_FIELD_RE = /"artifactChecksum":"([0-9a-f]{64})"/g;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Seal an artifact serialized with an EMPTY checksum (`"artifactChecksum":""`,
 * compact JSON, exactly one occurrence): returns the same text with the sha256
 * filled in. Mirrors `seal_artifact_text` in the Python trainer.
 */
export function sealArtifactText(unsealedText: string): string {
  const first = unsealedText.indexOf(CHECKSUM_FIELD_EMPTY);
  if (first === -1) throw new Error("sealArtifactText: no empty artifactChecksum field found (must be compact JSON)");
  if (unsealedText.indexOf(CHECKSUM_FIELD_EMPTY, first + 1) !== -1) {
    throw new Error("sealArtifactText: multiple empty artifactChecksum fields — refusing to seal ambiguously");
  }
  const hash = sha256Hex(unsealedText);
  return (
    unsealedText.slice(0, first) +
    `"artifactChecksum":"${hash}"` +
    unsealedText.slice(first + CHECKSUM_FIELD_EMPTY.length)
  );
}

export interface ArtifactTextVerification {
  ok: boolean;
  reason: string | null;
}

/** Verify a sealed artifact's checksum against its raw text. Pure; no float re-serialization. */
export function verifyArtifactText(text: string): ArtifactTextVerification {
  const matches = [...text.matchAll(CHECKSUM_FIELD_RE)];
  if (matches.length !== 1) {
    return { ok: false, reason: `expected exactly one sealed artifactChecksum field, found ${matches.length}` };
  }
  const m = matches[0]!;
  const embedded = m[1]!;
  const blanked = text.slice(0, m.index!) + CHECKSUM_FIELD_EMPTY + text.slice(m.index! + m[0].length);
  const computed = sha256Hex(blanked);
  if (computed !== embedded) {
    return { ok: false, reason: "artifact checksum mismatch — content does not match its embedded sha256 seal" };
  }
  return { ok: true, reason: null };
}

export interface ParsedArtifact {
  ok: boolean;
  reasons: string[];
  artifact: CalibrationArtifact | null;
}

/**
 * Verify the seal, parse, and structurally validate a CalibrationArtifact.
 * Returns every failing reason (risk-engine style) rather than the first.
 */
export function parseCalibrationArtifact(text: string): ParsedArtifact {
  const seal = verifyArtifactText(text);
  if (!seal.ok) return { ok: false, reasons: [seal.reason!], artifact: null };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, reasons: [`artifact is not valid JSON: ${(e as Error).message}`], artifact: null };
  }
  const reasons: string[] = [];
  const a = raw as Partial<CalibrationArtifact>;
  const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

  if (a.schemaVersion !== 1) reasons.push(`unsupported schemaVersion ${String(a.schemaVersion)} (expected 1)`);
  if (typeof a.id !== "string" || a.id.length === 0) reasons.push("missing artifact id");
  if (typeof a.modelKey !== "string" || a.modelKey.length === 0) reasons.push("missing modelKey");
  if (typeof a.version !== "string" || a.version.length === 0) reasons.push("missing version");
  if (a.kind !== "logistic" && a.kind !== "gbm") reasons.push(`unknown model kind ${String(a.kind)}`);
  if (!Array.isArray(a.featureNames) || a.featureNames.length === 0 || !a.featureNames.every((f) => typeof f === "string")) {
    reasons.push("featureNames must be a non-empty string array");
  }
  if (a.kind === "logistic") {
    const c = a.coefficients;
    if (!c || !isNum(c.intercept) || typeof c.weights !== "object" || c.weights === null) {
      reasons.push("logistic artifact requires coefficients {intercept, weights}");
    } else if (Array.isArray(a.featureNames)) {
      for (const f of a.featureNames) {
        if (!isNum(c.weights[f])) reasons.push(`missing coefficient for feature "${f}"`);
        const s = a.standardization?.[f];
        if (!s || !isNum(s.mean) || !isNum(s.std) || s.std <= 0) reasons.push(`missing/invalid standardization for feature "${f}"`);
      }
    }
  }
  const plan = a.foldPlan;
  if (!plan || plan.purge !== true || !isNum(plan.embargoMs) || plan.embargoMs < 0 || !isNum(plan.nFolds)) {
    reasons.push("foldPlan must be present with purge:true and a non-negative embargoMs");
  }
  if (!isNum(a.foldsRealized) || a.foldsRealized < 0) reasons.push("foldsRealized missing");
  if (!Array.isArray(a.perFoldVsNull)) reasons.push("perFoldVsNull missing");
  for (const k of ["oofModel", "oofMidNull"] as const) {
    const mtr = a[k];
    if (!mtr || !isNum(mtr.n)) reasons.push(`${k} metrics missing`);
  }
  if (!Array.isArray(a.fits) || a.fits.length === 0) {
    reasons.push("fits missing — artifact must carry at least the selected calibration");
  } else {
    if (a.selectedMethod !== "isotonic" && a.selectedMethod !== "platt") reasons.push("selectedMethod must be isotonic or platt");
    const sel = a.fits.find((f) => f.method === a.selectedMethod);
    if (!sel) reasons.push(`selectedMethod ${String(a.selectedMethod)} has no matching fit`);
    else if (sel.method === "isotonic" && (!sel.curve || sel.curve.length === 0)) reasons.push("isotonic fit missing curve");
    else if (sel.method === "platt" && (!sel.platt || !isNum(sel.platt.a) || !isNum(sel.platt.b))) reasons.push("platt fit missing parameters");
  }
  const ev = a.netEv;
  if (!ev || !ev.perCost || !ev.frictions) {
    reasons.push("netEv estimate missing");
  } else {
    if (!isNum(ev.frictions.feeRate)) reasons.push("netEv.frictions.feeRate missing");
    if (!isNum(ev.frictions.latencyProbPenalty)) reasons.push("netEv.frictions.latencyProbPenalty missing");
    if (!isNum(ev.frictions.adverseSelectionProbPenalty)) reasons.push("netEv.frictions.adverseSelectionProbPenalty missing");
    if (typeof ev.frictions.spreadIncluded !== "boolean") reasons.push("netEv.frictions.spreadIncluded missing");
  }
  if (!a.dataset || typeof a.dataset.manifestChecksum !== "string" || a.dataset.manifestChecksum.length === 0) {
    reasons.push("dataset manifest checksum missing — artifact must be traceable to its data");
  }
  if (typeof a.codeVersion !== "string" || a.codeVersion.length === 0) reasons.push("codeVersion missing");
  if (!isNum(a.trainedAtMs)) reasons.push("trainedAtMs missing");

  return reasons.length === 0
    ? { ok: true, reasons: [], artifact: a as CalibrationArtifact }
    : { ok: false, reasons, artifact: null };
}

/** The fit named by `selectedMethod` — the one the runtime applies. */
export function selectedFit(artifact: CalibrationArtifact): CalibrationFit {
  const fit = artifact.fits.find((f) => f.method === artifact.selectedMethod);
  if (!fit) throw new Error(`artifact ${artifact.id}: selected fit ${artifact.selectedMethod} missing`);
  return fit;
}
