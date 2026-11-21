import type { Page } from "@playwright/test";
import { test, expect, openView } from "../support/fixtures";

const idle = { syncing: [], limit: null };

async function answerWith(page: Page, profiles: () => unknown): Promise<void> {
  await page.route("**/api/sync-activity", (route) => route.fulfill({ json: { now: Date.now(), profiles: profiles() } }));
}

test.describe("the header status", () => {
  test("is not there when nothing syncs and Garmin is not refusing", async ({ alice }) => {
    await answerWith(alice, () => ({ alice: idle }));
    await openView(alice, "today");
    await expect(alice.locator("#views")).toBeVisible();
    await expect(alice.locator("#syncActivity")).toBeHidden();
  });

  test("says what is syncing while it runs, and goes away when it is over", async ({ alice }) => {
    let running = true;
    await answerWith(alice, () => ({ alice: { syncing: running ? ["activities", "wellness"] : [], limit: null } }));
    await openView(alice, "today");
    const pill = alice.locator("#syncActivity");
    await expect(pill).toBeVisible();
    await expect(pill).toContainText("Syncing activities and health data…");
    await expect(pill).toHaveAttribute("title", /runs in the background/);
    running = false;
    await expect(pill).toBeHidden({ timeout: 15_000 });
  });

  test("says Garmin answered 429, with the advice to leave it alone", async ({ alice }) => {
    const now = Date.now();
    await answerWith(alice, () => ({ alice: { syncing: ["activities"], limit: { since: now - 600_000, lastAt: now - 120_000, count: 3 } } }));
    await openView(alice, "today");
    const pill = alice.locator("#syncActivity");
    await expect(pill).toContainText("429");
    await expect(pill).toHaveClass(/warn/);
    await expect(pill).toHaveAttribute("title", /HTTP 429, Too Many Requests/);
    await expect(pill).toHaveAttribute("title", /3 requests refused/);
    await pill.click();
    await expect(alice.locator("#toast")).toContainText("can make it last longer");
  });

  test("stays in the header on every view", async ({ alice }) => {
    await answerWith(alice, () => ({ alice: { syncing: ["renpho"], limit: null } }));
    for (const view of ["today", "calendar", "food"]) {
      await openView(alice, view);
      await expect(alice.locator("#syncActivity")).toContainText("Syncing weight…");
    }
  });
});
