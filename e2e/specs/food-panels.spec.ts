/**
 * The Food view opens nothing the person did not open. After an action (Save, Cancel, Move, Undo, Add) the only things open are those
 * the person had opened: no form by hand left open by a change, no food's details opened in the meal it was moved to, no Recent list
 * opened by a focus the person did not give (the page's own, or the one the browser gives back on a return to the tab or when a
 * dialog shuts), and nothing of one day (or profile) still open on another.
 *
 * Each test checks the whole view with `opened`, so a panel that opens anywhere else fails it too. Open Food Facts is never reached.
 */
import { test, expect, openView, today, daysAgo, loginAs, ADMIN_TOKEN, type Page, type APIRequestContext } from "../support/fixtures";

const OATMEAL = { name: "Oatmeal", kcal: 300, proteinG: 10, carbsG: 54, fatG: 5, nutrients: { fiberG: 4 } };
const BANANA = { name: "Banana", kcal: 105, proteinG: 1, carbsG: 27, fatG: 0 };
const GRANOLA_PRODUCT = {
  code: "3017620422003", name: "Granola bars", brand: "Nature Valley", unit: "g", per: "portion", per100: { kcal: 450, proteinG: 8, carbsG: 62, fatG: 17 },
  nutrients: { fiberG: 4 }, servingG: 40, servingText: "1 bar (40 g)", amount: 2,
};
const GRANOLA = { name: "Granola bars (Nature Valley) · 2 × 40 g", kcal: 360, proteinG: 6.4, carbsG: 49.6, fatG: 13.6, nutrients: { fiberG: 3.2 }, product: GRANOLA_PRODUCT };
const OATS_HIT = { code: null, name: "Rolled oats", brand: null, per100: { kcal: 380, proteinG: 13, carbsG: 60, fatG: 7 }, nutrients: {}, complete: false, unit: "g", canada: false, servingG: null, servingText: null };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The label the Food view gives a day: "Thu 29 Oct". */
const labelOf = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};

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
 * What is open in the Food view, in the order of the page: per meal its form by hand, its Recent list, its picker and the foods whose
 * details are shown ("breakfast: Oatmeal"); then the AI box and any dialog. Empty when nothing is.
 */
function opened(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    if (document.querySelector('#fbody .faihead[aria-expanded="true"]')) out.push("AI box");
    for (const s of document.querySelectorAll<HTMLElement>("#fbody section.fmeal")) {
      const meal = s.dataset.meal;
      if (s.querySelector<HTMLDetailsElement>("details.fhand")!.open) out.push(`${meal}: by hand`);
      if (s.querySelector('.ffrow button[aria-pressed="true"]')) out.push(`${meal}: recent`);
      if (s.querySelector(".fpick")) out.push(`${meal}: picker`);
      for (const name of s.querySelectorAll(".fe.open .fn")) out.push(`${meal}: ${name.textContent}`);
    }
    for (const d of document.querySelectorAll("dialog[open]")) out.push(`dialog ${d.id}`);
    return out;
  });
}

/** Waits until what is open in the Food view is exactly `what` (see `opened`). */
const openIs = (page: Page, what: string[]) => expect.poll(() => opened(page)).toEqual(what);

const section = (page: Page, meal: string) => page.locator(`#fbody section.fmeal[data-meal="${meal}"]`);
const row = (page: Page, meal: string, name: string) => section(page, meal).locator(".fe", { has: page.locator(".fn", { hasText: name }) });
const searchBox = (page: Page, meal = "breakfast") => section(page, meal).getByRole("searchbox", { name: "Search a food" });
const recentButton = (page: Page, meal = "breakfast") => section(page, meal).getByRole("button", { name: "Recent", exact: true });
const handSummary = (page: Page, meal: string) => section(page, meal).locator("details.fhand > summary");

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

/** Searches oats in a meal, picks Rolled oats and adds 100 g of it: the page then puts the cursor back in the search box. */
async function addOatsFromPicker(page: Page, meal = "breakfast") {
  await searchBox(page, meal).fill("oats");
  await section(page, meal).locator("button.fr", { hasText: "Rolled oats" }).click();
  await section(page, meal).locator(".fpick").getByRole("button", { name: "Add", exact: true }).click();
  await expect(section(page, meal).locator(".fe .fn", { hasText: "Rolled oats · 100 g" })).toBeVisible();
  await expect(searchBox(page, meal)).toBeFocused();
}

test.describe("Food: a change shuts the form it opened", () => {
  test("Save of a food changed by hand shuts the form Change opened, and it stays shut on the next redraw", async ({ me, profile }) => {
    await seed(profile.api, today(), "breakfast", [OATMEAL, BANANA]);
    await openFood(me);
    await openRow(me, "breakfast", "Oatmeal");
    await me.getByRole("button", { name: "Change Oatmeal" }).click();
    await expect(handSummary(me, "breakfast")).toHaveText("Change the food");
    await openIs(me, ["breakfast: by hand", "breakfast: Oatmeal"]);
    await section(me, "breakfast").locator("form.fform").locator('input[aria-label="kcal"]').fill("320");
    await section(me, "breakfast").locator("form.fform button[type='submit']").click();
    await expect(row(me, "breakfast", "Oatmeal").locator(".fk")).toHaveText("320 kcal");
    await expect(handSummary(me, "breakfast")).toHaveText("Enter by hand");
    await openIs(me, ["breakfast: Oatmeal"]);
    // another action draws the view again: the form Change opened does not come back
    await row(me, "breakfast", "Oatmeal").getByRole("button", { name: "+ Add again" }).click();
    await expect(section(me, "breakfast").locator(".fe")).toHaveCount(3);
    await openIs(me, ["breakfast: Oatmeal"]);
  });

  test("Cancel of a change by hand shuts the form too", async ({ me, profile }) => {
    await seed(profile.api, today(), "dinner", [OATMEAL]);
    await openFood(me);
    await openRow(me, "dinner", "Oatmeal");
    await me.getByRole("button", { name: "Change Oatmeal" }).click();
    await openIs(me, ["dinner: by hand", "dinner: Oatmeal"]);
    await section(me, "dinner").locator("form.fform").getByRole("button", { name: "Cancel" }).click();
    await expect(handSummary(me, "dinner")).toHaveText("Enter by hand");
    await openIs(me, ["dinner: Oatmeal"]);
  });

  test("a form by hand the person had opened is still open once the change in its meal is done", async ({ me, profile }) => {
    await seed(profile.api, today(), "breakfast", [OATMEAL]);
    await openFood(me);
    await handSummary(me, "breakfast").click();
    await handSummary(me, "snack").click();
    await openRow(me, "breakfast", "Oatmeal");
    await me.getByRole("button", { name: "Change Oatmeal" }).click();
    await expect(handSummary(me, "breakfast")).toHaveText("Change the food");
    await section(me, "breakfast").locator("form.fform").getByRole("button", { name: "Cancel" }).click();
    await expect(handSummary(me, "breakfast")).toHaveText("Enter by hand");
    await openIs(me, ["breakfast: by hand", "breakfast: Oatmeal", "snack: by hand"]);
  });

  test("a form by hand the person shuts stays shut", async ({ me }) => {
    await openFood(me);
    await handSummary(me, "lunch").click();
    await openIs(me, ["lunch: by hand"]);
    await handSummary(me, "lunch").click();
    await openIs(me, []);
    await recentButton(me, "lunch").click(); // the Recent list draws the meal again
    await recentButton(me, "lunch").click();
    await openIs(me, []);
  });

  test("Edit the numbers of a food with a quantity, then Save, leaves neither the picker nor the form open", async ({ me, profile }) => {
    await seed(profile.api, today(), "lunch", [GRANOLA]);
    await stubFoods(me);
    await openFood(me);
    await openRow(me, "lunch", "Granola bars");
    await me.getByRole("button", { name: `Change ${GRANOLA.name}` }).click();
    await openIs(me, ["lunch: picker", `lunch: ${GRANOLA.name}`]);
    await section(me, "lunch").getByRole("button", { name: "Edit the numbers" }).click();
    await openIs(me, ["lunch: by hand", `lunch: ${GRANOLA.name}`]);
    await section(me, "lunch").locator("form.fform").locator('input[aria-label="kcal"]').fill("365");
    await section(me, "lunch").locator("form.fform button[type='submit']").click();
    await expect(row(me, "lunch", "Granola bars").locator(".fk")).toHaveText("365 kcal");
    await openIs(me, [`lunch: ${GRANOLA.name}`]);
  });

  test("Save in the picker of a food with a quantity leaves only its details open", async ({ me, profile }) => {
    await seed(profile.api, today(), "lunch", [GRANOLA]);
    await stubFoods(me);
    await openFood(me);
    await openRow(me, "lunch", "Granola bars");
    await me.getByRole("button", { name: `Change ${GRANOLA.name}` }).click();
    await section(me, "lunch").locator(".fpick").getByRole("spinbutton", { name: "Quantity" }).fill("3");
    await section(me, "lunch").locator(".fpick").getByRole("button", { name: "Save" }).click();
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

test.describe("Food: Recent opens on a tap or Tab into the search box, not on a focus that comes otherwise", () => {
  test("a tap in the box opens Recent there only", async ({ alice }) => {
    await openFood(alice);
    await searchBox(alice, "lunch").click();
    await openIs(alice, ["lunch: recent"]);
  });

  test("the cursor the page puts back in the box after Add opens nothing, and a tap in the box then opens Recent", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL]);
    await stubFoods(me);
    await openFood(me);
    await addOatsFromPicker(me);
    await openIs(me, []);
    // the box has the cursor already: the tap is what asks for the list
    await searchBox(me).click();
    await openIs(me, ["breakfast: recent"]);
    await expect(section(me, "breakfast").locator(".frec", { hasText: "Oatmeal" })).toBeVisible();
  });

  test("coming back to the tab or the window, which gives the box its focus back, does not open Recent", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL]);
    await stubFoods(me);
    await openFood(me);
    await addOatsFromPicker(me);
    await openIs(me, []);
    // what the browser does when the person leaves the tab and comes back: the box loses the focus with the window, and gets it back
    await searchBox(me).evaluate((box: HTMLInputElement) => {
      box.blur();
      window.dispatchEvent(new FocusEvent("blur"));
      window.dispatchEvent(new FocusEvent("focus"));
      box.focus();
    });
    await expect(searchBox(me)).toBeFocused();
    await openIs(me, []);
  });

  test("a dialog that shuts gives the box its focus back without opening Recent", async ({ alice }) => {
    await alice.context().grantPermissions([]);
    await openFood(alice);
    await searchBox(alice).click();
    await openIs(alice, ["breakfast: recent"]);
    // a browser that leaves the focus in the box when a button is tapped (Safari): the box still has it when the camera opens
    await recentButton(alice).evaluate((b: HTMLElement) => b.click());
    await openIs(alice, []);
    await section(alice, "breakfast").getByRole("button", { name: "📷 Scan" }).evaluate((b: HTMLElement) => b.click());
    await expect(alice.locator("#scandlg")).toBeVisible();
    await alice.keyboard.press("Escape");
    await expect(alice.locator("#scandlg")).toBeHidden();
    await expect(searchBox(alice)).toBeFocused();
    await openIs(alice, []);
  });

  test("Tab into the box opens Recent, for the keyboard", async ({ alice }) => {
    await openFood(alice);
    await recentButton(alice, "snack").focus();
    await alice.keyboard.press("Shift+Tab");
    await expect(searchBox(alice, "snack")).toBeFocused();
    await openIs(alice, ["snack: recent"]);
  });

  test("adding a recent food keeps that list open for the next one, and opens nothing else", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(1), "breakfast", [OATMEAL, BANANA]);
    await openFood(me);
    await searchBox(me).click();
    await me.getByRole("button", { name: "Add Oatmeal to Breakfast" }).click();
    await expect(section(me, "breakfast").locator(".fe .fn")).toHaveText(["Oatmeal"]);
    await openIs(me, ["breakfast: recent"]);
    await me.locator("#toast").getByRole("button", { name: "Undo" }).click();
    await expect(section(me, "breakfast").locator(".fe")).toHaveCount(0);
    await openIs(me, ["breakfast: recent"]);
  });
});

test.describe("Food: another day (or profile) starts with nothing open", () => {
  test("Recent, a search, a form by hand and a food's details of today are shut on the day before, and on today again", async ({ me, profile }) => {
    await seed(profile.api, today(), "breakfast", [OATMEAL]);
    await seed(profile.api, daysAgo(1), "breakfast", [BANANA]);
    await stubFoods(me);
    await openFood(me);
    await searchBox(me, "lunch").click();
    await searchBox(me, "snack").click();
    await searchBox(me, "snack").fill("oats");
    await expect(section(me, "snack").locator("button.fr", { hasText: "Rolled oats" })).toBeVisible();
    await handSummary(me, "dinner").click();
    await openRow(me, "breakfast", "Oatmeal");
    await openIs(me, ["breakfast: Oatmeal", "lunch: recent", "dinner: by hand", "snack: recent"]);
    await me.locator("#fPrev").click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(section(me, "breakfast").locator(".fe .fn")).toHaveText(["Banana"]);
    await openIs(me, []);
    await expect(searchBox(me, "snack")).toHaveValue("");
    await expect(section(me, "snack").locator(".fresults > *")).toHaveCount(0);
    await me.locator("#fNext").click();
    await expect(me.locator("#fDate")).toHaveValue(today());
    await openIs(me, []);
  });

  test("the picker of a food being added shuts when a day is picked in the Every day table", async ({ me, profile }) => {
    await seed(profile.api, daysAgo(2), "lunch", [BANANA]);
    await stubFoods(me);
    await openFood(me);
    await searchBox(me).fill("oats");
    await section(me, "breakfast").locator("button.fr", { hasText: "Rolled oats" }).click();
    await openIs(me, ["breakfast: picker"]);
    await me.locator(".rmetrics tbody tr", { has: me.locator("td.day", { hasText: labelOf(daysAgo(2)) }) }).click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(2));
    await expect(section(me, "lunch").locator(".fe .fn")).toHaveText(["Banana"]);
    await openIs(me, []);
  });

  test("a day typed in the address opens with nothing open", async ({ alice }) => {
    await openFood(alice);
    await searchBox(alice).click();
    await handSummary(alice, "lunch").click();
    await openIs(alice, ["breakfast: recent", "lunch: by hand"]);
    await alice.evaluate((day) => { location.hash = `#food/${day}`; }, daysAgo(2));
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(2));
    await expect(section(alice, "breakfast").locator(".fe .fn")).toHaveText(["Oatmeal", "Banana"]);
    await openIs(alice, []);
  });

  test("the admin's choice of another profile opens it with nothing of the first one's open", async ({ page, profile }) => {
    await loginAs(page, "admin", ADMIN_TOKEN);
    await openFood(page);
    await page.locator("#fProfile").selectOption("alice");
    await expect(page.locator("#fProfile")).toHaveValue("alice");
    await handSummary(page, "breakfast").click();
    await recentButton(page, "lunch").click();
    await openIs(page, ["breakfast: by hand", "lunch: recent"]);
    await page.locator("#fProfile").selectOption(profile.name);
    await expect(page.locator("#fProfile")).toHaveValue(profile.name);
    await expect(section(page, "breakfast").locator(".fmh > b")).toHaveText("Breakfast");
    await openIs(page, []);
  });
});
