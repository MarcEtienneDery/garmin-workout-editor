/**
 * The Food view on a phone: the days, the search box that brings itself to the top of the screen, Recent (one tap to add, with Undo),
 * the search results and the quantity picker, Enter by hand, and the touch sizes of all of it. alice's food is read only; anything
 * that logs a food uses a profile of its own (`me`). Open Food Facts is never reached: the search is answered by page.route.
 */
import { test, expect, openView, daysAgo, today, type Page, type Profile } from "../support/fixtures";

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

/** A meal's block on the day shown: the section that holds its foods, its search box and its by-hand form. */
const meal = (page: Page, name: string) => page.locator(`#fbody .fmeal[data-meal="${name}"]`);

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

test.describe("the search box and Recent", () => {
  test("tapping the search box brings the meal's box to the top of the screen", async ({ alice }) => {
    await openFood(alice);
    await meal(alice, "snack").locator(".fq").tap();
    // the page scrolls after a pause, so the box is looked at until it has come up
    await expect
      .poll(() =>
        alice.evaluate(() => {
          const scroller = document.getElementById("fscroll")!.getBoundingClientRect();
          const box = document.querySelector('#fbody .fmeal[data-meal="snack"] .ffind')!.getBoundingClientRect();
          return Math.abs(box.top - scroller.top);
        }),
      )
      .toBeLessThanOrEqual(4);
  });

  test("tapping the search box opens the foods used lately", async ({ alice }) => {
    await openFood(alice);
    await meal(alice, "snack").locator(".fq").tap();
    await expect(meal(alice, "snack").getByRole("button", { name: "Recent" })).toHaveAttribute("aria-pressed", "true");
    await expect(meal(alice, "snack").locator(".frec")).toHaveCount(5);
    await expect(meal(alice, "snack").locator(".fresults")).toContainText("Recent: tap to add");
  });

  test("Recent closes again on a second tap", async ({ alice }) => {
    await openFood(alice);
    await meal(alice, "snack").locator(".fq").tap();
    await expect(meal(alice, "snack").locator(".frec").first()).toBeVisible();
    await meal(alice, "snack").getByRole("button", { name: "Recent" }).tap();
    await expect(meal(alice, "snack").getByRole("button", { name: "Recent" })).toHaveAttribute("aria-pressed", "false");
    await expect(meal(alice, "snack").locator(".frec")).toHaveCount(0);
  });

  test("the search box, Recent, Scan and the recent rows are each at least 36 px tall", async ({ alice }) => {
    await openFood(alice);
    const snack = meal(alice, "snack");
    await snack.locator(".fq").tap();
    await expect(snack.locator(".frec").first()).toBeVisible();
    const sizes = await snack.locator(".ffrow > *, .frec").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(sizes.length).toBeGreaterThanOrEqual(7);
    for (const h of sizes) expect(h).toBeGreaterThanOrEqual(36);
  });

  test("the search box is 16 px, so the phone does not zoom in on it", async ({ alice }) => {
    await openFood(alice);
    await expect(meal(alice, "snack").locator(".fq")).toHaveCSS("font-size", "16px");
  });
});

test.describe("adding a food by tap", () => {
  test("a food used lately is added by one tap, and Undo takes it back", async ({ me, profile }) => {
    await logFoods(profile, "lunch", [{ name: "Apple", kcal: 95 }, { name: "Oat bar", kcal: 190 }]);
    await openFood(me);
    await meal(me, "snack").locator(".fq").tap();
    await meal(me, "snack").locator(".frec", { hasText: "Apple" }).tap();
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
    await meal(me, "dinner").locator(".fq").tap();
    await expect(meal(me, "dinner").locator(".frec")).toHaveCount(8);
    const more = meal(me, "dinner").getByRole("button", { name: "Show 1 more" });
    await expect(more).toBeVisible();
    expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(36);
    await more.tap();
    await expect(meal(me, "dinner").locator(".frec")).toHaveCount(9);
  });

  test("Enter by hand: the summary opens a form whose fields are 40 px tall with 16 px text", async ({ alice }) => {
    await openFood(alice);
    const dinner = meal(alice, "dinner");
    await dinner.getByText("Enter by hand").tap();
    const form = dinner.locator("form.fform");
    await expect(form).toBeVisible();
    const fields = await form.locator("input").evaluateAll((els) => els.map((el) => ({ h: el.getBoundingClientRect().height, size: getComputedStyle(el).fontSize })));
    expect(fields.length).toBeGreaterThanOrEqual(5);
    for (const f of fields) {
      expect(f.h).toBeGreaterThanOrEqual(40);
      expect(f.size).toBe("16px");
    }
    await expect(form.getByRole("button", { name: "Add" })).toBeVisible();
  });

  test("Enter by hand says what is missing when the name is left empty", async ({ alice }) => {
    await openFood(alice);
    const dinner = meal(alice, "dinner");
    await dinner.getByText("Enter by hand").tap();
    await dinner.locator("form.fform input[type=number]").first().fill("250");
    await dinner.locator("form.fform").getByRole("button", { name: "Add" }).tap();
    await expect(alice.locator("#toast")).toHaveText("Give the food a name.");
  });

  test("Enter by hand adds a food with its numbers", async ({ me, profile }) => {
    await openFood(me);
    const dinner = meal(me, "dinner");
    await dinner.getByText("Enter by hand").tap();
    await dinner.locator("form.fform input.fname").fill("Hand-cooked soup");
    await dinner.locator("form.fform input.fnum").first().fill("250");
    await dinner.locator("form.fform").getByRole("button", { name: "Add" }).tap();
    await expect(dinner.locator(".fe .fn")).toHaveText(["Hand-cooked soup"]);
    await expect(dinner.locator(".fe .fk")).toContainText("250");
  });

  test("a logged food opens to Add again, Change and Delete, each at least 40 px tall", async ({ me, profile }) => {
    await logFoods(profile, "lunch", [{ name: "Apple", kcal: 95 }]);
    await openFood(me);
    await meal(me, "lunch").locator(".fe .fhead").first().tap();
    const actions = meal(me, "lunch").locator(".fea button");
    await expect(actions).toHaveCount(3);
    for (const h of await actions.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(40);
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
  test("a food found by search opens the quantity picker, and Add logs it", async ({ me, profile }) => {
    await me.route("**/api/foods/search*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: searchAnswer([oats]) }));
    await openFood(me);
    const lunch = meal(me, "lunch");
    await lunch.locator(".fq").tap();
    await lunch.locator(".fq").fill("oat");
    const hit = lunch.locator(".fresults .fr", { hasText: "Rolled oats" });
    await expect(hit).toBeVisible();
    expect((await hit.boundingBox())!.height).toBeGreaterThanOrEqual(36);
    await hit.tap();
    const picker = lunch.locator(".fpick");
    await expect(picker).toBeVisible();
    await expect(picker.locator(".fpq input")).toHaveValue("100");
    await expect(picker.locator(".fpv")).toContainText("370 kcal");
    for (const h of await picker.locator(".fpa button, .fpq input").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) {
      expect(h).toBeGreaterThanOrEqual(40);
    }
    await picker.getByRole("button", { name: "Add" }).tap();
    await expect(picker).toBeHidden();
    await expect(lunch.locator(".fe .fn")).toHaveText(["Rolled oats · 100 g"]);
  });

  test("after a picked food is added, Recent stays closed and the box keeps focus (it opens on a tap)", async ({ me, profile }) => {
    await me.route("**/api/foods/search*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: searchAnswer([oats]) }));
    await openFood(me);
    const lunch = meal(me, "lunch");
    await lunch.locator(".fq").tap();
    await lunch.locator(".fq").fill("oat");
    await lunch.locator(".fresults .fr", { hasText: "Rolled oats" }).tap();
    await lunch.locator(".fpick").getByRole("button", { name: "Add" }).tap();
    await expect(lunch.locator(".fe .fn")).toHaveText(["Rolled oats · 100 g"]);
    // the page put the focus back in the box: that must not open the foods used lately by itself
    await expect(lunch.locator(".fq")).toBeFocused();
    await expect(lunch.getByRole("button", { name: "Recent" })).toHaveAttribute("aria-pressed", "false");
    await expect(lunch.locator(".frec")).toHaveCount(0);
    // a tap in the box still opens them, though the box has the focus already
    await lunch.locator(".fq").tap();
    await expect(lunch.getByRole("button", { name: "Recent" })).toHaveAttribute("aria-pressed", "true");
    await expect(lunch.locator(".frec").first()).toBeVisible();
  });

  test("the quantity field is 16 px, so the phone does not zoom in when it is focused", async ({ me, profile }) => {
    await me.route("**/api/foods/search*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: searchAnswer([oats]) }));
    await openFood(me);
    const lunch = meal(me, "lunch");
    await lunch.locator(".fq").tap();
    await lunch.locator(".fq").fill("oat");
    await lunch.locator(".fresults .fr", { hasText: "Rolled oats" }).tap();
    await expect(lunch.locator(".fpick .fpq input")).toHaveCSS("font-size", "16px");
  });
});

test.describe("nothing opens that was not tapped open", () => {
  /** What is open in the Food view: per meal its form by hand, its Recent list, its picker and the foods whose details are shown. */
  const opened = (page: Page) =>
    page.evaluate(() => {
      const out: string[] = [];
      for (const s of document.querySelectorAll<HTMLElement>("#fbody section.fmeal")) {
        if (s.querySelector<HTMLDetailsElement>("details.fhand")!.open) out.push(`${s.dataset.meal}: by hand`);
        if (s.querySelector('.ffrow button[aria-pressed="true"]')) out.push(`${s.dataset.meal}: recent`);
        if (s.querySelector(".fpick")) out.push(`${s.dataset.meal}: picker`);
        for (const name of s.querySelectorAll(".fe.open .fn")) out.push(`${s.dataset.meal}: ${name.textContent}`);
      }
      return out;
    });

  test("Save of a food changed by hand shuts the form Change opened", async ({ me, profile }) => {
    await logFoods(profile, "breakfast", [{ name: "Toast", kcal: 90 }]);
    await openFood(me);
    await meal(me, "breakfast").locator(".fhead", { hasText: "Toast" }).tap();
    await me.getByRole("button", { name: "Change Toast" }).tap();
    await expect.poll(() => opened(me)).toEqual(["breakfast: by hand", "breakfast: Toast"]);
    await meal(me, "breakfast").locator('form.fform input[aria-label="kcal"]').fill("120");
    await meal(me, "breakfast").locator("form.fform button[type='submit']").tap();
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

  test("coming back to the browser from another app does not open Recent in the box that had the cursor", async ({ me, profile }) => {
    await me.route("**/api/foods/search*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: searchAnswer([oats]) }));
    await logFoods(profile, "lunch", [{ name: "Soup", kcal: 200 }], daysAgo(1));
    await openFood(me);
    const lunch = meal(me, "lunch");
    await lunch.locator(".fq").tap();
    await lunch.locator(".fq").fill("oat");
    await lunch.locator(".fresults .fr", { hasText: "Rolled oats" }).tap();
    await lunch.locator(".fpick").getByRole("button", { name: "Add" }).tap();
    await expect(lunch.locator(".fq")).toBeFocused();
    await expect.poll(() => opened(me)).toEqual([]);
    // the page loses the focus with the window while the other app is in front, and gives it back to the box on the way back
    await lunch.locator(".fq").evaluate((box: HTMLInputElement) => {
      box.blur();
      window.dispatchEvent(new FocusEvent("blur"));
      window.dispatchEvent(new FocusEvent("focus"));
      box.focus();
    });
    await expect(lunch.locator(".fq")).toBeFocused();
    await expect.poll(() => opened(me)).toEqual([]);
  });

  test("the day before opens with nothing of today's open", async ({ alice }) => {
    await openFood(alice);
    await meal(alice, "snack").locator(".fq").tap();
    await meal(alice, "dinner").locator("details.fhand > summary").tap();
    await expect.poll(() => opened(alice)).toEqual(["dinner: by hand", "snack: recent"]);
    await alice.locator("#fPrev").tap();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(meal(alice, "breakfast").locator(".fe")).toHaveCount(2);
    await expect.poll(() => opened(alice)).toEqual([]);
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
