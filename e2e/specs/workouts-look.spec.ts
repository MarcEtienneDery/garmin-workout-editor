import { test, expect, openView, type Page } from "../support/fixtures";
import { withGarmin } from "../support/garmin";

test.describe.configure({ timeout: 60_000 });

const PLAN = "workout-plans/hm.json";
const garminRun = (name: string, extra: Record<string, unknown> = {}) => ({
  workoutName: name,
  workoutType: "running",
  steps: [
    { stepType: "warmup", endCondition: "distance", endConditionValue: 2000, targetType: "no.target" },
    { stepType: "interval", endCondition: "distance", endConditionValue: 5000, targetType: "no.target" },
  ],
  ...extra,
});
const garminLift = (name: string) => ({
  workoutName: name,
  workoutType: "strength_training",
  steps: [
    { stepType: "exercise", exerciseName: "BARBELL_BACK_SQUAT", targetType: "no.target", endCondition: "reps", endConditionValue: 5 },
    { stepType: "exercise", exerciseName: "BARBELL_BENCH_PRESS", targetType: "no.target", endCondition: "reps", endConditionValue: 8 },
  ],
});

const ROWS = (profile: string) => [
  { key: "g:101", workoutId: 101, workoutName: "Intervals", workoutType: "running", updatedDate: "2026-11-01", plans: [{ path: PLAN, index: 0, version: 1 }], dates: ["2999-01-01"], state: "linked" },
  { key: "g:102", workoutId: 102, workoutName: "Tempo", workoutType: "running", updatedDate: "2026-10-30", plans: [{ path: PLAN, index: 1, version: 1 }], dates: [], state: "linked" },
  { key: "g:103", workoutId: 103, workoutName: "Upper body", workoutType: "strength_training", updatedDate: "2026-10-29", plans: [{ path: PLAN, index: 2, version: 1 }], dates: [], state: "linked" },
  { key: `p:${PLAN}#3`, workoutName: "Long run", workoutType: "running", plans: [{ path: PLAN, index: 3, version: 1 }], dates: [], state: "not-uploaded" },
  { key: "g:104", workoutId: 104, workoutName: "Morning mobility", workoutType: "other", updatedDate: "2026-10-20", plans: [], dates: [], state: "garmin-only" },
  { key: "g:105", workoutId: 105, workoutName: "Tempo ride", workoutType: "cycling", updatedDate: "2026-10-10", plans: [], dates: [], state: "garmin-only" },
].map((r) => ({ ...r, profile }));

async function openLibrary(page: Page, profile: string): Promise<void> {
  await withGarmin(page, profile);
  await page.route(/\/api\/workouts\?/, (route) => route.fulfill({ json: { profile, rows: ROWS(profile), truncated: false } }));
  await page.route(/\/api\/garmin\/status$/, (route) =>
    route.fulfill({ json: { profile, statuses: [{ index: 0, state: "modified", differences: ["Step 2: distance 5 km in the plan, 5.5 km on Garmin"] }, { index: 1, state: "synced", differences: [] }, { index: 2, state: "synced", differences: [] }] } }));
  await page.route(/\/api\/garmin\/workout\?/, (route) => {
    const id = new URL(route.request().url()).searchParams.get("id");
    const plan = (index: number, workout: unknown, differences: string[]) => ({ path: PLAN, index, version: 1, workout, differences });
    const found = {
      "101": { workout: { ...garminRun("Intervals", { workoutId: 101 }) }, plans: [plan(0, garminRun("Intervals", { workoutId: 101, scheduledDate: ["2999-01-01", "2999-01-08"] }), ["Step 2: distance 5 km in the plan, 5.5 km on Garmin"])] },
      "103": { workout: garminLift("Upper body"), plans: [plan(2, { ...garminLift("Upper body"), workoutId: 103 }, [])] },
    }[id ?? ""];
    return found ? route.fulfill({ json: { profile, ...found } }) : route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await openView(page, "workouts");
  await expect(page.locator("#wrows .wrow")).toHaveCount(6);
  await expect(page.locator("#wstrip .wchecking")).toHaveCount(0);
}

test.describe("the strip of states", () => {
  test("counts the workouts in each state, and a tile shows only those, a second tap all again", async ({ me, profile }) => {
    await openLibrary(me, profile.name);
    await expect(me.locator("#wstrip .tl small")).toHaveText(["All workouts", "Need a look", "Up to date", "Not on Garmin", "Only on Garmin"]);
    await expect(me.locator("#wstrip .tl b")).toHaveText(["6", "1", "2", "1", "2"]);
    await expect(me.locator("#wsub")).toContainText("6 workouts");
    await me.locator("#wstrip .tl", { hasText: "Need a look" }).click();
    await expect(me.locator("#wstrip .tl[aria-pressed=true]")).toHaveCount(1);
    await expect(me.locator("#wrows .wrow")).toHaveCount(1);
    await expect(me.locator("#wrows .wrow .n")).toHaveText("Intervals");
    await me.locator("#wstrip .tl", { hasText: "Need a look" }).click();
    await expect(me.locator("#wrows .wrow")).toHaveCount(6);
    await me.locator("#wstrip .tl", { hasText: "Only on Garmin" }).click();
    await expect(me.locator("#wrows .wrow .n")).toHaveText(["Morning mobility", "Tempo ride"]);
  });
});

test.describe("the list", () => {
  test("a row has its type, a chip for how it stands, the plans that carry it, and a ⋯ menu", async ({ me, profile }) => {
    await openLibrary(me, profile.name);
    const row = me.locator("#wrows .wrow", { hasText: "Intervals" });
    await expect(row.locator(".chip")).toHaveText("≠ Differs");
    await expect(row.locator("small")).toContainText("Running · hm");
    await expect(row.locator("small")).toContainText("Next");
    await expect(me.locator("#wrows .wrow", { hasText: "Upper body" }).locator(".chip")).toHaveText("✓ Up to date");
    await expect(me.locator("#wrows .wrow", { hasText: "Long run" }).locator(".chip")).toHaveText("Not on Garmin");
    await expect(me.locator("#wrows .wrow", { hasText: "Tempo ride" }).locator(".chip")).toHaveText("Garmin only");
    await row.locator("button.more").click();
    await expect(me.locator("#pmenu").getByRole("menuitem")).toHaveText([/Upload to Garmin/, /Use Garmin's version/, /Clone/, /Delete/]);
    await expect(me.locator("#pmenu").getByRole("menuitem", { name: /Upload to Garmin/ })).toBeEnabled();
    await me.keyboard.press("Escape");
    await me.locator("#wrows .wrow", { hasText: "Morning mobility" }).locator("button.more").click();
    await expect(me.locator("#pmenu").getByRole("menuitem", { name: /Upload to Garmin/ })).toBeDisabled();
  });
});

test.describe("the workout beside the list", () => {
  test("says how the plan and Garmin differ, with the two ways to settle it, and a switch for either copy", async ({ me, profile }) => {
    await openLibrary(me, profile.name);
    await me.locator("#wrows .wrow", { hasText: "Intervals" }).click();
    await expect(me.locator("#wTitle")).toHaveText("Intervals");
    await expect(me.locator("#wbody .meta")).toContainText("Garmin id 101");
    await expect(me.locator("#wbody .banner.warn")).toContainText("Differs from hm");
    await expect(me.locator("#wbody .banner li")).toContainText("5.5 km on Garmin");
    await expect(me.getByRole("button", { name: "↑ Push the plan's version to Garmin" })).toBeVisible();
    await expect(me.getByRole("button", { name: "↓ Use Garmin's version in the plan" })).toBeVisible();
    const seg = me.locator("#wbody .seg button");
    await expect(seg).toHaveText(["Garmin", "Plan: hm"]);
    await expect(seg.nth(0)).toHaveAttribute("aria-pressed", "true");
    await seg.nth(1).click();
    await expect(seg.nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(me.locator("#wbody .wv-chart")).toBeVisible();
  });

  test("lists the plans that hold it, each with a button that opens the plan", async ({ me, profile }) => {
    await openLibrary(me, profile.name);
    await me.locator("#wrows .wrow", { hasText: "Intervals" }).click();
    const plan = me.locator("#wbody .wplan");
    await expect(plan).toHaveCount(1);
    await expect(plan).toContainText("hm.json");
    await expect(plan).toContainText("workout 1");
    await expect(plan.getByRole("button", { name: "Open plan ›" })).toBeVisible();
  });

  test("shows the muscles of a lifting workout, compactly", async ({ me, profile }) => {
    await openLibrary(me, profile.name);
    await me.locator("#wrows .wrow", { hasText: "Upper body" }).click();
    await expect(me.locator("#wbody .banner.ok")).toContainText("Up to date with hm");
    const box = me.locator("#wbody .mmc");
    await expect(box).toBeVisible();
    await expect(box.locator(".mm-fig")).toHaveCount(2);
    expect((await box.boundingBox())!.height).toBeLessThan(260);
  });
});

test.describe("looks", () => {
  test("text keeps its contrast and what is touched is 44 px, in both themes", async ({ me, profile }) => {
    await openLibrary(me, profile.name);
    await me.locator("#wrows .wrow", { hasText: "Intervals" }).click();
    for (const theme of ["dark", "light"]) {
      await me.evaluate((t) => document.body.setAttribute("data-theme", t), theme);
      await me.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
      const low = await me.evaluate(() => {
        const lum = (css: string) => {
          const unit = css.startsWith("color(srgb") ? 1 : 255;
          const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => { const c = v / unit; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const bgOf = (el: Element): string => { for (let p: Element | null = el; p; p = p.parentElement) { const c = getComputedStyle(p).backgroundColor; if (!/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(c)) return c; } return "rgb(0, 0, 0)"; };
        const out: string[] = [];
        const check = (selector: string, need: number) => {
          for (const el of document.querySelectorAll(selector)) {
            const r = el.getBoundingClientRect(); if (!r.width) continue;
            const [a, b] = [lum(getComputedStyle(el).color), lum(bgOf(el))], ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            if (ratio < need) out.push(`${selector} ${el.className || el.tagName} ${ratio.toFixed(2)} < ${need}`);
          }
        };
        check("#wtitle h2, #wrows .wrow .n, #wstrip .tl b, #wTitle", 7);
        check("#wsub, #wrows .wrow small, #wstrip .tl small, #wbody .meta, #wbody h3, #wbody .banner, #wCount", 4.5);
        return out;
      });
      expect(low, `${theme}: text under its contrast`).toEqual([]);
      const small = await me.evaluate(() => [...document.querySelectorAll<HTMLElement>("#wbar button, #wstrip .tl, #wrows .wrow, #wrows button.more, #wTypes .tchip, #wUpcoming, #wdetail > .wbar button, #wbody .btns button")].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 43.5).map((e) => `${e.id || e.className} ${Math.round(e.getBoundingClientRect().height)}`));
      expect(small, `${theme}: under 44 px`).toEqual([]);
    }
    await me.evaluate(() => document.body.setAttribute("data-theme", "dark"));
  });
});
