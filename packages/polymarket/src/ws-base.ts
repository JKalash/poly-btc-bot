import { randomUUID } from "node:crypto";

/**
 * Reconnecting WebSocket base using Node 22's native WebSocket.
 * - Application-level text PING on a fixed interval (Polymarket requires it).
 * - Staleness watchdog: a connection with no inbound message (data OR PONG)
 *   for staleAfterMs is force-closed and reconnected — `onclose` alone never
 *   fires on half-open TCP paths (NAT/LB silently dropping the route), which
 *   would otherwise starve every feed until a human restarts the process.
 * - Exponential backoff reconnect with resubscribe hook. Backoff resets only
 *   after the connection PROVES healthy (first inbound message), not on the
 *   handshake — accept-then-drop failures back off properly instead of
 *   hammering the endpoint at 1 Hz forever.
 * - Generation-tokened: events from superseded sockets are ignored, so
 *   restart()/stop()/start() can never yield two live sockets or leaked
 *   ping timers feeding duplicate data.
 * - A throwing onMessage handler drops that message (status "error"), never
 *   the socket or the process.
 * - Connection epochs (spec §12.3): every successful (re)connect generates a
 *   fresh `connectionEpoch` BEFORE any message of that connection is
 *   delivered, so consumers can invalidate stale books first.
 */
export interface WsBaseOptions {
  url: string;
  name: string;
  pingIntervalMs: number;
  pingText?: string;
  /** Force-reconnect threshold for inbound silence. Default max(15s, 3× ping interval). */
  staleAfterMs?: number;
  onOpen: (send: (data: string) => void) => void;
  onMessage: (data: string, receivedTsMs: number) => void;
  onStatus?: (status: WsStatus, detail?: string) => void;
  /**
   * Fired once per (re)connect, when the fresh connection epoch is generated —
   * strictly BEFORE onStatus("open"), onOpen/resubscribe, and any onMessage of
   * the new connection. `prevEpoch` is null on the first connect. Optional:
   * existing consumers are unaffected.
   */
  onEpochChange?: (epoch: string, prevEpoch: string | null) => void;
}

export type WsStatus = "connecting" | "open" | "closed" | "reconnecting" | "error";

export class ReconnectingWs {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  // A newly constructed transport is not started. This keeps a pre-start
  // subscription update/restart request from creating a hidden socket that
  // `start()` immediately supersedes.
  private stopped = true;
  /** Monotonic connection token: handlers from superseded sockets no-op. */
  private generation = 0;
  private epoch: string | null = null;
  lastMessageTsMs = 0;
  reconnectCount = 0;

  constructor(private readonly opts: WsBaseOptions) {}

  /** Epoch of the current connection; null until the first successful open. */
  get connectionEpoch(): string | null { return this.epoch; }

  start(): void {
    this.stopped = false;
    this.clearReconnectTimer();
    this.connect();
  }

  private staleAfterMs(): number {
    return this.opts.staleAfterMs ?? Math.max(15_000, this.opts.pingIntervalMs * 3);
  }

  private connect(): void {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.teardownSocket(); // supersede any existing socket before opening a new one
    this.opts.onStatus?.("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.scheduleReconnect(String(e));
      return;
    }
    this.ws = ws;
    const openedAtMs = Date.now();
    let proven = false; // healthy = at least one inbound message on THIS socket

    ws.onopen = () => {
      if (gen !== this.generation) return;
      const prevEpoch = this.epoch;
      this.epoch = randomUUID();
      this.opts.onEpochChange?.(this.epoch, prevEpoch);
      this.opts.onStatus?.("open");
      this.opts.onOpen((data) => this.send(data));
      this.pingTimer = setInterval(() => {
        if (gen !== this.generation) return;
        this.send(this.opts.pingText ?? "PING");
        // Watchdog: silence beyond the threshold means the path is dead even
        // though readyState says OPEN. Measured per-connection so a fresh
        // socket gets a full grace period.
        const lastSeen = Math.max(this.lastMessageTsMs, openedAtMs);
        const idleMs = Date.now() - lastSeen;
        if (idleMs > this.staleAfterMs()) {
          this.forceReconnect(gen, `stale: no inbound message for ${idleMs}ms`);
        }
      }, this.opts.pingIntervalMs);
    };
    ws.onmessage = (ev) => {
      if (gen !== this.generation) return;
      const now = Date.now();
      this.lastMessageTsMs = now;
      if (!proven) {
        proven = true;
        this.backoffMs = 1000; // healthy: proven by inbound data, not by the handshake
      }
      const data = typeof ev.data === "string" ? ev.data : "";
      if (data === "PONG" || data === "") return;
      try {
        this.opts.onMessage(data, now);
      } catch (e) {
        // one malformed message must never take down the socket or the process
        this.opts.onStatus?.("error", `onMessage handler threw (message dropped): ${String(e)}`);
      }
    };
    ws.onerror = () => {
      if (gen === this.generation) this.opts.onStatus?.("error");
    };
    ws.onclose = () => {
      if (gen !== this.generation) return; // superseded socket: ignore
      this.cleanup();
      this.ws = null;
      if (!this.stopped) this.scheduleReconnect("closed");
    };
  }

  /** Public forced reconnect (e.g. subscription set changed). Immediate, keeps backoff state. */
  restart(reason: string): void {
    if (this.stopped) return;
    this.opts.onStatus?.("reconnecting", reason);
    this.reconnectCount++;
    this.clearReconnectTimer();
    this.connect();
  }

  private forceReconnect(gen: number, why: string): void {
    if (gen !== this.generation || this.stopped) return;
    this.opts.onStatus?.("error", why);
    this.cleanup();
    this.teardownSocket();
    this.scheduleReconnect(why);
  }

  private scheduleReconnect(detail: string): void {
    if (this.stopped) return;
    this.clearReconnectTimer();
    this.opts.onStatus?.("reconnecting", detail);
    this.reconnectCount++;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(30_000, this.backoffMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private cleanup(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  /** Detach and close the current socket without triggering reconnect logic. */
  private teardownSocket(): void {
    const old = this.ws;
    this.ws = null;
    if (!old) return;
    old.onopen = null;
    old.onmessage = null;
    old.onerror = null;
    old.onclose = null;
    try { old.close(); } catch { /* already closed */ }
  }

  send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(data); } catch { /* connection raced shut; reconnect will resubscribe */ }
    }
  }

  stop(): void {
    this.stopped = true;
    this.generation++; // invalidate every in-flight socket event
    this.cleanup();
    this.clearReconnectTimer();
    this.opts.onStatus?.("closed");
    this.teardownSocket();
  }

  ageMs(now = Date.now()): number | null {
    return this.lastMessageTsMs === 0 ? null : now - this.lastMessageTsMs;
  }
}
