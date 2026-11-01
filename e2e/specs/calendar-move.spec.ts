/**
 * Moving a workout to another day: dragging its chip in the Calendar (a drop asks before it moves anything), Move… in the Calendar's
 * day panel, and the Move menu of the days in a workout's picture (in the Plans view, and in the Workouts view with Garmin's answers
 * stubbed: the suite has no Garmin). A move saves the plan file at once and says so in a toast with Undo. Every test makes its own profile and plan, dated in 2031 so
 * that no other spec's data lands on its months.
 */
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect, openView, type Profile } from "../support/fixtures";

// The Monaco editor of the page: the top-level `editor` of the page's own script.
declare const editor: any;

test.describe.configure({ timeout: 60_000 });

// ── helpers ──────────────────────────────────────────────────────────────

const longLabel = (day: string) => new Intl.DateTimeFormat("en-CA", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
const monthTitle = (day: string) => new Intl.DateTimeFormat("en-CA", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
const enc = (path: string) => `/api/file?path=${encodeURIComponent(path)}`;

const cellOf = (page: Page, day: string) => page.getByRole("button", { name: longLabel(day), exact: true });
const weekOf = (page: Page, day: string) => page.locator(".cweek").filter({ has: cellOf(page, day) });

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("the element has no box");
  return b;
}

/** A plan file of the profile's, made through the API; its name carries the profile's (plan files share one folder). */
async function addPlan(profile: Profile, suffix: string, workouts: object[]): Promise<{ path: string; name: string }> {
  const name = `${profile.name}-${suffix}`, path = `workout-plans/${name}.json`;
  const res = await profile.api.put(enc(path), { data: { text: JSON.stringify({ weekStart: "2031-09-01", weekEnd: "2031-09-07", workouts }, null, 2), create: true } });
  expect(res.status(), await res.text()).toBe(201);
  return { path, name };
}

/** The scheduledDate of each workout of a plan file, as saved. */
async function savedDates(api: APIRequestContext, path: string): Promise<unknown[]> {
  const res = await api.get(enc(path));
  expect(res.ok()).toBeTruthy();
  return JSON.parse((await res.json()).text).workouts.map((w: any) => w.scheduledDate);
}

/** Open the Calendar on the month of the profile's plan, by its row in the legend; `mode` is pressed first. */
async function openOnPlan(page: Page, plan: string, month: string, mode?: "workouts") {
  await openView(page, "calendar");
  await expect(page.locator("#cNote")).not.toContainText("Loading", { timeout: 20_000 });
  await page.locator("#cLegend .citem", { hasText: plan }).click(); // the plans' legend is not shown in Workouts mode
  await expect(page.locator("#cTitle")).toHaveText(monthTitle(month));
  if (mode) await page.locator(`#cModes button[data-mode=${mode}]`).click();
}

/** How many chips named `name` sit in the column of `day`. */
async function chipsOnDay(page: Page, day: string, name: string): Promise<number> {
  return page.evaluate(
    ({ label, name }) => {
      const cell = [...document.querySelectorAll<HTMLElement>("#cgrid .cday")].find((c) => c.getAttribute("aria-label") === label);
      if (!cell) return -1;
      const r = cell.getBoundingClientRect();
      return [...(cell.closest(".cweek")?.querySelectorAll<HTMLElement>(".cbar.wk") ?? [])].filter((chip) => {
        const b = chip.getBoundingClientRect(), mid = b.left + b.width / 2;
        return chip.textContent === name && mid >= r.left && mid <= r.right;
      }).length;
    },
    { label: longLabel(day), name },
  );
}

/** The chip named `name` on `day`. */
async function chipOn(page: Page, day: string, name: string): Promise<Locator> {
  const chips = weekOf(page, day).getByRole("button", { name, exact: true });
  const cell = await box(cellOf(page, day));
  for (let i = 0; i < (await chips.count()); i++) {
    const b = await box(chips.nth(i)), mid = b.x + b.width / 2;
    if (mid >= cell.x && mid <= cell.x + cell.width) return chips.nth(i);
  }
  throw new Error(`no chip ${name} on ${day}`);
}

/** Press the mouse on `from`, move it in steps as a hand does, and let go over `to` (a locator, or a point). */
async function dragTo(page: Page, from: Locator, to: Locator | { x: number; y: number }, { wait = 0 } = {}) {
  const a = await box(from);
  const b = "x" in to ? { x: to.x, y: to.y, width: 0, height: 0 } : await box(to);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 4, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  if (wait) await page.waitForTimeout(wait); // held still there: over ◀ or ▶ the month turns
  await page.mouse.up();
}

const toast = (page: Page) => page.locator("#toast");

/** Answer the question a drop asks: Move, or Cancel. */
async function answerDrop(page: Page, press: "Move" | "Cancel" = "Move") {
  await expect(page.locator("#dlg")).toBeVisible();
  await page.locator(press === "Move" ? "#dlgOk" : "#dlgCancel").click();
  await expect(page.locator("#dlg")).toBeHidden();
}

// ── dragging in the Calendar ─────────────────────────────────────────────

test.describe("dragging a workout in the Calendar", () => {
  test("a chip dropped on another day asks, then moves the workout there and saves the plan; Undo moves it back", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "drag", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await openOnPlan(me, name, "2031-09-01");
    const moved = me.waitForRequest((r) => r.url().endsWith("/api/plans/move"));
    await dragTo(me, await chipOn(me, "2031-09-03", "Morning run"), cellOf(me, "2031-09-05"));
    await expect(me.locator("#dlgTitle")).toHaveText("Move Morning run?");
    await expect(me.locator("#dlgText")).toHaveText(`From ${longLabel("2031-09-03")} to ${longLabel("2031-09-05")}.`); // not on Garmin: Garmin is not mentioned
    await expect(me.locator("#dlgOk")).toHaveText("Move");
    await expect(me.locator("#dlgOk")).toBeFocused();
    await answerDrop(me);
    expect((await moved).postDataJSON()).toEqual(expect.objectContaining({ plans: [{ path, index: 0 }], workoutName: "Morning run", from: "2031-09-03", to: "2031-09-05", garmin: false }));
    await expect(toast(me)).toContainText("Moved Morning run to");
    await expect.poll(() => chipsOnDay(me, "2031-09-05", "Morning run")).toBe(1);
    expect(await chipsOnDay(me, "2031-09-03", "Morning run")).toBe(0);
    await expect(me.locator("#cDayTitle")).toHaveText(longLabel("2031-09-05")); // the day it went to is the one shown
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-05"]);

    await toast(me).getByRole("button", { name: "Undo" }).click();
    await expect(toast(me)).toContainText("Moved Morning run back to");
    await expect.poll(() => chipsOnDay(me, "2031-09-03", "Morning run")).toBe(1);
    expect(await chipsOnDay(me, "2031-09-05", "Morning run")).toBe(0);
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-03"]);
  });

  test("a workout on several days moves on the day it was dragged from only, in Workouts mode too", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "weekly", [{ workoutName: "Long run", workoutType: "running", scheduledDate: ["2031-09-07", "2031-09-14", "2031-09-21"] }]);
    await openOnPlan(me, name, "2031-09-01", "workouts");
    await dragTo(me, await chipOn(me, "2031-09-14", "Long run"), cellOf(me, "2031-09-17"));
    await answerDrop(me);
    await expect(toast(me)).toContainText("Moved Long run to");
    expect(await savedDates(profile.api, path)).toEqual([["2031-09-07", "2031-09-17", "2031-09-21"]]);
    await expect.poll(() => chipsOnDay(me, "2031-09-17", "Long run")).toBe(1);
    for (const day of ["2031-09-07", "2031-09-21"]) expect(await chipsOnDay(me, day, "Long run")).toBe(1);
    expect(await chipsOnDay(me, "2031-09-14", "Long run")).toBe(0);
  });

  test("dropped onto a day that has it already, the workout is on that day once", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "merge", [{ workoutName: "Swim", workoutType: "swimming", scheduledDate: ["2031-09-02", "2031-09-04"] }]);
    await openOnPlan(me, name, "2031-09-01");
    await dragTo(me, await chipOn(me, "2031-09-02", "Swim"), cellOf(me, "2031-09-04"));
    await answerDrop(me);
    await expect(toast(me)).toContainText("Moved Swim to");
    expect(await savedDates(profile.api, path)).toEqual([["2031-09-04"]]);
    await expect.poll(() => chipsOnDay(me, "2031-09-04", "Swim")).toBe(1);
  });

  test("a drop asks first: Cancel, or Escape, leaves the workout where it was and sends nothing", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "ask", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await openOnPlan(me, name, "2031-09-01");
    let sent = 0;
    me.on("request", (r) => { if (r.url().endsWith("/api/plans/move")) sent++; });
    await dragTo(me, await chipOn(me, "2031-09-03", "Morning run"), cellOf(me, "2031-09-05"));
    await answerDrop(me, "Cancel");
    await dragTo(me, await chipOn(me, "2031-09-03", "Morning run"), cellOf(me, "2031-09-06"));
    await expect(me.locator("#dlg")).toBeVisible();
    await me.keyboard.press("Escape");
    await expect(me.locator("#dlg")).toBeHidden();
    expect(await chipsOnDay(me, "2031-09-03", "Morning run")).toBe(1);
    for (const day of ["2031-09-05", "2031-09-06"]) expect(await chipsOnDay(me, day, "Morning run")).toBe(0);
    await expect(me.locator("body")).toHaveAttribute("data-view", "calendar");
    expect(sent).toBe(0);
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-03"]);
  });

  test("let go on its own day, off the days, or after Escape, the workout stays where it was: nothing is asked or sent", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "stay", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await openOnPlan(me, name, "2031-09-01");
    let sent = 0;
    me.on("request", (r) => { if (r.url().endsWith("/api/plans/move")) sent++; });
    const chip = await chipOn(me, "2031-09-03", "Morning run");
    await dragTo(me, chip, cellOf(me, "2031-09-03"));
    await dragTo(me, chip, me.locator("#cLegendTitle"));
    const a = await box(chip), target = await box(cellOf(me, "2031-09-05"));
    await me.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await me.mouse.down();
    await me.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
    await expect(cellOf(me, "2031-09-05")).toHaveClass(/\bdrop\b/); // the day under it is lit
    await me.keyboard.press("Escape");
    await expect(me.locator(".cghost")).toHaveCount(0);
    await me.mouse.up();
    await expect(cellOf(me, "2031-09-05")).not.toHaveClass(/\bdrop\b/);
    expect(await chipsOnDay(me, "2031-09-03", "Morning run")).toBe(1);
    await expect(me.locator("body")).toHaveAttribute("data-view", "calendar"); // a drag is not a click: the plan is not opened
    await expect(me.locator("#dlg")).toBeHidden();
    expect(sent).toBe(0);
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-03"]);
  });

  test("while the chip is held it follows the pointer, dimmed where it was, and a click without a drag still opens the plan", async ({ me, profile }) => {
    const { name } = await addPlan(profile, "ghost", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await openOnPlan(me, name, "2031-09-01");
    const chip = await chipOn(me, "2031-09-03", "Morning run"), a = await box(chip);
    await me.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await me.mouse.down();
    await me.mouse.move(a.x + 160, a.y + 40, { steps: 6 });
    await expect(me.locator(".cghost")).toHaveText("Morning run");
    await expect(chip).toHaveClass(/\blifted\b/);
    const ghost = await box(me.locator(".cghost"));
    expect(Math.abs(ghost.x - (a.x + 170))).toBeLessThanOrEqual(4);
    await me.keyboard.press("Escape");
    await me.mouse.up();
    await expect(chip).not.toHaveClass(/\blifted\b/);

    await chip.click();
    await expect(me.locator("body")).toHaveAttribute("data-view", "plans");
    await expect(me.locator("#outline .row[data-name='Morning run'] .wv-host")).toBeVisible();
  });

  test("held over ▶ the month turns, and the workout can be dropped on a day of the next month", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "turn", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-24" }]);
    await openOnPlan(me, name, "2031-09-01");
    const chip = await chipOn(me, "2031-09-24", "Morning run"), a = await box(chip), next = await box(me.locator("#cNext"));
    await me.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await me.mouse.down();
    await me.mouse.move(next.x + next.width / 2, next.y + next.height / 2, { steps: 10 });
    await expect(me.locator("#cTitle")).toHaveText(monthTitle("2031-10-01"));
    const target = await box(cellOf(me, "2031-10-08")); // the month has turned once: move off the arrow before it turns again
    await me.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 4 });
    await expect(me.locator("#cTitle")).toHaveText(monthTitle("2031-10-01"));
    await me.mouse.up();
    await expect(me.locator("#dlgText")).toHaveText(`From ${longLabel("2031-09-24")} to ${longLabel("2031-10-08")}.`);
    await answerDrop(me);
    await expect(toast(me)).toContainText("Moved Morning run to");
    expect(await savedDates(profile.api, path)).toEqual(["2031-10-08"]);
    await expect.poll(() => chipsOnDay(me, "2031-10-08", "Morning run")).toBe(1);
  });

  test("a move the plan no longer allows is refused, and the calendar shows the plan as it is", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "stale", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await openOnPlan(me, name, "2031-09-01");
    // changed elsewhere since the page read it: the run is on Thursday now
    const doc = await (await profile.api.get(enc(path))).json();
    const res = await profile.api.put(enc(path), { data: { text: JSON.stringify({ weekStart: "2031-09-01", weekEnd: "2031-09-07", workouts: [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-04" }] }), version: doc.version } });
    expect(res.ok()).toBeTruthy();
    await dragTo(me, await chipOn(me, "2031-09-03", "Morning run"), cellOf(me, "2031-09-05"));
    await answerDrop(me);
    await expect(toast(me)).toContainText("is not on 2031-09-03");
    await expect.poll(() => chipsOnDay(me, "2031-09-04", "Morning run")).toBe(1);
    expect(await chipsOnDay(me, "2031-09-05", "Morning run")).toBe(0);
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-04"]);
  });
});

// ── Move… in the day panel ───────────────────────────────────────────────

test.describe("Move… in the Calendar's day panel", () => {
  test("offers the day before, the day after and a week later, and moves the workout to the one picked", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "menu", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await openOnPlan(me, name, "2031-09-01");
    await cellOf(me, "2031-09-03").click({ position: { x: 6, y: 6 } });
    const row = me.locator("#cDay .citem", { hasText: "Morning run" });
    await row.getByRole("button", { name: "Move…" }).click();
    const menu = me.locator("#moveMenu");
    await expect(menu).toBeVisible();
    const short = (day: string) => new Intl.DateTimeFormat("en-CA", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
    await expect(me.locator("#mvTitle")).toHaveText(`Move ${short("2031-09-03")} to…`);
    await expect(me.locator("#mvPrev")).toHaveText(`◀ ${short("2031-09-02")}`);
    await expect(me.locator("#mvNext")).toHaveText(`${short("2031-09-04")} ▶`);
    await expect(me.locator("#mvWeek")).toHaveText(`${short("2031-09-10")} (+1 week)`);
    await expect(me.locator("#mvNext")).toBeFocused();
    // the menu sits by the button it came from
    const [b, m] = await Promise.all([box(row.getByRole("button", { name: "Move…" })), box(menu)]);
    expect(Math.abs(m.y - (b.y + b.height + 4)) < 2 || Math.abs(m.y + m.height - (b.y - 4)) < 2).toBe(true);

    await me.locator("#mvWeek").click();
    await expect(menu).toBeHidden();
    await expect(toast(me)).toContainText("Moved Morning run to");
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-10"]);
    await expect(me.locator("#cDayTitle")).toHaveText(longLabel("2031-09-10"));
    await expect(me.locator("#cDay .citem", { hasText: "Morning run" })).toBeVisible();
  });

  test("moves the workout to any day typed in, and Escape or a click outside closes the menu without moving it", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "anyday", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await openOnPlan(me, name, "2031-09-01");
    await cellOf(me, "2031-09-03").click({ position: { x: 6, y: 6 } });
    const move = me.locator("#cDay .citem", { hasText: "Morning run" }).getByRole("button", { name: "Move…" });
    await move.click();
    await me.keyboard.press("Escape");
    await expect(me.locator("#moveMenu")).toBeHidden();
    await expect(move).toBeFocused(); // back on the button it came from
    await move.click();
    await me.locator("#cTitle").click();
    await expect(me.locator("#moveMenu")).toBeHidden();
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-03"]);

    await move.click();
    await expect(me.locator("#mvDate")).toHaveValue("2031-09-03");
    await me.locator("#mvDate").fill("2031-12-25");
    await me.locator("#mvAny").getByRole("button", { name: "Move" }).click();
    await expect(toast(me)).toContainText("Moved Morning run to");
    expect(await savedDates(profile.api, path)).toEqual(["2031-12-25"]);
  });

  test("the day panel says how moving works behind its ⓘ", async ({ me, profile }) => {
    const { name } = await addPlan(profile, "about", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await openOnPlan(me, name, "2031-09-01");
    await cellOf(me, "2031-09-03").click({ position: { x: 6, y: 6 } });
    const info = me.locator("#cDay").getByRole("button", { name: "About moving a workout" });
    await expect(me.locator("#cDay .help")).toBeHidden();
    await info.click();
    await expect(me.locator("#cDay .help")).toContainText("Drag a workout onto another day to move it");
  });
});

// ── the days in a workout's picture ──────────────────────────────────────

test.describe("the Move menu of a workout's days in the Plans view", () => {
  /** The plan opened from its chip, on the outline with the workout's picture open. */
  async function openPicture(page: Page, plan: string, day: string, workout: string) {
    await openOnPlan(page, plan, "2031-09-01");
    await (await chipOn(page, day, workout)).click();
    await expect(page.locator("body")).toHaveAttribute("data-view", "plans");
    const row = page.locator(`#outline .row[data-name='${workout}']`);
    await expect(row.locator(".wv-host")).toBeVisible();
    return row;
  }

  test("each day the workout is on opens a Move menu; the move saves the plan, and the editor and the picture show it", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "picture", [{ workoutName: "Long run", workoutType: "running", scheduledDate: ["2031-09-07", "2031-09-14"] }]);
    const row = await openPicture(me, name, "2031-09-07", "Long run");
    const days = row.locator(".wv-days .wv-day");
    await expect(days).toHaveCount(2);
    await expect(row.locator(".wv-days small")).toHaveText("Scheduled");
    await row.getByRole("button", { name: `Move ${longLabel("2031-09-14")} to another day` }).click();
    await me.locator("#mvNext").click();
    await expect(toast(me)).toContainText("Moved Long run to");
    expect(await savedDates(profile.api, path)).toEqual([["2031-09-07", "2031-09-15"]]);
    // the editor holds the plan as saved: nothing to save, and the picture shows the new day
    await expect(me.locator("#save")).toBeDisabled();
    await expect(row.getByRole("button", { name: `Move ${longLabel("2031-09-15")} to another day` })).toBeVisible();
    await expect.poll(() => me.evaluate(() => editor.getValue())).toContain('"2031-09-15"');

    await toast(me).getByRole("button", { name: "Undo" }).click();
    await expect(toast(me)).toContainText("Moved Long run back to");
    expect(await savedDates(profile.api, path)).toEqual([["2031-09-07", "2031-09-14"]]);
    await expect(row.getByRole("button", { name: `Move ${longLabel("2031-09-14")} to another day` })).toBeVisible();
  });

  test("a plan with unsaved changes is saved first, once asked; Cancel moves nothing", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "unsaved", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }, { workoutName: "Swim", workoutType: "swimming", scheduledDate: "2031-09-04" }]);
    const row = await openPicture(me, name, "2031-09-03", "Morning run");
    // an unsaved change: Duplicate the swim in the outline
    await me.locator("#outline .row[data-name='Swim']").getByRole("button", { name: "Duplicate" }).click();
    await expect(me.locator("#save")).toBeEnabled();

    await row.getByRole("button", { name: `Move ${longLabel("2031-09-03")} to another day` }).click();
    await me.locator("#mvNext").click();
    await expect(me.locator("#dlg")).toBeVisible();
    await expect(me.locator("#dlgTitle")).toHaveText("Save the plan first?");
    await me.locator("#dlgCancel").click();
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-03", "2031-09-04"]);
    await expect(me.locator("#save")).toBeEnabled();

    await row.getByRole("button", { name: `Move ${longLabel("2031-09-03")} to another day` }).click();
    await me.locator("#mvNext").click();
    await me.locator("#dlgOk").click();
    await expect(toast(me)).toContainText("Moved Morning run to");
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-04", "2031-09-04", "2031-09-04"]); // the copy of the swim was saved with it
    await expect(me.locator("#save")).toBeDisabled();
  });
});

test.describe("the Move menu of a workout's days in the Workouts view", () => {
  test("lists the days the plans put the workout on, and moves one in the plan, asking Garmin to follow", async ({ me, profile }) => {
    const plan = { workoutName: "Morning run", workoutType: "running", workoutId: 4242, scheduledDate: ["2031-09-03", "2031-09-10"] };
    const { path } = await addPlan(profile, "garmin", [plan]);
    // the suite has no Garmin: the page is told this profile has one, and Garmin's answers come from the plan file as it stands
    const entry = async () => {
      const doc = await (await profile.api.get(enc(path))).json();
      return { path, index: 0, version: doc.version, workout: JSON.parse(doc.text).workouts[0], differences: [] };
    };
    await me.route("**/api/garmin", async (route) => {
      const info = await (await route.fetch()).json();
      await route.fulfill({ json: { ...info, enabled: true, connected: [profile.name], profileInfo: { [profile.name]: { ...info.profileInfo[profile.name], garmin: true } } } });
    });
    await me.route("**/api/workouts?*", async (route) => {
      const e = await entry();
      await route.fulfill({ json: { profile: profile.name, truncated: false, rows: [{ key: "g:4242", workoutId: 4242, workoutName: "Morning run", workoutType: "running", plans: [{ path, index: 0, version: e.version }], dates: [e.workout.scheduledDate].flat(), state: "linked" }] } });
    });
    await me.route("**/api/garmin/workout?*", async (route) => route.fulfill({ json: { profile: profile.name, workout: { workoutId: 4242, workoutName: "Morning run", workoutType: "running", steps: [] }, plans: [await entry()] } }));
    await me.route("**/api/garmin/status", (route) => route.fulfill({ json: { profile: profile.name, statuses: [{ index: 0, state: "synced", differences: [] }] } }));

    const short = (day: string) => new Intl.DateTimeFormat("en-CA", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
    await openView(me, "workouts");
    await me.locator("#wrows .wrow", { hasText: "Morning run" }).click();
    const detail = me.locator("#wbody");
    await expect(detail.locator(".wv-days .wv-day")).toHaveCount(2);
    const moved = me.waitForRequest((r) => r.url().endsWith("/api/plans/move"));
    await detail.getByRole("button", { name: `Move ${longLabel("2031-09-10")} to another day` }).click();
    await me.locator("#mvPrev").click();
    expect((await moved).postDataJSON()).toEqual(expect.objectContaining({ plans: [{ path, index: 0 }], workoutName: "Morning run", from: "2031-09-10", to: "2031-09-09", garmin: true, confirm: true, profile: profile.name }));
    // the real server has no Garmin login for the profile: the plan moves, and Garmin's calendar is not mentioned
    await expect(toast(me)).toHaveText(`Moved Morning run to ${short("2031-09-09")}.Undo`);
    expect(await savedDates(profile.api, path)).toEqual([["2031-09-03", "2031-09-09"]]);
    await expect(detail.getByRole("button", { name: `Move ${longLabel("2031-09-09")} to another day` })).toBeVisible();
  });

  test("a drop does not speak of Garmin to a profile without a Garmin login, even for a workout with a workoutId", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "nologin", [{ workoutName: "Morning run", workoutType: "running", workoutId: 4242, scheduledDate: "2031-09-03" }]);
    await openOnPlan(me, name, "2031-09-01");
    const short = (day: string) => new Intl.DateTimeFormat("en-CA", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
    await dragTo(me, await chipOn(me, "2031-09-03", "Morning run"), cellOf(me, "2031-09-04"));
    await expect(me.locator("#dlgText")).toHaveText(`From ${longLabel("2031-09-03")} to ${longLabel("2031-09-04")}.`);
    await answerDrop(me);
    await expect(toast(me)).toHaveText(`Moved Morning run to ${short("2031-09-04")}.Undo`);
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-04"]);
  });

  test("says when Garmin's calendar moved too, or why it did not", async ({ me, profile }) => {
    const { path, name } = await addPlan(profile, "said", [{ workoutName: "Morning run", workoutType: "running", workoutId: 4242, scheduledDate: "2031-09-03" }]);
    const answers = [{ state: "moved" }, { state: "not-scheduled" }, { state: "failed", reason: "Garmin said 500" }];
    // the suite has no Garmin: the page is told this profile has one, and Garmin's part of each answer is made up
    await me.route("**/api/garmin", async (route) => {
      const info = await (await route.fetch()).json();
      await route.fulfill({ json: { ...info, enabled: true, connected: [profile.name], profileInfo: { [profile.name]: { ...info.profileInfo[profile.name], garmin: true } } } });
    });
    await me.route("**/api/plans/move", async (route) => {
      const r = await (await route.fetch()).json();
      await route.fulfill({ json: { ...r, garmin: answers.shift() } });
    });
    await openOnPlan(me, name, "2031-09-01");
    const short = (day: string) => new Intl.DateTimeFormat("en-CA", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
    await dragTo(me, await chipOn(me, "2031-09-03", "Morning run"), cellOf(me, "2031-09-04"));
    await expect(me.locator("#dlgText")).toContainText(`If Garmin's calendar has it on ${longLabel("2031-09-03")}, it moves there too.`); // on Garmin: the question says so
    await answerDrop(me);
    await expect(toast(me)).toContainText(`Moved Morning run to ${short("2031-09-04")}, on Garmin's calendar too.`);
    await expect.poll(() => chipsOnDay(me, "2031-09-04", "Morning run")).toBe(1);
    await dragTo(me, await chipOn(me, "2031-09-04", "Morning run"), cellOf(me, "2031-09-05"));
    await answerDrop(me);
    await expect(toast(me)).toContainText(`Moved Morning run to ${short("2031-09-05")}; Garmin's calendar did not have it on ${short("2031-09-04")}.`);
    await expect.poll(() => chipsOnDay(me, "2031-09-05", "Morning run")).toBe(1);
    await dragTo(me, await chipOn(me, "2031-09-05", "Morning run"), cellOf(me, "2031-09-06"));
    await answerDrop(me);
    await expect(toast(me)).toContainText(`Moved Morning run to ${short("2031-09-06")}, but not on Garmin's calendar: Garmin said 500.`);
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-06"]);
  });
});
