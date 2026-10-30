/**
 * The Food view's log: the days, entering a food by hand and its checks, editing and deleting, undo, copying to today, the
 * totals of a meal and a day, the profiles that may see the log, and what the API keeps of it. Finding foods (search, barcode,
 * recent, AI) is food-find.spec.ts; the goals and their bars are food-goals.spec.ts.
 *
 * alice's log is read-only here (she has the past five days, nothing today): every test that writes makes a profile of its own.
 */
import { type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { type Profile, test as base, expect as baseExpect, today, daysAgo, daysAhead, loginAs, ADMIN_TOKEN, PASSWORD } from "../support/fixtures";

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

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The label the Food view gives a day: "Thu 29 Oct". */
const labelOf = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};

interface Food {
  name: string;
  kcal?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  nutrients?: Record<string, number | null>;
}

interface Entry extends Food {
  id: number;
  meal: string;
  day: string;
  source: string;
  nutrients: Record<string, number>;
}

/** Logs foods through the API as the profile, to a day and a meal; they are all written or none. */
async function addFoods(api: APIRequestContext, day: string, meal: string, items: Food[]): Promise<void> {
  const r = await api.post("/api/nutrition", { data: { action: "add", day, meal, items } });
  if (!r.ok()) throw new Error(`Could not log foods: ${r.status()} ${await r.text()}`);
}

/** The log of a day as the API answers it (the meals with their entries and totals). */
async function dayOf(api: APIRequestContext, day: string, profile?: string) {
  const r = await api.get(`/api/nutrition?days=7&date=${day}${profile ? `&profile=${encodeURIComponent(profile)}` : ""}`);
  if (!r.ok()) throw new Error(`Could not read the log: ${r.status()} ${await r.text()}`);
  return r.json();
}

/** Every entry of a day, in the order of the meals. */
const entriesOf = (json: any): Entry[] => json.day.meals.flatMap((m: any) => m.entries);

/** One meal of the day on the page: its section. */
const meal = (page: Page, m: string): Locator => page.locator(`#fbody section.fmeal[data-meal="${m}"]`);

/** The row of a food in a meal, by its name (a row is one button and, when open, its actions). */
const rowOf = (page: Page, m: string, name: string): Locator => meal(page, m).locator(".fe").filter({ hasText: name });

/** Opens a food's row (its nutrients and actions), once: a tap on an open row closes it. */
async function openRow(page: Page, m: string, name: string): Promise<Locator> {
  const row = rowOf(page, m, name), head = row.locator("button.fhead");
  await expect(head).toBeVisible();
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  return row;
}

/** The by-hand form of a meal, with its "Enter by hand" section opened. */
async function byHandForm(page: Page, m: string): Promise<Locator> {
  const hand = meal(page, m).locator("details.fhand");
  if (!(await hand.evaluate((el: HTMLDetailsElement) => el.open))) await hand.locator("summary").first().click();
  return hand.locator("form.fform");
}

/** The field of the form for a key: "name", "kcal", "P", "C", "F", or a nutrient's own label such as "Fiber (g)". */
function fieldOf(form: Locator, key: string): Locator {
  if (key === "name") return form.locator(".fname");
  return form.locator(`input[aria-label="${key === "P" ? "P g" : key === "C" ? "C g" : key === "F" ? "F g" : key}"]`);
}

/** Fills the form's fields given by key; an empty string leaves the field empty. Opens "More nutrients" when a nutrient is filled. */
async function fillForm(form: Locator, draft: Record<string, string>): Promise<void> {
  if (Object.keys(draft).some((key) => key.includes("("))) {
    const more = form.locator("details.fmore");
    if (!(await more.evaluate((el: HTMLDetailsElement) => el.open))) await more.locator("summary").first().click();
  }
  for (const [key, value] of Object.entries(draft)) await fieldOf(form, key).fill(value);
}

/**
 * Enters a food by hand in a meal with the given fields and presses Add. A food that is saved is waited for in its meal before the
 * function returns (the page drops a second add while one is being saved); `refused` for a food the page is meant to refuse.
 */
async function enterByHand(page: Page, m: string, draft: Record<string, string>, { refused = false, shown }: { refused?: boolean; shown?: string } = {}): Promise<void> {
  const form = await byHandForm(page, m);
  await fillForm(form, draft);
  await form.locator('button[type="submit"]').click();
  if (refused) return;
  const name = (shown ?? draft.name ?? "").trim().replace(/\s+/g, " ");
  await expect(meal(page, m).locator(".fn", { hasText: name })).toBeVisible();
}

/** The toast: its message, and an Undo button when the action has one. */
const toast = (page: Page): Locator => page.locator("#toast");

/**
 * Opens the Food view and waits until its day is drawn: the day buttons do nothing before the first load. A load that lands on
 * another view (seen now and then on a busy server) is reloaded, as a person would.
 */
async function openFood(page: Page): Promise<void> {
  await page.goto("/#food", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#fbody .fsum")).toBeVisible({ timeout: 10_000 }).catch(() => page.reload({ waitUntil: "domcontentloaded" }));
  await expect(page.locator("#fbody .fsum")).toBeVisible();
}

test.describe("Food log: days", () => {
  test("opens on today, which is the day after nothing and cannot be passed", async ({ me }) => {
    await openFood(me);
    await expect(me.locator("#fDate")).toHaveValue(today());
    await expect(me.locator("#fbody .fsum small")).toHaveText("Today");
    await expect(me.locator("#fNext")).toBeDisabled();
    await expect(me.locator("#fPrev")).toBeEnabled();
  });

  test("◀ goes to the day before, shows its totals, and ▶ comes back to today", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fPrev").click();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(alice.locator("#fbody .fsum small")).toHaveText(labelOf(daysAgo(1)));
    await expect(alice.locator("#fbody .fhero b")).toHaveText("1,695");
    await expect(alice.locator("#fNext")).toBeEnabled();
    await alice.locator("#fNext").click();
    await expect(alice.locator("#fDate")).toHaveValue(today());
    await expect(alice.locator("#fbody .fsum small")).toHaveText("Today");
    await expect(alice.locator("#fNext")).toBeDisabled();
  });

  test("◀ steps back one day at a time, and ▶ cannot pass today", async ({ alice }) => {
    await openFood(alice);
    for (const back of [1, 2, 3]) {
      await alice.locator("#fPrev").click();
      await expect(alice.locator("#fDate")).toHaveValue(daysAgo(back));
    }
    for (const back of [2, 1, 0]) {
      await alice.locator("#fNext").click();
      await expect(alice.locator("#fDate")).toHaveValue(daysAgo(back));
    }
    await expect(alice.locator("#fNext")).toBeDisabled();
  });

  test("the date picker goes to the day picked", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fDate").fill(daysAgo(4));
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(4));
    await expect(alice.locator("#fbody .fsum small")).toHaveText(labelOf(daysAgo(4)));
    await expect(alice.locator("#fbody .fhero b")).toHaveText("1,695");
  });

  test("a date after today is not shown: the picker goes to today", async ({ me }) => {
    await openFood(me);
    await me.locator("#fDate").fill(daysAhead(3));
    await expect(me.locator("#fDate")).toHaveValue(today());
    await expect(me.locator("#fbody .fsum small")).toHaveText("Today");
    await expect(me.locator("#fNext")).toBeDisabled();
  });

  test("Today goes back to today from a past day", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fPrev").click();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
    await alice.locator("#fToday").click();
    await expect(alice.locator("#fDate")).toHaveValue(today());
    await expect(alice.locator("#fbody .fsum small")).toHaveText("Today");
  });

  test("a past day with nothing logged says so, shows no copy bar and has no foods", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fDate").fill(daysAgo(20));
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(20));
    await expect(alice.locator("#fbody .fhero .fhn")).toContainText("nothing logged");
    await expect(alice.locator("#fbody .fhero b")).toHaveText("–");
    await expect(alice.locator("#fbody .fday")).toHaveCount(0);
    await expect(alice.locator("#fbody .fe")).toHaveCount(0);
    await expect(alice.locator("#fbody .fburn").first()).toContainText("Burned 2,600 kcal by Garmin");
  });

  test("a day in the Every day table opens when it is clicked", async ({ alice }) => {
    await openFood(alice);
    const row = alice.locator(".rmetrics tbody tr", { has: alice.locator("td.day", { hasText: labelOf(daysAgo(4)) }) });
    await row.click();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(4));
    await expect(alice.locator("#fbody .fhero b")).toHaveText("1,695");
  });

  test("the range picker shows 30 days by default, and 14 or 90 when it is changed", async ({ alice }) => {
    await openFood(alice);
    const rows = alice.locator(".rmetrics tbody tr");
    await expect(rows).toHaveCount(30);
    await expect(alice.locator("#fbody .frange")).toHaveValue("30");
    await alice.locator("#fbody .frange").selectOption("14");
    await expect(rows).toHaveCount(14);
    await alice.locator("#fbody .frange").selectOption("90");
    await expect(rows).toHaveCount(90);
  });

  test("a reload keeps the foods logged", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "lunch", [{ name: "Reload soup", kcal: 150 }]);
    await openFood(me);
    await expect(meal(me, "lunch").locator(".fn", { hasText: "Reload soup" })).toBeVisible();
    await me.reload({ waitUntil: "domcontentloaded" });
    await expect(me.locator("#fbody .fsum")).toBeVisible();
    await expect(meal(me, "lunch").locator(".fn", { hasText: "Reload soup" })).toBeVisible();
  });

  test.fixme("a reload keeps the day shown", async ({ alice }) => {
    // The app: after ◀ and a reload the Food view shows today again, not the day that was shown. The day is kept in the page's
    // memory only; the address stays `#food`, with no date in it. Expected: the day shown stays after a reload.
    await openFood(alice);
    await alice.locator("#fPrev").click();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
    await alice.reload();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
  });
});

test.describe("Food log: today when nothing is logged", () => {
  test("alice's today has no foods, nothing logged and the burn so far", async ({ alice }) => {
    await openFood(alice);
    await expect(alice.locator("#fbody .fhero .fhn")).toContainText("nothing logged");
    await expect(alice.locator("#fbody .fe")).toHaveCount(0);
    await expect(alice.locator("#fbody .fday")).toHaveCount(0);
    await expect(alice.locator("#fbody .fburn").first()).toHaveText("Burned 2,600 kcal so far by Garmin");
    await expect(alice.locator("#fbody .fcard").nth(1)).toContainText("Nothing logged.");
  });

  test("every meal of an empty day shows its search and the by-hand form, and no totals", async ({ me }) => {
    await openFood(me);
    for (const m of ["breakfast", "lunch", "dinner", "snack"]) {
      await expect(meal(me, m).locator(".fmh span")).toHaveCount(0);
      await expect(meal(me, m).locator(".fe")).toHaveCount(0);
      await expect(meal(me, m).locator("input.fq")).toBeVisible();
      await expect(meal(me, m).locator("details.fhand > summary")).toHaveText("Enter by hand");
    }
  });

  test("a new profile has no Garmin burn: no burn line, no Garmin column, and a hint to set goals", async ({ me }) => {
    await openFood(me);
    await expect(me.locator("#fbody .fhero .fhn")).toContainText("nothing logged");
    await expect(me.locator("#fbody .fburn")).toHaveCount(0);
    await expect(me.locator("#fbody .fgoalhint")).toContainText("Set daily goals to follow your progress through the day.");
    await expect(me.locator(".rmetrics th.g")).toHaveText(["Eaten", "Nutrients"]);
  });
});

test.describe("Food log: entering a food by hand", () => {
  test("adds a food with its name, calories and macros to its meal, and writes it to the log", async ({ me, profile }) => {
    await openFood(me);
    await enterByHand(me, "lunch", { name: "Test oats", kcal: "300", P: "10", C: "50", F: "5" });
    await expect(rowOf(me, "lunch", "Test oats").locator(".fk")).toHaveText("300 kcal");
    await expect(rowOf(me, "lunch", "Test oats").locator(".ft > .fm")).toHaveText("P 10 · C 50 · F 5");
    await expect(meal(me, "lunch").locator(".fmh > span")).toHaveText("300 kcal · P 10 · C 50 · F 5");
    const [entry] = entriesOf(await dayOf(profile.api, today()));
    expect(entry).toMatchObject({ name: "Test oats", kcal: 300, proteinG: 10, carbsG: 50, fatG: 5, meal: "lunch", day: today(), source: "web", nutrients: {} });
  });

  test("calories left empty are worked out as 4 kcal a gram of protein and carbs, and 9 of fat", async ({ me, profile }) => {
    await openFood(me);
    const form = await byHandForm(me, "dinner");
    await fillForm(form, { name: "Chili", P: "10", C: "50", F: "5" });
    await expect(form.locator('input[aria-label="kcal"]')).toHaveAttribute("placeholder", "≈ 285 kcal");
    await form.locator('button[type="submit"]').click();
    await expect(rowOf(me, "dinner", "Chili").locator(".fk")).toHaveText("285 kcal");
    const [entry] = entriesOf(await dayOf(profile.api, today()));
    expect(entry.kcal).toBe(285);
  });

  test("a food given one macro only is worked out from that macro", async ({ me, profile }) => {
    await openFood(me);
    const form = await byHandForm(me, "snack");
    await fillForm(form, { name: "Egg white", P: "20" });
    await expect(form.locator('input[aria-label="kcal"]')).toHaveAttribute("placeholder", "≈ 80 kcal");
    await form.locator('button[type="submit"]').click();
    await expect(rowOf(me, "snack", "Egg white").locator(".fk")).toHaveText("80 kcal");
    expect(entriesOf(await dayOf(profile.api, today()))[0].kcal).toBe(80);
  });

  test("calories typed are kept as typed, even where the macros would give another figure", async ({ me, profile }) => {
    await openFood(me);
    await enterByHand(me, "snack", { name: "Sports drink", kcal: "150", P: "0", C: "35", F: "0" });
    await expect(rowOf(me, "snack", "Sports drink").locator(".fk")).toHaveText("150 kcal");
    expect(entriesOf(await dayOf(profile.api, today()))[0].kcal).toBe(150);
  });

  test("a food with zero in every number is kept at 0 kcal, which is a number and not unknown", async ({ me, profile }) => {
    await openFood(me);
    await enterByHand(me, "breakfast", { name: "Water", kcal: "0", P: "0", C: "0", F: "0" });
    await expect(rowOf(me, "breakfast", "Water").locator(".fk")).toHaveText("0 kcal");
    expect(entriesOf(await dayOf(profile.api, today()))[0]).toMatchObject({ name: "Water", kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 });
  });

  test("grams with a decimal are kept to one decimal, and the calories are rounded", async ({ me, profile }) => {
    await openFood(me);
    const form = await byHandForm(me, "breakfast");
    await fillForm(form, { name: "Cheese slice", P: "10.5", C: "0.3", F: "2.2" });
    await expect(form.locator('input[aria-label="kcal"]')).toHaveAttribute("placeholder", "≈ 63 kcal");
    await form.locator('button[type="submit"]').click();
    await expect(rowOf(me, "breakfast", "Cheese slice").locator(".ft > .fm")).toHaveText("P 10.5 · C 0.3 · F 2.2");
    expect(entriesOf(await dayOf(profile.api, today()))[0]).toMatchObject({ kcal: 63, proteinG: 10.5, carbsG: 0.3, fatG: 2.2 });
  });

  test("the name is kept trimmed, with its inner spaces made one", async ({ me, profile }) => {
    await openFood(me);
    await enterByHand(me, "lunch", { name: "   Greek    yogurt  ", kcal: "120" }, { shown: "Greek yogurt" });
    await expect(rowOf(me, "lunch", "Greek yogurt").locator(".fn")).toHaveText("Greek yogurt");
    expect(entriesOf(await dayOf(profile.api, today()))[0].name).toBe("Greek yogurt");
  });

  test("the name box holds 120 characters at most", async ({ me }) => {
    await openFood(me);
    const form = await byHandForm(me, "lunch");
    await form.locator(".fname").fill("x".repeat(130));
    await expect(form.locator(".fname")).toHaveValue("x".repeat(120));
  });

  test("a food with no name is refused, and nothing is logged", async ({ me, profile }) => {
    await openFood(me);
    await enterByHand(me, "lunch", { kcal: "100" }, { refused: true });
    await expect(toast(me)).toContainText("Give the food a name.");
    await enterByHand(me, "lunch", { name: "   ", kcal: "100" }, { refused: true });
    await expect(toast(me)).toContainText("Give the food a name.");
    expect((await dayOf(profile.api, today())).day.entries).toBe(0);
  });

  test("a food with a name and no numbers is refused, and nothing is logged", async ({ me, profile }) => {
    await openFood(me);
    await enterByHand(me, "lunch", { name: "Mystery" }, { refused: true });
    await expect(toast(me)).toContainText("Give the calories or at least one macro.");
    expect((await dayOf(profile.api, today())).day.entries).toBe(0);
  });

  test("negative calories are refused, and the form keeps what was typed", async ({ me, profile }) => {
    await openFood(me);
    await enterByHand(me, "lunch", { name: "Negative", kcal: "-5", P: "2" }, { refused: true });
    await expect(toast(me)).toContainText("Calories must be a number from 0.");
    const form = await byHandForm(me, "lunch");
    await expect(form.locator(".fname")).toHaveValue("Negative");
    await expect(form.locator('input[aria-label="P g"]')).toHaveValue("2");
    expect((await dayOf(profile.api, today())).day.entries).toBe(0);
  });

  test("negative grams are refused with the field's name", async ({ me, profile }) => {
    await openFood(me);
    await enterByHand(me, "lunch", { name: "Negative fat", kcal: "100", F: "-1" }, { refused: true });
    await expect(toast(me)).toContainText("Fat must be a number from 0.");
    expect((await dayOf(profile.api, today())).day.entries).toBe(0);
  });

  test("calories above 10 000 are refused by the server", async ({ me, profile }) => {
    await openFood(me);
    await enterByHand(me, "dinner", { name: "Feast", kcal: "20000" }, { refused: true });
    await expect(toast(me)).toContainText("Calories must be a number from 0 to 10000.");
    expect((await dayOf(profile.api, today())).day.entries).toBe(0);
  });

  test("scientific notation is read as a number, so 1e5 calories is refused as too large", async ({ me }) => {
    await openFood(me);
    await enterByHand(me, "dinner", { name: "Scientific", kcal: "1e5" }, { refused: true });
    await expect(toast(me)).toContainText("Calories must be a number from 0 to 10000.");
  });

  test("protein above 2 000 g is refused by the server", async ({ me, profile }) => {
    await openFood(me);
    await enterByHand(me, "dinner", { name: "Protein bomb", P: "5000" }, { refused: true });
    await expect(toast(me)).toContainText("Protein must be a number from 0 to 2000.");
    expect((await dayOf(profile.api, today())).day.entries).toBe(0);
  });

  test("a letter cannot be typed into a calorie box", async ({ me }) => {
    await openFood(me);
    const form = await byHandForm(me, "dinner");
    await form.locator('input[aria-label="kcal"]').pressSequentially("abc");
    await expect(form.locator('input[aria-label="kcal"]')).toHaveValue("");
  });

  test("the meal's totals add up its foods", async ({ me }) => {
    await openFood(me);
    await enterByHand(me, "dinner", { name: "Pasta", kcal: "400", P: "20", C: "40", F: "10" });
    await enterByHand(me, "dinner", { name: "Sauce", kcal: "200", P: "5", C: "20", F: "8" });
    await expect(meal(me, "dinner").locator(".fmh > span")).toHaveText("600 kcal · P 25 · C 60 · F 18");
    await expect(meal(me, "dinner").locator(".fe .fn")).toHaveText(["Pasta", "Sauce"]);
  });

  test("the foods of a meal are listed in the order they were added, and each meal keeps its own", async ({ me, profile }) => {
    await openFood(me);
    for (const name of ["Third", "First", "Second"]) await enterByHand(me, "breakfast", { name, kcal: "100" });
    await enterByHand(me, "snack", { name: "Apple", kcal: "95" });
    await expect(meal(me, "breakfast").locator(".fe .fn")).toHaveText(["Third", "First", "Second"]);
    await expect(meal(me, "lunch").locator(".fe")).toHaveCount(0);
    await expect(meal(me, "snack").locator(".fe .fn")).toHaveText(["Apple"]);
    const meals = entriesOf(await dayOf(profile.api, today())).map((e) => e.meal);
    expect(meals).toEqual(["breakfast", "breakfast", "breakfast", "snack"]);
  });

  test("the day's summary card shows the calories eaten, the foods, the shares and the macros", async ({ me }) => {
    await openFood(me);
    await enterByHand(me, "lunch", { name: "Card A", kcal: "400", P: "20", C: "40", F: "10" });
    await enterByHand(me, "dinner", { name: "Card B", kcal: "200", P: "5", C: "20", F: "8" });
    const card = me.locator("#fbody .fsum");
    await expect(card.locator(".fhero b")).toHaveText("600");
    await expect(card.locator(".fhero .fhu")).toHaveText("kcal eaten");
    await expect(card.locator(".fhero .fhn")).toHaveText("2 foods");
    await expect(card.locator(".fleg span")).toHaveText(["Protein 20 %", "Carbs 48 %", "Fat 32 %"]);
    await expect(card.locator(".fmr.protein .fv")).toHaveText("25 g");
    await expect(card.locator(".fmr.carbs .fv")).toHaveText("60 g");
    await expect(card.locator(".fmr.fat .fv")).toHaveText("18 g");
  });

  test("the form is empty again after a food is added", async ({ me }) => {
    await openFood(me);
    const form = await byHandForm(me, "lunch");
    await fillForm(form, { name: "Closing", kcal: "50" });
    await form.locator('button[type="submit"]').click();
    await expect(meal(me, "lunch").locator(".fe .fn", { hasText: "Closing" })).toBeVisible();
    await expect(meal(me, "lunch").locator(".fname")).toHaveValue("");
    await expect(meal(me, "lunch").locator('input[aria-label="kcal"]')).toHaveValue("");
  });

  test("a food named as one logged lately fills its numbers in the form", async ({ me, profile }) => {
    await addFoods(profile.api, daysAgo(2), "breakfast", [{ name: "Old porridge", kcal: 210, proteinG: 7, carbsG: 36, fatG: 4 }]);
    await openFood(me);
    const form = await byHandForm(me, "lunch");
    await fillForm(form, { name: "Old porridge" });
    await form.locator(".fname").press("Tab");
    await expect(form.locator('input[aria-label="kcal"]')).toHaveValue("210");
    await expect(form.locator('input[aria-label="P g"]')).toHaveValue("7");
    await expect(form.locator('input[aria-label="F g"]')).toHaveValue("4");
  });

  test("a food logged lately does not replace the numbers already typed", async ({ me, profile }) => {
    await addFoods(profile.api, daysAgo(2), "breakfast", [{ name: "Old porridge", kcal: 210, proteinG: 7, carbsG: 36, fatG: 4 }]);
    await openFood(me);
    const form = await byHandForm(me, "lunch");
    await fillForm(form, { kcal: "50", name: "Old porridge" });
    await form.locator(".fname").press("Tab");
    await expect(form.locator('input[aria-label="kcal"]')).toHaveValue("50");
    await expect(form.locator('input[aria-label="P g"]')).toHaveValue("");
  });
});

test.describe("Food log: optional nutrients", () => {
  test("fiber and sodium are optional, listed under the food, and shown on the day", async ({ me, profile }) => {
    await openFood(me);
    await enterByHand(me, "lunch", { name: "Lentils", kcal: "230", P: "18", C: "40", F: "1", "Fiber (g)": "8", "Sodium (mg)": "410" });
    const row = await openRow(me, "lunch", "Lentils");
    await expect(row.locator(".fmore-e > .fm").first()).toHaveText("Fiber 8 g · Sodium 410 mg");
    const [entry] = entriesOf(await dayOf(profile.api, today()));
    expect(entry.nutrients).toEqual({ fiberG: 8, sodiumMg: 410 });
    const fiber = me.locator("#fbody .fcard").nth(1).locator(".fnrow").filter({ hasText: /^Fiber/ });
    await expect(fiber.locator(".fv")).toHaveText("8 g");
    await expect(fiber.locator(".fmn")).toHaveText("from the food");
  });

  test("a food with no nutrients states none, and its nutrients are unknown, not zero", async ({ me, profile }) => {
    await openFood(me);
    await enterByHand(me, "lunch", { name: "Plain rice", kcal: "200", P: "4", C: "44", F: "0" });
    const row = await openRow(me, "lunch", "Plain rice");
    await expect(row.locator(".fmore-e > .fm").first()).toHaveText("States no fiber or other nutrients.");
    expect(entriesOf(await dayOf(profile.api, today()))[0].nutrients).toEqual({});
  });

  test("a total counts only the foods that state the nutrient: the fiber of one food of two is a lower bound", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "breakfast", [{ name: "Oats", kcal: 380, proteinG: 13, carbsG: 60, fatG: 7, nutrients: { fiberG: 8 } }]);
    await addFoods(profile.api, today(), "lunch", [{ name: "Burger", kcal: 1000, proteinG: 40, carbsG: 80, fatG: 58 }]);
    await openFood(me);
    const card = me.locator("#fbody .fcard").nth(1);
    const fiber = card.locator(".fnrow").filter({ hasText: /^Fiber/ });
    await expect(fiber.locator(".fv")).toHaveText("≥ 8 g");
    await expect(fiber.locator(".fmn")).toHaveText("from 1 of 2 foods");
    const calcium = card.locator(".fnrow").filter({ hasText: /^Calcium/ });
    await expect(calcium.locator(".fv")).toHaveText("–");
    await expect(calcium.locator(".fmn")).toHaveText("no food states it");
    await expect(me.locator(".rmetrics tbody tr").first().locator("td").nth(5)).toHaveText("≥ 8 g");
  });

  test("a nutrient every food states is the full total, from all of them", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "lunch", [
      { name: "Ham", kcal: 150, proteinG: 20, carbsG: 1, fatG: 7, nutrients: { sodiumMg: 100 } },
      { name: "Cheese", kcal: 110, proteinG: 7, carbsG: 1, fatG: 9, nutrients: { sodiumMg: 200 } },
    ]);
    await openFood(me);
    const sodium = me.locator("#fbody .fcard").nth(1).locator(".fnrow").filter({ hasText: /^Sodium/ });
    await expect(sodium.locator(".fv")).toHaveText("300 mg");
    await expect(sodium.locator(".fmn")).toHaveText("from all 2 foods");
  });

  test("a nutrient left empty in the form is not sent, and one changed to empty is removed", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "dinner", [{ name: "Beans", kcal: 340, proteinG: 21, carbsG: 60, fatG: 1, nutrients: { fiberG: 15, ironMg: 3.5 } }]);
    await openFood(me);
    await openRow(me, "dinner", "Beans");
    await rowOf(me, "dinner", "Beans").locator('button[aria-label="Change Beans"]').click();
    const form = meal(me, "dinner").locator("form.fform");
    await fillForm(form, { "Fiber (g)": "" });
    await form.locator('button[type="submit"]').click();
    await expect(rowOf(me, "dinner", "Beans").locator(".fmore-e > .fm").first()).toHaveText("Iron 3.5 mg");
    expect(entriesOf(await dayOf(profile.api, today()))[0].nutrients).toEqual({ ironMg: 3.5 });
  });

  test("a nutrient given a negative amount is refused, and a huge one too", async ({ me, profile }) => {
    await openFood(me);
    await enterByHand(me, "lunch", { name: "Bad fiber", kcal: "100", "Fiber (g)": "-1" }, { refused: true });
    await expect(toast(me)).toContainText("Fiber must be a number from 0.");
    await enterByHand(me, "lunch", { name: "Bad sodium", kcal: "100", "Fiber (g)": "", "Sodium (mg)": "200000" }, { refused: true });
    await expect(toast(me)).toContainText("Sodium must be a number from 0 to 100000.");
    expect((await dayOf(profile.api, today())).day.entries).toBe(0);
  });
});

test.describe("Food log: changing and deleting an entry", () => {
  test("a food's Change form is filled with its numbers, and Save writes the changes", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "breakfast", [{ name: "Oats", kcal: 300, proteinG: 10, carbsG: 50, fatG: 5 }]);
    await openFood(me);
    await openRow(me, "breakfast", "Oats");
    await rowOf(me, "breakfast", "Oats").locator('button[aria-label="Change Oats"]').click();
    const hand = meal(me, "breakfast").locator("details.fhand");
    await expect(hand.locator("summary").first()).toHaveText("Change the food");
    const form = hand.locator("form.fform");
    await expect(form.locator(".fname")).toHaveValue("Oats");
    await expect(form.locator('input[aria-label="kcal"]')).toHaveValue("300");
    await expect(form.locator('input[aria-label="P g"]')).toHaveValue("10");
    await expect(form.locator('input[aria-label="C g"]')).toHaveValue("50");
    await expect(form.locator('input[aria-label="F g"]')).toHaveValue("5");
    await expect(form.locator('button[type="submit"]')).toHaveText("Save");
    await fillForm(form, { name: "Oats (large)", kcal: "320", P: "12" });
    await form.locator('button[type="submit"]').click();
    await expect(meal(me, "breakfast").locator(".fe .fn")).toHaveText("Oats (large)");
    await expect(meal(me, "breakfast").locator(".fk")).toHaveText("320 kcal");
    await expect(meal(me, "breakfast").locator(".fmh > span")).toHaveText("320 kcal · P 12 · C 50 · F 5");
    expect(entriesOf(await dayOf(profile.api, today()))[0]).toMatchObject({ id: expect.any(Number), name: "Oats (large)", kcal: 320, proteinG: 12, carbsG: 50, fatG: 5 });
  });

  test("changing a macro keeps the calories as they are: they are not worked out again", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "lunch", [{ name: "Rice bowl", kcal: 500, proteinG: 10, carbsG: 80, fatG: 12 }]);
    await openFood(me);
    await openRow(me, "lunch", "Rice bowl");
    await rowOf(me, "lunch", "Rice bowl").locator('button[aria-label="Change Rice bowl"]').click();
    const form = meal(me, "lunch").locator("form.fform");
    await fillForm(form, { P: "30" });
    await form.locator('button[type="submit"]').click();
    await expect(rowOf(me, "lunch", "Rice bowl").locator(".ft > .fm")).toHaveText("P 30 · C 80 · F 12");
    await expect(rowOf(me, "lunch", "Rice bowl").locator(".fk")).toHaveText("500 kcal");
    expect(entriesOf(await dayOf(profile.api, today()))[0]).toMatchObject({ kcal: 500, proteinG: 30 });
  });

  test("emptying the calories of a food being changed works them out from its macros", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "lunch", [{ name: "Wrap", kcal: 500, proteinG: 12, carbsG: 50, fatG: 5 }]);
    await openFood(me);
    await openRow(me, "lunch", "Wrap");
    await rowOf(me, "lunch", "Wrap").locator('button[aria-label="Change Wrap"]').click();
    const form = meal(me, "lunch").locator("form.fform");
    await fillForm(form, { kcal: "" });
    await form.locator('button[type="submit"]').click();
    await expect(rowOf(me, "lunch", "Wrap").locator(".fk")).toHaveText("293 kcal");
    expect(entriesOf(await dayOf(profile.api, today()))[0].kcal).toBe(293);
  });

  test("emptying a nutrient of a food being changed removes it: the food states none", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "snack", [{ name: "Pear", kcal: 100, proteinG: 1, carbsG: 25, fatG: 0, nutrients: { fiberG: 4 } }]);
    await openFood(me);
    await openRow(me, "snack", "Pear");
    await rowOf(me, "snack", "Pear").locator('button[aria-label="Change Pear"]').click();
    await fillForm(meal(me, "snack").locator("form.fform"), { "Fiber (g)": "" });
    await meal(me, "snack").locator("form.fform button[type='submit']").click();
    await expect(rowOf(me, "snack", "Pear").locator(".fmore-e > .fm").first()).toHaveText("States no fiber or other nutrients.");
    expect(entriesOf(await dayOf(profile.api, today()))[0].nutrients).toEqual({});
  });

  test("Cancel leaves the food as it was", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "dinner", [{ name: "Stew", kcal: 420, proteinG: 30, carbsG: 30, fatG: 18 }]);
    await openFood(me);
    await openRow(me, "dinner", "Stew");
    await rowOf(me, "dinner", "Stew").locator('button[aria-label="Change Stew"]').click();
    const form = meal(me, "dinner").locator("form.fform");
    await fillForm(form, { name: "Stew changed", kcal: "1" });
    await form.locator("button", { hasText: "Cancel" }).click();
    await expect(rowOf(me, "dinner", "Stew").locator(".fn")).toHaveText("Stew");
    await expect(meal(me, "dinner").locator("details.fhand > summary")).toHaveText("Enter by hand");
    expect(entriesOf(await dayOf(profile.api, today()))[0]).toMatchObject({ name: "Stew", kcal: 420 });
  });

  test("a change that is refused says why, and the entry stays as it was", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "dinner", [{ name: "Curry", kcal: 600, proteinG: 25, carbsG: 60, fatG: 25 }]);
    await openFood(me);
    await openRow(me, "dinner", "Curry");
    await rowOf(me, "dinner", "Curry").locator('button[aria-label="Change Curry"]').click();
    const form = meal(me, "dinner").locator("form.fform");
    await fillForm(form, { kcal: "20000" });
    await form.locator('button[type="submit"]').click();
    await expect(toast(me)).toContainText("Calories must be a number from 0 to 10000.");
    expect(entriesOf(await dayOf(profile.api, today()))[0]).toMatchObject({ name: "Curry", kcal: 600 });
  });

  test("Delete asks first, and Cancel keeps the food", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "snack", [{ name: "Keep me", kcal: 80 }]);
    await openFood(me);
    await openRow(me, "snack", "Keep me");
    await rowOf(me, "snack", "Keep me").locator('button[aria-label="Delete Keep me"]').click();
    await expect(me.locator("#dlgTitle")).toHaveText("Delete this food?");
    await expect(me.locator("#dlgText")).toContainText("Keep me · 80 kcal");
    await me.locator("#dlgCancel").click();
    await expect(me.locator("#dlg")).toBeHidden();
    await expect(rowOf(me, "snack", "Keep me")).toBeVisible();
    expect(entriesOf(await dayOf(profile.api, today()))).toHaveLength(1);
  });

  test("Delete removes the food from the meal, its totals and the log", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "snack", [{ name: "Gone soon", kcal: 80, proteinG: 1, carbsG: 15, fatG: 1 }, { name: "Stays", kcal: 120, proteinG: 2, carbsG: 20, fatG: 3 }]);
    await openFood(me);
    await openRow(me, "snack", "Gone soon");
    await rowOf(me, "snack", "Gone soon").locator('button[aria-label="Delete Gone soon"]').click();
    await me.locator("#dlgOk").click();
    await expect(meal(me, "snack").locator(".fe .fn")).toHaveText(["Stays"]);
    await expect(meal(me, "snack").locator(".fmh > span")).toHaveText("120 kcal · P 2 · C 20 · F 3");
    await expect(me.locator("#fbody .fsum .fhero b")).toHaveText("120");
    const left = entriesOf(await dayOf(profile.api, today()));
    expect(left.map((e) => e.name)).toEqual(["Stays"]);
  });

  test.fixme("Delete offers an Undo that brings the food back", async ({ me, profile }) => {
    // The app: after OK in the confirm dialog the food is removed at once and the toast stays empty: there is no Undo button (the
    // README offers Undo for recent foods, copies and the AI log only). Expected: a toast with Undo brings the food back.
    await addFoods(profile.api, today(), "snack", [{ name: "Undo me", kcal: 80 }]);
    await openFood(me);
    await openRow(me, "snack", "Undo me");
    await rowOf(me, "snack", "Undo me").locator('button[aria-label="Delete Undo me"]').click();
    await me.locator("#dlgOk").click();
    await expect(toast(me).locator("button", { hasText: "Undo" })).toBeVisible();
    await toast(me).locator("button", { hasText: "Undo" }).click();
    await expect(rowOf(me, "snack", "Undo me")).toBeVisible();
  });
});

test.describe("Food log: moving a food to another meal", () => {
  /** The "Move … to another meal" choice in a food's open row. */
  const mover = (row: Locator): Locator => row.locator("select.fmove");

  test("an open food offers the other three meals, and not its own", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "lunch", [{ name: "Wrap", kcal: 350 }]);
    await openFood(me);
    const move = mover(await openRow(me, "lunch", "Wrap"));
    await expect(move).toHaveAttribute("aria-label", "Move Wrap to another meal");
    await expect(move).toHaveValue("");
    await expect(move.locator("option")).toHaveText(["Move to…", "Breakfast", "Dinner", "Snacks"]);
  });

  test("the meal chosen takes the food, with its numbers, and the totals of both meals follow", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "lunch", [{ name: "Wrap", kcal: 350, proteinG: 20, carbsG: 40, fatG: 12 }, { name: "Apple", kcal: 80, proteinG: 0, carbsG: 20, fatG: 0 }]);
    await addFoods(profile.api, today(), "dinner", [{ name: "Soup", kcal: 150, proteinG: 5, carbsG: 20, fatG: 4 }]);
    await openFood(me);
    await mover(await openRow(me, "lunch", "Wrap")).selectOption("dinner");
    await expect(toast(me)).toContainText("Moved Wrap to Dinner.");
    await expect(meal(me, "lunch").locator(".fe .fn")).toHaveText(["Apple"]);
    await expect(meal(me, "dinner").locator(".fe .fn")).toHaveText(["Wrap", "Soup"]); // a meal lists its foods in the order they were logged, so the moved one keeps its place
    await expect(meal(me, "lunch").locator(".fmh > span")).toHaveText("80 kcal · P 0 · C 20 · F 0");
    await expect(meal(me, "dinner").locator(".fmh > span")).toHaveText("500 kcal · P 25 · C 60 · F 16");
    await expect(me.locator("#fbody .fsum .fhero b")).toHaveText("580"); // the day's total does not change
    const log = entriesOf(await dayOf(profile.api, today()));
    expect(log.find((e) => e.name === "Wrap")).toMatchObject({ meal: "dinner", day: today(), kcal: 350, proteinG: 20, carbsG: 40, fatG: 12 });
    expect(log).toHaveLength(3);
  });

  test("a move keeps the food's own entry: same id, same nutrients", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "breakfast", [{ name: "Granola", kcal: 220, proteinG: 6, carbsG: 35, fatG: 7, nutrients: { fiberG: 4, sodiumMg: 90 } }]);
    const before = entriesOf(await dayOf(profile.api, today()))[0];
    await openFood(me);
    await mover(await openRow(me, "breakfast", "Granola")).selectOption("snack");
    await expect(meal(me, "snack").locator(".fe .fn")).toHaveText(["Granola"]);
    const after = entriesOf(await dayOf(profile.api, today()))[0];
    expect(after).toMatchObject({ id: before.id, meal: "snack", nutrients: before.nutrients, kcal: 220 });
    expect(entriesOf(await dayOf(profile.api, today()))).toHaveLength(1);
  });

  test("Undo moves the food back to its meal, and the log says so", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "lunch", [{ name: "Wrap", kcal: 350 }]);
    await openFood(me);
    await mover(await openRow(me, "lunch", "Wrap")).selectOption("snack");
    await expect(meal(me, "snack").locator(".fe .fn")).toHaveText(["Wrap"]);
    await toast(me).locator("button", { hasText: "Undo" }).click();
    await expect(meal(me, "lunch").locator(".fe .fn")).toHaveText(["Wrap"]);
    await expect(meal(me, "snack").locator(".fe")).toHaveCount(0);
    expect(entriesOf(await dayOf(profile.api, today()))[0]).toMatchObject({ meal: "lunch", name: "Wrap" });
  });

  test("a food of a past day moves within that day, and today stays empty", async ({ me, profile }) => {
    await addFoods(profile.api, daysAgo(1), "lunch", [{ name: "Leftovers", kcal: 400 }]);
    await openFood(me);
    await me.locator("#fPrev").click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    await mover(await openRow(me, "lunch", "Leftovers")).selectOption("dinner");
    await expect(meal(me, "dinner").locator(".fe .fn")).toHaveText(["Leftovers"]);
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    expect(entriesOf(await dayOf(profile.api, daysAgo(1)))[0]).toMatchObject({ meal: "dinner", day: daysAgo(1) });
    expect((await dayOf(profile.api, today())).day.entries).toBe(0);
  });

  test("a food being changed closes its form when it is moved, and the form is not left in the old meal", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "lunch", [{ name: "Wrap", kcal: 350 }]);
    await openFood(me);
    const row = await openRow(me, "lunch", "Wrap");
    await row.locator('button[aria-label="Change Wrap"]').click();
    await expect(meal(me, "lunch").locator("details.fhand summary").first()).toHaveText("Change the food");
    await mover(row).selectOption("dinner");
    await expect(meal(me, "dinner").locator(".fe .fn")).toHaveText(["Wrap"]);
    await expect(meal(me, "lunch").locator("details.fhand summary").first()).toHaveText("Enter by hand");
    await expect(meal(me, "dinner").locator("details.fhand summary").first()).toHaveText("Enter by hand");
    await expect(me.locator("#fbody .fe.editing")).toHaveCount(0);
  });

  test("a move the server refuses says why, and the food stays in its meal", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "lunch", [{ name: "Wrap", kcal: 350 }]);
    await openFood(me);
    const move = mover(await openRow(me, "lunch", "Wrap"));
    const id = entriesOf(await dayOf(profile.api, today()))[0].id;
    const gone = await profile.api.post("/api/nutrition", { data: { action: "delete", ids: [id], date: today() } }); // deleted on another screen
    expect(gone.ok()).toBeTruthy();
    await move.selectOption("dinner");
    await expect(toast(me)).toContainText(`There is no food entry ${id}.`);
    await expect(meal(me, "lunch").locator(".fe .fn")).toHaveText(["Wrap"]);
    await expect(mover(rowOf(me, "lunch", "Wrap"))).toHaveValue(""); // the list puts the choice back
    await expect(meal(me, "dinner").locator(".fe")).toHaveCount(0);
  });

  test("the API moves a food with a meal alone, and refuses a meal it does not know", async ({ profile }) => {
    await addFoods(profile.api, today(), "lunch", [{ name: "Wrap", kcal: 350, proteinG: 20 }]);
    const id = entriesOf(await dayOf(profile.api, today()))[0].id;
    const bad = await profile.api.post("/api/nutrition", { data: { action: "update", id, meal: "brunch" } });
    expect(bad.status()).toBe(400);
    expect(entriesOf(await dayOf(profile.api, today()))[0].meal).toBe("lunch");
    const ok = await profile.api.post("/api/nutrition", { data: { action: "update", id, meal: "snack" } });
    expect(ok.ok()).toBeTruthy();
    expect(entriesOf(await dayOf(profile.api, today()))[0]).toMatchObject({ id, meal: "snack", name: "Wrap", kcal: 350, proteinG: 20 });
  });
});

test.describe("Food log: undo after adding", () => {
  test("+ Add again on today adds a second copy, and Undo takes that copy back", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "breakfast", [{ name: "Latte", kcal: 120, proteinG: 6, carbsG: 9, fatG: 6 }]);
    await openFood(me);
    await openRow(me, "breakfast", "Latte");
    await rowOf(me, "breakfast", "Latte").locator("button.fcopy", { hasText: "+ Add again" }).click();
    await expect(toast(me)).toContainText("Added Latte again.");
    await expect(meal(me, "breakfast").locator(".fe .fn")).toHaveText(["Latte", "Latte"]);
    // Undo is taken at once: the toast goes after a few seconds, and the log is read afterwards
    await toast(me).locator("button", { hasText: "Undo" }).click();
    await expect(toast(me)).toContainText("Removed 1 food.");
    await expect(meal(me, "breakfast").locator(".fe .fn")).toHaveText(["Latte"]);
    expect(entriesOf(await dayOf(profile.api, today()))).toHaveLength(1);
  });

  test("+ Add again can be used more than once: two more coffees, then the total is three", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "breakfast", [{ name: "Espresso", kcal: 5 }]);
    await openFood(me);
    await openRow(me, "breakfast", "Espresso");
    await rowOf(me, "breakfast", "Espresso").locator("button.fcopy", { hasText: "+ Add again" }).click();
    await expect(meal(me, "breakfast").locator(".fe .fn")).toHaveCount(2);
    await rowOf(me, "breakfast", "Espresso").first().locator("button.fcopy", { hasText: "+ Add again" }).click();
    await expect(meal(me, "breakfast").locator(".fe .fn")).toHaveCount(3);
    expect(entriesOf(await dayOf(profile.api, today()))).toHaveLength(3);
  });

  test("Undo after a copy to today removes the copies", async ({ me, profile }) => {
    await addFoods(profile.api, daysAgo(1), "lunch", [{ name: "Sandwich", kcal: 400 }]);
    await openFood(me);
    await me.locator("#fPrev").click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    await me.locator("#fbody .fday button").click();
    await expect(toast(me)).toContainText("Copied 1 food to today.");
    await toast(me).locator("button", { hasText: "Undo" }).click();
    await expect(toast(me)).toContainText("Removed 1 food.");
    expect((await dayOf(profile.api, today())).day.entries).toBe(0);
    await expect(me.locator("#fbody .fday button")).toHaveText("Copy the day to today");
    await expect(me.locator("#fbody .fday button")).toBeEnabled();
  });
});

test.describe("Food log: copying a past day to today", () => {
  test("Copy the day to today copies every food into its meal, marks the button, and leaves the past day as it was", async ({ me, profile }) => {
    await addFoods(profile.api, daysAgo(1), "breakfast", [{ name: "Porridge", kcal: 250, proteinG: 9, carbsG: 40, fatG: 5 }]);
    await addFoods(profile.api, daysAgo(1), "dinner", [{ name: "Soup", kcal: 180, proteinG: 6, carbsG: 20, fatG: 7 }]);
    await openFood(me);
    await me.locator("#fPrev").click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    const button = me.locator("#fbody .fday button");
    await expect(me.locator("#fbody .fday")).toContainText("2 foods");
    await button.click();
    await expect(toast(me)).toContainText("Copied 2 foods to today.");
    await expect(button).toHaveText("Copied ✓");
    await expect(button).toBeDisabled();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    const todays = entriesOf(await dayOf(profile.api, today()));
    expect(todays.map((e) => [e.name, e.meal, e.kcal])).toEqual([["Porridge", "breakfast", 250], ["Soup", "dinner", 180]]);
    expect(entriesOf(await dayOf(profile.api, daysAgo(1)))).toHaveLength(2);
  });

  test("a copy keeps the numbers and the nutrients of the food", async ({ me, profile }) => {
    await addFoods(profile.api, daysAgo(1), "snack", [{ name: "Nuts", kcal: 170, proteinG: 6, carbsG: 6, fatG: 15, nutrients: { fiberG: 2.5, sodiumMg: 5 } }]);
    await openFood(me);
    await me.locator("#fPrev").click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    await openRow(me, "snack", "Nuts");
    await rowOf(me, "snack", "Nuts").locator("button.fcopy", { hasText: "Copy to today" }).click();
    await expect(toast(me)).toContainText("Copied Nuts (Snacks) to today.");
    const [copy] = entriesOf(await dayOf(profile.api, today()));
    expect(copy).toMatchObject({ name: "Nuts", meal: "snack", kcal: 170, proteinG: 6, carbsG: 6, fatG: 15, nutrients: { fiberG: 2.5, sodiumMg: 5 } });
  });

  test("a meal copied is marked copied, and the day then copies only what is left", async ({ me, profile }) => {
    await addFoods(profile.api, daysAgo(1), "breakfast", [{ name: "Toast", kcal: 150 }]);
    await addFoods(profile.api, daysAgo(1), "dinner", [{ name: "Fish", kcal: 400 }]);
    await openFood(me);
    await me.locator("#fPrev").click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    const dinnerButton = meal(me, "dinner").locator(".fmh button");
    await dinnerButton.click();
    await expect(toast(me)).toContainText("Copied Dinner (1 food) to today.");
    await expect(dinnerButton).toHaveText("Copied ✓");
    await expect(dinnerButton).toBeDisabled();
    await me.locator("#fbody .fday button").click();
    await expect(toast(me)).toContainText("Copied 1 food to today.");
    const todays = entriesOf(await dayOf(profile.api, today()));
    expect(todays.map((e) => e.name).sort()).toEqual(["Fish", "Toast"]);
    expect(todays).toHaveLength(2);
  });

  test("a food copied by its own button is marked, and the day copies the rest", async ({ me, profile }) => {
    await addFoods(profile.api, daysAgo(1), "breakfast", [{ name: "Yogurt", kcal: 100 }, { name: "Berries", kcal: 40 }]);
    await openFood(me);
    await me.locator("#fPrev").click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    await openRow(me, "breakfast", "Yogurt");
    const own = rowOf(me, "breakfast", "Yogurt").locator("button.fcopy");
    await own.click();
    await expect(toast(me)).toContainText("Copied Yogurt (Breakfast) to today.");
    await expect(own).toHaveText("Copied ✓");
    await expect(own).toBeDisabled();
    await me.locator("#fbody .fday button").click();
    await expect(toast(me)).toContainText("Copied 1 food to today.");
    expect(entriesOf(await dayOf(profile.api, today())).map((e) => e.name).sort()).toEqual(["Berries", "Yogurt"]);
  });

  test("the copy buttons say nothing to copy once all is copied, and a copied food is not copied again", async ({ me, profile }) => {
    await addFoods(profile.api, daysAgo(1), "lunch", [{ name: "Only one", kcal: 300 }]);
    await openFood(me);
    await me.locator("#fPrev").click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    await me.locator("#fbody .fday button").click();
    await expect(me.locator("#fbody .fday button")).toHaveText("Copied ✓");
    await expect(meal(me, "lunch").locator(".fmh button")).toHaveText("Copied ✓");
    await expect(meal(me, "lunch").locator(".fmh button")).toBeDisabled();
    expect(entriesOf(await dayOf(profile.api, today()))).toHaveLength(1);
  });

  test("today offers no copy buttons, only + Add again", async ({ me, profile }) => {
    await addFoods(profile.api, today(), "lunch", [{ name: "Today food", kcal: 200 }]);
    await openFood(me);
    await expect(me.locator("#fbody .fday")).toHaveCount(0);
    await openRow(me, "lunch", "Today food");
    await expect(rowOf(me, "lunch", "Today food").locator("button.fcopy", { hasText: "Copy to today" })).toHaveCount(0);
    await expect(rowOf(me, "lunch", "Today food").locator("button.fcopy", { hasText: "+ Add again" })).toBeVisible();
  });

  test("the API answers a copy of food that is not the profile's with an error, and copies nothing", async ({ profile, admin }) => {
    const aliceToday = await dayOf(admin, daysAgo(1), "alice");
    const id = entriesOf(aliceToday)[0].id;
    const r = await profile.api.post("/api/nutrition", { data: { action: "copy", ids: [id], date: daysAgo(1) } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain(`There is no food entry ${id}.`);
    expect((await dayOf(profile.api, today())).day.entries).toBe(0);
  });
});

test.describe("Food log: the day's totals and alice's past days", () => {
  test("alice's past day shows her four meals, each with its foods and totals", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fPrev").click();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
    const expected: [string, string, string[]][] = [
      ["breakfast", "405 kcal · P 11 · C 81 · F 5", ["Oatmeal", "Banana"]],
      ["lunch", "520 kcal · P 34 · C 48 · F 20", ["Chicken wrap"]],
      ["dinner", "640 kcal · P 41 · C 62 · F 24", ["Salmon and rice"]],
      ["snack", "130 kcal · P 17 · C 8 · F 3", ["Greek yogurt"]],
    ];
    for (const [m, totals, names] of expected) {
      await expect(meal(alice, m).locator(".fmh > span")).toHaveText(totals);
      await expect(meal(alice, m).locator(".fe .fn")).toHaveText(names);
    }
    await expect(alice.locator("#fbody .fe .fk").first()).toHaveText("300 kcal");
  });

  test("alice's past day has the day's totals: 1,695 kcal, the macros and their shares", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fPrev").click();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
    const card = alice.locator("#fbody .fsum");
    await expect(card.locator(".fhero b")).toHaveText("1,695");
    await expect(card.locator(".fhero .fhu")).toHaveText("kcal eaten");
    await expect(card.locator(".fleg span")).toHaveText(["Protein 25 %", "Carbs 47 %", "Fat 28 %"]);
    await expect(card.locator(".fmr.protein .fv")).toHaveText("103 / 130 g");
    await expect(card.locator(".fmr.carbs .fv")).toHaveText("199 / 250 g");
    await expect(card.locator(".fmr.fat .fv")).toHaveText("52 / 70 g");
    await expect(card.locator(".fburn").first()).toContainText("Burned 2,600 kcal by Garmin · eaten − burned −905 kcal");
  });

  test("the other past days of alice have the same 1,695 kcal, and the Every day row says the same", async ({ alice }) => {
    await openFood(alice);
    for (const back of [2, 5]) {
      await alice.locator("#fDate").fill(daysAgo(back));
      await expect(alice.locator("#fDate")).toHaveValue(daysAgo(back));
      await expect(alice.locator("#fbody .fhero b")).toHaveText("1,695");
    }
    const row = alice.locator(".rmetrics tbody tr", { has: alice.locator("td.day", { hasText: labelOf(daysAgo(1)) }) });
    await expect(row.locator("td").nth(1)).toHaveText("1,695 kcal");
    await expect(row.locator("td").nth(2)).toHaveText("103 g");
    await expect(row.locator("td").nth(3)).toHaveText("199 g");
    await expect(row.locator("td").nth(4)).toHaveText("52 g");
    await expect(row.locator("td").nth(5)).toHaveText("2,600 kcal");
    await expect(row.locator("td").nth(6)).toHaveText("−905 kcal");
  });

  test("alice's average is of the five days that have food", async ({ alice }) => {
    await openFood(alice);
    await expect(alice.locator("#fbody .fnote", { hasText: "Average of 5 logged days: 1,695 kcal · P 103 · C 199 · F 52" })).toBeVisible();
  });
});

test.describe("Food log: profiles", () => {
  test("a profile without the admin login has no profile list on the Food view", async ({ me }) => {
    await openFood(me);
    await expect(me.locator("#fProfile")).toBeHidden();
  });

  test("the admin chooses a profile and sees its log, then another profile's", async ({ page, profile }) => {
    await addFoods(profile.api, today(), "lunch", [{ name: "Admin test soup", kcal: 123 }]);
    await loginAs(page, "admin", ADMIN_TOKEN);
    await openFood(page);
    await expect(page.locator("#fProfile")).toBeVisible();
    await page.locator("#fProfile").selectOption(profile.name);
    await expect(page.locator("#fbody .fn", { hasText: "Admin test soup" })).toBeVisible();
    await expect(page.locator("#fProfile")).toHaveValue(profile.name);
    await page.locator("#fProfile").selectOption("alice");
    await expect(page.locator("#fbody .fn", { hasText: "Admin test soup" })).toHaveCount(0);
    await expect(page.locator("#fbody .fhero .fhn")).toContainText("nothing logged");
    await page.locator("#fPrev").click();
    await expect(page.locator("#fbody .fn", { hasText: "Oatmeal" })).toBeVisible();
  });

  test("bob, who has no food, sees none of alice's", async ({ page }) => {
    await loginAs(page, "bob", PASSWORD);
    await openFood(page);
    await expect(page.locator("#fProfile")).toBeHidden();
    await page.locator("#fPrev").click();
    await expect(page.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(page.locator("#fbody .fe")).toHaveCount(0);
    await expect(page.locator("#fbody .fhero .fhn")).toContainText("nothing logged");
  });

  test("a profile asking for another profile's log is answered with its own", async ({ profile }) => {
    const json = await dayOf(profile.api, daysAgo(1), "alice");
    expect(json.profile).toBe(profile.name);
    expect(json.day.entries).toBe(0);
  });

  test("an admin reading a profile's log gets exactly what that profile entered", async ({ profile, admin }) => {
    await addFoods(profile.api, today(), "dinner", [{ name: "Admin reads", kcal: 77 }]);
    const json = await dayOf(admin, today(), profile.name);
    expect(json.profile).toBe(profile.name);
    expect(entriesOf(json).map((e) => e.name)).toEqual(["Admin reads"]);
    expect((await dayOf(admin, today(), "alice")).day.entries).toBe(0);
  });
});

test.describe("Food log: what the API keeps", () => {
  test("a food written by the page is in the log, with its source and its day", async ({ me, profile }) => {
    await openFood(me);
    await enterByHand(me, "snack", { name: "Api check", kcal: "99", P: "1", C: "2", F: "3" });
    await expect(rowOf(me, "snack", "Api check")).toBeVisible();
    const json = await dayOf(profile.api, today());
    expect(json.date).toBe(today());
    expect(json.day.meals.find((m: any) => m.meal === "snack").entries).toEqual([expect.objectContaining({ name: "Api check", kcal: 99, proteinG: 1, carbsG: 2, fatG: 3, source: "web" })]);
    expect(json.day.burnedKcal).toBeNull();
  });

  test("the day and its meal totals come back with the API's own arithmetic", async ({ profile }) => {
    await addFoods(profile.api, today(), "breakfast", [{ name: "A", kcal: 10.4, proteinG: 1.25, carbsG: 2, fatG: 0.5 }, { name: "B", kcal: 20, proteinG: 3, carbsG: 4, fatG: 1 }]);
    const json = await dayOf(profile.api, today());
    expect(json.day).toMatchObject({ kcal: 30, proteinG: 4.3, carbsG: 6, fatG: 1.5, entries: 2 });
    expect(json.day.meals.find((m: any) => m.meal === "breakfast").totals).toMatchObject({ kcal: 30, entries: 2 });
  });

  test("a food that is no name, no numbers or a bad meal is refused and nothing is written", async ({ profile }) => {
    const bad = [
      { body: { action: "add", day: today(), meal: "lunch", items: [{ name: "", kcal: 10 }] }, error: "Each food needs a name." },
      { body: { action: "add", day: today(), meal: "lunch", items: [{ name: "Nothing" }] }, error: "needs calories or at least one macro" },
      { body: { action: "add", day: today(), meal: "brunch", items: [{ name: "Brunch", kcal: 10 }] }, error: "The meal must be one of breakfast, lunch, dinner, snack." },
      { body: { action: "add", day: "2026-02-30", meal: "lunch", items: [{ name: "Leap", kcal: 10 }] }, error: "is not a day" },
      { body: { action: "add", day: today(), meal: "lunch", items: [{ name: "Text", kcal: "abc" }] }, error: "Calories must be a number from 0 to 10000." },
      { body: { action: "add", day: today(), meal: "lunch", items: [{ name: "Ok", kcal: 10 }, { name: "Bad", kcal: -1 }] }, error: "Calories must be a number from 0 to 10000." },
      { body: { action: "add", day: today(), meal: "lunch", items: [{ name: "Vit", kcal: 10, nutrients: { vitaminC: 5 } }] }, error: '"vitaminC" is not a nutrient the log holds' },
      { body: { action: "add", day: today(), meal: "lunch", items: [{ name: "Fiber", kcal: 10, nutrients: { fiberG: "lots" } }] }, error: "Fiber must be a number from 0 to 2000." },
      { body: { action: "add", day: today(), meal: "lunch", items: [] }, error: "Give at least one food." },
      { body: { action: "add", day: today(), meal: "lunch", items: Array.from({ length: 51 }, (_, i) => ({ name: `Food ${i}`, kcal: 1 })) }, error: "Give at most 50 foods at a time." },
      { body: { action: "explode" }, error: 'Unknown action "explode".' },
      { body: { action: "delete", ids: [] }, error: "Delete from 1 to 50 foods at a time." },
    ];
    for (const { body, error } of bad) {
      const r = await profile.api.post("/api/nutrition", { data: body });
      expect(r.status(), JSON.stringify(body).slice(0, 80)).toBe(400);
      expect((await r.json()).error).toContain(error);
    }
    expect((await dayOf(profile.api, today())).day.entries).toBe(0);
  });

  test("a batch with one food refused writes none of its foods", async ({ profile }) => {
    const r = await profile.api.post("/api/nutrition", { data: { action: "add", day: today(), meal: "lunch", items: [{ name: "Good one", kcal: 10 }, { name: "", kcal: 10 }] } });
    expect(r.status()).toBe(400);
    expect((await dayOf(profile.api, today())).day.entries).toBe(0);
  });

  test("a food named over 120 characters is refused by the API", async ({ profile }) => {
    const r = await profile.api.post("/api/nutrition", { data: { action: "add", day: today(), meal: "lunch", items: [{ name: "n".repeat(121), kcal: 10 }] } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("A food name is at most 120 characters.");
  });

  test("a day the API is asked for that is not one shows today, and a range is at least seven days", async ({ profile }) => {
    const r = await profile.api.get("/api/nutrition?date=not-a-day&days=2");
    const json = await r.json();
    expect(json.date).toBe(today());
    expect(json.days).toHaveLength(7);
  });
});
