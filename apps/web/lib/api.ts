"use client";

/** API client: same-origin (Next rewrites proxy to the API), CSRF from cookie for mutations. */

export function csrfToken(): string | null {
  const m = /(?:^|;\s*)b5p_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]!) : null;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.method && init.method !== "GET") {
    headers["content-type"] = "application/json";
    const t = csrfToken();
    if (t) headers["x-csrf-token"] = t;
  }
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    if (path === "/api/auth/login") {
      throw new Error((body as { error?: string }).error ?? "invalid credentials");
    }
    if (typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
      location.href = "/login";
    }
    throw new Error("unauthenticated");
  }
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as T;
}
