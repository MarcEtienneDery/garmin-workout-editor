/**
 * The edges of every view on a phone: a view's bar and its page start 16 px from the window's edge (the same on every view, so the
 * eye does not step when one view replaces another), the small "About these numbers" button is not pushed against the edge, and
 * nothing makes the page scroll sideways at 412 or 375 px. alice's data, read only.
 */
import { test, expect, openView, type Page } from "../support/fixtures";

test.setTimeout(60_000);

const WIDTHS = [412, 375];
/** A view and the parts of it that must share the 16 px gutter. */
const GUTTERS: Record<string, string[]> = {
  today: ["#tbar", "#tbody"],
  food: ["#fbar", "#fweek", "#fbody"],
  recovery: ["#rbar", "#rweek", "#rbody"],
  weight: ["#bbar", "#bweek", "#bbody"],
  settings: ["#sbar", "#sbody"],
  calendar: ["#cbar"],
  activities: ["#abar"],
};

const padding = (page: Page, selectors: string[]) =>
  page.evaluate(
    (list) =>
      list.flatMap((selector) => {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (!el || getComputedStyle(el).display === "none") return [];
        return [{ selector, left: parseFloat(getComputedStyle(el).paddingLeft), right: parseFloat(getComputedStyle(el).paddingRight) }];
      }),
    selectors,
  );

for (const width of WIDTHS) {
  for (const [view, parts] of Object.entries(GUTTERS)) {
    test(`${view} at ${width} px: ${parts.join(", ")} keep a 16 px gutter, and the page does not scroll sideways`, async ({ alice }) => {
      await alice.setViewportSize({ width, height: 860 });
      await openView(alice, view);
      const found = await padding(alice, parts);
      expect(found.length).toBeGreaterThan(0);
      for (const part of found) {
        expect(part.left, `${part.selector} on the left`).toBe(16);
        expect(part.right, `${part.selector} on the right`).toBe(16);
      }
      expect(await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }

  for (const view of ["recovery", "weight"]) {
    test(`${view} at ${width} px: the "About these numbers" button is at least 8 px from the edge`, async ({ alice }) => {
      await alice.setViewportSize({ width, height: 860 });
      await openView(alice, view);
      const button = alice.locator(`#${view === "recovery" ? "rview" : "bview"} button.infob.about`).first();
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(8);
    });
  }
}
