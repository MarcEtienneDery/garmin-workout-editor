/**
 * The Weight view: the last weigh-in, the trend, the count of weigh-ins and the calories burned, in pounds or kilograms (the
 * unit is remembered), the range, the charts, the table of every stored number, and Garmin's responses of the picked day. Reads
 * alice's data (read only) and checks the page against GET /api/weight (the oracle, read as admin). A fresh profile and the admin's
 * view of one cover the states alice does not have.
 */
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect, openView, loginAs, ADMIN_TOKEN } from "../support/fixtures";

// ── oracle: GET /api/weight as stored (weights in kilograms, the trend fitted through the weigh-ins) ──

interface BodyDay {
  day: string;
  weightKg: number | null;
  bodyFatPercent: number | null;
  muscleKg: number | null;
  bmi: number | null;
  totalKcal: number | null;
  activeKcal: number | null;
  bmrKcal: number | null;
}
interface Weight {
  today: string;
  date: string;
  body: {
    weighIns: number;
    latest: { day: string; kg: number; bodyFatPercent: number | null } | null;
    first: { day: string; kg: number } | null;
    perWeekKg: number | null;
    changeKg: number | null;
    direction: "gaining" | "losing" | "steady" | null;
  };
  days: BodyDay[];
  sync: { days: number; oldest: string | null; newest: string | null };
}

async function weight(admin: APIRequestContext, query = ""): Promise<Weight> {
  const res = await admin.get(`/api/weight?profile=alice${query ? `&${query}` : ""}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as Weight;
}

// ── how the page words things (the same rules, written out) ─────────────────────────────────────

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LB_PER_KG = 2.2046226218;
const MINUS = "−";
const label = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};
const short = (iso: string) => label(iso).slice(4);
const fmt = (v: number | null | undefined, digits = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-CA", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "–";
/** A weight in the unit, to one decimal: "180.8 lb". */
const weightIn = (kg: number | null | undefined, unit: "lb" | "kg") => (typeof kg === "number" ? `${fmt(unit === "lb" ? kg * LB_PER_KG : kg, 1)} ${unit}` : "–");
/** A change, signed, in the unit: "+0.6 lb", "−0.7 lb"; no sign when it rounds to nothing. */
const changeIn = (kg: number, unit: "lb" | "kg") => {
  const v = unit === "lb" ? kg * LB_PER_KG : kg;
  const rounds = Math.round(Math.abs(v) * 10) === 0;
  return `${rounds ? "" : v > 0 ? "+" : MINUS}${fmt(Math.abs(v), 1)} ${unit}`;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// ── the page ─────────────────────────────────────────────────────────────────────────────────────

const figure = (page: Page, name: string) => page.locator("#bbody .rfig", { has: page.locator("small", { hasText: name }) });
const chart = (page: Page, title: string) => page.locator("#bbody .rc", { has: page.locator("b", { hasText: title }) });
const table = (page: Page) => page.locator("#bbody table.rmetrics");
const rows = (page: Page) => table(page).locator("tbody tr");
const rowOf = (page: Page, day: string) => rows(page).filter({ has: page.locator(`td.day:text-is("${label(day)}")`) });
const unitButton = (page: Page, unit: "lb" | "kg") => page.locator(`#bUnits button[data-unit=${unit}]`);

/** A column's index by its header; "Weight" is the weigh-in's, "Active" the calories'. */
/** The table as text, read in one go: its field headers and each row's cells by its day label. */
async function readTable(page: Page): Promise<{ heads: string[]; rows: Map<string, string[]> }> {
  const read = await table(page).evaluate((t) => ({
    heads: [...(t.querySelectorAll("thead tr")[1]?.querySelectorAll("th") ?? [])].map((th) => th.textContent ?? ""),
    rows: [...t.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "")),
  }));
  return { heads: read.heads, rows: new Map(read.rows.map((cells) => [cells[0], cells])) };
}
/** One cell of a read table: the day's row, and the column by its header. */
function cellOf(t: { heads: string[]; rows: Map<string, string[]> }, day: string, header: string): string {
  const at = t.heads.indexOf(header);
  expect(at, `a column "${header}"`).toBeGreaterThan(0);
  const cells = t.rows.get(label(day));
  expect(cells, `a row for ${label(day)}`).toBeDefined();
  return cells![at] ?? "";
}

/** Points a fraction of the way across a chart: the plot area starts at 40 of 600 and ends at 592, so 0.075 is its first day, 0.98 its last. */
async function aim(c: Locator, fraction: number): Promise<{ x: number; y: number }> {
  const svg = c.locator("svg.rcsvg");
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width * fraction, y: box!.y + box!.height / 2 };
}
async function hover(page: Page, c: Locator, fraction: number) {
  const { x, y } = await aim(c, fraction);
  await page.mouse.move(x, y);
}
async function click(page: Page, c: Locator, fraction: number) {
  const { x, y } = await aim(c, fraction);
  await page.mouse.click(x, y);
}

const CHARTS_LB = ["Weight (lb)", "Body fat (%)", "Muscle mass (lb)", "Calories burned (kcal)"];

/** Opens the view and waits for its first answer to be drawn: the unit and range controls do nothing before it, as the person would find them. */
async function openWeight(page: Page) {
  await openView(page, "weight");
  await expect(figure(page, "Trend")).toBeVisible();
}

// ── alice: a weigh-in every third day, 45 days stored ─────────────────────────────────────────────

test.describe("Weight view, alice (45 days stored, a weigh-in every third day)", () => {
  test("the header button opens the view from Today", async ({ alice, admin }) => {
    const data = await weight(admin);
    await openView(alice, "today");
    await alice.locator("#vWeight").click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "weight");
    await expect(alice).toHaveURL(/#weight$/);
    await expect(alice.locator("#vWeight")).toHaveAttribute("aria-pressed", "true");
    await expect(figure(alice, "Last weigh-in")).toBeVisible();
    await expect(alice.locator("#bbody .rcr").first()).toContainText(label(data.body.latest!.day));
  });

  test("the address opens the view in pounds, the unit picked when nothing is remembered", async ({ alice, admin }) => {
    const data = await weight(admin);
    await openWeight(alice);
    await expect(unitButton(alice, "lb")).toHaveAttribute("aria-pressed", "true");
    await expect(unitButton(alice, "kg")).toHaveAttribute("aria-pressed", "false");
    await expect(figure(alice, "Last weigh-in").locator("b")).toHaveText(weightIn(data.body.latest!.kg, "lb"));
  });

  test("the last weigh-in tile shows the latest weight, its day and its body fat", async ({ alice, admin }) => {
    const { body } = await weight(admin);
    await openWeight(alice);
    const tile = figure(alice, "Last weigh-in");
    await expect(tile.locator("b")).toHaveText(weightIn(body.latest!.kg, "lb"));
    await expect(tile.locator("span")).toHaveText(`${short(body.latest!.day)} · ${fmt(body.latest!.bodyFatPercent, 1)} % fat`);
  });

  test("the trend tile says how fast the weight is moving, and the change over the days", async ({ alice, admin }) => {
    const { body } = await weight(admin);
    expect(body.direction).toBe("gaining");
    await openWeight(alice);
    const tile = figure(alice, "Trend");
    await expect(tile.locator("b")).toHaveText(`${changeIn(body.perWeekKg!, "lb")} / week`);
    await expect(tile.locator("span")).toHaveText(`gaining · ${changeIn(body.changeKg!, "lb")} from ${short(body.first!.day)} to ${short(body.latest!.day)}`);
  });

  test("the weigh-ins tile counts the weigh-ins of the days shown", async ({ alice, admin }) => {
    const { body, days } = await weight(admin);
    await openWeight(alice);
    await expect(figure(alice, "Weigh-ins").locator("b")).toHaveText(String(body.weighIns));
    await expect(figure(alice, "Weigh-ins").locator("span")).toHaveText(`in ${days.length} days`);
    expect(body.weighIns).toBe(days.filter((d) => d.weightKg !== null).length);
  });

  test("the burned-a-day tile averages the full days, which leaves today out", async ({ alice, admin }) => {
    const { today, days } = await weight(admin);
    const full = days.filter((d) => d.day < today && typeof d.totalKcal === "number");
    const active = full.map((d) => d.activeKcal).filter((v): v is number => typeof v === "number");
    await openWeight(alice);
    await expect(figure(alice, "Burned a day").locator("b")).toHaveText(`${fmt(mean(full.map((d) => d.totalKcal!)))} kcal`);
    await expect(figure(alice, "Burned a day").locator("span")).toHaveText(`${fmt(mean(active))} active · ${full.length} full days`);
  });

  test("the figures in kilograms are the same weights, to one decimal", async ({ alice, admin }) => {
    const { body } = await weight(admin);
    await openWeight(alice);
    await unitButton(alice, "kg").click();
    await expect(unitButton(alice, "kg")).toHaveAttribute("aria-pressed", "true");
    await expect(figure(alice, "Last weigh-in").locator("b")).toHaveText(weightIn(body.latest!.kg, "kg"));
    await expect(figure(alice, "Trend").locator("b")).toHaveText(`${changeIn(body.perWeekKg!, "kg")} / week`);
    await expect(figure(alice, "Trend").locator("span")).toHaveText(`gaining · ${changeIn(body.changeKg!, "kg")} from ${short(body.first!.day)} to ${short(body.latest!.day)}`);
    await expect(chart(alice, "Weight").locator("b")).toHaveText("Weight (kg)");
  });

  test("switching back to pounds converts the figures again", async ({ alice, admin }) => {
    const { body } = await weight(admin);
    await openWeight(alice);
    await unitButton(alice, "kg").click();
    await unitButton(alice, "lb").click();
    await expect(unitButton(alice, "lb")).toHaveAttribute("aria-pressed", "true");
    await expect(figure(alice, "Last weigh-in").locator("b")).toHaveText(weightIn(body.latest!.kg, "lb"));
    await expect(chart(alice, "Weight").locator("b")).toHaveText("Weight (lb)");
  });

  test("the chosen unit is kept across a reload", async ({ alice, admin }) => {
    const { body } = await weight(admin);
    await openWeight(alice);
    await unitButton(alice, "kg").click();
    await expect(alice.evaluate(() => localStorage.getItem("weightUnit"))).resolves.toBe("kg");
    await alice.reload({ waitUntil: "domcontentloaded" });
    await expect(alice.locator("#bbody .rfig").first()).toBeVisible();
    await expect(unitButton(alice, "kg")).toHaveAttribute("aria-pressed", "true");
    await expect(figure(alice, "Last weigh-in").locator("b")).toHaveText(weightIn(body.latest!.kg, "kg"));
    await alice.evaluate(() => localStorage.removeItem("weightUnit"));
  });

  test("a stored unit that is neither pounds nor kilograms falls back to pounds", async ({ alice }) => {
    await openWeight(alice);
    await alice.evaluate(() => localStorage.setItem("weightUnit", "stone"));
    await alice.reload({ waitUntil: "domcontentloaded" });
    await expect(alice.locator("#bbody .rfig").first()).toBeVisible();
    await expect(unitButton(alice, "lb")).toHaveAttribute("aria-pressed", "true");
    await expect(unitButton(alice, "kg")).toHaveAttribute("aria-pressed", "false");
    await alice.evaluate(() => localStorage.removeItem("weightUnit"));
  });

  test("every weigh-in in the table is its kilograms in pounds, to one decimal", async ({ alice, admin }) => {
    const { days } = await weight(admin);
    await openWeight(alice);
    await expect(rows(alice)).toHaveCount(45);
    const t = await readTable(alice);
    for (const d of days.filter((x) => x.weightKg !== null)) {
      expect.soft(cellOf(t, d.day, "Weight"), d.day).toBe(weightIn(d.weightKg, "lb"));
      expect.soft(cellOf(t, d.day, "Body fat"), d.day).toBe(`${fmt(d.bodyFatPercent, 1)} %`);
      expect.soft(cellOf(t, d.day, "Muscle"), d.day).toBe(weightIn(d.muscleKg, "lb"));
      expect.soft(cellOf(t, d.day, "BMI"), d.day).toBe(fmt(d.bmi, 1));
    }
  });

  test("in kilograms the table shows the same weigh-ins to one decimal", async ({ alice, admin }) => {
    const { days } = await weight(admin);
    await openWeight(alice);
    await unitButton(alice, "kg").click();
    const t = await readTable(alice);
    for (const d of days.filter((x) => x.weightKg !== null).slice(-4)) {
      expect.soft(cellOf(t, d.day, "Weight"), d.day).toBe(weightIn(d.weightKg, "kg"));
      expect.soft(cellOf(t, d.day, "Muscle"), d.day).toBe(weightIn(d.muscleKg, "kg"));
    }
  });

  test("the range of 14 days has the weigh-ins of the last two weeks, and their own trend", async ({ alice, admin }) => {
    const data = await weight(admin, "days=14");
    await openWeight(alice);
    await alice.locator("#bRange").selectOption("14");
    await expect(rows(alice)).toHaveCount(14);
    await expect(figure(alice, "Weigh-ins").locator("b")).toHaveText(String(data.body.weighIns));
    await expect(figure(alice, "Weigh-ins").locator("span")).toHaveText("in 14 days");
    await expect(figure(alice, "Trend").locator("b")).toHaveText(`${changeIn(data.body.perWeekKg!, "lb")} / week`);
    await expect(figure(alice, "Trend").locator("span")).toHaveText(`gaining · ${changeIn(data.body.changeKg!, "lb")} from ${short(data.body.first!.day)} to ${short(data.body.latest!.day)}`);
    await expect(chart(alice, "Weight").locator("circle.rc-dot")).toHaveCount(data.body.weighIns);
  });

  test("the range of 30 days has its weigh-ins and no more rows", async ({ alice, admin }) => {
    const data = await weight(admin, "days=30");
    await openWeight(alice);
    await alice.locator("#bRange").selectOption("30");
    await expect(rows(alice)).toHaveCount(30);
    await expect(figure(alice, "Weigh-ins").locator("b")).toHaveText(String(data.body.weighIns));
    await expect(figure(alice, "Weigh-ins").locator("span")).toHaveText("in 30 days");
    await expect(alice.locator("#bRange")).toHaveValue("30");
  });

  test("60 and 90 days both show the 45 days stored, with all 15 weigh-ins", async ({ alice }) => {
    await openWeight(alice);
    await expect(alice.locator("#bRange")).toHaveValue("60");
    await expect(rows(alice)).toHaveCount(45);
    await expect(figure(alice, "Weigh-ins").locator("b")).toHaveText("15");
    await alice.locator("#bRange").selectOption("90");
    await expect(rows(alice)).toHaveCount(45);
    await expect(figure(alice, "Weigh-ins").locator("b")).toHaveText("15");
    await expect(alice.locator("#bbody h3").first()).toHaveText("Trends, 45 days");
  });

  test("the weight chart has a point per weigh-in and the charts are drawn under their titles", async ({ alice }) => {
    await openWeight(alice);
    await expect(alice.locator("#bbody .rc .rch b")).toHaveText(CHARTS_LB);
    await expect(chart(alice, "Weight").locator("circle.rc-dot")).toHaveCount(15);
    await expect(chart(alice, "Weight").locator("path.rc-line")).toHaveCount(1);
    await expect(chart(alice, "Body fat").locator("circle.rc-dot")).toHaveCount(15);
    await expect(chart(alice, "Muscle mass").locator("circle.rc-dot")).toHaveCount(15);
  });

  test("the calories chart stacks the resting and the active burn of each day", async ({ alice }) => {
    await openWeight(alice);
    const burn = chart(alice, "Calories burned");
    await expect(burn.locator("rect.rc-part.bmr")).toHaveCount(45);
    await expect(burn.locator("rect.rc-part.active")).toHaveCount(45);
    await expect(burn.locator(".rcl")).toContainText("At rest");
    await expect(burn.locator(".rcl")).toContainText("Active");
  });

  test("the table lists each day's weight, fat, muscle, BMI and calories, and a day without a weigh-in shows dashes", async ({ alice, admin }) => {
    const { days, today } = await weight(admin);
    const latest = days[days.length - 1];
    expect(latest.day).toBe(today);
    const withoutWeighIn = days[days.length - 2];
    expect(withoutWeighIn.weightKg).toBeNull();
    await openWeight(alice);
    await expect(rows(alice).first().locator("td.day")).toHaveText(label(today));
    const t = await readTable(alice);
    expect.soft(cellOf(t,today, "Weight")).toBe(weightIn(latest.weightKg, "lb"));
    expect.soft(cellOf(t,today, "Body fat")).toBe(`${fmt(latest.bodyFatPercent, 1)} %`);
    expect.soft(cellOf(t,today, "All day")).toBe(`${fmt(latest.totalKcal)} kcal`);
    expect.soft(cellOf(t,today, "Active")).toBe(`${fmt(latest.activeKcal)} kcal`);
    expect.soft(cellOf(t,today, "At rest")).toBe(`${fmt(latest.bmrKcal)} kcal`);
    expect.soft(cellOf(t,withoutWeighIn.day, "Weight")).toBe("–");
    expect.soft(cellOf(t,withoutWeighIn.day, "Body fat")).toBe("–");
    expect.soft(cellOf(t,withoutWeighIn.day, "Muscle")).toBe("–");
    expect.soft(cellOf(t,withoutWeighIn.day, "BMI")).toBe("–");
    expect.soft(cellOf(t,withoutWeighIn.day, "All day")).toBe(`${fmt(withoutWeighIn.totalKcal)} kcal`);
  });

  test("hovering the weight chart reads the weigh-in of that day, and a day without one reads a dash", async ({ alice, admin }) => {
    const { days } = await weight(admin);
    const last = days[days.length - 1];
    await openWeight(alice);
    const w = chart(alice, "Weight");
    await hover(alice, w, 0.98);
    await expect(w.locator(".rcr")).toHaveText(`${label(last.day)}: ${weightIn(last.weightKg, "lb")} · ${fmt(last.bodyFatPercent, 1)} % fat`);
    await hover(alice, w, 0.075);
    await expect(w.locator(".rcr")).toHaveText(`${label(days[0].day)}: –`);
  });

  test("leaving the chart goes back to the picked day, the latest weigh-in", async ({ alice, admin }) => {
    const { days, body } = await weight(admin);
    await openWeight(alice);
    const w = chart(alice, "Weight");
    await hover(alice, w, 0.075);
    await alice.mouse.move(0, 0);
    await expect(w.locator(".rcr")).toHaveText(`${label(body.latest!.day)}: ${weightIn(days[days.length - 1].weightKg, "lb")} · ${fmt(days[days.length - 1].bodyFatPercent, 1)} % fat`);
  });

  test("a click on a weigh-in day picks it, marks its row and lists its Garmin responses", async ({ alice, admin }) => {
    const day = "2026-10-27";
    const oracle = await admin.get(`/api/wellness/raw?profile=alice&date=${day}&kind=weight`);
    expect(oracle.ok()).toBeTruthy();
    const stored = (await oracle.json()) as { data: unknown };
    await openWeight(alice);
    await rowOf(alice, day).click();
    await expect(alice.locator("#bbody h3", { hasText: "Garmin's responses for" })).toHaveText(`Garmin's responses for ${label(day)}`);
    await expect(rowOf(alice, day)).toHaveClass(/\bsel\b/);
    const weighIn = alice.locator("#bbody details.rraw").first();
    await expect(weighIn.locator("summary b")).toHaveText("Weigh-in");
    await weighIn.locator("summary").click();
    await expect(weighIn.locator("pre")).toContainText('"weight": 81880');
    expect(JSON.parse((await weighIn.locator("pre").textContent()) ?? "null")).toEqual(stored.data);
  });

  test("a click on a chart picks that day too", async ({ alice, admin }) => {
    const { days } = await weight(admin);
    await openWeight(alice);
    await click(alice, chart(alice, "Body fat"), 0.075);
    await expect(alice.locator("#bbody tr.sel td.day")).toHaveText(label(days[0].day));
    await expect(alice.locator("#bbody h3", { hasText: "Garmin's responses for" })).toHaveText(`Garmin's responses for ${label(days[0].day)}`);
  });

  test("a day without a weigh-in lists its weigh-in as not stored", async ({ alice }) => {
    await openWeight(alice);
    await rowOf(alice, "2026-10-26").click();
    await expect(alice.locator("#bbody details.rraw.none")).toHaveCount(1);
    await expect(alice.locator("#bbody details.rraw.none summary b")).toHaveText("Weigh-in");
    await expect(alice.locator("#bbody details.rraw.none summary small")).toHaveText("not stored for this day");
  });

  test("the footnote says the trend is a straight line, and the calories are Garmin's estimate", async ({ alice }) => {
    await openWeight(alice);
    await expect(alice.locator("#bbody .rfoot")).toContainText("The trend is a straight line through the weigh-ins of the days shown");
    await expect(alice.locator("#bbody .rfoot")).toContainText("The calories are Garmin's estimate from the watch: what the day burned, not what was eaten.");
  });

  test("the note says how many days are stored and their span", async ({ alice, admin }) => {
    const { sync } = await weight(admin);
    await openWeight(alice);
    await expect(alice.locator("#bNote")).toHaveText(`${sync.days} days stored (${short(sync.oldest!)} to ${short(sync.newest!)})`);
    await expect(alice.locator("#bNote")).not.toHaveClass(/err/);
  });

  test("the Sync button and the profile picker are hidden for a profile without a Garmin login", async ({ alice }) => {
    await openWeight(alice);
    await expect(figure(alice, "Trend")).toBeVisible();
    await expect(alice.locator("#bSync")).toBeHidden();
    await expect(alice.locator("#bProfile")).toBeHidden();
  });

  test("no NaN, undefined or null on the view, in either unit, over every range, or on a picked day", async ({ alice }) => {
    await openWeight(alice);
    for (const unit of ["lb", "kg"] as const) {
      await unitButton(alice, unit).click();
      for (const range of ["14", "30", "60", "90"]) {
        await alice.locator("#bRange").selectOption(range);
        await expect(figure(alice, "Trend")).toBeVisible();
        for (const pick of [null, "2026-10-27", "2026-10-26"] as const) {
          if (pick) await rowOf(alice, pick).click();
          await expect(alice.locator("#bbody .rfig").first()).toBeVisible();
          const text = (await alice.locator("#bbody").textContent()) ?? "";
          const svg = await alice.locator("#bbody svg").evaluateAll((els) => els.map((e) => e.outerHTML).join(""));
          expect(text, `${unit}, ${range} days, ${pick ?? "latest"}`).not.toMatch(/NaN|undefined|null|Infinity/);
          expect(svg, `${unit}, ${range} days, ${pick ?? "latest"}`).not.toMatch(/NaN|undefined|Infinity/);
        }
      }
    }
  });
});

// ── a fresh profile: no weigh-in, so no Weight view ───────────────────────────────────────────────

test.describe("Weight view, a fresh profile", () => {
  test("a fresh profile has no Weight button", async ({ me }) => {
    await openView(me, "today");
    await expect(me.locator("#vPlans")).toBeVisible();
    await expect(me.locator("#vWeight")).toBeHidden();
  });

  test("a fresh profile's Weight address falls back to Today", async ({ me }) => {
    await me.goto("/#weight");
    await expect(me.locator("body")).toHaveAttribute("data-view", "today");
    await expect(me.locator("#bview")).toBeHidden();
  });
});

// ── the admin reads every profile: a profile with nothing stored, and back to alice ───────────────

test.describe("Weight view, as the admin", () => {
  test("a profile with no weigh-ins says so, and offers no Sync", async ({ page, profile }) => {
    await loginAs(page, "admin", ADMIN_TOKEN);
    await page.goto("/#weight");
    await expect(figure(page, "Trend")).toBeVisible();
    await expect(page.locator("#bProfile")).toBeVisible();
    await page.locator("#bProfile").selectOption(profile.name);
    await expect(page.locator("#bbody")).toHaveText("No weigh-ins are stored yet. Connect a Renpho scale or Garmin in Settings to get them.");
    await expect(page.locator("#bSync")).toBeHidden();
    await expect(page.locator("#bNote")).toBeHidden();
  });

  test("switching the picker goes between alice's weigh-ins and an empty profile", async ({ page, profile }) => {
    await loginAs(page, "admin", ADMIN_TOKEN);
    await page.goto("/#weight");
    await page.locator("#bProfile").selectOption("alice");
    await expect(rows(page)).toHaveCount(45);
    await page.locator("#bProfile").selectOption(profile.name);
    await expect(page.locator("#bbody")).toContainText("No weigh-ins are stored yet");
    await page.locator("#bProfile").selectOption("alice");
    await expect(rows(page)).toHaveCount(45);
  });
});

// ── failures: the view says why, and keeps what it had ───────────────────────────────────────────

test.describe("Weight view, when the server fails", () => {
  test("a failed load says why, in the view and in the note", async ({ alice }) => {
    await alice.route(/\/api\/weight\?/, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Weights are unavailable" }) }));
    await alice.goto("/#weight");
    await expect(alice.locator("#bbody .msg.err")).toHaveText("Weights are unavailable");
    await expect(alice.locator("#bNote")).toHaveText("Weights are unavailable");
    await expect(alice.locator("#bNote")).toHaveClass(/err/);
  });

  test("a failed refresh keeps the figures on screen and says why, and the next good answer clears it", async ({ alice, admin }) => {
    const { sync } = await weight(admin);
    let failing = false;
    await alice.route(/\/api\/weight\?/, (route) =>
      failing ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Weights are unavailable" }) }) : route.continue(),
    );
    await openWeight(alice);
    await expect(rows(alice)).toHaveCount(45);
    failing = true;
    await alice.locator("#bRange").selectOption("14");
    await expect(alice.locator("#bNote")).toHaveText("Weights are unavailable");
    await expect(alice.locator("#bNote")).toHaveClass(/err/);
    await expect(figure(alice, "Weigh-ins").locator("b")).toHaveText("15");
    await expect(rows(alice)).toHaveCount(45);
    failing = false;
    await alice.locator("#bRange").selectOption("14");
    await expect(rows(alice)).toHaveCount(14);
    await expect(alice.locator("#bNote")).not.toHaveClass(/err/);
    await expect(alice.locator("#bNote")).toContainText(`${sync.days} days stored`);
  });
});
