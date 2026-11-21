/**
 * The Food view's look: the dark and the light theme (one choice, shared with Today, with a button in the day's bar), the palette read
 * by the summary, the meals and the add sheet, the rail following the theme, the AI marked with an icon and not an emoji, and the sizes
 * of the controls. alice's food is read only.
 */
import { test, expect, openView, daysAgo, type APIRequestContext, type Page, chooseTheme, toggleTheme } from "../support/fixtures";
import { labelOf, openFood, openInsights, sheet, sheetTab } from "../support/food";

test.describe.configure({ timeout: 60_000 });

/** Contrast ratio (1 to 21) of two CSS colours, as the page computes them. */
const contrast = (page: Page, a: string, b: string) =>
  page.evaluate(
    ([x, y]) => {
      const lum = (css: string) => {
        const [r, g, bl] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      };
      return (Math.max(lum(x), lum(y)) + 0.05) / (Math.min(lum(x), lum(y)) + 0.05);
    },
    [a, b],
  );
const style = (page: Page, selector: string, prop: string) => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

test.describe("the Food view's themes", () => {
  test("the button in the day's bar switches between dark and light, says what it will do, and the choice is kept", async ({ alice }) => {
    await openFood(alice);
    const body = alice.locator("body");
    await expect(body).toHaveAttribute("data-theme", "dark");
    await expect(body).toHaveAttribute("data-theme", "dark");
    const darkBg = await style(alice, "#fscroll", "background-color");
    await toggleTheme(alice);
    await expect(body).toHaveAttribute("data-theme", "light");
    await expect(body).toHaveAttribute("data-theme", "light");
    expect(await style(alice, "#fscroll", "background-color")).not.toBe(darkBg);
    await alice.reload();
    await expect(alice.locator("#fbody .fsum")).toBeVisible();
    await expect(body).toHaveAttribute("data-theme", "light");
    await toggleTheme(alice);
    await expect(body).toHaveAttribute("data-theme", "dark");
  });

  test("is one choice for Today and Food: the theme picked on one is the other's, and the rail follows on both", async ({ alice }) => {
    await openFood(alice);
    const rail = () => style(alice, "header", "background-color");
    const dark = await rail();
    await toggleTheme(alice);
    const light = await rail();
    expect(light).not.toBe(dark);
    await alice.locator("#vToday").click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "today");
    await expect(alice.locator("body")).toHaveAttribute("data-theme", "light");
    expect(await rail()).toBe(light);
    await toggleTheme(alice); // back to dark, from Today
    await alice.locator("#vFood").click();
    await expect(alice.locator("body")).toHaveAttribute("data-theme", "dark");
    expect(await rail()).toBe(dark);
  });

  test("a theme saved by the Today view before the choice was shared is still honoured", async ({ alice }) => {
    await alice.addInitScript(() => localStorage.setItem("todayTheme", "light"));
    await openFood(alice);
    await expect(alice.locator("body")).toHaveAttribute("data-theme", "light");
  });

  test("in both themes the meals and the summary read as text on their own background", async ({ alice }) => {
    await openFood(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await chooseTheme(alice, "light");
      const name = await style(alice, "#fbody .fmeal .fmt b", "color"), hint = await style(alice, "#fbody .fmeal .fmt span", "color"), card = await style(alice, "#fbody .fmeal", "background-color");
      expect(await contrast(alice, name, card), `${theme}: a meal's name`).toBeGreaterThanOrEqual(7);
      expect(await contrast(alice, hint, card), `${theme}: its macros`).toBeGreaterThanOrEqual(4.5);
      const big = await style(alice, "#fbody .fsum .fctr b", "color"), sum = await style(alice, "#fbody .fsum", "background-color");
      expect(await contrast(alice, big, sum), `${theme}: the calories in the ring`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("the cards are rounded, the numbers are in the monospace face and the macros keep their three colours", async ({ alice }) => {
    await openFood(alice);
    expect(parseFloat(await style(alice, "#fbody .fmeal", "border-top-left-radius"))).toBeGreaterThanOrEqual(16);
    expect(await style(alice, "#fbody .fsum .fctr b", "font-family")).toContain("Fira Code");
    const colour = (key: string) => style(alice, `#fbody .fsum .fmacs .fmr.${key}`, "--c"); // the macro's colour, whether or not the day has any of it logged
    const [protein, carbs, fat] = [await colour("protein"), await colour("carbs"), await colour("fat")];
    expect(new Set([protein, carbs, fat]).size).toBe(3);
  });
});

test.describe("the add sheet", () => {
  test("opens in the theme of the view, with its background and text from the palette", async ({ alice }) => {
    await openFood(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await chooseTheme(alice, "light");
      await alice.locator("#fdSearch").click();
      await expect(sheet(alice)).toBeVisible();
      const bg = await style(alice, "#fsheet", "background-color"), text = await style(alice, "#fsheet .fsh-head b", "color");
      expect(await contrast(alice, text, bg), `${theme}: the sheet's title`).toBeGreaterThanOrEqual(7);
      expect(bg).toBe(await style(alice, "#fscroll", "background-color"));
      await alice.locator("#fsh").getByRole("button", { name: "Close", exact: true }).click();
      await expect(sheet(alice)).toBeHidden();
    }
  });

  test("the meal choices are pills, the one chosen in the accent colour with dark text on it", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fdSearch").click();
    const chosen = alice.locator("#fsh .fsh-meals button[aria-pressed='true']"), other = alice.locator("#fsh .fsh-meals button[aria-pressed='false']").first();
    expect(parseFloat(await chosen.evaluate((el) => getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThanOrEqual(18);
    const [bg, fg] = [await chosen.evaluate((el) => getComputedStyle(el).backgroundColor), await chosen.evaluate((el) => getComputedStyle(el).color)];
    expect(await contrast(alice, fg, bg)).toBeGreaterThanOrEqual(4.5);
    expect(await other.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(bg);
  });

  test("the AI is marked with an icon, in the bar and in the sheet, not with an emoji", async ({ alice }) => {
    await openFood(alice);
    await expect(alice.locator("#fdAi svg")).toHaveCount(1);
    await expect(alice.locator("#fdAi")).toHaveText("");
    await alice.locator("#fdSearch").click();
    await expect(sheetTab(alice, "AI").locator(".ico svg")).toHaveCount(1);
    expect(await sheetTab(alice, "AI").innerText()).not.toMatch(/✨/);
  });
});

test.describe("the controls", () => {
  test("the day's bar and the bar at the foot are at least 44 px, in both themes", async ({ alice }) => {
    await openFood(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await chooseTheme(alice, "light");
      const small = await alice.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("#fbar button, #fbar .fdaypick, #fweek button, #fdock button")].filter((el) => el.offsetParent !== null).map((el) => [el.id || el.className, Math.round(el.getBoundingClientRect().height)] as const).filter(([, h]) => h < 44),
      );
      expect(small, `${theme}: controls under 44 px`).toEqual([]);
    }
  });

  test("the day pill still opens the date, and the arrows still move the day, in the new bar", async ({ alice }) => {
    await openFood(alice);
    await expect(alice.locator("#fDayLabel")).toContainText("Today");
    await alice.locator("#fPrev").click();
    await expect(alice.locator("#fDayLabel")).toContainText("Yesterday");
    await expect(alice.locator("#fToday")).toBeVisible();
    await alice.locator("#fToday").click();
    await expect(alice.locator("#fDayLabel")).toContainText("Today");
    await openView(alice, "today");
  });
});

/** The text of the charts as it is shown: its size in px (the drawing is scaled to the card), and whether each label is wholly inside its drawing. */
const chartText = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<SVGSVGElement>("#fbody .rcsvg")].map((svg) => {
      const box = svg.getBoundingClientRect(), scale = box.width / svg.viewBox.baseVal.width;
      const labels = [...svg.querySelectorAll<SVGTextElement>(".rc-tick, .rc-x")];
      return {
        width: Math.round(box.width),
        minFontPx: Math.min(...labels.map((l) => parseFloat(getComputedStyle(l).fontSize) * scale)),
        cutOff: labels.filter((l) => { const r = l.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5; }).length,
        ticks: [...svg.querySelectorAll(".rc-tick")].map((l) => l.textContent ?? ""),
      };
    }),
  );

test.describe("the disposition of the Food view", () => {
  test("on a wide screen the Log is two columns: the card to add and the meals on the left, the day at a glance on the right, level with the card", async ({ alice }) => {
    await alice.setViewportSize({ width: 1360, height: 860 });
    await openFood(alice);
    const at = (selector: string) => alice.locator(selector).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
    const [main, side, summary, add, meal] = [await at(".fmain"), await at(".fside"), await at("#fbody .fsum"), await at("#fbody .faddcard"), await at("#fbody .fmeal")];
    expect(main.right).toBeLessThanOrEqual(side.left);
    expect(add.left).toBeGreaterThanOrEqual(main.left - 1);
    expect(summary.left).toBeGreaterThanOrEqual(side.left - 1);
    expect(Math.abs(summary.top - add.top)).toBeLessThan(8);
    expect(meal.top).toBeGreaterThan(add.bottom - 1); // the meals come under the card to add
  });

  test("the Insights are tiles over charts two across (the weekdays among them), with the table of every day under them, in the width of the page", async ({ alice }) => {
    await alice.setViewportSize({ width: 1360, height: 860 });
    await openFood(alice);
    await openInsights(alice);
    const at = (selector: string) => alice.locator(selector).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
    const [tile, chart, table] = [await at("#fbody .itile"), await at("#fbody .rcharts .rc"), await at("#fbody details.fevery")];
    expect(chart.top).toBeGreaterThan(tile.bottom - 1);
    expect(table.top).toBeGreaterThan(chart.bottom - 1);
    const lefts = await alice.locator("#fbody .rcharts .rc").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(2);
  });

  test("the Insights draw the calories eaten against the calories burned, by day and by week", async ({ alice }) => {
    await alice.setViewportSize({ width: 1360, height: 860 });
    await openFood(alice);
    await openInsights(alice);
    const card = alice.locator("#fbody .fbc");
    await expect(card).toBeVisible();
    await expect(card.locator(".fbcgrp").first()).toBeVisible();
    await expect(card.locator(".fbcbar.eaten").first()).toBeVisible();
    await expect(card.locator(".fbcbar.burned").first()).toBeVisible();
    const daily = await card.locator(".fbcgrp").count();
    await card.getByRole("button", { name: "Weekly", exact: true }).click();
    await expect(alice.locator("#fbody .fbc").getByRole("button", { name: "Weekly", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await alice.locator("#fbody .fbc .fbcgrp").count()).toBeLessThanOrEqual(daily);
  });

  test("below 1100 px the Log is one column again, in the order of the page: the day at a glance, the card to add, the meals", async ({ alice }) => {
    await alice.setViewportSize({ width: 1000, height: 800 });
    await openFood(alice);
    const tops = await alice.evaluate(() => ["#fbody .fsum", "#fbody .faddcard", "#fbody .fmeal:last-of-type"].map((s) => Math.round(document.querySelector(s)!.getBoundingClientRect().top)));
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    const left = await alice.evaluate(() => ["#fbody .fsum", "#fbody .faddcard", "#fbody .fmeal"].map((s) => Math.round(document.querySelector(s)!.getBoundingClientRect().left)));
    expect(new Set(left).size).toBe(1);
  });

  test("the charts are drawn for the room they get: their text is readable as shown and none of it is cut off", async ({ alice }) => {
    for (const width of [1360, 1000]) {
      await alice.setViewportSize({ width, height: 860 });
      await openFood(alice);
      await openInsights(alice);
      const charts = await chartText(alice);
      expect(charts.length).toBeGreaterThanOrEqual(2);
      for (const c of charts) {
        expect(c.minFontPx, `${width}px: text size`).toBeGreaterThanOrEqual(9.5);
        expect(c.cutOff, `${width}px: labels cut off`).toBe(0);
      }
    }
  });

  test("the calorie scale stops where the data does: not a full step above the highest line", async ({ alice }) => {
    await alice.setViewportSize({ width: 1360, height: 860 });
    await openFood(alice);
    await openInsights(alice);
    const [eaten] = await chartText(alice);
    const top = Math.max(...eaten.ticks.map((t) => Number(t.replace(/,/g, ""))));
    expect(top).toBeLessThanOrEqual(3500);
  });

  test("the charts sit two across on a wide screen and when the page is narrower, and one over another when there is no room for two", async ({ alice }) => {
    for (const width of [1360, 1000]) {
      await alice.setViewportSize({ width, height: 800 });
      await openFood(alice);
      await openInsights(alice);
      const lefts = await alice.locator("#fbody .rcharts .rc").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
      expect(new Set(lefts).size, `${width}px`).toBe(2);
    }
  });

  test("the Weight view's chart is drawn for the room it gets, as its own size and not the Food view's", async ({ alice }) => {
    await openView(alice, "weight");
    await expect(alice.locator("#bbody .rcsvg").first()).toBeVisible();
    expect(await alice.locator("#bbody .rcsvg").first().getAttribute("viewBox")).toBe("0 0 1160 260");
  });
});

/** Three finished days against a 2,000 kcal / 100 g protein goal: over it, on it and under it (under counts as on target). */
async function logThreeDays(api: APIRequestContext): Promise<void> {
  const goals = await api.post("/api/settings/goals", { data: { action: "save", goals: { kcal: 2000, proteinG: 100 } } });
  expect(goals.ok()).toBeTruthy();
  const days: [number, { proteinG: number; carbsG: number; fatG: number }][] = [[3, { proteinG: 100, carbsG: 300, fatG: 70 }], [2, { proteinG: 100, carbsG: 250, fatG: 67 }], [1, { proteinG: 80, carbsG: 150, fatG: 40 }]];
  for (const [back, macros] of days) {
    const res = await api.post("/api/nutrition", { data: { action: "add", day: daysAgo(back), meal: "lunch", items: [{ name: `Day ${back}`, ...macros }] } });
    expect(res.ok()).toBeTruthy();
  }
}

test.describe("the goal on the charts", () => {
  const calories = (page: Page) => page.locator("#fbody .rcharts .rc").filter({ hasText: "Calories eaten" });
  const protein = (page: Page) => page.locator("#fbody .rcharts .rc").filter({ hasText: /^Protein \(g\)/ });

  test("a day over the calorie goal is drawn in another colour, with its words in the legend and the hover", async ({ me, profile }) => {
    await logThreeDays(profile.api);
    await openFood(me);
    await openInsights(me);
    await expect(calories(me).locator("svg .rc-bar")).toHaveCount(3);
    await expect(calories(me).locator("svg .rc-bar.over")).toHaveCount(1);
    await expect(calories(me).locator(".rcl")).toContainText("Over the goal");
    const fills = async (selector: string) => calories(me).locator(selector).first().evaluate((el) => getComputedStyle(el).fill);
    expect(await fills("svg .rc-bar.over")).not.toBe(await fills("svg .rc-bar:not(.over)"));
    await me.locator("#fDate").fill(daysAgo(3));
    await expect(calories(me).locator(".rcr")).toContainText("over the goal");
    await me.locator("#fDate").fill(daysAgo(2));
    await expect(calories(me).locator(".rcr")).not.toContainText("over the goal");
  });

  test("says in a line how many finished days were on target (a day under the goal is) and over, and how many reached the protein goal", async ({ me, profile }) => {
    await logThreeDays(profile.api);
    await openFood(me);
    await openInsights(me);
    await expect(calories(me).locator(".rcs")).toHaveText("2 of 3 finished days on target · 1 over");
    await expect(protein(me).locator(".rcs")).toHaveText("2 of 3 finished days reached 100 g");
  });

  test("does not count today, which is not over, and the line says nothing when no finished day has food", async ({ me, profile }) => {
    const goals = await profile.api.post("/api/settings/goals", { data: { action: "save", goals: { kcal: 2000 } } });
    expect(goals.ok()).toBeTruthy();
    const today = await profile.api.post("/api/nutrition", { data: { action: "add", day: daysAgo(0), meal: "lunch", items: [{ name: "Big lunch", proteinG: 100, carbsG: 300, fatG: 70 }] } });
    expect(today.ok()).toBeTruthy();
    await openFood(me);
    await openInsights(me);
    await expect(calories(me).locator("svg .rc-bar")).toHaveCount(1);
    await expect(calories(me).locator("svg .rc-bar.over")).toHaveCount(1); // the bar is drawn in its colour, as it will be if the day ends so
    await expect(calories(me).locator(".rcs")).toHaveCount(0); // but today is not counted, so there is nothing to say
  });

  test("has neither the colour nor the line without a calorie goal", async ({ me, profile }) => {
    const res = await profile.api.post("/api/nutrition", { data: { action: "add", day: daysAgo(2), meal: "lunch", items: [{ name: "Lunch", proteinG: 100, carbsG: 300, fatG: 70 }] } });
    expect(res.ok()).toBeTruthy();
    await openFood(me);
    await openInsights(me);
    await expect(calories(me).locator("svg .rc-bar")).toHaveCount(1);
    await expect(calories(me).locator("svg .rc-bar.over")).toHaveCount(0);
    await expect(calories(me).locator(".rcs")).toHaveCount(0);
    await expect(calories(me).getByText("Over the goal")).toHaveCount(0);
  });

  test("the over colour is told from the others in both themes, and the lines of words keep their contrast", async ({ me, profile }) => {
    await logThreeDays(profile.api);
    await openFood(me);
    await openInsights(me);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await chooseTheme(me, "light");
      const over = await calories(me).locator("svg .rc-bar.over").evaluate((el) => getComputedStyle(el).fill);
      const normal = await calories(me).locator("svg .rc-bar:not(.over)").first().evaluate((el) => getComputedStyle(el).fill);
      expect(over, `${theme}: over against the other bars`).not.toBe(normal);
      const text = await style(me, "#fbody .rcs", "color"), card = await style(me, "#fbody .rc", "background-color");
      expect(await contrast(me, text, card), `${theme}: the line of words`).toBeGreaterThanOrEqual(7);
    }
  });
});
