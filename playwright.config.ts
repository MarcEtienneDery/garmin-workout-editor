import { defineConfig, devices } from "@playwright/test";
import { MAIN, MOCK } from "./e2e/support/ports";

export default defineConfig({
  testDir: "e2e/specs",
  outputDir: "e2e/results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 7_000 },
  reporter: [["list"], ["html", { outputFolder: "e2e/report", open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${MAIN}`,
    timezoneId: "UTC",
    locale: "en-CA",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    { command: "npx tsx e2e/support/server.ts", url: `http://127.0.0.1:${MAIN}/`, reuseExistingServer: !process.env.CI, timeout: 60_000, stdout: "pipe" },
    { command: "npx tsx e2e/support/server.ts mock", url: `http://127.0.0.1:${MOCK}/`, reuseExistingServer: !process.env.CI, timeout: 60_000, stdout: "pipe" },
  ],
  projects: [
    { name: "desktop", testIgnore: [/\.phone\.spec\.ts/, /mock\//], use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } } },
    { name: "phone", testMatch: /\.phone\.spec\.ts/, use: { ...devices["Pixel 7"], browserName: "chromium" } },
    { name: "mock", testMatch: /mock\/.*\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 }, baseURL: `http://127.0.0.1:${MOCK}` } },
  ],
});
