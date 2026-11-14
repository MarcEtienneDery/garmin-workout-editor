/**
 * The Food view's look: the dark and the light theme (one choice, shared with Today, with a button in the day's bar), the palette read
 * by the summary, the meals and the add sheet, the rail following the theme, the AI marked with an icon and not an emoji, and the sizes
 * of the controls. alice's food is read only.
 */
import { test, expect, openView, type Page } from "../support/fixtures";
import { openFood, sheet, sheetTab } from "../support/food";

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
    const body = alice.locator("body"), button = alice.locator("#fTheme");
    await expect(body).toHaveAttribute("data-theme", "dark");
    await expect(button).toHaveAttribute("aria-label", "Switch to light theme");
    const darkBg = await style(alice, "#fscroll", "background-color");
    await button.click();
    await expect(body).toHaveAttribute("data-theme", "light");
    await expect(button).toHaveAttribute("aria-label", "Switch to dark theme");
    expect(await style(alice, "#fscroll", "background-color")).not.toBe(darkBg);
    await alice.reload();
    await expect(alice.locator("#fbody .fsum")).toBeVisible();
    await expect(body).toHaveAttribute("data-theme", "light");
    await button.click();
    await expect(body).toHaveAttribute("data-theme", "dark");
  });

  test("is one choice for Today and Food: the theme picked on one is the other's, and the rail follows on both", async ({ alice }) => {
    await openFood(alice);
    const rail = () => style(alice, "header", "background-color");
    const dark = await rail();
    await alice.locator("#fTheme").click();
    const light = await rail();
    expect(light).not.toBe(dark);
    await alice.locator("#vToday").click();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "today");
    await expect(alice.locator("#tTheme")).toHaveAttribute("aria-label", "Switch to dark theme");
    expect(await rail()).toBe(light);
    await alice.locator("#tTheme").click(); // back to dark, from Today
    await alice.locator("#vFood").click();
    await expect(alice.locator("#fTheme")).toHaveAttribute("aria-label", "Switch to light theme");
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
      if (theme === "light") await alice.locator("#fTheme").click();
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
      if (theme === "light") await alice.locator("#fTheme").click();
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
      if (theme === "light") await alice.locator("#fTheme").click();
      const small = await alice.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("#fbar button, #fbar .fdaypick, #fdock button")].filter((el) => el.offsetParent !== null).map((el) => [el.id || el.className, Math.round(el.getBoundingClientRect().height)] as const).filter(([, h]) => h < 44),
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
