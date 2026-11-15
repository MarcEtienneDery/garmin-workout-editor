/**
 * The Weight view in its new look: the week of the day shown, the verdict of the line through the weigh-ins (and the goal against it), the chart,
 * the weeks one by one, the calories burned and eaten, the Body part (only when the scale measured a body fat), the Data part, the empty states,
 * the goal set on the Weight tab and in Settings, both themes, and the sizes of the controls. alice (a weigh-in every third day for 45 days, 5 days
 * of food, no Garmin login) is read only: the states she does not have are made by changing her answer on its way to the page (`stub`), and the one
 * test that sets a goal on her takes it off again.
 */
import { test, expect, openView, loginAs, daysAgo, today, mondayOf, PASSWORD, ADMIN_TOKEN, type APIRequestContext, type Page } from "../support/fixtures";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LB_PER_KG = 2.2046226218;
const MINUS = "−";
const label = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const short = (iso: string) => label(iso).slice(4);
const fmt = (v: number, digits = 1) => v.toLocaleString("en-CA", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const weightIn = (kg: number, unit: "lb" | "kg" = "lb") => `${fmt(unit === "lb" ? kg * LB_PER_KG : kg)} ${unit}`;
const changeIn = (kg: number, unit: "lb" | "kg" = "lb") => { const v = unit === "lb" ? kg * LB_PER_KG : kg; return `${Math.round(Math.abs(v) * 10) === 0 ? "" : v > 0 ? "+" : MINUS}${fmt(Math.abs(v))} ${unit}`; };
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface Day { day: string; weightKg: number | null; bodyFatPercent: number | null; muscleKg: number | null; bmi: number | null; totalKcal: number | null; activeKcal: number | null; bmrKcal: number | null }
interface Weight {
  today: string; date: string; goalKg: number | null;
  body: { weighIns: number; perWeekKg: number | null; changeKg: number | null; direction: string | null; first: { day: string } | null; latest: { day: string; kg: number } | null };
  intake: { loggedDays: number; days: number; eatenKcal: number | null; burnedKcal: number | null };
  days: Day[];
  sync: { days: number };
}
async function oracle(admin: APIRequestContext, query = ""): Promise<Weight> {
  const res = await admin.get(`/api/weight?profile=alice${query ? `&${query}` : ""}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as Weight;
}

/** alice's GET /api/weight as the page gets it, after `edit` has changed it. Call before the page is opened. */
async function stub(page: Page, edit: (json: any) => void): Promise<void> {
  await page.route(/\/api\/weight\?/, async (route) => {
    const response = await route.fetch(), json = await response.json();
    json.goalKg = null; // the goal the one test that sets one for real has on alice is not part of the states made here
    edit(json);
    await route.fulfill({ response, json });
  });
}
/** The weigh-ins of the answer, replaced: `kg(n)` is the weight of the n-th weigh-in (oldest first), `fat(n)` its body fat. */
function weighIns(json: any, kg: (n: number) => number, fat: ((n: number) => number | null) | null = null): void {
  let n = 0;
  for (const d of json.days as Day[]) {
    if (d.weightKg === null) continue;
    d.weightKg = kg(n); d.bodyFatPercent = fat ? fat(n) : null; d.muscleKg = fat ? 36 : null; d.bmi = fat ? 24 : null;
    n++;
  }
  json.body.weighIns = n;
}

const hero = (page: Page) => page.locator("#bbody .bhero");
const tab = (page: Page, name: "Weight" | "Body" | "Data") => page.locator("#bTabs").getByRole("button", { name, exact: true });
const chip = (page: Page, day: string) => page.locator(`#bstrip button.fwd[data-day="${day}"]`);
const unitButton = (page: Page, unit: "lb" | "kg") => page.locator(`#bUnits button[data-unit=${unit}]`);
const chartOf = (page: Page, id: string) => page.locator(`#bbody .rc[data-chart="${id}"]`);

async function openWeight(page: Page): Promise<void> {
  await openView(page, "weight");
  await expect(hero(page)).toBeVisible();
}

test.describe.configure({ timeout: 60_000 });

test.describe("the parts and the week", () => {
  test("has the Weight, the Body (alice's scale measured her body fat) and the Data, the Weight first", async ({ alice }) => {
    await openWeight(alice);
    await expect(alice.locator("#bTabs button:visible")).toHaveText(["Weight", "Body", "Data"]);
    await expect(tab(alice, "Weight")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#bbody .bchart")).toBeVisible();
    await tab(alice, "Body").click();
    await expect(tab(alice, "Body")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#bbody .bhero")).toHaveCount(0);
    await expect(alice.locator("#bbody .btile")).toHaveCount(3);
    await tab(alice, "Data").click();
    await expect(alice.locator("#bbody table.rmetrics")).toBeVisible();
    await tab(alice, "Weight").click();
    await expect(hero(alice)).toBeVisible();
  });

  test("has no Body part when no day has a body fat, and says nothing about it", async ({ alice }) => {
    await stub(alice, (json) => weighIns(json, (n) => 82 - n * 0.1));
    await openWeight(alice);
    await expect(alice.locator("#bTabs button:visible")).toHaveText(["Weight", "Data"]);
    await expect(tab(alice, "Body")).toBeHidden();
    await expect(alice.locator("#bbody .bsnap")).toHaveCount(0); // nor its three lines in the Weight part
    await expect(alice.locator("#bbody .bweeks")).toBeVisible();
  });

  test("shows the seven days of the week of the day shown, Monday first, each with its weigh-in", async ({ alice, admin }) => {
    const data = await oracle(admin), monday = mondayOf(today());
    await openWeight(alice);
    await expect(alice.locator("#bstrip button.fwd")).toHaveCount(7);
    expect(await alice.locator("#bstrip button.fwd").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.day))).toEqual(Array.from({ length: 7 }, (_, i) => addDays(monday, i)));
    const byDay = new Map(data.days.map((d) => [d.day, d]));
    for (let i = 0; i < 7; i++) {
      const day = addDays(monday, i), d = byDay.get(day), future = day > today();
      await expect(chip(alice, day)).toHaveClass(future ? /bd-future/ : d && d.weightKg !== null ? /bd-weighed/ : /bd-none/);
      await expect(chip(alice, day).locator(".fwk")).toHaveText(d && d.weightKg !== null && !future ? fmt(d.weightKg * LB_PER_KG) : "–");
      if (future) await expect(chip(alice, day)).toBeDisabled();
    }
    await expect(chip(alice, today())).toHaveAttribute("aria-current", "date"); // alice is weighed today
    await expect(alice.locator("#bstrip [aria-current]")).toHaveCount(1);
    await expect(chip(alice, today())).toHaveClass(/\btoday\b/);
  });

  test("says each day in words for a screen reader: the weigh-in and how far it sat from the line, or that there is none, or that it is not yet", async ({ alice, admin }) => {
    const data = await oracle(admin), weighed = data.days.find((d) => d.day === today())!;
    await openWeight(alice);
    await expect(chip(alice, today())).toHaveAttribute("aria-label", new RegExp(`^${label(today())}, ${fmt(weighed.weightKg! * LB_PER_KG)} lb, [+${MINUS}]?\\d\\.\\d lb from the line$`));
    const none = data.days.find((d) => d.day >= mondayOf(today()) && d.day <= today() && d.weightKg === null);
    if (none) await expect(chip(alice, none.day)).toHaveAttribute("aria-label", `${label(none.day)}, no weigh-in`);
    const ahead = addDays(today(), 1);
    if (ahead <= addDays(mondayOf(today()), 6)) await expect(chip(alice, ahead)).toHaveAttribute("aria-label", `${label(ahead)}, not yet`);
  });

  test("a tap on a day picks it: the chart reads it out and the Weight part stays", async ({ alice }) => {
    await openWeight(alice);
    const earlier = [3, 6, 9].map((n) => daysAgo(n)).find((day) => day >= mondayOf(today()));
    test.skip(!earlier, "today is the first day of the week: there is no earlier day in it with a weigh-in");
    await chip(alice, earlier!).click();
    await expect(chip(alice, earlier!)).toHaveAttribute("aria-current", "date");
    await expect(alice.locator("#bbody .rc .rcr")).toContainText(label(earlier!));
    await expect(tab(alice, "Weight")).toHaveAttribute("aria-pressed", "true");
  });

  test("the arrows step a day and the week follows them across a Monday; ▶ is out of reach on today", async ({ alice }) => {
    await openWeight(alice);
    await expect(alice.locator("#bNext")).toBeDisabled();
    const monday = mondayOf(today());
    for (let day = today(); day > monday; day = addDays(day, -1)) await alice.locator("#bPrev").click();
    await expect(chip(alice, monday)).toHaveAttribute("aria-current", "date");
    await alice.locator("#bPrev").click();
    await expect(chip(alice, addDays(monday, -1))).toHaveAttribute("aria-current", "date");
    await expect(alice.locator("#bstrip button.fwd").first()).toHaveAttribute("data-day", mondayOf(addDays(monday, -1)));
    await expect(alice.locator("#bNext")).toBeEnabled();
  });

  test("▶ is out of reach on today and ◀ on the first day of the range", async ({ alice }) => {
    await stub(alice, (json) => { json.date = addDays(json.today, -13); });
    await alice.goto("/#weight");
    await expect(hero(alice)).toBeVisible();
    await alice.locator("#bRange").selectOption("14");
    await expect(alice.locator("#bPrev")).toBeDisabled();
    await expect(alice.locator("#bNext")).toBeEnabled();
  });
});

test.describe("where the weight is going", () => {
  test("says gaining, the rate a week, the change over the days and the three figures, from the numbers of the server", async ({ alice, admin }) => {
    const { body } = await oracle(admin), last = (await oracle(admin)).days.filter((d) => d.weightKg !== null).pop()!;
    expect(body.direction).toBe("gaining");
    await openWeight(alice);
    await expect(hero(alice).locator("h2")).toContainText("Gaining");
    await expect(hero(alice).locator(".brate")).toHaveText(`${changeIn(body.perWeekKg!)} / week`);
    const span = Math.round((Date.parse(body.latest!.day) - Date.parse(body.first!.day)) / 86_400_000);
    await expect(hero(alice).locator(".bsum")).toContainText(`${changeIn(body.changeKg!)} over the ${span} days between your first and last weigh-in`);
    await expect(hero(alice).locator(".bsum")).toContainText(`A straight line fitted through ${body.weighIns} weigh-ins.`);
    const tiles = hero(alice).locator(".bkv > div");
    await expect(tiles.nth(0)).toContainText(`${weightIn(last.weightKg!)}`);
    await expect(tiles.nth(0)).toContainText(label(body.latest!.day));
    await expect(tiles.nth(1).locator("small")).toHaveText("From your line");
    await expect(tiles.nth(2)).toContainText(String(body.weighIns));
    await expect(tiles.nth(2)).toContainText("of 60 days");
  });

  test("says where the line will be in four weeks", async ({ alice }) => {
    await openWeight(alice);
    await expect(hero(alice).locator(".bnote").first()).toHaveText(/^If the line holds: about \d{3}\.\d lb in four weeks\.$/);
  });

  test("says losing for a falling line and steady for a flat one, without a projection for the flat one", async ({ alice }) => {
    await stub(alice, (json) => weighIns(json, (n) => 82 - n * 0.3));
    await openWeight(alice);
    await expect(hero(alice).locator("h2")).toContainText("Losing");
    await expect(hero(alice).locator(".brate")).toHaveText(/^−\d\.\d lb \/ week$/);
    await expect(hero(alice).locator(".bglyph svg path")).toHaveAttribute("d", /^M5 7l14 10/);
  });

  test("says steady for a flat line, and no projection", async ({ alice }) => {
    await stub(alice, (json) => weighIns(json, (n) => 80 + (n % 2 ? 0.01 : -0.01)));
    await openWeight(alice);
    await expect(hero(alice).locator("h2")).toContainText("Steady");
    await expect(hero(alice).locator(".brate")).toHaveText("steady");
    await expect(hero(alice).locator(".bsum")).toContainText("No change beyond the day-to-day swing");
    await expect(hero(alice).locator(".bnote")).toHaveCount(0);
  });

  test("says too early with fewer than three weigh-ins, and what a trend needs", async ({ alice }) => {
    await stub(alice, (json) => {
      let kept = 0;
      for (const d of json.days as Day[]) { if (d.weightKg !== null && ++kept > 2) { d.weightKg = d.bodyFatPercent = d.muscleKg = d.bmi = null; } }
      json.body.weighIns = 2;
    });
    await openWeight(alice);
    await expect(hero(alice).locator("h2")).toContainText("Too early");
    await expect(hero(alice).locator(".brate")).toHaveText("needs 3 weigh-ins over a week or more");
    await expect(hero(alice).locator(".bsum")).toHaveText("2 weigh-ins so far. A trend needs 3, spread over at least a week.");
    await expect(hero(alice).locator(".bkv > div").nth(1)).toContainText("no line yet");
    await expect(alice.locator("#bbody .rc-ref")).toHaveCount(0); // no line is drawn for what is not a trend
    await expect(alice.locator("#bbody .rc-band")).toHaveCount(0);
  });

  test("with a goal the line moves toward, says so and how long it takes; the goal is drawn and named in the chart", async ({ alice }) => {
    await stub(alice, (json) => { weighIns(json, (n) => 85 - n * 0.3); json.goalKg = 70; });
    await openWeight(alice);
    await expect(hero(alice).locator(".bchip")).toHaveText("Toward the goal");
    await expect(hero(alice).locator(".bgoal .bnote")).toContainText(`Goal ${weightIn(70)}`);
    await expect(hero(alice).locator(".bgoal .bnote")).toContainText(/At this rate, 154\.3 lb is about \d+ weeks away\./);
    await expect(alice.locator("#bbody .rc-goal")).toHaveCount(1);
    await expect(alice.locator("#bbody .rcl")).toContainText(`goal ${weightIn(70)}`);
  });

  test("with a goal the line moves from, says away, and puts no time to it; at the goal it says that", async ({ alice }) => {
    await stub(alice, (json) => { weighIns(json, (n) => 70 + n * 0.3); json.goalKg = 60; });
    await openWeight(alice);
    await expect(hero(alice).locator(".bchip")).toHaveText("Away from the goal");
    await expect(hero(alice).locator(".bgoal .bnote")).toContainText("and moving away from it.");
    await expect(hero(alice).locator(".bgoal .bnote")).not.toContainText("weeks away");
  });

  test("with a goal and a flat line it says steady and no chip", async ({ alice }) => {
    await stub(alice, (json) => { weighIns(json, () => 80); json.goalKg = 75; });
    await openWeight(alice);
    await expect(hero(alice).locator(".bchip")).toHaveCount(0);
    await expect(hero(alice).locator(".bgoal .bnote")).toContainText(`The line is ${weightIn(5)} above your goal`);
    await expect(hero(alice).locator(".bgoal .bnote")).toContainText("and steady.");
  });

  test("without a goal, offers to set one and draws none", async ({ alice }) => {
    await stub(alice, () => undefined);
    await openWeight(alice);
    await expect(hero(alice).getByRole("button", { name: "Set a goal weight" })).toBeVisible();
    await expect(hero(alice).locator(".bchip")).toHaveCount(0);
    await expect(alice.locator("#bbody .rc-goal")).toHaveCount(0);
  });
});

test.describe("the goal, typed in the unit", () => {
  test.describe.configure({ mode: "serial" }); // both set a goal on alice, and take it off again
  test("is set on the Weight tab in pounds, kept in kilograms, changed and removed", async ({ alice, admin }) => {
    test.setTimeout(90_000);
    const set = async (kg: number | null) => expect((await admin.post("/api/settings/goals", { data: { profile: "alice", action: "save", goals: { weightKg: kg } } })).ok()).toBeTruthy();
    try {
      await openWeight(alice);
      await hero(alice).getByRole("button", { name: "Set a goal weight" }).click();
      const box = alice.getByRole("textbox", { name: "Goal weight (lb)" });
      await expect(box).toBeFocused();
      await box.fill("176,4");
      await hero(alice).getByRole("button", { name: "Save goal" }).click();
      await expect(hero(alice).locator(".bgoal .bnote")).toContainText("Goal 176.4 lb");
      expect((await oracle(admin)).goalKg).toBeCloseTo(176.4 / LB_PER_KG, 1);
      await expect(alice.locator("#bbody .rc-goal")).toHaveCount(1);

      await unitButton(alice, "kg").click(); // the same goal in the other unit
      await expect(hero(alice).locator(".bgoal .bnote")).toContainText(/Goal 80\.0 kg/);
      await hero(alice).getByRole("button", { name: "Change" }).click();
      const kgBox = alice.getByRole("textbox", { name: "Goal weight (kg)" });
      await expect(kgBox).toHaveValue("80");
      await kgBox.fill("75.5");
      await hero(alice).getByRole("button", { name: "Save goal" }).click();
      await expect(hero(alice).locator(".bgoal .bnote")).toContainText("Goal 75.5 kg");
      expect((await oracle(admin)).goalKg).toBe(75.5);

      await hero(alice).getByRole("button", { name: "Change" }).click();
      await hero(alice).getByRole("button", { name: "Cancel" }).click();
      await expect(hero(alice).locator(".bgoal .bnote")).toContainText("Goal 75.5 kg");

      await hero(alice).getByRole("button", { name: "Remove" }).click();
      await expect(hero(alice).getByRole("button", { name: "Set a goal weight" })).toBeVisible();
      expect((await oracle(admin)).goalKg).toBeNull();
    } finally {
      await set(null);
      await alice.evaluate(() => localStorage.removeItem("weightUnit"));
    }
  });

  test("says what is wrong with a goal that is not a number or is out of range, and keeps what it had", async ({ alice, admin }) => {
    await openWeight(alice);
    await hero(alice).getByRole("button", { name: "Set a goal weight" }).click();
    const box = alice.getByRole("textbox", { name: "Goal weight (lb)" });
    await box.fill("heavy");
    await hero(alice).getByRole("button", { name: "Save goal" }).click();
    await expect(alice.locator("#toast")).toContainText("Type the goal weight as a number of pounds.");
    await box.fill("5");
    await hero(alice).getByRole("button", { name: "Save goal" }).click();
    await expect(alice.locator("#toast")).toContainText("must be a number of kilograms from 20 to 400");
    expect((await oracle(admin)).goalKg).toBeNull();
    await hero(alice).getByRole("button", { name: "Cancel" }).click();
    await expect(hero(alice).getByRole("button", { name: "Set a goal weight" })).toBeVisible();
  });
});

test.describe("the chart, the weeks and the calories", () => {
  test("draws a dot for each weigh-in, the line through them with the usual swing around it, and names them", async ({ alice, admin }) => {
    const { body } = await oracle(admin);
    await openWeight(alice);
    const c = chartOf(alice, "weight");
    await expect(c.locator(".rch b")).toHaveText("Weigh-ins and trend (lb)");
    await expect(c.locator("circle.rc-dot")).toHaveCount(body.weighIns);
    await expect(c.locator("circle.rc-dot.sel")).toHaveCount(1); // the day picked, drawn larger
    await expect(c.locator("path.rc-line")).toHaveCount(0); // the weigh-ins are not joined
    await expect(c.locator("path.rc-ref")).toHaveCount(1);
    await expect(c.locator("path.rc-band")).toHaveCount(1);
    await expect(c.locator(".rcl")).toContainText("weigh-in");
    await expect(c.locator(".rcl")).toContainText("trend line");
    await expect(c.locator(".rcl")).toContainText(/usual day-to-day swing \(±\d\.\d lb\)/);
    await expect(c.locator(".bnote")).toContainText("Read the line, not the day.");
    await expect(c.locator(".rcr")).toContainText(`${label(today())}: ${fmt((await oracle(admin)).days.find((d) => d.day === today())!.weightKg! * LB_PER_KG)} lb`);
  });

  test("the chart is drawn in the unit, and a click on it picks a day", async ({ alice }) => {
    await openWeight(alice);
    await unitButton(alice, "kg").click();
    await expect(chartOf(alice, "weight").locator(".rch b")).toHaveText("Weigh-ins and trend (kg)");
    const over = chartOf(alice, "weight").locator(".rc-over"), box = (await over.boundingBox())!;
    await over.click({ position: { x: box.width * 0.9, y: box.height / 2 } });
    await expect(alice.locator("#bstrip [aria-current]")).toHaveCount(1);
    await expect(chip(alice, today())).not.toHaveAttribute("aria-current", "date");
    await alice.evaluate(() => localStorage.removeItem("weightUnit"));
  });

  test("lists the weeks, the newest first, with the average weigh-in, how many there were, and the change from the week before", async ({ alice, admin }) => {
    const { days } = await oracle(admin), rows = alice.locator("#bbody .bwk");
    await openWeight(alice);
    await expect(rows).toHaveCount(8);
    const monday = mondayOf(today()), inWeek = (m: string) => days.filter((d) => d.weightKg !== null && d.day >= m && d.day <= addDays(m, 6)).map((d) => d.weightKg!);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    await expect(rows.first().locator(".lab")).toContainText(`${short(monday)} – ${short(addDays(monday, 6))}`);
    await expect(rows.first().locator(".lab small")).toHaveText(`this week, so far · ${inWeek(monday).length} weigh-in${inWeek(monday).length === 1 ? "" : "s"}`);
    await expect(rows.first().locator(".avg")).toHaveText(weightIn(mean(inWeek(monday))));
    const before = addDays(monday, -7);
    await expect(rows.first().locator(".ch")).toHaveText(changeIn(mean(inWeek(monday)) - mean(inWeek(before))));
    await expect(rows.nth(1).locator(".lab small")).toHaveText(`${inWeek(before).length} weigh-ins`);
    await expect(rows.first().locator(".dl i")).toHaveCount(1);
  });

  test("says what Garmin counted as burned a day, split into rest and active, with the last 14 full days as bars", async ({ alice, admin }) => {
    const { days, today: now } = await oracle(admin), done = days.filter((d) => d.day < now && d.totalKcal !== null);
    const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    await openWeight(alice);
    const card = alice.locator("#bbody .bburn");
    await expect(card.locator(".bbig b")).toHaveText(mean(done.map((d) => d.totalKcal!)).toLocaleString());
    await expect(card.locator(".blegend")).toContainText(`Active ${mean(done.map((d) => d.activeKcal!)).toLocaleString()}`);
    await expect(card.locator(".bmini span")).toHaveCount(14);
    await expect(card.locator(".bfoot")).toHaveText(`${done.length} full days · Garmin's estimate from the watch · the last 14 days above`);
  });

  test("sets the Food log's calories against the burn, with the rate by the numbers against the scale's, and says a gap is probably food not logged", async ({ alice, admin }) => {
    const { intake, body } = await oracle(admin);
    expect(intake.days).toBe(5);
    await openWeight(alice);
    const card = alice.locator("#bbody .bintake");
    await expect(card.locator(".bpair b")).toHaveText([intake.eatenKcal!.toLocaleString(), intake.burnedKcal!.toLocaleString()]);
    const rate = changeIn(((intake.eatenKcal! - intake.burnedKcal!) * 7) / 7700);
    await expect(card.locator("p")).toContainText(`On the 5 days with food logged, that is ${rate} a week by the numbers, against ${changeIn(body.perWeekKg!)} on the scale.`);
    await expect(card.locator("p")).toContainText("A day without a log counts as unknown, not zero, so a gap usually means food that was not logged.");
  });

  test("has no eaten-against-burned card when no day has food and a burn", async ({ alice }) => {
    await stub(alice, (json) => { json.intake = { loggedDays: 0, days: 0, eatenKcal: null, burnedKcal: null }; });
    await openWeight(alice);
    await expect(alice.locator("#bbody .bburn")).toBeVisible();
    await expect(alice.locator("#bbody .bintake")).toHaveCount(0);
  });
});

test.describe("what the scale measured", () => {
  test("the Weight part has the last body fat, muscle and BMI with a small picture of each, and a way to the Body part", async ({ alice }) => {
    await openWeight(alice);
    const rows = alice.locator("#bbody .bsrow");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator(".nm")).toContainText("Body fat");
    await expect(rows.nth(0).locator(".v")).toContainText(" %");
    await expect(rows.nth(1).locator(".nm")).toContainText("Muscle");
    await expect(rows.nth(2).locator(".nm")).toContainText("BMI");
    await expect(rows.locator("svg polyline")).toHaveCount(3);
    await alice.locator("#bbody .bsnap").getByRole("button", { name: "See body ›" }).click();
    await expect(tab(alice, "Body")).toHaveAttribute("aria-pressed", "true");
  });

  test("the Body part splits a loss into fat and lean mass and says what part of it was fat; with a gain it says no part", async ({ alice }) => {
    await stub(alice, (json) => weighIns(json, (n) => 82 - n * 0.2, () => 20));
    await openWeight(alice);
    await tab(alice, "Body").click();
    const came = alice.locator("#bbody .bcame");
    await expect(came.locator(".bcb .l")).toHaveText(["Fat massweight × body fat", "Lean massthe rest", "Weightfat + lean"]);
    await expect(came.locator(".bnote b")).toHaveText("About 20 % of the loss was fat.");
    await expect(came.locator(".bcb .v").nth(2)).toHaveText(/^−\d+\.\d lb$/);
    await expect(came.locator(".bnote")).toContainText("Scale body fat is an estimate");
  });

  test("a gain has no share of fat in its note, and the three pictures are drawn", async ({ alice }) => {
    await openWeight(alice);
    await tab(alice, "Body").click();
    await expect(alice.locator("#bbody .bcame .bnote b")).toHaveCount(0);
    await expect(alice.locator("#bbody .rc[data-chart]")).toHaveCount(3);
    await expect(chartOf(alice, "compare").locator(".rch b")).toHaveText("Fat mass and lean mass, change since the first weigh-in (lb)");
    await expect(chartOf(alice, "compare").locator("circle.rc-dot2").first()).toBeVisible();
    await expect(chartOf(alice, "compare").locator("path.rc-ref")).toHaveCount(2);
    await expect(chartOf(alice, "compare").locator(".rcl")).toContainText("lean mass");
    await expect(chartOf(alice, "fat").locator(".rch b")).toHaveText("Body fat (%)");
    await expect(chartOf(alice, "muscle").locator(".rch b")).toHaveText("Muscle mass (lb)");
  });
});

test.describe("the Data part", () => {
  test("has the table of every stored number, open, and Garmin's responses for the day, shut", async ({ alice }) => {
    await openWeight(alice);
    await tab(alice, "Data").click();
    const [every, raw] = [alice.locator("#bbody details.racc").nth(0), alice.locator("#bbody details.racc").nth(1)];
    await expect(every).toHaveAttribute("open", "");
    await expect(every.locator(":scope > summary b")).toHaveText("Every stored number");
    await expect(every.locator(":scope > summary span")).toHaveText("45 days");
    await expect(alice.locator("#bbody table.rmetrics tbody tr")).toHaveCount(45);
    await expect(raw).not.toHaveAttribute("open", "");
    await expect(raw.locator(":scope > summary b")).toHaveText(`Garmin's responses for ${label(today())}`);
  });

  test("a row picks the day and stays in the Data, where its responses are", async ({ alice }) => {
    await openWeight(alice);
    await tab(alice, "Data").click();
    await alice.locator("#bbody table.rmetrics tbody tr", { has: alice.locator(`td.day:text-is("${label(daysAgo(3))}")`) }).click();
    await expect(tab(alice, "Data")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#bbody details.racc").nth(1).locator(":scope > summary b")).toHaveText(`Garmin's responses for ${label(daysAgo(3))}`);
    await expect(alice.locator("#bbody tr.sel td.day")).toHaveText(label(daysAgo(3)));
  });
});

test.describe("when there is nothing to draw", () => {
  test("with nothing stored says so, and where to get it, with the way to Settings", async ({ alice }) => {
    await stub(alice, (json) => { json.days = []; json.sync = { days: 0, oldest: null, newest: null, pending: 0, syncing: false }; json.body = { weighIns: 0, latest: null, first: null, perWeekKg: null, changeKg: null, direction: null }; });
    await alice.goto("/#weight");
    const card = alice.locator("#bbody .bempty");
    await expect(card.locator("h2")).toHaveText("No weigh-ins are stored yet");
    await expect(card.locator("p")).toHaveText("Connect a Renpho scale or Garmin in Settings to get them.");
    await expect(alice.locator("#bTabs")).toBeHidden();
    await expect(alice.locator("#bweek")).toBeHidden();
    await expect(alice.locator("#brangebar")).toBeHidden();
    await card.getByRole("button", { name: "Open Settings" }).click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "settings");
  });

  test("with days but no weigh-in among them says so, keeps the range to look further back, and shows no tabs or week", async ({ alice }) => {
    await stub(alice, (json) => { for (const d of json.days as Day[]) d.weightKg = d.bodyFatPercent = d.muscleKg = d.bmi = null; json.body = { weighIns: 0, latest: null, first: null, perWeekKg: null, changeKg: null, direction: null }; });
    await alice.goto("/#weight");
    const card = alice.locator("#bbody .bempty");
    await expect(card.locator("h2")).toHaveText("No weigh-in in these days");
    await expect(card.locator("p")).toContainText("Nothing was weighed in these days.");
    await expect(alice.locator("#bTabs")).toBeHidden();
    await expect(alice.locator("#bweek")).toBeHidden();
    await expect(alice.locator("#bRange")).toBeVisible();
    await expect(alice.locator("#bUnits")).toBeVisible();
  });
});

test.describe("the Settings form takes the weight goal in the unit", () => {
  test("is typed in pounds, kept in kilograms, shown in kilograms when the view is in them, and left alone when the form is saved without it", async ({ me, profile }) => {
    test.setTimeout(90_000);
    const goals = async () => ((await (await profile.api.get("/api/settings")).json()) as any).goals;
    await openView(me, "settings");
    const field = me.getByLabel("Weight goal (lb)");
    await expect(field).toHaveAttribute("placeholder", "no goal");
    await field.fill("176.4");
    await me.getByRole("button", { name: "Save goals" }).click();
    await expect(me.getByText("Goals saved.")).toBeVisible();
    const kg = (await goals()).values.weightKg;
    expect(kg).toBeCloseTo(176.4 / LB_PER_KG, 1);
    await expect(me.getByLabel("Weight goal (lb)")).toHaveValue("176.4");
    expect((await goals()).fields.at(-1)).toMatchObject({ key: "weightKg", unit: "kg", kind: "weight" });

    await me.getByLabel("Calories (kcal)").fill("2100"); // a save with the weight not touched does not move it through the unit
    await me.getByRole("button", { name: "Save goals" }).click();
    await expect(me.getByText("Goals saved.")).toBeVisible();
    expect((await goals()).values).toEqual({ kcal: 2100, weightKg: kg });

    await me.evaluate(() => localStorage.setItem("weightUnit", "kg"));
    await me.reload({ waitUntil: "domcontentloaded" });
    await expect(me.getByLabel("Weight goal (kg)")).toHaveValue(String(Math.round(kg * 10) / 10));
    await me.getByLabel("Weight goal (kg)").fill("");
    await me.getByRole("button", { name: "Save goals" }).click();
    await expect(me.getByText("Goals saved.")).toBeVisible();
    expect((await goals()).values).toEqual({ kcal: 2100 });
    await me.evaluate(() => localStorage.removeItem("weightUnit"));
  });

  test("says what is wrong with a weight goal out of range, and the count of goals is of the food goals", async ({ me, profile }) => {
    await profile.api.post("/api/settings/goals", { data: { action: "save", goals: { weightKg: 70 } } });
    await openView(me, "settings");
    await expect(me.locator(".scard", { has: me.getByRole("heading", { name: "Nutrition goals" }) }).locator(".chip").first()).toHaveText("none set"); // the weight to aim for is not a goal of the day
    await me.getByLabel("Weight goal (lb)").fill("4");
    await me.getByRole("button", { name: "Save goals" }).click();
    await expect(me.getByText(/must be a number of kilograms from 20 to 400/)).toBeVisible();
    await me.getByRole("button", { name: "Clear all goals" }).click();
    expect(((await (await profile.api.get("/api/settings")).json()) as any).goals.values).toEqual({});
  });

  test("a weight goal alone does not make the Food view stop asking for daily goals", async ({ me, profile }) => {
    await profile.api.post("/api/settings/goals", { data: { action: "save", goals: { weightKg: 70 } } });
    await openView(me, "food");
    await expect(me.locator("#fbody .fgoalhint")).toContainText("Set daily goals to follow your progress through the day.");
  });
});

test.describe("the look, in both themes", () => {
  test("the verdict, the figures, the chip and the strip keep their contrast: 4.5 to 1 for each text against its card", async ({ alice }) => {
    await stub(alice, (json) => { weighIns(json, (n) => 85 - n * 0.3); json.goalKg = 70; });
    await openWeight(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await alice.locator("#bTheme").click();
      await expect(alice.locator("body")).toHaveAttribute("data-theme", theme);
      await alice.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null)))); // the colours have settled
      const low = await alice.evaluate(() => {
        // any CSS colour as red, green, blue and alpha, as the page's own canvas reads it (a mix of colours comes as color(srgb ...))
        const px = (css: string): number[] => { const c = document.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d")!; g.fillStyle = css; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
        const lum = ([r, g, b]: number[]) => { const [x, y, z] = [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * x + 0.7152 * y + 0.0722 * z; };
        /** What the text sits on: the backgrounds from the page down to it, each blended over the one under it. */
        const bgOf = (el: Element): number[] => {
          const chain: number[][] = [];
          for (let p: Element | null = el; p; p = p.parentElement) chain.push(px(getComputedStyle(p).backgroundColor));
          let [r, g, b] = [0, 0, 0];
          for (const [cr, cg, cb, a] of chain.reverse()) { r = cr * a + r * (1 - a); g = cg * a + g * (1 - a); b = cb * a + b * (1 - a); }
          return [r, g, b];
        };
        const out: string[] = [];
        for (const sel of ["#bbody .bhero h2", "#bbody .bchip", "#bbody .brate", "#bbody .bsum", "#bbody .bkv small", "#bbody .bkv span", "#bbody .bnote", "#bstrip .fwd small", "#bstrip .fwk", "#bstrip .bdv", "#bbody .bburn .bbig b", "#bbody .bwk .lab small", "#bbody .bwk .avg", "#bTabs button", "#bUnits button", "#bbody .rch b", "#bbody .rcr", "#bbody .rcl"]) {
          for (const el of document.querySelectorAll(sel)) {
            const [a, b] = [lum(px(getComputedStyle(el).color)), lum(bgOf(el))];
            const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            if (ratio < 4.5) out.push(`${sel} ${getComputedStyle(el).color} on ${bgOf(el).map(Math.round)}: ${ratio.toFixed(2)}`);
          }
        }
        return out;
      });
      expect(low, `${theme}: text under 4.5 to 1`).toEqual([]);
    }
  });

  test("the controls of the bar, the week and the range are at least 44 px", async ({ alice }) => {
    await openWeight(alice);
    for (const sel of ["#bTabs button", "#bUnits button", "#bRange", "#bTheme", "#bPrev", "#bNext", "#bstrip button.fwd", "#bbody .bhero .blink"]) {
      for (const [w, h] of await alice.locator(sel).evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]))) {
        expect(h, `${sel} height`).toBeGreaterThanOrEqual(44);
        expect(w, `${sel} width`).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test("the button in the bar switches between dark and light, one choice shared with the other views", async ({ alice }) => {
    await openWeight(alice);
    const body = alice.locator("body");
    await expect(body).toHaveAttribute("data-theme", "dark");
    await alice.locator("#bTheme").click();
    await expect(body).toHaveAttribute("data-theme", "light");
    await expect(alice.locator("#bTheme")).toHaveAttribute("aria-label", "Switch to dark theme");
    expect(await alice.locator("#bscroll").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgb(7, 5, 4)");
    await alice.reload({ waitUntil: "domcontentloaded" });
    await expect(hero(alice)).toBeVisible();
    await expect(body).toHaveAttribute("data-theme", "light");
    await alice.locator("#bTheme").click();
    await expect(body).toHaveAttribute("data-theme", "dark");
  });

  test("the charts are drawn for the room they get: the weight chart takes the width of the page on a wide screen", async ({ alice }) => {
    await alice.setViewportSize({ width: 1360, height: 900 });
    await openWeight(alice);
    const wide = await chartOf(alice, "weight").locator("svg.rcsvg").evaluate((svg) => (svg as SVGSVGElement).viewBox.baseVal.width);
    await alice.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(() => chartOf(alice, "weight").locator("svg.rcsvg").evaluate((svg) => (svg as SVGSVGElement).viewBox.baseVal.width)).toBeLessThan(wide);
  });

  test("no NaN, undefined or null on any part, in either unit", async ({ alice }) => {
    await openWeight(alice);
    for (const unit of ["lb", "kg"] as const) {
      await unitButton(alice, unit).click();
      for (const name of ["Weight", "Body", "Data"] as const) {
        await tab(alice, name).click();
        await expect(tab(alice, name)).toHaveAttribute("aria-pressed", "true");
        const text = (await alice.locator("#bbody").textContent()) ?? "", svg = await alice.locator("#bbody svg").evaluateAll((els) => els.map((e) => e.outerHTML).join(""));
        expect(text, `${unit} ${name}`).not.toMatch(/NaN|undefined|null|Infinity/);
        expect(svg, `${unit} ${name}`).not.toMatch(/NaN|undefined|Infinity/);
      }
    }
    await alice.evaluate(() => localStorage.removeItem("weightUnit"));
  });
});

test.describe("as the admin", () => {
  test("a profile with no weigh-ins gets the empty state with no Sync, and the picker goes back to alice's week", async ({ page, profile }) => {
    await loginAs(page, "admin", ADMIN_TOKEN);
    await page.goto("/#weight");
    await expect(hero(page)).toBeVisible();
    await page.locator("#bProfile").selectOption(profile.name);
    await expect(page.locator("#bbody .bempty h2")).toHaveText("No weigh-ins are stored yet");
    await expect(page.locator("#bSync")).toBeHidden();
    await expect(page.locator("#bTabs")).toBeHidden();
    await page.locator("#bProfile").selectOption("alice");
    await expect(hero(page)).toBeVisible();
    await expect(page.locator("#bstrip button.fwd")).toHaveCount(7);
  });
});

test("bob, who has nothing, has no Weight view", async ({ page }) => {
  await loginAs(page, "bob", PASSWORD);
  await page.goto("/#weight");
  await expect(page.locator("body")).toHaveAttribute("data-view", "today");
});
