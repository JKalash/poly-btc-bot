import { schema, type DbHandle } from "@b5p/db";
import { ONE, PPM, parseFixed, type Ppm, type Prob6, type Shares6 } from "@b5p/domain";
import {
  canonicalObjectHash,
  type PairFeeConventionResolver,
  type PairFeeSnapshot,
  type PairOutcome,
  type PairTokenTerms,
  type PairTokenTermsProvider,
  type PairTokenTermsResult,
} from "@b5p/pair-execution";

export interface RawPairTokenTerms {
  readonly tokenId: string;
  readonly rawFeeRate: string;
  readonly rawTickSize: string;
  readonly rawMinimumOrderShares: string;
  readonly rawVenueMetadata: Readonly<Record<string, string>>;
  readonly source: string;
  readonly effectiveAtMs: number;
}

export interface PairTokenTermsSource {
  fetchTokenTerms(input: { readonly marketId: string; readonly conditionId: string; readonly tokenId: string; readonly asOfMs: number }): Promise<RawPairTokenTerms | null>;
}

export interface PersistedPairTokenTermsProviderOptions {
  readonly maximumFeeSnapshotAgeMs: number;
  readonly maximumConstraintSnapshotAgeMs: number;
  readonly nowMs?: () => number;
}

/** Resolver that only trusts an explicit source-provided collection field. */
export class ExplicitMetadataFeeConventionResolver implements PairFeeConventionResolver {
  readonly version = "explicit-fee-collection-v1";
  resolve(input: { readonly tokenId: string; readonly rawFeeRate: string; readonly rawVenueMetadata: Readonly<Record<string, string>> }) {
    const raw = input.rawVenueMetadata.fee_collection?.toLowerCase();
    if (raw === "usdc") return { kind: "RESOLVED" as const, convention: "USDC" as const };
    if (raw === "shares") return { kind: "RESOLVED" as const, convention: "SHARES" as const };
    return { kind: "UNKNOWN" as const, reason: "authoritative fee_collection metadata is absent or unsupported" };
  }
}

function parseUnsignedFixed(raw: string, label: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw)) throw new TypeError(`${label} is not a canonical decimal with at most six places`);
  return parseFixed(raw, 6);
}

function rejection(code: Extract<PairTokenTermsResult, { kind: "REJECTED" }>["code"], detail: string): PairTokenTermsResult {
  return Object.freeze({ kind: "REJECTED", code, detail });
}

/** Exact-string, token-aware discovery and immutable snapshot persistence. */
export class PersistedPairTokenTermsProvider implements PairTokenTermsProvider {
  private readonly nowMs: () => number;

  constructor(
    private readonly db: DbHandle,
    private readonly source: PairTokenTermsSource,
    private readonly resolver: PairFeeConventionResolver,
    private readonly options: PersistedPairTokenTermsProviderOptions,
  ) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  async currentTerms(input: { readonly marketId: string; readonly conditionId: string; readonly upTokenId: string; readonly downTokenId: string; readonly asOfMs: number }): Promise<PairTokenTermsResult> {
    const up = await this.loadLeg(input, "UP", input.upTokenId);
    if ("reject" in up) return up.reject;
    const down = await this.loadLeg(input, "DOWN", input.downTokenId);
    if ("reject" in down) return down.reject;
    return Object.freeze({ kind: "READY", up: up.terms, down: down.terms });
  }

  private async loadLeg(
    input: { readonly marketId: string; readonly conditionId: string; readonly asOfMs: number },
    outcome: PairOutcome,
    tokenId: string,
  ): Promise<{ terms: PairTokenTerms } | { reject: PairTokenTermsResult }> {
    let raw: RawPairTokenTerms | null;
    try {
      raw = await this.source.fetchTokenTerms({ ...input, tokenId });
    } catch (error) {
      return { reject: rejection("TERMS_TRANSPORT_FAILURE", `${tokenId}: ${error instanceof Error ? error.message : "terms transport failed"}`) };
    }
    if (raw === null) return { reject: rejection("FEE_SNAPSHOT_MISSING", `${tokenId}: token terms are missing`) };
    if (raw.tokenId !== tokenId) return { reject: rejection("FEE_SNAPSHOT_TOKEN_MISMATCH", `${tokenId}: source returned ${raw.tokenId}`) };
    const fetchedAtMs = this.nowMs();
    if (!Number.isSafeInteger(raw.effectiveAtMs) || raw.effectiveAtMs <= 0) {
      return { reject: rejection("CONSTRAINT_SNAPSHOT_MALFORMED", `${tokenId}: invalid effective time`) };
    }
    const age = input.asOfMs - raw.effectiveAtMs;
    if (age > this.options.maximumFeeSnapshotAgeMs) return { reject: rejection("FEE_SNAPSHOT_STALE", `${tokenId}: fee terms are stale`) };
    if (age > this.options.maximumConstraintSnapshotAgeMs) return { reject: rejection("CONSTRAINT_SNAPSHOT_STALE", `${tokenId}: constraint terms are stale`) };

    let ratePpm: Ppm;
    let tickSize6: Prob6;
    let minimumOrderShares6: Shares6;
    try {
      ratePpm = parseUnsignedFixed(raw.rawFeeRate, "fee rate");
      tickSize6 = parseUnsignedFixed(raw.rawTickSize, "tick size");
      minimumOrderShares6 = parseUnsignedFixed(raw.rawMinimumOrderShares, "minimum order");
    } catch (error) {
      return { reject: rejection("FEE_SNAPSHOT_MALFORMED", `${tokenId}: ${error instanceof Error ? error.message : "malformed terms"}`) };
    }
    if (ratePpm < 0n || ratePpm > PPM) return { reject: rejection("FEE_SNAPSHOT_MALFORMED", `${tokenId}: fee rate outside [0,1]`) };
    if (tickSize6 <= 0n || tickSize6 > ONE) return { reject: rejection("CONSTRAINT_SNAPSHOT_MALFORMED", `${tokenId}: tick size outside (0,1]`) };
    if (minimumOrderShares6 <= 0n) return { reject: rejection("CONSTRAINT_SNAPSHOT_MALFORMED", `${tokenId}: minimum order must be positive`) };

    const resolution = this.resolver.resolve({ tokenId, rawFeeRate: raw.rawFeeRate, rawVenueMetadata: raw.rawVenueMetadata });
    const sourcePayload = {
      tokenId, rawFeeRate: raw.rawFeeRate, rawTickSize: raw.rawTickSize,
      rawMinimumOrderShares: raw.rawMinimumOrderShares, rawVenueMetadata: raw.rawVenueMetadata,
      source: raw.source, effectiveAtMs: raw.effectiveAtMs,
    };
    const sourcePayloadHash = canonicalObjectHash(sourcePayload);
    const constraintHash = canonicalObjectHash({ tokenId, tickSize6, minimumOrderShares6, source: raw.source, effectiveAtMs: raw.effectiveAtMs });
    const feeHash = canonicalObjectHash({ tokenId, ratePpm, convention: resolution.kind === "RESOLVED" ? resolution.convention : "UNKNOWN", resolverVersion: this.resolver.version, source: raw.source, effectiveAtMs: raw.effectiveAtMs });
    const constraintId = `pcon_${constraintHash.slice(0, 32)}`;
    const feeId = `pfee_${feeHash.slice(0, 32)}`;
    await this.db.db.insert(schema.constraintSnapshots).values({
      id: constraintId, marketId: input.marketId, tickSize6, minOrderShares6: minimumOrderShares6,
      bestBid6: null, bestAsk6: null, volumeUsd: null, capturedAtMs: fetchedAtMs, raw: sourcePayload,
      tokenId, source: raw.source, sourcePayloadHash, canonicalHash: constraintHash,
      effectiveAtMs: raw.effectiveAtMs, fetchedAtMs,
    }).onConflictDoNothing();
    await this.db.db.insert(schema.feeScheduleSnapshots).values({
      id: feeId, marketId: input.marketId, ratePpm, takerOnly: true, rebateRatePpm: 0n,
      feeType: raw.rawVenueMetadata.fee_type ?? null,
      collection: resolution.kind === "RESOLVED" ? resolution.convention.toLowerCase() : "unknown",
      capturedAtMs: fetchedAtMs, raw: sourcePayload, tokenId, source: raw.source,
      sourcePayloadHash, canonicalHash: feeHash, effectiveAtMs: raw.effectiveAtMs,
      fetchedAtMs, conventionResolverVersion: this.resolver.version,
    }).onConflictDoNothing();
    if (resolution.kind === "UNKNOWN") return { reject: rejection("FEE_CONVENTION_UNKNOWN", `${tokenId}: ${resolution.reason}`) };

    const fee: PairFeeSnapshot = Object.freeze({
      snapshotId: feeId, tokenId, tokenFeeRatePpm: ratePpm, convention: resolution.convention,
      conventionResolverVersion: this.resolver.version, effectiveAtMs: raw.effectiveAtMs,
      fetchedAtMs, source: raw.source, canonicalHash: feeHash,
    });
    return { terms: Object.freeze({
      outcome, tokenId,
      constraints: Object.freeze({ snapshotId: constraintId, tokenId, tickSize6, minimumOrderShares6, effectiveAtMs: raw.effectiveAtMs, fetchedAtMs, source: raw.source, canonicalHash: constraintHash }),
      fee,
    }) };
  }
}
