const DEFAULT_CLOB_BASE = "https://clob.polymarket.com";
const EXACT_UNSIGNED_DECIMAL_6 = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
const EXACT_UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/;

export interface PublicClobTermsTransportResponse {
  readonly status: number;
  readonly body: string;
}

/** Deliberately smaller than an authenticated CLOB client. */
export interface PublicClobTermsTransport {
  get(path: string): Promise<PublicClobTermsTransportResponse>;
}

export class FetchPublicClobTermsTransport implements PublicClobTermsTransport {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = DEFAULT_CLOB_BASE,
  ) {
    if (!/^https:\/\/[^/]+(?:\/[^?#]*)?$/.test(baseUrl)) throw new TypeError("public CLOB baseUrl must be https");
  }

  async get(path: string): Promise<PublicClobTermsTransportResponse> {
    if (!path.startsWith("/") || path.includes("#")) throw new TypeError("public CLOB path is invalid");
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
    });
    return Object.freeze({ status: response.status, body: await response.text() });
  }
}

export interface PublicClobFeeCollectionResolution {
  readonly convention: "usdc" | "shares";
  readonly authority: string;
  readonly contractVersion: string;
}

export interface PublicClobFeeCollectionContract {
  readonly version: string;
  resolve(input: {
    readonly conditionId: string;
    readonly tokenId: string;
    readonly feeRateBps: string;
  }): PublicClobFeeCollectionResolution | null;
}

/**
 * Versioned authority for CLOB V2 taker fees. The cited Polymarket contract
 * states that taker fees are calculated in USDC. It is injected explicitly so
 * callers can omit/replace it and fail closed when that authority changes.
 */
export const POLYMARKET_CLOB_V2_USDC_TAKER_FEE_CONTRACT: PublicClobFeeCollectionContract = Object.freeze({
  version: "polymarket-clob-v2-usdc-taker-fee-2026-04-28",
  resolve: ({ conditionId, tokenId, feeRateBps }: {
    readonly conditionId: string;
    readonly tokenId: string;
    readonly feeRateBps: string;
  }) => {
    if (conditionId.length === 0 || tokenId.length === 0 || !EXACT_UNSIGNED_INTEGER.test(feeRateBps)) return null;
    return Object.freeze({
      convention: "usdc" as const,
      authority: "https://docs.polymarket.com/trading/fees",
      contractVersion: "polymarket-clob-v2-usdc-taker-fee-2026-04-28",
    });
  },
});

export interface PublicClobRawTokenTerms {
  readonly tokenId: string;
  readonly rawFeeRate: string;
  readonly rawTickSize: string;
  readonly rawMinimumOrderShares: string;
  readonly rawVenueMetadata: Readonly<Record<string, string>>;
  readonly source: string;
  readonly effectiveAtMs: number;
}

export interface PublicClobTokenTermsHealth {
  readonly requiredTokenCount: number;
  readonly feeTermsHealthy: boolean;
  readonly constraintTermsHealthy: boolean;
  readonly lastFeeSnapshotAtMs: number | null;
  readonly lastConstraintSnapshotAtMs: number | null;
}

export interface PublicClobTokenTermsSourceOptions {
  readonly transport?: PublicClobTermsTransport;
  readonly nowMs?: () => number;
  readonly feeCollectionContract?: PublicClobFeeCollectionContract;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function parseJsonObject(body: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new TypeError(`${label} is not valid JSON`); }
  return object(value, label);
}

function requiredString(row: Record<string, unknown>, key: string, label: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label}.${key} must be a non-empty string`);
  return value;
}

function exactDecimal(row: Record<string, unknown>, key: string, label: string): string {
  const value = requiredString(row, key, label);
  if (!EXACT_UNSIGNED_DECIMAL_6.test(value)) throw new TypeError(`${label}.${key} must be an exact decimal string with at most six places`);
  return value;
}

function parseExactFeeRateBps(body: string): string {
  // Parse the integer lexeme from the wire. JSON.parse would first convert it
  // to IEEE-754 Number and destroy exactness for sufficiently large integers.
  const match = /^\s*\{\s*"base_fee"\s*:\s*(0|[1-9]\d*)\s*\}\s*$/.exec(body);
  if (!match) throw new TypeError("CLOB fee-rate response must contain only an integer base_fee");
  const bps = match[1]!;
  if (BigInt(bps) > 10_000n) throw new TypeError("CLOB base_fee must be between 0 and 10000 basis points");
  return bps;
}

/** Exact basis-point integer to canonical decimal rate (30 -> "0.003"). */
export function exactBasisPointsToRate(bps: string): string {
  if (!EXACT_UNSIGNED_INTEGER.test(bps)) throw new TypeError("basis points must be a canonical unsigned integer");
  const exact = BigInt(bps);
  if (exact > 10_000n) throw new RangeError("basis points must not exceed 10000");
  const whole = exact / 10_000n;
  const remainder = exact % 10_000n;
  if (remainder === 0n) return whole.toString(10);
  return `${whole}.${remainder.toString(10).padStart(4, "0").replace(/0+$/, "")}`;
}

function validateNow(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
}

function minimumTimestamp(values: readonly (number | undefined)[]): number | null {
  if (values.length === 0 || values.some((value) => value === undefined)) return null;
  return Math.min(...values as number[]);
}

function current(timestamp: number | undefined, asOfMs: number, maximumAgeMs: number): boolean {
  return timestamp !== undefined && timestamp <= asOfMs && asOfMs - timestamp <= maximumAgeMs;
}

/**
 * Public, unauthenticated, token-isolated source for exact pair constraints and
 * fee terms. It never constructs a wallet/signer or sends credentials.
 */
export class PublicClobTokenTermsSource {
  private readonly transport: PublicClobTermsTransport;
  private readonly nowMs: () => number;
  private readonly feeCollectionContract: PublicClobFeeCollectionContract | undefined;
  private readonly feeSuccessAtMs = new Map<string, number>();
  private readonly constraintSuccessAtMs = new Map<string, number>();

  constructor(options: PublicClobTokenTermsSourceOptions = {}) {
    this.transport = options.transport ?? new FetchPublicClobTermsTransport();
    this.nowMs = options.nowMs ?? Date.now;
    this.feeCollectionContract = options.feeCollectionContract;
    if (this.feeCollectionContract !== undefined && this.feeCollectionContract.version.trim().length === 0) {
      throw new TypeError("fee collection contract version must be non-empty");
    }
  }

  async fetchTokenTerms(input: {
    readonly marketId: string;
    readonly conditionId: string;
    readonly tokenId: string;
    readonly asOfMs: number;
  }): Promise<PublicClobRawTokenTerms | null> {
    if (input.marketId.trim().length === 0 || input.conditionId.trim().length === 0 || input.tokenId.trim().length === 0) {
      throw new TypeError("marketId, conditionId, and tokenId must be non-empty");
    }
    validateNow(input.asOfMs, "terms asOfMs");
    const encodedToken = encodeURIComponent(input.tokenId);
    const [bookResponse, feeResponse] = await Promise.all([
      this.transport.get(`/book?token_id=${encodedToken}`),
      this.transport.get(`/fee-rate?token_id=${encodedToken}`),
    ]);
    if (bookResponse.status !== 200) throw new Error(`public CLOB /book HTTP ${bookResponse.status}`);
    if (feeResponse.status !== 200) throw new Error(`public CLOB /fee-rate HTTP ${feeResponse.status}`);

    const fetchedAtMs = this.nowMs();
    validateNow(fetchedAtMs, "terms fetchedAtMs");
    const book = parseJsonObject(bookResponse.body, "CLOB book response");
    const returnedToken = requiredString(book, "asset_id", "CLOB book response");
    const returnedCondition = requiredString(book, "market", "CLOB book response");
    if (returnedToken !== input.tokenId) throw new TypeError(`CLOB book token mismatch: requested ${input.tokenId}, received ${returnedToken}`);
    if (returnedCondition !== input.conditionId) throw new TypeError(`CLOB book condition mismatch: requested ${input.conditionId}, received ${returnedCondition}`);
    const rawTickSize = exactDecimal(book, "tick_size", "CLOB book response");
    const rawMinimumOrderShares = exactDecimal(book, "min_order_size", "CLOB book response");
    this.constraintSuccessAtMs.set(input.tokenId, fetchedAtMs);

    const feeRateBps = parseExactFeeRateBps(feeResponse.body);
    const resolution = this.feeCollectionContract?.resolve({
      conditionId: input.conditionId,
      tokenId: input.tokenId,
      feeRateBps,
    }) ?? null;
    if (resolution === null || resolution.contractVersion !== this.feeCollectionContract?.version ||
      resolution.authority.trim().length === 0 || !["usdc", "shares"].includes(resolution.convention)) return null;
    this.feeSuccessAtMs.set(input.tokenId, fetchedAtMs);

    return Object.freeze({
      tokenId: input.tokenId,
      rawFeeRate: exactBasisPointsToRate(feeRateBps),
      rawTickSize,
      rawMinimumOrderShares,
      rawVenueMetadata: Object.freeze({
        fee_collection: resolution.convention,
        fee_collection_authority: resolution.authority,
        fee_collection_contract_version: resolution.contractVersion,
        fee_rate_basis_points: feeRateBps,
        fee_rate_unit: "basis_points",
        fee_type: "clob_public_base_fee",
      }),
      source: "polymarket_public_clob_rest_v1",
      // The CLOB endpoints expose current values, not an upstream effective
      // timestamp. Never claim they were effective later than the decision.
      effectiveAtMs: Math.min(input.asOfMs, fetchedAtMs),
    });
  }

  health(input: {
    readonly tokenIds: readonly string[];
    readonly asOfMs: number;
    readonly maximumFeeAgeMs: number;
    readonly maximumConstraintAgeMs: number;
  }): PublicClobTokenTermsHealth {
    validateNow(input.asOfMs, "health asOfMs");
    for (const [label, value] of [["maximumFeeAgeMs", input.maximumFeeAgeMs], ["maximumConstraintAgeMs", input.maximumConstraintAgeMs]] as const) {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
    }
    const tokenIds = [...new Set(input.tokenIds)];
    if (tokenIds.some((tokenId) => tokenId.trim().length === 0)) throw new TypeError("health token ids must be non-empty");
    const feeTimes = tokenIds.map((tokenId) => this.feeSuccessAtMs.get(tokenId));
    const constraintTimes = tokenIds.map((tokenId) => this.constraintSuccessAtMs.get(tokenId));
    return Object.freeze({
      requiredTokenCount: tokenIds.length,
      feeTermsHealthy: tokenIds.length > 0 && feeTimes.every((timestamp) => current(timestamp, input.asOfMs, input.maximumFeeAgeMs)),
      constraintTermsHealthy: tokenIds.length > 0 && constraintTimes.every((timestamp) => current(timestamp, input.asOfMs, input.maximumConstraintAgeMs)),
      lastFeeSnapshotAtMs: minimumTimestamp(feeTimes),
      lastConstraintSnapshotAtMs: minimumTimestamp(constraintTimes),
    });
  }
}
