import { ONE, PPM, mulDiv, type Ppm, type Prob6, type Shares6, type Usdc6 } from "./fixed";

/**
 * Stake required (as bankroll fraction, ppm) to earn `g` of bankroll on a WINNING
 * maker buy at price p:  stake_fraction = g * p / (1 - p).
 * Rounded UP: overstating required stake is conservative because it trips caps sooner.
 * This calculator NEVER authorizes anything; it exists to show why fixed return
 * targets at high prices are incompatible with bounded risk.
 */
export function targetReturnStakeFraction(gPpm: Ppm, p: Prob6): Ppm {
  if (p >= ONE) throw new Error("price must be < 1");
  return mulDiv(gPpm, p, ONE - p, "ceil");
}

export function stakeFromFraction(bankroll: Usdc6, fracPpm: Ppm): Usdc6 {
  return mulDiv(bankroll, fracPpm, PPM, "floor");
}

/** Maker buy: stake (max loss) equals cost; shares = stake / p, floored to whole micro-shares. */
export function sharesForStake(stake: Usdc6, p: Prob6): Shares6 {
  if (p <= 0n) throw new Error("price must be > 0");
  return mulDiv(stake, ONE, p, "floor");
}

export function costOfShares(sh: Shares6, p: Prob6): Usdc6 {
  return mulDiv(sh, p, ONE, "ceil");
}

/** Round shares DOWN to the market's minimum order increment / respect min size. */
export function roundSharesToLot(sh: Shares6, lot: Shares6): Shares6 {
  if (lot <= 0n) return sh;
  return (sh / lot) * lot;
}

export interface CapResult {
  finalPpm: Ppm;
  binding: string;
  caps: Array<{ name: string; capPpm: Ppm }>;
}

/** Apply a cap chain; result is min(requested, caps...) with the binding cap identified. */
export function applyCapChain(requestedPpm: Ppm, caps: Array<{ name: string; capPpm: Ppm }>): CapResult {
  let final = requestedPpm;
  let binding = "requested";
  for (const c of caps) {
    if (c.capPpm < final) {
      final = c.capPpm;
      binding = c.name;
    }
  }
  if (final < 0n) final = 0n;
  return { finalPpm: final, binding, caps };
}

/** Bankroll multiplier (ppm of starting bankroll) after n consecutive full losses of `fracPpm`. */
export function bankrollAfterLosses(fracPpm: Ppm, n: number): Ppm {
  let acc = PPM;
  for (let i = 0; i < n; i++) acc = mulDiv(acc, PPM - fracPpm, PPM, "floor");
  return acc;
}
