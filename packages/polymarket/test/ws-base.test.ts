import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconnectingWs } from "../src/ws-base";

/**
 * Fake native WebSocket driven by fake timers. Instances register globally so
 * tests can fire open/message/close on specific sockets and count how many
 * live sockets exist — the exact failure modes of #19/#20/#24.
 */
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(d: string): void { this.sent.push(d); }
  close(): void { this.closed = true; }
  open(): void { this.onopen?.(); }
  message(data: string): void { this.onmessage?.({ data }); }
  serverClose(): void { this.onclose?.(); }
}

let received: string[];
let statuses: Array<{ s: string; d?: string }>;

function makeWs(staleAfterMs?: number): ReconnectingWs {
  return new ReconnectingWs({
    url: "wss://example.test/ws",
    name: "test",
    pingIntervalMs: 5000,
    ...(staleAfterMs !== undefined ? { staleAfterMs } : {}),
    onOpen: (send) => send("SUBSCRIBE"),
    onMessage: (data) => {
      if (data === "BOOM") throw new Error("bad payload");
      received.push(data);
    },
    onStatus: (s, d) => statuses.push({ s, ...(d !== undefined ? { d } : {}) }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.instances = [];
  received = [];
  statuses = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ReconnectingWs", () => {
  it("#24: stop()/start() never yields two live sockets; stale-socket events are ignored", () => {
    const ws = makeWs();
    ws.start();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    ws.stop();
    ws.start();
    const second = FakeWebSocket.instances[1]!;
    second.open();
    // the OLD socket's late close must not schedule a third connection
    // (advance under the staleness threshold so the watchdog stays quiet)
    first.serverClose();
    vi.advanceTimersByTime(5_000);
    expect(FakeWebSocket.instances.length).toBe(2);
    // and messages from the OLD socket are dropped, not double-fed
    first.message("stale-data");
    second.message("fresh-data");
    expect(received).toEqual(["fresh-data"]);
  });

  it("#20: backoff grows across accept-then-drop cycles and resets only after inbound data", () => {
    const ws = makeWs();
    ws.start();
    // cycle 1: open then immediate close (no message) -> reconnect after 1s
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.serverClose();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances.length).toBe(2);
    // cycle 2: same. backoff must now be 2s, NOT reset to 1s by the handshake
    FakeWebSocket.instances[1]!.open();
    FakeWebSocket.instances[1]!.serverClose();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances.length).toBe(2); // still waiting: 1s < 2s
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances.length).toBe(3);
    // a PROVEN connection (inbound message) resets backoff to 1s
    FakeWebSocket.instances[2]!.open();
    FakeWebSocket.instances[2]!.message("PONG");
    FakeWebSocket.instances[2]!.serverClose();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances.length).toBe(4);
  });

  it("#19: silence beyond staleAfterMs force-reconnects a half-open socket", () => {
    const ws = makeWs(12_000);
    ws.start();
    const sock = FakeWebSocket.instances[0]!;
    sock.open();
    sock.message("tick"); // healthy at t=0
    // half-open: no close event ever fires, no messages arrive
    vi.advanceTimersByTime(15_000); // ping timer fires at 5s/10s/15s; idle > 12s at 15s
    expect(sock.closed).toBe(true); // watchdog force-closed the dead socket
    vi.advanceTimersByTime(1_000); // reconnect fires after the 1s backoff
    expect(FakeWebSocket.instances.length).toBe(2); // watchdog opened a replacement
    // replacement works normally
    FakeWebSocket.instances[1]!.open();
    FakeWebSocket.instances[1]!.message("tick2");
    expect(received).toEqual(["tick", "tick2"]);
  });

  it("#75: a throwing onMessage handler drops the message, not the socket", () => {
    const ws = makeWs();
    ws.start();
    const sock = FakeWebSocket.instances[0]!;
    sock.open();
    sock.message("BOOM");
    sock.message("good");
    expect(received).toEqual(["good"]);
    expect(sock.closed).toBe(false);
    expect(statuses.some((x) => x.s === "error" && (x.d ?? "").includes("dropped"))).toBe(true);
  });
});
