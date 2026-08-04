"use client";

import { useState } from "react";
import { api } from "../../lib/api";

export default function LoginPage() {
  const [username, setUsername] = useState("operator");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      location.href = "/";
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={(e) => void submit(e)} className="panel p-8 w-96">
        <h1 className="text-ink font-bold text-lg mb-1">BTC 5m Command Center</h1>
        <p className="text-[12px] text-muted mb-6">Single-operator console. Paper mode by default; live trading is disabled in this release.</p>
        <label htmlFor="username" className="block text-[12px] text-muted mb-1">Username</label>
        <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username"
          className="w-full bg-page border border-hairline rounded px-3 py-2 text-[13px] mb-4 text-ink focus:outline-none focus:border-up" />
        <label htmlFor="password" className="block text-[12px] text-muted mb-1">Password</label>
        <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"
          className="w-full bg-page border border-hairline rounded px-3 py-2 text-[13px] mb-4 text-ink focus:outline-none focus:border-up" />
        {error && <p className="text-critical text-[12px] mb-3" role="alert">{error}</p>}
        <button disabled={busy} className="w-full bg-up text-white font-semibold rounded py-2 text-[13px] disabled:opacity-50">
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-[11px] text-muted mt-4">Dev default: operator / operator (change via OPERATOR_PASSWORD_HASH in .env).</p>
      </form>
    </div>
  );
}
