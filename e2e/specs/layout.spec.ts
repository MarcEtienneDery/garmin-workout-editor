/**
 * The edges of every view on a desktop: the bar, the week, the notes and the page of a view share one column that is centred on a wide
 * screen (up to 1280 px), nothing runs to the edge of the window, and nothing makes the page scroll sideways. alice's data is read only;
 * the Workouts view has no Garmin login to show it, so its library is made up here (see withGarmin).
 */
import { test, expect, openView, type Page } from "../support/fixtures";
import { withGarmin } from "../support/garmin";

test.describe.configure({ timeout: 90_000 });

const WIDTHS = [1920, 1440, 1280, 1024];
/** The parts of a view that stack in one column: they must start and end where the others do. */
const COLUMN: Record<string, string[]> = {
  today: ["#tbar", "#tbody"],
  recovery: ["#rbar", "#rweek", "#rbody"],
  weight: ["#bbar", "#bweek", "#bbody"],
  food: ["#fbar", "#fweek", "#fbody"],
  settings: ["#sbar", "#sbody"],
};

const boxes = (page: Page, selectors: string[]) =>
  page.evaluate(
    (list) =>
      list.flatMap((selector) => {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (!el || getComputedStyle(el).display === "none") return [];
        const r = el.getBoundingClientRect();
        return r.width ? [{ selector, left: Math.round(r.left), right: Math.round(r.right) }] : [];
      }),
    selectors,
  );

const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const [view, parts] of Object.entries(COLUMN)) {
  test.describe(`the ${view} view's column`, () => {
    for (const width of WIDTHS) {
      test(`${width} px: ${parts.join(", ")} start and end together, and a wide screen is centred`, async ({ alice }) => {
        await alice.setViewportSize({ width, height: 900 });
        await openView(alice, view);
        const found = await boxes(alice, parts);
        expect(found.map((b) => b.selector)).toEqual(expect.arrayContaining([parts[0], parts[parts.length - 1]]));
        const first = found[0];
        for (const box of found) {
          expect(Math.abs(box.left - first.left), `${box.selector} starts with ${first.selector}`).toBeLessThanOrEqual(2);
          expect(Math.abs(box.right - first.right), `${box.selector} ends with ${first.selector}`).toBeLessThanOrEqual(2);
        }
        if (width >= 1440) {
          // the rail is 80 px wide: the column is centred in what is left of the window
          const space = width - 80;
          expect(first.right - first.left, "a column of at most 1280 px").toBeLessThanOrEqual(1281);
          expect(Math.abs(first.left - 80 - (width - first.right)), "the same space on both sides").toBeLessThanOrEqual(2);
          expect(space).toBeGreaterThan(first.right - first.left);
        }
        expect(await noSidewaysScroll(alice)).toBe(true);
      });
    }
  });
}

test.describe("the Calendar bar", () => {
  for (const width of [1024, 1280, 1440]) {
    test(`${width} px: the refresh button is not against the edge of the window, and ends where the week does`, async ({ alice }) => {
      await alice.setViewportSize({ width, height: 900 });
      await openView(alice, "calendar");
      const [refresh, grid] = await boxes(alice, ["#cRefresh", "#cscroll"]);
      expect(width - refresh.right).toBeGreaterThanOrEqual(8);
      // on the narrow screen the week is a column of its own with a 16 px margin; on the wide one the button ends where the grid under it does
      if (width <= 1180) expect(width - refresh.right).toBeGreaterThanOrEqual(16);
      else expect(Math.abs(refresh.right - grid.right)).toBeLessThanOrEqual(2);
      expect(await noSidewaysScroll(alice)).toBe(true);
    });
  }
});

test.describe("the sign-in card", () => {
  test("has the same space above and below its contents", async ({ page }) => {
    await page.goto("/");
    const form = page.locator("#loginForm");
    await expect(form).toBeVisible();
    const padding = await form.evaluate((el) => {
      const s = getComputedStyle(el);
      return { top: parseFloat(s.paddingTop), bottom: parseFloat(s.paddingBottom), left: parseFloat(s.paddingLeft), right: parseFloat(s.paddingRight) };
    });
    expect(padding.top).toBe(padding.bottom);
    expect(padding.left).toBe(padding.right);
  });
});

/** Six workouts in the library, as a profile with a Garmin login would see them. */
const library = (profile: string) =>
  [
    { key: "g:101", workoutId: 101, workoutName: "Intervals", workoutType: "running", updatedDate: "2026-11-01", plans: [], dates: [], state: "garmin-only" },
    { key: "g:102", workoutId: 102, workoutName: "Tempo", workoutType: "running", updatedDate: "2026-10-30", plans: [], dates: [], state: "garmin-only" },
    { key: "g:103", workoutId: 103, workoutName: "Upper body", workoutType: "strength_training", updatedDate: "2026-10-29", plans: [], dates: [], state: "garmin-only" },
    { key: "g:104", workoutId: 104, workoutName: "Morning mobility", workoutType: "other", updatedDate: "2026-10-20", plans: [], dates: [], state: "garmin-only" },
    { key: "g:105", workoutId: 105, workoutName: "Tempo ride", workoutType: "cycling", updatedDate: "2026-10-10", plans: [], dates: [], state: "garmin-only" },
    { key: "g:106", workoutId: 106, workoutName: "Long run", workoutType: "running", updatedDate: "2026-10-05", plans: [], dates: [], state: "garmin-only" },
  ].map((row) => ({ ...row, profile }));

test.describe("the Workouts view", () => {
  for (const width of WIDTHS) {
    test(`${width} px: made-up library rows stay inside the window`, async ({ me, profile }) => {
      await me.setViewportSize({ width, height: 900 });
      await withGarmin(me, profile.name);
      await me.route(/\/api\/workouts\?/, (route) => route.fulfill({ json: { profile: profile.name, rows: library(profile.name), truncated: false } }));
      await openView(me, "workouts");
      await expect(me.locator("#wrows .wrow")).toHaveCount(6);
      const rows = await me.locator("#wrows .wrow").evaluateAll((list) => list.map((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; }));
      for (const row of rows) {
        expect(row.left).toBeGreaterThanOrEqual(80 + 8);
        expect(width - row.right).toBeGreaterThanOrEqual(8);
      }
      expect(await noSidewaysScroll(me)).toBe(true);
    });
  }
});
