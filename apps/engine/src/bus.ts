import { EventEmitter } from "node:events";
import { logger } from "./log";

/**
 * Internal event bus. Redis pub/sub when REDIS_URL is set (split-process
 * deployment); otherwise an in-process emitter shared through globalThis so
 * the API can embed the engine in one process (zero-install dev mode).
 */
export interface Bus {
  publish(channel: string, payload: unknown): void;
  subscribe(channel: string, cb: (payload: unknown) => void): () => void;
  kind: "local" | "redis";
}

const GLOBAL_KEY = "__b5p_local_bus__";

export function getLocalBus(): Bus {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    const em = new EventEmitter();
    em.setMaxListeners(100);
    const bus: Bus = {
      kind: "local",
      publish: (ch, payload) => { em.emit(ch, payload); },
      subscribe: (ch, cb) => { em.on(ch, cb); return () => em.off(ch, cb); },
    };
    g[GLOBAL_KEY] = bus;
  }
  return g[GLOBAL_KEY] as Bus;
}

export async function makeBus(): Promise<Bus> {
  const url = process.env.REDIS_URL;
  if (!url) return getLocalBus();
  const { default: Redis } = await import("ioredis");
  const pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
  const sub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  sub.on("message", (channel: string, message: string) => {
    const hs = handlers.get(channel);
    if (!hs) return;
    let payload: unknown;
    try { payload = JSON.parse(message); } catch { payload = message; }
    for (const h of hs) {
      try { h(payload); } catch (e) { logger.error("bus handler error", { channel, error: String(e) }); }
    }
  });
  return {
    kind: "redis",
    publish: (ch, payload) => {
      void pub.publish(ch, JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    },
    subscribe: (ch, cb) => {
      if (!handlers.has(ch)) {
        handlers.set(ch, new Set());
        void sub.subscribe(ch);
      }
      handlers.get(ch)!.add(cb);
      return () => { handlers.get(ch)?.delete(cb); };
    },
  };
}

export const CHANNELS = {
  cockpit: "b5p:cockpit",
  events: "b5p:events",
  control: "b5p:control",
} as const;
