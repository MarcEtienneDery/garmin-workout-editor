/**
 * The Food view against the day's goals: the calorie ring and what is left in its middle, the macro bars, the nutrient bars under the
 * summary, a calorie goal that follows the burn, the trend charts with their goal lines, and the goals of the profiles. The goals are set
 * through the API (`POST /api/settings/goals`); the log itself is food-log.spec.ts.
 *
 * alice's goals (2,200 kcal, 130 g protein, 250 g carbs, 70 g fat) are read on her past days; every test that sets a goal or
 * logs food makes a profile of its own.
 */
import { type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { type Profile, test as base, expect as baseExpect, openView, today, daysAgo, loginAs, ADMIN_TOKEN, PASSWORD } from "../support/fixtures";
import { dayLine, enterByHand, labelOf, macro, nutrientRow, nutrients, openFood, ring, ringBig, ringSmall, summary } from "../support/food";

/**
 * The fixtures send the sign-ins and the profile's creation again when the connection was reset; the API calls a test makes itself are
 * sent again here, for the same reason: the server had closed an idle connection and did not read the request, so it writes nothing twice.
 */
async function sent<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= 4 || !/ECONNRESET/.test(String(error))) throw error;
    }
  }
}

/** An API client whose GET and POST are sent again when the connection was reset (see `sent`). */
function reliable<A extends APIRequestContext>(api: A): A {
  return new Proxy(api, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "get" || prop === "post") return (...args: unknown[]) => sent(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The page's assertions wait this long: the server is shared by every spec of the run and answers slowly when it is busy. */
const expect = baseExpect.configure({ timeout: 20_000 });

const test = base.extend<{ admin: APIRequestContext; profile: Profile }>({
  admin: async ({ admin }, use) => use(reliable(admin)),
  profile: async ({ profile }, use) => use({ ...profile, api: reliable(profile.api) }),
});
test.describe.configure({ timeout: 120_000 }); // a busy server can take a minute to answer a page of the log

type Goals = Partial<Record<"kcal" | "kcalBurnPct" | "proteinG" | "carbsG" | "fatG" | "fiberG" | "sugarsG" | "satFatG" | "sodiumMg" | "potassiumMg", number | null>>;

/** Sets goals through the API as the profile (a number sets, null removes, a key left out stays). */
async function setGoals(api: APIRequestContext, goals: Goals): Promise<void> {
  const r = await api.post("/api/settings/goals", { data: { action: "save", goals } });
  if (!r.ok()) throw new Error(`Could not set goals: ${r.status()} ${await r.text()}`);
}

interface Food {
  name: string;
  kcal?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  nutrients?: Record<string, number>;
}

/** Logs foods through the API as the profile, to a day and a meal; they are all written or none. */
async function addFoods(api: APIRequestContext, day: string, meal: string, items: Food[]): Promise<void> {
  const r = await api.post("/api/nutrition", { data: { action: "add", day, meal, items } });
  if (!r.ok()) throw new Error(`Could not log foods: ${r.status()} ${await r.text()}`);
}

/** The trend chart whose title starts with `title`. */
const chart = (page: Page, title: string): Locator => page.locator(".rcharts .rc").filter({ hasText: title }).first();
/** The widths (in percent of the track) of the segments of a bar, as the page set them. */
async function widthsOf(locator: Locator): Promise<number[]> {
  return locator.evaluateAll((els) => els.map((el) => parseFloat((el as HTMLElement).style.width)));
}

/** The position (in percent of the track) of a bar's tick, when it has one. */
async function tickOf(locator: Locator): Promise<number | null> {
  const ticks = await locator.locator(".ftick").evaluateAll((els) => els.map((el) => parseFloat((el as HTMLElement).style.left)));
  return ticks.length ? ticks[0] : null;
}

/** A nutrient's line under the summary, by its label: its class says the state and the kind of goal. */
const nutrient = (page: Page, label: string): Locator => nutrientRow(page, label).locator(".fmr");

const RING = 2 * Math.PI * 42, GAP = 1.6; // the ring's radius in its 100-unit box, and the gap the page leaves between two arcs

/** The share of the ring (in percent) each macro's arc covers, as the page set it: { protein: 10, carbs: 20, fat: 9 }. */
async function arcsOf(page: Page): Promise<Record<string, number>> {
  const arcs = await ring(page).locator("circle.arc").evaluateAll((els) => els.map((el) => [el.getAttribute("class")!.replace("arc ", ""), parseFloat((el as SVGElement).style.strokeDasharray)] as [string, number]));
  return Object.fromEntries(arcs.map(([cls, dash]) => [cls, ((dash + GAP) / RING) * 100]));
}

/** Where round the ring (in percent, from the top) its tick for the goal is, when it has one. */
async function goalTickOf(page: Page): Promise<number | null> {
  const ticks = await ring(page).locator(".gtick").evaluateAll((els) => els.map((el) => [Number(el.getAttribute("x1")), Number(el.getAttribute("y1"))]));
  if (!ticks.length) return null;
  const [x, y] = ticks[0], a = Math.atan2(y - 50, x - 50);
  return ((a < 0 ? a + 2 * Math.PI : a) / (2 * Math.PI)) * 100;
}

/** Shows the day again after the log or the goals changed through the API: the page does not follow the API by itself. */
async function reopenFood(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#fbody .fsum")).toBeVisible();
}

test.describe("Food goals: the day's calorie ring", () => {
  test("the ring splits the calories eaten into protein, carbs and fat against the goal, and says what is left in its middle", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Bowl", proteinG: 50, carbsG: 100, fatG: 20 }]);
    await openFood(me);
    // 780 kcal: protein 200, carbs 400, fat 180, on a ring of 2,000 kcal
    await expect.poll(() => arcsOf(me)).toEqual({ protein: expect.closeTo(10, 0), carbs: expect.closeTo(20, 0), fat: expect.closeTo(9, 0) });
    await expect(ringBig(me)).toHaveText("1,220");
    await expect(ringSmall(me)).toHaveText("kcal left");
    await expect(dayLine(me)).toHaveText("780 kcal eaten · goal 2,000 kcal");
    await expect(ring(me)).toHaveClass(/st-short/);
    await expect(ring(me)).toHaveAttribute("aria-label", "780 kcal eaten · 1,220 kcal left · goal 2,000 kcal");
    await expect(ring(me).locator(".gtick")).toHaveCount(0);
    await expect(me.locator("#fbody .fcard .fleg span")).toHaveText(["Protein 26 %", "Carbs 51 %", "Fat 23 %"]);
  });

  test("the ring's arcs add up to the share of the goal eaten", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Bowl", proteinG: 50, carbsG: 100, fatG: 20 }]);
    await openFood(me);
    await expect.poll(async () => Object.values(await arcsOf(me)).reduce((a, b) => a + b, 0)).toBeCloseTo(39, 0); // 780 / 2,000 = 39 %
  });

  test("over the calorie goal the ring says by how much, and ticks where the goal was passed", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000 });
    await addFoods(profile.api, today(), "dinner", [{ name: "Feast", kcal: 2400 }]);
    await openFood(me);
    await expect(ring(me)).toHaveClass(/st-over/);
    await expect(ringBig(me)).toHaveText("400");
    await expect(ringSmall(me)).toHaveText("kcal over");
    await expect(dayLine(me)).toHaveText("2,400 kcal eaten · goal 2,000 kcal");
    // the goal is at 2,000 of the 2,400 eaten: 83.33 % round the ring
    expect(await goalTickOf(me)).toBeCloseTo(83.33, 1);
  });

  test("the calorie state moves from short to on target to over as foods are added, on the tenth of the goal", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000 });
    await addFoods(profile.api, today(), "breakfast", [{ name: "Breakfast", kcal: 1700 }]);
    await openFood(me);
    await expect(ringBig(me)).toHaveText("300");
    await expect(ring(me)).toHaveClass(/st-short/);
    await enterByHand(me, "lunch", { name: "Lunch", kcal: "200" });
    await expect(ringBig(me)).toHaveText("100");
    await expect(ringSmall(me)).toHaveText("kcal left");
    await expect(ring(me)).toHaveClass(/st-ok/);
    await enterByHand(me, "dinner", { name: "Dinner", kcal: "400" });
    await expect(ringBig(me)).toHaveText("300");
    await expect(ringSmall(me)).toHaveText("kcal over");
    await expect(ring(me)).toHaveClass(/st-over/);
  });

  test("a day nothing was logged on says the goal and nothing logged, with no arc drawn", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000, proteinG: 100 });
    await openFood(me);
    await expect(ringBig(me)).toHaveText("–");
    await expect(ringSmall(me)).toHaveText("of 2,000 kcal");
    await expect(dayLine(me)).toHaveText("Nothing logged · goal 2,000 kcal");
    await expect(ring(me).locator("circle.arc")).toHaveCount(0);
    await expect(ring(me)).toHaveClass(/st-unknown/);
    await expect(macro(me, "protein").locator(".fv")).toHaveText("– / 100 g");
    await expect(macro(me, "protein").locator(".fmn")).toHaveText("nothing logged");
    await expect(macro(me, "protein").locator(".fmeter")).toHaveCount(0);
  });

  test("the ring moves to the day as it is now when a food is added", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Rice", carbsG: 100 }]);
    await openFood(me);
    await expect.poll(() => arcsOf(me)).toEqual({ carbs: expect.closeTo(20, 0) });
    await enterByHand(me, "dinner", { name: "Steak", P: "100" });
    await expect.poll(() => arcsOf(me)).toEqual({ protein: expect.closeTo(20, 0), carbs: expect.closeTo(20, 0) });
    await expect(ringBig(me)).toHaveText("1,200");
  });

  test("alice's 1,695 kcal on her past days is 77 % of her 2,200 kcal goal, with the goal drawn on the trend", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fPrev").click();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(ringBig(alice)).toHaveText("505");
    await expect.poll(async () => Object.values(await arcsOf(alice)).reduce((a, b) => a + b, 0)).toBeCloseTo(77.05, 0); // 1,695 / 2,200
    await expect(dayLine(alice)).toHaveText("1,695 kcal eaten · goal 2,200 kcal");
    await expect(chart(alice, "Calories eaten").locator(".rcl")).toContainText("Goal 2,200 kcal");
  });

  test("alice's past day shows each meal's share of the 2,200 kcal goal", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fPrev").click();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
    const rows = alice.locator("#fbody .fcard").first().locator(".fmeal-row");
    await expect(rows.nth(0).locator(".fmn")).toHaveText("P 11 · C 81 · F 5 · 18 % of the goal");
    await expect(rows.nth(1).locator(".fmn")).toHaveText("P 34 · C 48 · F 20 · 24 % of the goal");
    await expect(rows.nth(2).locator(".fmn")).toHaveText("P 41 · C 62 · F 24 · 29 % of the goal");
    await expect(rows.nth(3).locator(".fmn")).toHaveText("P 17 · C 8 · F 3 · 6 % of the goal");
  });

  test("alice's today has her goals and nothing logged against them", async ({ alice }) => {
    await openFood(alice);
    await expect(dayLine(alice)).toHaveText("Nothing logged · goal 2,200 kcal");
    await expect(macro(alice, "protein").locator(".fv")).toHaveText("– / 130 g");
    await expect(macro(alice, "carbs").locator(".fv")).toHaveText("– / 250 g");
    await expect(macro(alice, "fat").locator(".fv")).toHaveText("– / 70 g");
  });

  test("the add sheet's foot has the day against its goal too, as a bar, with what is left", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Bowl", proteinG: 50, carbsG: 100, fatG: 20 }]);
    await openFood(me);
    await me.locator("#fdSearch").click();
    const foot = me.locator("#fsh .fsh-foot");
    await expect(foot).toContainText("780 / 2,000 kcal · 1,220 left");
    expect(await widthsOf(foot.locator(".fmeter .fseg"))).toEqual([expect.closeTo(10, 3), expect.closeTo(20, 3), expect.closeTo(9, 3)]);
  });
});

test.describe("Food goals: the macros", () => {
  test("protein is a floor: short until the goal, then reached, with a tick where it was passed", async ({ me, profile }) => {
    await setGoals(profile.api, { proteinG: 100 });
    await addFoods(profile.api, today(), "breakfast", [{ name: "Eggs", proteinG: 53 }]);
    await openFood(me);
    await expect(macro(me, "protein")).toHaveClass(/st-short/);
    await expect(macro(me, "protein")).toHaveClass(/k-min/);
    await expect(macro(me, "protein").locator(".fv")).toHaveText("53 / 100 g");
    await expect(macro(me, "protein").locator(".fmn")).toHaveText("47 g to go");
    await expect(macro(me, "protein").locator(".fmeter .fseg")).toHaveCount(1);
    expect(await tickOf(macro(me, "protein").locator(".fmeter"))).toBeNull();
    await enterByHand(me, "dinner", { name: "Chicken", P: "60" });
    await expect(macro(me, "protein").locator(".fv")).toHaveText("113 / 100 g");
    await expect(macro(me, "protein").locator(".fmn")).toHaveText("✓ reached");
    await expect(macro(me, "protein")).toHaveClass(/st-ok/);
    expect(await tickOf(macro(me, "protein").locator(".fmeter"))).toBeCloseTo(88.5, 1); // the goal of 100 within 113
  });

  test("carbs and fat are aims within a tenth: short below, on target within, over above, with the amount over", async ({ me, profile }) => {
    await setGoals(profile.api, { carbsG: 250, fatG: 70 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Pasta", carbsG: 200, fatG: 65 }]);
    await openFood(me);
    await expect(macro(me, "carbs").locator(".fmn")).toHaveText("50 g to go");
    await expect(macro(me, "carbs")).toHaveClass(/st-short/);
    await expect(macro(me, "carbs")).toHaveClass(/k-target/);
    await expect(macro(me, "fat").locator(".fmn")).toHaveText("✓ on target");
    await expect(macro(me, "fat")).toHaveClass(/st-ok/);
    await enterByHand(me, "dinner", { name: "Rice", C: "70" });
    await expect(macro(me, "carbs").locator(".fv")).toHaveText("270 / 250 g");
    await expect(macro(me, "carbs").locator(".fmn")).toHaveText("✓ on target");
    await expect(macro(me, "carbs")).toHaveClass(/st-ok/);
    await enterByHand(me, "snack", { name: "Cookies", C: "40", F: "25" });
    await expect(macro(me, "carbs").locator(".fmn")).toHaveText("▲ over by 60 g");
    await expect(macro(me, "carbs")).toHaveClass(/st-over/);
    await expect(macro(me, "fat").locator(".fmn")).toHaveText("▲ over by 20 g");
    await expect(macro(me, "fat")).toHaveClass(/st-over/);
    expect(await tickOf(macro(me, "carbs").locator(".fmeter"))).toBeCloseTo(80.65, 1); // 250 of the 310 eaten
  });

  test("the macros' rows without a goal show the grams only, with no bar", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Toast", carbsG: 30, fatG: 4 }]);
    await openFood(me);
    await expect(macro(me, "carbs").locator(".fv")).toHaveText("30 g");
    await expect(macro(me, "carbs").locator(".fmeter")).toHaveCount(0);
    await expect(macro(me, "protein").locator(".fv")).toHaveText("0 g"); // a day's macros are sums: a food with none adds 0
  });
});

test.describe("Food goals: the nutrients", () => {
  test("the nutrients with a goal come first under the summary, in the list's order, each with its bar and its wording", async ({ me, profile }) => {
    await setGoals(profile.api, { fiberG: 25, sugarsG: 50, satFatG: 20, sodiumMg: 2300 });
    await addFoods(profile.api, today(), "breakfast", [{ name: "Oats", kcal: 380, proteinG: 13, carbsG: 60, fatG: 7, nutrients: { fiberG: 8, sodiumMg: 300 } }]);
    await addFoods(profile.api, today(), "lunch", [{ name: "Burger", kcal: 1000, proteinG: 40, carbsG: 80, fatG: 58, nutrients: { sodiumMg: 2000, sugarsG: 60 } }]);
    await openFood(me);
    await nutrients(me);
    await expect(summary(me).locator(".fnuts .fnrow .fmr > b")).toHaveText(["Fiber", "Sugars", "Saturated fat", "Sodium", "Trans fat", "Cholesterol", "Potassium", "Calcium", "Iron"]);
    // fiber: a floor, from one of the two foods only, so it is "at least" and "up to" what is left
    const fiber = nutrient(me, "Fiber");
    await expect(fiber).toHaveClass(/k-min/);
    await expect(fiber).toHaveClass(/st-short/);
    await expect(fiber.locator(".fv")).toHaveText("≥ 8 / 25 g");
    await expect(fiber.locator(".fmn")).toHaveText("up to 17 g to go");
    await expect(fiber.locator(".fmeter")).toHaveCount(1);
    // sugars: a ceiling, passed by the one food that states it
    const sugars = nutrient(me, "Sugars");
    await expect(sugars).toHaveClass(/k-max/);
    await expect(sugars).toHaveClass(/st-over/);
    await expect(sugars.locator(".fv")).toHaveText("≥ 60 / 50 g");
    await expect(sugars.locator(".fmn")).toHaveText("▲ over by at least 10 g");
    // sodium: a ceiling both foods state, at it exactly: on it, nothing left
    const sodium = nutrient(me, "Sodium");
    await expect(sodium).toHaveClass(/k-max/);
    await expect(sodium).toHaveClass(/st-ok/);
    await expect(sodium.locator(".fv")).toHaveText("2,300 / 2,300 mg");
    await expect(sodium.locator(".fmn")).toHaveText("0 mg left");
  });

  test("a floor reached and a ceiling under its goal say so: reached, and what is left", async ({ me, profile }) => {
    await setGoals(profile.api, { fiberG: 25, sodiumMg: 2300 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Beans", kcal: 500, proteinG: 30, carbsG: 60, fatG: 4, nutrients: { fiberG: 30, sodiumMg: 1000 } }]);
    await openFood(me);
    await nutrients(me);
    const fiber = nutrient(me, "Fiber");
    await expect(fiber).toHaveClass(/st-ok/);
    await expect(fiber.locator(".fv")).toHaveText("30 / 25 g");
    await expect(fiber.locator(".fmn")).toHaveText("✓ reached");
    const sodium = nutrient(me, "Sodium");
    await expect(sodium).toHaveClass(/st-ok/);
    await expect(sodium.locator(".fv")).toHaveText("1,000 / 2,300 mg");
    await expect(sodium.locator(".fmn")).toHaveText("1,300 mg left");
  });

  test("a nutrient no food states is unknown: no amount, no bar, and the wording says no food states it", async ({ me, profile }) => {
    await setGoals(profile.api, { potassiumMg: 3000 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Plain toast", kcal: 100, carbsG: 20 }]);
    await openFood(me);
    await nutrients(me);
    const potassium = nutrient(me, "Potassium");
    await expect(potassium).toHaveClass(/st-unknown/);
    await expect(potassium.locator(".fv")).toHaveText("– / 3,000 mg");
    await expect(potassium.locator(".fmn")).toHaveText("no food states it");
    await expect(potassium.locator(".fmeter")).toHaveCount(0);
  });

  test("nutrients without a goal follow the goals as amounts, a total saying how many foods state it", async ({ me, profile }) => {
    await setGoals(profile.api, { fiberG: 25 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Apple", kcal: 95, nutrients: { fiberG: 4, sugarsG: 19 } }, { name: "Cola", kcal: 140, nutrients: { sugarsG: 39 } }]);
    await openFood(me);
    await nutrients(me);
    await expect(summary(me).locator(".fnuts .fnrow")).toHaveCount(9);
    const sugars = nutrient(me, "Sugars");
    await expect(sugars).toHaveClass(/st-none/); // no goal: no state, the amount as it is
    await expect(sugars.locator(".fv")).toHaveText("58 g");
    await expect(sugars.locator(".fmn")).toHaveText("from all 2 foods");
    const calcium = nutrient(me, "Calcium");
    await expect(calcium.locator(".fv")).toHaveText("–");
    await expect(calcium.locator(".fmn")).toHaveText("no food states it");
  });

  test("the nutrients are shut under the summary, their line says each goal, and a tap opens them, which another day keeps", async ({ me, profile }) => {
    await setGoals(profile.api, { fiberG: 25, sodiumMg: 2300 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Beans", kcal: 500, proteinG: 30, carbsG: 60, fatG: 4, nutrients: { fiberG: 30, sodiumMg: 1000 } }]);
    await openFood(me);
    const box = summary(me).locator("details.fnuts");
    await expect(box).not.toHaveAttribute("open", "");
    await expect(box.locator(".fnbrief span")).toHaveText(["Fiber 30 / 25 g", "Sodium 1,000 / 2,300 mg"]);
    await expect(box.locator(".fnbrief span").first()).toHaveClass(/st-ok/);
    await expect(nutrient(me, "Fiber")).toBeHidden();
    await nutrients(me);
    await expect(nutrient(me, "Fiber")).toBeVisible();
    await me.locator("#fPrev").click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(box).toHaveAttribute("open", "");
  });

  test("without nutrient goals their line names a few of them, or says nothing is logged", async ({ me, profile }) => {
    await openFood(me);
    await expect(summary(me).locator(".fnuts .fnbrief")).toHaveText("nothing logged");
    await addFoods(profile.api, today(), "lunch", [{ name: "Toast", kcal: 100 }]);
    await reopenFood(me);
    await expect(summary(me).locator(".fnuts .fnbrief")).toHaveText("fiber, sodium, sugars…");
  });
});

test.describe("Food goals: the calorie goal that follows the burn", () => {
  test("a profile with no Garmin burn keeps the calorie goal as set, and says so under the bar", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000, kcalBurnPct: 50 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Lunch", kcal: 620 }]);
    await openFood(me);
    await expect(summary(me).locator(".fburn").last()).toHaveText("Goal 2,000 kcal as set: no burn from Garmin for this day to add to it");
    await expect(ringBig(me)).toHaveText("1,380");
    await expect(dayLine(me)).toHaveText("620 kcal eaten · goal 2,000 kcal");
    const progress = (await (await profile.api.get("/api/nutrition?days=7")).json()).progress;
    expect(progress.find((p: any) => p.key === "kcal")).toMatchObject({ goal: 2000, amount: 620, adjust: { base: 2000, pct: 50, activeKcal: null, added: null } });
    await expect(chart(me, "Calories eaten").locator(".rcl")).toContainText("Goal 2,000 kcal + 50 % of active");
  });

  test("turning the share off again removes the note and the + from the goal line", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000, kcalBurnPct: 50 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Lunch", kcal: 500 }]); // the chart draws a legend for a day with food
    await openFood(me);
    await expect(chart(me, "Calories eaten").locator(".rcl")).toContainText("+ 50 % of active");
    await setGoals(profile.api, { kcalBurnPct: null });
    await reopenFood(me);
    await expect(summary(me).locator(".fburn")).toHaveCount(0);
    await expect(chart(me, "Calories eaten").locator(".rcl")).toContainText("Goal 2,000 kcal");
    await expect(chart(me, "Calories eaten").locator(".rcl")).not.toContainText("active");
  });

  test("a share of the burn needs a calorie goal, and a share out of 1 to 100 % is refused", async ({ profile }) => {
    const alone = await profile.api.post("/api/settings/goals", { data: { action: "save", goals: { kcalBurnPct: 50 } } });
    expect(alone.status()).toBe(400);
    expect((await alone.json()).error).toContain("Set a calorie goal to add the burned calories to.");
    await setGoals(profile.api, { kcal: 2000 });
    const over = await profile.api.post("/api/settings/goals", { data: { action: "save", goals: { kcalBurnPct: 101 } } });
    expect(over.status()).toBe(400);
    expect((await over.json()).error).toContain("from 1 to 100 %");
    const zero = await profile.api.post("/api/settings/goals", { data: { action: "save", goals: { kcalBurnPct: 0 } } });
    expect(zero.status()).toBe(400);
  });
});

test.describe("Food goals: the trend charts", () => {
  test("the calorie trend draws its goal as a dashed line, labelled in the legend", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Lunch", kcal: 700 }]);
    await openFood(me);
    const calories = chart(me, "Calories eaten");
    await expect(calories).toBeVisible();
    await expect(calories.locator("svg .rc-goal")).toHaveCount(1);
    expect(await calories.locator("svg .rc-goal").evaluate((el) => getComputedStyle(el).strokeDasharray)).not.toBe("none");
    await expect(calories.locator(".rcl")).toContainText("Goal 2,000 kcal");
  });

  test("the protein chart appears only with a protein goal, and draws that goal", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Lunch", kcal: 500, proteinG: 30 }]);
    await openFood(me);
    await expect(me.locator(".rcharts .rch b").filter({ hasText: /^Calories eaten/ })).toHaveCount(1);
    await expect(me.locator(".rcharts .rch b").filter({ hasText: /^Protein \(g\)/ })).toHaveCount(0);
    await setGoals(profile.api, { proteinG: 100 });
    await reopenFood(me);
    const protein = chart(me, "Protein (g)");
    await expect(protein).toBeVisible();
    await expect(protein.locator("svg .rc-goal")).toHaveCount(1);
    await expect(protein.locator(".rcl")).toContainText("Goal 100 g");
  });

  test("without a calorie goal the calorie chart has no goal line, and the macros chart stacks each day", async ({ me, profile }) => {
    await setGoals(profile.api, { proteinG: 100 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Chicken", kcal: 300, proteinG: 40, carbsG: 0, fatG: 10 }]);
    await openFood(me);
    await expect(chart(me, "Calories eaten").locator("svg .rc-goal")).toHaveCount(0);
    await expect(chart(me, "Macros").locator("svg .rc-part.protein")).not.toHaveCount(0);
    await expect(chart(me, "Macros").locator("svg .rc-part.fat")).not.toHaveCount(0);
  });

  test("the protein readout of a picked day gives its grams and its share of the goal", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fPrev").click();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(chart(alice, "Protein (g)").locator(".rcr")).toHaveText(`${labelOf(daysAgo(1))}: 103 g · 79 % of the goal`);
  });
});

test.describe("Food goals: the profiles and the goals' own rules", () => {
  test("clearing the goals removes the bars, and the hint sends the person to Settings", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000, proteinG: 100 });
    await addFoods(profile.api, today(), "lunch", [{ name: "Lunch", kcal: 300, proteinG: 10 }]);
    await openFood(me);
    await expect(ringBig(me)).toHaveText("1,700");
    expect(await (await profile.api.post("/api/settings/goals", { data: { action: "clear" } })).json()).toMatchObject({ goals: { values: {} } });
    await reopenFood(me);
    await expect(dayLine(me)).toHaveText("1 food");
    await expect(ringBig(me)).toHaveText("300");
    await expect(ringSmall(me)).toHaveText("kcal eaten");
    await expect(ring(me)).toHaveClass(/st-none/);
    await expect(summary(me).locator(".fmacs .fmr .fmn")).toHaveCount(0);
    await expect(summary(me).locator(".fgoalhint")).toContainText("Set daily goals to follow your progress through the day.");
    await summary(me).locator(".fgoalhint button").click();
    await expect(me.locator("body")).toHaveAttribute("data-view", "settings");
  });

  test("the goals are the profile's own: a profile without goals shows none, where the admin switches to it", async ({ page, profile, admin }) => {
    await setGoals(profile.api, { kcal: 1800 });
    const made = await admin.post("/api/profiles", { data: { name: `bare${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, password: PASSWORD, confirm: PASSWORD } });
    expect(made.status()).toBe(201);
    const bareName: string = (await made.json()).name;
    await loginAs(page, "admin", ADMIN_TOKEN);
    await openFood(page);
    await page.locator("#fProfile").selectOption(profile.name);
    await expect(dayLine(page)).toHaveText("Nothing logged · goal 1,800 kcal");
    await page.locator("#fProfile").selectOption(bareName);
    await expect(summary(page).locator(".fgoalhint")).toBeVisible();
    await expect(dayLine(page)).toHaveText("Nothing logged");
  });

  test("the goals are saved as numbers, a key left out stays, and null removes one", async ({ profile }) => {
    await setGoals(profile.api, { kcal: 2000, proteinG: 100, fatG: 70 });
    await setGoals(profile.api, { proteinG: null });
    await setGoals(profile.api, { carbsG: 250 });
    const r = await profile.api.get("/api/settings");
    expect((await r.json()).goals.values).toEqual({ kcal: 2000, fatG: 70, carbsG: 250 });
  });

  test("a goal of zero, a number that is not a goal and an out-of-range goal are refused", async ({ profile }) => {
    const refused = [
      { goals: { kcal: 0 }, error: "must be a number above 0" },
      { goals: { fibreG: 3 }, error: "not a goal" },
      { goals: { proteinG: "lots" }, error: "must be a number above 0" },
      { goals: { kcal: 20000 }, error: "at most 10000 kcal" },
      { goals: { fiberG: 2001 }, error: "at most 2000 g" },
    ];
    for (const { goals, error } of refused) {
      const r = await profile.api.post("/api/settings/goals", { data: { action: "save", goals } });
      expect(r.status(), JSON.stringify(goals)).toBe(400);
      expect((await r.json()).error).toContain(error);
    }
    const empty = await profile.api.post("/api/settings/goals", { data: { action: "save" } });
    expect(empty.status()).toBe(400);
    const unknownAction = await profile.api.post("/api/settings/goals", { data: { action: "explode" } });
    expect(unknownAction.status()).toBe(400);
    expect((await (await profile.api.get("/api/settings")).json()).goals.values).toEqual({});
  });

  test("the Settings card counts the goals set, and shows the calorie goal in its field", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000, proteinG: 100, sodiumMg: 2300 });
    await openView(me, "settings");
    await expect(me.locator(".scard").filter({ hasText: "Nutrition goals" }).locator(".chip")).toHaveText("3 set");
    await expect(me.locator("#s-goal_kcal")).toHaveValue("2000");
    await expect(me.locator("#s-goal_proteinG")).toHaveValue("100");
    await expect(me.locator("#s-goal_sodiumMg")).toHaveValue("2300");
  });
});
