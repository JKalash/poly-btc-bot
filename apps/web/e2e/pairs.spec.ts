import { expect, test, type Page, type Route } from "@playwright/test";
import {
  emptyPairSummaryFixture,
  pairEpisodesFixture,
  pairGroupsFixture,
  pairResearchRunsFixture,
  pairSummaryFixture,
} from "./fixtures/pairs";

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockShell(page: Page): Promise<void> {
  await page.route("**/api/state", (route) => json(route, { engineState: "OFFLINE", note: "fixture" }));
  await page.route("**/api/ws-ticket", (route) => json(route, { ticket: "fixture" }));
}

async function mockPairs(page: Page, fixture: "populated" | "empty" | "error" | "loading"): Promise<void> {
  const answer = (body: unknown) => async (route: Route): Promise<void> => {
    if (fixture === "loading") await new Promise<void>(() => undefined);
    if (fixture === "error") return json(route, { error: "pair read model unavailable" }, 503);
    return json(route, body);
  };
  await page.route("**/api/pairs/summary", answer(fixture === "empty" ? emptyPairSummaryFixture : pairSummaryFixture));
  await page.route("**/api/pairs/episodes?**", answer(fixture === "empty" ? { items: [], nextCursor: null } : pairEpisodesFixture));
  await page.route("**/api/pairs/groups?**", answer(fixture === "empty" ? { items: [], nextCursor: null } : pairGroupsFixture));
  await page.route("**/api/pairs/research-runs?**", answer(fixture === "empty" ? { items: [], nextCursor: null } : pairResearchRunsFixture));
}

test.describe("pair research overview", () => {
  test("renders a read-only research cockpit with exact decimals and separate legs", async ({ page }) => {
    const pairMethods: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/pairs/")) pairMethods.push(request.method());
    });
    await mockShell(page);
    await mockPairs(page, "populated");
    await page.goto("/pairs");

    await expect(page.getByText("RESEARCH / COUNTERFACTUAL PAPER ONLY", { exact: true })).toBeVisible();
    await expect(page.getByText("LIVE EXECUTION DOES NOT EXIST", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Complete-set pair research" })).toBeVisible();
    await expect(page.getByText("Operator attention:")).toBeVisible();
    await expect(page.getByText("9,007,199,254,740,993", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("$9,007,199,254,740,993.000000", { exact: true })).toBeVisible();
    await expect(page.getByText("group-001", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("columnheader", { name: /UP held/i })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /DOWN held/i })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Prospective quote P&L/i })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Realized P&L/i })).toBeVisible();
    await expect(page.getByText("parallel / 250ms / full depth", { exact: true })).toBeVisible();
    await expect(page.getByText("−0.120000", { exact: false })).toBeVisible();
    await expect(page.locator("main button, main input, main select, main textarea")).toHaveCount(0);
    expect(pairMethods.length).toBeGreaterThan(0);
    expect(new Set(pairMethods)).toEqual(new Set(["GET"]));
  });

  test("keeps the permanent capability banner visible while data loads", async ({ page }) => {
    await mockShell(page);
    await mockPairs(page, "loading");
    await page.goto("/pairs");
    await expect(page.getByText("RESEARCH / COUNTERFACTUAL PAPER ONLY", { exact: true })).toBeVisible();
    await expect(page.getByText("Loading pair research read models…", { exact: true })).toBeVisible();
  });

  test("shows endpoint failures without offering a mutation", async ({ page }) => {
    await mockShell(page);
    await mockPairs(page, "error");
    await page.goto("/pairs");
    const alert = page.locator("main").getByRole("alert").filter({ hasText: "Some pair research data could not be loaded" });
    await expect(alert).toContainText("Some pair research data could not be loaded");
    await expect(alert).toContainText("pair read model unavailable");
    await expect(page.locator("main button, main input, main select, main textarea")).toHaveCount(0);
  });

  test("renders explicit empty states for every pair collection", async ({ page }) => {
    await mockShell(page);
    await mockPairs(page, "empty");
    await page.goto("/pairs");
    await expect(page.getByText("No pair opportunity episodes have been recorded.")).toBeVisible();
    await expect(page.getByText("No counterfactual paper groups have been scheduled.")).toBeVisible();
    await expect(page.getByText("No offline research runs have completed.")).toBeVisible();
    await expect(page.getByText("Operator attention:")).toHaveCount(0);
  });
});
