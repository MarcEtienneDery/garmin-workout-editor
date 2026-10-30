import { defineConfig, devices } from "@playwright/test";

const MAIN = 8792;
const MOCK = 8793;

/**
 * The browser suite (`npm run e2e`). Two servers are started on databases made for the run (e2e/support/server.ts): the app as a
 * person without Garmin meets it, with data stored, and the app in mock mode, where Garmin looks connected and refuses every write.
 * Open Food Facts, Claude and the camera are never reached: the specs that need them answer the page's requests themselves.
 *
 *   npm run e2e                     the whole suite
 *   npm run e2e -- e2e/specs/food   one area
 *   npm run e2e -- --project=phone  one project
 *   npm run e2e:ui                  the Playwright UI
 */
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
