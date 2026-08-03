/**
 * Engine-side pair capability guard (BPAIR-003, spec §6.5) — second line of
 * defense behind packages/pair-execution/test/capability-guard.test.ts.
 *
 * Asserts that engine pair composition files (`apps/engine/src/pair-*.ts`)
 * never touch the directional live signing/transaction path, and that the
 * pair package's dependency surface stays free of venue/wallet SDKs.
 *
 * NOTE: no `pair-*.ts` file exists in apps/engine/src yet — later waves
 * (pair composition work) populate it. Until then the file scan passes
 * vacuously; the fixture test below proves the scanner itself can fail.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_SRC = join(ENGINE_ROOT, "src");
const REPO_ROOT = resolve(ENGINE_ROOT, "..", "..");
const PAIR_PACKAGE_JSON = join(REPO_ROOT, "packages", "pair-execution", "package.json");

/** Identifiers / env vars engine pair files must never reference. */
const FORBIDDEN_TOKENS = [
  "LiveController",
  "LiveClobAdapter",
  "LIVE_TRADING_ENABLED",
  "HOT_WALLET_PRIVATE_KEY",
] as const;

/** Bare import specifiers engine pair files must never resolve. */
const FORBIDDEN_SPECIFIERS = ["@polymarket/clob-client", "viem"] as const;

/** Recursively collect src files whose basename matches pair-*.ts. */
function listPairFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listPairFiles(full));
    else if (entry.isFile() && /^pair-.*\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Strip comments, then extract static/dynamic/require import specifiers. */
function extractImportSpecifiers(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[\s;])\/\/.*$/gm, "$1");
  const patterns = [
    /\bfrom\s*["']([^"'\n]+)["']/g,
    /\bimport\s*["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  const specifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

interface Finding {
  file: string;
  offense: string;
}

function scanPairFile(file: string, content: string): Finding[] {
  const findings: Finding[] = [];
  for (const token of FORBIDDEN_TOKENS) {
    if (content.includes(token)) findings.push({ file, offense: `references ${token}` });
  }
  for (const specifier of extractImportSpecifiers(content)) {
    const forbidden = FORBIDDEN_SPECIFIERS.find(
      (f) => specifier === f || specifier.startsWith(`${f}/`),
    );
    if (forbidden) findings.push({ file, offense: `imports ${forbidden}` });
  }
  return findings;
}

describe("engine pair capability guard", () => {
  it("no apps/engine/src/pair-*.ts file touches the directional live path", () => {
    const pairFiles = listPairFiles(ENGINE_SRC);
    // Vacuously true today (no pair-*.ts exists yet); becomes load-bearing
    // the moment a later wave adds pair composition files.
    const findings = pairFiles.flatMap((file) => scanPairFile(file, readFileSync(file, "utf8")));
    expect(findings).toEqual([]);
  });

  it("negative control: the scanner flags a live-path fixture", () => {
    const fixture = [
      'import { LiveController } from "@b5p/polymarket";',
      'const clob = await import("@polymarket/clob-client");',
      "const armed = process.env.LIVE_TRADING_ENABLED;",
    ].join("\n");
    const findings = scanPairFile(join(ENGINE_SRC, "pair-fixture.ts"), fixture);
    expect(findings.map((f) => f.offense).sort()).toEqual([
      "imports @polymarket/clob-client",
      "references LIVE_TRADING_ENABLED",
      "references LiveController",
    ]);
  });

  it("packages/pair-execution declares no polymarket/wallet dependency", () => {
    const pkg = JSON.parse(readFileSync(PAIR_PACKAGE_JSON, "utf8")) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.name).toBe("@b5p/pair-execution");
    const declared = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    const offending = declared.filter((name) =>
      ["@b5p/polymarket", "@polymarket/clob-client", "viem"].some(
        (f) => name === f || name.startsWith(`${f}/`),
      ),
    );
    expect(offending).toEqual([]);
    // The pair package may depend only on domain + strategy (spec §9.1).
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["@b5p/domain", "@b5p/strategy"]);
  });
});
