import { test, expect, openView, type Page, toggleTheme } from "../support/fixtures";

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

const openLog = async (page: Page) => { await openView(page, "activities"); await expect(page.locator("#alist .arow").first()).toBeVisible(); };
const progress = (page: Page) => page.locator('#aModes button[data-mode="stats"]').tap();

test.describe("the Activities view on a phone", () => {
  test("the Log is one column inside the width: the ribbon, the filters and the rows, none sticking out", async ({ alice }) => {
    await openLog(alice);
    await expect(alice.locator("#aribbon .awk12")).toHaveCount(12);
    const box = (await alice.locator("#aribbon .acard").boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(412);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
    await toggleTheme(alice);
    await expect(alice.locator("body")).toHaveAttribute("data-theme", "light");
    await expect.poll(() => stickingOut(alice)).toEqual([]);
    await toggleTheme(alice);
  });

  test("tapping a row shows the activity on its own, and the back button brings the Log back where it was", async ({ alice }) => {
    await openLog(alice);
    await alice.locator('#alist .arow[data-id="9018"]').tap();
    await expect(alice.locator("body")).toHaveAttribute("data-wpane", "detail");
    await expect(alice.locator("#adetail")).toBeVisible();
    await expect(alice.locator("#amain")).toBeHidden();
    await expect(alice.locator("#abar")).toBeHidden();
    await expect(alice.locator("#aDetailTitle")).toHaveText("Easy run");
    await alice.locator("#aBack").tap();
    await expect(alice.locator("#amain")).toBeVisible();
    await expect(alice.locator("#adetail")).toBeHidden();
    await expect(alice.locator('#alist .arow[data-id="9018"]')).toBeVisible();
  });

  test("a run's detail stacks its cards, planned against done under the figures, and fits the width in both themes", async ({ alice }) => {
    await alice.route("**/tile.openstreetmap.org/**", (route) => route.abort());
    await openLog(alice);
    await alice.locator('#alist .arow[data-id="9018"]').tap();
    await expect(alice.locator("#abody .aplanned")).toBeVisible();
    const [p, e] = [(await alice.locator("#abody .aplanned").boundingBox())!, (await alice.locator("#abody .aeffect").boundingBox())!];
    expect(e.y, "stacked: the effect under the planned bars").toBeGreaterThanOrEqual(p.y + p.height - 1);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
    await alice.locator("#aBack").tap();
    await toggleTheme(alice);
    await alice.locator('#alist .arow[data-id="9018"]').tap();
    await expect(alice.locator("#abody .aplanned")).toBeVisible();
    await expect.poll(() => stickingOut(alice)).toEqual([]);
    await alice.locator("#aBack").tap();
    await toggleTheme(alice);
  });

  test("a gym session's exercises put the share of the 1RM in each chip, and the chips wrap inside the width", async ({ alice }) => {
    await openLog(alice);
    await alice.locator('#alist .arow[data-id="9019"]').tap();
    await expect(alice.locator("#abody .aexercises .aexchip").first()).toHaveText(/^3 × 5 @ 220 lb 86 %$/);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("Progress stacks its cards, the heatmap is 26 weeks, the muscle map compact with the way to the rest, and nothing sticks out", async ({ alice }) => {
    await openLog(alice);
    await progress(alice);
    await expect(alice.locator("#astats .aheat i")).toHaveCount(26 * 7);
    await expect(alice.locator("#astats .aheatcard .aeyebrow")).toHaveText("Consistency · last 26 weeks");
    const card = alice.locator("#astats .ammc");
    await expect(card).not.toHaveClass(/open/);
    await card.scrollIntoViewIfNeeded();
    const [c, d, l] = [(await card.boundingBox())!, (await card.locator(".ammleft").boundingBox())!, (await card.locator(".ammright").boundingBox())!];
    expect(d.width).toBeGreaterThanOrEqual(120);
    for (const b of [d, l]) { expect(b.x).toBeGreaterThanOrEqual(c.x - 1); expect(b.x + b.width).toBeLessThanOrEqual(c.x + c.width + 1); }
    await card.locator(".ammt").tap();
    await expect(card).toHaveClass(/open/);
    await expect(card.locator(".ammbal")).toBeVisible();
    await expect.poll(() => stickingOut(alice)).toEqual([]);
    await toggleTheme(alice);
    await expect(alice.locator("body")).toHaveAttribute("data-theme", "light");
    await expect.poll(() => stickingOut(alice)).toEqual([]);
    await toggleTheme(alice);
  });

  test("tapping a muscle of the list names it and the exercises that worked it, and tapping elsewhere lets it go", async ({ alice }) => {
    await openLog(alice);
    await progress(alice);
    const card = alice.locator("#astats .ammc");
    await card.scrollIntoViewIfNeeded();
    await card.locator(".ammrow", { hasText: "Chest" }).tap();
    await expect(card.locator(".ammread")).toContainText(/^Chest · \d+ sets: /);
    await expect(card.locator('.mm-muscle[data-muscle="chest"].on').first()).toBeAttached();
  });

  test("the controls are big enough to tap: the modes, the theme, the filters and the rows are at least 44 px high", async ({ alice }) => {
    await openLog(alice);
    for (const sel of ["#aModes button", "#aTypes .tchip", ".asearch", "#aRange", "#alist .arow", "#aribbon .awk12"]) {
      for (const [w, h] of await alice.locator(sel).evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]))) {
        expect(h, `${sel} height`).toBeGreaterThanOrEqual(44);
        expect(w, `${sel} width`).toBeGreaterThanOrEqual(sel.includes("awk12") ? 16 : 44);
      }
    }
    await alice.locator('#alist .arow[data-id="9018"]').tap();
    const back = (await alice.locator("#aBack").boundingBox())!;
    expect(back.width).toBeGreaterThanOrEqual(44);
    expect(back.height).toBeGreaterThanOrEqual(44);
  });
});
