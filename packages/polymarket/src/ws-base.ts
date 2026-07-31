/**
 * Reconnecting WebSocket base using Node 22's native WebSocket.
 * - Application-level text PING on a fixed interval (Polymarket requires it).
 * - Exponential backoff reconnect with resubscribe hook.
 * - Staleness tracking via lastMessageTsMs.
 */
export interface WsBaseOptions {
  url: string;
  name: string;
  pingIntervalMs: number;
  pingText?: string;
  onOpen: (send: (data: string) => void) => void;
  onMessage: (data: string, receivedTsMs: number) => void;
  onStatus?: (status: WsStatus, detail?: string) => void;
}

export type WsStatus = "connecting" | "open" | "closed" | "reconnecting" | "error";

export class ReconnectingWs {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private stopped = false;
  lastMessageTsMs = 0;
  reconnectCount = 0;

  constructor(private readonly opts: WsBaseOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    this.opts.onStatus?.("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.scheduleReconnect(String(e));
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 1000;
      this.opts.onStatus?.("open");
      this.opts.onOpen((data) => this.send(data));
      this.pingTimer = setInterval(() => this.send(this.opts.pingText ?? "PING"), this.opts.pingIntervalMs);
    };
    ws.onmessage = (ev) => {
      const now = Date.now();
      this.lastMessageTsMs = now;
      const data = typeof ev.data === "string" ? ev.data : "";
      if (data === "PONG" || data === "") return;
      this.opts.onMessage(data, now);
    };
    ws.onerror = () => {
      this.opts.onStatus?.("error");
    };
    ws.onclose = () => {
      this.cleanup();
      if (!this.stopped) this.scheduleReconnect("closed");
    };
  }

  private scheduleReconnect(detail: string): void {
    this.opts.onStatus?.("reconnecting", detail);
    this.reconnectCount++;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(30_000, this.backoffMs * 2);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private cleanup(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(data); } catch { /* connection raced shut; reconnect will resubscribe */ }
    }
  }

  stop(): void {
    this.stopped = true;
    this.cleanup();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.opts.onStatus?.("closed");
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }

  ageMs(now = Date.now()): number | null {
    return this.lastMessageTsMs === 0 ? null : now - this.lastMessageTsMs;
  }
}
