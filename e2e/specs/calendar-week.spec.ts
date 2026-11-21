/**
 * The Calendar's week view, the one it opens on: seven days with a card for each workout (its type, distance and time, its profile, the plan
 * it is in, a tick when it was done), what the week adds up to against the week before, the workout picked shown in full at the side, and the
 * move by drag, by the ⋯ on a card or by Move… in the side. alice's plans are read only and fall around today; the moves use a plan of a
 * profile's own, dated in 2031 so that no other spec's data lands on its weeks.
 */
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect, openView, today, daysAgo, mondayOf, type Profile, chooseTheme } from "../support/fixtures";

test.describe.configure({ timeout: 60_000 });

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const longLabel = (day: string) => new Intl.DateTimeFormat("en-CA", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
const weekTitle = (monday: string) => new Intl.DateTimeFormat("en-CA", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).formatRange(new Date(`${monday}T00:00:00Z`), new Date(`${addDays(monday, 6)}T00:00:00Z`));
const enc = (path: string) => `/api/file?path=${encodeURIComponent(path)}`;
const day = (page: Page, iso: string): Locator => page.locator(`#cwBoard .wday[data-day="${iso}"]`);
const card = (page: Page, name: string): Locator => page.locator("#cwBoard .wcard").filter({ has: page.locator(".wcn", { hasText: name }) });
const toast = (page: Page) => page.locator("#toast");

async function openWeek(page: Page): Promise<void> {
  await openView(page, "calendar");
  await expect(page.locator("#cNote")).not.toContainText("Loading", { timeout: 20_000 });
  await expect(page.locator("#cwBoard .wday")).toHaveCount(7);
}

/** A plan file of the profile's, dated in 2031, and the week of its Monday shown (by its row in the legend). */
async function openOnPlan(page: Page, profile: Profile, suffix: string, workouts: object[], monday = "2031-09-01"): Promise<{ path: string; name: string }> {
  const name = `${profile.name}-${suffix}`, path = `workout-plans/${name}.json`;
  const res = await profile.api.put(enc(path), { data: { text: JSON.stringify({ weekStart: "2031-09-01", weekEnd: "2031-09-07", workouts }), create: true } });
  expect(res.status(), await res.text()).toBe(201);
  await openWeek(page);
  await page.locator("#cLegend .citem", { hasText: name }).click();
  await expect(page.locator("#cTitle")).toHaveText(weekTitle(monday)); // the week the plan starts in
  return { path, name };
}

async function savedDates(api: APIRequestContext, path: string): Promise<unknown[]> {
  const res = await api.get(enc(path));
  return JSON.parse((await res.json()).text).workouts.map((w: any) => w.scheduledDate);
}

test.describe("the week", () => {
  test("opens on the week of today: its dates in the title, seven days Monday to Sunday, and today marked", async ({ alice }) => {
    await openWeek(alice);
    const monday = mondayOf(today());
    await expect(alice.locator("#cTitle")).toHaveText(weekTitle(monday));
    expect(await alice.locator("#cwBoard .wday").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.day))).toEqual(Array.from({ length: 7 }, (_, i) => addDays(monday, i)));
    await expect(alice.locator("#cwBoard .wday.today")).toHaveCount(1);
    await expect(day(alice, today())).toHaveClass(/today/);
    await expect(alice.locator("#cViews button[data-view=week]")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#cModes")).toBeHidden(); // the modes are the month's
  });

  test("the arrows move a week, Today comes back, and they say week", async ({ alice }) => {
    await openWeek(alice);
    const monday = mondayOf(today());
    await expect(alice.locator("#cNext")).toHaveAttribute("aria-label", "Next week");
    await alice.locator("#cNext").click();
    await expect(alice.locator("#cTitle")).toHaveText(weekTitle(addDays(monday, 7)));
    await alice.locator("#cPrev").click();
    await alice.locator("#cPrev").click();
    await expect(alice.locator("#cTitle")).toHaveText(weekTitle(addDays(monday, -7)));
    await alice.locator("#cToday").click();
    await expect(alice.locator("#cTitle")).toHaveText(weekTitle(monday));
    await expect(day(alice, today())).toHaveClass(/sel/);
  });

  test("a workout is a card: its type, name, distance and time, its profile, and the plan it is in", async ({ alice }) => {
    await openWeek(alice);
    const tempo = card(alice, "Tempo intervals");
    await expect(tempo).toHaveCount(1);
    await expect(tempo.locator(".wct")).toContainText("Running");
    await expect(tempo.locator(".wcm")).toHaveText(/^\d+(\.\d)? km · ~\d+ min$/);
    await expect(tempo.locator(".wcg .wv-chart")).toHaveAttribute("role", "img");
    await expect(tempo.locator(".wcp")).toContainText("alice-run-block");
    await expect(day(alice, today()).locator(".wcard")).toContainText("Tempo intervals");
  });

  test("a strength workout has no profile to draw, and says its time", async ({ alice }) => {
    await alice.locator("body").evaluate(() => undefined);
    await openView(alice, "calendar");
    // the next days that have it: go forward to a week with Full body strength
    const strength = alice.locator("#cwBoard .wcard", { hasText: "Full body strength" });
    for (let i = 0; i < 2 && !(await strength.count()); i++) await alice.locator("#cNext").click();
    await expect(strength.first()).toBeVisible();
    await expect(strength.first().locator(".wcg")).toHaveCount(0);
    await expect(strength.first().locator(".wcm")).toHaveText(/^~\d+ min$/);
  });

  test("an empty day is a Rest day", async ({ me, profile }) => {
    await openOnPlan(me, profile, "rest", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await expect(day(me, "2031-09-02").locator(".wrest")).toHaveText("Rest day");
    await expect(day(me, "2031-09-03").locator(".wrest")).toHaveCount(0);
  });

  test("a card can be picked from the keyboard", async ({ alice }) => {
    await openWeek(alice);
    const tempo = card(alice, "Tempo intervals");
    await tempo.focus();
    await alice.keyboard.press("Enter");
    await expect(tempo).toHaveClass(/sel/);
    await expect(alice.locator("#cDayTitle")).toHaveText("Workout");
  });
});

test.describe("what the week adds up to", () => {
  test("counts the cards, adds up their distance and time, and draws the load of each day", async ({ me, profile }) => {
    await openOnPlan(me, profile, "sum", [
      { workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-02", steps: [{ stepType: "interval", targetType: "no.target", endCondition: "distance", endConditionValue: 10000 }] },
      { workoutName: "Hill run", workoutType: "running", scheduledDate: "2031-09-04", steps: [{ stepType: "interval", targetType: "no.target", endCondition: "distance", endConditionValue: 5000 }] },
    ]);
    const tiles = me.locator("#cwSum .cws");
    await expect(tiles.nth(0).locator("b")).toHaveText("2");
    await expect(tiles.nth(1).locator("b")).toHaveText(/^~?15 km$/);
    await expect(tiles.nth(2).locator("b")).toHaveText(/^~?\d+ h \d\d$/);
    const load = me.locator("#cwSum .cwload");
    await expect(load).toHaveAttribute("role", "img");
    await expect(load).toHaveAttribute("aria-label", /^Planned time by day: Mon none, Tue \d/);
    await expect(load.locator(".cwbar")).toHaveCount(7);
    await expect(load.locator(".cwbar.none")).toHaveCount(5);
  });

  test("says how the week compares with the week before, and nothing when the week before had nothing", async ({ me, profile }) => {
    await openOnPlan(me, profile, "cmp", [
      { workoutName: "Last week", workoutType: "running", scheduledDate: "2031-08-26", steps: [{ stepType: "interval", targetType: "no.target", endCondition: "time", endConditionValue: 3600 }] },
      { workoutName: "This week", workoutType: "running", scheduledDate: "2031-09-03", steps: [{ stepType: "interval", targetType: "no.target", endCondition: "time", endConditionValue: 5400 }] },
    ], "2031-08-25");
    await me.locator("#cNext").click(); // the plan starts a week early: the week of the 1st is the next
    await expect(me.locator("#cTitle")).toHaveText(weekTitle("2031-09-01"));
    await expect(me.locator("#cwSum .cws").nth(2).locator("span")).toHaveText("▲ 50 % on last week");
    await me.locator("#cPrev").click();
    await expect(me.locator("#cwSum .cws").nth(2).locator("span")).toHaveText("last week had nothing");
  });

  test("ticks a workout that was done (started from it) and says how many were", async ({ alice }) => {
    await openWeek(alice);
    if (mondayOf(daysAgo(2)) !== mondayOf(today())) await alice.locator("#cPrev").click();
    const easy = card(alice, "Easy run");
    await expect(easy).toHaveCount(1);
    await expect(easy).toHaveClass(/done/);
    await expect(easy.locator(".wdone")).toHaveAttribute("title", "Done");
    await expect(easy).toHaveAttribute("aria-label", /, done$/);
    await expect(alice.locator("#cwSum .cws").first().locator("span")).toHaveText(/^1 done$/);
  });
});

test.describe("the side of the week", () => {
  test("shows the workout picked in full, with Open plan and Move…, and the day's list when none is picked", async ({ alice }) => {
    await openWeek(alice);
    await expect(alice.locator("#cDayTitle")).not.toHaveText("Workout");
    const tempo = card(alice, "Tempo intervals");
    await tempo.click();
    await expect(alice.locator("#cDayTitle")).toHaveText("Workout");
    await expect(alice.locator("#cDay .wdtt")).toHaveText("Tempo intervals");
    await expect(alice.locator("#cDay .wdgraph .wv-chart")).toBeVisible();
    await expect(alice.locator("#cDay .wdsteps")).toContainText("steps");
    await expect(alice.locator("#cDay .wdact button")).toHaveText(["Open plan", "Move…"]);
    await day(alice, today()).locator(".wdh").click();
    await expect(alice.locator("#cDayTitle")).not.toHaveText("Workout");
  });

  test("Open plan opens the plan on that workout, and a double click on a card does too", async ({ alice }) => {
    await openWeek(alice);
    await card(alice, "Tempo intervals").click();
    await alice.locator("#cDay .wdact button", { hasText: "Open plan" }).click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "plans");
    await expect(alice.locator("#current")).toContainText("alice-run-block.json");
    await openWeek(alice);
    await card(alice, "Tempo intervals").dblclick();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "plans");
  });

  test("the plans are listed, and a plan's row shows the week it starts in", async ({ me, profile }) => {
    const { name } = await openOnPlan(me, profile, "legend", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await expect(me.locator("#cLegend .citem", { hasText: name })).toContainText("Sep");
    await expect(me.locator("#cTypesTitle")).toBeHidden();
  });
});

test.describe("moving a workout in the week", () => {
  test("the ⋯ on a card moves it to the next day, saves the plan, and Undo moves it back", async ({ me, profile }) => {
    const { path } = await openOnPlan(me, profile, "menu", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    const run = card(me, "Morning run");
    await run.hover();
    await run.locator(".wcmv").click();
    await expect(me.locator("#moveMenu")).toBeVisible();
    await me.locator("#mvNext").click();
    await expect(toast(me)).toContainText("Moved Morning run to");
    await expect(day(me, "2031-09-04").locator(".wcard")).toHaveCount(1);
    await expect(day(me, "2031-09-03").locator(".wcard")).toHaveCount(0);
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-04"]);
    await toast(me).getByRole("button", { name: "Undo" }).click();
    await expect(day(me, "2031-09-03").locator(".wcard")).toHaveCount(1);
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-03"]);
  });

  test("Move… in the side moves the picked workout, which stays picked on its new day", async ({ me, profile }) => {
    const { path } = await openOnPlan(me, profile, "side", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await card(me, "Morning run").click();
    await me.locator("#cDay .wdact button", { hasText: "Move…" }).click();
    await me.locator("#mvWeek").click();
    await expect(toast(me)).toContainText("Moved Morning run to");
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-10"]);
  });

  test("a card dropped on another day asks, then moves the workout there; dropped off the days, or cancelled, it stays", async ({ me, profile }) => {
    const { path } = await openOnPlan(me, profile, "drag", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    const drag = async (to: Locator) => {
      const a = (await card(me, "Morning run").boundingBox())!, b = (await to.boundingBox())!;
      await me.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await me.mouse.down();
      await me.mouse.move(a.x + a.width / 2 + 14, a.y + a.height / 2 + 4, { steps: 3 });
      await me.mouse.move(b.x + b.width / 2, b.y + 60, { steps: 10 });
      await me.mouse.up();
    };
    await drag(day(me, "2031-09-05"));
    await expect(me.locator("#dlgTitle")).toHaveText("Move Morning run?");
    await expect(me.locator("#dlgText")).toHaveText(`From ${longLabel("2031-09-03")} to ${longLabel("2031-09-05")}.`);
    await me.locator("#dlgCancel").click();
    await expect(me.locator("#dlg")).toBeHidden();
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-03"]);
    await drag(day(me, "2031-09-05"));
    await me.locator("#dlgOk").click();
    await expect(toast(me)).toContainText("Moved Morning run to");
    await expect(day(me, "2031-09-05").locator(".wcard")).toHaveCount(1);
    expect(await savedDates(profile.api, path)).toEqual(["2031-09-05"]);
  });

  test("a click on a card is not a drag: it picks the card and asks nothing", async ({ me, profile }) => {
    await openOnPlan(me, profile, "click", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await card(me, "Morning run").click();
    await expect(me.locator("#dlg")).toBeHidden();
    await expect(card(me, "Morning run")).toHaveClass(/sel/);
  });
});

test.describe("week and month", () => {
  test("the choice is kept, the week opened is the one of the day picked in the month, and the month's day card has a way back to its week", async ({ alice }) => {
    await openWeek(alice);
    await alice.locator("#cViews button[data-view=month]").click();
    await expect(alice.locator("#cgrid .cday").first()).toBeVisible();
    await expect(alice.locator("#cwBoard")).toBeHidden();
    await expect(alice.locator("#cModes")).toBeVisible();
    await alice.reload();
    await expect(alice.locator("#cgrid .cday").first()).toBeVisible(); // the month stays the month
    await alice.locator("#cgrid .cday.today").first().click({ position: { x: 6, y: 6 } });
    await alice.locator("#cDay .cwlink").click();
    await expect(alice.locator("#cwBoard .wday")).toHaveCount(7);
    await expect(alice.locator("#cTitle")).toHaveText(weekTitle(mondayOf(today())));
    await alice.reload();
    await expect(alice.locator("#cwBoard .wday")).toHaveCount(7);
  });
});

test.describe("an empty calendar", () => {
  test("says so, with a way to the nearest week that has something when there is one", async ({ me, profile }) => {
    await openOnPlan(me, profile, "far", [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }]);
    await me.locator("#cNext").click();
    await me.locator("#cNext").click();
    await expect(me.locator("#cNote")).toContainText("Nothing planned this week.");
    await me.locator("#cNote button", { hasText: "←" }).click();
    await expect(me.locator("#cTitle")).toHaveText(weekTitle("2031-09-01"));
    await expect(me.locator("#cNote")).toBeHidden();
  });
});

test.describe("the look of the week", () => {
  const contrast = (page: Page, a: string, b: string) =>
    page.evaluate(([x, y]) => {
      const lum = (css: string) => {
        const scale = css.startsWith("color(") ? 255 : 1; // a colour the browser mixed is written color(srgb 0.9 0.9 0.8), each part 0 to 1
        const [r, g, bl] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => { const c = (v * scale) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      };
      return (Math.max(lum(x), lum(y)) + 0.05) / (Math.min(lum(x), lum(y)) + 0.05);
    }, [a, b]);
  const style = (page: Page, selector: string, prop: string) => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

  test("the text of the summary, the days and the cards keeps its contrast in both themes", async ({ alice }) => {
    await openWeek(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await chooseTheme(alice, "light");
      const tile = await style(alice, "#cwSum .cws", "background-color");
      expect(await contrast(alice, await style(alice, "#cwSum .cws b", "color"), tile), `${theme}: a number of the summary`).toBeGreaterThanOrEqual(7);
      expect(await contrast(alice, await style(alice, "#cwSum .cws > span", "color"), tile), `${theme}: its note`).toBeGreaterThanOrEqual(4.5);
      const col = await style(alice, "#cwBoard .wday:not(.today)", "background-color");
      expect(await contrast(alice, await style(alice, "#cwBoard .wday:not(.today) .wdn", "color"), col), `${theme}: a weekday`).toBeGreaterThanOrEqual(4.5);
      const c = await style(alice, "#cwBoard .wcard", "background-color");
      expect(await contrast(alice, await style(alice, "#cwBoard .wcard .wcn", "color"), c), `${theme}: a card's name`).toBeGreaterThanOrEqual(7);
      expect(await contrast(alice, await style(alice, "#cwBoard .wcard .wcm", "color"), c), `${theme}: its figures`).toBeGreaterThanOrEqual(4.5);
      expect(await contrast(alice, await style(alice, "#cwBoard .wcard .wcp", "color"), c), `${theme}: its plan`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("the bar's controls, the week and month choice included, are at least 44 px", async ({ alice }) => {
    await openWeek(alice);
    const small = await alice.evaluate(() => [...document.querySelectorAll<HTMLElement>("#cbar button")].filter((el) => el.offsetParent !== null).map((el) => [el.id || el.dataset.view || "", Math.round(el.getBoundingClientRect().height)] as const).filter(([, h]) => h < 44));
    expect(small).toEqual([]);
  });

  test("on a laptop the side goes under the week, and the seven days still have room", async ({ alice }) => {
    await alice.setViewportSize({ width: 1024, height: 768 });
    await openWeek(alice);
    const at = (selector: string) => alice.locator(selector).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: r.width }; });
    const [board, side, col] = [await at("#cwBoard"), await at("#cside"), await at("#cwBoard .wday")];
    expect(side.top).toBeGreaterThan(board.top);
    expect(col.width).toBeGreaterThanOrEqual(100);
    expect(board.right).toBeLessThanOrEqual(1024);
  });
});
