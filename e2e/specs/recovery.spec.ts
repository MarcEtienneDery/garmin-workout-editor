/**
 * The Recovery view: the readiness of a day with its signals (the Verdict), the day and range controls, the trend charts (the Trends), the
 * table of every stored number and Garmin's raw responses (the Data), and the empty and error states. Reads alice's data (read only) and checks the page
 * against GET /api/wellness, which the suite reads as admin (the oracle). A fresh profile and the admin's view of one cover
 * the states alice does not have.
 */
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect, openView, loginAs, ADMIN_TOKEN } from "../support/fixtures";

// ── oracle: GET /api/wellness as stored (the shapes the page reads) ──────────────────────────────

interface Signal {
  name: string;
  value: string;
  baseline: string | null;
  score: number;
  reason: string;
}
interface Day {
  day: string;
  hrvBalancedLow: number | null;
  hrvBalancedHigh: number | null;
  sleepSeconds: number | null;
  sleepScore: number | null;
  sleepNeedMinutes: number | null;
  deepSeconds: number | null;
  lightSeconds: number | null;
  remSeconds: number | null;
  awakeSeconds: number | null;
  awakeCount: number | null;
  sleepStress: number | null;
  hrvLastNight: number | null;
  hrvWeeklyAvg: number | null;
  restingHr: number | null;
  restingHr7d: number | null;
  bodyBatteryWake: number | null;
  bodyBatteryHigh: number | null;
  bodyBatteryLow: number | null;
  bodyBatteryCharged: number | null;
  bodyBatteryDrained: number | null;
  avgStress: number | null;
  maxStress: number | null;
  steps: number | null;
  moderateMinutes: number | null;
  vigorousMinutes: number | null;
  avgSleepRespiration: number | null;
  avgWakingRespiration: number | null;
  lowRespiration: number | null;
  lowestSpo2: number | null;
}
interface Wellness {
  today: string;
  date: string;
  week: { day: string; band: string; score: number | null }[];
  readinessDays: { day: string; band: string; score: number | null }[];
  readiness: {
    band: "go-harder" | "as-planned" | "back-off" | "unknown";
    score: number | null;
    confidence: string;
    signals: Signal[];
    missing: string[];
    load: { sessions: number; acute: number; usual: number | null; hoursSinceHard: number | null; intensity: { acute: number; usual: number | null } | null } | null;
    suggestion: string;
  };
  days: Day[];
  stored: { kind: string; bytes: number; fetchedAt: number }[];
  sync: { days: number; oldest: string | null; newest: string | null; pending: number; syncing: boolean; error: string | null };
}

async function wellness(admin: APIRequestContext, query: string): Promise<Wellness> {
  const res = await admin.get(`/api/wellness?profile=alice&${query}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as Wellness;
}

// ── how the page words things (the same rules, written out) ─────────────────────────────────────

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const label = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};
const fmt = (v: number | null | undefined, digits = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-CA", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "–";
const hm = (seconds: number | null | undefined) => {
  if (typeof seconds !== "number" || seconds <= 0) return "–";
  const m = Math.round(seconds / 60);
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
};
const BAND_LABEL = { "go-harder": "Go harder", "as-planned": "As planned", "back-off": "Back off", unknown: "Not enough data" } as const;
const BAND_CLASS = { "go-harder": "go", "as-planned": "plan", "back-off": "back", unknown: "unknown" } as const;
const SIGNAL_LABEL: Record<string, string> = { hrv: "HRV", restingHr: "Resting heart rate", sleep: "Sleep", bodyBattery: "Body Battery", stress: "Stress yesterday", load: "Training load" };
/** "stress: no stress figure for yesterday" reads "Stress yesterday: no stress figure for yesterday". */
const notCounted = (missing: string[]) => "Not counted: " + missing.map((m) => m.replace(/^(\w+): /, (_, k) => `${SIGNAL_LABEL[k] ?? k}: `)).join("; ") + ".";

// ── the page ─────────────────────────────────────────────────────────────────────────────────────

/** The verdict of the day: the card with the gauge, the band and what to do. */
const card = (page: Page) => page.locator("#rbody .rhero");
const table = (page: Page) => page.locator("#rbody table.rmetrics");
const rows = (page: Page) => table(page).locator("tbody tr");
const chart = (page: Page, title: string) => page.locator("#rbody .rc", { has: page.locator("b", { hasText: title }) });
const CHART_TITLES = ["Readiness (score)", "HRV overnight (ms)", "Resting heart rate (bpm)", "Breathing (/min)", "Sleep (h)", "Body Battery", "Stress", "Steps", "Intensity minutes"];
const part = (page: Page, name: "Verdict" | "Trends" | "Data") => page.locator("#rTabs").getByRole("button", { name, exact: true });

/** Opens one of the three parts of the view and waits until it is the one drawn. */
async function openPart(page: Page, name: "Verdict" | "Trends" | "Data") {
  await part(page, name).click();
  await expect(part(page, name)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#rbody")).toHaveAttribute("data-tab", name.toLowerCase());
}
/** The Trends, with their charts drawn. */
async function openTrends(page: Page) {
  await openPart(page, "Trends");
  await expect(page.locator("#rbody .rcharts")).toBeVisible();
}
/** The Data, the table open (it is by default) and, with `raw`, Garmin's responses open too. */
async function openData(page: Page, raw = false) {
  await openPart(page, "Data");
  await expect(table(page)).toBeVisible();
  if (raw) {
    const box = page.locator("#rbody details.racc").nth(1);
    if (!(await box.evaluate((el: HTMLDetailsElement) => el.open))) await box.locator("summary").first().click();
    await expect(box).toHaveAttribute("open", "");
  }
}

/** Opens the view and waits for its first answer to be drawn: the day controls do nothing before it, as the person would find them. */
async function openRecovery(page: Page) {
  await openView(page, "recovery");
  await expect(card(page)).toBeVisible();
}

/** The table row of a day, by its first cell. */
const rowOf = (page: Page, day: string) => rows(page).filter({ has: page.locator(`td.day:text-is("${label(day)}")`) });
/**
 * A column's index in the table, by its header (the second header row names the fields). Some names are in two groups ("Awake" is
 * sleep and breathing): `occurrence` picks which, 0 for the first.
 */
/** The table as text, read in one go: its field headers and each row's cells by its day label. */
async function readTable(page: Page): Promise<{ heads: string[]; rows: Map<string, string[]> }> {
  const read = await table(page).evaluate((t) => ({
    heads: [...(t.querySelectorAll("thead tr")[1]?.querySelectorAll("th") ?? [])].map((th) => th.textContent ?? ""),
    rows: [...t.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "")),
  }));
  return { heads: read.heads, rows: new Map(read.rows.map((cells) => [cells[0], cells])) };
}
/** One cell of a read table: the day's row, and the column by its header (the nth one of that name). */
function cellOf(t: { heads: string[]; rows: Map<string, string[]> }, day: string, header: string, occurrence = 0): string {
  const hits = t.heads.flatMap((h, i) => (h === header ? [i] : []));
  expect(hits.length, `a column "${header}"`).toBeGreaterThan(occurrence);
  const cells = t.rows.get(label(day));
  expect(cells, `a row for ${label(day)}`).toBeDefined();
  return cells![hits[occurrence]] ?? "";
}

/** Points a fraction of the way across a chart's plot area (0 to 1): 0.02 is over its first day and 0.98 over its last. */
async function aim(c: Locator, fraction: number): Promise<{ x: number; y: number }> {
  const over = c.locator("rect.rc-over");
  await over.scrollIntoViewIfNeeded();
  const box = await over.boundingBox();
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

/** Picks a day in the date picker and waits for the title of the view to show it. */
async function pickDay(page: Page, day: string) {
  await page.locator("#rDate").fill(day);
  await expect(page.locator("#rDate")).toHaveValue(day);
  await expect(page.locator("#rDayLabel")).toContainText(label(day));
}

// ── alice: 45 days stored ─────────────────────────────────────────────────────────────────────────

test.describe("Recovery view, alice (45 days stored, no Garmin login)", () => {
  test("the header button opens the view from Today", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    await openView(alice, "today");
    await alice.locator("#vRecovery").click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "recovery");
    await expect(alice).toHaveURL(/#recovery$/);
    await expect(alice.locator("#vRecovery")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#rDate")).toHaveValue(data.today);
  });

  test("the address opens the view on today's readiness", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    await openRecovery(alice);
    await expect(card(alice)).toBeVisible();
    await expect(alice.locator("#rDate")).toHaveValue(data.today);
    await expect(card(alice)).toContainText(`${label(data.today)} (today)`);
  });

  test("today's card names the band, the score and the confidence", async ({ alice, admin }) => {
    const { readiness: r, today } = await wellness(admin, "days=30");
    await openRecovery(alice);
    await expect(card(alice)).toHaveClass(`rhero b-${BAND_CLASS[r.band]}`);
    await expect(card(alice).locator(".rband")).toHaveText(BAND_LABEL[r.band]);
    await expect(card(alice).locator(".rgauge .rmid b")).toHaveText(String(r.score));
    await expect(card(alice).locator(".rverdict .eyebrow")).toHaveText(`Readiness · ${label(today)} (today)`);
    await expect(card(alice).locator(".rchips .chipx").first()).toHaveText(`${r.confidence} confidence`);
    await expect(card(alice).locator(".rchips .chipx").nth(1)).toHaveText(`${r.signals.length} of ${r.signals.length + r.missing.length} signals counted`);
  });

  test("the card gives the suggestion for the band", async ({ alice, admin }) => {
    const { readiness: r } = await wellness(admin, "days=30");
    await openRecovery(alice);
    await expect(card(alice).locator(".rsug")).toHaveText(r.suggestion);
  });

  test("every signal of the day is listed with its value, its baseline and its reason", async ({ alice, admin }) => {
    const { readiness: r } = await wellness(admin, "days=30");
    await openRecovery(alice);
    const signals = alice.locator("#rbody .rsigcard .rsig");
    await expect(signals).toHaveCount(r.signals.length);
    for (const [i, s] of r.signals.entries()) {
      const row = signals.nth(i);
      await expect(row.locator(".nm")).toContainText(SIGNAL_LABEL[s.name]);
      await expect(row.locator(".val")).toHaveText(s.value);
      await expect(row.locator(".why")).toHaveText(s.reason);
      if (s.baseline) await expect(row.locator(".base")).toHaveText(s.baseline);
      else await expect(row.locator(".base")).toHaveCount(0);
    }
    await expect(signals.locator(".nm em")).toHaveText(["COUNTS MOST"]); // the HRV counts twice what the others do
    // the six signals a full day gives, in the order the model scores them
    expect(r.signals.map((s) => s.name)).toEqual(["hrv", "restingHr", "sleep", "bodyBattery", "stress", "load"]);
  });

  test("the training load card gives the sessions and the units against the usual, and the intensity minutes against theirs", async ({ alice, admin }) => {
    const { readiness: r } = await wellness(admin, "days=30");
    const load = r.load!;
    expect(load).not.toBeNull();
    await openRecovery(alice);
    const bars = alice.locator("#rbody .rload .rbullet");
    await expect(bars.first().locator(".l")).toHaveText(`Last 3 days · ${load.sessions} session${load.sessions === 1 ? "" : "s"}${fmt(load.acute)} units`);
    await expect(bars.first().locator(".n")).toContainText(load.usual === null ? "no usual to compare with yet" : `usual ${fmt(load.usual)}`);
    if (load.intensity) {
      await expect(bars.nth(1).locator(".l")).toHaveText(`Intensity minutes, last 3 days${fmt(load.intensity.acute)} min`);
      if (load.intensity.usual !== null) await expect(bars.nth(1).locator(".n")).toContainText(`usual ${fmt(load.intensity.usual)}`);
    }
    const hard = load.hoursSinceHard === null ? "none in 3 days" : `${fmt(Math.round(load.hoursSinceHard))} h ago`;
    await expect(alice.locator("#rbody .rload .rkv div").first().locator("b")).toHaveText(hard);
  });

  test("a day the readiness scores go-harder shows the green band, and says what was not counted", async ({ alice, admin }) => {
    // the first stored day has no stress figure for the day before and no sessions before it: those two signals are not counted
    const first = await wellness(admin, "days=30");
    const day = first.sync.oldest!;
    const data = await wellness(admin, `date=${day}&days=14`);
    expect(data.readiness.band).toBe("go-harder");
    await openRecovery(alice);
    await pickDay(alice, day);
    await expect(card(alice)).toHaveClass("rhero b-go");
    await expect(card(alice).locator(".rband")).toHaveText("Go harder");
    await expect(card(alice).locator(".rgauge .rmid b")).toHaveText(String(data.readiness.score));
    await expect(card(alice).locator(".rsug")).toHaveText(data.readiness.suggestion);
    await expect(alice.locator("#rbody .rmiss")).toHaveText(notCounted(data.readiness.missing));
    await expect(alice.locator("#rbody .rmiss")).toContainText("Stress yesterday: no stress figure for yesterday");
    await expect(alice.locator("#rbody .rmiss")).toContainText("Training load: no sessions in the last 31 days");
  });

  test("a day with nothing stored says Not enough data, with no score and no signals", async ({ alice, admin }) => {
    const first = await wellness(admin, "days=30");
    const day = addDays(first.sync.oldest!, -1);
    await openRecovery(alice);
    await pickDay(alice, day);
    await expect(card(alice)).toHaveClass("rhero b-unknown");
    await expect(card(alice).locator(".rband")).toHaveText("Not enough data");
    await expect(card(alice).locator(".rgauge")).toHaveCount(0);
    await expect(alice.locator("#rbody .rsigcard")).toHaveCount(0);
    await expect(card(alice).locator(".rchange")).toHaveCount(0);
    await expect(card(alice).locator(".rsug")).toHaveText("Not enough data to judge the day: train as planned and go by feel.");
    await expect(alice.locator("#rbody .rmiss")).toContainText("HRV: no data stored for the day");
    await expect(alice.locator("#rbody .rmiss")).toContainText("Sleep: no data stored for the day");
  });

  test("a day with nothing stored has no points in its charts and no table rows, rather than zeros", async ({ alice, admin }) => {
    const first = await wellness(admin, "days=30");
    const day = addDays(first.sync.oldest!, -1);
    await openRecovery(alice);
    await pickDay(alice, day);
    await openTrends(alice);
    await expect(alice.locator("#rbody .rc .rcnone")).toHaveCount(CHART_TITLES.length);
    await expect(alice.locator("#rbody .rc .rcnone").first()).toHaveText("No data in this range.");
    await expect(alice.locator("#rbody svg.rcsvg")).toHaveCount(0);
    await expect(alice.locator("#rbody h3").nth(0)).toHaveText("Trends, 0 days");
    await openData(alice);
    await expect(rows(alice)).toHaveCount(0);
  });

  test("◀ steps back a day, and ▶ is disabled on today", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    await openRecovery(alice);
    await expect(alice.locator("#rNext")).toBeDisabled();
    await alice.locator("#rPrev").click();
    await expect(alice.locator("#rDate")).toHaveValue(addDays(data.today, -1));
    await expect(card(alice)).toContainText(label(addDays(data.today, -1)));
    await expect(card(alice)).not.toContainText("(today)");
    await expect(alice.locator("#rNext")).toBeEnabled();
  });

  test("▶ steps forward again, and Today goes back to today from any day", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    await openRecovery(alice);
    // each press waits for its day to be drawn, as a person pausing between presses does
    await alice.locator("#rPrev").click();
    await expect(alice.locator("#rDate")).toHaveValue(addDays(data.today, -1));
    await alice.locator("#rPrev").click();
    await expect(alice.locator("#rDate")).toHaveValue(addDays(data.today, -2));
    await alice.locator("#rNext").click();
    await expect(alice.locator("#rDate")).toHaveValue(addDays(data.today, -1));
    await alice.locator("#rToday").click();
    await expect(alice.locator("#rDate")).toHaveValue(data.today);
    await expect(alice.locator("#rNext")).toBeDisabled();
    await expect(card(alice)).toContainText("(today)");
  });

  // ◀ and ▶ step from the day asked for, not the day drawn, which trails while an answer is awaited (the first answer is held for 1.5 s here).
  test("two quick presses of ◀ step back two days, even while the first day is still loading", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    await openRecovery(alice);
    let slowed = false;
    await alice.route(/\/api\/wellness\?/, async (route) => {
      if (!slowed && route.request().url().includes("date=")) {
        slowed = true;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      await route.continue();
    });
    await alice.locator("#rPrev").click();
    await alice.locator("#rPrev").click();
    await expect(alice.locator("#rDate")).toHaveValue(addDays(data.today, -2));
  });

  test("a date typed in the picker moves to that day", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    const day = addDays(data.today, -7);
    await openRecovery(alice);
    await pickDay(alice, day);
    await expect(alice.locator("#rNext")).toBeEnabled();
    await openData(alice);
    await expect(rowOf(alice, day)).toHaveClass(/sel/);
  });

  test("a date typed after today is brought back to today", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    await openRecovery(alice);
    await alice.locator("#rPrev").click();
    await expect(alice.locator("#rDate")).toHaveValue(addDays(data.today, -1));
    await alice.locator("#rDate").fill(addDays(data.today, 10));
    await expect(alice.locator("#rDate")).toHaveValue(data.today);
    await expect(card(alice)).toContainText("(today)");
    await expect(alice.locator("#rNext")).toBeDisabled();
  });

  test("the range select is with the trends, and sets how many days the charts and the table list: 14, then 30", async ({ alice }) => {
    await openRecovery(alice);
    await expect(alice.locator("#rRange")).toBeHidden(); // it is the trends' own
    await openTrends(alice);
    await expect(alice.locator("#rRange")).toBeVisible();
    await expect(alice.locator("#rbody .rth #rRange")).toHaveCount(1);
    await expect(alice.locator("#rbody .rth h3")).toHaveText("Trends, 30 days");
    await alice.locator("#rRange").selectOption("14");
    await expect(chart(alice, "Steps").locator("rect.rc-bar")).toHaveCount(14);
    await expect(alice.locator("#rbody .rth h3")).toHaveText("Trends, 14 days");
    await openData(alice);
    await expect(rows(alice)).toHaveCount(14);
    await expect(alice.locator("#rRange")).toBeHidden();
    await openTrends(alice);
    await alice.locator("#rRange").selectOption("30");
    await openData(alice);
    await expect(rows(alice)).toHaveCount(30);
    await openTrends(alice);
    await expect(alice.locator("#rRange")).toHaveValue("30");
  });

  test("60 and 90 days list the 45 days stored, and no empty rows past them", async ({ alice }) => {
    await openRecovery(alice);
    await openTrends(alice);
    await alice.locator("#rRange").selectOption("60");
    await expect(alice.locator("#rbody h3").nth(0)).toHaveText("Trends, 45 days");
    await openData(alice);
    await expect(rows(alice)).toHaveCount(45);
    await openTrends(alice);
    await alice.locator("#rRange").selectOption("90");
    await openData(alice);
    await expect(rows(alice)).toHaveCount(45);
    await openTrends(alice);
    await expect(alice.locator("#rRange")).toHaveValue("90");
  });

  test("each chart has a mark per stored day in the range", async ({ alice }) => {
    await openRecovery(alice);
    await openTrends(alice);
    await alice.locator("#rRange").selectOption("14");
    await expect(alice.locator("#rbody .rth h3")).toHaveText("Trends, 14 days");
    await expect(chart(alice, "HRV overnight").locator("circle.rc-dot")).toHaveCount(14);
    await expect(chart(alice, "Resting heart rate").locator("circle.rc-dot")).toHaveCount(14);
    await expect(chart(alice, "Breathing").locator("circle.rc-dot")).toHaveCount(14);
    await expect(chart(alice, "Sleep (h)").locator("rect.rc-part.deep")).toHaveCount(14);
    await expect(chart(alice, "Body Battery").locator("line.rc-range")).toHaveCount(14);
    await expect(chart(alice, "Stress").locator("rect.rc-bar")).toHaveCount(14);
    await expect(chart(alice, "Steps").locator("rect.rc-bar")).toHaveCount(14);
    await expect(chart(alice, "Intensity minutes").locator("rect.rc-part.moderate")).toHaveCount(14);
    await expect(chart(alice, "Readiness").locator("rect.rc-bar")).toHaveCount(14);
  });

  test("a range of 30 days draws the same marks for every stored day of it", async ({ alice }) => {
    await openRecovery(alice);
    await openTrends(alice);
    await expect(chart(alice, "HRV overnight").locator("circle.rc-dot")).toHaveCount(30);
    await expect(chart(alice, "Steps").locator("rect.rc-bar")).toHaveCount(30);
    await expect(chart(alice, "Body Battery").locator("line.rc-range")).toHaveCount(30);
  });

  test("the nine trend charts are drawn under their titles, the readiness first", async ({ alice }) => {
    await openRecovery(alice);
    await openTrends(alice);
    await expect(alice.locator("#rbody .rc")).toHaveCount(CHART_TITLES.length);
    await expect(alice.locator("#rbody .rc .rch b")).toHaveText(CHART_TITLES);
    await expect(alice.locator("#rbody h3").nth(0)).toHaveText("Trends, 30 days");
  });

  test("hovering a chart reads out that day's numbers, and leaving it goes back to the picked day", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    await openRecovery(alice);
    await openTrends(alice);
    const hrv = chart(alice, "HRV overnight");
    const first = data.days[0], last = data.days[data.days.length - 1];
    const reading = (d: Day) => `${label(d.day)}: ${fmt(d.hrvLastNight)} ms · balanced ${fmt(d.hrvBalancedLow)}–${fmt(d.hrvBalancedHigh)}`;
    await hover(alice, hrv, 0.02);
    await expect(hrv.locator(".rcr")).toHaveText(reading(first));
    await hover(alice, hrv, 0.98);
    await expect(hrv.locator(".rcr")).toHaveText(reading(last));
    await alice.mouse.move(0, 0);
    // the pointer has left: the readout is back on the picked day, which is today
    await expect(hrv.locator(".rcr")).toHaveText(reading(last));
    await expect(hrv.locator(".rcr")).toContainText(label(data.today));
  });

  test("a hover on a day reads out the Body Battery range and the average stress of the day", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    await openRecovery(alice);
    await openTrends(alice);
    const bb = chart(alice, "Body Battery");
    await hover(alice, bb, 0.98);
    const last = data.days[data.days.length - 1];
    await expect(bb.locator(".rcr")).toHaveText(`${label(last.day)}: ${fmt(last.bodyBatteryWake)} on waking · ${fmt(last.bodyBatteryLow)}–${fmt(last.bodyBatteryHigh)} over the day`);
    const stress = chart(alice, "Stress");
    await hover(alice, stress, 0.98);
    await expect(stress.locator(".rcr")).toHaveText(`${label(last.day)}: average ${fmt(last.avgStress)} · max ${fmt(last.maxStress)}`);
  });

  test("a click on a chart picks that day, and the trends stay", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=14");
    await openRecovery(alice);
    await openTrends(alice);
    await alice.locator("#rRange").selectOption("14");
    await expect(alice.locator("#rbody .rth h3")).toHaveText("Trends, 14 days");
    const day = data.days[0].day;
    await click(alice, chart(alice, "Steps"), 0.02);
    await expect(alice.locator("#rDate")).toHaveValue(day);
    await expect(part(alice, "Trends")).toHaveAttribute("aria-pressed", "true");
    await expect(chart(alice, "Steps").locator("rect.rc-sel")).toHaveCount(1);
    await expect(chart(alice, "Steps").locator(".rcr")).toContainText(label(day));
    await openPart(alice, "Verdict");
    await expect(card(alice)).toContainText(label(day));
  });

  test("the readiness chart draws a bar for each day's verdict, in the colour of its zone, and reads it out", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    await openRecovery(alice);
    await openTrends(alice);
    const c = chart(alice, "Readiness");
    const zone = (s: number | null) => (s === null ? "" : s < 37.5 ? "back" : s >= 70 ? "go" : "plan");
    const days = data.readinessDays;
    expect(days).toHaveLength(30);
    await expect(c.locator("rect.rc-bar")).toHaveCount(days.filter((d) => d.score !== null).length);
    for (const z of ["go", "plan", "back"]) await expect(c.locator(`rect.rc-bar.${z}`)).toHaveCount(days.filter((d) => zone(d.score) === z).length);
    await expect(c.locator(".rcl")).toContainText("A normal day, 50");
    const last = days[days.length - 1];
    await hover(alice, c, 0.98);
    await expect(c.locator(".rcr")).toHaveText(`${label(last.day)}: ${last.score} · ${BAND_LABEL[last.band as keyof typeof BAND_LABEL].toLowerCase()}`);
    // the first of the charts takes the width of the page, and the others two across
    const widths = await alice.locator("#rbody .rcharts .rc").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    expect(widths[0]).toBeGreaterThan(widths[1] * 1.7);
  });

  test("a click on a table row picks that day and marks its row", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    const day = data.days[data.days.length - 5].day;
    await openRecovery(alice);
    await openData(alice);
    await expect(alice.locator("#rbody tr.sel")).toHaveCount(1);
    await rowOf(alice, day).click();
    await expect(alice.locator("#rDate")).toHaveValue(day);
    await expect(part(alice, "Verdict")).toHaveAttribute("aria-pressed", "true"); // the day opens in the Verdict, where its readiness is
    await expect(card(alice)).toContainText(label(day));
    await openData(alice);
    await expect(alice.locator("#rbody tr.sel td.day")).toHaveText(label(day));
    await expect(alice.locator("#rbody tr.sel")).toHaveCount(1);
  });

  test("the table lists each day newest first with the numbers stored for it", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    await openRecovery(alice);
    await openData(alice);
    await expect(rows(alice)).toHaveCount(30);
    await expect(rows(alice).first().locator("td.day")).toHaveText(label(data.today));
    await expect(rows(alice).last().locator("td.day")).toHaveText(label(data.days[0].day));
    const t = await readTable(alice);
    for (const d of [data.days[data.days.length - 1], data.days[data.days.length - 2], data.days[data.days.length - 9]]) {
      expect.soft(cellOf(t, d.day, "Slept")).toBe(hm(d.sleepSeconds));
      expect.soft(cellOf(t, d.day, "Score")).toBe(fmt(d.sleepScore));
      expect.soft(cellOf(t, d.day, "Need")).toBe(hm(d.sleepNeedMinutes === null ? null : d.sleepNeedMinutes * 60));
      expect.soft(cellOf(t, d.day, "Deep")).toBe(hm(d.deepSeconds));
      expect.soft(cellOf(t, d.day, "Wakings")).toBe(fmt(d.awakeCount));
      expect.soft(cellOf(t, d.day, "Last night")).toBe(`${fmt(d.hrvLastNight)} ms`);
      expect.soft(cellOf(t, d.day, "Resting")).toBe(`${fmt(d.restingHr)} bpm`);
      expect.soft(cellOf(t, d.day, "On waking")).toBe(fmt(d.bodyBatteryWake));
      expect.soft(cellOf(t, d.day, "Average")).toBe(fmt(d.avgStress));
      expect.soft(cellOf(t, d.day, "Steps")).toBe(fmt(d.steps));
      expect.soft(cellOf(t, d.day, "Moderate min")).toBe(fmt(d.moderateMinutes));
      expect.soft(cellOf(t, d.day, "Vigorous min")).toBe(fmt(d.vigorousMinutes));
      expect.soft(cellOf(t, d.day, "In sleep")).toBe(fmt(d.avgSleepRespiration, 1) + " /min");
    }
  });

  test("a number Garmin did not give is a dash in the table, not a zero", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    await openRecovery(alice);
    await openData(alice);
    await expect(rows(alice)).toHaveCount(30);
    // alice's days carry no waking breathing, no lowest breath and no SpO2: every such cell reads as a dash
    expect(data.days.every((d) => d.avgWakingRespiration === null && d.lowRespiration === null && d.lowestSpo2 === null)).toBeTruthy();
    const t = await readTable(alice);
    for (const d of [data.days[0], data.days[15], data.days[data.days.length - 1]]) {
      expect.soft(cellOf(t, d.day, "Awake", 1)).toBe("–");
      expect.soft(cellOf(t, d.day, "Lowest")).toBe("–");
      expect.soft(cellOf(t, d.day, "Lowest SpO2")).toBe("–");
    }
  });

  test("the raw responses list each kind with its size, and the kinds not stored say so", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    await openRecovery(alice);
    await openData(alice, true);
    const raw = alice.locator("#rbody details.rraw");
    await expect(raw).toHaveCount(8);
    await expect(raw.locator("summary b")).toHaveText(["Daily summary", "Sleep", "HRV", "Heart rate", "Stress", "Body Battery", "Respiration", "SpO2"]);
    // the eight kinds the view lists; the stored weigh-in of the day is the Weight view's to show, not listed here
    const listed = ["summary", "sleep", "hrv", "heart_rate", "stress", "body_battery", "respiration", "spo2"];
    const stored = new Map(data.stored.filter((s) => listed.includes(s.kind)).map((s) => [s.kind, s]));
    expect([...stored.keys()]).toEqual(["summary", "sleep", "hrv"]);
    await expect(raw.nth(0).locator("summary small")).toContainText(`summary · ${stored.get("summary")!.bytes} B · fetched `);
    await expect(raw.nth(1).locator("summary small")).toContainText(`sleep · ${stored.get("sleep")!.bytes} B · fetched `);
    await expect(raw.nth(2).locator("summary small")).toContainText(`hrv · ${stored.get("hrv")!.bytes} B · fetched `);
    await expect(alice.locator("#rbody details.rraw.none")).toHaveCount(5);
    await expect(alice.locator("#rbody details.rraw.none summary small").first()).toHaveText("not stored for this day");
  });

  test("opening a kind shows Garmin's stored response for the day, as it came", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    const oracle = await admin.get(`/api/wellness/raw?profile=alice&date=${data.date}&kind=summary`);
    expect(oracle.ok()).toBeTruthy();
    const stored = (await oracle.json()) as { data: unknown };
    await openRecovery(alice);
    await openData(alice, true);
    const summary = alice.locator("#rbody details.rraw").nth(0);
    await summary.locator("summary").click();
    await expect(summary.locator("pre")).toContainText('"totalSteps"');
    await expect(summary.locator("pre")).toHaveText(new RegExp(`"calendarDate": "${data.date}"`));
    // the page's layout keeps the numbers as they are: the text reads back to exactly what Garmin's response held
    expect(JSON.parse((await summary.locator("pre").textContent()) ?? "null")).toEqual(stored.data);
  });

  test("a kind with nothing stored does not open", async ({ alice }) => {
    await openRecovery(alice);
    await openData(alice, true);
    const none = alice.locator("#rbody details.rraw.none").first();
    await none.locator("summary").click({ force: true });
    await expect(none).not.toHaveAttribute("open", "");
    await expect(none.locator("pre")).toHaveCount(0);
  });

  test("the note says how many days are stored and their span", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    await openRecovery(alice);
    const span = (iso: string) => label(iso).slice(4);
    await expect(alice.locator("#rNote")).toHaveText(`${data.sync.days} days stored (${span(data.sync.oldest!)} to ${span(data.sync.newest!)})`);
    await expect(alice.locator("#rNote")).not.toHaveClass(/err/);
  });

  test("the profile picker and the Sync button are hidden for a profile without a Garmin login", async ({ alice }) => {
    await openRecovery(alice);
    await expect(card(alice)).toBeVisible();
    await expect(alice.locator("#rProfile")).toBeHidden();
    await expect(alice.locator("#rSync")).toBeHidden();
  });

  test("About these numbers says the band is a heuristic, and where its thresholds are", async ({ alice }) => {
    await openRecovery(alice);
    const about = alice.locator("#rbody .rfoot .help");
    await expect(about).toBeHidden();
    await alice.locator("#rbody .rfoot").getByRole("button", { name: "About these numbers" }).click();
    await expect(about).toBeVisible();
    await expect(about).toContainText("a heuristic from watch data to adjust training, not medical advice");
    await expect(about).toContainText("src/shared/readiness.ts");
  });

  test("no NaN, undefined or null on the view, for any day, range or state, in any of its three parts", async ({ alice, admin }) => {
    test.setTimeout(150_000);
    const data = await wellness(admin, "days=30");
    await openRecovery(alice);
    const days = [data.today, data.sync.oldest!, addDays(data.sync.oldest!, -1), addDays(data.today, -20)];
    for (const range of ["14", "30", "60", "90"]) {
      await openTrends(alice);
      await alice.locator("#rRange").selectOption(range);
      for (const day of days) {
        await pickDay(alice, day);
        for (const name of ["Verdict", "Trends", "Data"] as const) {
          await openPart(alice, name);
          const text = (await alice.locator("#rbody").textContent()) ?? "";
          const svg = (await alice.locator("#rview svg").evaluateAll((els) => els.map((e) => e.outerHTML).join(""))) ?? "";
          expect(text, `${name}, ${range} days, ${day}`).not.toMatch(/NaN|undefined|null|Infinity/);
          expect(svg, `${name}, ${range} days, ${day}`).not.toMatch(/NaN|undefined|Infinity/);
          expect(await alice.locator("#rNote").textContent()).not.toMatch(/NaN|undefined|null/);
          expect(await alice.locator("#rstrip").textContent()).not.toMatch(/NaN|undefined|null|Infinity/);
        }
      }
    }
  });
});

// ── a fresh profile: nothing stored, so no Recovery view ─────────────────────────────────────────

test.describe("Recovery view, a fresh profile", () => {
  test("a fresh profile has no Recovery button", async ({ me }) => {
    await openView(me, "today");
    await expect(me.locator("#vPlans")).toBeVisible();
    await expect(me.locator("#vRecovery")).toBeHidden();
  });

  test("a fresh profile's Recovery address falls back to Today", async ({ me }) => {
    await me.goto("/#recovery");
    await expect(me.locator("body")).toHaveAttribute("data-view", "today");
    await expect(me.locator("#rview")).toBeHidden();
  });
});

// ── the admin reads every profile: a profile with nothing stored, and back to alice ──────────────

test.describe("Recovery view, as the admin", () => {
  test("a profile with nothing stored says so, and offers no Sync", async ({ page, profile }) => {
    await loginAs(page, "admin", ADMIN_TOKEN);
    await page.goto("/#recovery");
    await expect(card(page)).toBeVisible();
    await expect(page.locator("#rProfile")).toBeVisible();
    await page.locator("#rProfile").selectOption(profile.name);
    await expect(page.locator("#rbody")).toHaveText("No health data is stored yet, and Garmin is not connected for this profile to fetch it.");
    await expect(page.locator("#rSync")).toBeHidden();
    await expect(page.locator("#rNote")).toBeHidden();
    await expect(page.locator("#rNext")).toBeDisabled();
  });

  test("switching the profile picker goes between alice's days and an empty profile", async ({ page, profile }) => {
    await loginAs(page, "admin", ADMIN_TOKEN);
    await page.goto("/#recovery");
    await page.locator("#rProfile").selectOption("alice");
    await expect(card(page)).toBeVisible();
    await openData(page);
    await expect(rows(page)).toHaveCount(30);
    await page.locator("#rProfile").selectOption(profile.name);
    await expect(page.locator("#rbody")).toContainText("No health data is stored yet");
    await expect(rows(page)).toHaveCount(0);
    await page.locator("#rProfile").selectOption("alice");
    await expect(rows(page)).toHaveCount(30);
  });
});

// ── failures: the view says why, and keeps what it had ─────────────────────────────────────────

test.describe("Recovery view, when the server fails", () => {
  test("a failed load says why, in the view and in the note", async ({ alice }) => {
    await alice.route(/\/api\/wellness\?/, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The database is busy" }) }));
    await alice.goto("/#recovery");
    await expect(alice.locator("#rbody .msg.err")).toHaveText("The database is busy");
    await expect(alice.locator("#rNote")).toHaveText("The database is busy");
    await expect(alice.locator("#rNote")).toHaveClass(/err/);
    await expect(card(alice)).toHaveCount(0);
  });

  test("a failed refresh keeps the day on screen and says why, and the next good answer clears it", async ({ alice, admin }) => {
    const data = await wellness(admin, "days=30");
    let failing = false;
    await alice.route(/\/api\/wellness\?/, (route) =>
      failing ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The database is busy" }) }) : route.continue(),
    );
    await openRecovery(alice);
    await expect(card(alice)).toBeVisible();
    failing = true;
    await alice.locator("#rPrev").click();
    await expect(alice.locator("#rNote")).toHaveText("The database is busy");
    await expect(alice.locator("#rNote")).toHaveClass(/err/);
    await expect(card(alice)).toContainText(label(data.today)); // what was on screen stays
    await expect(alice.locator("#rDate")).toHaveValue(data.today);
    failing = false;
    await alice.locator("#rPrev").click();
    await expect(alice.locator("#rDate")).toHaveValue(addDays(data.today, -1));
    await expect(alice.locator("#rNote")).not.toHaveClass(/err/);
    await expect(alice.locator("#rNote")).toContainText("45 days stored");
  });

  test("a raw response that fails shows the reason in its box", async ({ alice }) => {
    await alice.route(/\/api\/wellness\/raw\?/, (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "No sleep data is stored for that day." }) }));
    await openRecovery(alice);
    await openData(alice, true);
    const sleep = alice.locator("#rbody details.rraw").nth(1);
    await sleep.locator("summary").click();
    await expect(sleep.locator("pre")).toHaveText("No sleep data is stored for that day.");
  });
});
