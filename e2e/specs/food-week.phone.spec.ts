/**
 * The Food view's reworked layout on a phone: the week as a strip that scrolls to the day shown, the summary first and the card to add a
 * food under it, the bar to add at the foot of the screen (not in the card), the meals as pills that scroll, the Insights in two columns of
 * tiles, and nothing sticking out sideways. alice's food is read only.
 */
import { test, expect, openView, today, type Page } from "../support/fixtures";

test.setTimeout(60_000);

async function openFood(page: Page) {
  await openView(page, "food");
  await expect(page.locator("#fbody .fmeal").first()).toBeVisible();
}

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

test.describe("the Log on a phone", () => {
  test("has the summary first, then the card to add a food, then the meals", async ({ alice }) => {
    await openFood(alice);
    const tops = await alice.evaluate(() => ["#fbody .fsum", "#fbody .faddcard", "#fbody .fmeal"].map((s) => Math.round(document.querySelector(s)!.getBoundingClientRect().top)));
    expect(tops[0]).toBeLessThan(tops[1]);
    expect(tops[1]).toBeLessThan(tops[2]);
  });

  test("keeps the bar to add at the foot of the screen, out of the card, and the page scrolls above it", async ({ alice }) => {
    await openFood(alice);
    await expect(alice.locator("#fbody .faddcard #fdock")).toHaveCount(0);
    const dock = (await alice.locator("#fdock").boundingBox())!;
    expect(dock.y + dock.height).toBeGreaterThanOrEqual(alice.viewportSize()!.height - 1);
  });

  test("shows no more than the screen is wide: the pills and the foods used lately scroll inside the card", async ({ alice }) => {
    await openFood(alice);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
    const row = alice.locator("#fbody .fquick .fqchips");
    expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const card = (await alice.locator("#fbody .faddcard").boundingBox())!;
    expect(card.x + card.width).toBeLessThanOrEqual(alice.viewportSize()!.width);
  });

  test("a meal with nothing in it is as wide as the others, in one line", async ({ me }) => {
    await openFood(me);
    const [slim, summary] = [(await me.locator("#fbody .fmeal.slim").first().boundingBox())!, (await me.locator("#fbody .fsum").boundingBox())!];
    expect(Math.round(slim.width)).toBe(Math.round(summary.width));
    expect(slim.height).toBeLessThan(80);
  });
});

test.describe("the week on a phone", () => {
  test("scrolls inside its own box and shows the day opened", async ({ alice }) => {
    await openFood(alice);
    const strip = alice.locator("#fstrip");
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const [box, now] = [(await strip.boundingBox())!, (await alice.locator(`#fstrip button.fwd[data-day="${today()}"]`).boundingBox())!];
    expect(now.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(now.x + now.width).toBeLessThanOrEqual(box.x + box.width + 1);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("its days, the arrows and the tabs are at least 44 px tall and wide", async ({ alice }) => {
    await openFood(alice);
    for (const sel of ["#fstrip button.fwd", "#fPrev", "#fNext", "#fTabs button", "#fbody .fpill"]) {
      for (const [w, h] of await alice.locator(sel).evaluateAll((els) => els.map((e) => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]))) {
        expect(w, `${sel} width`).toBeGreaterThanOrEqual(44);
        expect(h, `${sel} height`).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test("the title is one line, with the Log and Insights tabs under it", async ({ alice }) => {
    await openFood(alice);
    const [title, tabs] = [(await alice.locator("#fbar .fdaypick").boundingBox())!, (await alice.locator("#fTabs").boundingBox())!];
    expect(tabs.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
    expect(title.height).toBeLessThan(70);
  });
});

test.describe("the Insights on a phone", () => {
  test("have two tiles a row, the charts one over another, and nothing sticking out", async ({ alice }) => {
    await openFood(alice);
    await alice.locator("#fTabs").getByRole("button", { name: "Insights", exact: true }).tap();
    await expect(alice.locator("#fbody .itile").first()).toBeVisible();
    const lefts = await alice.locator("#fbody .itile").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(2);
    const charts = await alice.locator("#fbody .rcharts .rc").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(charts).size).toBe(1);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
    await expect(alice.locator("#fdock")).toBeHidden();
  });
});
