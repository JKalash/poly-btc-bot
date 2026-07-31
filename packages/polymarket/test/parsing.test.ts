import { describe, expect, it } from "vitest";
import { fullAccuracyToDecimalString, parseFiveMinMarket, resolvedOutcome, tsToMs, type GammaEvent } from "../src/index";

// Fixture distilled from a live Gamma response captured 2026-07-31.
const liveEvent: GammaEvent = {
  id: "770282",
  slug: "btc-updown-5m-1785454500",
  title: "Bitcoin Up or Down - July 30, 7:35PM-7:40PM ET",
  description: "This market will resolve to \"Up\" if the Bitcoin price at the end of the time range specified in the title is greater than or equal to the price at the beginning of that range. Otherwise, it will resolve to \"Down\".\nThe resolution source for this market is information from Chainlink, specifically the BTC/USD data stream available at https://data.chain.link/streams/btc-usd.",
  resolutionSource: "https://data.chain.link/streams/btc-usd",
  endDate: "2026-07-30T23:40:00Z",
  markets: [{
    id: "3214313",
    question: "Bitcoin Up or Down - July 30, 7:35PM-7:40PM ET",
    conditionId: "0x9e8824821c4f609e4afeca5b745f025bb68f941634ee192518815bf191ff2e7f",
    slug: "btc-updown-5m-1785454500",
    description: "resolution source ... Chainlink data stream BTC/USD ...",
    resolutionSource: "https://data.chain.link/streams/btc-usd",
    endDate: "2026-07-30T23:40:00Z",
    eventStartTime: "2026-07-30T23:35:00Z",
    outcomes: "[\"Up\", \"Down\"]",
    outcomePrices: "[\"0.605\", \"0.395\"]",
    clobTokenIds: "[\"56063598408828486386308049116060057201582593572746443264502751223375010727437\", \"6647042295508992092366898835694526788142885094648182505776590388394144641600\"]",
    orderPriceMinTickSize: 0.01,
    orderMinSize: 5,
    negRisk: false,
    active: true,
    closed: false,
    acceptingOrders: true,
    bestBid: 0.6,
    bestAsk: 0.61,
    feesEnabled: true,
    feeType: "crypto_fees_v2",
    feeSchedule: { exponent: 1, rate: 0.07, takerOnly: true, rebateRate: 0.2 },
  }],
} as unknown as GammaEvent;

describe("gamma parsing", () => {
  it("parses the live five-minute market shape", () => {
    const m = parseFiveMinMarket(liveEvent)!;
    expect(m).not.toBeNull();
    expect(m.startEpoch).toBe(1785454500);
    expect(m.endEpoch).toBe(1785454800);
    expect(m.upTokenId).toBe("56063598408828486386308049116060057201582593572746443264502751223375010727437");
    expect(m.downTokenId).toBe("6647042295508992092366898835694526788142885094648182505776590388394144641600");
    expect(m.tickSize).toBe(0.01);
    expect(m.minOrderSize).toBe(5);
    expect(m.feeSchedule).toEqual({ rate: 0.07, takerOnly: true, rebateRate: 0.2, feeType: "crypto_fees_v2" });
    expect(m.rulesNameChainlink).toBe(true);
  });

  it("detects resolved outcomes from outcome prices", () => {
    const resolvedUp = {
      ...liveEvent,
      markets: [{ ...liveEvent.markets[0]!, closed: true, outcomePrices: "[\"1\", \"0\"]" }],
    } as GammaEvent;
    expect(resolvedOutcome(parseFiveMinMarket(resolvedUp)!)).toBe("UP");
    const resolvedDown = {
      ...liveEvent,
      markets: [{ ...liveEvent.markets[0]!, closed: true, outcomePrices: "[\"0\", \"1\"]" }],
    } as GammaEvent;
    expect(resolvedOutcome(parseFiveMinMarket(resolvedDown)!)).toBe("DOWN");
    expect(resolvedOutcome(parseFiveMinMarket(liveEvent)!)).toBeNull(); // open market
  });

  it("flags markets whose rules do not name chainlink", () => {
    const weird = {
      ...liveEvent,
      markets: [{ ...liveEvent.markets[0]!, description: "resolves by coin flip", resolutionSource: "" }],
    } as GammaEvent;
    expect(parseFiveMinMarket(weird)!.rulesNameChainlink).toBe(false);
  });
});

describe("rtds helpers", () => {
  it("converts full-accuracy 1e18 strings exactly", () => {
    expect(fullAccuracyToDecimalString("64709288059102280000000")).toBe("64709.28805910228");
    expect(fullAccuracyToDecimalString("64722071000000000000000")).toBe("64722.071");
    expect(fullAccuracyToDecimalString("1000000000000000000")).toBe("1");
    expect(fullAccuracyToDecimalString("500000000000000000")).toBe("0.5");
  });
});

describe("clob helpers", () => {
  it("normalizes second/ms timestamps", () => {
    expect(tsToMs("1785458979800", 0)).toBe(1785458979800);
    expect(tsToMs("1785458979", 0)).toBe(1785458979000);
    expect(tsToMs(undefined, 42)).toBe(42);
  });
});
