/**
 * The Food view on a phone: the days, the summary in the first screen, the quick-add strip, the bar at the bottom, the add sheet over
 * the whole screen (Recent with one tap to add and Undo, the search results and the quantity picker, By hand), and the touch sizes of
 * all of it. alice's food is read only; anything that logs a food uses a profile of its own (`me`). Open Food Facts is never reached:
 * the search is answered by page.route.
 */
import { test, expect, openView, daysAgo, today, type Locator, type Page, type Profile } from "../support/fixtures";
import { dayButton, sheet, sheetTab } from "../support/food";

/** What sticks out past the phone's width, as shown: an element is cut at the edge of any box above it that clips its content. */
async function stickingOut(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const shownRight = (el: Element) => {
      let right = el.getBoundingClientRect().right;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== "visible") right = Math.min(right, p.getBoundingClientRect().right);
      }
      return right;
    };
    return [...document.body.querySelectorAll("*")]
      .filter((el) => {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && shownRight(el) > width + 0.5;
      })
      .slice(0, 8)
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} right=${Math.round(el.getBoundingClientRect().right)}`);
  });
}

// The suite shares this machine with other runs, so a step can take longer than the default 30 s on a loaded box: the time is kept
// generous here, while every wait on the page is still a web-first assertion that ends as soon as the page is there.
test.setTimeout(60_000);

/** Opens the Food view and waits until its day has loaded: the day arrows and the meals do nothing before that. */
async function openFood(page: Page) {
  await openView(page, "food");
  await expect(page.locator("#fbody .fmeal").first()).toBeVisible();
}

/** A meal's block on the day shown: the section that holds its foods and its +. */
const meal = (page: Page, name: string) => page.locator(`#fbody .fmeal[data-meal="${name}"]`);
const MEAL_LABEL: Record<string, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snacks" };

/** Opens the add sheet from a meal's + (on the search). */
async function openSheet(page: Page, name: string) {
  await meal(page, name).getByRole("button", { name: `Add a food to ${MEAL_LABEL[name]}` }).tap();
  await expect(sheet(page)).toBeVisible();
}

/** The sheet's parts: its search box, its list, its form by hand and its picker. */
const searchBox = (page: Page) => page.locator("#fsh .fq");
const results = (page: Page) => page.locator("#fsh .fresults");
const form = (page: Page) => page.locator("#fsh form.fform");
const picker = (page: Page) => page.locator("#fsh .fpick");

/** Turns the sheet to its form by hand. */
async function byHand(page: Page, name: string) {
  await openSheet(page, name);
  await sheetTab(page, "By hand").tap();
  await expect(form(page)).toBeVisible();
}

/** The heights, rounded, of the elements a locator finds. */
const heights = (locator: Locator) => locator.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));

/** Logs foods of the profile's own log, through its API, on a day (today unless given). */
async function logFoods(profile: Profile, mealName: string, items: { name: string; kcal: number; proteinG?: number; carbsG?: number; fatG?: number }[], day = today()) {
  const res = await profile.api.post("/api/nutrition", {
    data: { action: "add", profile: profile.name, day, meal: mealName, items: items.map((i) => ({ proteinG: 1, carbsG: 1, fatG: 1, ...i })) },
  });
  expect(res.ok()).toBeTruthy();
}

/** Open the food search results the page asks for: the Open Food Facts answer is a fixture, the page is what is tested. */
const searchAnswer = (foods: object[]) => JSON.stringify({ foods });
const oats = {
  code: null,
  name: "Rolled oats",
  brand: null,
  per100: { kcal: 370, proteinG: 13, carbsG: 60, fatG: 7 },
  nutrients: {},
  complete: true,
  unit: "g",
  servingG: null,
  servingText: null,
  canada: true,
};

test.describe("moving between days", () => {
  test("the arrows move a day back and forward, and forward stops at today", async ({ alice }) => {
    await openFood(alice);
    await expect(alice.locator("#fDate")).toHaveValue(today());
    await expect(alice.locator("#fNext")).toBeDisabled();
    await alice.locator("#fPrev").tap();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(alice.locator("#fNext")).toBeEnabled();
    await alice.locator("#fNext").tap();
    await expect(alice.locator("#fDate")).toHaveValue(today());
    await expect(alice.locator("#fNext")).toBeDisabled();
  });

  test("the day button says the day, and the date box covers it so a tap opens the phone's calendar", async ({ alice }) => {
    await openFood(alice);
    await expect(alice.locator("#fDayLabel")).toHaveText(dayButton(today()));
    const button = (await alice.locator("#fbar .fdaypick").boundingBox())!, input = (await alice.locator("#fDate").boundingBox())!;
    expect(Math.abs(input.x - button.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(input.width - button.width)).toBeLessThanOrEqual(2);
    expect(button.height).toBeGreaterThanOrEqual(32);
    await alice.locator("#fPrev").tap();
    await expect(alice.locator("#fDayLabel")).toHaveText(dayButton(daysAgo(1)));
  });

  test("the Today button comes back from a past day", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fPrev").tap();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
    await alice.locator("#fPrev").tap();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(2));
    await alice.locator("#fToday").tap();
    await expect(alice.locator("#fDate")).toHaveValue(today());
  });

  test("a date typed in the day box shows that day's meals", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fDate").fill(daysAgo(3));
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(3));
    await expect(alice.locator("#fbody")).toContainText("Oatmeal");
  });

  test("a past day with meals fits the width, and its copy button is at least 36 px tall", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fPrev").tap();
    await expect(alice.locator("#fbody")).toContainText("Salmon and rice");
    const copy = alice.locator("#fbody .fmh .fcopy").first();
    await expect(copy).toBeVisible();
    expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(36);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
    const w = await alice.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(w.scroll).toBeLessThanOrEqual(w.client);
  });
});

test.describe("the day at a glance", () => {
  test("the ring and the macro bars sit side by side, and the summary takes less than half the screen", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fPrev").tap();
    await expect(alice.locator("#fbody .fsum .fring .fctr b")).toHaveText("505");
    const ring = (await alice.locator("#fbody .fsum .fring").boundingBox())!, macros = (await alice.locator("#fbody .fsum .fmacs").boundingBox())!;
    expect(macros.x).toBeGreaterThanOrEqual(ring.x + ring.width - 1); // beside the ring, not under it
    expect(macros.y).toBeLessThan(ring.y + ring.height);
    const card = (await alice.locator("#fbody .fsum").boundingBox())!;
    expect(card.height).toBeLessThan(alice.viewportSize()!.height / 2);
  });

  test("the quick-add strip is a row of cards that scrolls sideways, each at least 44 px tall, and one tap logs a food", async ({ me, profile }) => {
    await logFoods(profile, "lunch", Array.from({ length: 6 }, (_, i) => ({ name: `Lunch ${i + 1}`, kcal: 300 + i })), daysAgo(1));
    await openFood(me);
    await me.locator("#fbody .fquick").getByRole("combobox", { name: "The meal a tap adds to" }).selectOption("lunch");
    const chips = me.locator("#fbody .fquick .fchip");
    await expect(chips).toHaveCount(6);
    for (const h of await heights(chips)) expect(h).toBeGreaterThanOrEqual(44);
    const strip = me.locator("#fbody .fquick .fqchips");
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect.poll(() => stickingOut(me)).toEqual([]);
    await me.locator("#fbody .fquick").getByRole("button", { name: "Add Lunch 3 to Lunch" }).tap();
    await expect(meal(me, "lunch").locator(".fe .fn")).toHaveText(["Lunch 3"]);
    await expect(sheet(me)).toBeHidden();
  });
});

test.describe("the bar at the bottom and the sheet", () => {
  test("the bar sits at the bottom of the screen, its search, barcode and AI each at least 44 px tall", async ({ alice }) => {
    await openFood(alice);
    const dock = (await alice.locator("#fdock").boundingBox())!;
    expect(dock.y + dock.height).toBeGreaterThanOrEqual(alice.viewportSize()!.height - 1);
    for (const h of await heights(alice.locator("#fdock button"))) expect(h).toBeGreaterThanOrEqual(44);
    // the page scrolls above it: the last of the page is not hidden under the bar
    await alice.locator("#fscroll").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const scroller = (await alice.locator("#fscroll").boundingBox())!;
    expect(scroller.y + scroller.height).toBeLessThanOrEqual(dock.y + 1);
  });

  test("the search in the bar opens the sheet over the whole screen, on the foods used lately", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fdSearch").tap();
    await expect(sheet(alice)).toBeVisible();
    const box = (await sheet(alice).boundingBox())!, view = alice.viewportSize()!;
    expect(Math.round(box.width)).toBe(view.width);
    expect(box.height).toBeGreaterThanOrEqual(view.height - 1);
    await expect(results(alice).locator(".frec")).toHaveCount(5);
    await expect(results(alice)).toContainText("Recent: tap to add");
  });

  test("the sheet's meals, its tabs, its search box and the recent rows are each at least 36 px tall", async ({ alice }) => {
    await openFood(alice);
    await openSheet(alice, "snack");
    await expect(results(alice).locator(".frec").first()).toBeVisible();
    const sizes = await heights(alice.locator("#fsh .fsh-meals button, #fsh .fsh-tabs button, #fsh .fq, #fsh .frec"));
    expect(sizes.length).toBeGreaterThanOrEqual(14);
    for (const h of sizes) expect(h).toBeGreaterThanOrEqual(36);
  });

  test("the search box is 16 px, so the phone does not zoom in on it", async ({ alice }) => {
    await openFood(alice);
    await openSheet(alice, "snack");
    await expect(searchBox(alice)).toHaveCSS("font-size", "16px");
  });

  test("while a box of the sheet has the cursor (the keyboard is up) its foot gives its room to the list", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fdSearch").tap(); // the bar's search puts the cursor in the box
    await expect(searchBox(alice)).toBeFocused();
    await expect(alice.locator("#fsh .fsh-foot")).toBeHidden();
    await searchBox(alice).blur();
    await expect(alice.locator("#fsh .fsh-foot")).toBeVisible();
    await expect(alice.locator("#fsh .fsh-foot").getByRole("button", { name: "Done" })).toBeVisible();
  });

  test("Done shuts the sheet", async ({ alice }) => {
    await openFood(alice);
    await openSheet(alice, "lunch");
    await alice.locator("#fsh .fsh-foot").getByRole("button", { name: "Done" }).tap();
    await expect(sheet(alice)).toBeHidden();
  });

  test("each way into the sheet fits the width: the search, the AI, by hand, and the picker", async ({ me }) => {
    await me.route("**/api/foods/search*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: searchAnswer([oats]) }));
    await openFood(me);
    await openSheet(me, "lunch");
    await expect.poll(() => stickingOut(me)).toEqual([]);
    for (const tab of ["AI", "By hand"] as const) {
      await sheetTab(me, tab).tap();
      await expect(sheetTab(me, tab)).toHaveAttribute("aria-selected", "true");
      await expect.poll(() => stickingOut(me)).toEqual([]);
    }
    await sheetTab(me, "Search").tap();
    await searchBox(me).fill("oat");
    await results(me).locator(".fr", { hasText: "Rolled oats" }).tap();
    await expect(picker(me)).toBeVisible();
    await expect.poll(() => stickingOut(me)).toEqual([]);
  });
});

test.describe("adding a food by tap", () => {
  test("a food used lately is added by one tap, and Undo takes it back, in a toast that fits the screen", async ({ me, profile }) => {
    await logFoods(profile, "lunch", [{ name: "Apple", kcal: 95 }, { name: "Oat bar", kcal: 190 }]);
    await openFood(me);
    await openSheet(me, "snack");
    await results(me).locator(".frec", { hasText: "Apple" }).tap();
    await expect(meal(me, "snack").locator(".fe .fn")).toHaveText(["Apple"]);
    const toast = me.locator("#toast");
    await expect(toast).toContainText("Added Apple to Snacks.");
    await expect(toast.locator("button", { hasText: "Undo" })).toBeVisible();
    const box = await toast.boundingBox();
    const view = me.viewportSize()!;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(view.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(view.height);
    await toast.locator("button", { hasText: "Undo" }).tap();
    await expect(toast).toContainText("Removed 1 food.");
    await expect(meal(me, "snack").locator(".fe")).toHaveCount(0);
  });

  test("Show more lists the rest of the foods used lately", async ({ me, profile }) => {
    await logFoods(profile, "breakfast", Array.from({ length: 9 }, (_, i) => ({ name: `Snack ${i + 1}`, kcal: 100 + i })));
    await openFood(me);
    await openSheet(me, "dinner");
    await expect(results(me).locator(".frec")).toHaveCount(8);
    const more = results(me).getByRole("button", { name: "Show 1 more" });
    await expect(more).toBeVisible();
    expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(36);
    await more.tap();
    await expect(results(me).locator(".frec")).toHaveCount(9);
  });

  test("By hand: the form's fields are 40 px tall with 16 px text", async ({ alice }) => {
    await openFood(alice);
    await byHand(alice, "dinner");
    const fields = await form(alice).locator("input").evaluateAll((els) => els.map((el) => ({ h: el.getBoundingClientRect().height, size: getComputedStyle(el).fontSize })));
    expect(fields.length).toBeGreaterThanOrEqual(5);
    for (const f of fields) {
      expect(f.h).toBeGreaterThanOrEqual(40);
      expect(f.size).toBe("16px");
    }
    await expect(form(alice).getByRole("button", { name: "Add to Dinner" })).toBeVisible();
  });

  test("By hand says what is missing when the name is left empty", async ({ alice }) => {
    await openFood(alice);
    await byHand(alice, "dinner");
    await form(alice).locator("input[type=number]").first().fill("250");
    await form(alice).getByRole("button", { name: "Add to Dinner" }).tap();
    await expect(alice.locator("#toast")).toHaveText("Give the food a name.");
  });

  test("By hand adds a food with its numbers, and puts the cursor in no box, so the keyboard stays down", async ({ me }) => {
    await openFood(me);
    await byHand(me, "dinner");
    await form(me).locator("input.fname").fill("Hand-cooked soup");
    await form(me).locator("input.fnum").first().fill("250");
    await form(me).getByRole("button", { name: "Add to Dinner" }).tap();
    await expect(meal(me, "dinner").locator(".fe .fn")).toHaveText(["Hand-cooked soup"]);
    await expect(meal(me, "dinner").locator(".fe .fk")).toContainText("250");
    await expect(me.locator("#fsh input:focus, #fsh textarea:focus")).toHaveCount(0);
  });

  test("By hand: once a macro is typed the calories are its sum, and a tap in their box types nothing", async ({ me }) => {
    await openFood(me);
    await byHand(me, "dinner");
    const kcal = form(me).locator('input[aria-label="kcal"]');
    await form(me).locator("input.fname").fill("Omelette");
    await form(me).locator('input[aria-label="P g"]').fill("12");
    await form(me).locator('input[aria-label="F g"]').fill("10");
    await expect(kcal).toHaveValue("138");
    await kcal.tap();
    await me.keyboard.type("9");
    await expect(kcal).toHaveValue("138");
    await expect(kcal).not.toBeEditable();
    await form(me).getByRole("button", { name: "Add to Dinner" }).tap();
    await expect(meal(me, "dinner").locator(".fe .fk")).toHaveText(["138 kcal"]);
  });

  test("a logged food opens to Add again, Change and Delete, each at least 40 px tall", async ({ me, profile }) => {
    await logFoods(profile, "lunch", [{ name: "Apple", kcal: 95 }]);
    await openFood(me);
    await meal(me, "lunch").locator(".fe .fhead").first().tap();
    const actions = meal(me, "lunch").locator(".fea button");
    await expect(actions).toHaveCount(3);
    for (const h of await heights(actions)) expect(h).toBeGreaterThanOrEqual(40);
  });

  test("a meal's + is at least 36 px, and opens the sheet on that meal", async ({ me }) => {
    await openFood(me);
    const add = meal(me, "lunch").getByRole("button", { name: "Add a food to Lunch" });
    const box = (await add.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(36);
    expect(box.width).toBeGreaterThanOrEqual(36);
    await add.tap();
    await expect(me.locator("#fsh .fsh-meals").getByRole("button", { name: "Lunch" })).toHaveAttribute("aria-pressed", "true");
  });

  test("Move to… is as tall as the buttons beside it, 16 px so the phone does not zoom, and moves the food", async ({ me, profile }) => {
    await logFoods(profile, "lunch", [{ name: "Apple", kcal: 95 }]);
    await openFood(me);
    await meal(me, "lunch").locator(".fe .fhead").first().tap();
    const move = meal(me, "lunch").locator(".fea select.fmove");
    await expect(move).toBeVisible();
    expect((await move.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    expect(await move.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    expect(await stickingOut(me)).toEqual([]);
    await move.selectOption("snack");
    await expect(meal(me, "snack").locator(".fe .fn")).toHaveText(["Apple"]);
    await expect(meal(me, "lunch").locator(".fe")).toHaveCount(0);
  });

  test("Delete asks first, in a dialog that fits the phone, and Cancel keeps the food", async ({ me, profile }) => {
    await logFoods(profile, "lunch", [{ name: "Apple", kcal: 95 }]);
    await openFood(me);
    await meal(me, "lunch").locator(".fe .fhead").first().tap();
    await meal(me, "lunch").locator(".fea button.danger").tap();
    const dialog = me.locator("#dlg");
    await expect(dialog).toBeVisible();
    await expect(me.locator("#dlgTitle")).toHaveText("Delete this food?");
    const box = await dialog.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(412);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    await me.locator("#dlgCancel").tap();
    await expect(dialog).toBeHidden();
    await expect(meal(me, "lunch").locator(".fe .fn")).toHaveText(["Apple"]);
  });
});

test.describe("searching by name (answers faked)", () => {
  test("a food found by search opens the quantity picker, and Add logs it", async ({ me }) => {
    await me.route("**/api/foods/search*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: searchAnswer([oats]) }));
    await openFood(me);
    await openSheet(me, "lunch");
    await searchBox(me).tap();
    await searchBox(me).fill("oat");
    const hit = results(me).locator(".fr", { hasText: "Rolled oats" });
    await expect(hit).toBeVisible();
    expect((await hit.boundingBox())!.height).toBeGreaterThanOrEqual(36);
    await hit.tap();
    await expect(picker(me)).toBeVisible();
    await expect(picker(me).locator(".fpq input")).toHaveValue("100");
    await expect(picker(me).locator(".fpv")).toContainText("370 kcal");
    for (const h of await heights(picker(me).locator(".fpa button, .fpq input"))) expect(h).toBeGreaterThanOrEqual(40);
    await picker(me).getByRole("button", { name: "Add to Lunch" }).tap();
    await expect(picker(me)).toBeHidden();
    await expect(meal(me, "lunch").locator(".fe .fn")).toHaveText(["Rolled oats · 100 g"]);
  });

  test("after a picked food is added, the sheet stays on its list and no box takes the cursor, so the keyboard stays down", async ({ me }) => {
    await me.route("**/api/foods/search*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: searchAnswer([oats]) }));
    await openFood(me);
    await openSheet(me, "lunch");
    await searchBox(me).fill("oat");
    await results(me).locator(".fr", { hasText: "Rolled oats" }).tap();
    await picker(me).getByRole("button", { name: "Add to Lunch" }).tap();
    await expect(meal(me, "lunch").locator(".fe .fn")).toHaveText(["Rolled oats · 100 g"]);
    await expect(searchBox(me)).toBeVisible();
    await expect(searchBox(me)).not.toBeFocused();
    await expect(results(me).locator(".frec", { hasText: "Rolled oats" })).toBeVisible(); // the list of foods used lately has it now
  });

  test("the quantity field is 16 px, so the phone does not zoom in when it is focused", async ({ me }) => {
    await me.route("**/api/foods/search*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: searchAnswer([oats]) }));
    await openFood(me);
    await openSheet(me, "lunch");
    await searchBox(me).fill("oat");
    await results(me).locator(".fr", { hasText: "Rolled oats" }).tap();
    await expect(picker(me).locator(".fpq input")).toHaveCSS("font-size", "16px");
  });
});

test.describe("nothing opens that was not tapped open", () => {
  /** What is open in the Food view: the add sheet (and what it shows) and the foods whose details are shown. */
  const opened = (page: Page) =>
    page.evaluate(() => {
      const out: string[] = [];
      if ((document.getElementById("fsheet") as HTMLDialogElement).open) out.push(`sheet: ${document.getElementById("fsh")!.dataset.mode}`);
      for (const s of document.querySelectorAll<HTMLElement>("#fbody section.fmeal")) {
        for (const name of s.querySelectorAll(".fe.open .fn")) out.push(`${s.dataset.meal}: ${name.textContent}`);
      }
      return out;
    });

  test("Save of a food changed by hand shuts the sheet Change opened", async ({ me, profile }) => {
    await logFoods(profile, "breakfast", [{ name: "Toast", kcal: 90 }]);
    await openFood(me);
    await meal(me, "breakfast").locator(".fhead", { hasText: "Toast" }).tap();
    await me.getByRole("button", { name: "Change Toast" }).tap();
    await expect.poll(() => opened(me)).toEqual(["sheet: edit", "breakfast: Toast"]);
    await form(me).locator('input[aria-label="kcal"]').fill("120");
    await form(me).locator("button[type='submit']").tap();
    await expect(meal(me, "breakfast").locator(".fe .fk")).toHaveText(["120 kcal"]);
    await expect.poll(() => opened(me)).toEqual(["breakfast: Toast"]);
  });

  test("a food moved to another meal lands there shut", async ({ me, profile }) => {
    await logFoods(profile, "breakfast", [{ name: "Toast", kcal: 90 }]);
    await openFood(me);
    await meal(me, "breakfast").locator(".fhead", { hasText: "Toast" }).tap();
    await me.getByRole("combobox", { name: "Move Toast to another meal" }).selectOption("snack");
    await expect(meal(me, "snack").locator(".fe .fn")).toHaveText(["Toast"]);
    await expect.poll(() => opened(me)).toEqual([]);
  });

  test("the day before opens with nothing of today's open", async ({ me, profile }) => {
    await logFoods(profile, "dinner", [{ name: "Soup", kcal: 200 }]);
    await logFoods(profile, "breakfast", [{ name: "Toast", kcal: 90 }, { name: "Jam", kcal: 50 }], daysAgo(1));
    await openFood(me);
    await meal(me, "dinner").locator(".fhead", { hasText: "Soup" }).tap();
    await expect.poll(() => opened(me)).toEqual(["dinner: Soup"]);
    await me.locator("#fPrev").tap();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(meal(me, "breakfast").locator(".fe")).toHaveCount(2);
    await expect.poll(() => opened(me)).toEqual([]);
  });
});

test.describe("the page on a phone", () => {
  test("the food view fits the width: the summary, the meals, the breakdown and the trends", async ({ alice }) => {
    await openFood(alice);
    await expect(alice.locator("#fbody .fmeal").first()).toBeVisible();
    await expect(alice.locator("#fbody h3", { hasText: "Breakdown" })).toBeVisible();
    await expect.poll(() => stickingOut(alice)).toEqual([]);
    const w = await alice.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(w.scroll).toBeLessThanOrEqual(w.client);
  });
});
