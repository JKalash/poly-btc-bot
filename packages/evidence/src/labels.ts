/**
 * Evidence labels: every claim that influences a trading decision carries one.
 * A claim's label may only move "up" (toward LIVE_VALIDATED) through a recorded
 * reproduction or live measurement — never by assertion.
 *
 *  SOURCE_CLAIM_UNVERIFIED       — stated by an external source; not checked here.
 *  OFFICIAL_CURRENT_AT_RETRIEVAL — read from official docs/API at a recorded time;
 *                                  the live market object still overrides prose.
 *  REPRODUCED_MATCH              — our reproduction agrees within stated tolerance.
 *  REPRODUCED_MISMATCH           — our reproduction disagrees; the mismatch itself
 *                                  is the finding and must stay visible.
 *  DATA_GATED                    — reproduction harness exists but the required
 *                                  dataset does not; awaiting data, never faked.
 *  INTERNAL_HYPOTHESIS           — our own idea; needs a preregistered experiment.
 *  LIVE_VALIDATED                — confirmed on our own live/paper fills.
 *  REJECTED_ANTI_PATTERN         — demonstrated unsafe/unsound; code must prevent
 *                                  it from reaching an armed path.
 */
export const EVIDENCE_LABELS = [
  "SOURCE_CLAIM_UNVERIFIED",
  "OFFICIAL_CURRENT_AT_RETRIEVAL",
  "REPRODUCED_MATCH",
  "REPRODUCED_MISMATCH",
  "DATA_GATED",
  "INTERNAL_HYPOTHESIS",
  "LIVE_VALIDATED",
  "REJECTED_ANTI_PATTERN",
] as const;

export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

export function isEvidenceLabel(v: unknown): v is EvidenceLabel {
  return typeof v === "string" && (EVIDENCE_LABELS as readonly string[]).includes(v);
}
