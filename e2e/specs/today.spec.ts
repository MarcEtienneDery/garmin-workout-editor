/**
 * The Today view: the page that opens first. Alice has stored health data, activities and a plan around today (read-only); a fresh
 * profile has nothing, so what it shows is what the page says when there is nothing. Food and plans are added through the API for
 * the fresh profile only. Garmin is not connected for either, so the Sync button and the profile picker are absent for them.
 */
import type { Page } from "@playwright/test";
import { test, expect, openView, loginAs, today, daysAgo, daysAhead, ADMIN_TOKEN } from "../support/fixtures";

// The machine is shared by every spec run at once: a page can take many seconds to answer, so each test has more than the default 30 s.
test.describe.configure({ timeout: 60_000 });

// ── helpers ──────────────────────────────────────────────────────────────

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A day as the Today view labels it: "Fri 30 Oct". */
const dayLabel = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};
const grouped = (n: number) => n.toLocaleString("en-CA");

/**
 * Open the Today view and wait until its own "Loading…" has gone. The machine runs many specs at once, so the first answer can take
 * several seconds: the wait is longer than the default expect timeout, and it is the page's own signal that the data has arrived.
 */
async function openToday(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await openView(page, "today");
    await expect(page.locator("#tbody")).not.toContainText("Loading", { timeout: 20_000 });
    // a load the server dropped leaves the page's error in place of the day: the page is opened again
    if (!(await page.locator("#tbody .msg.err").count())) return;
  }
}

/** The words that mean a value was never filled in: they must not reach a page. */
const RAW_WORDS = /\b(NaN|undefined|null|Infinity)\b/;

/** Every subsequence check: `expected` appears in `actual` in this order (other items may sit between them). */
function expectInOrder(actual: string[], expected: string[]) {
  let at = 0;
  for (const want of expected) {
    const found = actual.indexOf(want, at);
    expect(found, `"${want}" in order in ${JSON.stringify(actual)}`).toBeGreaterThanOrEqual(0);
    at = found + 1;
  }
}

/** Today's numbers as the server has them, read with the signed-in browser's session. */
async function todayData(page: Page) {
  const res = await page.context().request.get("/api/today?profile=alice");
  expect(res.ok()).toBeTruthy();
  return res.json();
}

const card = (page: Page) => page.locator("#tbody section.tcard").first();
const tile = (page: Page, label: string) => page.locator("#tbody .tfig", { has: page.locator("small", { hasText: new RegExp(`^${label}$`) }) });

// ── alice: the day as it is ─────────────────────────────────────────────

test.describe("alice's day", () => {
  test("the title is today's day", async ({ alice }) => {
    await openToday(alice);
    await expect(alice.locator("#tTitle")).toHaveText(dayLabel(today()));
  });

  test("the line under the title says how old the numbers are: when the watch synced and when they were fetched", async ({ alice }) => {
    await openToday(alice);
    await expect(alice.locator("#tAsOf")).toHaveText(/^Watch synced \d+ days? ago · fetched (just now|\d+ min ago|\d+ h ago|\d+ days? ago)$/);
  });

  test("a watch that has not synced for hours says to open Garmin Connect, and a plain sync would not help", async ({ alice }) => {
    await openToday(alice);
    await expect(alice.locator("#tbody .thint")).toContainText("The watch has not synced for a while");
    await expect(alice.locator("#tbody .thint")).toContainText("Open Garmin Connect on your phone");
  });

  test("the Sync button and the profile picker are absent for a profile without Garmin", async ({ alice }) => {
    await openToday(alice);
    await expect(alice.locator("#tbody .tcard")).toHaveCount(2);
    await expect(alice.locator("#tSync")).toBeHidden();
    await expect(alice.locator("#tProfile")).toBeHidden();
  });

  test("today's workout card lists the plan's workout for today, with its profile picture", async ({ alice }) => {
    await openToday(alice);
    const tempo = card(alice).locator(".twk", { hasText: "Tempo intervals" });
    await expect(tempo).toHaveCount(1);
    await expect(tempo.locator(".wv-chart")).toHaveAttribute("role", "img");
    await expect(tempo.locator(".wv-chart")).toHaveAttribute("aria-label", /^Workout profile: \d+ steps/);
    await expect(card(alice).locator(".twk")).toHaveCount(1);
  });

  test("today's workout says what it is, and its distance and time (with ~ where the time is an estimate)", async ({ alice }) => {
    await openToday(alice);
    const tempo = card(alice).locator(".twk", { hasText: "Tempo intervals" });
    await expect(tempo.locator(".tm")).toHaveText(/^Running · 9\.5 km · ~\d+ min$/);
  });

  test("a workout from two days ago is not on today's card, even when it was done", async ({ alice }) => {
    await openToday(alice);
    await expect(alice.locator("#tbody")).toContainText("Tempo intervals");
    await expect(alice.locator("#tbody")).not.toContainText("Easy run");
    await expect(alice.locator("#tbody .twk.done")).toHaveCount(0);
  });

  test("the readiness chip shows the band and score the stored data gives, and it is not Done for a workout not started from one", async ({ alice }) => {
    await openToday(alice);
    const data = await todayData(alice);
    const chip = card(alice).locator(".tch .chip");
    await expect(chip).toContainText(`· ${data.readiness.score}`);
    await expect(card(alice).locator(".tsug")).toHaveText(data.readiness.suggestion);
    await expect(card(alice).locator(".twk")).not.toContainText("Done");
  });

  test("the readiness chip opens the Recovery view", async ({ alice }) => {
    await openToday(alice);
    await card(alice).locator(".tch .chip").click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "recovery");
  });

  test("today's activities are listed under Done so far, with time, distance, duration and calories", async ({ alice }) => {
    await openToday(alice);
    const done = card(alice).locator(".tdone");
    await expect(done.locator("h4")).toHaveText("Done so far");
    await expect(done.locator(".ta").first()).toHaveText("Today's shakeout06:00 · 4 km · 25 min · 520 kcal");
  });

  test("the steps tile shows the day's steps against the goal, with the distance", async ({ alice }) => {
    await openToday(alice);
    const steps = tile(alice, "Steps");
    await expect(steps.locator("b")).toHaveText("6,000");
    await expect(steps.locator("span")).toHaveText("of 6,000 · 100% · 5.2 km");
    await expect(steps.locator(".tbar")).toHaveClass(/done/);
  });

  test("the intensity minutes tile shows the week against Garmin's goal", async ({ alice }) => {
    await openToday(alice);
    // the week runs from Monday to today, so its total depends on the weekday: the server's answer says what it is
    const data = await todayData(alice);
    const pct = Math.round((data.week.minutes / data.progress.intensityGoal) * 100);
    const minutes = tile(alice, "Intensity minutes");
    await expect(minutes.locator("b")).toHaveText(grouped(data.week.minutes));
    await expect(minutes.locator("span")).toHaveText(`of ${grouped(data.progress.intensityGoal)} this week · ${pct}%`);
    await expect(minutes.locator(".tbar")).toHaveClass(pct >= 100 ? /done/ : /^tbar$/);
  });

  test("the Body Battery tile shows the reading now, with the wake, low and stress values", async ({ alice }) => {
    await openToday(alice);
    const battery = tile(alice, "Body Battery");
    await expect(battery.locator("b")).toHaveText("40");
    await expect(battery.locator("span")).toHaveText("woke at 70 · low 20 · stress 30");
    await expect(battery.locator(".tbar i")).toHaveAttribute("style", /--w: 40%/);
    await expect(battery.locator(".tbar")).not.toHaveClass(/done/);
  });

  test("the sleep tile shows last night's sleep against the sleep needed", async ({ alice }) => {
    await openToday(alice);
    const sleep = tile(alice, "Sleep");
    await expect(sleep.locator("b")).toHaveText("6 h 57");
    await expect(sleep.locator("span")).toHaveText("score 82 · need 8 h 00 · resting HR 49");
  });

  test("with every number stored, no tile says 'not synced yet'", async ({ alice }) => {
    await openToday(alice);
    await expect(alice.locator("#tbody .tfig")).toHaveCount(4);
    await expect(alice.locator("#tbody")).not.toContainText("not synced yet");
  });

  test("every tile opens the Recovery view, from a click", async ({ alice }) => {
    await openToday(alice);
    for (const label of ["Steps", "Intensity minutes", "Body Battery", "Sleep"]) {
      await alice.locator("#vToday").click();
      await expect(alice.locator("body")).toHaveAttribute("data-view", "today");
      await tile(alice, label).click();
      await expect(alice.locator("body")).toHaveAttribute("data-view", "recovery");
    }
  });

  test("a tile can be opened from the keyboard", async ({ alice }) => {
    await openToday(alice);
    await tile(alice, "Sleep").focus();
    await alice.keyboard.press("Enter");
    await expect(alice.locator("body")).toHaveAttribute("data-view", "recovery");
  });

  test("the food section says nothing is logged today, against the goals", async ({ alice }) => {
    await openToday(alice);
    const food = alice.locator("#tbody .tfsum");
    await expect(food.locator(".fhero")).toContainText("nothing logged");
    await expect(food.locator(".fhero")).toContainText("goal 2,200 kcal");
    await expect(food.locator(".fhero b")).toHaveText("–");
    await expect(food.locator(".fmrows")).toContainText("Protein");
    await expect(food.locator(".fmrows")).toContainText("– / 130 g");
    await expect(food.locator(".fmrows")).toContainText("– / 250 g");
    await expect(food.locator(".fmrows")).toContainText("– / 70 g");
    await expect(food.locator(".fburn")).toContainText("Burned 2,600 kcal so far by Garmin");
  });

  test("the food section shows goals, so it has no hint to set them", async ({ alice }) => {
    await openToday(alice);
    await expect(alice.locator("#tbody .tfsum .fgoalhint")).toHaveCount(0);
  });

  test("'Open the Food view' opens the Food view", async ({ alice }) => {
    await openToday(alice);
    await alice.locator("#tbody .tgo").click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "food");
  });

  test("the coming days list the plan's workouts in date order, after today and within the next seven days", async ({ alice }) => {
    await openToday(alice);
    await expect(alice.locator("#tbody h3", { hasText: "Next days" })).toBeVisible();
    const names = await alice.locator("#tbody .tcard .twk .tn").allTextContents();
    expectInOrder(names, ["Full body strength", "Shared walk", "Long run", "Full body strength"]);
    await expect(alice.locator("#tbody .tday").first()).toHaveText("Tomorrow");
    await expect(alice.locator("#tbody .tday", { hasText: dayLabel(daysAhead(2)) })).toHaveCount(1);
    await expect(alice.locator("#tbody .tday", { hasText: dayLabel(daysAhead(3)) })).toHaveCount(1);
  });

  test("coming workouts show their distance and time, with ~ where the time is an estimate", async ({ alice }) => {
    await openToday(alice);
    const walk = alice.locator("#tbody .twk", { hasText: "Shared walk" });
    await expect(walk.locator(".tm")).toHaveText("Walking · 3 km");
    const long = alice.locator("#tbody .twk", { hasText: "Long run" });
    await expect(long.locator(".tm")).toHaveText(/^Running · 16 km · ~\d+ h \d+ min$/);
    const strength = alice.locator("#tbody .twk", { hasText: "Full body strength" }).first();
    await expect(strength.locator(".tm")).toHaveText(/^Strength training · ~\d+ min$/);
  });

  test("clicking a coming workout opens its plan", async ({ alice }) => {
    await openToday(alice);
    await alice.locator("#tbody .twk", { hasText: "Shared walk" }).click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "plans");
    await expect(alice.locator("#current")).toContainText("shared-base.json");
  });

  test("clicking today's workout opens its plan", async ({ alice }) => {
    await openToday(alice);
    await alice.locator("#tbody .twk", { hasText: "Tempo intervals" }).click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "plans");
    await expect(alice.locator("#current")).toContainText("alice-run-block.json");
  });

  test("the shown numbers match the server's answer for today", async ({ alice }) => {
    await openToday(alice);
    const data = await todayData(alice);
    await expect(tile(alice, "Steps").locator("b")).toHaveText(grouped(data.day.steps));
    await expect(card(alice).locator(".tsug")).toHaveText(data.readiness.suggestion);
    await expect(alice.locator("#tbody .tfsum .fhero b")).toHaveText("–");
  });
});

// ── no raw values in any view of alice ──────────────────────────────────

const VIEWS: [string, string, string][] = [
  ["today", "#tbody .tcard", "#tbody"],
  ["calendar", "#cgrid .cday", "#cview"],
  ["activities", "#aview", "#aview"],
  ["recovery", "#rview", "#rview"],
  ["weight", "#bview", "#bview"],
  ["food", "#fview", "#fview"],
  ["plans", "#outline", "#outline"],
];
for (const [view, ready, where] of VIEWS) {
  test(`no view of alice shows a NaN, undefined or null: ${view}`, async ({ alice }) => {
    await openView(alice, view);
    await expect(alice.locator(ready).first()).toBeVisible({ timeout: 20_000 });
    await expect(alice.locator(where).first()).not.toContainText("Loading", { timeout: 20_000 });
    const text = await alice.locator(where).first().innerText();
    expect(text).not.toMatch(RAW_WORDS);
  });
}

// ── a fresh profile: nothing to show, and what it says instead ───────────

test.describe("a profile with nothing", () => {
  test("says there is nothing planned today, and shows no tiles, readiness or sync", async ({ me }) => {
    await openToday(me);
    await expect(me.locator("#tbody")).toContainText("Nothing is planned for today.");
    await expect(me.locator("#tbody .rfigs")).toHaveCount(0);
    await expect(me.locator("#tbody .tch .chip")).toHaveCount(0);
    await expect(me.locator("#tAsOf")).toBeEmpty();
    await expect(me.locator("#tSync")).toBeHidden();
    await expect(me.locator("#tbody")).not.toContainText("Done so far");
  });

  test("the food section says nothing is logged and offers to set goals in Settings", async ({ me }) => {
    await openToday(me);
    await expect(me.locator("#tbody .tfsum .fhero")).toContainText("nothing logged");
    await expect(me.locator("#tbody .tfsum .fgoalhint")).toContainText("Set daily goals to follow your progress through the day.");
    await me.locator("#tbody .tfsum .fgoalhint button").click();
    await expect(me.locator("body")).toHaveAttribute("data-view", "settings");
  });

  test("with nothing planned, the coming days list the shared plan's walk and nothing else from this profile", async ({ me }) => {
    await openToday(me);
    await expect(me.locator("#tbody .tcard .twk .tn", { hasText: "Shared walk" })).toHaveCount(1);
    await expect(me.locator("#tbody")).not.toContainText("Full body strength");
  });

  test("food logged through the API, with goals, shows the calories, the macros and what is left", async ({ me, profile }) => {
    const logged = await profile.api.post("/api/nutrition", { data: { action: "add", profile: profile.name, day: today(), meal: "lunch", items: [{ name: "Lentil soup", kcal: 500, proteinG: 20, carbsG: 60, fatG: 15 }] } });
    expect(logged.ok()).toBeTruthy();
    const goals = await profile.api.post("/api/settings/goals", { data: { action: "save", profile: profile.name, goals: { kcal: 2000, proteinG: 100, carbsG: 250, fatG: 70 } } });
    expect(goals.ok()).toBeTruthy();
    await openToday(me);
    const food = me.locator("#tbody .tfsum");
    await expect(food.locator(".fhero b")).toHaveText("500");
    await expect(food.locator(".fhero")).toContainText("1,500 kcal to go · goal 2,000 kcal");
    await expect(food.locator(".fmrows")).toContainText("20 / 100 g");
    await expect(food.locator(".fmrows")).toContainText("80 g to go");
    await expect(food.locator(".fmrows")).toContainText("60 / 250 g");
    await expect(food.locator(".fmrows")).toContainText("190 g to go");
    await expect(food.locator(".fmrows")).toContainText("15 / 70 g");
    await expect(food.locator(".fmrows")).toContainText("55 g to go");
    // no Garmin, so no burn to add to the goal
    await expect(food.locator(".fburn")).toHaveCount(0);
    await expect(food.locator(".fgoalhint")).toHaveCount(0);
  });

  test("goals set without any food show the goal and that nothing is logged", async ({ me, profile }) => {
    const goals = await profile.api.post("/api/settings/goals", { data: { action: "save", profile: profile.name, goals: { kcal: 1800 } } });
    expect(goals.ok()).toBeTruthy();
    await openToday(me);
    await expect(me.locator("#tbody .tfsum .fhero")).toContainText("goal 1,800 kcal · nothing logged");
    await expect(me.locator("#tbody .tfsum .fhero b")).toHaveText("–");
  });

  test("a workout scheduled for today appears on today's card, and opens its plan", async ({ me, profile }) => {
    const name = `${profile.name}-hills`;
    const path = `workout-plans/${name}.json`;
    const made = await profile.api.put(`/api/file?path=${encodeURIComponent(path)}`, {
      data: {
        text: JSON.stringify({ workouts: [{ workoutName: "Hills", workoutType: "running", scheduledDate: today(), steps: [{ stepType: "interval", targetType: "no.target", endCondition: "time", endConditionValue: 1200 }] }] }),
        create: true,
      },
    });
    expect(made.status()).toBe(201);
    await openToday(me);
    const hills = card(me).locator(".twk", { hasText: "Hills" });
    await expect(hills).toHaveCount(1);
    await expect(hills.locator(".tm")).toHaveText(/^Running · \d+(\.\d)? km · ~\d+ min$/);
    await expect(me.locator("#tbody")).not.toContainText("Nothing is planned for today.");
    await hills.click();
    await expect(me.locator("body")).toHaveAttribute("data-view", "plans");
    await expect(me.locator("#current")).toContainText(`${name}.json`);
  });

  test("a workout more than seven days ahead, and one from yesterday, are not listed", async ({ me, profile }) => {
    const made = await profile.api.put(`/api/file?path=${encodeURIComponent(`workout-plans/${profile.name}-window.json`)}`, {
      data: {
        text: JSON.stringify({
          workouts: [
            { workoutName: "Yesterday's run", workoutType: "running", scheduledDate: daysAgo(1), distanceMeters: 5000 },
            { workoutName: "Within the week", workoutType: "cycling", scheduledDate: daysAhead(3), distanceMeters: 30000 },
            { workoutName: "Beyond the week", workoutType: "running", scheduledDate: daysAhead(9), distanceMeters: 8000 },
          ],
        }),
        create: true,
      },
    });
    expect(made.status()).toBe(201);
    await openToday(me);
    await expect(me.locator("#tbody .twk", { hasText: "Within the week" })).toHaveCount(1);
    await expect(me.locator("#tbody .twk", { hasText: "Within the week" }).locator(".tm")).toHaveText("Cycling · 30 km");
    await expect(me.locator("#tbody")).not.toContainText("Beyond the week");
    await expect(me.locator("#tbody")).not.toContainText("Yesterday's run");
  });

  test("a profile with nothing shows no NaN, undefined or null on Today", async ({ me }) => {
    await openToday(me);
    await expect(me.locator("#tbody")).not.toContainText("Loading…");
    const text = await me.locator("#tbody").innerText();
    expect(text).not.toMatch(RAW_WORDS);
  });
});

// ── an admin picks the profile the Today view shows ─────────────────────

test("an admin picks the profile the Today view shows, and the picker switches the day", async ({ page, profile }) => {
  await loginAs(page, "admin", ADMIN_TOKEN);
  await page.goto("/");
  await expect(page.locator("#tProfile")).toBeVisible({ timeout: 20_000 });
  await page.locator("#tProfile").selectOption("alice");
  await expect(page.locator("#tbody .twk", { hasText: "Tempo intervals" })).toHaveCount(1, { timeout: 20_000 });
  await page.locator("#tProfile").selectOption(profile.name);
  await expect(page.locator("#tbody")).toContainText("Nothing is planned for today.");
  await expect(page.locator("#tbody")).not.toContainText("Tempo intervals");
});
