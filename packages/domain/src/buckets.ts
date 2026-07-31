/** Time features. All calculations are UTC; display timezone is presentation-only. */

export const CLOSING_MINUTE_BUCKETS = ["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"] as const;
export type ClosingMinuteBucket = (typeof CLOSING_MINUTE_BUCKETS)[number];

export function closingMinuteBucket(endEpochSec: number): ClosingMinuteBucket {
  const minute = Math.floor(endEpochSec / 60) % 60;
  const bucket = Math.floor(minute / 5) * 5;
  return String(bucket).padStart(2, "0") as ClosingMinuteBucket;
}

export const isQuarterHourClose = (endEpochSec: number): boolean => (Math.floor(endEpochSec / 60) % 15) === 0;
export const isTopOfHourClose = (endEpochSec: number): boolean => (Math.floor(endEpochSec / 60) % 60) === 0;

export function utcHour(epochSec: number): number {
  return Math.floor(epochSec / 3600) % 24;
}

export function dayOfWeekUtc(epochSec: number): number {
  // 1970-01-01 was a Thursday (=4)
  return (Math.floor(epochSec / 86400) + 4) % 7;
}

export type SessionLabel = "asia" | "europe" | "eu_us_overlap" | "us" | "low_liquidity";

/** Coarse session labels (UTC hours). Approximate by design; used as categorical features only. */
export function sessionLabel(epochSec: number): SessionLabel {
  const h = utcHour(epochSec);
  if (h < 7) return "asia";
  if (h < 13) return "europe";
  if (h < 16) return "eu_us_overlap";
  if (h < 21) return "us";
  return "low_liquidity";
}

/** Slot start epoch (300s aligned) for a timestamp. */
export const slotStartEpoch = (epochSec: number): number => Math.floor(epochSec / 300) * 300;
export const SLOT_SECONDS = 300;
