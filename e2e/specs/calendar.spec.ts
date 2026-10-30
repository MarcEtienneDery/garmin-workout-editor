/**
 * The Calendar view: where the plan files put their workouts, as a month grid in two modes (Plans: a bar per plan across its span;
 * Workouts: a chip per scheduled workout). Alice's plans are read-only and seeded relative to today; the fresh profiles made here
 * use dates in 2031, so no other spec's data lands on their months.
 */
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect, openView, loginAs, today, daysAgo, daysAhead, mondayOf, PASSWORD } from "../support/fixtures";

// The machine is shared by every spec run at once: a page can take many seconds to answer, so each test has more than the default 30 s.
test.describe.configure({ timeout: 60_000 });

// ── helpers ──────────────────────────────────────────────────────────────

/** The month title and the long day label the page shows (en-CA, as the browser formats them). */
const monthTitle = (day: string) => new Intl.DateTimeFormat("en-CA", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
const longLabel = (day: string) => new Intl.DateTimeFormat("en-CA", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
const monthDiff = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The first day of the month `n` months away from a day's month ("YYYY-MM-01"). */
const monthOffset = (day: string, n: number) => {
  const [y, m] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};
/** What a day's number reads in its cell: the number, or "Oct 1" on the first of a month. */
const dayNumber = (day: string) => (day.endsWith("-01") ? `${new Intl.DateTimeFormat("en-CA", { month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`))} 1` : String(Number(day.slice(8))));

/** How a month is laid out: the days before its first (Monday-first), its length and how many week rows the grid has. */
function monthShape(day: string) {
  const [y, m] = day.split("-").map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { lead, days, weeks: Math.ceil((lead + days) / 7) };
}

const cellOf = (page: Page, day: string) => page.getByRole("button", { name: longLabel(day), exact: true });
const weekOf = (page: Page, day: string) => page.locator(".cweek").filter({ has: cellOf(page, day) });

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("the element has no box");
  return b;
}

/** Left and right edges of a bar sit on the cell's edges (2 px of slack for the bar's margin and border). */
async function expectSpans(bar: Locator, from: Locator, to: Locator) {
  const [b, a, z] = await Promise.all([box(bar), box(from), box(to)]);
  expect(Math.abs(b.x - a.x)).toBeLessThanOrEqual(3);
  expect(Math.abs(b.x + b.width - (z.x + z.width))).toBeLessThanOrEqual(3);
}

/** Open the Calendar view and wait until the plans have arrived (the page's own "Loading…" note has gone). */
async function openCalendar(page: Page): Promise<void> {
  await openView(page, "calendar");
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(page.locator("#cNote")).not.toContainText("Loading", { timeout: 20_000 });
    if (!(await page.locator("#cNote").evaluate((e) => e.classList.contains("err")))) return;
    // the page shows "Failed to fetch" when a load is dropped and does not ask again: press its reload button, as a person would
    await page.locator("#cRefresh").click();
  }
}

/** Show the month of a day: Today first (which also selects today), then the arrows for the months between. */
async function goToMonthOf(page: Page, day: string) {
  await page.locator("#cToday").click();
  const n = monthDiff(today(), day);
  for (let i = 0; i < Math.abs(n); i++) await page.locator(n < 0 ? "#cPrev" : "#cNext").click();
  await expect(page.locator("#cTitle")).toHaveText(monthTitle(day));
}

/** How many chips named `name` sit in the column of `day`: a week row can hold the same workout on two of its days. */
async function chipsOnDay(page: Page, day: string, name: string): Promise<number> {
  return page.evaluate(
    ({ label, name }) => {
      const cell = [...document.querySelectorAll<HTMLElement>("#cgrid .cday")].find((c) => c.getAttribute("aria-label") === label);
      if (!cell) return -1;
      const r = cell.getBoundingClientRect();
      const chips = [...(cell.closest(".cweek")?.querySelectorAll<HTMLElement>(".cbar.wk") ?? [])];
      return chips.filter((chip) => {
        const b = chip.getBoundingClientRect();
        const mid = b.left + b.width / 2;
        return chip.textContent === name && mid >= r.left && mid <= r.right;
      }).length;
    },
    { label: longLabel(day), name },
  );
}

/** Click a plan's row in the legend (the row jumps to the plan's first month). */
const legendRow = (page: Page, name: string) => page.locator("#cLegend .citem", { hasText: name });

/** A plan file for a profile, made through the API (201 when made). The name carries the profile's name: plan files share one folder. */
async function addPlan(api: APIRequestContext, name: string, plan: unknown): Promise<string> {
  const path = `workout-plans/${name}.json`;
  const res = await api.put(`/api/file?path=${encodeURIComponent(path)}`, { data: { text: JSON.stringify(plan), create: true } });
  expect(res.status(), await res.text()).toBe(201);
  return path;
}

/** What the calendar gets when there are no plans at all (a test stubs the API for it: the shared plan is seen by every profile). */
const NO_PLANS = { plans: [] };

// Alice's seeded plans (see e2e/support/seed.ts): their names in the legend and the workouts on the grid.
const RUN_BLOCK = "alice-run-block";
const SOMEDAY = "alice-someday";
const SHARED = "shared-base";
const GREEN = "rgb(42, 125, 99)"; // running
const BLUE = "rgb(58, 104, 176)"; // strength training
const GREY = "rgb(102, 102, 102)"; // anything else (walking)

// ── the month grid ───────────────────────────────────────────────────────

test.describe("month grid", () => {
  test("opens on the current month in Plans mode", async ({ alice }) => {
    await openCalendar(alice);
    await expect(alice.locator("#cTitle")).toHaveText(monthTitle(today()));
    await expect(alice.locator("#cModes button[data-mode=plans]")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#cModes button[data-mode=workouts]")).toHaveAttribute("aria-pressed", "false");
  });

  test("the weekday header runs Monday to Sunday", async ({ alice }) => {
    await openCalendar(alice);
    await expect(alice.locator("#cdow span")).toHaveText(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });

  test("each week is a row from Monday to Sunday, with every day of the month once", async ({ alice }) => {
    await openCalendar(alice);
    const shape = monthShape(today());
    await expect(alice.locator("#cgrid .cweek")).toHaveCount(shape.weeks);
    await expect(alice.locator("#cgrid .cweek .cday")).toHaveCount(shape.weeks * 7);
    await expect(alice.locator("#cgrid .cday:not(.out)")).toHaveCount(shape.days);
    const firsts = await alice.locator("#cgrid .cweek").evaluateAll((weeks) => weeks.map((w) => w.querySelector(".cday")?.getAttribute("aria-label") ?? ""));
    expect(firsts).toHaveLength(shape.weeks);
    for (const label of firsts) expect(label.startsWith("Monday,")).toBeTruthy();
  });

  test("the days of the neighbouring months are dimmed and not counted in the month", async ({ alice }) => {
    await openCalendar(alice);
    const shape = monthShape(today());
    const dimmed = alice.locator("#cgrid .cday.out");
    await expect(dimmed).toHaveCount(shape.weeks * 7 - shape.days);
    // a month that starts on a Monday and fills its last week has no neighbouring days to dim
    if (shape.weeks * 7 - shape.days > 0) await expect(dimmed.first()).toHaveCSS("background-color", "rgb(26, 26, 26)");
    // the first cell of a grid that starts mid-week is the last days of the month before
    if (shape.lead > 0) await expect(alice.locator("#cgrid .cday").first()).toHaveClass(/out/);
  });

  test("today's cell is the one marked, and the side panel opens on today", async ({ alice }) => {
    await openCalendar(alice);
    await expect(alice.locator("#cgrid .cday.today")).toHaveCount(1);
    await expect(alice.locator("#cgrid .cday.today")).toHaveAttribute("aria-label", longLabel(today()));
    await expect(alice.locator("#cgrid .cday.today .dnum")).toHaveText(dayNumber(today()));
    await expect(alice.locator("#cgrid .cday.sel")).toHaveAttribute("aria-label", longLabel(today()));
    await expect(alice.locator("#cDayTitle")).toHaveText(longLabel(today()));
  });

  test("the next and previous arrows move one month at a time", async ({ alice }) => {
    await openCalendar(alice);
    await alice.locator("#cNext").click();
    await expect(alice.locator("#cTitle")).toHaveText(monthTitle(monthOffset(today(), 1)));
    await alice.locator("#cPrev").click();
    await alice.locator("#cPrev").click();
    await expect(alice.locator("#cTitle")).toHaveText(monthTitle(monthOffset(today(), -1)));
    await alice.locator("#cNext").click();
    await expect(alice.locator("#cTitle")).toHaveText(monthTitle(monthOffset(today(), 0)));
  });

  test("the Today button comes back to the current month and selects today", async ({ alice }) => {
    await openCalendar(alice);
    await alice.locator("#cPrev").click();
    await alice.locator("#cPrev").click();
    await alice.locator("#cPrev").click();
    await expect(alice.locator("#cTitle")).not.toHaveText(monthTitle(today()));
    await alice.locator("#cToday").click();
    await expect(alice.locator("#cTitle")).toHaveText(monthTitle(today()));
    await expect(alice.locator("#cDayTitle")).toHaveText(longLabel(today()));
  });

  test("moving forward past December reaches January of the next year, and back again", async ({ alice }) => {
    await openCalendar(alice);
    const toJanuary = 13 - Number(today().slice(5, 7)); // the months up to and including January of next year
    for (let i = 0; i < toJanuary; i++) await alice.locator("#cNext").click();
    await expect(alice.locator("#cTitle")).toHaveText(monthTitle(`${Number(today().slice(0, 4)) + 1}-01-01`));
    await alice.locator("#cPrev").click();
    await expect(alice.locator("#cTitle")).toHaveText(monthTitle(`${Number(today().slice(0, 4))}-12-01`));
  });

  test("moving back past January reaches December of the year before", async ({ alice }) => {
    await openCalendar(alice);
    // stepping back month by month from this month's number reaches December of the year before
    for (let i = 0; i < Number(today().slice(5, 7)); i++) await alice.locator("#cPrev").click();
    await expect(alice.locator("#cTitle")).toHaveText(monthTitle(`${Number(today().slice(0, 4)) - 1}-12-01`));
  });

  test("clicking a day selects it, and the side panel shows its date", async ({ alice }) => {
    await openCalendar(alice);
    // the neighbour of today in this month (tomorrow, or yesterday on the last day of the month)
    const other = Number(today().slice(8)) < monthShape(today()).days ? addDays(today(), 1) : addDays(today(), -1);
    await cellOf(alice, other).click({ position: { x: 6, y: 6 } });
    await expect(alice.locator("#cgrid .cday.sel")).toHaveCount(1);
    await expect(alice.locator("#cgrid .cday.sel")).toHaveAttribute("aria-label", longLabel(other));
    await expect(alice.locator("#cDayTitle")).toHaveText(longLabel(other));
  });

  test("a day with no plan or workout says so in the side panel", async ({ alice }) => {
    await openCalendar(alice);
    await goToMonthOf(alice, "2025-06-16");
    await cellOf(alice, "2025-06-16").click({ position: { x: 6, y: 6 } });
    await expect(alice.locator("#cDayTitle")).toHaveText(longLabel("2025-06-16"));
    await expect(alice.locator("#cDay")).toHaveText("Nothing on this day.");
  });

  test("a day can be selected from the keyboard", async ({ alice }) => {
    await openCalendar(alice);
    const day = addDays(mondayOf(today()), 2); // Wednesday of this week
    await goToMonthOf(alice, day);
    await cellOf(alice, day).focus();
    await alice.keyboard.press("Enter");
    await expect(alice.locator("#cDayTitle")).toHaveText(longLabel(day));
    await expect(cellOf(alice, day)).toHaveClass(/sel/);
  });
});

// ── Plans mode ───────────────────────────────────────────────────────────

test.describe("Plans mode", () => {
  test("a plan is one bar across the week it covers, and alice's run block spans the whole current week", async ({ alice }) => {
    await openCalendar(alice);
    const week = weekOf(alice, today());
    const bar = week.getByRole("button", { name: RUN_BLOCK, exact: true });
    await expect(bar).toHaveCount(1);
    const [b, row] = await Promise.all([box(bar), box(week)]);
    // the plan starts on this Monday and runs past this Sunday, so the bar fills the row
    expect(Math.abs(b.x - row.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(b.width - row.width)).toBeLessThanOrEqual(3);
  });

  test("two plans that overlap are drawn on separate rows", async ({ alice }) => {
    await openCalendar(alice);
    const week = weekOf(alice, today());
    const run = await box(week.getByRole("button", { name: RUN_BLOCK, exact: true }));
    const shared = await box(week.getByRole("button", { name: SHARED, exact: true }));
    expect(shared.y).toBeGreaterThanOrEqual(run.y + run.height - 1);
  });

  test("each plan's bar is named and its tooltip gives its file and owner", async ({ alice }) => {
    await openCalendar(alice);
    const bar = weekOf(alice, today()).getByRole("button", { name: RUN_BLOCK, exact: true });
    await expect(bar).toHaveAttribute("title", /workout-plans\/alice-run-block\.json \(alice\)/);
    await expect(bar).toHaveAttribute("title", /4 of 4 workouts dated/);
  });

  test("a plan with no dated workout is drawn dashed, and the legend says why", async ({ alice }) => {
    await openCalendar(alice);
    await legendRow(alice, SOMEDAY).click();
    await expect(alice.locator("#cTitle")).toHaveText(monthTitle("2026-01-01"));
    const bar = alice.getByRole("button", { name: SOMEDAY, exact: true }).first();
    await expect(bar).toHaveCSS("border-top-style", "dashed");
    await expect(bar).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(legendRow(alice, SOMEDAY)).toContainText("no workout has a scheduledDate");
  });

  test("a plan whose workouts are dated is drawn solid", async ({ alice }) => {
    await openCalendar(alice);
    const bar = weekOf(alice, today()).getByRole("button", { name: RUN_BLOCK, exact: true });
    await expect(bar).toHaveCSS("border-top-style", "solid");
  });

  test("clicking a plan bar opens that plan in the Plans view", async ({ alice }) => {
    await openCalendar(alice);
    await weekOf(alice, today()).getByRole("button", { name: RUN_BLOCK, exact: true }).click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "plans");
    await expect(alice.locator("#current")).toContainText("alice-run-block.json");
  });

  test("the legend lists alice's plans with their spans and the undated plan's window", async ({ alice }) => {
    await openCalendar(alice);
    await expect(alice.locator("#cLegend .citem .n", { hasText: RUN_BLOCK })).toHaveCount(1);
    await expect(alice.locator("#cLegend .citem .n", { hasText: SHARED })).toHaveCount(1);
    await expect(alice.locator("#cLegend .citem .n", { hasText: SOMEDAY })).toHaveCount(1);
    await expect(legendRow(alice, RUN_BLOCK)).toContainText("4 of 4 workouts dated");
    await expect(legendRow(alice, SHARED)).toContainText("1 of 1 workouts dated");
  });

  test("the legend's Open button opens the plan in the Plans view", async ({ alice }) => {
    await openCalendar(alice);
    await legendRow(alice, SOMEDAY).getByRole("button", { name: "Open", exact: true }).click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "plans");
    await expect(alice.locator("#current")).toContainText("alice-someday.json");
  });

  test("clicking a legend row jumps to the plan's first month", async ({ alice }) => {
    await openCalendar(alice);
    await legendRow(alice, SOMEDAY).click();
    await expect(alice.locator("#cTitle")).toHaveText(monthTitle("2026-01-01"));
    await expect(alice.locator("#cModes button[data-mode=plans]")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("body")).toHaveAttribute("data-view", "calendar");
  });

  test("the side panel lists the plans a day falls in, with their span", async ({ alice }) => {
    await openCalendar(alice);
    await cellOf(alice, today()).click({ position: { x: 6, y: 6 } });
    await expect(alice.locator("#cDay .clabel").first()).toHaveText(/^In plans?$/);
    await expect(alice.locator("#cDay")).toContainText(RUN_BLOCK);
    await expect(alice.locator("#cDay")).toContainText(SHARED);
  });

  test("a plan's span runs to its last scheduled date beyond its week, and the bar continues into the next week", async ({ me, profile }) => {
    await addPlan(profile.api, `${profile.name}-far`, {
      weekStart: "2031-03-03",
      weekEnd: "2031-03-09",
      workouts: [{ workoutName: "Far run", workoutType: "running", scheduledDate: "2031-03-19" }],
    });
    await openCalendar(me);
    await legendRow(me, `${profile.name}-far`).click();
    await expect(me.locator("#cTitle")).toHaveText(monthTitle("2031-03-01"));
    const week = weekOf(me, "2031-03-17");
    const bar = week.getByRole("button", { name: `${profile.name}-far`, exact: true });
    await expect(bar).toHaveCount(1);
    // the bar in the week of the 17th stops at Wednesday the 19th
    await expectSpans(bar, week.locator(".cday").first(), cellOf(me, "2031-03-19"));
    await expect(weekOf(me, "2031-03-10").getByRole("button", { name: `${profile.name}-far`, exact: true })).toHaveCount(1);
  });
});

// ── Workouts mode ────────────────────────────────────────────────────────

test.describe("Workouts mode", () => {
  test("each scheduled day gets a chip with the workout's name, on the day itself", async ({ alice }) => {
    await openCalendar(alice);
    await alice.locator("#cModes button[data-mode=workouts]").click();
    await expect(alice.locator("#cModes button[data-mode=workouts]")).toHaveAttribute("aria-pressed", "true");
    // Easy run two days ago, Tempo intervals today, Long run in three days, Shared walk in two
    for (const [day, name] of [[daysAgo(2), "Easy run"], [today(), "Tempo intervals"], [daysAhead(3), "Long run"], [daysAhead(2), "Shared walk"]] as const) {
      await goToMonthOf(alice, day);
      await expect.poll(() => chipsOnDay(alice, day, name)).toBe(1);
      const chip = weekOf(alice, day).getByRole("button", { name, exact: true });
      const [c, cell] = await Promise.all([box(chip), box(cellOf(alice, day))]);
      const mid = c.x + c.width / 2;
      expect(mid).toBeGreaterThan(cell.x);
      expect(mid).toBeLessThan(cell.x + cell.width);
    }
  });

  test("a workout with several dates gets a chip on each of them", async ({ alice }) => {
    await openCalendar(alice);
    await alice.locator("#cModes button[data-mode=workouts]").click();
    for (const day of [daysAhead(1), daysAhead(5)]) {
      await goToMonthOf(alice, day);
      await expect.poll(() => chipsOnDay(alice, day, "Full body strength")).toBe(1);
    }
  });

  test("chips are coloured by the workout's type: running green, strength blue, anything else grey", async ({ alice }) => {
    await openCalendar(alice);
    await alice.locator("#cModes button[data-mode=workouts]").click();
    await goToMonthOf(alice, today());
    await expect(weekOf(alice, today()).getByRole("button", { name: "Tempo intervals", exact: true })).toHaveCSS("background-color", GREEN);
    await goToMonthOf(alice, daysAhead(1));
    await expect(weekOf(alice, daysAhead(1)).getByRole("button", { name: "Full body strength", exact: true })).toHaveCSS("background-color", BLUE);
    await goToMonthOf(alice, daysAhead(2));
    await expect(weekOf(alice, daysAhead(2)).getByRole("button", { name: "Shared walk", exact: true })).toHaveCSS("background-color", GREY);
  });

  test("clicking a chip opens the plan in the Plans view with the workout's picture open", async ({ alice }) => {
    await openCalendar(alice);
    await alice.locator("#cModes button[data-mode=workouts]").click();
    await goToMonthOf(alice, today());
    await weekOf(alice, today()).getByRole("button", { name: "Tempo intervals", exact: true }).click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "plans");
    await expect(alice.locator("#current")).toContainText("alice-run-block.json");
    const row = alice.locator("#outline .row[data-name='Tempo intervals']");
    await expect(row.locator(".name")).toHaveAttribute("aria-expanded", "true");
    await expect(row.locator(".wv-host")).toBeVisible();
  });

  test("the side panel of a day with a workout lists it under Workout, with its type and plan", async ({ alice }) => {
    await openCalendar(alice);
    await alice.locator("#cModes button[data-mode=workouts]").click();
    await goToMonthOf(alice, today());
    await cellOf(alice, today()).click({ position: { x: 6, y: 6 } });
    await expect(alice.locator("#cDay .clabel").first()).toHaveText("Workout");
    await expect(alice.locator("#cDay .citem", { hasText: "Tempo intervals" })).toContainText("Running · alice-run-block");
  });

  test("the legend lists the workout types scheduled, with how many dates each has", async ({ alice }) => {
    await openCalendar(alice);
    await alice.locator("#cModes button[data-mode=workouts]").click();
    await expect(alice.locator("#cLegendTitle")).toHaveText("Workout types");
    await expect(alice.locator("#cLegend .citem", { hasText: "Strength Training" })).toContainText("scheduled");
    await expect(alice.locator("#cLegend .citem", { hasText: "Running" })).toContainText("scheduled");
    await expect(alice.locator("#cLegend .citem", { hasText: "Walking" })).toContainText("1 scheduled");
  });

  test("a month with scheduled workouts elsewhere says so, with a button to the nearest of them", async ({ alice }) => {
    await openCalendar(alice);
    await alice.locator("#cModes button[data-mode=workouts]").click();
    await goToMonthOf(alice, "2025-06-16");
    await expect(alice.locator("#cNote")).toContainText("Nothing scheduled in June 2025.");
    const next = alice.locator("#cNote button").last();
    const label = (await next.textContent())!.replace(/\s*→$/, "");
    await next.click();
    await expect(alice.locator("#cTitle")).toHaveText(label);
  });
});

// ── fresh profiles: what the files say, as the calendar draws it ──────────

test.describe("a profile's own plans", () => {
  test("a plan with no dates at all is listed as 'No dates yet' and is not on the grid", async ({ me, profile }) => {
    const name = `${profile.name}-someday`;
    await addPlan(profile.api, name, { workouts: [{ workoutName: "Someday run", workoutType: "running", distanceMeters: 5000 }] });
    await openCalendar(me);
    await expect(legendRow(me, name)).toContainText("No dates yet");
    await expect(me.locator("#cgrid").getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(me.locator("#cgrid .cbar.wk", { hasText: "Someday run" })).toHaveCount(0);
  });

  test("clicking the undated plan's row opens it in the Plans view", async ({ me, profile }) => {
    const name = `${profile.name}-undated`;
    await addPlan(profile.api, name, { workouts: [{ workoutName: "Loose run", workoutType: "running" }] });
    await openCalendar(me);
    await legendRow(me, name).click();
    await expect(me.locator("body")).toHaveAttribute("data-view", "plans");
    await expect(me.locator("#current")).toContainText(`${name}.json`);
  });

  test("a plan with a week range but no scheduled date is drawn dashed, with its week as the span", async ({ me, profile }) => {
    const name = `${profile.name}-window`;
    await addPlan(profile.api, name, { weekStart: "2031-05-05", weekEnd: "2031-05-11", workouts: [{ workoutName: "Window run", workoutType: "running" }] });
    await openCalendar(me);
    await legendRow(me, name).click();
    await expect(me.locator("#cTitle")).toHaveText(monthTitle("2031-05-01"));
    const bar = me.getByRole("button", { name, exact: true });
    await expect(bar).toHaveCSS("border-top-style", "dashed");
    await expect(legendRow(me, name)).toContainText("May 5 – May 11, 2031");
    await expect(legendRow(me, name)).toContainText("no workout has a scheduledDate");
  });

  test("a workout with several dates puts a chip on every date, and two workouts on one day stack", async ({ me, profile }) => {
    const name = `${profile.name}-dates`;
    await addPlan(profile.api, name, {
      weekStart: "2031-03-03",
      weekEnd: "2031-03-09",
      workouts: [
        { workoutName: "Intervals", workoutType: "running", scheduledDate: ["2031-03-04", "2031-03-06"] },
        { workoutName: "Long", workoutType: "running", scheduledDate: "2031-03-06" },
      ],
    });
    await openCalendar(me);
    await legendRow(me, name).click();
    await me.locator("#cModes button[data-mode=workouts]").click();
    await expect(me.locator("#cTitle")).toHaveText(monthTitle("2031-03-01"));
    // the one workout is on both of its dates: the 4th and the 6th share a week row
    await expect.poll(() => chipsOnDay(me, "2031-03-04", "Intervals")).toBe(1);
    await expect.poll(() => chipsOnDay(me, "2031-03-06", "Intervals")).toBe(1);
    await expect.poll(() => chipsOnDay(me, "2031-03-06", "Long")).toBe(1);
    await expect.poll(() => chipsOnDay(me, "2031-03-04", "Long")).toBe(0);
    // the 6th has both workouts, one chip under the other
    const thu = weekOf(me, "2031-03-06");
    const first = await box(thu.getByRole("button", { name: "Intervals", exact: true }).first());
    const second = await box(thu.getByRole("button", { name: "Long", exact: true }));
    expect(second.y).toBeGreaterThan(first.y + first.height - 2);
    await cellOf(me, "2031-03-06").click({ position: { x: 6, y: 6 } });
    await expect(me.locator("#cDay .citem", { hasText: "Intervals" })).toHaveCount(1);
    await expect(me.locator("#cDay .citem", { hasText: "Long" })).toHaveCount(1);
    // the 4th has the one workout only
    await cellOf(me, "2031-03-04").click({ position: { x: 6, y: 6 } });
    await expect(me.locator("#cDay .citem", { hasText: "Intervals" })).toHaveCount(1);
    await expect(me.locator("#cDay .citem", { hasText: "Long" })).toHaveCount(0);
  });

  test("a day inside a plan's week with no workout lists the plan under 'In plan' and no workout", async ({ me, profile }) => {
    const name = `${profile.name}-quiet`;
    await addPlan(profile.api, name, { weekStart: "2031-03-03", weekEnd: "2031-03-09", workouts: [{ workoutName: "Only later", workoutType: "running", scheduledDate: "2031-03-06" }] });
    await openCalendar(me);
    await legendRow(me, name).click();
    await cellOf(me, "2031-03-03").click({ position: { x: 6, y: 6 } });
    await expect(me.locator("#cDay .clabel", { hasText: /^In plan$/ })).toHaveCount(1);
    await expect(me.locator("#cDay")).toContainText(name);
    await expect(me.locator("#cDay .clabel", { hasText: /^Workouts?$/ })).toHaveCount(0);
  });

  test("a scheduled date that is not a real YYYY-MM-DD day puts nothing on the calendar", async ({ me, profile }) => {
    const name = `${profile.name}-bogus`;
    await addPlan(profile.api, name, { weekStart: "2031-02-03", weekEnd: "2031-02-09", workouts: [{ workoutName: "Bogus date run", workoutType: "running", scheduledDate: "2031-02-30" }] });
    await openCalendar(me);
    await legendRow(me, name).click();
    await me.locator("#cModes button[data-mode=workouts]").click();
    await expect(me.locator("#cgrid .cbar.wk", { hasText: "Bogus date run" })).toHaveCount(0);
    await expect(me.locator("#cLegend .citem", { hasText: "Running" })).toHaveCount(0);
  });

  test("a month with plans elsewhere says so and offers the nearest month that has one", async ({ me, profile }) => {
    await addPlan(profile.api, `${profile.name}-far-plan`, { weekStart: "2031-03-03", weekEnd: "2031-03-09", workouts: [{ workoutName: "Far", workoutType: "running", scheduledDate: "2031-03-04" }] });
    await openCalendar(me);
    const far = monthOffset(today(), -4);
    await goToMonthOf(me, far);
    await expect(me.locator("#cNote")).toContainText(`Nothing planned in ${monthTitle(far)}.`);
    const next = me.locator("#cNote button").last();
    await expect(next).toHaveText(/→$/);
    const label = (await next.textContent())!.replace(/\s*→$/, "");
    await next.click();
    await expect(me.locator("#cTitle")).toHaveText(label);
  });

  test("plans are kept when you leave the calendar for a plan and come back on the same month", async ({ me, profile }) => {
    const name = `${profile.name}-back`;
    await addPlan(profile.api, name, { weekStart: "2031-04-07", weekEnd: "2031-04-13", workouts: [{ workoutName: "Back run", workoutType: "running", scheduledDate: "2031-04-08" }] });
    await openCalendar(me);
    await legendRow(me, name).click();
    await expect(me.locator("#cTitle")).toHaveText(monthTitle("2031-04-01"));
    await me.getByRole("button", { name, exact: true }).first().click();
    await expect(me.locator("body")).toHaveAttribute("data-view", "plans");
    await me.locator("#vCalendar").click();
    await expect(me.locator("body")).toHaveAttribute("data-view", "calendar");
    await expect(me.locator("#cTitle")).toHaveText(monthTitle("2031-04-01"));
  });

  test("the refresh button shows a plan added through the API since the page was opened", async ({ me, profile }) => {
    await openCalendar(me);
    const name = `${profile.name}-added`;
    await expect(me.locator("#cLegend")).not.toContainText(name);
    await addPlan(profile.api, name, { weekStart: "2031-06-02", weekEnd: "2031-06-08", workouts: [{ workoutName: "Added run", workoutType: "running", scheduledDate: "2031-06-03" }] });
    // a reload that the server answers late or drops under load is asked for again, as a person presses the button again
    await expect(async () => {
      await me.locator("#cRefresh").click();
      await expect(me.locator("#cLegend")).toContainText(name, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await legendRow(me, name).click();
    await expect(me.locator("#cTitle")).toHaveText(monthTitle("2031-06-01"));
    await expect(me.getByRole("button", { name, exact: true }).first()).toBeVisible();
  });

  test("an archived plan leaves the calendar after a refresh, and comes back when unarchived", async ({ me, profile }) => {
    const name = `${profile.name}-shelved`;
    const path = await addPlan(profile.api, name, { weekStart: "2031-07-07", weekEnd: "2031-07-13", workouts: [{ workoutName: "Shelved run", workoutType: "running", scheduledDate: "2031-07-08" }] });
    await openCalendar(me);
    await expect(me.locator("#cLegend")).toContainText(name);
    const archived = await profile.api.post("/api/plans/archive", { data: { path } });
    expect(archived.status()).toBe(200);
    await expect(async () => {
      await me.locator("#cRefresh").click();
      await expect(me.locator("#cLegend")).not.toContainText(name, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await goToMonthOf(me, "2031-07-01");
    await expect(me.locator("#cgrid").getByRole("button", { name, exact: true })).toHaveCount(0);
    const back = await profile.api.post("/api/plans/unarchive", { data: { path } });
    expect(back.status()).toBe(200);
    await expect(async () => {
      await me.locator("#cRefresh").click();
      await expect(me.locator("#cLegend")).toContainText(name, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  });

  test("a profile does not see the plans of another profile, but sees the shared one", async ({ page, profile }) => {
    await addPlan(profile.api, `${profile.name}-own`, { weekStart: "2031-08-04", weekEnd: "2031-08-10", workouts: [{ workoutName: "Own run", workoutType: "running", scheduledDate: "2031-08-05" }] });
    await loginAs(page, "bob", PASSWORD);
    await openCalendar(page);
    await expect(page.locator("#cLegend")).toContainText(SHARED);
    await expect(page.locator("#cLegend")).not.toContainText(RUN_BLOCK);
    await expect(page.locator("#cLegend")).not.toContainText(SOMEDAY);
    await expect(page.locator("#cLegend")).not.toContainText(`${profile.name}-own`);
  });
});

// ── empty states (the plans come from the API, which a test may answer itself) ──

test.describe("empty states", () => {
  test("with no plans at all, the Plans mode says so and the legend has nothing", async ({ page }) => {
    await page.route("**/api/calendar", (route) => route.fulfill({ json: NO_PLANS }));
    await loginAs(page, "bob", PASSWORD);
    await openCalendar(page);
    await expect(page.locator("#cNote")).toHaveText("No plan has dates yet. A plan's weekStart / weekEnd, or a workout's scheduledDate (YYYY-MM-DD), puts it on the calendar.");
    await expect(page.locator("#cLegend")).toHaveText("No plans.");
    await expect(page.locator("#cDay")).toHaveText("Nothing on this day.");
  });

  test("with no plans at all, the Workouts mode says no workout has a date yet", async ({ page }) => {
    await page.route("**/api/calendar", (route) => route.fulfill({ json: NO_PLANS }));
    await loginAs(page, "bob", PASSWORD);
    await openCalendar(page);
    await page.locator("#cModes button[data-mode=workouts]").click();
    await expect(page.locator("#cNote")).toHaveText("No workout has a scheduledDate yet (YYYY-MM-DD).");
    await expect(page.locator("#cLegend")).toHaveText("No scheduled workouts.");
  });

  test("the grid still draws the month when there is nothing to show in it", async ({ page }) => {
    await page.route("**/api/calendar", (route) => route.fulfill({ json: NO_PLANS }));
    await loginAs(page, "bob", PASSWORD);
    await openCalendar(page);
    await expect(page.locator("#cgrid .cday:not(.out)")).toHaveCount(monthShape(today()).days);
    await expect(page.locator("#cgrid .cbar")).toHaveCount(0);
  });
});
