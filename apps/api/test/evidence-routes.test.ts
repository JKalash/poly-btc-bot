import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDb, type DbHandle } from "@b5p/db";
import { getLocalBus } from "@b5p/engine";
import { seedAll, seedEvidence } from "@b5p/research";
import type { FastifyInstance } from "fastify";
import { AuthService } from "../src/auth";
import { buildServer } from "../src/server";

/**
 * Evidence Lab read routes. Until seed-evidence / the R1–R8/R11 reproduction
 * runners populate the provenance tables, every route must return a
 * well-formed empty payload — the dashboard's empty states depend on these
 * shapes. After seeding, the REPRODUCED_MISMATCH row must come back exactly
 * as visible as the matches: a failed reproduction is a result.
 */

// Mirrors packages/evidence/src/labels.ts (and the list in server.ts).
const EVIDENCE_LABELS = [
  "SOURCE_CLAIM_UNVERIFIED",
  "OFFICIAL_CURRENT_AT_RETRIEVAL",
  "REPRODUCED_MATCH",
  "REPRODUCED_MISMATCH",
  "DATA_GATED",
  "INTERNAL_HYPOTHESIS",
  "LIVE_VALIDATED",
  "REJECTED_ANTI_PATTERN",
] as const;

const ROUTES = [
  "/api/evidence/ledger",
  "/api/evidence/experiments",
  "/api/evidence/manifests",
];

interface LedgerClaim {
  id: string;
  sourceKey: string;
  claimKey: string;
  label: string;
  claimedValue: string | null;
  reproducedValue: string | null;
  retrievedAtMs: number | null;
  updatedAtMs: number;
  reproduction: { runId: string; dataGated: boolean } | null;
  datasets: Array<{ id: string; materialized: boolean }>;
}
interface LedgerPayload {
  claims: LedgerClaim[];
  counts: Record<string, number>;
  labels: string[];
  notes: string[];
  note?: string;
}
interface ExperimentsPayload {
  experiments: Array<{
    experimentKey: string;
    status: string;
    primaryMetric: string;
    nullHypothesis: string;
    foldPlan: unknown;
    dataGated: boolean;
    runs: Array<{ id: string; status: string; resultChecksum: string | null; dataGated: boolean; observations: unknown[] }>;
  }>;
  note?: string;
}
interface ManifestsPayload {
  manifests: Array<{
    datasetKey: string;
    contentChecksum: string;
    materialized: boolean;
    fileCount: number;
    checksummedFiles: number;
    files: Array<{ path: string; sha256: string | null }>;
  }>;
  note?: string;
}

let db: DbHandle;
let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  db = await makeDb({ pgliteDir: "memory://", databaseUrl: undefined });
  await db.migrate();
  await seedAll(db); // base seeds only — seedAll does NOT touch the evidence tables
  process.env.OPERATOR_PASSWORD_HASH = await AuthService.hashPassword("test-password-123");
  process.env.OPERATOR_USERNAME = "operator";
  const auth = new AuthService();
  await auth.ensurePasswordHash();
  app = await buildServer({ db, bus: getLocalBus(), auth, requireAuth: true });
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "operator", password: "test-password-123" } });
  const setCookies = res.headers["set-cookie"] as string[] | string;
  const all = Array.isArray(setCookies) ? setCookies : [setCookies];
  cookie = all.find((c) => c.startsWith("b5p_session="))!.split(";")[0]!;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("evidence lab routes (empty)", () => {
  it("every route is guarded", async () => {
    for (const url of ROUTES) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("ledger: empty claims, the full label vocabulary zero-counted, mandated notes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/evidence/ledger", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LedgerPayload;
    expect(body.claims).toEqual([]);
    expect(body.labels).toEqual([...EVIDENCE_LABELS]);
    for (const label of EVIDENCE_LABELS) {
      expect(body.counts[label], label).toBe(0);
    }
    expect(body.notes).toContain("A failed reproduction is a result.");
    expect(body.notes).toContain("No live order can be created by any unverified source claim.");
  });

  it("experiments: empty list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/evidence/experiments", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ExperimentsPayload).experiments).toEqual([]);
  });

  it("manifests: empty list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/evidence/manifests", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ManifestsPayload).manifests).toEqual([]);
  });
});

describe("evidence lab routes (seeded with the 2026-08 calibration study)", () => {
  beforeAll(async () => {
    // Idempotent provenance backfill. File-dependent fields (materialization,
    // reproduced values extracted from study_results.json) are asserted only
    // for self-consistency so the suite passes with or without the dataset.
    await seedEvidence(db, Date.now());
  });

  it("ledger: rows joined to runs/manifests; counts reconcile; labels are in-vocabulary", async () => {
    const res = await app.inject({ method: "GET", url: "/api/evidence/ledger", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as LedgerPayload;
    expect(body.claims.length).toBeGreaterThanOrEqual(5);
    const countSum = Object.values(body.counts).reduce((a, b) => a + b, 0);
    expect(countSum).toBe(body.claims.length);
    for (const c of body.claims) {
      expect(EVIDENCE_LABELS as readonly string[], `${c.sourceKey}/${c.claimKey}`).toContain(c.label);
      if (c.reproduction) {
        // every dataset the run consumed is joined in, and the gated flag
        // reflects their materialization exactly
        expect(c.reproduction.dataGated).toBe(c.datasets.some((d) => !d.materialized));
      }
    }
  });

  it("ledger: a failed reproduction is a result — the ':45 anomaly' mismatch is first-class", async () => {
    const res = await app.inject({ method: "GET", url: "/api/evidence/ledger", headers: { cookie } });
    const body = res.json() as LedgerPayload;
    const mismatch = body.claims.find((c) => c.claimKey === "minute_45_up_anomaly");
    expect(mismatch).toBeDefined();
    expect(mismatch!.label).toBe("REPRODUCED_MISMATCH");
    expect(mismatch!.claimedValue).toBe("0.5403");
    expect(mismatch!.reproducedValue).toContain("0.5225");
    expect(body.counts.REPRODUCED_MISMATCH).toBeGreaterThanOrEqual(1);
  });

  it("experiments: the calibration study carries its preregistration and REFUTED verdict", async () => {
    const res = await app.inject({ method: "GET", url: "/api/evidence/experiments", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExperimentsPayload;
    const study = body.experiments.find((e) => e.experimentKey === "calibration_study_2026_08");
    expect(study).toBeDefined();
    expect(study!.status).toBe("REFUTED"); // the null held — that is the result
    expect(study!.primaryMetric).toBe("oos_auc_delta_model_minus_mid");
    expect(study!.nullHypothesis.length).toBeGreaterThan(0);
    expect(study!.foldPlan).not.toBeNull();
    expect(Array.isArray(study!.runs)).toBe(true);
    for (const r of study!.runs) {
      expect(Array.isArray(r.observations)).toBe(true);
      expect(typeof r.dataGated).toBe("boolean");
    }
  });

  it("manifests: kachoio manifest reports checksum status honestly", async () => {
    const res = await app.inject({ method: "GET", url: "/api/evidence/manifests", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ManifestsPayload;
    const kachoio = body.manifests.find((m) => m.datasetKey === "kachoio_btc5m_2026q2");
    expect(kachoio).toBeDefined();
    expect(kachoio!.fileCount).toBe(3);
    expect(kachoio!.contentChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(kachoio!.checksummedFiles).toBe(kachoio!.files.filter((f) => f.sha256 !== null).length);
    // materialized must equal "every file present and checksummed" — absence is
    // recorded, never faked
    expect(kachoio!.materialized).toBe(kachoio!.checksummedFiles === kachoio!.fileCount);
  });
});
