"use client";

import Link from "next/link";
import { Card, Empty } from "../../components/ui";
import { useApi } from "../../lib/hooks";

interface Tutorial {
  title: string;
  narrative: string[];
  intent: { side: string; style: string; price: string; sharesRequested: string; stake: string };
  effectiveBreakEven: string;
  lossErasesWins: number;
}

export default function TutorialPage() {
  const { data } = useApi<Tutorial>("/api/tutorial");
  if (!data) return <Empty text="Tutorial data not seeded — run: pnpm db:seed" />;

  return (
    <div className="max-w-3xl space-y-4">
      <Card title="Why outcome quality and decision quality are different things">
        <h3 className="text-ink font-bold text-[16px] mb-3">{data.title}</h3>
        <ol className="space-y-2.5 list-decimal pl-5 text-[13px] text-ink2">
          {data.narrative.map((line, i) => <li key={i}>{line}</li>)}
        </ol>
      </Card>

      <Card title="The arithmetic, exactly">
        <table className="w-full max-w-md text-[13px]">
          <tbody>
            <tr><td className="td text-muted">Buy</td><td className="td num text-ink">{data.intent.sharesRequested} shares {data.intent.side} @ {data.intent.price} ({data.intent.style})</td></tr>
            <tr><td className="td text-muted">Cash at risk</td><td className="td num text-warning font-semibold">${data.intent.stake}</td></tr>
            <tr><td className="td text-muted">Effective break-even probability</td><td className="td num text-ink font-semibold">{data.effectiveBreakEven} (above the price you paid)</td></tr>
            <tr><td className="td text-muted">One full loss erases</td><td className="td num text-critical font-semibold">~{data.lossErasesWins} equal wins</td></tr>
          </tbody>
        </table>
        <p className="text-[13px] text-ink2 mt-4">
          To be long-run profitable at 0.95 as a taker, the true probability must exceed ~95.33% <em>every time</em>.
          The market was quoting 95%. The entire trade thesis was the unexamined difference between those numbers, held for 30 seconds, against counterparties watching the same feed with better latency.
        </p>
        <p className="text-[13px] text-ink2 mt-2">
          Inspect the full seeded decision chain in the <Link href="/decisions/00000000-0000-4000-8000-0000000000d1" className="text-up hover:underline">decision inspector</Link>.
        </p>
      </Card>

      <Card title="What this system does about it">
        <ul className="text-[13px] text-ink2 space-y-1.5 list-disc pl-5">
          <li>Every order requires conservative probability &gt; effective break-even + minimum edge — market prices are not evidence of edge.</li>
          <li>Maker status is verified (explicit post-only, rejected safely if it would cross), never assumed from the word “limit”.</li>
          <li>The late-snipe preset that resembles this trade is paper/shadow-only until a dedicated walk-forward test passes.</li>
          <li>Sizing comes after edge validation. Target returns never authorize risk.</li>
          <li>The decision snapshot you just viewed exists for every decision, before any order — wins are auditable, not just countable.</li>
        </ul>
      </Card>
    </div>
  );
}
