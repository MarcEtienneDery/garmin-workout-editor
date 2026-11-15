/**
 * The Calendar's look: the dark and the light theme (one choice with Today and Food, a button in the bar), the month as one card, the
 * plan bars and workout chips readable on it, the side as cards that follow the mode, the rail following the theme, the Move menu in the
 * palette, and the sizes of the controls. alice's plans are read only; the Move menu needs a plan of a profile's own.
 */
import type { Page } from "@playwright/test";
import { test, expect, openView, type Profile } from "../support/fixtures";

test.describe.configure({ timeout: 60_000 });

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

async function openCalendar(page: Page): Promise<void> {
  await openView(page, "calendar");
  await expect(page.locator("#cNote")).not.toContainText("Loading", { timeout: 20_000 });
  await expect(page.locator("#cgrid .cday").first()).toBeVisible();
}

test.describe("the Calendar's themes", () => {
  test("the button in the bar switches between dark and light, says what it will do, and the choice is kept", async ({ alice }) => {
    await openCalendar(alice);
    const body = alice.locator("body"), button = alice.locator("#cTheme");
    await expect(body).toHaveAttribute("data-theme", "dark");
    await expect(button).toHaveAttribute("aria-label", "Switch to light theme");
    const darkBg = await style(alice, "#cscroll", "background-color");
    await button.click();
    await expect(body).toHaveAttribute("data-theme", "light");
    await expect(button).toHaveAttribute("aria-label", "Switch to dark theme");
    expect(await style(alice, "#cscroll", "background-color")).not.toBe(darkBg);
    await alice.reload();
    await expect(alice.locator("#cgrid .cday").first()).toBeVisible();
    await expect(body).toHaveAttribute("data-theme", "light");
    await button.click();
    await expect(body).toHaveAttribute("data-theme", "dark");
  });

  test("is one choice for Today, Food and the Calendar, and the rail follows it on the Calendar", async ({ alice }) => {
    await openCalendar(alice);
    const rail = () => style(alice, "header", "background-color");
    const dark = await rail();
    await alice.locator("#cTheme").click();
    const light = await rail();
    expect(light).not.toBe(dark);
    await alice.locator("#vFood").click();
    await expect(alice.locator("#fTheme")).toHaveAttribute("aria-label", "Switch to dark theme");
    expect(await rail()).toBe(light);
    await alice.locator("#fTheme").click();
    await alice.locator("#vCalendar").click();
    await expect(alice.locator("#cTheme")).toHaveAttribute("aria-label", "Switch to light theme");
    expect(await rail()).toBe(dark);
  });

  test("in both themes the text of the month and of the side keeps its contrast", async ({ alice }) => {
    await openCalendar(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await alice.locator("#cTheme").click();
      const card = await style(alice, "#cscroll", "background-color");
      expect(await contrast(alice, await style(alice, "#cTitle", "color"), await style(alice, "#cview", "background-color")), `${theme}: the month's title`).toBeGreaterThanOrEqual(7);
      expect(await contrast(alice, await style(alice, "#cdow span", "color"), card), `${theme}: the weekdays`).toBeGreaterThanOrEqual(4.5);
      expect(await contrast(alice, await style(alice, "#cgrid .cday:not(.out) .dnum", "color"), card), `${theme}: a day's number`).toBeGreaterThanOrEqual(7);
      const side = await style(alice, "#cside .ccard", "background-color");
      expect(await contrast(alice, await style(alice, "#cDay .citem .n, #cLegend .citem .n", "color"), side), `${theme}: a row of the side`).toBeGreaterThanOrEqual(7);
      expect(await contrast(alice, await style(alice, "#cLegend .citem small", "color"), side), `${theme}: its second line`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

test.describe("the month", () => {
  test("is one rounded card, its weekdays staying on top while it scrolls on a desktop", async ({ alice }) => {
    await alice.setViewportSize({ width: 1360, height: 700 });
    await openCalendar(alice);
    expect(parseFloat(await style(alice, "#cscroll", "border-top-left-radius"))).toBeGreaterThanOrEqual(16);
    expect(await style(alice, "#cdow", "position")).toBe("sticky");
  });

  test("marks today with an accent circle and the day picked with an outline in the same colour", async ({ alice }) => {
    await openCalendar(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await alice.locator("#cTheme").click();
      const accent = await style(alice, "#cgrid .cday.today .dnum", "background-color");
      expect(accent).not.toBe("rgba(0, 0, 0, 0)");
      expect(await contrast(alice, await style(alice, "#cgrid .cday.today .dnum", "color"), accent), `${theme}: today's number`).toBeGreaterThanOrEqual(4.5);
      expect(await style(alice, "#cgrid .cday.sel", "outline-color")).toBe(accent);
    }
  });

  test("keeps every plan bar and workout chip readable: white on its colour is at least 4.5 to 1, in both themes", async ({ alice }) => {
    await openCalendar(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await alice.locator("#cTheme").click();
      const pairs = await alice.locator("#cgrid .cbar:not(.window)").evaluateAll((els) => [...new Set(els.map((el) => `${getComputedStyle(el).color}|${getComputedStyle(el).backgroundColor}`))]);
      expect(pairs.length).toBeGreaterThan(1);
      for (const pair of pairs) {
        const [fg, bg] = pair.split("|");
        expect(await contrast(alice, fg, bg), `${theme}: ${pair}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("a plan with no dated workout is a dashed outline, and its edge is still visible against the card in the light theme", async ({ me, profile }) => {
    const name = `${profile.name}-window`;
    const res = await profile.api.put(`/api/file?path=${encodeURIComponent(`workout-plans/${name}.json`)}`, { data: { text: JSON.stringify({ weekStart: "2031-09-01", weekEnd: "2031-09-07", workouts: [{ workoutName: "Undated run", workoutType: "running" }] }), create: true } });
    expect(res.status()).toBe(201);
    await openCalendar(me);
    await me.locator("#cLegend .citem", { hasText: name }).click();
    await me.locator("#cModes button[data-mode=plans]").click();
    const dashed = me.locator("#cgrid .cbar.window").first();
    await expect(dashed).toBeVisible();
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await me.locator("#cTheme").click();
      expect(await dashed.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");
      const edge = await dashed.evaluate((el) => getComputedStyle(el).borderTopColor);
      expect(await contrast(me, edge, await style(me, "#cscroll", "background-color")), `${theme}: the dashed edge`).toBeGreaterThanOrEqual(3);
    }
  });
});

test.describe("the side", () => {
  test("is a card each for the day, the plans and the workout types, and the mode takes away the card it does not use", async ({ alice }) => {
    await openCalendar(alice);
    const visible = () => alice.locator("#cside .ccard:visible").evaluateAll((els) => els.map((el) => (el.querySelector("h2")?.id ?? "") + ":" + ((el.textContent ?? "").trim().length > 0)));
    expect(await visible()).toEqual(["cDayTitle:true", "cLegendTitle:true", "cTypesTitle:true"]);
    await alice.locator("#cModes button[data-mode=plans]").click();
    expect(await visible()).toEqual(["cDayTitle:true", "cLegendTitle:true"]);
    await alice.locator("#cModes button[data-mode=workouts]").click();
    expect(await visible()).toEqual(["cDayTitle:true", "cTypesTitle:true"]);
    await alice.locator("#cModes button[data-mode=both]").click();
    expect(await visible()).toHaveLength(3);
  });
});

test.describe("the Move menu", () => {
  async function addPlan(profile: Profile): Promise<string> {
    const name = `${profile.name}-look`, path = `workout-plans/${name}.json`;
    const res = await profile.api.put(`/api/file?path=${encodeURIComponent(path)}`, { data: { text: JSON.stringify({ weekStart: "2031-09-01", weekEnd: "2031-09-07", workouts: [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }] }), create: true } });
    expect(res.status()).toBe(201);
    return name;
  }
  async function openMenu(page: Page, plan: string): Promise<void> {
    await openCalendar(page);
    await page.locator("#cLegend .citem", { hasText: plan }).click();
    await page.getByRole("button", { name: "Wednesday, September 3, 2031", exact: true }).click({ position: { x: 6, y: 6 } });
    await page.locator("#cDay .citem", { hasText: "Morning run" }).getByRole("button", { name: "Move…" }).click();
    await expect(page.locator("#moveMenu")).toBeVisible();
  }

  test("reads the palette in both themes: its card, its date box and its buttons", async ({ me, profile }) => {
    const plan = await addPlan(profile);
    await openMenu(me, plan);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") {
        await me.keyboard.press("Escape");
        await me.locator("#cTheme").click();
        await me.locator("#cDay .citem", { hasText: "Morning run" }).getByRole("button", { name: "Move…" }).click();
        await expect(me.locator("#moveMenu")).toBeVisible();
      }
      const card = await style(me, "#moveMenu", "background-color");
      expect(card, `${theme}: the menu is the card colour`).toBe(await style(me, "#cscroll", "background-color"));
      expect(await style(me, "#mvDate", "color-scheme")).toBe(theme);
      expect(await contrast(me, await style(me, "#mvPrev", "color"), await style(me, "#mvPrev", "background-color")), `${theme}: a day button`).toBeGreaterThanOrEqual(7);
      expect(parseFloat(await style(me, "#moveMenu", "border-top-left-radius"))).toBeGreaterThanOrEqual(12);
    }
  });
});

test.describe("the controls", () => {
  test("the bar's buttons and the mode choices are at least 44 px, in both themes", async ({ alice }) => {
    await openCalendar(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await alice.locator("#cTheme").click();
      const small = await alice.evaluate(() => [...document.querySelectorAll<HTMLElement>("#cbar button")].filter((el) => el.offsetParent !== null).map((el) => [el.id || el.dataset.mode || "", Math.round(el.getBoundingClientRect().height)] as const).filter(([, h]) => h < 44));
      expect(small, `${theme}: controls under 44 px`).toEqual([]);
    }
  });
});
