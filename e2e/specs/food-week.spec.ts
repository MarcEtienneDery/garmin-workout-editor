/**
 * The Food view's reworked layout: the week of the day shown, Monday to Sunday, to pick a day from (its calories against its goal as a ring,
 * a day over the goal told apart, a day to come out of reach); the Log and the Insights it is split in (the day to add to and eat from, what
 * the days add up to); the card to add a food (the bar, the meal to add to as pills, the foods used lately); the meals as cards, one with
 * nothing in it a single line. alice's food is read only; anything that logs a food uses a profile of its own (`me`).
 */
import { test, expect, openView, daysAgo, today, mondayOf, type APIRequestContext, type Page, chooseTheme } from "../support/fixtures";
import { MEAL_LABEL, meal, openFood, type Meal } from "../support/food";

test.describe.configure({ timeout: 60_000 });

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => iso(new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86_400_000));
const week = () => Array.from({ length: 7 }, (_, i) => addDays(mondayOf(today()), i));

async function seed(api: APIRequestContext, day: string, mealName: Meal, items: Record<string, unknown>[]): Promise<void> {
  const r = await api.post("/api/nutrition", { data: { action: "add", day, meal: mealName, items } });
  expect(r.ok()).toBeTruthy();
}
const setGoals = async (api: APIRequestContext, goals: Record<string, number>) => expect((await api.post("/api/settings/goals", { data: { action: "save", goals } })).ok()).toBeTruthy();

const strip = (page: Page) => page.locator("#fstrip");
const chip = (page: Page, day: string) => strip(page).locator(`button.fwd[data-day="${day}"]`);
const pills = (page: Page) => page.locator("#fbody .fpills");
const pill = (page: Page, m: Meal) => pills(page).getByRole("button", { name: MEAL_LABEL[m], exact: true });
const tab = (page: Page, name: "Log" | "Insights") => page.locator("#fTabs").getByRole("button", { name, exact: true });

test.describe("the week", () => {
  test("shows the seven days of the week the day shown is in, Monday first, the day shown marked, today dotted", async ({ alice }) => {
    await openFood(alice);
    await expect(strip(alice).locator("button.fwd")).toHaveCount(7);
    await expect(strip(alice).locator("button.fwd").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.day))).resolves.toEqual(week());
    await expect(chip(alice, today())).toHaveAttribute("aria-current", "date");
    await expect(strip(alice).locator("[aria-current]")).toHaveCount(1);
    await expect(chip(alice, today())).toHaveClass(/\btoday\b/);
    await expect(chip(alice, week()[0]).locator("small")).toHaveText("Mon");
  });

  test("says each day in words for a screen reader, with its calories, or that nothing is logged, or that it is not yet", async ({ alice }) => {
    await openFood(alice);
    const yesterday = daysAgo(1);
    if (yesterday >= week()[0]) await expect(chip(alice, yesterday)).toHaveAttribute("aria-label", /, 1,695 kcal$/);
    await expect(chip(alice, today())).toHaveAttribute("aria-label", /, nothing logged$/);
  });

  test("a tap on a past day opens it, in the Log, the week staying", async ({ alice }) => {
    test.skip(daysAgo(1) < week()[0], "today is a Monday: there is no day before it in the week");
    await openFood(alice);
    await chip(alice, daysAgo(1)).click();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(chip(alice, daysAgo(1))).toHaveAttribute("aria-current", "date");
    await expect(strip(alice).locator("button.fwd").first()).toHaveAttribute("data-day", week()[0]);
    await expect(alice.locator("#fbody .fsumlines .fhn")).toContainText("1,695 kcal");
  });

  test("a day that is yet to come cannot be opened, and the ▶ is out of reach on today", async ({ alice }) => {
    test.skip(today() === week()[6], "today is a Sunday: the week has no day to come");
    await openFood(alice);
    await expect(chip(alice, week()[6])).toBeDisabled();
    await expect(chip(alice, week()[6])).toHaveAttribute("aria-label", /, not yet$/);
    await expect(alice.locator("#fNext")).toBeDisabled();
  });

  test("the arrows step a day and the week follows them into the week before", async ({ alice }) => {
    await openFood(alice);
    const monday = week()[0];
    for (let day = today(); day > monday; day = addDays(day, -1)) await alice.locator("#fPrev").click();
    await expect(alice.locator("#fDate")).toHaveValue(monday);
    await alice.locator("#fPrev").click();
    await expect(alice.locator("#fDate")).toHaveValue(addDays(monday, -1));
    await expect(strip(alice).locator("button.fwd").first()).toHaveAttribute("data-day", mondayOf(addDays(monday, -1)));
    await expect(chip(alice, addDays(monday, -1))).toHaveAttribute("aria-current", "date");
    await expect(strip(alice).locator("button.fwd:disabled")).toHaveCount(0);
  });

  test("the part of the view stays when a day is picked in the week: the Insights stay the Insights", async ({ alice }) => {
    test.skip(daysAgo(1) < week()[0], "today is a Monday: there is no day before it in the week");
    await openFood(alice);
    await tab(alice, "Insights").click();
    await chip(alice, daysAgo(1)).click();
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(tab(alice, "Insights")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#fbody .itile").first()).toBeVisible();
  });

  test("a day over the goal is told apart from one on target, a day under the goal counts as on target", async ({ me, profile }) => {
    test.skip(today() === week()[0] || daysAgo(2) < week()[0], "the week has not two finished days yet");
    await setGoals(profile.api, { kcal: 2000 });
    await seed(profile.api, daysAgo(1), "lunch", [{ name: "Big lunch", kcal: 2600, proteinG: 80, carbsG: 300, fatG: 90 }]);
    await seed(profile.api, daysAgo(2), "lunch", [{ name: "Light lunch", kcal: 900, proteinG: 40, carbsG: 100, fatG: 30 }]);
    await openFood(me);
    await expect(chip(me, daysAgo(1))).toHaveClass(/st-over/);
    await expect(chip(me, daysAgo(1))).toHaveAttribute("aria-label", /over the goal/);
    await expect(chip(me, daysAgo(2))).toHaveClass(/st-ok/);
    await expect(chip(me, daysAgo(2))).not.toHaveAttribute("aria-label", /over the goal/);
    await expect(chip(me, daysAgo(2)).locator(".fwk")).toHaveText("900");
    await expect(chip(me, daysAgo(1)).locator(".fwring .arc.over")).toHaveCount(1);
    await expect(chip(me, daysAgo(2)).locator(".fwring .arc:not(.over)")).toHaveCount(1);
  });

  test("a day with nothing logged has a dash and an empty ring", async ({ me }) => {
    await openFood(me);
    await expect(chip(me, today()).locator(".fwk")).toHaveText("–");
    await expect(chip(me, today()).locator(".fwring .arc")).toHaveCount(0);
  });

  test("the days and the arrows are at least 44 px tall", async ({ alice }) => {
    await openFood(alice);
    for (const sel of ["#fstrip button.fwd", "#fPrev", "#fNext", "#fTabs button", "#fbody .fpill"]) {
      for (const h of await alice.locator(sel).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))) expect(h, sel).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("the Log and the Insights", () => {
  test("open on the Log; the Insights show what the days add up to, and the Log comes back as it was", async ({ alice }) => {
    await openFood(alice);
    await expect(tab(alice, "Log")).toHaveAttribute("aria-pressed", "true");
    await expect(tab(alice, "Insights")).toHaveAttribute("aria-pressed", "false");
    await expect(alice.locator("#fbody .fmeal")).toHaveCount(4);
    await expect(alice.locator("#fbody .itile")).toHaveCount(0);
    await tab(alice, "Insights").click();
    await expect(tab(alice, "Insights")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#fbody .fmeal")).toHaveCount(0);
    await expect(alice.locator("#fbody .itile small")).toHaveText(["Average · 5 days", "On target", "Protein", "Eaten vs burned"]);
    await expect(alice.locator("#fbody .rcharts .rc")).not.toHaveCount(0);
    await tab(alice, "Log").click();
    await expect(alice.locator("#fbody .fmeal")).toHaveCount(4);
    await expect(alice.locator("#fbody .rcharts")).toHaveCount(0);
  });

  test("the tiles count the finished days: the average, the days on target, the protein, what was eaten against what was burned", async ({ alice }) => {
    await openFood(alice);
    await tab(alice, "Insights").click();
    const tiles = alice.locator("#fbody .itile");
    await expect(tiles.nth(0)).toContainText("1,695");
    await expect(tiles.nth(0)).toContainText("goal 2,200");
    await expect(tiles.nth(1)).toContainText("5 of 5");
    await expect(tiles.nth(1)).toContainText("none over the goal");
    await expect(tiles.nth(2)).toContainText("goal 130");
    await expect(tiles.nth(3)).toContainText("kcal a day, on average");
  });

  test("the range select reaches the tiles, the charts and the table", async ({ alice }) => {
    await openFood(alice);
    await tab(alice, "Insights").click();
    await alice.locator("#fbody .frange").selectOption("14");
    await expect(alice.locator("#fbody details.fevery summary")).toContainText("14 days");
    await expect(alice.locator("#fbody details.fevery summary")).not.toContainText("30 days");
  });

  test("the table of every day is shut, opens on a tap, and a day picked in it opens in the Log", async ({ alice }) => {
    await openFood(alice);
    await tab(alice, "Insights").click();
    const every = alice.locator("#fbody details.fevery");
    await expect(every).not.toHaveAttribute("open", "");
    await expect(alice.locator("#fbody table.rmetrics")).toBeHidden();
    await every.locator("summary").click();
    await expect(every).toHaveAttribute("open", "");
    await expect(alice.locator("#fbody table.rmetrics")).toBeVisible();
    await alice.locator(`#fbody table.rmetrics tr.pick`).filter({ hasText: /1,695/ }).first().click();
    await expect(tab(alice, "Log")).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#fbody .fsum")).toBeVisible();
    await expect(alice.locator("#fDate")).not.toHaveValue(today());
  });

  test("a bar of a chart picks its day and stays in the Insights, where the charts read it out", async ({ alice }) => {
    await openFood(alice);
    await tab(alice, "Insights").click();
    const over = alice.locator("#fbody .rcharts .rc").first().locator(".rc-over"), box = (await over.boundingBox())!;
    await over.click({ position: { x: box.width * 0.95, y: box.height / 2 } }); // the second bar from the right: yesterday, of 30 days
    await expect(alice.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(tab(alice, "Insights")).toHaveAttribute("aria-pressed", "true");
  });

  test("the weekdays are compared once there are enough days: the bars, the goal and a sentence on what stands out", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000, proteinG: 100 });
    for (let i = 1; i <= 21; i++) {
      const day = daysAgo(i), weekend = [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
      await seed(profile.api, day, "lunch", [{ name: "Lunch", kcal: weekend ? 3000 : 1800, proteinG: weekend ? 60 : 120, carbsG: 200, fatG: 60 }]);
    }
    await openFood(me);
    await tab(me, "Insights").click();
    const card = me.locator("#fbody .fwdcard");
    await expect(card).toBeVisible();
    await expect(card.locator(".fwdbar")).toHaveCount(7);
    await expect(card.locator(".fwdbar.over")).toHaveCount(2);
    await expect(card.locator(".fwdlabels small")).toHaveText(["M", "T", "W", "T", "F", "S", "S"]);
    await expect(card.locator(".fwdsay")).toContainText("3,000 kcal");
    await expect(card.locator(".fwdsay")).toContainText("Protein is lowest on");
    await expect(card.locator(".fwdkey")).toContainText("Goal 2,000 kcal");
    await expect(card).toHaveAttribute("class", /fcard/);
    await expect(card.locator(".fwdplot")).toHaveAttribute("role", "img");
  });

  test("there is no weekday card with too few days", async ({ alice }) => {
    await openFood(alice);
    await tab(alice, "Insights").click();
    await expect(alice.locator("#fbody .fwdcard")).toHaveCount(0);
  });

  test("a profile with no finished day says so instead of showing empty tiles", async ({ me }) => {
    await openFood(me);
    await tab(me, "Insights").click();
    await expect(me.locator("#fbody .itile")).toHaveCount(0);
    await expect(me.locator("#fbody")).toContainText("Nothing to add up yet");
  });

  test("the bar to add a food is only on the Log", async ({ alice }) => {
    await openFood(alice);
    await expect(alice.locator("#fdock")).toBeVisible();
    await tab(alice, "Insights").click();
    await expect(alice.locator("#fdock")).toBeHidden();
    await tab(alice, "Log").click();
    await expect(alice.locator("#fdock")).toBeVisible();
  });
});

test.describe("the card to add a food", () => {
  test("holds the bar (search, barcode, AI), the meals as pills and the foods used lately, on a wide screen", async ({ alice }) => {
    await openFood(alice);
    const card = alice.locator("#fbody .faddcard");
    await expect(card.locator("#fdock")).toBeVisible();
    await expect(card.locator("#fdSearch")).toBeVisible();
    await expect(pills(alice).locator("button")).toHaveText(["Breakfast", "Lunch", "Dinner", "Snacks"]);
    await expect(card.locator(".fquick .fchip").first()).toBeVisible();
    await expect(card.locator(".fquick .fqh")).toContainText("Log again");
  });

  test("the pills choose the meal the bar, the foods used lately and the sheet add to, and one is chosen at all times", async ({ alice }) => {
    await openFood(alice);
    await expect(pills(alice).locator("button[aria-pressed='true']")).toHaveCount(1);
    await pill(alice, "lunch").click();
    await expect(pill(alice, "lunch")).toHaveAttribute("aria-pressed", "true");
    await expect(pills(alice).locator("button[aria-pressed='true']")).toHaveCount(1);
    await expect(alice.locator("#fdLabel")).toHaveText("Add food to Lunch");
    await expect(alice.locator("#fbody .fquick .fqh")).toContainText("Lunch");
    await expect(alice.locator("#fbody .fquick .fchip").first()).toHaveAttribute("aria-label", /to Lunch$/);
    await alice.locator("#fdSearch").click();
    await expect(alice.locator("#fsh .fsh-meals button[aria-pressed='true']")).toHaveText("Lunch");
  });

  test("the meal the food goes to says so: a tag on its card, which follows the pills", async ({ alice }) => {
    await openFood(alice);
    await pill(alice, "dinner").click();
    await expect(alice.locator("#fbody .fhere")).toHaveCount(1);
    await expect(meal(alice, "dinner").locator(".fhere")).toHaveText("adding here");
    await pill(alice, "breakfast").click();
    await expect(meal(alice, "breakfast").locator(".fhere")).toHaveText("adding here");
    await expect(meal(alice, "dinner").locator(".fhere")).toHaveCount(0);
  });
});

test.describe("the meals as cards", () => {
  test("a meal with food has its calories, the share of the goal, a bar of what they are made of and a button to add to it", async ({ me, profile }) => {
    await setGoals(profile.api, { kcal: 2000 });
    await seed(profile.api, today(), "breakfast", [{ name: "Oatmeal", kcal: 400, proteinG: 15, carbsG: 60, fatG: 10 }]);
    await openFood(me);
    const card = meal(me, "breakfast");
    await expect(card).not.toHaveClass(/slim/);
    await expect(card.locator(".fmk")).toHaveText("400 kcal");
    await expect(card.locator(".fmsh")).toHaveText("20 % of the goal");
    await expect(card.locator(".fmsplit .fseg")).toHaveCount(3);
    await expect(card.getByRole("button", { name: "Add a food to Breakfast", exact: true })).toHaveText("+ Add to Breakfast");
  });

  test("the share is of the day when there is no goal", async ({ me, profile }) => {
    await seed(profile.api, today(), "breakfast", [{ name: "Oatmeal", kcal: 400, proteinG: 15, carbsG: 60, fatG: 10 }]);
    await seed(profile.api, today(), "lunch", [{ name: "Wrap", kcal: 400, proteinG: 30, carbsG: 40, fatG: 15 }]);
    await openFood(me);
    await expect(meal(me, "lunch").locator(".fmsh")).toHaveText("50 % of the day");
  });

  test("a meal with nothing in it is a single line, with a short button to add to it", async ({ me }) => {
    await openFood(me);
    for (const m of ["breakfast", "lunch", "dinner", "snack"] as Meal[]) {
      const card = meal(me, m);
      await expect(card).toHaveClass(/slim/);
      await expect(card.locator(".fmt span")).toHaveText("Nothing logged");
      await expect(card.getByRole("button", { name: `Add a food to ${MEAL_LABEL[m]}`, exact: true })).toHaveText("+ Add");
      expect((await card.boundingBox())!.height).toBeLessThan(80);
    }
  });

  test("a tap on the button of a meal opens the sheet on that meal", async ({ me }) => {
    await openFood(me);
    await meal(me, "dinner").getByRole("button", { name: "Add a food to Dinner", exact: true }).click();
    await expect(me.locator("#fsh .fsh-meals button[aria-pressed='true']")).toHaveText("Dinner");
  });

  test("the summary stays beside the meals while they are scrolled, on a wide screen", async ({ me, profile }) => {
    for (const m of ["breakfast", "lunch", "dinner", "snack"] as Meal[]) await seed(profile.api, today(), m, Array.from({ length: 6 }, (_, i) => ({ name: `${m} ${i}`, kcal: 100 + i, proteinG: 5, carbsG: 10, fatG: 2 })));
    await openFood(me);
    const before = (await me.locator("#fbody .fsum").boundingBox())!.y;
    await me.locator("#fscroll").evaluate((el) => el.scrollTo(0, 400));
    const after = (await me.locator("#fbody .fsum").boundingBox())!.y;
    expect(after).toBeGreaterThanOrEqual(0);
    expect(before - after).toBeLessThan(400); // it did not scroll away with the meals
  });
});

test.describe("on a wide screen, in both themes", () => {
  test("the days, the pills and the tabs read: the text of each against its background is at least 4.5 to 1", async ({ alice }) => {
    await openFood(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await chooseTheme(alice, "light");
      await alice.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null)))); // the colours have settled
      const low = await alice.evaluate(() => {
        const lum = (css: string) => {
          const unit = css.startsWith("color(srgb") ? 1 : 255; // a mix of colours is given as 0 to 1
          const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => { const c = v / unit; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const bgOf = (el: Element): string => {
          for (let p: Element | null = el; p; p = p.parentElement) {
            const c = getComputedStyle(p).backgroundColor;
            if (!/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(c)) return c;
          }
          return "rgb(0,0,0)";
        };
        const out: string[] = [];
        for (const sel of ["#fstrip button.fwd small", "#fstrip button.fwd .fwk", "#fbody .fpill", "#fTabs button", "#fbody .fqh span", "#fbody .fmeal .fmt span"]) {
          for (const el of document.querySelectorAll(sel)) {
            const fg = getComputedStyle(el).color, bg = bgOf(el), [a, b] = [lum(fg), lum(bg)];
            const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            if (ratio < 4.5) out.push(`${sel} ${fg} on ${bg}: ${ratio.toFixed(2)}`);
          }
        }
        return out;
      });
      expect(low, `${theme}: text under 4.5 to 1`).toEqual([]);
    }
  });
});

test("the part of the view chosen stays while the page is open, on another view and back", async ({ me }) => {
  await openView(me, "food");
  await expect(me.locator("#fbody .fmeal").first()).toBeVisible();
  await tab(me, "Insights").click();
  await me.locator("#vToday").click(); // in the page: another address would load it again
  await expect(me.locator("body")).toHaveAttribute("data-view", "today");
  await me.locator("#vFood").click();
  await expect(me.locator("body")).toHaveAttribute("data-view", "food");
  await expect(tab(me, "Insights")).toHaveAttribute("aria-pressed", "true"); // the part chosen stays while the page is open
});
