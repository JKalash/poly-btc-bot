import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { fixture, huge } from "./fixtures/pair-detail.cjs";

type FixtureName = "both-filled" | "residual" | "unknown" | "recovery-partial" | "merge-resolution" | "mismatch";

async function mockPairApis(page: Page, name: FixtureName, groupStatus = 200, delayMs = 0, methods?: string[]) {
  const data = fixture(name);
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/pairs/")) methods?.push(request.method());
    if (url.pathname === "/api/state") return route.fulfill({ json: { engineState: "OFFLINE", note: "fixture" } });
    if (url.pathname === "/api/ws-ticket") return route.fulfill({ status: 503, json: { error: "fixture_ws_disabled" } });
    if (url.pathname.endsWith("/events")) return route.fulfill({ json: { items: data.events, nextCursor: null } });
    if (url.pathname.endsWith("/reconciliations")) return route.fulfill({ json: { items: data.reconciliations, nextCursor: null } });
    if (/\/api\/pairs\/groups\/[^/]+$/.test(url.pathname)) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return route.fulfill({ status: groupStatus, json: groupStatus === 200 ? data.group : { error: groupStatus === 404 ? "pair_resource_not_found" : "pair_read_failed" } });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
}

test("both-filled reconciled detail explains both legs, exact evidence, and causal order", async ({ page }) => {
  await mockPairApis(page, "both-filled");
  await page.goto("/pairs/groups/pair-group-fixture");
  await expect(page.getByText("RESEARCH / COUNTERFACTUAL PAPER ONLY")).toBeVisible();
  await expect(page.getByText("LIVE EXECUTION DOES NOT EXIST", { exact: false })).toBeVisible();
  await expect(page.getByRole("region", { name: "UP leg" })).toBeVisible();
  await expect(page.getByRole("region", { name: "DOWN leg" })).toBeVisible();
  await expect(page.getByText(huge, { exact: true }).first()).toHaveAttribute("title", `Exact value: ${huge}`);
  await expect(page.getByText("Realized pair P&L")).toBeVisible();
  await expect(page.getByText("matched terminal payout before market/operational risk", { exact: false })).toBeVisible();
  const timeline = page.getByRole("list", { name: "Pair group causal lifecycle" });
  await expect(timeline.getByRole("listitem")).toHaveCount(8);
  await expect(timeline.getByRole("listitem").first()).toContainText("PAIR_GROUP_CREATED");
  await expect(timeline.getByRole("listitem").last()).toContainText("PAIR_RECONCILIATION_COMPLETED");
  await expect(timeline).toContainText("25 ms");
});

test("one-leg residual stays above the fold and preserves UP/DOWN identity on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await mockPairApis(page, "residual");
  await page.goto("/pairs/groups/pair-group-fixture");
  const banner = page.getByRole("alert", { name: /Residual inventory/i });
  await expect(banner).toBeVisible();
  expect((await banner.boundingBox())!.y).toBeLessThan(700);
  await expect(page.getByRole("region", { name: "UP leg" })).toBeVisible();
  await expect(page.getByRole("region", { name: "DOWN leg" })).toBeVisible();
  await expect(banner).toContainText(huge);
});

test("unknown outcome remains explicitly failed and evidence-linked", async ({ page }) => {
  await mockPairApis(page, "unknown");
  await page.goto("/pairs/groups/pair-group-fixture");
  await expect(page.getByText("OUTCOME_UNKNOWN", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("VENUE_TIMEOUT", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Pair group causal lifecycle" })).toContainText("PAIR_LEG_OUTCOME_UNKNOWN");
});

test("recovery partial shows chosen alternatives, residual quantity, and recovery timeline stage", async ({ page }) => {
  await mockPairApis(page, "recovery-partial");
  await page.goto("/pairs/groups/pair-group-fixture");
  await expect(page.getByText("MINIMIZE_WORST_LOSS", { exact: false })).toBeVisible();
  await expect(page.getByRole("list", { name: "Pair group causal lifecycle" })).toContainText("PAIR_RECOVERY_PARTIAL");
  await expect(page.getByText("4500000", { exact: true }).first()).toBeVisible();
});

test("virtual merge failure is ordered before authoritative resolution", async ({ page }) => {
  await mockPairApis(page, "merge-resolution");
  await page.goto("/pairs/groups/pair-group-fixture");
  const items = page.getByRole("list", { name: "Pair group causal lifecycle" }).getByRole("listitem");
  await expect(items.nth(6)).toContainText("PAIR_VIRTUAL_MERGE_FAILED");
  await expect(items.nth(7)).toContainText("PAIR_RESOLUTION_APPLIED");
});

test("reconciliation mismatch keeps manual-review banner above the fold and exposes diff", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await mockPairApis(page, "mismatch");
  await page.goto("/pairs/groups/pair-group-fixture");
  const banner = page.getByRole("alert", { name: /Manual review required/i });
  await expect(banner).toBeVisible();
  expect((await banner.boundingBox())!.y).toBeLessThan(700);
  await expect(page.getByText("LEDGER_BALANCE_MISMATCH", { exact: false }).first()).toBeVisible();
});

test("loading, rejected/no-group, and API failure states remain read-only and explicit", async ({ page }) => {
  await mockPairApis(page, "both-filled", 200, 800);
  await page.goto("/pairs/groups/pair-group-fixture");
  await expect(page.getByText("Loading pair lifecycle…")).toBeVisible();
  await expect(page.getByText("Pair group pair-group-fixture")).toBeVisible();

  await page.unroute("**/api/**");
  await mockPairApis(page, "both-filled", 404);
  await page.goto("/pairs/groups/rejected-observation-with-no-group");
  await expect(page.getByText("Pair group not found")).toBeVisible();
  await expect(page.getByText("LIVE EXECUTION DOES NOT EXIST", { exact: false })).toBeVisible();

  await page.unroute("**/api/**");
  await mockPairApis(page, "both-filled", 500);
  await page.goto("/pairs/groups/api-failure");
  await expect(page.getByText("Pair detail unavailable", { exact: true })).toBeVisible();
});

test("detail screen has no pair mutation calls or mutation source", async ({ page }) => {
  const methods: string[] = [];
  await mockPairApis(page, "both-filled", 200, 0, methods);
  await page.goto("/pairs/groups/pair-group-fixture");
  await expect(page.getByText("Pair group pair-group-fixture")).toBeVisible();
  expect(methods.length).toBeGreaterThan(0);
  expect(new Set(methods)).toEqual(new Set(["GET"]));
  const source = await readFile(resolve(process.cwd(), "app/pairs/groups/[id]/page.tsx"), "utf8");
  expect(source).not.toMatch(/method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i);
});
