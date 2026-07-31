"use client";

import { useEffect, useState } from "react";
import { Card, Empty } from "../../components/ui";
import { api } from "../../lib/api";
import { fmtTs, useApi } from "../../lib/hooks";

interface ConfigPayload {
  active: { version: number; config: Record<string, unknown>; createdAtMs: number; actor: string } | null;
  history: Array<{ version: number; active: boolean; createdAtMs: number; actor: string; changedPaths: Array<{ path: string; from: unknown; to: unknown }> | null }>;
}

export default function ConfigPage() {
  const { data, reload } = useApi<ConfigPayload>("/api/config");
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; issues?: Array<{ path: string; message: string }> } | null>(null);

  useEffect(() => {
    if (data?.active && !dirty) setText(JSON.stringify(data.active.config, null, 2));
  }, [data, dirty]);

  const save = async () => {
    setResult(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setResult({ ok: false, message: `JSON parse error: ${String(e)}` });
      return;
    }
    try {
      const res = await api<{ changed: Array<{ path: string }> }>("/api/config", { method: "POST", body: JSON.stringify(parsed) });
      setResult({ ok: true, message: `Saved as new version. Changed: ${res.changed.map((c) => c.path).join(", ")}` });
      setDirty(false);
      reload();
    } catch (e) {
      const msg = String((e as Error).message);
      setResult({ ok: false, message: msg });
    }
  };

  return (
    <div className="grid grid-cols-3 gap-4">
      <Card title={`Active configuration · v${data?.active?.version ?? "…"}`} className="col-span-2">
        <p className="text-[11px] text-muted mb-2">
          Validated by schema on save; risk limits cannot exceed the absolute 10% cap; env vars can never override these values.
          Changes publish a reload signal to the engine; a live position&apos;s recorded policy is never rewritten retroactively.
        </p>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setDirty(true); }}
          spellCheck={false}
          className="w-full h-[480px] bg-page border border-hairline rounded p-3 font-mono text-[12px] text-ink2 focus:outline-none focus:border-up"
        />
        <div className="flex items-center gap-3 mt-3">
          <button onClick={() => void save()} className="bg-up text-white font-semibold rounded px-4 py-1.5 text-[13px]">Validate &amp; save as new version</button>
          <button onClick={() => { setDirty(false); reload(); }} className="text-muted hover:text-ink text-[13px]">discard edits</button>
          {result && (
            <span className={`text-[12px] ${result.ok ? "text-good" : "text-critical"}`}>{result.message}</span>
          )}
        </div>
      </Card>

      <Card title="Version history & diffs">
        {!data || data.history.length === 0 ? <Empty text="No versions" /> : (
          <div className="space-y-3">
            {data.history.map((h) => (
              <div key={h.version} className={`border rounded p-3 ${h.active ? "border-up/50 bg-up/5" : "border-hairline"}`}>
                <div className="flex justify-between text-[12px]">
                  <span className="text-ink font-semibold">v{h.version} {h.active && <span className="text-up">(active)</span>}</span>
                  <span className="text-muted num">{fmtTs(h.createdAtMs)}</span>
                </div>
                <div className="text-[11px] text-muted">{h.actor}</div>
                {(h.changedPaths ?? []).slice(0, 8).map((c, i) => (
                  <div key={i} className="text-[11px] font-mono mt-1">
                    <span className="text-warning">{c.path}</span>
                    <span className="text-muted"> {JSON.stringify(c.from)} → </span>
                    <span className="text-ink">{JSON.stringify(c.to)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
