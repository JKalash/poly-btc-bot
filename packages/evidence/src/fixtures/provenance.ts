import type { EvidenceLabel } from "../labels";

/**
 * Source-fixture provenance.
 *
 * Every fixture in this directory transcribes a numeric table or parameter set
 * EXACTLY as stated by an external source (via the authoritative transcription
 * in `2026-07-31-001-initial-refinement.fable` at the repo root). The fixtures
 * represent the SOURCE'S claims, not truth: every one is labeled
 * SOURCE_CLAIM_UNVERIFIED and may only be re-labeled through a recorded
 * reproduction (see labels.ts).
 *
 * Numeric conventions (repo-wide no-float-money discipline extended to claims):
 *  - percentages  -> integer tenths of a percent (`pctTenths`: 49.8% = 498)
 *  - pp deltas    -> integer tenths of a percentage point (`ppTenths`: -4.5pp = -45)
 *  - price moves  -> integer parts-per-million of price (`ppm`: 0.10% = 1000)
 *  - token prices -> integer cents (0.95 = 95)
 *  - USD amounts  -> integer cents
 *  - the exact printed source text is kept alongside in `asPrinted` fields
 * Plain `number` weights appear only where the source's values (7, 5, 3, 2,
 * 1.5, 1) are exactly representable in binary floating point.
 */

/** Where a fixture's numbers were transcribed from. */
export interface SourceFixtureRef {
  /** Stable source slug (matches SourceEvidence.sourceKey). */
  sourceKey: "reddit_efficient_markets_2026" | "archetapp_gist";
  /** Stable claim slug within the source (matches SourceEvidence.claimKey). */
  claimKey: string;
  /** Original source URL. */
  url: string;
  /** Pinned raw revision URL when one exists (gist only). */
  revisionUrl: string | null;
  /** Repo-root-relative path of the authoritative transcription. */
  briefPath: "2026-07-31-001-initial-refinement.fable";
  /** Heading of the brief section transcribed. */
  briefSection: string;
  /** Inclusive 1-based line range in the brief covering the transcribed numbers. */
  briefLines: { start: number; end: number };
}

/** A typed, labeled, provenance-carrying transcription of one source table. */
export interface SourceFixture<T> {
  /** Stable fixture id, unique across SOURCE_FIXTURES. */
  id: string;
  title: string;
  /** Always SOURCE_CLAIM_UNVERIFIED here; promotion requires a reproduction run. */
  label: Extract<EvidenceLabel, "SOURCE_CLAIM_UNVERIFIED">;
  /** Faithful summary of what the source claims this data shows. */
  claimText: string;
  sourceRef: SourceFixtureRef;
  data: T;
}

export const REDDIT_SOURCE_URL =
  "https://www.reddit.com/r/PredictionsMarkets/comments/1uoqskg/how_efficient_are_polymarkets_5min_crypto_markets/";

export const GIST_SOURCE_URL = "https://gist.github.com/Archetapp/7680adabc48f812a561ca79d73cbac69";

export const GIST_RAW_REVISION_URL =
  "https://gist.githubusercontent.com/Archetapp/7680adabc48f812a561ca79d73cbac69/raw/e45340873b7a2e2f2f3e6663cf77f667e61cc0b7/PolymarketBot.md";

export const BRIEF_PATH = "2026-07-31-001-initial-refinement.fable" as const;

export function redditRef(
  claimKey: string,
  briefSection: string,
  briefLines: { start: number; end: number },
): SourceFixtureRef {
  return {
    sourceKey: "reddit_efficient_markets_2026",
    claimKey,
    url: REDDIT_SOURCE_URL,
    revisionUrl: null,
    briefPath: BRIEF_PATH,
    briefSection,
    briefLines,
  };
}

export function gistRef(
  claimKey: string,
  briefSection: string,
  briefLines: { start: number; end: number },
): SourceFixtureRef {
  return {
    sourceKey: "archetapp_gist",
    claimKey,
    url: GIST_SOURCE_URL,
    revisionUrl: GIST_RAW_REVISION_URL,
    briefPath: BRIEF_PATH,
    briefSection,
    briefLines,
  };
}
