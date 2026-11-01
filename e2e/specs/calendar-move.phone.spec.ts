/**
 * Moving a workout on a phone. The Calendar's chips are thin bars there and a tap selects the day, so a finger held still on a day
 * lifts its workout, which then follows the finger to another day (where letting go asks before it moves); a finger that moves at
 * once scrolls the page as before. The Move menu is a sheet across the foot of the screen. Each test makes its own profile and plan, dated in 2031.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, openView, type Profile } from "../support/fixtures";

test.setTimeout(60_000);

const longLabel = (day: string) => new Intl.DateTimeFormat("en-CA", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
const monthTitle = (day: string) => new Intl.DateTimeFormat("en-CA", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
const enc = (path: string) => `/api/file?path=${encodeURIComponent(path)}`;
const cellOf = (page: Page, day: string) => page.getByRole("button", { name: longLabel(day), exact: true });

async function centre(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("the element has no box");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function addPlan(profile: Profile, suffix: string, workouts: object[]) {
  const name = `${profile.name}-${suffix}`, path = `workout-plans/${name}.json`;
  const res = await profile.api.put(enc(path), { data: { text: JSON.stringify({ weekStart: "2031-09-01", weekEnd: "2031-09-07", workouts }), create: true } });
  expect(res.status(), await res.text()).toBe(201);
  return { path, name };
}

async function savedDates(profile: Profile, path: string): Promise<unknown[]> {
  return JSON.parse((await (await profile.api.get(enc(path))).json()).text).workouts.map((w: any) => w.scheduledDate);
}

async function openOnPlan(page: Page, plan: string) {
  await openView(page, "calendar");
  await expect(page.locator("#cNote")).not.toContainText("Loading", { timeout: 20_000 });
  await page.locator("#cLegend .citem", { hasText: plan }).tap();
  await expect(page.locator("#cTitle")).toHaveText(monthTitle("2031-09-01"));
  await page.locator("#cview").evaluate((e) => e.scrollTo(0, 0));
}

/** A finger on the touch screen, through the browser's own input (Playwright's touchscreen only taps). */
async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number }[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) });
  let at = { x: 0, y: 0 };
  return {
    down: async (p: { x: number; y: number }) => { at = p; await send("touchStart", [p]); },
    /** Slide to `p` in small steps, as a finger does. */
    slide: async (p: { x: number; y: number }, steps = 10) => {
      const from = at;
      for (let i = 1; i <= steps; i++) await send("touchMove", [{ x: from.x + ((p.x - from.x) * i) / steps, y: from.y + ((p.y - from.y) * i) / steps }]);
      at = p;
    },
    up: () => send("touchEnd", []),
  };
}

test.describe("moving a workout on a phone", () => {
  test("a finger held on a day lifts its workout, and letting go on another day asks, then moves it there", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "hold", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await openOnPlan(me, name);
    const f = await finger(me);
    await f.down(await centre(cellOf(me, "2031-09-03")));
    await me.waitForTimeout(500); // held still
    await expect(me.locator(".cghost")).toHaveText("Morning run");
    await f.slide(await centre(cellOf(me, "2031-09-05")));
    await expect(cellOf(me, "2031-09-05")).toHaveClass(/\bdrop\b/);
    await f.up();
    await expect(me.locator(".cghost")).toHaveCount(0);
    await expect(me.locator("#dlgTitle")).toHaveText("Move Morning run?");
    await me.locator("#dlgOk").tap();
    await expect(me.locator("#toast")).toContainText("Moved Morning run to");
    expect(await savedDates(profile, path)).toEqual(["2031-09-05"]);
    await expect(me.locator("#cDayTitle")).toHaveText(longLabel("2031-09-05"));
    await expect(me.locator("#cDay .citem", { hasText: "Morning run" })).toBeVisible();
  });

  test("a finger that moves at once is scrolling: nothing is lifted or moved", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "scroll", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await openOnPlan(me, name);
    let sent = 0;
    me.on("request", (r) => { if (r.url().endsWith("/api/plans/move")) sent++; });
    const f = await finger(me), start = await centre(cellOf(me, "2031-09-03"));
    await f.down(start);
    await f.slide({ x: start.x + 120, y: start.y + 20 }, 6); // sideways onto another day, without the hold
    await me.waitForTimeout(500);
    await expect(me.locator(".cghost")).toHaveCount(0);
    await f.up();
    await me.waitForTimeout(300);
    await expect(me.locator("#dlg")).toBeHidden();
    expect(sent).toBe(0);
    expect(await savedDates(profile, path)).toEqual(["2031-09-03"]);
  });

  test("a day with no workout lifts nothing, and a tap still selects the day", async ({ me, profile }) => {
    const { name } = await addPlan(profile, "empty", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await openOnPlan(me, name);
    const f = await finger(me);
    await f.down(await centre(cellOf(me, "2031-09-04")));
    await me.waitForTimeout(500);
    await expect(me.locator(".cghost")).toHaveCount(0);
    await f.up();
    await cellOf(me, "2031-09-03").tap();
    await expect(me.locator("#cDayTitle")).toHaveText(longLabel("2031-09-03"));
  });

  test("the Move menu is a sheet across the foot of the screen, and moves the workout to the day picked", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "sheet", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await openOnPlan(me, name);
    await cellOf(me, "2031-09-03").tap();
    await me.locator("#cDay .citem", { hasText: "Morning run" }).getByRole("button", { name: "Move…" }).tap();
    const menu = me.locator("#moveMenu");
    await expect(menu).toBeVisible();
    const b = await menu.boundingBox(), view = me.viewportSize()!;
    expect(b && Math.round(b.x)).toBe(0);
    expect(b && Math.round(b.width)).toBe(view.width);
    expect(b && Math.round(b.y + b.height)).toBe(view.height);
    expect(await me.locator("#mvDate").evaluate((e) => getComputedStyle(e).fontSize)).toBe("16px"); // no zoom on focus
    await me.locator("#mvNext").tap();
    await expect(menu).toBeHidden();
    await expect(me.locator("#toast")).toContainText("Moved Morning run to");
    expect(await savedDates(profile, path)).toEqual(["2031-09-04"]);
  });
});
