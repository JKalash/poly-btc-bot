import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

const scrypt = (password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, buf) => (err ? reject(err) : resolve(buf))));

/** Compare secret strings without leaking their first differing byte. */
export function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * Single-operator auth. scrypt password hashing, HMAC-signed opaque session
 * tokens, double-submit CSRF token, simple login rate limiting. Short
 * sessions are kept in memory and end on API restart. Remembered sessions are
 * self-contained signed cookies so they can honor the 30-day browser cookie.
 * Secrets never reach the browser beyond the HTTP-only session cookie.
 */

export interface SessionInfo {
  username: string;
  createdAtMs: number;
  expiresAtMs: number;
  csrfToken: string;
}

const SESSION_TTL_MS = 12 * 3600 * 1000;
export const REMEMBERED_SESSION_TTL_SECONDS = 30 * 24 * 3600;

interface PersistentSessionPayload {
  u: string;
  c: string;
  iat: number;
  exp: number;
  r: true;
}

export class AuthService {
  private sessions = new Map<string, SessionInfo>();
  private loginAttempts = new Map<string, { count: number; windowStartMs: number }>();
  private readonly secret: string;
  readonly devFallback: boolean;
  private passwordHash: string;
  readonly username: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.username = env.OPERATOR_USERNAME || "operator";
    const secret = env.SESSION_SECRET;
    if (secret && secret !== "change-me-generate-a-real-secret") {
      this.secret = secret;
      this.devFallback = false;
    } else {
      this.secret = randomBytes(32).toString("hex");
      this.devFallback = true;
    }
    this.passwordHash = env.OPERATOR_PASSWORD_HASH || "";
  }

  /** Hash format: scrypt$N$r$p$salthex$hashhex */
  static async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const N = 16384, r = 8, p = 1;
    const buf = await scrypt(password, salt, 32, { N, r, p });
    return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${buf.toString("hex")}`;
  }

  static async verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, nS, rS, pS, saltHex, hashHex] = parts;
    const buf = (await scrypt(password, Buffer.from(saltHex!, "hex"), 32, {
      N: Number(nS), r: Number(rS), p: Number(pS),
    })) as Buffer;
    const expected = Buffer.from(hashHex!, "hex");
    return buf.length === expected.length && timingSafeEqual(buf, expected);
  }

  /** Re-verify the operator password for a sensitive control (live arming). */
  async reverify(password: string): Promise<boolean> {
    return AuthService.verifyPassword(password, this.passwordHash);
  }

  async ensurePasswordHash(): Promise<{ devDefault: boolean }> {
    if (this.passwordHash) return { devDefault: false };
    this.passwordHash = await AuthService.hashPassword("operator");
    return { devDefault: true };
  }

  rateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = this.loginAttempts.get(ip);
    if (!entry || now - entry.windowStartMs > 60_000) {
      this.loginAttempts.set(ip, { count: 1, windowStartMs: now });
      return false;
    }
    entry.count += 1;
    return entry.count > 5;
  }

  async login(username: string, password: string, remember = false): Promise<{ token: string; csrfToken: string } | null> {
    if (username !== this.username) return null;
    if (!(await AuthService.verifyPassword(password, this.passwordHash))) return null;
    const csrfToken = randomBytes(16).toString("hex");
    const now = Date.now();
    if (remember) {
      const payload: PersistentSessionPayload = {
        u: username,
        c: csrfToken,
        iat: now,
        exp: now + REMEMBERED_SESSION_TTL_SECONDS * 1000,
        r: true,
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return { token: `v1.${encoded}.${this.sign(encoded)}`, csrfToken };
    }

    const raw = randomBytes(32).toString("hex");
    const token = `${raw}.${this.sign(raw)}`;
    this.sessions.set(raw, {
      username,
      createdAtMs: now,
      expiresAtMs: now + SESSION_TTL_MS,
      csrfToken,
    });
    return { token, csrfToken };
  }

  validate(token: string | undefined): SessionInfo | null {
    if (!token) return null;
    const remembered = this.validatePersistent(token);
    if (remembered) return remembered;
    const [raw, sig] = token.split(".");
    if (!raw || !sig || !timingSafeStringEqual(sig, this.sign(raw))) return null;
    const s = this.sessions.get(raw);
    if (!s) return null;
    if (Date.now() > s.expiresAtMs) {
      this.sessions.delete(raw);
      return null;
    }
    return s;
  }

  logout(token: string | undefined): void {
    if (!token) return;
    const raw = token.split(".")[0];
    if (raw) this.sessions.delete(raw);
  }

  private sign(raw: string): string {
    return createHmac("sha256", this.secret).update(raw).digest("hex").slice(0, 32);
  }

  private validatePersistent(token: string): SessionInfo | null {
    const [version, encoded, sig] = token.split(".");
    if (version !== "v1" || !encoded || !sig || !timingSafeStringEqual(sig, this.sign(encoded))) return null;
    let payload: PersistentSessionPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as PersistentSessionPayload;
    } catch {
      return null;
    }
    if (
      payload.r !== true ||
      payload.u !== this.username ||
      typeof payload.c !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.iat) ||
      !Number.isFinite(payload.exp) ||
      Date.now() > payload.exp
    ) {
      return null;
    }
    return {
      username: payload.u,
      csrfToken: payload.c,
      createdAtMs: payload.iat,
      expiresAtMs: payload.exp,
    };
  }

  // one-time WebSocket tickets (cookie can't cross the dev proxy boundary for WS)
  private wsTickets = new Map<string, number>();

  issueWsTicket(session: SessionInfo): string {
    void session;
    const t = randomBytes(16).toString("hex");
    this.wsTickets.set(t, Date.now() + 30_000);
    return t;
  }

  redeemWsTicket(t: string | undefined): boolean {
    if (!t) return false;
    const exp = this.wsTickets.get(t);
    this.wsTickets.delete(t);
    return exp !== undefined && Date.now() <= exp;
  }
}
