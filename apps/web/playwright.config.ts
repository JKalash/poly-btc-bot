import { defineConfig } from "@playwright/test";

/**
 * E2E smoke tests. Requires the full dev stack running (pnpm dev) and
 * playwright browsers installed (npx playwright install chromium).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
  },
});
