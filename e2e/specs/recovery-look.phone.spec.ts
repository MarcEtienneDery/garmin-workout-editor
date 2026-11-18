/**
 * The Recovery view on a phone: the week scrolling to the day shown, the three parts, the verdict in one column (the gauge over the band, the signals,
 * last night, the load), the charts one over another and drawn for the width, the stored numbers scrolling inside their own box, the touch sizes,
 * and nothing sticking out sideways in either theme. alice's days are read only.
 */
import type { Page } from "@playwright/test";
import { test, expect, openView, chooseTheme, toggleTheme } from "../support/fixtures";

test.setTimeout(60_000);

/** What sticks out past the phone's width, as shown (an element is cut at the edge of any box above it that clips its content). */
async function stickingOut(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const shownRight = (el: Element) => {
      let right = el.getBoundingClientRect().right;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== "visible") right = Math.min(right, p.getBoundingClientRect().right);
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
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${(el as HTMLElement).className} right=${Math.round(el.getBoundingClientRect().right)}`);
  });
}

const part = (page: Page, name: "Verdict" | "Trends" | "Data") => page.locator("#rTabs").getByRole("button", { name, exact: true });
const hero = (page: Page) => page.locator("#rbody .rhero");
async function openRecovery(page: Page) {
  await openView(page, "recovery");
  await expect(hero(page)).toBeVisible();
}

test.describe("the Verdict on a phone", () => {
  test("is one column: the gauge over the band, then the signals, last night and the load, in that order", async ({ alice }) => {
    await openRecovery(alice);
    const tops = await alice.evaluate(() => [".rhero .rgauge", ".rhero .rband", ".rsigcard", ".rnight", ".rload"].map((s) => Math.round(document.querySelector("#rbody " + s)!.getBoundingClientRect().top)));
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    const lefts = await alice.evaluate(() => [".rhero", ".rsigcard", ".rnight", ".rload"].map((s) => Math.round(document.querySelector("#rbody " + s)!.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(1);
    const gauge = (await alice.locator("#rbody .rgauge").boundingBox())!, card = (await hero(alice).boundingBox())!;
    expect(Math.abs(gauge.x + gauge.width / 2 - (card.x + card.width / 2))).toBeLessThan(4); // centred
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("shows what would change it, and long signals (the load's) wrap inside the card", async ({ alice }) => {
    await openRecovery(alice);
    await expect(hero(alice).locator(".rchange")).toBeVisible();
    const load = alice.locator("#rbody .rsigcard .rsig").last();
    await expect(load).toContainText("Training load");
    const box = (await load.boundingBox())!, val = (await load.locator(".val").boundingBox())!;
    expect(val.x + val.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  });

  test("fits the width in both themes, and in Back off with its longest line of words", async ({ alice }) => {
    await alice.route(/\/api\/wellness\?/, async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      json.readiness.band = "back-off"; json.readiness.score = 31;
      json.readiness.signals.forEach((s: { score: number }, i: number) => { s.score = i === 0 ? -2 : -1; });
      await route.fulfill({ response: res, json });
    });
    await openRecovery(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await chooseTheme(alice, "light");
      await expect(alice.locator("body")).toHaveAttribute("data-theme", theme);
      await expect(hero(alice)).toHaveClass(/b-back/);
      await expect.poll(() => stickingOut(alice), theme).toEqual([]);
      const w = await alice.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(w.scroll).toBeLessThanOrEqual(w.client);
    }
  });
});

test.describe("the week on a phone", () => {
  test("scrolls inside its own box and shows the day opened, with the band named under each ring", async ({ alice }) => {
    await openRecovery(alice);
    const strip = alice.locator("#rstrip");
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const [box, now] = [(await strip.boundingBox())!, (await alice.locator("#rstrip button.fwd[aria-current]").boundingBox())!];
    expect(now.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(now.x + now.width).toBeLessThanOrEqual(box.x + box.width + 1);
    // the band's words are on one line under the score, not wrapped
    const heights = await alice.locator("#rstrip .rwn").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    for (const h of heights) expect(h).toBeLessThan(18);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("its days, the arrows, the tabs and the theme button are at least 44 px", async ({ alice }) => {
    await openRecovery(alice);
    for (const sel of ["#rstrip button.fwd", "#rPrev", "#rNext", "#rTabs button", "#rbar .rdaypick"]) {
      for (const [w, h] of await alice.locator(sel).evaluateAll((els) => els.map((e) => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]))) {
        expect(w, `${sel} width`).toBeGreaterThanOrEqual(44);
        expect(h, `${sel} height`).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test("the title is one line with the three tabs under it, all in the width", async ({ alice }) => {
    await openRecovery(alice);
    const [title, tabs] = [(await alice.locator("#rbar .rdaypick").boundingBox())!, (await alice.locator("#rTabs").boundingBox())!];
    expect(tabs.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
    expect(title.height).toBeLessThan(70);
    expect(tabs.x + tabs.width).toBeLessThanOrEqual(alice.viewportSize()!.width);
  });

  test("a tap on a day opens it, and the arrows step a day", async ({ alice }) => {
    await openRecovery(alice);
    const today = await alice.locator("#rDate").inputValue();
    await alice.locator("#rPrev").tap();
    await expect(alice.locator("#rDate")).not.toHaveValue(today);
    const picked = await alice.locator("#rDate").inputValue();
    // a past day of the week the strip shows, other than today (on a Monday today is in the week after it)
    const other = alice.locator("#rstrip button.fwd:not(:disabled):not(.sel):not(.today)").first();
    const day = (await other.getAttribute("data-day"))!;
    await other.tap();
    await expect(alice.locator("#rDate")).toHaveValue(day);
    expect(day < today).toBe(true);
    expect(picked < today).toBe(true);
  });
});

test.describe("the Trends and the Data on a phone", () => {
  test("the charts stack one to a row, the readiness drawn for the width (not the wide drawing), and each scales to its box", async ({ alice }) => {
    await openRecovery(alice);
    await part(alice, "Trends").tap();
    await expect(alice.locator("#rbody .rc svg.rcsvg").first()).toBeVisible();
    const lefts = await alice.locator("#rbody .rc").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(1);
    const views = await alice.locator("#rbody svg.rcsvg").evaluateAll((els) => els.map((e) => (e as SVGSVGElement).viewBox.baseVal.width));
    expect(Math.max(...views)).toBeLessThanOrEqual(480);
    const text = await alice.locator("#rbody svg.rcsvg").evaluateAll((svgs) =>
      svgs.map((svg) => Math.min(...[...svg.querySelectorAll<SVGTextElement>(".rc-tick, .rc-x")].map((l) => parseFloat(getComputedStyle(l).fontSize) * (svg.getBoundingClientRect().width / (svg as SVGSVGElement).viewBox.baseVal.width)))),
    );
    for (const px of text) expect(px).toBeGreaterThanOrEqual(9);
    await expect(alice.locator("#rRange")).toBeVisible();
    expect((await alice.locator("#rRange").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("the stored numbers scroll inside their own box, not the page, and Garmin's responses open under them", async ({ alice }) => {
    await openRecovery(alice);
    await part(alice, "Data").tap();
    const table = alice.locator("#rbody .rtable").first();
    await expect(table).toBeVisible();
    await expect(table).toHaveCSS("overflow-x", "auto");
    const sizes = await table.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(sizes.scroll).toBeGreaterThan(sizes.client);
    await alice.locator("#rbody details.racc").nth(1).locator("summary").first().tap();
    await expect(alice.locator("#rbody details.rraw")).toHaveCount(8);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("fits the width in the light theme in every part", async ({ alice }) => {
    await openRecovery(alice);
    await toggleTheme(alice);
    await expect(alice.locator("body")).toHaveAttribute("data-theme", "light");
    for (const name of ["Verdict", "Trends", "Data"] as const) {
      await part(alice, name).tap();
      await expect(part(alice, name)).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => stickingOut(alice), name).toEqual([]);
    }
  });
});
