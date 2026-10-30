/**
 * Finding a food in the Food view: the search box of each meal (Open Food Facts through the server), the barcode typed or scanned,
 * the foods used lately (Recent), the picker that sets the quantity, changing a logged food by its quantity or by another food,
 * and the camera for a barcode. Open Food Facts is never reached: each lookup is answered by stubFoods.
 */
import { test, expect, openView, today, daysAgo, type Page, type APIRequestContext } from "../support/fixtures";

type Answer = { status?: number; json: any };
type Lookup = (url: URL) => Answer | Promise<Answer>;
interface Asked { search: URL[]; barcode: URL[] }

/**
 * Answers the page's lookups (the search and the barcode). A lookup that is not stubbed is answered empty, so nothing reaches
 * Open Food Facts. What was asked is recorded in order, by the URL the page asked.
 */
async function stubFoods(page: Page, stub: { search?: Lookup; barcode?: Lookup } = {}): Promise<Asked> {
  const asked: Asked = { search: [], barcode: [] };
  await page.route("**/api/foods/search*", async (route) => {
    const url = new URL(route.request().url());
    asked.search.push(url);
    const answer = stub.search ? await stub.search(url) : { json: { foods: [] } };
    await route.fulfill({ status: answer.status ?? 200, json: answer.json });
  });
  await page.route("**/api/foods/barcode*", async (route) => {
    const url = new URL(route.request().url());
    asked.barcode.push(url);
    const answer = stub.barcode ? await stub.barcode(url) : { json: { food: null } };
    await route.fulfill({ status: answer.status ?? 200, json: answer.json });
  });
  return asked;
}

/** A gate a stubbed lookup waits at until the test opens it, so that the page can be seen while it is under way. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

// Foods as Open Food Facts answers them in a search: per 100 g, the nutrients the index holds, a portion for the granola bars.
const GRANOLA_HIT = {
  code: "3017620422003", name: "Granola bars", brand: "Nature Valley", per100: { kcal: 450, proteinG: 8, carbsG: 62, fatG: 17 },
  nutrients: { fiberG: 4 }, complete: false, unit: "g", canada: true, servingG: 40, servingText: "1 bar (40 g)",
};
const OATS_HIT = { code: null, name: "Rolled oats", brand: null, per100: { kcal: 380, proteinG: 13, carbsG: 60, fatG: 7 }, nutrients: {}, complete: false, unit: "g", canada: false, servingG: null, servingText: null };
const OAT_DRINK_HIT = { code: "5000159407236", name: "Oat drink", brand: null, per100: { kcal: 45, proteinG: 1, carbsG: 7, fatG: 1.5 }, nutrients: {}, complete: false, unit: "ml", canada: true, servingG: null, servingText: null };
// the product's own page: every nutrient it has, and the portion
const GRANOLA_FULL = { ...GRANOLA_HIT, complete: true, nutrients: { fiberG: 4, sodiumMg: 60 }, servingG: 42, servingText: "1 bar (42 g)" };
const OAT_DRINK_FULL = { ...OAT_DRINK_HIT, complete: true, nutrients: { fiberG: 0.8, sodiumMg: 60 }, servingG: 250, servingText: "1 cup (250 ml)" };

// Foods logged before, as the log holds them (a product keeps the quantity it was scaled from).
const OATMEAL = { name: "Oatmeal", kcal: 300, proteinG: 10, carbsG: 54, fatG: 5, nutrients: { fiberG: 4 } };
const BANANA = { name: "Banana", kcal: 105, proteinG: 1, carbsG: 27, fatG: 0 };
const WRAP = { name: "Chicken wrap", kcal: 520, proteinG: 34, carbsG: 48, fatG: 20 };
const GRANOLA_PRODUCT = {
  code: "3017620422003", name: "Granola bars", brand: "Nature Valley", unit: "g", per: "portion", per100: { kcal: 450, proteinG: 8, carbsG: 62, fatG: 17 },
  nutrients: { fiberG: 4 }, servingG: 40, servingText: "1 bar (40 g)", amount: 2,
};
const GRANOLA_LOGGED = { name: "Granola bars (Nature Valley) · 2 × 40 g", kcal: 360, proteinG: 6.4, carbsG: 49.6, fatG: 13.6, nutrients: { fiberG: 3.2 }, product: GRANOLA_PRODUCT };

interface Logged { id: number; meal: string; name: string; kcal: number; proteinG: number; carbsG: number; fatG: number; nutrients: Record<string, number>; product: unknown }

/** The foods of the log on a day, each with its meal. */
async function logged(api: APIRequestContext, day = today()): Promise<Logged[]> {
  const res = await api.get(`/api/nutrition?date=${day}`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.day.meals.flatMap((m: any) => m.entries.map((e: any) => ({ ...e, meal: m.meal })));
}

/** Logs foods in a meal of a day through the API, and gives back their ids. */
async function seed(api: APIRequestContext, day: string, meal: string, items: Record<string, unknown>[]): Promise<number[]> {
  const res = await api.post("/api/nutrition", { data: { action: "add", day, meal, items } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).added;
}

/** The section of one meal of the Food view. */
const section = (page: Page, meal: string) => page.locator(`#fbody section.fmeal[data-meal="${meal}"]`);

/** The Food view's search box of a meal. */
const searchBox = (page: Page, meal = "breakfast") => section(page, meal).getByRole("searchbox", { name: "Search a food" });

/** The Recent button of a meal. */
const recentButton = (page: Page, meal = "breakfast") => section(page, meal).getByRole("button", { name: "Recent", exact: true });

/** The rows of the foods used lately, shown under a meal's search box. */
const recentRows = (page: Page, meal = "breakfast") => section(page, meal).locator(".frec");

/** Opens a food's details in a meal and gives its Change button. */
async function openEntry(page: Page, meal: string, name: string) {
  const head = section(page, meal).locator(".fhead", { hasText: name });
  await head.click();
  return section(page, meal).getByRole("button", { name: `Change ${name}` });
}

/** The camera dialog of the Scan button. */
const scanDialog = (page: Page) => page.locator("#scandlg");

test.describe("the search box", () => {
  test("a search under three characters does not ask Open Food Facts", async ({ me }) => {
    await me.clock.install();
    const asked = await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await me.clock.pauseAt(new Date(Date.now() + 3_600_000));
    await searchBox(me).pressSequentially("ab");
    await me.clock.runFor(1000);
    await searchBox(me).pressSequentially("c");
    await me.clock.runFor(1000);
    // the query of the first search is the three letters: "ab" asked nothing, or it would be first in the list
    await expect.poll(() => asked.search.map((u) => u.searchParams.get("q"))).toEqual(["abc"]);
    await expect(section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" })).toBeVisible();
  });

  test("a search asks after the typing pauses, with the words in the query", async ({ me }) => {
    await me.clock.install();
    const asked = await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await me.clock.pauseAt(new Date(Date.now() + 3_600_000));
    await searchBox(me).pressSequentially("oat milk");
    await expect.poll(() => asked.search.length).toBe(0);
    await me.clock.runFor(1000);
    await expect.poll(() => asked.search.map((u) => u.pathname)).toEqual(["/api/foods/search"]);
    expect(asked.search[0].searchParams.get("q")).toBe("oat milk");
    await expect(section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" })).toBeVisible();
  });

  test("typing on sends one search, for the words typed last", async ({ me }) => {
    await me.clock.install();
    const asked = await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await me.clock.pauseAt(new Date(Date.now() + 3_600_000));
    await searchBox(me).pressSequentially("gra");
    await me.clock.runFor(200);
    await searchBox(me).pressSequentially("nola");
    await me.clock.runFor(1000);
    await expect.poll(() => asked.search.map((u) => u.searchParams.get("q"))).toEqual(["granola"]);
  });

  test("Enter searches at once, and the pause after it asks nothing more", async ({ me }) => {
    await me.clock.install();
    const asked = await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await me.clock.pauseAt(new Date(Date.now() + 3_600_000));
    await searchBox(me).pressSequentially("granola");
    await searchBox(me).press("Enter");
    await expect.poll(() => asked.search.map((u) => u.searchParams.get("q"))).toEqual(["granola"]);
    await me.clock.runFor(1000);
    await expect.poll(() => asked.search.length).toBe(1);
  });

  test("the search says it is searching while the answer is under way", async ({ me }) => {
    const release = gate();
    await stubFoods(me, { search: async () => { await release.wait; return { json: { foods: [OATS_HIT] } }; } });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    await expect(section(me, "breakfast").locator(".fresults")).toContainText("Searching…");
    release.open();
    await expect(section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" })).toBeVisible();
    await expect(section(me, "breakfast").locator(".fresults")).not.toContainText("Searching…");
  });

  test("a result shows its name, its brand and its nutrition per 100 g", async ({ me }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [GRANOLA_HIT, OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("granola");
    const row = section(me, "breakfast").locator("button.fr", { hasText: "Granola bars" });
    await expect(row.locator(".frb")).toHaveText("Nature Valley");
    await expect(row.locator(".frm")).toHaveText("450 kcal · P 8 · C 62 · F 17 per 100 g");
    // a food with no brand shows none
    await expect(section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).locator(".frb")).toHaveCount(0);
    await expect(section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).locator(".frm")).toHaveText("380 kcal · P 13 · C 60 · F 7 per 100 g");
  });

  test("products sold in Canada come first, under their heading, then the others under theirs", async ({ me }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [GRANOLA_HIT, OAT_DRINK_HIT, OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("granola");
    const results = section(me, "breakfast").locator(".fresults");
    await expect(results.locator(".fgroup").filter({ hasText: "Sold in Canada" })).toBeVisible();
    const headings = await results.locator(".fgroup").allTextContents(); // the headings are drawn in capitals, so the text is read as written
    expect(headings).toEqual(["Open Food Facts", "Sold in Canada", "Other countries"]);
    const names = await results.locator("button.fr b").allTextContents();
    expect(names).toEqual(["Granola bars", "Oat drink", "Rolled oats"]);
  });

  test("when every product is sold in Canada there is no country heading", async ({ me }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [GRANOLA_HIT, OAT_DRINK_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("granola");
    await expect(section(me, "breakfast").locator("button.fr")).toHaveCount(2);
    await expect(section(me, "breakfast").locator(".fgroup", { hasText: "Other countries" })).toHaveCount(0);
    await expect(section(me, "breakfast").locator(".fgroup", { hasText: "Sold in Canada" })).toHaveCount(0);
  });

  test("the results credit Open Food Facts", async ({ me }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    const credit = section(me, "breakfast").locator(".fcredit");
    await expect(credit).toContainText("Data: Open Food Facts (ODbL)");
    await expect(credit.getByRole("link", { name: "Open Food Facts" })).toHaveAttribute("href", "https://world.openfoodfacts.org/");
  });

  test("a search with nothing found says so, and suggests the words or entering it by hand", async ({ me }) => {
    await stubFoods(me);
    await openView(me, "food");
    await searchBox(me).fill("qwertyuiop");
    await expect(section(me, "breakfast").locator(".fresults")).toContainText("Nothing found. Try other words, or enter it by hand.");
    await expect(section(me, "breakfast").locator("button.fr")).toHaveCount(0);
  });

  test("a search Open Food Facts cannot answer shows its message in red", async ({ me }) => {
    await stubFoods(me, { search: () => ({ status: 502, json: { error: "Open Food Facts is unavailable right now (503)." } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    const note = section(me, "breakfast").locator(".fnote.err");
    await expect(note).toHaveText("Open Food Facts is unavailable right now (503).");
  });

  test("a server error on the search shows its message", async ({ me }) => {
    await stubFoods(me, { search: () => ({ status: 500, json: { error: "Something broke on the server." } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    await expect(section(me, "breakfast").locator(".fnote.err")).toHaveText("Something broke on the server.");
  });

  test("the search works again after an error", async ({ me }) => {
    let failing = true;
    await stubFoods(me, { search: () => (failing ? { status: 502, json: { error: "Open Food Facts did not answer in time." } } : { json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    await expect(section(me, "breakfast").locator(".fnote.err")).toBeVisible();
    failing = false;
    await searchBox(me).fill("oats!");
    await expect(section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" })).toBeVisible();
    await expect(section(me, "breakfast").locator(".fnote.err")).toHaveCount(0);
  });

  test("an answer to an earlier search is dropped when the words have changed since", async ({ me }) => {
    const slow = gate(), inFlight = gate();
    await stubFoods(me, {
      search: async (url) => {
        if (url.searchParams.get("q") === "granola") { inFlight.open(); await slow.wait; return { json: { foods: [GRANOLA_HIT] } }; }
        return { json: { foods: [OATS_HIT] } };
      },
    });
    await openView(me, "food");
    await searchBox(me).fill("granola");
    await inFlight.wait; // the search for "granola" is on its way before the words change
    await searchBox(me).fill("oats");
    await expect(section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" })).toBeVisible();
    slow.open();
    // the late answer for "granola" is not shown: the list still holds the oats
    await expect(section(me, "breakfast").locator("button.fr", { hasText: "Granola bars" })).toHaveCount(0);
    await expect(section(me, "breakfast").locator("button.fr")).toHaveCount(1);
  });

  test("a result with no barcode does not ask for a product page when it is picked and added", async ({ me, profile }) => {
    const asked = await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    await section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).click();
    await section(me, "breakfast").getByRole("button", { name: "Add", exact: true }).click();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Rolled oats · 100 g" })).toBeVisible();
    expect(asked.barcode).toHaveLength(0);
    expect(await logged(profile.api)).toHaveLength(1);
  });
});

test.describe("each meal's own search", () => {
  test("every meal has its own search box, and a search in one meal shows nothing in the others", async ({ me }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    for (const meal of ["breakfast", "lunch", "dinner", "snack"]) await expect(searchBox(me, meal)).toBeVisible();
    await searchBox(me, "snack").fill("oats");
    await expect(section(me, "snack").locator("button.fr", { hasText: "Rolled oats" })).toBeVisible();
    for (const meal of ["breakfast", "lunch", "dinner"]) {
      await expect(searchBox(me, meal)).toHaveValue("");
      await expect(section(me, meal).locator("button.fr")).toHaveCount(0);
    }
  });

  test("a food picked in one meal is logged in that meal", async ({ me, profile }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me, "dinner").fill("oats");
    await section(me, "dinner").locator("button.fr", { hasText: "Rolled oats" }).click();
    await section(me, "dinner").getByRole("button", { name: "Add", exact: true }).click();
    await expect(section(me, "dinner").locator(".fe .fn", { hasText: "Rolled oats · 100 g" })).toBeVisible();
    const [entry] = await logged(profile.api);
    expect(entry.meal).toBe("dinner");
  });
});

test.describe("picking a food", () => {
  test("a result with a portion size opens the picker at one portion, with grams and the portion to choose", async ({ me }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [GRANOLA_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("granola");
    await section(me, "breakfast").locator("button.fr", { hasText: "Granola bars" }).click();
    const picker = section(me, "breakfast").locator(".fpick");
    await expect(picker).toBeVisible();
    await expect(picker.locator(".fpn b")).toHaveText("Granola bars");
    await expect(picker.locator(".fpn")).toContainText("Nature Valley");
    await expect(picker.locator(".fph")).toHaveText("450 kcal · P 8 · C 62 · F 17 per 100 g");
    await expect(picker.getByRole("spinbutton", { name: "Quantity" })).toHaveValue("1");
    const unit = picker.getByRole("combobox", { name: "Unit" });
    await expect(unit.locator("option")).toHaveText(["g", "portion (40 g)"]);
    await expect(unit).toHaveValue("portion");
    await expect(picker.locator(".fpv")).toContainText("180 kcal · P 3.2 · C 24.8 · F 6.8");
    await expect(picker.getByRole("button", { name: "Add", exact: true })).toBeEnabled();
  });

  test("a food with no portion size is weighed in grams, starting at 100 g", async ({ me }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    await section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).click();
    const picker = section(me, "breakfast").locator(".fpick");
    await expect(picker.getByRole("spinbutton", { name: "Quantity" })).toHaveValue("100");
    const unit = picker.getByRole("combobox", { name: "Unit" });
    await expect(unit.locator("option")).toHaveText(["g"]);
    await expect(picker.locator(".fpv")).toContainText("380 kcal · P 13 · C 60 · F 7");
  });

  test("a drink is measured in millilitres", async ({ me }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [OAT_DRINK_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("oat drink");
    await section(me, "breakfast").locator("button.fr", { hasText: "Oat drink" }).click();
    const picker = section(me, "breakfast").locator(".fpick");
    await expect(picker.getByRole("combobox", { name: "Unit" }).locator("option")).toHaveText(["ml"]);
    await expect(picker.getByRole("spinbutton", { name: "Quantity" })).toHaveValue("100");
    await expect(picker.locator(".fph")).toContainText("per 100 ml");
  });

  test("the calories and macros follow the quantity typed in grams", async ({ me }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [GRANOLA_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("granola");
    await section(me, "breakfast").locator("button.fr", { hasText: "Granola bars" }).click();
    const picker = section(me, "breakfast").locator(".fpick");
    const amount = picker.getByRole("spinbutton", { name: "Quantity" });
    await picker.getByRole("combobox", { name: "Unit" }).selectOption("g");
    await amount.fill("200");
    await expect(picker.locator(".fpv")).toContainText("900 kcal · P 16 · C 124 · F 34");
    await expect(picker.locator(".fpm")).toHaveText("Fiber 8 g");
    await amount.fill("50");
    await expect(picker.locator(".fpv")).toContainText("225 kcal · P 4 · C 31 · F 8.5");
    await expect(picker.locator(".fpm")).toHaveText("Fiber 2 g");
  });

  test("the portions scale the numbers too: two portions are 80 g", async ({ me }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [GRANOLA_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("granola");
    await section(me, "breakfast").locator("button.fr", { hasText: "Granola bars" }).click();
    const picker = section(me, "breakfast").locator(".fpick");
    await picker.getByRole("spinbutton", { name: "Quantity" }).fill("2");
    await expect(picker.locator(".fpv")).toContainText("360 kcal · P 6.4 · C 49.6 · F 13.6");
    await expect(picker.locator(".fpm")).toHaveText("Fiber 3.2 g");
  });

  test("switching the unit carries the portion's weight over, and back to a portion gives one", async ({ me }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [GRANOLA_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("granola");
    await section(me, "breakfast").locator("button.fr", { hasText: "Granola bars" }).click();
    const picker = section(me, "breakfast").locator(".fpick");
    const amount = picker.getByRole("spinbutton", { name: "Quantity" }), unit = picker.getByRole("combobox", { name: "Unit" });
    await unit.selectOption("g");
    await expect(amount).toHaveValue("40");
    await expect(picker.locator(".fpv")).toContainText("180 kcal");
    await unit.selectOption("portion");
    await expect(amount).toHaveValue("1");
    await expect(picker.locator(".fpv")).toContainText("180 kcal");
  });

  test("a quantity of 0, nothing, or more than 2000 g says what is allowed and cannot be added", async ({ me }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    await section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).click();
    const picker = section(me, "breakfast").locator(".fpick");
    const amount = picker.getByRole("spinbutton", { name: "Quantity" }), add = picker.getByRole("button", { name: "Add", exact: true });
    for (const bad of ["0", "", "100000"]) {
      await amount.fill(bad);
      await expect(picker.locator(".fpv")).toHaveText("Give a quantity (up to 2000 g).");
      await expect(add).toBeDisabled();
    }
    await amount.fill("2000");
    await expect(add).toBeEnabled();
    await expect(picker.locator(".fpv")).toContainText(/7,?600 kcal · P 260 · C 1,?200 · F 140/);
  });

  test("Enter in the quantity with an invalid amount adds nothing", async ({ me, profile }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    await section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).click();
    const picker = section(me, "breakfast").locator(".fpick");
    await picker.getByRole("spinbutton", { name: "Quantity" }).fill("0");
    await picker.getByRole("spinbutton", { name: "Quantity" }).press("Enter");
    await expect(picker).toBeVisible();
    expect(await logged(profile.api)).toHaveLength(0);
  });

  test("Add logs the food scaled to the portions eaten, with its name and nutrients", async ({ me, profile }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [GRANOLA_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("granola");
    await section(me, "breakfast").locator("button.fr", { hasText: "Granola bars" }).click();
    const picker = section(me, "breakfast").locator(".fpick");
    await picker.getByRole("spinbutton", { name: "Quantity" }).fill("2");
    await picker.getByRole("button", { name: "Add", exact: true }).click();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Granola bars (Nature Valley) · 2 × 40 g" })).toBeVisible();
    const [entry] = (await logged(profile.api)).filter((e) => e.name.startsWith("Granola"));
    expect(entry).toMatchObject({ meal: "breakfast", name: "Granola bars (Nature Valley) · 2 × 40 g", kcal: 360, nutrients: { fiberG: 3.2 } });
    expect(entry.proteinG).toBeCloseTo(6.4);
    expect(entry.carbsG).toBeCloseTo(49.6);
    expect(entry.fatG).toBeCloseTo(13.6);
    expect(entry.product).toMatchObject({ code: "3017620422003", per: "portion", amount: 2, servingG: 40 });
  });

  test("Add in grams logs the grams in the name", async ({ me, profile }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    await section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).click();
    const picker = section(me, "breakfast").locator(".fpick");
    await picker.getByRole("spinbutton", { name: "Quantity" }).fill("150");
    await picker.getByRole("button", { name: "Add", exact: true }).click();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Rolled oats · 150 g" })).toBeVisible();
    const [entry] = await logged(profile.api);
    expect(entry).toMatchObject({ name: "Rolled oats · 150 g", kcal: 570, meal: "breakfast" });
    expect(entry.product).toMatchObject({ code: null, per: "g", amount: 150 });
  });

  test("Enter in the quantity adds the food", async ({ me, profile }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    await section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).click();
    const amount = section(me, "breakfast").getByRole("spinbutton", { name: "Quantity" });
    await amount.fill("200");
    await amount.press("Enter");
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Rolled oats · 200 g" })).toBeVisible();
    expect(await logged(profile.api)).toHaveLength(1);
  });

  test("the picker's ✕ goes back to the search", async ({ me }) => {
    await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    await section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).click();
    await expect(section(me, "breakfast").locator(".fpick")).toBeVisible();
    await section(me, "breakfast").getByRole("button", { name: "Choose another food" }).click();
    await expect(section(me, "breakfast").locator(".fpick")).toHaveCount(0);
    await expect(searchBox(me)).toBeVisible();
    await expect(searchBox(me)).toBeFocused();
  });

  test("while the product's own page loads, the picker says so and Add waits for it, then adds its nutrients and portion", async ({ me, profile }) => {
    const release = gate();
    await stubFoods(me, {
      search: () => ({ json: { foods: [OAT_DRINK_HIT] } }),
      barcode: async () => { await release.wait; return { json: { food: OAT_DRINK_FULL } }; },
    });
    await openView(me, "food");
    await searchBox(me).fill("oat drink");
    await section(me, "breakfast").locator("button.fr", { hasText: "Oat drink" }).click();
    const picker = section(me, "breakfast").locator(".fpick");
    await expect(picker.locator(".fpv")).toContainText("Loading the other nutrients…");
    await expect(picker.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
    await expect(picker.getByRole("combobox", { name: "Unit" }).locator("option")).toHaveText(["ml"]);
    release.open();
    await expect(picker.locator(".fpv")).not.toContainText("Loading the other nutrients…");
    await expect(picker.locator(".fpm")).toHaveText("Fiber 0.8 g · Sodium 60 mg");
    await expect(picker.getByRole("button", { name: "Add", exact: true })).toBeEnabled();
    await expect(picker.getByRole("combobox", { name: "Unit" }).locator("option")).toHaveText(["ml", "portion (250 ml)"]);
    await picker.getByRole("button", { name: "Add", exact: true }).click();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Oat drink · 100 ml" })).toBeVisible();
    const [entry] = await logged(profile.api);
    expect(entry.nutrients).toMatchObject({ fiberG: 0.8, sodiumMg: 60 });
  });

  test("a product page that cannot be fetched leaves the search's numbers in use", async ({ me, profile }) => {
    await stubFoods(me, {
      search: () => ({ json: { foods: [OAT_DRINK_HIT] } }),
      barcode: () => ({ status: 502, json: { error: "Open Food Facts did not answer in time." } }),
    });
    await openView(me, "food");
    await searchBox(me).fill("oat drink");
    await section(me, "breakfast").locator("button.fr", { hasText: "Oat drink" }).click();
    const picker = section(me, "breakfast").locator(".fpick");
    await expect(picker.getByRole("button", { name: "Add", exact: true })).toBeEnabled();
    await expect(picker.locator(".fpv")).not.toContainText("Loading the other nutrients…");
    await expect(picker.locator(".fpv")).toContainText("45 kcal · P 1 · C 7 · F 1.5");
    await picker.getByRole("button", { name: "Add", exact: true }).click();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Oat drink · 100 ml" })).toBeVisible();
    expect(await logged(profile.api)).toHaveLength(1);
  });

  test("a result with a barcode asks for its product page when it is picked", async ({ me }) => {
    const asked = await stubFoods(me, { search: () => ({ json: { foods: [GRANOLA_HIT] } }), barcode: () => ({ json: { food: GRANOLA_FULL } }) });
    await openView(me, "food");
    await searchBox(me).fill("granola");
    await section(me, "breakfast").locator("button.fr", { hasText: "Granola bars" }).click();
    await expect.poll(() => asked.barcode.map((u) => u.searchParams.get("code"))).toEqual(["3017620422003"]);
    const picker = section(me, "breakfast").locator(".fpick");
    await expect(picker.locator(".fpm")).toHaveText("Fiber 1.6 g · Sodium 24 mg");
    await expect(picker.getByRole("combobox", { name: "Unit" }).locator("option")).toHaveText(["g", "portion (40 g)"]);
  });
});

test.describe("barcodes", () => {
  test("a barcode typed in the box is looked up as a barcode, not searched for", async ({ me }) => {
    await me.clock.install();
    const asked = await stubFoods(me, { barcode: () => ({ json: { food: GRANOLA_FULL } }), search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await me.clock.pauseAt(new Date(Date.now() + 3_600_000));
    await searchBox(me).pressSequentially("3017620422003");
    await me.clock.runFor(1000);
    await expect.poll(() => asked.barcode.map((u) => u.searchParams.get("code"))).toEqual(["3017620422003"]);
    expect(asked.search).toHaveLength(0);
    await expect(section(me, "breakfast").locator(".fpick .fpn b")).toHaveText("Granola bars");
  });

  test("a barcode pasted with spaces and dashes is read the same", async ({ me }) => {
    const asked = await stubFoods(me, { barcode: () => ({ json: { food: GRANOLA_FULL } }) });
    await openView(me, "food");
    await searchBox(me).fill("3017 6204-22003");
    await searchBox(me).press("Enter");
    await expect(section(me, "breakfast").locator(".fpick .fpn b")).toHaveText("Granola bars");
    expect(asked.barcode.map((u) => u.searchParams.get("code"))).toEqual(["3017620422003"]);
    expect(asked.search).toHaveLength(0);
  });

  test("an 8-digit UPC-E code is expanded to its 12-digit UPC-A for the lookup", async ({ me }) => {
    const asked = await stubFoods(me, { barcode: () => ({ json: { food: { ...GRANOLA_FULL, code: "042100005264" } } }) });
    await openView(me, "food");
    await searchBox(me).fill("04252614");
    await searchBox(me).press("Enter");
    await expect(section(me, "breakfast").locator(".fpick .fpn b")).toHaveText("Granola bars");
    expect(asked.barcode.map((u) => u.searchParams.get("code"))).toEqual(["042100005264"]);
  });

  test("an EAN-8 typed in the box is looked up as it is", async ({ me }) => {
    const asked = await stubFoods(me, { barcode: () => ({ json: { food: GRANOLA_FULL } }) });
    await openView(me, "food");
    await searchBox(me).fill("12345670");
    await searchBox(me).press("Enter");
    await expect(section(me, "breakfast").locator(".fpick .fpn b")).toHaveText("Granola bars");
    expect(asked.barcode.map((u) => u.searchParams.get("code"))).toEqual(["12345670"]);
    expect(asked.search).toHaveLength(0);
  });

  test("a UPC-A typed in the box is looked up as it is", async ({ me }) => {
    const asked = await stubFoods(me, { barcode: () => ({ json: { food: GRANOLA_FULL } }) });
    await openView(me, "food");
    await searchBox(me).fill("0012000161155");
    await searchBox(me).press("Enter");
    await expect(section(me, "breakfast").locator(".fpick .fpn b")).toHaveText("Granola bars");
    expect(asked.barcode.map((u) => u.searchParams.get("code"))).toEqual(["0012000161155"]);
  });

  test("a code with a wrong check digit is not a barcode: it is searched for as words", async ({ me }) => {
    const asked = await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("3017620422004");
    await searchBox(me).press("Enter");
    await expect.poll(() => asked.search.map((u) => u.searchParams.get("q"))).toEqual(["3017620422004"]);
    expect(asked.barcode).toHaveLength(0);
  });

  test("a barcode nobody has says so", async ({ me }) => {
    const asked = await stubFoods(me, { barcode: () => ({ json: { food: null } }) });
    await openView(me, "food");
    await searchBox(me).fill("3017620422003");
    await searchBox(me).press("Enter");
    await expect(section(me, "breakfast").locator(".fnote")).toHaveText("3017620422003 is not in Open Food Facts, or has no nutrition values. Enter it by hand.");
    expect(asked.search).toHaveLength(0);
  });

  test("a barcode lookup that fails shows its message in red", async ({ me }) => {
    await stubFoods(me, { barcode: () => ({ status: 502, json: { error: "Open Food Facts could not be reached." } }) });
    await openView(me, "food");
    await searchBox(me).fill("3017620422003");
    await searchBox(me).press("Enter");
    await expect(section(me, "breakfast").locator(".fnote.err")).toHaveText("Open Food Facts could not be reached.");
  });

  test("while a barcode is looked up, the box says which one", async ({ me }) => {
    const release = gate();
    await stubFoods(me, { barcode: async () => { await release.wait; return { json: { food: GRANOLA_FULL } }; } });
    await openView(me, "food");
    await searchBox(me).fill("3017620422003");
    await searchBox(me).press("Enter");
    await expect(section(me, "breakfast").locator(".fresults")).toContainText("Looking up 3017620422003…");
    release.open();
    await expect(section(me, "breakfast").locator(".fpick .fpn b")).toHaveText("Granola bars");
  });
});

test.describe("the camera for a barcode", () => {
  test("Scan opens the camera dialog and, with no camera, says so", async ({ me }) => {
    await me.context().grantPermissions([]);
    await openView(me, "food");
    await section(me, "breakfast").getByRole("button", { name: "📷 Scan" }).click();
    await expect(scanDialog(me)).toBeVisible();
    await expect(me.locator("#scanNote")).toHaveText(/No camera was found on this device\.|The camera was refused/);
    await expect(me.locator("#scanNote")).toHaveClass(/err/);
  });

  test("Cancel closes the camera dialog", async ({ me }) => {
    await me.context().grantPermissions([]);
    await openView(me, "food");
    await section(me, "breakfast").getByRole("button", { name: "📷 Scan" }).click();
    await expect(scanDialog(me)).toBeVisible();
    await me.locator("#scanCancel").click();
    await expect(scanDialog(me)).toBeHidden();
    await expect(section(me, "breakfast").locator(".fpick")).toHaveCount(0);
  });

  test("Escape closes the camera dialog too", async ({ me }) => {
    await me.context().grantPermissions([]);
    await openView(me, "food");
    await section(me, "breakfast").getByRole("button", { name: "📷 Scan" }).click();
    await expect(scanDialog(me)).toBeVisible();
    await me.keyboard.press("Escape");
    await expect(scanDialog(me)).toBeHidden();
  });
});

test.describe("foods used lately (Recent)", () => {
  test("a tap in the box lists the foods logged for that meal, first", async ({ alice }) => {
    await openView(alice, "food");
    await searchBox(alice).click();
    await expect(recentButton(alice)).toHaveAttribute("aria-pressed", "true");
    await expect(section(alice, "breakfast").locator(".fnote.fgroup", { hasText: "Recent: tap to add" })).toBeVisible();
    const names = await recentRows(alice).locator("b").allInnerTexts();
    expect(names.slice(0, 2).sort()).toEqual(["Banana", "Oatmeal"]);
    expect(names).toHaveLength(5);
  });

  test("the Recent button opens the list and shuts it again", async ({ alice }) => {
    await openView(alice, "food");
    await expect(recentButton(alice)).toHaveAttribute("aria-pressed", "false");
    await expect(recentRows(alice)).toHaveCount(0);
    await recentButton(alice).click();
    await expect(recentButton(alice)).toHaveAttribute("aria-pressed", "true");
    await expect(recentRows(alice).first()).toBeVisible();
    await recentButton(alice).click();
    await expect(recentButton(alice)).toHaveAttribute("aria-pressed", "false");
    await expect(recentRows(alice)).toHaveCount(0);
  });

  test("a food logged in another meal comes after those of this meal", async ({ alice }) => {
    await openView(alice, "food");
    await recentButton(alice, "lunch").click();
    const lunch = await recentRows(alice, "lunch").locator("b").allInnerTexts();
    expect(lunch[0]).toBe("Chicken wrap");
    expect(lunch.slice(1).sort()).toEqual(["Banana", "Greek yogurt", "Oatmeal", "Salmon and rice"]);
  });

  test("each meal's list opens on its own", async ({ alice }) => {
    await openView(alice, "food");
    await recentButton(alice, "breakfast").click();
    await expect(recentButton(alice, "breakfast")).toHaveAttribute("aria-pressed", "true");
    await expect(recentButton(alice, "lunch")).toHaveAttribute("aria-pressed", "false");
    await expect(recentRows(alice, "lunch")).toHaveCount(0);
  });

  test("a recent food shows its calories and macros", async ({ alice }) => {
    await openView(alice, "food");
    await recentButton(alice).click();
    const oatmeal = recentRows(alice).filter({ hasText: "Oatmeal" });
    await expect(oatmeal.locator(".frm")).toHaveText("300 kcal · P 10 · C 54 · F 5");
    await expect(oatmeal.locator(".fplus")).toHaveText("+");
    await expect(alice.getByRole("button", { name: "Add Oatmeal to Breakfast" })).toBeVisible();
  });

  test("tapping a recent food logs it as it was, and says so with a toast", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL]);
    await openView(me, "food");
    await recentButton(me).click();
    await me.getByRole("button", { name: "Add Oatmeal to Breakfast" }).click();
    await expect(me.locator("#toast")).toContainText("Added Oatmeal to Breakfast.");
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Oatmeal" })).toBeVisible();
    const [entry] = await logged(profile.api);
    expect(entry).toMatchObject({ meal: "breakfast", name: "Oatmeal", kcal: 300, proteinG: 10, carbsG: 54, fatG: 5, nutrients: { fiberG: 4 } });
  });

  test("Undo in that toast takes the food back", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [BANANA]);
    await openView(me, "food");
    await recentButton(me).click();
    await me.getByRole("button", { name: "Add Banana to Breakfast" }).click();
    await expect(me.locator("#toast")).toContainText("Added Banana to Breakfast.");
    expect(await logged(profile.api)).toHaveLength(1);
    await me.locator("#toast").getByRole("button", { name: "Undo" }).click();
    await expect(me.locator("#toast")).toContainText("Removed 1 food.");
    await expect.poll(async () => (await logged(profile.api)).length).toBe(0);
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Banana" })).toHaveCount(0);
  });

  test("a recent food with a quantity is logged again with that quantity, so it can be changed by it", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [GRANOLA_LOGGED]);
    await openView(me, "food");
    await recentButton(me).click();
    await me.getByRole("button", { name: "Add Granola bars (Nature Valley) · 2 × 40 g to Breakfast" }).click();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Granola bars (Nature Valley) · 2 × 40 g" })).toBeVisible();
    const change = await openEntry(me, "breakfast", "Granola bars (Nature Valley) · 2 × 40 g");
    await change.click();
    const picker = section(me, "breakfast").locator(".fpick");
    await expect(picker.getByRole("spinbutton", { name: "Quantity" })).toHaveValue("2");
    await expect(picker.getByRole("combobox", { name: "Unit" })).toHaveValue("portion");
  });

  test("typing filters the list to the foods whose name has every word typed", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL, BANANA, WRAP]);
    await stubFoods(me);
    await openView(me, "food");
    await searchBox(me).click();
    await expect(recentRows(me)).toHaveCount(3);
    await searchBox(me).fill("chicken wrap");
    await expect(section(me, "breakfast").locator(".fnote.fgroup", { hasText: "Logged before" })).toBeVisible();
    await expect(recentRows(me)).toHaveCount(1);
    await expect(recentRows(me)).toContainText("Chicken wrap");
    await searchBox(me).fill("wrap chicken");
    await expect(recentRows(me)).toHaveCount(1);
    await searchBox(me).fill("wrap oat");
    await expect(recentRows(me)).toHaveCount(0);
  });

  test("the filter ignores case and accents", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "snack", [{ name: "Crème fraîche", kcal: 190, proteinG: 2, carbsG: 3, fatG: 19 }]);
    await stubFoods(me);
    await openView(me, "food");
    await searchBox(me, "snack").fill("CREME fraiche");
    await expect(recentRows(me, "snack")).toHaveCount(1);
    await expect(recentRows(me, "snack")).toContainText("Crème fraîche");
  });

  test("a list of more than eight shows eight, and Show the rest", async ({ me, profile }) => {
    const items = Array.from({ length: 10 }, (_, i) => ({ name: `Snack ${String.fromCharCode(65 + i)}`, kcal: 100 + i, proteinG: 1, carbsG: 2, fatG: 3 }));
    await seed(profile.api, daysAgo(1), "lunch", items);
    await openView(me, "food");
    await recentButton(me, "lunch").click();
    await expect(recentRows(me, "lunch")).toHaveCount(8);
    const more = section(me, "lunch").getByRole("button", { name: "Show 2 more" });
    await more.click();
    await expect(recentRows(me, "lunch")).toHaveCount(10);
    await expect(section(me, "lunch").getByRole("button", { name: /Show \d+ more/ })).toHaveCount(0);
  });

  test("a meal with nothing logged before says so", async ({ me }) => {
    await openView(me, "food");
    await recentButton(me).click();
    await expect(section(me, "breakfast").locator(".fresults")).toContainText("Nothing logged yet. What you add shows up here, to add again in one tap.");
    await expect(recentRows(me)).toHaveCount(0);
  });

  test("a search that matches nothing in the list and nothing on Open Food Facts shows no list heading", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [BANANA]);
    await stubFoods(me);
    await openView(me, "food");
    await searchBox(me).fill("zzz");
    await expect(section(me, "breakfast").locator(".fresults")).toContainText("Nothing found.");
    await expect(section(me, "breakfast").locator(".fnote.fgroup", { hasText: "Logged before" })).toHaveCount(0);
    await expect(recentRows(me)).toHaveCount(0);
  });
  test("a food logged more than once is listed once, as it was last logged", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(2), "breakfast", [{ ...OATMEAL, kcal: 290 }]);
    await seed(profile.api, daysAgo(1), "breakfast", [{ ...OATMEAL, kcal: 320 }]);
    await openView(me, "food");
    await recentButton(me).click();
    await expect(recentRows(me)).toHaveCount(1);
    await expect(recentRows(me).locator(".frm")).toHaveText("320 kcal · P 10 · C 54 · F 5");
  });

  test("a food added from the picker today is the first of this meal's list the next time", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [BANANA]);
    await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    await section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).click();
    await section(me, "breakfast").getByRole("button", { name: "Add", exact: true }).click();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Rolled oats · 100 g" })).toBeVisible();
    await recentButton(me).click();
    await expect(recentRows(me).first()).toContainText("Rolled oats");
  });

  test("a tap on a recent food keeps the list open for the next one", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL, BANANA]);
    await openView(me, "food");
    await recentButton(me).click();
    await me.getByRole("button", { name: "Add Oatmeal to Breakfast" }).click();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Oatmeal" })).toBeVisible();
    await expect(recentButton(me)).toHaveAttribute("aria-pressed", "true");
    await expect(me.getByRole("button", { name: "Add Banana to Breakfast" })).toBeVisible();
    await me.getByRole("button", { name: "Add Banana to Breakfast" }).click();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Banana" })).toBeVisible();
    expect((await logged(profile.api)).map((e) => e.name).sort()).toEqual(["Banana", "Oatmeal"]);
  });

  test("a tap on a recent food while words are typed clears the words and shows the whole list", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL, BANANA, WRAP]);
    await stubFoods(me);
    await openView(me, "food");
    await searchBox(me).fill("ban");
    await expect(recentRows(me)).toHaveCount(1);
    await me.getByRole("button", { name: "Add Banana to Breakfast" }).click();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Banana" })).toBeVisible();
    await expect(searchBox(me)).toHaveValue("");
    await expect(recentRows(me)).toHaveCount(3);
  });

  test("on a past day a recent food is logged on that day", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(2), "dinner", [WRAP]);
    await openView(me, "food");
    await me.locator("#fPrev").click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    await recentButton(me, "dinner").click();
    await me.getByRole("button", { name: "Add Chicken wrap to Dinner" }).click();
    await expect(section(me, "dinner").locator(".fe .fn", { hasText: "Chicken wrap" })).toBeVisible();
    const yesterday = await logged(profile.api, daysAgo(1));
    expect(yesterday).toMatchObject([{ meal: "dinner", name: "Chicken wrap", kcal: 520 }]);
    expect(await logged(profile.api, daysAgo(2))).toHaveLength(1);
  });
});

test.describe("the focus the page puts in the search box does not open Recent", () => {
  test("after a food is picked and ✕ is pressed, the box has the focus and Recent stays shut", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL]);
    await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    await section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).click();
    await section(me, "breakfast").getByRole("button", { name: "Choose another food" }).click();
    await expect(searchBox(me)).toBeFocused();
    await expect(recentButton(me)).toHaveAttribute("aria-pressed", "false");
    await expect(recentRows(me)).toHaveCount(0);
  });

  test("after a food is added from the picker, the box has the focus and Recent stays shut", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL]);
    await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    await section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).click();
    await section(me, "breakfast").getByRole("button", { name: "Add", exact: true }).click();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Rolled oats · 100 g" })).toBeVisible();
    await expect(searchBox(me)).toBeFocused();
    await expect(recentButton(me)).toHaveAttribute("aria-pressed", "false");
    await expect(recentRows(me)).toHaveCount(0);
  });

  test("after Other food is chosen to change an entry, the box has the focus and Recent stays shut", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL]);
    await seed(profile.api, today(), "breakfast", [GRANOLA_LOGGED]);
    await stubFoods(me);
    await openView(me, "food");
    const change = await openEntry(me, "breakfast", "Granola bars (Nature Valley) · 2 × 40 g");
    await change.click();
    await section(me, "breakfast").getByRole("button", { name: "Other food" }).click();
    await expect(section(me, "breakfast").locator(".frepl")).toBeVisible();
    await expect(searchBox(me)).toBeFocused();
    await expect(recentButton(me)).toHaveAttribute("aria-pressed", "false");
    await expect(recentRows(me)).toHaveCount(0);
  });

  test("a real click in the box still opens Recent once the page has put the focus there", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL]);
    await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    await searchBox(me).fill("oats");
    await section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).click();
    await section(me, "breakfast").getByRole("button", { name: "Choose another food" }).click();
    await expect(searchBox(me)).toBeFocused();
    await expect(recentRows(me)).toHaveCount(0);
    // the box has the focus already, so the click is what needs to bring it: leave it first
    await searchBox(me).evaluate((el: HTMLElement) => el.blur());
    await searchBox(me).click();
    await expect(recentButton(me)).toHaveAttribute("aria-pressed", "true");
    await expect(recentRows(me).first()).toBeVisible();
    await expect(recentRows(me)).toContainText("Oatmeal");
  });
});

test.describe("changing a logged food by its quantity or by another food", () => {
  test("Change opens the picker at the logged quantity, and Save changes the entry in place", async ({ me, profile }) => {
    const [id] = await seed(profile.api, today(), "breakfast", [GRANOLA_LOGGED]);
    await stubFoods(me);
    await openView(me, "food");
    const change = await openEntry(me, "breakfast", "Granola bars (Nature Valley) · 2 × 40 g");
    await change.click();
    const picker = section(me, "breakfast").locator(".fpick");
    await expect(picker.getByRole("spinbutton", { name: "Quantity" })).toHaveValue("2");
    await expect(picker.getByRole("combobox", { name: "Unit" })).toHaveValue("portion");
    await expect(picker.locator(".fpv")).toContainText("360 kcal");
    await picker.getByRole("spinbutton", { name: "Quantity" }).fill("3");
    await picker.getByRole("button", { name: "Save", exact: true }).click();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Granola bars (Nature Valley) · 3 × 40 g" })).toBeVisible();
    const entries = await logged(profile.api);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id, name: "Granola bars (Nature Valley) · 3 × 40 g", kcal: 540 });
  });

  test("Cancel in the changing picker leaves the entry as it was", async ({ me, profile }) => {
    await seed(profile.api, today(), "breakfast", [GRANOLA_LOGGED]);
    await stubFoods(me);
    await openView(me, "food");
    const change = await openEntry(me, "breakfast", "Granola bars (Nature Valley) · 2 × 40 g");
    await change.click();
    const picker = section(me, "breakfast").locator(".fpick");
    await picker.getByRole("spinbutton", { name: "Quantity" }).fill("5");
    await picker.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(section(me, "breakfast").locator(".fpick")).toHaveCount(0);
    const [entry] = await logged(profile.api);
    expect(entry).toMatchObject({ name: "Granola bars (Nature Valley) · 2 × 40 g", kcal: 360 });
  });

  test("while changing, the picker has no ✕ and the entry is marked as being changed", async ({ me, profile }) => {
    await seed(profile.api, today(), "breakfast", [GRANOLA_LOGGED]);
    await stubFoods(me);
    await openView(me, "food");
    const change = await openEntry(me, "breakfast", "Granola bars (Nature Valley) · 2 × 40 g");
    await change.click();
    await expect(section(me, "breakfast").getByRole("button", { name: "Choose another food" })).toHaveCount(0);
    await expect(section(me, "breakfast").locator(".fe.editing")).toHaveCount(1);
  });

  test("Other food shows the banner, and the food chosen is saved over the entry", async ({ me, profile }) => {
    const [id] = await seed(profile.api, today(), "breakfast", [GRANOLA_LOGGED]);
    await stubFoods(me, { search: () => ({ json: { foods: [OATS_HIT] } }) });
    await openView(me, "food");
    const change = await openEntry(me, "breakfast", "Granola bars (Nature Valley) · 2 × 40 g");
    await change.click();
    await section(me, "breakfast").getByRole("button", { name: "Other food" }).click();
    const banner = section(me, "breakfast").locator(".frepl");
    await expect(banner).toContainText("Choose the food to put in place of Granola bars (Nature Valley) · 2 × 40 g.");
    await searchBox(me).fill("oats");
    await section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).click();
    const picker = section(me, "breakfast").locator(".fpick");
    await expect(picker.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Choose another food" })).toHaveCount(0);
    await picker.getByRole("spinbutton", { name: "Quantity" }).fill("150");
    await picker.getByRole("button", { name: "Save", exact: true }).click();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Rolled oats · 150 g" })).toBeVisible();
    const entries = await logged(profile.api);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id, name: "Rolled oats · 150 g", kcal: 570 });
  });

  test("the banner's Cancel leaves the entry and the search as they were", async ({ me, profile }) => {
    await seed(profile.api, today(), "breakfast", [GRANOLA_LOGGED]);
    await stubFoods(me);
    await openView(me, "food");
    const change = await openEntry(me, "breakfast", "Granola bars (Nature Valley) · 2 × 40 g");
    await change.click();
    await section(me, "breakfast").getByRole("button", { name: "Other food" }).click();
    await section(me, "breakfast").locator(".frepl").getByRole("button", { name: "Cancel" }).click();
    await expect(section(me, "breakfast").locator(".frepl")).toHaveCount(0);
    await expect(recentRows(me)).toHaveCount(0);
    const [entry] = await logged(profile.api);
    expect(entry.name).toBe("Granola bars (Nature Valley) · 2 × 40 g");
  });

  test("while another food is chosen, Recent offers only the foods with a quantity", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL]);
    await seed(profile.api, today(), "breakfast", [GRANOLA_LOGGED]);
    await stubFoods(me);
    await openView(me, "food");
    const change = await openEntry(me, "breakfast", "Granola bars (Nature Valley) · 2 × 40 g");
    await change.click();
    await section(me, "breakfast").getByRole("button", { name: "Other food" }).click();
    await recentButton(me).click();
    await expect(section(me, "breakfast").locator(".fnote.fgroup", { hasText: "Recent: tap to choose" })).toBeVisible();
    await expect(recentRows(me)).toHaveCount(1);
    await expect(me.getByRole("button", { name: "Choose Granola bars (Nature Valley) · 2 × 40 g" })).toBeVisible();
    await expect(me.getByRole("button", { name: "Choose Oatmeal" })).toHaveCount(0);
  });

  test("a food chosen from Recent in place of another opens the picker at its quantity, and Save replaces the entry", async ({ me, profile }) => {
    const [id] = await seed(profile.api, today(), "breakfast", [GRANOLA_LOGGED]);
    await stubFoods(me);
    await openView(me, "food");
    const change = await openEntry(me, "breakfast", "Granola bars (Nature Valley) · 2 × 40 g");
    await change.click();
    await section(me, "breakfast").getByRole("button", { name: "Other food" }).click();
    await recentButton(me).click();
    await me.getByRole("button", { name: "Choose Granola bars (Nature Valley) · 2 × 40 g" }).click();
    const picker = section(me, "breakfast").locator(".fpick");
    await expect(picker.getByRole("spinbutton", { name: "Quantity" })).toHaveValue("2");
    await picker.getByRole("button", { name: "Save", exact: true }).click();
    const entries = await logged(profile.api);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id, name: "Granola bars (Nature Valley) · 2 × 40 g", kcal: 360 });
  });
});
