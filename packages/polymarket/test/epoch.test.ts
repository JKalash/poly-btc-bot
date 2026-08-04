/**
 * BPAIR-010 — connection epochs on the reconnecting WS layer (spec §12.3,
 * §10.5): a fresh epoch per (re)connect, onEpochChange fired BEFORE
 * resubscribe/messages of the new connection, and every parsed CLOB message
 * stamped with the delivering connection's epoch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClobMarketWs, ReconnectingWs, type ClobMessageMeta } from "../src/index";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
  // test helpers
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  message(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function baseOpts(overrides: Partial<ConstructorParameters<typeof ReconnectingWs>[0]> = {}) {
  return {
    url: "wss://fake.example/ws",
    name: "test",
    pingIntervalMs: 5000,
    onOpen: () => {},
    onMessage: () => {},
    ...overrides,
  };
}

describe("ReconnectingWs connection epochs (§12.3)", () => {
  it("connectionEpoch is null before the first successful open", () => {
    const ws = new ReconnectingWs(baseOpts());
    expect(ws.connectionEpoch).toBeNull();
    ws.start();
    expect(ws.connectionEpoch).toBeNull(); // still connecting
    ws.stop();
  });

  it("generates a fresh epoch on every (re)connect and reports the previous one", () => {
    const epochs: Array<[string, string | null]> = [];
    const ws = new ReconnectingWs(baseOpts({ onEpochChange: (e, p) => epochs.push([e, p]) }));
    ws.start();
    FakeWebSocket.instances[0]!.open();
    const epoch1 = ws.connectionEpoch!;
    expect(epoch1).toBeTruthy();
    expect(epochs).toEqual([[epoch1, null]]);

    FakeWebSocket.instances[0]!.close(); // drop -> backoff reconnect
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1]!.open();
    const epoch2 = ws.connectionEpoch!;
    expect(epoch2).not.toBe(epoch1);
    expect(epochs).toEqual([[epoch1, null], [epoch2, epoch1]]);
    expect(ws.reconnectCount).toBe(1);
    ws.stop();
  });

  it("fires onEpochChange BEFORE onStatus(open) and before onOpen/resubscribe", () => {
    const order: string[] = [];
    const ws = new ReconnectingWs(baseOpts({
      onEpochChange: () => order.push("epoch"),
      onStatus: (s) => order.push(`status:${s}`),
      onOpen: () => order.push("resubscribe"),
    }));
    ws.start();
    FakeWebSocket.instances[0]!.open();
    expect(order).toEqual(["status:connecting", "epoch", "status:open", "resubscribe"]);
    ws.stop();
  });
});

const bookMsg = {
  event_type: "book",
  market: "0xmkt",
  asset_id: "123",
  timestamp: "1700000000000",
  hash: "book-hash-1",
  bids: [{ price: "0.4", size: "10" }],
  asks: [{ price: "0.6", size: "5" }],
};

const priceChangeMsg = {
  event_type: "price_change",
  market: "0xmkt",
  timestamp: "1700000000500",
  price_changes: [
    { asset_id: "123", price: "0.41", size: "7", side: "BUY", hash: "pc-hash-1", best_bid: "0.41", best_ask: "0.6" },
  ],
};

describe("ClobMarketWs epoch stamping (§10.5 retention)", () => {
  function makeClob() {
    const cb = {
      onBook: vi.fn(),
      onPriceChange: vi.fn(),
      onLastTrade: vi.fn(),
      onEpochChange: vi.fn(),
    };
    const clob = new ClobMarketWs(cb);
    clob.setAssets(["123"]);
    clob.start();
    return { cb, clob };
  }

  it("stamps every parsed message with the delivering connection's epoch", () => {
    const { cb, clob } = makeClob();
    const inst = FakeWebSocket.instances[0]!;
    inst.open();
    const epoch1 = clob.connectionEpoch!;
    expect(cb.onEpochChange).toHaveBeenCalledWith(epoch1, null);
    expect(inst.sent).toContain(JSON.stringify({ assets_ids: ["123"], type: "market" }));

    inst.message([bookMsg]); // initial delivery is an ARRAY of book snapshots
    expect(cb.onBook).toHaveBeenCalledTimes(1);
    const [bMsg, , bMeta] = cb.onBook.mock.calls[0]! as [typeof bookMsg, number, ClobMessageMeta];
    expect(bMsg.hash).toBe("book-hash-1"); // exchange hash retained on the message itself
    expect(bMeta.connectionEpoch).toBe(epoch1);

    inst.message(priceChangeMsg);
    const [pMsg, , pMeta] = cb.onPriceChange.mock.calls[0]! as [typeof priceChangeMsg, number, ClobMessageMeta];
    expect(pMsg.price_changes[0]!.hash).toBe("pc-hash-1");
    expect(pMeta.connectionEpoch).toBe(epoch1);
    clob.stop();
  });

  it("messages after a reconnect carry the NEW epoch; the reset is surfaced first", () => {
    const { cb, clob } = makeClob();
    FakeWebSocket.instances[0]!.open();
    const epoch1 = clob.connectionEpoch!;
    FakeWebSocket.instances[0]!.message(priceChangeMsg);

    FakeWebSocket.instances[0]!.close();
    vi.advanceTimersByTime(1000);
    const inst2 = FakeWebSocket.instances[1]!;
    inst2.open();
    const epoch2 = clob.connectionEpoch!;
    expect(epoch2).not.toBe(epoch1);
    expect(cb.onEpochChange).toHaveBeenNthCalledWith(2, epoch2, epoch1);
    // resubscribe happened on the new connection after the epoch change
    expect(inst2.sent).toContain(JSON.stringify({ assets_ids: ["123"], type: "market" }));

    inst2.message(priceChangeMsg);
    const metas = cb.onPriceChange.mock.calls.map((c) => (c[2] as ClobMessageMeta).connectionEpoch);
    expect(metas).toEqual([epoch1, epoch2]);
    clob.stop();
  });

  it("existing two-argument callbacks and PONG filtering keep working unchanged", () => {
    let seen = 0;
    // legacy consumer shape: no meta parameter, no onEpochChange
    const clob = new ClobMarketWs({
      onBook: () => { seen++; },
      onPriceChange: () => { seen++; },
      onLastTrade: () => { seen++; },
    });
    clob.setAssets(["123"]);
    clob.start();
    const inst = FakeWebSocket.instances[0]!;
    inst.open();
    inst.message("PONG"); // filtered in ws-base, never dispatched
    inst.message([bookMsg]);
    inst.message(priceChangeMsg);
    expect(seen).toBe(2);
    expect(clob.connectionEpoch).not.toBeNull();
    clob.stop();
  });
});
