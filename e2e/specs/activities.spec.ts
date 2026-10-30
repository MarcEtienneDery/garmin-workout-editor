/**
 * The Activities view as alice sees it (the seeded profile with 27 stored activities and no Garmin login): the list by week,
 * the calendar with the planned workouts, and the lifetime stats. The server's own answers are the oracle for the numbers.
 * Rows that open a page are covered by activity-detail.spec.ts.
 */
import type { Page } from "@playwright/test";
import { test, expect, openView, loginAs, ADMIN_TOKEN, PASSWORD, daysAgo, daysAhead, today, mondayOf } from "../support/fixtures";

const DAY = 86_400_000;

interface Stored {
  id: string;
  date: string;
  time: string;
  type: string;
  name: string;
  km: number | null;
  seconds: number | null;
  paceSec: number | null;
  avgHr: number | null;
  maxHr: number | null;
  effect: string | null;
  aerobic: number | null;
  elevation: number | null;
  calories: number | null;
  sets: number | null;
  reps: number | null;
  workoutId: string | null;
  detailed: boolean;
}

/** What the server holds for alice: the rows the list is drawn from, and its sync counts. */
async function storedFor(page: Page) {
  const res = await page.context().request.get("/api/activities?profile=alice");
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { activities: Stored[]; sync: { activities: number; withDetails: number; withCharts: number } };
}

/** The server's lifetime numbers for alice. */
async function statsFor(page: Page) {
  const res = await page.context().request.get("/api/activities/stats?profile=alice");
  expect(res.ok()).toBeTruthy();
  return (await res.json()).stats;
}

/** Let the page's list request through, then change the rows it was given (an extra activity, one taken away). */
async function editList(page: Page, edit: (rows: Stored[]) => Stored[]) {
  await page.route(/\/api\/activities\?/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, activities: edit(body.activities) } });
  });
}

/** Let the page's calendar request through, then change the plans it was given. */
async function editPlans(page: Page, edit: (plans: any[]) => any[]) {
  await page.route(/\/api\/calendar/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, plans: edit(body.plans) } });
  });
}

const newestFirst = (a: Stored, b: Stored) => (a.date === b.date ? b.time.localeCompare(a.time) : b.date.localeCompare(a.date));
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", ...opts }).format(new Date(`${iso}T00:00:00Z`));
const monthAndDay = (iso: string) => fmt(iso, { month: "short", day: "numeric" });
const weekdayAndDay = (iso: string) => fmt(iso, { weekday: "short", month: "short", day: "numeric" });
const longDate = (iso: string) => fmt(iso, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const monthTitle = (iso: string) => fmt(iso, { month: "long", year: "numeric" });
const durationText = (s: number) => {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const exact = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const label = (type: string) => type.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
/** The first day of the month after (or before) the month of an ISO day. */
const shiftMonth = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/** The weeks of some rows, newest first, the way the list groups them: each with its totals. */
function weekTotals(rows: Stored[]) {
  const by = new Map<string, Stored[]>();
  for (const r of [...rows].sort(newestFirst)) {
    const week = mondayOf(r.date);
    by.set(week, [...(by.get(week) ?? []), r]);
  }
  return [...by].map(([week, list]) => ({
    week,
    list,
    sessions: list.length,
    km: Math.round(list.reduce((a, r) => a + (r.km ?? 0), 0) * 10) / 10,
    seconds: list.reduce((a, r) => a + (r.seconds ?? 0), 0),
  }));
}

/** The number of week rows a month's grid has, Monday first, as the calendar draws it. */
function gridWeeks(month: string) {
  const first = `${month}-01`;
  const last = shiftMonth(first, 1);
  const lastDay = new Date(Date.parse(last + "T00:00:00Z") - DAY).toISOString().slice(0, 10);
  const span = Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${mondayOf(first)}T00:00:00Z`);
  return Math.ceil((span / DAY + 1) / 7);
}

/** A day of the grid by its date. The chips of its activities lie over the middle of the cell, so the day is pressed at its number. */
const cell = (page: Page, iso: string) => page.getByRole("button", { name: exact(longDate(iso)) });
const pressDay = (page: Page, iso: string) => cell(page, iso).click({ position: { x: 6, y: 6 } });
const row = (page: Page, name: string) => page.locator("#alist .arow").filter({ has: page.locator(".nm", { hasText: exact(name) }) });
/** A record of the Stats view, by its label (exactly: "1 km" is not "10 km"). */
const record = (page: Page, label: string) => page.locator(".srec").filter({ has: page.locator(".srl", { hasText: exact(label) }) });
const tile = (page: Page, block: string, name: string) =>
  page.locator("#astats h3", { hasText: exact(block) }).locator("xpath=following-sibling::*[1]").locator(".stile", { has: page.locator("span", { hasText: exact(name) }) }).locator("b");

test.describe("Activities list", () => {
  test("the list opens on the 12-week range with every stored activity", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    await openView(alice, "activities");
    await expect(alice.locator("#aModes button[data-mode=list]")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#aRange")).toHaveValue("12w");
    await expect(alice.locator("#alist .arow")).toHaveCount(activities.length);
    await expect(alice.locator("#acal")).toBeHidden();
    await expect(alice.locator("#astats")).toBeHidden();
  });

  test("the weeks run newest first, each under its own header", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    const weeks = weekTotals(activities);
    await openView(alice, "activities");
    const headers = alice.locator("#alist .awk");
    await expect(headers).toHaveCount(weeks.length);
    await expect(headers.locator("b")).toHaveText(weeks.map((w) => `Week of ${monthAndDay(w.week)}`));
  });

  test("each week header gives its sessions, distance and time", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    const weeks = weekTotals(activities);
    await openView(alice, "activities");
    for (const [i, w] of weeks.entries()) {
      const header = alice.locator("#alist .awk").nth(i);
      await expect(header.locator("span")).toHaveText([
        plural(w.sessions, "session"),
        ...(w.km ? [`${w.km} km`] : []),
        ...(w.seconds ? [durationText(w.seconds)] : []),
      ]);
    }
  });

  test("the activities of each week run newest first, a later start on the same day coming first", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    await openView(alice, "activities");
    await expect(alice.locator("#alist .arow")).toHaveCount(activities.length);
    const names = await alice.locator("#alist .arow .nm").allInnerTexts();
    expect(names).toEqual([...activities].sort(newestFirst).map((a) => a.name));
    // the gym session at 18:00 is listed above the morning run of the same day
    await expect(alice.locator("#alist .arow .nm").filter({ hasText: /^(Gym session 9019|Morning run 9001)$/ })).toHaveText(["Gym session 9019", "Morning run 9001"]);
  });

  test("a run's row gives its day and start time, its distance, its time and its pace", async ({ alice }) => {
    await openView(alice, "activities");
    const r = row(alice, "Morning run 9000");
    await expect(r.locator("small").first()).toHaveText(`${weekdayAndDay(daysAgo(1))} · 07:00`);
    await expect(r.locator(".met")).toHaveText("7 km · 40 min · 5:03 /km");
  });

  test("a run's row shows its training effect under the numbers", async ({ alice }) => {
    await openView(alice, "activities");
    const easy = row(alice, "Easy run");
    await expect(easy.locator(".met")).toContainText("8 km · 40 min · 5:03 /km");
    await expect(easy.locator(".met small")).toHaveText("Aerobic Base");
  });

  test("a ride's row shows its heart rate in place of a pace", async ({ alice }) => {
    await openView(alice, "activities");
    await expect(row(alice, "Ride 9024").locator(".met")).toHaveText("25 km · 40 min · 148 bpm");
  });

  test("a gym session's row shows its time and heart rate, with no distance or pace", async ({ alice }) => {
    await openView(alice, "activities");
    const gym = row(alice, "Gym session 9019");
    await expect(gym.locator(".met")).toHaveText("50 min · 148 bpm");
    await expect(gym.locator(".met")).not.toContainText("km");
  });

  test("the 4-week range keeps only the activities of the last 28 days", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    const recent = activities.filter((a) => a.date >= daysAgo(28));
    expect(recent.length).toBeLessThan(activities.length); // the seed reaches back further than four weeks
    await openView(alice, "activities");
    await alice.locator("#aRange").selectOption("4w");
    await expect(alice.locator("#alist .arow")).toHaveCount(recent.length);
    await expect(alice.locator("#alist .arow .nm")).toHaveText(recent.sort(newestFirst).map((a) => a.name));
    await expect(alice.locator("#alist .awk")).toHaveCount(weekTotals(recent).length);
  });

  test("1 year and all keep every stored activity", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    await openView(alice, "activities");
    for (const range of ["1y", "all", "12w"]) {
      await alice.locator("#aRange").selectOption(range);
      await expect(alice.locator("#alist .arow")).toHaveCount(activities.length);
    }
  });

  test("the range stays as it was chosen when the calendar is opened and the list again", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    const recent = activities.filter((a) => a.date >= daysAgo(28));
    await openView(alice, "activities");
    await alice.locator("#aRange").selectOption("4w");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await expect(alice.locator("#aRange")).toBeHidden();
    await alice.locator("#aModes button[data-mode=list]").click();
    await expect(alice.locator("#aRange")).toHaveValue("4w");
    await expect(alice.locator("#alist .arow")).toHaveCount(recent.length);
  });

  test("a search by name keeps the matching activities, whatever the case, and the week's totals follow", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aSearch").fill("EASY");
    await expect(alice.locator("#alist .arow .nm")).toHaveText(["Easy run"]);
    await expect(alice.locator("#alist .awk")).toHaveCount(1);
    await expect(alice.locator("#alist .awk span")).toHaveText(["1 session", "8 km", "40 min"]);
  });

  test("clearing the search brings every activity back", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    await openView(alice, "activities");
    await alice.locator("#aSearch").fill("ride");
    await expect(alice.locator("#alist .arow")).toHaveCount(2);
    await alice.locator("#aSearch").fill("");
    await expect(alice.locator("#alist .arow")).toHaveCount(activities.length);
    await expect(alice.locator("#alist")).not.toContainText("No activity matches.");
  });

  test("a search that matches no name says so, and the note still counts what is stored", async ({ alice }) => {
    const { sync } = await storedFor(alice);
    await openView(alice, "activities");
    await alice.locator("#aSearch").fill("zzz no such run");
    await expect(alice.locator("#alist .arow")).toHaveCount(0);
    await expect(alice.locator("#alist")).toHaveText("No activity matches.");
    await expect(alice.locator("#aNote")).toHaveText(`${sync.activities} stored · ${sync.withDetails} with details · ${sync.withCharts} with graphs`);
  });

  test("the search looks at the name only, not the sport", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aSearch").fill("Strength");
    await expect(alice.locator("#alist")).toHaveText("No activity matches.");
  });

  test("the sport chips count the stored activities of each sport, the most first", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    const counts = new Map<string, number>();
    for (const a of activities) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
    const expected = [...counts].sort((a, b) => b[1] - a[1]).map(([type, n]) => `${label(type)} ${n}`);
    await openView(alice, "activities");
    await expect(alice.locator("#aTypes .tchip")).toHaveText(expected);
    await expect(alice.locator("#aTypes .tchip").first()).toHaveAttribute("aria-pressed", "false");
  });

  test("a sport chip keeps only that sport, and pressing it again lifts the filter", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    const cycling = activities.filter((a) => a.type === "cycling").sort(newestFirst);
    await openView(alice, "activities");
    const chip = alice.locator("#aTypes .tchip", { hasText: "Cycling" });
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#alist .arow .nm")).toHaveText(cycling.map((a) => a.name));
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await expect(alice.locator("#alist .arow")).toHaveCount(activities.length);
  });

  test("several sport chips together keep the sports of any of them", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    const wanted = activities.filter((a) => a.type !== "strength_training");
    await openView(alice, "activities");
    await alice.locator("#aTypes .tchip", { hasText: "Running" }).click();
    await alice.locator("#aTypes .tchip", { hasText: "Cycling" }).click();
    await expect(alice.locator("#alist .arow")).toHaveCount(wanted.length);
  });

  test("a sport chip and the search filter together", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aTypes .tchip", { hasText: "Running" }).click();
    await alice.locator("#aSearch").fill("easy");
    await expect(alice.locator("#alist .arow .nm")).toHaveText(["Easy run"]);
    await alice.locator("#aTypes .tchip", { hasText: "Cycling" }).click();
    await alice.locator("#aTypes .tchip", { hasText: "Running" }).click();
    await expect(alice.locator("#alist")).toHaveText("No activity matches.");
  });

  test("the week totals follow a sport chip: strength shows its sessions and time, no distance", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    const week = mondayOf(daysAgo(3));
    const strength = activities.filter((a) => a.type === "strength_training" && mondayOf(a.date) === week);
    await openView(alice, "activities");
    await alice.locator("#aTypes .tchip", { hasText: "Strength" }).click();
    const header = alice.locator("#alist .awk", { has: alice.locator("b", { hasText: exact(`Week of ${monthAndDay(week)}`) }) });
    await expect(header.locator("span")).toHaveText([plural(strength.length, "session"), durationText(strength.reduce((a, r) => a + (r.seconds ?? 0), 0))]);
  });

  test("a profile without a Garmin login gets no Sync button and no Fetch prompt", async ({ alice }) => {
    const { sync } = await storedFor(alice);
    await openView(alice, "activities");
    await expect(alice.locator("#aNote")).toHaveText(`${sync.activities} stored · ${sync.withDetails} with details · ${sync.withCharts} with graphs`);
    await expect(alice.locator("#aSync")).toBeHidden();
    await expect(alice.locator("#aNote button")).toHaveCount(0);
    await expect(alice.getByRole("button", { name: /Fetch/ })).toHaveCount(0);
  });

  test("a profile with no Garmin login and nothing stored is told why there is nothing", async ({ alice }) => {
    await editList(alice, () => []);
    await openView(alice, "activities");
    await expect(alice.locator("#aNote")).toHaveText("This profile has no Garmin login: add one in Settings.");
    await expect(alice.locator("#alist .arow")).toHaveCount(0);
    await expect(alice.locator("#aSync")).toBeHidden();
  });

  test("a failing list request shows its message in the note, in the error colour", async ({ alice }) => {
    await alice.route(/\/api\/activities\?/, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The list is down." }) }));
    await openView(alice, "activities");
    await expect(alice.locator("#aNote")).toHaveText("The list is down.");
    await expect(alice.locator("#aNote")).toHaveClass(/err/);
    await expect(alice.locator("#alist .arow")).toHaveCount(0);
  });

  test("a fresh profile has no Activities button, and the address goes to Today", async ({ me }) => {
    await openView(me, "today");
    await expect(me.locator("#vActivities")).toBeHidden();
    await me.goto("/#activities");
    await expect(me.locator("body")).toHaveAttribute("data-view", "today");
  });

  test("bob, who has no activities, sees none of alice's", async ({ page }) => {
    await loginAs(page, "bob", PASSWORD);
    const res = await page.context().request.get("/api/activities");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.profile).toBe("bob");
    expect(body.activities).toEqual([]);
    await openView(page, "today");
    await expect(page.locator("#vActivities")).toBeHidden();
  });

  test("the admin reads a profile's activities by choosing it in the profile picker", async ({ page }) => {
    await loginAs(page, "admin", ADMIN_TOKEN);
    const { activities } = await storedFor(page);
    await openView(page, "activities");
    await expect(page.locator("#aProfile")).toBeVisible();
    await page.locator("#aProfile").selectOption("alice");
    await expect(page.locator("#alist .arow")).toHaveCount(activities.length);
  });

  test("reloading the page keeps the Activities view and its list", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    await openView(alice, "activities");
    await expect(alice.locator("#alist .arow")).toHaveCount(activities.length);
    await alice.reload();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "activities");
    await expect(alice.locator("#alist .arow")).toHaveCount(activities.length);
  });
});

test.describe("Activities calendar", () => {
  test("the month is a Monday-first grid, with the week totals on the right", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await expect(alice.locator("#aTitle")).toHaveText(monthTitle(today()));
    await expect(alice.locator("#adow span")).toHaveText(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Week"]);
    const month = today().slice(0, 7);
    const weeks = gridWeeks(month);
    await expect(alice.locator("#agrid .cweek")).toHaveCount(weeks);
    const expected = Array.from({ length: weeks }, (_, i) => {
      const monday = new Date(Date.parse(`${mondayOf(`${month}-01`)}T00:00:00Z`) + i * 7 * DAY).toISOString().slice(0, 10);
      const list = activities.filter((a) => a.date >= monday && a.date < new Date(Date.parse(monday + "T00:00:00Z") + 7 * DAY).toISOString().slice(0, 10));
      return list.length ? `${plural(list.length, "session")}` : "";
    });
    for (const [i, text] of expected.entries()) {
      if (text) await expect(alice.locator("#agrid .cweek").nth(i).locator(".cwtot b")).toHaveText(text);
      else await expect(alice.locator("#agrid .cweek").nth(i).locator(".cwtot")).toBeEmpty();
    }
  });

  test("each week's total gives its distance and time as well as its sessions", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    const week = mondayOf(daysAgo(3));
    const list = activities.filter((a) => mondayOf(a.date) === week);
    const km = Math.round(list.reduce((a, r) => a + (r.km ?? 0), 0) * 10) / 10;
    const seconds = list.reduce((a, r) => a + (r.seconds ?? 0), 0);
    // the grid's first row starts on the Monday of the 1st of the month
    const rowIndex = Math.round((Date.parse(`${week}T00:00:00Z`) - Date.parse(`${mondayOf(`${today().slice(0, 7)}-01`)}T00:00:00Z`)) / (7 * DAY));
    await expect(alice.locator("#agrid .cweek").nth(rowIndex).locator(".cwtot")).toContainText(`${plural(list.length, "session")}${km} km · ${durationText(seconds)}`);
  });

  test("every activity is a chip on its day, and a day with two shows both in time order", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await expect(cell(alice, daysAgo(3))).toBeVisible();
    await expect(alice.locator(`#agrid .cbar[title*="${daysAgo(3)}"]`)).toHaveText(["Morning run 9001", "Gym session 9019"]);
    await expect(alice.locator(`#agrid .cbar[title*="${daysAgo(3)}"]`).nth(1)).toHaveAttribute("title", /Strength Training · \S+ 18:00/);
  });

  test("the days outside the month are dimmed, and today is marked", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await expect(alice.locator("#agrid .cday.today")).toHaveAttribute("aria-label", longDate(today()));
    expect(await alice.locator("#agrid .cday.out").count()).toBeGreaterThan(0);
  });

  test("previous, next and today move through the months, and today selects today", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await alice.locator("#aPrev").click();
    await expect(alice.locator("#aTitle")).toHaveText(monthTitle(shiftMonth(today(), -1)));
    await alice.locator("#aNext").click();
    await alice.locator("#aNext").click();
    await expect(alice.locator("#aTitle")).toHaveText(monthTitle(shiftMonth(today(), 1)));
    await alice.locator("#aToday").click();
    await expect(alice.locator("#aTitle")).toHaveText(monthTitle(today()));
    await expect(alice.locator("#aDay h3")).toHaveText(longDate(today()));
    await expect(alice.locator("#aDay .arow .nm")).toHaveText(["Today's shakeout"]);
  });

  test("a previous month's activities are in its grid, though the list's range is 4 weeks", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    const older = activities.filter((a) => a.date < daysAgo(28)).sort(newestFirst)[0];
    await openView(alice, "activities");
    await alice.locator("#aRange").selectOption("4w");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    // the calendar shows the month of that run, and the run is on its grid
    for (let i = 0; i < 12 && !(await alice.locator("#aTitle").textContent())?.includes(monthTitle(older.date)); i++) {
      await alice.locator("#aPrev").click();
    }
    await expect(alice.locator(`#agrid .cbar[title*="${older.date}"]`, { hasText: older.name })).toHaveCount(1);
  });

  test("clicking a day lists its activities below the grid, in time order", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await pressDay(alice, daysAgo(3));
    await expect(alice.locator("#aDay h3")).toHaveText(longDate(daysAgo(3)));
    await expect(alice.locator("#aDay .arow .nm")).toHaveText(["Morning run 9001", "Gym session 9019"]);
  });

  test("a day with nothing on it says so", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await pressDay(alice, daysAgo(4));
    await expect(alice.locator("#aDay h3")).toHaveText(longDate(daysAgo(4)));
    await expect(alice.locator("#aDay")).toContainText("Nothing on this day.");
  });

  test("clicking an activity's chip opens its page beside the grid and marks the chip", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await alice.locator("#agrid .cbar", { hasText: "Gym session 9019" }).click();
    await expect(alice.locator("#aDetailTitle")).toHaveText("Gym session 9019");
    await expect(alice.locator("#agrid .cbar.sel")).toHaveText("Gym session 9019");
  });

  test("the calendar follows the sport chips and the search", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await alice.locator("#aTypes .tchip", { hasText: "Cycling" }).click();
    await expect(alice.locator("#agrid .cbar.act")).toHaveCount(2);
    expect((await alice.locator("#agrid .cbar.act").allInnerTexts()).sort()).toEqual(["Ride 9024", "Ride 9025"]);
    await alice.locator("#aTypes .tchip", { hasText: "Cycling" }).click();
    await alice.locator("#aSearch").fill("gym");
    await expect(alice.locator("#agrid .cbar.act").first()).toBeVisible();
    await expect(alice.locator("#agrid .cbar.act").filter({ hasNotText: "Gym session" })).toHaveCount(0);
  });

  test("a day with more activities than fit shows a count, and the count opens the day", async ({ alice }) => {
    const extra = Array.from({ length: 4 }, (_, i) => ({
      id: `extra-${i}`, date: daysAgo(3), time: `${String(8 + i).padStart(2, "0")}:00`, type: "running", name: `Extra run ${i + 1}`, km: 5, seconds: 1500, paceSec: 300,
      avgHr: 140, maxHr: 160, effect: null, aerobic: null, elevation: null, calories: null, sets: null, reps: null, workoutId: null, detailed: false,
    }));
    await editList(alice, (rows) => [...rows, ...extra]);
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    // six activities that day: three chips and "+3 more"
    await expect(alice.locator(`#agrid .cbar.act[title*="${daysAgo(3)}"]`)).toHaveCount(3);
    await alice.locator("#agrid .cbar.more", { hasText: "+3 more" }).click();
    await expect(alice.locator("#aDay .arow")).toHaveCount(6);
  });

  test("Show planned is off at first, and pressing it adds the plan's workouts", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    const toggle = alice.locator("#aPlanned");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(alice.locator("#agrid .cbar.plan")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#agrid .cbar.plan", { hasText: "Full body strength" }).first()).toBeVisible();
  });

  test("a done workout ticks the activity that answers it, and one activity answers one session", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await alice.locator("#aPlanned").click();
    // the Easy run was done: its activity is ticked
    await expect(alice.locator("#agrid .cbar.act.ok", { hasText: "Easy run" })).toHaveCount(1);
    // today's Tempo intervals is answered by today's run (the same sport, on the same day): nothing is left open for it
    await expect(alice.locator("#agrid .cbar.act.ok", { hasText: "Today's shakeout" })).toHaveCount(1);
    await expect(alice.locator("#agrid .cbar.plan", { hasText: "Tempo intervals" })).toHaveCount(0);
  });

  test("the day list says which planned workouts were done, and which are still to come", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await alice.locator("#aPlanned").click();
    await pressDay(alice, daysAgo(2));
    await expect(alice.locator("#aDay .aplan.done b")).toHaveText("✓ Easy run");
    await expect(alice.locator("#aDay .aplan.done span")).toHaveText("planned, done");
    await pressDay(alice, today());
    await expect(alice.locator("#aDay .aplan.done b")).toHaveText("✓ Tempo intervals");
    await pressDay(alice, daysAhead(1));
    await expect(alice.locator("#aDay .aplan b")).toHaveText("Full body strength");
    await expect(alice.locator("#aDay .aplan span")).toHaveText("planned");
  });

  test("an upcoming workout is dashed and grey; the next month's workouts show in that month", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await alice.locator("#aPlanned").click();
    const upcoming = alice.locator("#agrid .cbar.plan.upcoming", { hasText: "Full body strength" }).first();
    await expect(upcoming).toHaveAttribute("title", /Planned \(upcoming\)/);
    // the Long run is three days ahead: the next month's grid, unless it falls in this one
    if (daysAhead(3).slice(0, 7) !== today().slice(0, 7)) await alice.locator("#aNext").click();
    await expect(alice.locator("#agrid .cbar.plan", { hasText: "Long run" })).toHaveCount(1);
    await expect(alice.locator("#agrid .cbar.plan.upcoming", { hasText: "Long run" })).toHaveCount(1);
  });

  test("a planned workout on a past day with nothing done is red, and the day says so", async ({ alice }) => {
    const missed = daysAgo(8);
    await editPlans(alice, (plans) => [
      ...plans,
      { path: "workout-plans/e2e-missed.json", owner: "alice", weekStart: mondayOf(missed), weekEnd: mondayOf(missed), start: missed, end: missed, workouts: [{ index: 0, workoutName: "Missed intervals", workoutType: "running", workoutId: null, dates: [missed] }] },
    ]);
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await alice.locator("#aPlanned").click();
    await expect(alice.locator("#agrid .cbar.plan.missed", { hasText: "Missed intervals" })).toHaveAttribute("title", /Planned \(not done\)/);
    await pressDay(alice, missed);
    await expect(alice.locator("#aDay .aplan.missed b")).toHaveText("Missed intervals");
    await expect(alice.locator("#aDay .aplan.missed span")).toHaveText("planned, not done");
  });

  test("a workout due today that nothing has answered yet is amber", async ({ alice }) => {
    await editList(alice, (rows) => rows.filter((r) => r.name !== "Today's shakeout"));
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await alice.locator("#aPlanned").click();
    await expect(alice.locator("#agrid .cbar.plan.today", { hasText: "Tempo intervals" })).toHaveCount(1);
    await pressDay(alice, today());
    await expect(alice.locator("#aDay .aplan.today b")).toHaveText("Tempo intervals");
    await expect(alice.locator("#aDay .aplan.today span")).toHaveText("planned for today");
  });

  test("turning Show planned off hides the plan's workouts again", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await alice.locator("#aPlanned").click();
    await expect(alice.locator("#agrid .cbar.plan").first()).toBeVisible();
    await alice.locator("#aPlanned").click();
    await expect(alice.locator("#aPlanned")).toHaveAttribute("aria-pressed", "false");
    await expect(alice.locator("#agrid .cbar.plan")).toHaveCount(0);
  });

  test("when the plans cannot be read the calendar still shows the activities", async ({ alice }) => {
    const errors: string[] = [];
    alice.on("pageerror", (e) => errors.push(e.message));
    await alice.route(/\/api\/calendar/, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "no plans" }) }));
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await alice.locator("#aPlanned").click();
    await expect(alice.locator("#aPlanned")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#agrid .cbar.plan")).toHaveCount(0);
    await expect(alice.locator("#agrid .cbar.act").first()).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("Activities stats", () => {
  test("Stats gives the lifetime totals, as the server counts them", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    const stats = await statsFor(alice);
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    await expect(alice.locator("#astats h3").first()).toHaveText("Overall");
    await expect(tile(alice, "Overall", "activities")).toHaveText(String(activities.length));
    await expect(tile(alice, "Overall", "time")).toHaveText(durationText(stats.seconds));
    await expect(tile(alice, "Overall", "active days")).toHaveText(String(stats.activeDays));
    await expect(tile(alice, "Overall", "since")).toHaveText(stats.since);
    await expect(alice.locator("#astats .stile", { hasText: "since" })).toHaveAttribute("title", `latest ${stats.until}`);
    await expect(alice.locator("#astats .anote").first()).toHaveText(stats.byType.map((t: any) => `${label(t.type)} ${t.count}`).join(" · "));
  });

  test("the running block gives runs, distance, time, climb and average pace", async ({ alice }) => {
    const { running } = (await statsFor(alice));
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    await expect(tile(alice, "Running", "runs")).toHaveText(String(running.runs));
    await expect(tile(alice, "Running", "distance")).toHaveText(`${(running.meters / 1000).toLocaleString("en-CA", { maximumFractionDigits: 1 })} km`);
    await expect(tile(alice, "Running", "time")).toHaveText(durationText(running.seconds));
    await expect(tile(alice, "Running", "climbed")).toHaveText(`${running.gain.toLocaleString("en-CA")} m`);
    await expect(tile(alice, "Running", "average pace")).toHaveText(`${Math.floor(running.avgPaceSec / 60)}:${String(running.avgPaceSec % 60).padStart(2, "0")} /km`);
    await expect(tile(alice, "Running", "VO2max")).toHaveText("–");
  });

  test("the records name their run, its date and its figures", async ({ alice }) => {
    const { running } = await statsFor(alice);
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    const longest = alice.locator(".srec", { hasText: "Longest run" });
    await expect(longest.locator(".srv")).toHaveText(`${running.longest.meters / 1000} km`);
    const m = Math.floor(running.longest.seconds / 60), s = running.longest.seconds % 60;
    await expect(longest.locator(".srd")).toHaveText(`${m}:${String(s).padStart(2, "0")} · ${running.longest.date} · ${running.longest.name}`);
    await expect(alice.locator(".srec", { hasText: "Biggest climb" }).locator(".srv")).toHaveText(`${running.biggestClimb.gain} m`);
    await expect(alice.locator(".srec", { hasText: "Best pace" }).locator(".srv")).toHaveText(`${Math.floor(running.bestPace.paceSec / 60)}:${String(running.bestPace.paceSec % 60).padStart(2, "0")} /km`);
  });

  test("the biggest week and the biggest month give their runs and the start of the week or the month", async ({ alice }) => {
    const { running } = await statsFor(alice);
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    await expect(alice.locator(".srec", { hasText: "Biggest week" }).locator(".srd")).toHaveText(`${running.biggestWeek.runs} runs, the week of ${running.biggestWeek.start}`);
    await expect(alice.locator(".srec", { hasText: "Biggest month" }).locator(".srd")).toHaveText(`${running.biggestMonth.runs} runs, ${running.biggestMonth.month}`);
  });

  test("the strength block counts sessions, and the volume and exercises come from the sessions with their sets stored", async ({ alice }) => {
    const { strength } = await statsFor(alice);
    expect(strength.detailed).toBeGreaterThan(0); // the seed stores the sets of two gym sessions
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    await expect(tile(alice, "Strength", "sessions")).toHaveText(String(strength.sessions));
    await expect(tile(alice, "Strength", "time")).toHaveText(durationText(strength.seconds));
    await expect(tile(alice, "Strength", "volume lifted")).toHaveText(/^[\d,]+ lb$/);
    await expect(alice.locator("#astats .anote", { hasText: "The exercise figures cover" })).toHaveText(`The exercise figures cover ${strength.detailed} of ${strength.sessions} sessions; the others have no details stored yet.`);
    const rows = alice.locator("#astats h3", { hasText: "Exercises" }).locator("+ .aexs .aex");
    await expect(rows).toHaveCount(strength.exercises.length);
    for (const [i, e] of strength.exercises.entries()) {
      await expect(rows.nth(i).locator(".aexn")).toHaveText(e.name);
      await expect(rows.nth(i).locator(".aext")).toHaveText(`${e.sessions} sessions`);
      await expect(rows.nth(i).locator(".aexchip").first()).toHaveText(/^est\. 1RM [\d.]+ lb$/);
    }
  });

  test("the by-year table has a row for each year with its counts", async ({ alice }) => {
    const { years } = await statsFor(alice);
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    const rows = alice.locator("#astats table.atable tr");
    await expect(rows).toHaveCount(years.length + 1);
    const y = years[0];
    await expect(rows.nth(1).locator("td").first()).toHaveText(String(y.year));
    await expect(rows.nth(1).locator("td").nth(1)).toHaveText(String(y.activities));
    await expect(rows.nth(1).locator("td").nth(3)).toHaveText(String(y.runs));
  });

  test("Stats shows no NaN, undefined or null anywhere", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    await expect(alice.locator("#astats .stile").first()).toBeVisible();
    await expect(alice.locator("#astats")).not.toHaveText(/NaN|undefined|null|Infinity/);
  });

  test("clicking a record opens its activity beside the list", async ({ alice }) => {
    const { running } = await statsFor(alice);
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    await alice.locator(".srec", { hasText: "Longest run" }).click();
    await expect(alice.locator("#aModes button[data-mode=list]")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#aDetailTitle")).toHaveText(running.longest.name);
  });

  test("a record can be opened from the keyboard", async ({ alice }) => {
    const { running } = await statsFor(alice);
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    const record = alice.locator(".srec", { hasText: "Biggest climb" });
    await expect(record).toHaveAttribute("role", "button");
    await record.focus();
    await alice.keyboard.press("Enter");
    await expect(alice.locator("#aDetailTitle")).toHaveText(running.biggestClimb.name);
  });

  test("Stats has none of the list's controls", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    await expect(alice.locator("#aRange")).toBeHidden();
    await expect(alice.locator("#aSearch")).toBeHidden();
    await expect(alice.locator("#aTypesBar")).toBeHidden();
    await expect(alice.locator("#aCalBar")).toBeHidden();
  });

  test("the best efforts give the fastest 1 km and 5 km of the runs, with their pace, day and run", async ({ alice }) => {
    // alice's runs carry no split times, so the server's answer is given the shape it has when they do
    await alice.route(/\/api\/activities\/stats/, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.stats.running.efforts = [
        { id: "9014", date: "2026-10-01", name: "Morning run 9014", meters: 1000, seconds: 240 },
        { id: "9013", date: "2026-10-03", name: "Morning run 9013", meters: 5000, seconds: 1300 },
      ];
      await route.fulfill({ response, json: body });
    });
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    await expect(alice.locator("#astats h3", { hasText: exact("Best efforts") })).toBeVisible();
    const fast = record(alice, "1 km");
    await expect(fast.locator(".srv")).toHaveText("4:00");
    await expect(fast.locator(".srd")).toHaveText("4:00 /km · 2026-10-01 · Morning run 9014");
    await expect(record(alice, "5 km").locator(".srv")).toHaveText("21:40");
    await expect(record(alice, "5 km").locator(".srd")).toHaveText("4:20 /km · 2026-10-03 · Morning run 9013");
    await expect(alice.locator("#astats")).not.toHaveText(/NaN|undefined|null|Infinity/);
    // an effort opens the run it was timed in
    await fast.click();
    await expect(alice.locator("#aDetailTitle")).toHaveText("Morning run 9014");
  });

  test("the exercises give each lift's estimated one-rep max, its sets and its volume, with the set it came from", async ({ alice }) => {
    // the strength details of the seed are the gym sessions' summaries alone; the exercise figures are given the shape the server has when they are stored
    await alice.route(/\/api\/activities\/stats/, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.stats.strength = {
        ...body.stats.strength, detailed: 3, sets: 12, reps: 60, volume: 6000,
        exercises: [
          { name: "Barbell Back Squat", sessions: 3, sets: 12, reps: 60, volume: 6000, lastDate: "2026-10-20", best: { oneRm: 117, weight: 100, reps: 5, date: "2026-10-01" }, heaviest: { weight: 100, reps: 5 } },
        ],
      };
      await route.fulfill({ response, json: body });
    });
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    await expect(tile(alice, "Strength", "volume lifted")).toHaveText("6,000 lb");
    const lift = alice.locator("#astats .aex", { hasText: "Barbell Back Squat" });
    await expect(lift.locator(".aexn")).toHaveText("Barbell Back Squat");
    await expect(lift.locator(".aext")).toHaveText("3 sessions");
    await expect(lift.locator(".aexchip")).toHaveText(["est. 1RM 117 lb", "heaviest 100 lb × 5", "12 sets · 60 reps", "6,000 lb"]);
    await expect(lift.locator(".aexnote")).toHaveText("from 5 @ 100 lb on 2026-10-01 · last 2026-10-20");
    await expect(alice.locator("#astats .anote", { hasText: "est. 1RM" })).toContainText("Epley formula");
    await expect(alice.locator("#astats")).not.toHaveText(/NaN|undefined|null|Infinity/);
  });

  test("a failing stats request shows its message in Stats", async ({ alice }) => {
    await alice.route(/\/api\/activities\/stats/, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Stats are down." }) }));
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    await expect(alice.locator("#astats .msg.err")).toHaveText("Stats are down.");
  });
});

test.describe("Activities view in every mode", () => {
  test("no NaN, undefined or null shows in the list, the calendar or the stats", async ({ alice }) => {
    await openView(alice, "activities");
    await expect(alice.locator("#alist .arow").first()).toBeVisible();
    await expect(alice.locator("#aview")).not.toHaveText(/NaN|undefined|null/);
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await expect(alice.locator("#agrid .cweek").first()).toBeVisible();
    await expect(alice.locator("#aview")).not.toHaveText(/NaN|undefined|null/);
    await alice.locator("#aModes button[data-mode=stats]").click();
    await expect(alice.locator("#astats .stile").first()).toBeVisible();
    await expect(alice.locator("#aview")).not.toHaveText(/NaN|undefined|null/);
  });

  test("the list's rows and the calendar's chips are keyboard buttons", async ({ alice }) => {
    await openView(alice, "activities");
    const first = alice.locator("#alist .arow").first();
    await expect(first).toHaveAttribute("role", "button");
    await expect(first).toHaveAttribute("tabindex", "0");
    await alice.locator("#aModes button[data-mode=calendar]").click();
    await expect(alice.locator("#agrid .cday").first()).toHaveAttribute("role", "button");
    await expect(alice.locator("#agrid .cday").first()).toHaveAttribute("tabindex", "0");
  });
});
