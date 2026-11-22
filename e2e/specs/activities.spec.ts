import type { Page } from "@playwright/test";
import { test, expect, openView, loginAs, ADMIN_TOKEN, PASSWORD, daysAgo, daysAhead, today, mondayOf } from "../support/fixtures";


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

async function storedFor(page: Page) {
  const res = await page.context().request.get("/api/activities?profile=alice");
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { activities: Stored[]; sync: { activities: number; withDetails: number; withCharts: number } };
}

async function statsFor(page: Page) {
  const res = await page.context().request.get("/api/activities/stats?profile=alice");
  expect(res.ok()).toBeTruthy();
  return (await res.json()).stats;
}

async function editList(page: Page, edit: (rows: Stored[]) => Stored[]) {
  await page.route(/\/api\/activities\?/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, activities: edit(body.activities) } });
  });
}

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
const durationText = (s: number) => {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const exact = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const label = (type: string) => type.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

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

const row = (page: Page, name: string) => page.locator("#alist .arow").filter({ has: page.locator(".nm", { hasText: exact(name) }) });
const record = (page: Page, label: string) => page.locator(".srec").filter({ has: page.locator(".srl", { hasText: exact(label) }) });
const tile = (page: Page, block: string, name: string) =>
  page.locator("#astats .acard", { has: page.locator(".aeyebrow", { hasText: exact(block) }) }).locator(".stile", { has: page.locator("small", { hasText: exact(name) }) }).locator("b");

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
      await expect(header.locator("span")).toHaveText([plural(w.sessions, "session"), ...(w.km ? [`${w.km} km`] : []), ...(w.seconds ? [durationText(w.seconds)] : [])].join(" · "));
    }
  });

  test("the activities of each week run newest first, a later start on the same day coming first", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    await openView(alice, "activities");
    await expect(alice.locator("#alist .arow")).toHaveCount(activities.length);
    const names = await alice.locator("#alist .arow .nm").allInnerTexts();
    expect(names).toEqual([...activities].sort(newestFirst).map((a) => a.name));
    await expect(alice.locator("#alist .arow .nm").filter({ hasText: /^(Gym session 9019|Morning run 9001)$/ })).toHaveText(["Gym session 9019", "Morning run 9001"]);
  });

  test("a run's row gives its day and start time, its distance, its time and its pace", async ({ alice }) => {
    await openView(alice, "activities");
    const r = row(alice, "Morning run 9000");
    await expect(r.locator(".ameta span").first()).toHaveText(`${weekdayAndDay(daysAgo(1))} · 07:00`);
    await expect(r.locator(".ak b")).toHaveText("7 km");
    await expect(r.locator(".ak small")).toHaveText("5:03 /km · 148 bpm");
  });

  test("a run's row shows its training effect under the numbers", async ({ alice }) => {
    await openView(alice, "activities");
    const easy = row(alice, "Easy run");
    await expect(easy.locator(".ak b")).toHaveText("8 km");
    await expect(easy.locator(".ak small")).toContainText("5:03 /km");
    await expect(easy.locator(".ameta .atag:not(.plan)")).toHaveText("Aerobic Base");
  });

  test("a ride's row shows its speed and heart rate in place of a pace", async ({ alice }) => {
    await openView(alice, "activities");
    const ride = row(alice, "Ride 9024");
    await expect(ride.locator(".ak b")).toHaveText("25 km");
    await expect(ride.locator(".ak small")).toHaveText("21.6 km/h · 148 bpm");
  });

  test("a gym session's row shows its time and heart rate, with no distance or pace", async ({ alice }) => {
    await openView(alice, "activities");
    const gym = row(alice, "Gym session 9019");
    await expect(gym.locator(".ak b")).toHaveText("50 min");
    await expect(gym.locator(".ak small")).toHaveText("148 bpm");
    await expect(gym.locator(".ak")).not.toContainText("km");
  });

  test("the 4-week range keeps only the activities of the last 28 days", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    const recent = activities.filter((a) => a.date >= daysAgo(28));
    expect(recent.length).toBeLessThan(activities.length);
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

  test("the range stays as it was chosen when Progress is opened and the Log again", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    const recent = activities.filter((a) => a.date >= daysAgo(28));
    await openView(alice, "activities");
    await alice.locator("#aRange").selectOption("4w");
    await alice.locator("#aModes button[data-mode=stats]").click();
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
    await expect(alice.locator("#alist .awk span")).toHaveText("1 session · 8 km · 40 min");
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
    await expect(header.locator("span")).toHaveText(`${plural(strength.length, "session")} · ${durationText(strength.reduce((a, r) => a + (r.seconds ?? 0), 0))}`);
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

test.describe("Activities stats", () => {
  test("Stats gives the lifetime totals, as the server counts them", async ({ alice }) => {
    const { activities } = await storedFor(alice);
    const stats = await statsFor(alice);
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    await expect(alice.locator("#astats .aeyebrow").first()).toHaveText("Overall");
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
    expect(strength.detailed).toBeGreaterThan(0);
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    await expect(tile(alice, "Strength", "sessions")).toHaveText(String(strength.sessions));
    await expect(tile(alice, "Strength", "time")).toHaveText(durationText(strength.seconds));
    await expect(tile(alice, "Strength", "volume lifted")).toHaveText(/^[\d,]+ lb$/);
    await expect(alice.locator("#astats .anote", { hasText: "The exercise figures cover" })).toHaveText(`The exercise figures cover ${strength.detailed} of ${strength.sessions} sessions; the others have no details stored yet.`);
    const rows = alice.locator("#astats .alifts .aexc2");
    await expect(rows).toHaveCount(Math.min(12, strength.exercises.length));
    for (const [i, e] of strength.exercises.slice(0, 12).entries()) {
      await expect(rows.nth(i).locator(".aexn")).toHaveText(e.name);
      await expect(rows.nth(i).locator("small").first()).toContainText(`${e.sessions} session`);
      await expect(rows.nth(i).locator(".aexrm")).toHaveText(/^[\d.,]+ lb$|^–$/);
    }
  });

  test("By year has a row for each year with its counts", async ({ alice }) => {
    const { years } = await statsFor(alice);
    await openView(alice, "activities");
    await alice.locator("#aModes button[data-mode=stats]").click();
    const rows = alice.locator("#astats .ayears .ayr");
    await expect(rows).toHaveCount(years.length);
    const y = years[0];
    await expect(rows.first().locator("b")).toHaveText(String(y.year));
    await expect(rows.first().locator("small")).toContainText(`${y.activities.toLocaleString()} activities`);
    await expect(rows.first().locator("small")).toContainText(`${y.runs.toLocaleString()} runs`);
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
    await expect(alice.locator("#astats .aeyebrow", { hasText: exact("Best efforts and records") })).toBeVisible();
    const fast = record(alice, "1 km");
    await expect(fast.locator(".srv")).toHaveText("4:00");
    await expect(fast.locator(".srd")).toHaveText("4:00 /km · 2026-10-01 · Morning run 9014");
    await expect(record(alice, "5 km").locator(".srv")).toHaveText("21:40");
    await expect(record(alice, "5 km").locator(".srd")).toHaveText("4:20 /km · 2026-10-03 · Morning run 9013");
    await expect(alice.locator("#astats")).not.toHaveText(/NaN|undefined|null|Infinity/);
    await fast.click();
    await expect(alice.locator("#aDetailTitle")).toHaveText("Morning run 9014");
  });

  test("the exercises give each lift's estimated one-rep max, its sets and its volume, with the set it came from", async ({ alice }) => {
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
    const lift = alice.locator("#astats .aexc2", { hasText: "Barbell Back Squat" });
    await expect(lift.locator(".aexn")).toHaveText("Barbell Back Squat");
    await expect(lift.locator(".aexrm")).toHaveText("117 lb");
    await expect(lift.locator("small").first()).toHaveText("3 sessions · 12 sets · 60 reps · 6,000 lb · heaviest 100 lb × 5");
    await expect(lift.locator("small").last()).toHaveText("from 5 @ 100 lb on 2026-10-01 · last 2026-10-20");
    const oneRm = alice.locator("#astats .help", { hasText: "est. 1RM" });
    await expect(oneRm).toBeHidden();
    await alice.locator("#astats .alifts").getByRole("button", { name: "About est. 1RM" }).click();
    await expect(oneRm).toBeVisible();
    await expect(oneRm).toContainText("Epley formula");
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
  test("no NaN, undefined or null shows in the log or in Progress", async ({ alice }) => {
    await openView(alice, "activities");
    await expect(alice.locator("#alist .arow").first()).toBeVisible();
    await expect(alice.locator("#aview")).not.toHaveText(/NaN|undefined|null/);
    await alice.locator("#aModes button[data-mode=stats]").click();
    await expect(alice.locator("#astats .stile").first()).toBeVisible();
    await expect(alice.locator("#aview")).not.toHaveText(/NaN|undefined|null/);
  });

  test("the list's rows and the records of Progress are keyboard buttons", async ({ alice }) => {
    await openView(alice, "activities");
    const first = alice.locator("#alist .arow").first();
    await expect(first).toHaveAttribute("role", "button");
    await expect(first).toHaveAttribute("tabindex", "0");
    await alice.locator("#aModes button[data-mode=stats]").click();
    await expect(alice.locator("#astats .srec.go").first()).toHaveAttribute("role", "button");
    await expect(alice.locator("#astats .srec.go").first()).toHaveAttribute("tabindex", "0");
  });
});

test.describe("the daily steps", () => {
  test("a bar for each stored day of the last 30, steps and intensity minutes, sits in the Log over the list; Steps is not in Recovery, Intensity minutes is in both", async ({ alice }) => {
    await openView(alice, "activities");
    const card = alice.locator("#amove .rc", { hasText: "Steps" });
    await expect(card).toBeVisible();
    await expect(card.locator("rect.rc-bar")).toHaveCount(30);
    await expect(alice.locator("#amove .rc", { hasText: "Intensity minutes" }).locator("rect.rc-part.moderate")).toHaveCount(30);
    await alice.locator("#aModes").getByRole("button", { name: "Progress", exact: true }).click();
    await expect(alice.locator("#amove")).toBeHidden();
    await openView(alice, "recovery");
    await alice.locator("#rTabs").getByRole("button", { name: "Trends", exact: true }).click();
    await expect(alice.locator("#rbody .rc .rch b", { hasText: "Steps" })).toHaveCount(0);
    await expect(alice.locator("#rbody .rc .rch b", { hasText: "Intensity minutes" })).toHaveCount(1);
  });
});
