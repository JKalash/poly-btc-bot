/**
 * Dependency / capability guard (BPAIR-003) — permanent CI tripwire.
 *
 * Enforces the research-only boundary of `@b5p/pair-execution` (spec §3
 * absolute rules, §6.5 dependency tests, §9.4 compile-time capability
 * boundary):
 *
 *   1. no `src/**` import may resolve to an authenticated/live/wallet/db
 *      dependency or reach `apps/` or `packages/polymarket`;
 *   2. package.json dependencies are exactly {@b5p/domain, @b5p/strategy};
 *   3. no `src/**` file references the directional live controller/adapter
 *      or hot-wallet/live-arming environment variables;
 *   4. no pair run mode named live/shadow may ever be declared;
 *   5. a negative control proves the walker actually flags violations.
 *
 * This test intentionally reads files rather than importing them, so it fails
 * on forbidden references even when they are type-only or unreachable.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAIR_EXECUTION_CAPABILITY } from "../src/index";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const SRC_DIR = join(PACKAGE_ROOT, "src");

/** Bare specifiers this package must never depend on, directly or by subpath. */
const FORBIDDEN_SPECIFIERS = [
  "@b5p/polymarket",
  "@polymarket/clob-client",
  "viem",
  "@b5p/db",
  "drizzle-orm",
  "pg",
  "ioredis",
  "zod",
] as const;

/**
 * Raw tokens that must never appear in src (even in comments — a mention is
 * a review smell and a rename target; keep src free of them entirely).
 */
const FORBIDDEN_TOKENS = [
  "LIVE_TRADING_ENABLED",
  "HOT_WALLET_PRIVATE_KEY",
  "LiveClobAdapter",
  "LiveController",
  "clob-client",
] as const;

/** Directory prefixes a relative import must never resolve into. */
const FORBIDDEN_REACH_PREFIXES = [
  join(REPO_ROOT, "apps") + sep,
  join(REPO_ROOT, "packages", "polymarket") + sep,
] as const;

// ---------------------------------------------------------------------------
// Import walker (pure functions; the negative control exercises these same
// code paths against in-memory fixtures).
// ---------------------------------------------------------------------------

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Remove block comments and line comments so commented-out imports do not
 * false-positive. Line comments are only stripped when `//` starts the line
 * or follows whitespace/`;`, so `"https://…"` string contents survive. Import
 * specifiers never contain `//`, so stripping cannot hide a real specifier.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[\s;])\/\/.*$/gm, "$1");
}

/**
 * Extract every module specifier referenced by the source: static
 * import/export-from, bare side-effect imports, dynamic `import()`, and the
 * CJS `require()` escape hatch.
 */
function extractImportSpecifiers(source: string): string[] {
  const stripped = stripComments(source);
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

interface Violation {
  file: string;
  specifier: string;
  reason: string;
}

/**
 * Classify each specifier. Relative specifiers are resolved against the
 * importing file; anything escaping the package root is a violation
 * (fail-closed per spec §3 — src has no legitimate reason to leave the
 * package other than via its two allowed bare dependencies).
 */
function specifierViolations(file: string, specifiers: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  for (const specifier of specifiers) {
    const forbidden = FORBIDDEN_SPECIFIERS.find(
      (f) => specifier === f || specifier.startsWith(`${f}/`),
    );
    if (forbidden) {
      violations.push({ file, specifier, reason: `forbidden dependency ${forbidden}` });
      continue;
    }
    if (specifier.startsWith(".")) {
      const resolved = resolve(dirname(file), specifier);
      const reach = FORBIDDEN_REACH_PREFIXES.find((p) => resolved.startsWith(p));
      if (reach) {
        violations.push({ file, specifier, reason: `path reaches ${reach}` });
      } else if (!resolved.startsWith(PACKAGE_ROOT + sep)) {
        violations.push({ file, specifier, reason: "relative path escapes the package root" });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// 1. Import boundary over the real src tree
// ---------------------------------------------------------------------------

describe("capability guard: src import boundary", () => {
  it("no src import resolves to a forbidden dependency or reaches apps/ or packages/polymarket", () => {
    const files = listSourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0); // the guard must never pass by scanning nothing

    const violations = files.flatMap((file) =>
      specifierViolations(file, extractImportSpecifiers(readFileSync(file, "utf8"))),
    );
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. package.json dependency surface
// ---------------------------------------------------------------------------

describe("capability guard: package.json dependency surface", () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("dependencies are exactly @b5p/domain and @b5p/strategy", () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["@b5p/domain", "@b5p/strategy"]);
  });

  it("devDependencies contain no forbidden package", () => {
    const offending = Object.keys(pkg.devDependencies ?? {}).filter((name) =>
      FORBIDDEN_SPECIFIERS.some((f) => name === f || name.startsWith(`${f}/`)),
    );
    expect(offending).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Forbidden live/wallet tokens in src
// ---------------------------------------------------------------------------

describe("capability guard: forbidden live/wallet tokens", () => {
  it("no src file references the directional live path or wallet/arming env vars", () => {
    const offending: Array<{ file: string; token: string }> = [];
    for (const file of listSourceFiles(SRC_DIR)) {
      const content = readFileSync(file, "utf8");
      for (const token of FORBIDDEN_TOKENS) {
        if (content.includes(token)) offending.push({ file, token });
      }
    }
    expect(offending).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. PairRunMode stays "observe" | "paper"
// ---------------------------------------------------------------------------

const RUN_MODE_ADDITION = /PairRunMode[^;]*"(live|shadow)"/;
const ALLOWED_MODES = new Set(["observe", "paper"]);

describe('capability guard: pair run modes are only "observe" | "paper"', () => {
  it("no src file grows PairRunMode with a live or shadow member", () => {
    for (const file of listSourceFiles(SRC_DIR)) {
      const content = readFileSync(file, "utf8");
      expect(RUN_MODE_ADDITION.test(content), `${file} adds a forbidden pair run mode`).toBe(false);

      // Any actual PairRunMode type declaration may only union the two
      // allowed literals.
      for (const decl of content.matchAll(/\btype\s+PairRunMode\s*=\s*([^;]+);/g)) {
        const literals = [...decl[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
        expect(literals.length).toBeGreaterThan(0);
        for (const literal of literals) {
          expect(ALLOWED_MODES.has(literal), `${file} declares mode "${literal}"`).toBe(true);
        }
      }
    }
  });

  it("the exported capability constant advertises exactly observe + paper", () => {
    expect([...PAIR_EXECUTION_CAPABILITY.modes]).toEqual(["observe", "paper"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Negative controls — prove the guard can fail
// ---------------------------------------------------------------------------

describe("capability guard: negative controls (walker must flag violations)", () => {
  const fixtureFile = join(SRC_DIR, "__negative_control_fixture__.ts");

  it("flags a static import of @b5p/polymarket", () => {
    const violations = specifierViolations(
      fixtureFile,
      extractImportSpecifiers('import x from "@b5p/polymarket";\n'),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.specifier).toBe("@b5p/polymarket");
  });

  it("flags dynamic imports, export-from, subpaths, and require()", () => {
    const fixture = [
      'const m = await import("@polymarket/clob-client");',
      'export { y } from "viem";',
      'import z from "@b5p/db/schema";',
      'const p = require("drizzle-orm");',
    ].join("\n");
    const violations = specifierViolations(fixtureFile, extractImportSpecifiers(fixture));
    expect(violations.map((v) => v.specifier).sort()).toEqual([
      "@b5p/db/schema",
      "@polymarket/clob-client",
      "drizzle-orm",
      "viem",
    ]);
  });

  it("flags relative paths reaching packages/polymarket and apps/", () => {
    const fixture = [
      'import live from "../../polymarket/src/live";',
      'import eng from "../../../apps/engine/src/live";',
    ].join("\n");
    const violations = specifierViolations(fixtureFile, extractImportSpecifiers(fixture));
    expect(violations).toHaveLength(2);
  });

  it("does not flag commented-out imports (comment handling works)", () => {
    const fixture = [
      '// import x from "@b5p/polymarket";',
      '/* import y from "viem"; */',
      'import ok from "@b5p/domain";',
    ].join("\n");
    const specifiers = extractImportSpecifiers(fixture);
    expect(specifiers).toEqual(["@b5p/domain"]);
    expect(specifierViolations(fixtureFile, specifiers)).toEqual([]);
  });

  it("flags a PairRunMode declaration that adds a live member", () => {
    const fixture = 'type PairRunMode = "observe" | "paper" | "live";\n';
    expect(RUN_MODE_ADDITION.test(fixture)).toBe(true);
  });
});
