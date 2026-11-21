import type { Page } from "@playwright/test";
import { test, expect, openView } from "../support/fixtures";

const pageWidth = (page: Page) => page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));

test("the ⓘ buttons of Settings are at least 32 px both ways, and their notes keep the page its width", async ({ alice }) => {
  await openView(alice, "settings");
  await expect(alice.locator("#sbody .snav")).toBeVisible({ timeout: 15_000 });
  let seen = 0;
  for (const section of ["connections", "goals", "display", "signin"]) {
    await alice.locator(`#sbody .snav [data-section="${section}"]`).tap();
    await expect(alice.locator(`#sbody .spane[data-section="${section}"]`)).toBeVisible();
    const infos = alice.locator("#sbody button.infob:visible");
    seen += await infos.count();
    for (const box of await infos.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height })))) {
      expect(box.w).toBeGreaterThanOrEqual(32);
      expect(box.h).toBeGreaterThanOrEqual(32);
    }
    for (const button of await infos.all()) await button.click();
    await expect(alice.locator("#sbody .help:visible")).toHaveCount(await infos.count());
    const w = await pageWidth(alice);
    expect(w.scroll).toBeLessThanOrEqual(w.client);
    await alice.locator("#sbody .sback").tap();
  }
  expect(seen).toBeGreaterThanOrEqual(5);
});

test("About these numbers opens at the foot of the Food view without widening the page", async ({ alice }) => {
  await openView(alice, "food");
  const button = alice.locator("#fbody .rfoot").getByRole("button", { name: "About these numbers" });
  await button.click();
  await expect(alice.locator("#fbody .rfoot .help")).toBeVisible();
  const box = (await button.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(32);
  const w = await pageWidth(alice);
  expect(w.scroll).toBeLessThanOrEqual(w.client);
});
