/** The Settings view on a phone: the list of sections is the home screen, a section opens over the whole screen with a way back, and nothing goes sideways. */
import { test, expect, type Page } from "../support/fixtures";

test.setTimeout(60_000);

const home = async (page: Page) => {
  await page.goto("/#settings");
  await expect(page.locator("#sbody .snav")).toBeVisible({ timeout: 20_000 });
};
const sticking = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("opens on the list of sections, a section fills the screen, and ‹ Settings goes back to the list", async ({ me }) => {
  await home(me);
  await expect(me.locator("#sbody .spane")).toHaveCount(0);
  await me.locator("#sbody .snav [data-section='goals']").tap();
  await expect(me.locator("#sbody .spane[data-section='goals']")).toBeVisible();
  await expect(me.locator("#sbody .snav")).toBeHidden();
  const back = me.locator("#sbody .sback");
  expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await back.tap();
  await expect(me.locator("#sbody .snav")).toBeVisible();
});

test("every section fits the width, and what is touched is 44 px", async ({ me }) => {
  await home(me);
  for (const section of ["overview", "connections", "goals", "display", "signin"]) {
    await me.locator(`#sbody .snav [data-section='${section}']`).tap();
    await expect(me.locator(`#sbody .spane[data-section='${section}']`)).toBeVisible();
    expect(await sticking(me), section).toBeLessThanOrEqual(0);
    const small = await me.evaluate(() => [...document.querySelectorAll<HTMLElement>("#sbody .sbtns button, #sbody .sback, #sbody .sattn button, #sbody .slink")].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => e.textContent!.trim().slice(0, 20)));
    expect(small, section).toEqual([]);
    await me.locator("#sbody .sback").tap();
  }
});

test("the unsaved bar shows over the goals on a phone, and its buttons are tappable", async ({ me }) => {
  await home(me);
  await me.locator("#sbody .snav [data-section='goals']").tap();
  await me.locator("#s-goal_kcal").fill("2100");
  const bar = me.locator(".sunsaved");
  await expect(bar).toBeVisible();
  for (const b of await bar.getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await sticking(me)).toBeLessThanOrEqual(0);
});
