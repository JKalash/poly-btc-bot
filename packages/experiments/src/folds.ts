/**
 * Walk-forward folds with purge + embargo. Pure functions over sample WINDOWS
 * (not points): each sample spans [startMs, endMs] — features are known by
 * startMs, the label resolves at endMs. Leakage happens when a training
 * sample's window overlaps or nearly touches the test block, so:
 *
 *  - PURGE: any sample whose window overlaps the test block is excluded from
 *    the training set (and from the test set unless fully inside it).
 *  - EMBARGO: training samples must additionally end at least `embargoMs`
 *    before the test block starts — a buffer against serial correlation
 *    (trailing-window features computed just before the test period).
 *
 * Training data is strictly historical relative to its test block
 * (walk-forward), so no sample after the test block ever trains fold k.
 */

export interface FoldPlan {
  nFolds: number;
  embargoMs: number;
  purge: true; // purge is not optional — the type forbids turning it off
  minTrainSamples: number;
}

export interface SampleWindow {
  id: string;
  startMs: number;
  endMs: number;
}

export interface Fold {
  index: number;
  trainIds: string[];
  testIds: string[];
  /** Latest endMs among training samples (diagnostic). */
  trainEndMs: number | null;
  testStartMs: number;
  testEndMs: number;
}

export interface FoldValidation {
  ok: boolean;
  violations: string[];
}

/**
 * Split time into `nFolds` contiguous test blocks over the sample span,
 * reserving the first block's history as the initial training set. Returns
 * only folds whose training set meets `minTrainSamples` — a fold trained on
 * too little data is silently unsound, so it is dropped loudly (the caller
 * sees fewer folds and must report that).
 */
export function walkForwardFolds(samples: SampleWindow[], plan: FoldPlan): Fold[] {
  if (plan.nFolds < 1) throw new Error("walkForwardFolds: nFolds must be >= 1");
  if (plan.embargoMs < 0) throw new Error("walkForwardFolds: embargoMs must be >= 0");
  for (const s of samples) {
    if (s.endMs < s.startMs) throw new Error(`walkForwardFolds: sample ${s.id} has endMs < startMs`);
  }
  const sorted = [...samples].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (sorted.length === 0) return [];

  const spanStart = Math.min(...sorted.map((s) => s.startMs));
  const spanEnd = Math.max(...sorted.map((s) => s.endMs));
  // nFolds test blocks over the LAST (nFolds/(nFolds+1)) of the span; the first
  // 1/(nFolds+1) is history-only so fold 0 has a training set.
  const blockLen = (spanEnd - spanStart) / (plan.nFolds + 1);
  if (blockLen <= 0) return [];

  const folds: Fold[] = [];
  for (let k = 0; k < plan.nFolds; k++) {
    const testStartMs = spanStart + blockLen * (k + 1);
    const testEndMs = k === plan.nFolds - 1 ? spanEnd : spanStart + blockLen * (k + 2);
    const embargoBoundary = testStartMs - plan.embargoMs;

    const trainIds: string[] = [];
    const testIds: string[] = [];
    let trainEndMs: number | null = null;
    for (const s of sorted) {
      if (s.endMs <= embargoBoundary) {
        // strictly historical AND clear of the embargo buffer -> train
        trainIds.push(s.id);
        if (trainEndMs === null || s.endMs > trainEndMs) trainEndMs = s.endMs;
      } else if (s.startMs >= testStartMs && s.endMs <= testEndMs) {
        // fully inside the test block -> test
        testIds.push(s.id);
      }
      // everything else (overlapping a boundary or inside the embargo buffer)
      // is PURGED for this fold: it belongs to neither set.
    }
    if (trainIds.length < plan.minTrainSamples) continue;
    folds.push({ index: k, trainIds, testIds, trainEndMs, testStartMs, testEndMs });
  }
  return folds;
}

/**
 * Independent leakage check, run by tests and by the trainer before fitting:
 * verifies for every fold that (a) no id is in both sets, (b) every training
 * sample ends before the embargo boundary, (c) every test sample lies fully
 * inside its test block.
 */
export function validateFolds(samples: SampleWindow[], folds: Fold[], plan: FoldPlan): FoldValidation {
  const byId = new Map(samples.map((s) => [s.id, s]));
  const violations: string[] = [];
  for (const f of folds) {
    const trainSet = new Set(f.trainIds);
    for (const id of f.testIds) {
      if (trainSet.has(id)) violations.push(`fold ${f.index}: sample ${id} in both train and test`);
    }
    for (const id of f.trainIds) {
      const s = byId.get(id);
      if (!s) { violations.push(`fold ${f.index}: unknown train sample ${id}`); continue; }
      if (s.endMs > f.testStartMs - plan.embargoMs) {
        violations.push(`fold ${f.index}: train sample ${id} ends inside the embargo/test window (leakage)`);
      }
    }
    for (const id of f.testIds) {
      const s = byId.get(id);
      if (!s) { violations.push(`fold ${f.index}: unknown test sample ${id}`); continue; }
      if (s.startMs < f.testStartMs || s.endMs > f.testEndMs) {
        violations.push(`fold ${f.index}: test sample ${id} not fully inside the test block`);
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
