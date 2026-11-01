/**
 * The Food view opens nothing the person did not open. After an action (Save, Cancel, Move, Undo, Add) the only things open are those
 * the person had opened: no add sheet left open by a change once it is saved or cancelled, no food's details opened in the meal it was
 * moved to, nothing opened by a tap that logs a food, and nothing of one day (or profile) still open on another. The sheet shuts the
 * ways a dialog does (✕, Done, Back, Escape), and a dialog over it (the camera) shuts alone.
 *
 * Each test checks the whole view with `opened`, so a panel that opens anywhere else fails it too. Open Food Facts is never reached.
 */
import { test, expect, openView, today, daysAgo, loginAs, ADMIN_TOKEN, type Page, type APIRequestContext } from "../support/fixtures";
import { labelOf, nutrients, openSheet, sheetClose, sheetTab } from "../support/food";

const OATMEAL = { name: "Oatmeal", kcal: 300, proteinG: 10, carbsG: 54, fatG: 5, nutrients: { fiberG: 4 } };
const BANANA = { name: "Banana", kcal: 105, proteinG: 1, carbsG: 27, fatG: 0 };
const GRANOLA_PRODUCT = {
  code: "3017620422003", name: "Granola bars", brand: "Nature Valley", unit: "g", per: "portion", per100: { kcal: 450, proteinG: 8, carbsG: 62, fatG: 17 },
  nutrients: { fiberG: 4 }, servingG: 40, servingText: "1 bar (40 g)", amount: 2,
};
const GRANOLA = { name: "Granola bars (Nature Valley) · 2 × 40 g", kcal: 360, proteinG: 6.4, carbsG: 49.6, fatG: 13.6, nutrients: { fiberG: 3.2 }, product: GRANOLA_PRODUCT };
const OATS_HIT = { code: null, name: "Rolled oats", brand: null, per100: { kcal: 380, proteinG: 13, carbsG: 60, fatG: 7 }, nutrients: {}, complete: false, unit: "g", canada: false, servingG: null, servingText: null };

/** Logs foods in a meal of a day through the API. */
async function seed(api: APIRequestContext, day: string, meal: string, items: Record<string, unknown>[]): Promise<void> {
  const res = await api.post("/api/nutrition", { data: { action: "add", day, meal, items } });
  expect(res.ok()).toBeTruthy();
}

/** Answers the page's food search with Rolled oats, and a barcode with nothing, so nothing reaches Open Food Facts. */
async function stubFoods(page: Page): Promise<void> {
  await page.route("**/api/foods/search*", (route) => route.fulfill({ json: { foods: [OATS_HIT] } }));
  await page.route("**/api/foods/barcode*", (route) => route.fulfill({ json: { food: null } }));
}

/**
 * What is open in the Food view, in the order of the page: the add sheet and what it shows ("sheet: find", the search; "ai", "hand",
 * "pick" the picker, "edit" a food changed by hand), the foods whose details are shown ("breakfast: Oatmeal"), the nutrients under the
 * summary, then any other dialog. Empty when nothing is.
 */
function opened(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    if ((document.getElementById("fsheet") as HTMLDialogElement).open) out.push(`sheet: ${document.getElementById("fsh")!.dataset.mode}`);
    for (const s of document.querySelectorAll<HTMLElement>("#fbody section.fmeal")) {
      for (const name of s.querySelectorAll(".fe.open .fn")) out.push(`${s.dataset.meal}: ${name.textContent}`);
    }
    if (document.querySelector("#fbody details.fnuts[open]")) out.push("nutrients");
    for (const d of document.querySelectorAll("dialog[open]")) if (d.id !== "fsheet") out.push(`dialog ${d.id}`);
    return out;
  });
}

/** Waits until what is open in the Food view is exactly `what` (see `opened`). */
const openIs = (page: Page, what: string[]) => expect.poll(() => opened(page)).toEqual(what);

const section = (page: Page, meal: string) => page.locator(`#fbody section.fmeal[data-meal="${meal}"]`);
const row = (page: Page, meal: string, name: string) => section(page, meal).locator(".fe", { has: page.locator(".fn", { hasText: name }) });
const searchBox = (page: Page) => page.locator("#fsh").getByRole("searchbox", { name: "Search a food" });
const form = (page: Page) => page.locator("#fsh form.fform");
const picker = (page: Page) => page.locator("#fsh .fpick");
/** The quick-add strip's meal, and its card for a food. */
const stripMeal = (page: Page) => page.locator("#fbody .fquick").getByRole("combobox", { name: "The meal a tap adds to" });

/** Opens the Food view and waits until its day has loaded. */
async function openFood(page: Page) {
  await openView(page, "food");
  await expect(page.locator("#fbody .fmeal").first()).toBeVisible();
}

/** Opens a food's details (the person's tap on it). */
async function openRow(page: Page, meal: string, name: string) {
  await row(page, meal, name).locator(".fhead").click();
  await expect(row(page, meal, name)).toHaveClass(/\bopen\b/);
}

test.describe("Food: a change shuts the sheet it opened", () => {
  test("Save of a food changed by hand shuts the sheet Change opened, and it stays shut on the next redraw", async ({ me, profile }) => {
    await seed(profile.api, today(), "breakfast", [OATMEAL, BANANA]);
    await openFood(me);
    await openRow(me, "breakfast", "Oatmeal");
    await me.getByRole("button", { name: "Change Oatmeal" }).click();
    await openIs(me, ["sheet: edit", "breakfast: Oatmeal"]);
    await form(me).locator('input[aria-label="kcal"]').fill("320");
    await form(me).locator("button[type='submit']").click();
    await expect(row(me, "breakfast", "Oatmeal").locator(".fk")).toHaveText("320 kcal");
    await openIs(me, ["breakfast: Oatmeal"]);
    // another action draws the view again: the sheet Change opened does not come back
    await row(me, "breakfast", "Oatmeal").getByRole("button", { name: "+ Add again" }).click();
    await expect(section(me, "breakfast").locator(".fe")).toHaveCount(3);
    await openIs(me, ["breakfast: Oatmeal"]);
  });

  test("Cancel of a change by hand shuts the sheet too", async ({ me, profile }) => {
    await seed(profile.api, today(), "dinner", [OATMEAL]);
    await openFood(me);
    await openRow(me, "dinner", "Oatmeal");
    await me.getByRole("button", { name: "Change Oatmeal" }).click();
    await openIs(me, ["sheet: edit", "dinner: Oatmeal"]);
    await form(me).getByRole("button", { name: "Cancel" }).click();
    await openIs(me, ["dinner: Oatmeal"]);
  });

  test("a change left with Escape changes nothing, and the next sheet opened is to add a food, on the search", async ({ me, profile }) => {
    await seed(profile.api, today(), "dinner", [OATMEAL]);
    await openFood(me);
    await openRow(me, "dinner", "Oatmeal");
    await me.getByRole("button", { name: "Change Oatmeal" }).click();
    await form(me).locator('input[aria-label="kcal"]').fill("999");
    await me.keyboard.press("Escape");
    await openIs(me, ["dinner: Oatmeal"]);
    await expect(row(me, "dinner", "Oatmeal").locator(".fk")).toHaveText("300 kcal");
    await expect(section(me, "dinner").locator(".fe.editing")).toHaveCount(0);
    await openSheet(me, "dinner");
    await expect(me.locator("#fshTitle")).toHaveText("Add food");
    await openIs(me, ["sheet: find", "dinner: Oatmeal"]);
    await sheetTab(me, "By hand").click();
    await expect(form(me).locator('input[aria-label="kcal"]')).toHaveValue(""); // nothing of the change is left in the form
  });

  test("Back during a change shuts the sheet and changes nothing", async ({ me, profile }) => {
    await seed(profile.api, today(), "lunch", [BANANA]);
    await openFood(me);
    await openRow(me, "lunch", "Banana");
    await me.getByRole("button", { name: "Change Banana" }).click();
    await openIs(me, ["sheet: edit", "lunch: Banana"]);
    await me.goBack();
    await openIs(me, ["lunch: Banana"]);
    await expect(me.locator("body")).toHaveAttribute("data-view", "food");
  });

  test("Edit the numbers of a food with a quantity, then Save, leaves neither the picker nor the form open", async ({ me, profile }) => {
    await seed(profile.api, today(), "lunch", [GRANOLA]);
    await stubFoods(me);
    await openFood(me);
    await openRow(me, "lunch", "Granola bars");
    await me.getByRole("button", { name: `Change ${GRANOLA.name}` }).click();
    await openIs(me, ["sheet: pick", `lunch: ${GRANOLA.name}`]);
    await picker(me).getByRole("button", { name: "Edit the numbers" }).click();
    await openIs(me, ["sheet: edit", `lunch: ${GRANOLA.name}`]);
    await form(me).locator('input[aria-label="kcal"]').fill("365");
    await form(me).locator("button[type='submit']").click();
    await expect(row(me, "lunch", "Granola bars").locator(".fk")).toHaveText("365 kcal");
    await openIs(me, [`lunch: ${GRANOLA.name}`]);
  });

  test("Save in the picker of a food with a quantity leaves only its details open", async ({ me, profile }) => {
    await seed(profile.api, today(), "lunch", [GRANOLA]);
    await stubFoods(me);
    await openFood(me);
    await openRow(me, "lunch", "Granola bars");
    await me.getByRole("button", { name: `Change ${GRANOLA.name}` }).click();
    await picker(me).getByRole("spinbutton", { name: "Quantity" }).fill("3");
    await picker(me).getByRole("button", { name: "Save" }).click();
    await expect(section(me, "lunch").locator(".fe .fn")).toHaveText("Granola bars (Nature Valley) · 3 × 40 g");
    await openIs(me, ["lunch: Granola bars (Nature Valley) · 3 × 40 g"]);
  });
});

test.describe("Food: a food moved, deleted or added again does not open elsewhere", () => {
  test("a food moved to another meal lands there shut, and Undo brings it back shut", async ({ me, profile }) => {
    await seed(profile.api, today(), "breakfast", [OATMEAL, BANANA]);
    await openFood(me);
    await openRow(me, "breakfast", "Oatmeal");
    await me.getByRole("combobox", { name: "Move Oatmeal to another meal" }).selectOption("dinner");
    await expect(section(me, "dinner").locator(".fe .fn")).toHaveText(["Oatmeal"]);
    await openIs(me, []);
    await me.locator("#toast").getByRole("button", { name: "Undo" }).click();
    await expect(section(me, "breakfast").locator(".fe .fn")).toHaveText(["Oatmeal", "Banana"]);
    await openIs(me, []);
  });

  test("moving one food leaves the other foods the person opened as they were", async ({ me, profile }) => {
    await seed(profile.api, today(), "breakfast", [OATMEAL, BANANA]);
    await openFood(me);
    await openRow(me, "breakfast", "Banana");
    await openRow(me, "breakfast", "Oatmeal");
    await me.getByRole("combobox", { name: "Move Oatmeal to another meal" }).selectOption("lunch");
    await expect(section(me, "lunch").locator(".fe .fn")).toHaveText(["Oatmeal"]);
    await openIs(me, ["breakfast: Banana"]);
  });

  test("Undo of a Delete brings the food back shut", async ({ me, profile }) => {
    await seed(profile.api, today(), "snack", [BANANA]);
    await openFood(me);
    await openRow(me, "snack", "Banana");
    await me.getByRole("button", { name: "Delete Banana" }).click();
    await me.locator("dialog[open]").getByRole("button", { name: "Delete" }).click();
    await expect(section(me, "snack").locator(".fe")).toHaveCount(0);
    await openIs(me, []);
    await me.locator("#toast").getByRole("button", { name: "Undo" }).click();
    await expect(section(me, "snack").locator(".fe .fn")).toHaveText(["Banana"]);
    await openIs(me, []);
  });

  test("+ Add again adds the food shut, under the one left open", async ({ me, profile }) => {
    await seed(profile.api, today(), "snack", [BANANA]);
    await openFood(me);
    await openRow(me, "snack", "Banana");
    await row(me, "snack", "Banana").getByRole("button", { name: "+ Add again" }).click();
    await expect(section(me, "snack").locator(".fe")).toHaveCount(2);
    await openIs(me, ["snack: Banana"]);
    await expect(section(me, "snack").locator(".fe").nth(1)).not.toHaveClass(/\bopen\b/);
  });
});

test.describe("Food: the sheet opens when asked, and shuts as a dialog does", () => {
  test("a tap on a quick-add card logs the food and opens nothing, and the nutrients the person opened stay open", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL]);
    await openFood(me);
    await nutrients(me);
    await stripMeal(me).selectOption("breakfast");
    await me.locator("#fbody .fquick").getByRole("button", { name: "Add Oatmeal to Breakfast" }).click();
    await expect(section(me, "breakfast").locator(".fe .fn")).toHaveText(["Oatmeal"]);
    await openIs(me, ["nutrients"]);
  });

  test("adding a recent food keeps the sheet on the search for the next one, and its Undo too", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL, BANANA]);
    await openFood(me);
    await openSheet(me, "breakfast");
    await me.locator("#fsh").getByRole("button", { name: "Add Oatmeal to Breakfast" }).click();
    await expect(section(me, "breakfast").locator(".fe .fn")).toHaveText(["Oatmeal"]);
    await openIs(me, ["sheet: find"]);
    await me.locator("#toast").getByRole("button", { name: "Undo" }).click();
    await expect(section(me, "breakfast").locator(".fe")).toHaveCount(0);
    await openIs(me, ["sheet: find"]);
  });

  test("Done shuts the sheet, and the foods added wait in their meal, shut", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL, BANANA]);
    await openFood(me);
    await openSheet(me, "breakfast");
    await me.locator("#fsh").getByRole("button", { name: "Add Oatmeal to Breakfast" }).click();
    await expect(section(me, "breakfast").locator(".fe .fn")).toHaveText(["Oatmeal"]);
    await me.locator("#fsh .fsh-foot").getByRole("button", { name: "Done" }).click();
    await openIs(me, []);
  });

  test("✕, Escape and Back each shut the sheet, and the view stays on the day", async ({ me }) => {
    await openFood(me);
    await me.locator("#fdSearch").click();
    await openIs(me, ["sheet: find"]);
    await sheetClose(me).click();
    await openIs(me, []);
    await me.locator("#fdSearch").click();
    await openIs(me, ["sheet: find"]);
    await me.keyboard.press("Escape");
    await openIs(me, []);
    await me.locator("#fdSearch").click();
    await openIs(me, ["sheet: find"]);
    await me.goBack();
    await openIs(me, []);
    await expect(me.locator("body")).toHaveAttribute("data-view", "food");
    await expect(me).toHaveURL(/#food$/);
  });

  test("the camera over the sheet shuts alone and gives the sheet back, on the search", async ({ alice }) => {
    await alice.context().grantPermissions([]);
    await openFood(alice);
    await openSheet(alice, "breakfast");
    await sheetTab(alice, "Scan").click();
    await expect(alice.locator("#scandlg")).toBeVisible();
    await openIs(alice, ["sheet: find", "dialog scandlg"]);
    await alice.keyboard.press("Escape");
    await openIs(alice, ["sheet: find"]);
    await expect(searchBox(alice)).toBeVisible();
  });

  test("a sheet shut on the search opens again on an empty search", async ({ me }) => {
    await stubFoods(me);
    await openFood(me);
    await openSheet(me, "lunch");
    await searchBox(me).fill("oats");
    await expect(me.locator("#fsh .fresults button.fr", { hasText: "Rolled oats" })).toBeVisible();
    await sheetClose(me).click();
    await openSheet(me, "lunch");
    await expect(searchBox(me)).toHaveValue("");
    await expect(me.locator("#fsh .fresults button.fr", { hasText: "Rolled oats" })).toHaveCount(0);
  });
});

test.describe("Food: another day (or profile) starts with nothing open", () => {
  test("a food's details of today are shut on the day before, and on today again", async ({ me, profile }) => {
    await seed(profile.api, today(), "breakfast", [OATMEAL]);
    await seed(profile.api, daysAgo(1), "breakfast", [BANANA]);
    await openFood(me);
    await openRow(me, "breakfast", "Oatmeal");
    await openIs(me, ["breakfast: Oatmeal"]);
    await me.locator("#fPrev").click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(section(me, "breakfast").locator(".fe .fn")).toHaveText(["Banana"]);
    await openIs(me, []);
    await me.locator("#fNext").click();
    await expect(me.locator("#fDate")).toHaveValue(today());
    await openIs(me, []);
  });

  test("a day picked in the Every day table opens with nothing open", async ({ me, profile }) => {
    await seed(profile.api, today(), "breakfast", [OATMEAL]);
    await seed(profile.api, daysAgo(2), "lunch", [BANANA]);
    await openFood(me);
    await openRow(me, "breakfast", "Oatmeal");
    await me.locator(".rmetrics tbody tr", { has: me.locator("td.day", { hasText: labelOf(daysAgo(2)) }) }).click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(2));
    await expect(section(me, "lunch").locator(".fe .fn")).toHaveText(["Banana"]);
    await openIs(me, []);
  });

  test("a day typed in the address while the sheet is open shuts it, and opens with nothing open", async ({ alice }) => {
    await stubFoods(alice);
    await openFood(alice);
    await openSheet(alice, "breakfast");
    await searchBox(alice).fill("oats");
    await openIs(alice, ["sheet: find"]);
    await alice.evaluate((day) => { location.hash = `#food/${day}`; }, daysAgo(2));
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(2));
    await expect(section(alice, "breakfast").locator(".fe .fn")).toHaveText(["Oatmeal", "Banana"]);
    await openIs(alice, []);
    await openSheet(alice, "breakfast");
    await expect(searchBox(alice)).toHaveValue(""); // the search of the other day is not carried over
  });

  test("the meal chosen for adding is forgotten on another day: the bar goes back to the meal of the hour", async ({ me, profile }) => {
    await me.clock.install({ time: new Date("2026-10-30T12:30:00Z") });
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL]);
    await openFood(me);
    await expect(me.locator("#fdLabel")).toHaveText("Add food to Lunch");
    await stripMeal(me).selectOption("snack");
    await expect(me.locator("#fdLabel")).toHaveText("Add food to Snacks");
    await me.locator("#fPrev").click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(me.locator("#fdLabel")).toHaveText("Add food to Lunch");
  });

  test("the admin's choice of another profile opens it with nothing of the first one's open", async ({ page, profile }) => {
    await loginAs(page, "admin", ADMIN_TOKEN);
    await openFood(page);
    await page.locator("#fProfile").selectOption("alice");
    await expect(page.locator("#fProfile")).toHaveValue("alice");
    await page.locator("#fPrev").click();
    await expect(page.locator("#fDate")).toHaveValue(daysAgo(1));
    await openRow(page, "breakfast", "Oatmeal");
    await openIs(page, ["breakfast: Oatmeal"]);
    await page.locator("#fProfile").selectOption(profile.name);
    await expect(page.locator("#fProfile")).toHaveValue(profile.name);
    await expect(section(page, "breakfast").locator(".fmt b")).toHaveText("Breakfast");
    await openIs(page, []);
  });
});
