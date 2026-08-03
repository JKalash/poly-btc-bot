// BPAIR-003 — Dependency/capability guard (spec §26.1; binding rules in §3 and §7).
//
// Proves @b5p/pair-execution can never reach live-execution, wallet, signing, or
// on-chain mutation code:
//   1. Dependency-graph assertion: the package manifest and every transitively
//      reachable workspace manifest must be free of forbidden packages.
//   2. Import walker: every .ts file under src/ must be free of forbidden
//      import/require/dynamic-import specifiers, including relative escapes out
//      of the package directory.
//   3. Negative control: a plain-text fixture with forbidden imports MUST be
//      flagged by the walker (a guard that cannot fail proves nothing).
//
// Runs under the package's normal `vitest run`, so `pnpm -r test` executes it.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const SRC_DIR = path.join(PKG_ROOT, "src");
const FIXTURE = path.join(PKG_ROOT, "test", "fixtures", "broken", "forbidden-imports.ts.txt");

// ---------------------------------------------------------------------------
// Forbidden capability surface (spec §3 rules 1–5, §26.1 BPAIR-003).
// ---------------------------------------------------------------------------

/** Exact package names that must never appear anywhere in the dependency graph. */
const FORBIDDEN_PACKAGES_EXACT: readonly string[] = [
  "@b5p/polymarket", // barrel exposes LiveClobAdapter / live directional path
  "@polymarket/clob-client", // authenticated CLOB submission client
  "viem",
  "ethers",
  "web3",
  "wagmi",
  "ethereumjs-util",
];

/** Scope/name prefixes that must never appear anywhere in the dependency graph. */
const FORBIDDEN_PACKAGE_PREFIXES: readonly string[] = [
  "@polymarket/",
  "@ethersproject/",
  "@wagmi/",
  "@web3-",
  "ethereumjs",
];

/**
 * Node built-ins and network/process libraries forbidden in src/ imports.
 * The pair package is pure (§10.1): all I/O arrives through injected ports, so
 * it needs no process-spawning or network capability of its own.
 */
const FORBIDDEN_MODULES: readonly string[] = [
  "child_process",
  "net",
  "tls",
  "dgram",
  "dns",
  "http",
  "https",
  "http2",
  "ws",
  "undici",
  "node-fetch",
  "axios",
];

/** Path segments that indicate a live/wallet/signing module, in any specifier. */
const FORBIDDEN_SEGMENT_RE = /^(live|wallet|wallets|signer|signing|private-key|keys?)$/i;

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function isForbiddenPackage(name: string): boolean {
  if (FORBIDDEN_PACKAGES_EXACT.includes(name)) return true;
  return FORBIDDEN_PACKAGE_PREFIXES.some((p) => name.startsWith(p));
}

// ---------------------------------------------------------------------------
// 1. Dependency-graph checker.
// ---------------------------------------------------------------------------

interface Manifest {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

interface DepViolation {
  readonly manifest: string;
  readonly dependency: string;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Manifest;
}

/** name -> directory for every workspace package (pnpm-workspace: apps/*, packages/*). */
function buildWorkspaceMap(repoRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of ["packages", "apps"]) {
    const groupDir = path.join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const dir = path.join(groupDir, entry);
      if (!statSync(dir).isDirectory() || !existsSync(path.join(dir, "package.json"))) continue;
      const name = readManifest(dir).name;
      if (name) map.set(name, dir);
    }
  }
  return map;
}

function allDeclaredDeps(m: Manifest): string[] {
  return [
    ...Object.keys(m.dependencies ?? {}),
    ...Object.keys(m.devDependencies ?? {}),
    ...Object.keys(m.peerDependencies ?? {}),
    ...Object.keys(m.optionalDependencies ?? {}),
  ];
}

/**
 * BFS over the workspace dependency graph starting from `startDir`, checking
 * every declared dependency (all dependency fields, at every level) against
 * the forbidden list. Returns all violations plus the set of visited packages.
 */
function checkDependencyGraph(
  startDir: string,
  workspace: Map<string, string>,
): { violations: DepViolation[]; visited: string[] } {
  const violations: DepViolation[] = [];
  const visited = new Set<string>();
  const queue: string[] = [startDir];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    if (visited.has(dir)) continue;
    visited.add(dir);
    const manifest = readManifest(dir);
    const label = manifest.name ?? dir;
    for (const dep of allDeclaredDeps(manifest)) {
      if (isForbiddenPackage(dep)) violations.push({ manifest: label, dependency: dep });
      const wsDir = workspace.get(dep);
      if (wsDir !== undefined) queue.push(wsDir);
    }
  }
  return {
    violations,
    visited: [...visited].map((d) => readManifest(d).name ?? d),
  };
}

// ---------------------------------------------------------------------------
// 2. Import walker.
// ---------------------------------------------------------------------------

interface ImportViolation {
  readonly file: string;
  readonly specifier: string;
  readonly rule: "forbidden-package" | "forbidden-module" | "live-or-wallet-segment" | "escapes-package";
}

const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s+["']([^"'\n]+)["']/g, // import ... from "x"; export ... from "x"
  /\bimport\s+["']([^"'\n]+)["']/g, // side-effect import "x"
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g, // dynamic import("x")
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g, // require("x")
];

function extractSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (spec !== undefined) found.push(spec);
    }
  }
  return found;
}

function checkSpecifier(file: string, spec: string): ImportViolation[] {
  const violations: ImportViolation[] = [];
  const isRelative = spec.startsWith(".") || spec.startsWith("/");
  const bare = spec.startsWith("node:") ? spec.slice("node:".length) : spec;

  if (!isRelative) {
    const pkg = packageNameOf(bare);
    if (isForbiddenPackage(pkg)) violations.push({ file, specifier: spec, rule: "forbidden-package" });
    if (FORBIDDEN_MODULES.includes(pkg)) violations.push({ file, specifier: spec, rule: "forbidden-module" });
  } else {
    const resolved = path.resolve(path.dirname(file), spec);
    if (!(resolved + path.sep).startsWith(PKG_ROOT + path.sep)) {
      violations.push({ file, specifier: spec, rule: "escapes-package" });
    }
  }

  const segments = spec
    .split("/")
    .map((s) => s.replace(/\.[cm]?[jt]sx?$/i, ""))
    .filter((s) => s !== "" && s !== "." && s !== "..");
  if (segments.some((s) => FORBIDDEN_SEGMENT_RE.test(s))) {
    violations.push({ file, specifier: spec, rule: "live-or-wallet-segment" });
  }
  return violations;
}

function scanFile(file: string): ImportViolation[] {
  return extractSpecifiers(readFileSync(file, "utf8")).flatMap((spec) => checkSpecifier(file, spec));
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (/\.[cm]?tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("BPAIR-003 capability guard: dependency graph", () => {
  const workspace = buildWorkspaceMap(REPO_ROOT);

  it("resolves the workspace map (walk is not vacuous)", () => {
    expect(workspace.get("@b5p/pair-execution")).toBe(PKG_ROOT);
    expect(workspace.has("@b5p/domain")).toBe(true);
    expect(workspace.has("@b5p/strategy")).toBe(true);
    // The forbidden live package really exists in this workspace — the guard
    // is checking against a real threat, not a phantom name.
    expect(workspace.has("@b5p/polymarket")).toBe(true);
  });

  it("declares no forbidden package, directly or through any workspace dependency", () => {
    const { violations, visited } = checkDependencyGraph(PKG_ROOT, workspace);
    // Transitive closure must actually include the declared workspace deps.
    expect(visited).toContain("@b5p/pair-execution");
    expect(visited).toContain("@b5p/domain");
    expect(visited).toContain("@b5p/strategy");
    expect(violations).toEqual([]);
  });

  it("negative control: the checker flags a manifest that depends on viem and @b5p/polymarket", () => {
    // Same predicate the graph walk applies to every manifest.
    const fake = ["viem", "@b5p/polymarket", "@polymarket/clob-client", "@ethersproject/wallet", "zod"];
    const flagged = fake.filter(isForbiddenPackage);
    expect(flagged).toEqual(["viem", "@b5p/polymarket", "@polymarket/clob-client", "@ethersproject/wallet"]);
  });
});

describe("BPAIR-003 capability guard: src import walker", () => {
  const srcFiles = listTsFiles(SRC_DIR);

  it("scans the full §10.1 module skeleton (walk is not vacuous)", () => {
    expect(srcFiles.length).toBeGreaterThanOrEqual(20);
    expect(srcFiles).toContain(path.join(SRC_DIR, "index.ts"));
    expect(srcFiles).toContain(path.join(SRC_DIR, "quote.ts"));
  });

  it("finds no forbidden import/require/dynamic-import in src/", () => {
    const violations = srcFiles.flatMap(scanFile);
    expect(violations).toEqual([]);
  });
});

describe("BPAIR-003 negative control: broken fixture must be flagged", () => {
  it("fixture exists and is not a compiled .ts file", () => {
    expect(existsSync(FIXTURE)).toBe(true);
    expect(FIXTURE.endsWith(".ts")).toBe(false);
  });

  it("the walker flags every class of forbidden import in the fixture", () => {
    const violations = scanFile(FIXTURE);
    const rules = new Set(violations.map((v) => v.rule));
    expect(rules).toContain("forbidden-package");
    expect(rules).toContain("forbidden-module");
    expect(rules).toContain("live-or-wallet-segment");
    expect(rules).toContain("escapes-package");

    const flaggedSpecifiers = violations.map((v) => v.specifier);
    expect(flaggedSpecifiers).toContain("@b5p/polymarket");
    expect(flaggedSpecifiers).toContain("@polymarket/clob-client");
    expect(flaggedSpecifiers).toContain("viem");
    expect(flaggedSpecifiers).toContain("ethers");
    expect(flaggedSpecifiers).toContain("node:child_process");
    expect(flaggedSpecifiers).toContain("child_process");
    expect(flaggedSpecifiers).toContain("../../../../polymarket/src/live");
    expect(flaggedSpecifiers).toContain("../../../../../apps/engine/src/main");
    expect(flaggedSpecifiers).toContain("./wallet");
  });

  it("benign specifiers are not flagged (guard is precise, not just noisy)", () => {
    const benign = ["@b5p/domain", "@b5p/strategy", "./contracts", "../src/quote", "vitest", "fast-check"];
    const violations = benign.flatMap((spec) => checkSpecifier(path.join(SRC_DIR, "index.ts"), spec));
    expect(violations).toEqual([]);
  });
});
