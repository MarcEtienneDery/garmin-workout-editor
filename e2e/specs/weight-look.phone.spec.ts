import { test, expect, openView, today, type Page, chooseTheme } from "../support/fixtures";

test.setTimeout(60_000);

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

async function openWeight(page: Page) {
  await openView(page, "weight");
  await expect(page.locator("#bbody .bhero")).toBeVisible();
}
const tab = (page: Page, name: "Weight" | "Body" | "Data") => page.locator("#bTabs").getByRole("button", { name, exact: true });

test.describe("the Weight part on a phone", () => {
  test("has the verdict first, then the calories, the chart, the weeks and what the scale measured, in one column", async ({ alice }) => {
    await openWeight(alice);
    const tops = await alice.evaluate(() => [".bhero", ".bburn", ".bintake", ".bchart", ".bweeks", ".bsnap"].map((s) => Math.round(document.querySelector(`#bbody ${s}`)!.getBoundingClientRect().top)));
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    const lefts = await alice.evaluate(() => [".bhero", ".bburn", ".bweeks", ".bsnap"].map((s) => Math.round(document.querySelector(`#bbody ${s}`)!.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(1);
  });

  test("shows no more than the screen is wide, in both themes", async ({ alice }) => {
    await openWeight(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await chooseTheme(alice, "light");
      await expect(alice.locator("body")).toHaveAttribute("data-theme", theme);
      for (const name of ["Weight", "Body", "Data"] as const) {
        await tab(alice, name).tap();
        await expect(tab(alice, name)).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => stickingOut(alice), `${theme} ${name}`).toEqual([]);
        const w = await alice.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        expect(w.scroll).toBeLessThanOrEqual(w.client);
      }
    }
  });

  test("the week scrolls inside its own box and shows the day opened", async ({ alice }) => {
    await openWeight(alice);
    const strip = alice.locator("#bstrip");
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const [box, now] = [(await strip.boundingBox())!, (await alice.locator(`#bstrip button.fwd[data-day="${today()}"]`).boundingBox())!];
    expect(now.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(now.x + now.width).toBeLessThanOrEqual(box.x + box.width + 1);
  });

  test("its days, the arrows, the parts, the unit and the range are at least 44 px tall and wide", async ({ alice }) => {
    await openWeight(alice);
    for (const sel of ["#bstrip button.fwd", "#bPrev", "#bNext", "#bTabs button", "#bUnits button", "#bRange", "#bbody .bhero .blink", "#bbody .bsnap .blink"]) {
      for (const [w, h] of await alice.locator(sel).evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]))) {
        expect(w, `${sel} width`).toBeGreaterThanOrEqual(44);
        expect(h, `${sel} height`).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test("the title is dropped from the top for the room, the tabs take a line of their own, and the unit and the range share a line", async ({ alice }) => {
    await openWeight(alice);
    const [title, tabs, units, range] = await Promise.all(["#bTitle", "#bTabs", "#bUnits", "#bRange"].map(async (s) => (await alice.locator(s).boundingBox())!));
    expect(title.height).toBeLessThan(5);
    expect(tabs.y).toBeLessThan(80);
    expect(Math.abs(units.y - range.y)).toBeLessThan(8);
  });

  test("the chart is drawn narrower so its text is readable as shown, and none of its labels is cut off", async ({ alice }) => {
    await openWeight(alice);
    const text = await alice.evaluate(() =>
      [...document.querySelectorAll<SVGSVGElement>("#bbody .rcsvg")].map((svg) => {
        const box = svg.getBoundingClientRect(), scale = box.width / svg.viewBox.baseVal.width, labels = [...svg.querySelectorAll<SVGTextElement>(".rc-tick, .rc-x")];
        return { width: svg.viewBox.baseVal.width, minFontPx: Math.min(...labels.map((l) => parseFloat(getComputedStyle(l).fontSize) * scale)), cutOff: labels.filter((l) => { const r = l.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5; }).length };
      }),
    );
    expect(text).toHaveLength(1);
    expect(text[0].width).toBeLessThan(500);
    expect(text[0].minFontPx).toBeGreaterThanOrEqual(9);
    expect(text[0].cutOff).toBe(0);
  });

  test("a week is two lines: its dates and average, then its change and a bar", async ({ alice }) => {
    await openWeight(alice);
    const row = alice.locator("#bbody .bwk").first(), [lab, avg, change] = await Promise.all([".lab", ".avg", ".ch"].map(async (s) => (await row.locator(s).boundingBox())!));
    expect(change.y).toBeGreaterThan(lab.y + 4);
    expect(Math.abs(avg.y - lab.y)).toBeLessThan(10);
  });
});

test.describe("the Body and the Data on a phone", () => {
  test("the Body has two figures to a row, the charts one over another and the one that compares as wide as the others", async ({ alice }) => {
    await openWeight(alice);
    await tab(alice, "Body").tap();
    const lefts = await alice.locator("#bbody .btile").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(2);
    const charts = await alice.locator("#bbody .rc").evaluateAll((els) => els.map((e) => [Math.round(e.getBoundingClientRect().left), Math.round(e.getBoundingClientRect().width)]));
    expect(new Set(charts.map(([l]) => l)).size).toBe(1);
    expect(new Set(charts.map(([, w]) => w)).size).toBe(1);
  });

  test("the Data has its table scroll inside its own card", async ({ alice }) => {
    await openWeight(alice);
    await tab(alice, "Data").tap();
    const table = alice.locator("#bbody .rtable").first();
    expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });
});

test.describe("the goal on a phone", () => {
  test("the box to type it fits the width, with its buttons at least 44 px tall", async ({ alice }) => {
    await openWeight(alice);
    await alice.locator("#bbody .bhero").getByRole("button", { name: "Set a goal weight" }).tap();
    await expect(alice.getByRole("textbox", { name: "Goal weight (lb)" })).toBeVisible();
    await expect.poll(() => stickingOut(alice)).toEqual([]);
    for (const h of await alice.locator("#bbody .bgoalform :is(input, button)").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))) expect(h).toBeGreaterThanOrEqual(44);
    await alice.locator("#bbody .bhero").getByRole("button", { name: "Cancel" }).tap();
  });
});
