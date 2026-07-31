import { expect, test } from "@playwright/test";

test("login -> cockpit -> timing lab shows seeded table -> emergency stop visible", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill("operator");
  await page.getByLabel(/password/i).fill(process.env.E2E_PASSWORD ?? "operator");
  await page.getByRole("button", { name: /sign in/i }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByText(/MODE:/)).toBeVisible();
  await expect(page.getByRole("button", { name: /EMERGENCY STOP/i })).toBeVisible();

  await page.goto("/timing-lab");
  await expect(page.getByText(/Outcome skew is not trading edge/i)).toBeVisible();
  await expect(page.getByText(/54\.03%/)).toBeVisible(); // seeded :45 up-rate
  await expect(page.getByText(/unconfirmed \/ selection-sensitive/i)).toBeVisible();

  await page.goto("/tutorial");
  await expect(page.getByText(/95\.33/)).toBeVisible();
  await expect(page.getByText(/erases/i).first()).toBeVisible();

  await page.goto("/risk");
  await expect(page.getByText(/five full losses leave ~59%/i)).toBeVisible();
});
