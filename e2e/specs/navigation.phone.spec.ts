/**
 * The phone layout's frame: the strip of views in the header, the account menu, and the rule that no view makes the page scroll
 * sideways at 412 px. Runs on the Pixel 7 project (`--project=phone`), against alice's data (read only).
 */
import { test, expect, openView, type Page } from "../support/fixtures";

// The suite shares this machine with other runs, so a step can take longer than the default 30 s on a loaded box.
test.setTimeout(60_000);

/**
 * On a phone the page never scrolls sideways: each view is laid out to the width, and whatever is wider lives in a box that scrolls
 * by itself (the strip of views, a table). Returns the elements that stick out past the width outside such a box.
 */
async function stickingOut(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    // what an element can show of itself: its own box, cut at the edge of every box above it that clips (hidden, scroll, auto)
    const shownRight = (el: Element) => {
      let right = el.getBoundingClientRect().right;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX !== "visible") right = Math.min(right, p.getBoundingClientRect().right);
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

/** The page's own width against the screen's: a sideways scroll of the whole page would show as scrollWidth above clientWidth. */
const pageWidth = (page: Page) => page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));

/** Whether a button of the strip is wholly inside the strip's visible part (the strip scrolls; the button must be reachable). */
async function expectInStrip(page: Page, buttonId: string) {
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const strip = document.getElementById("views")!.getBoundingClientRect();
        const button = document.getElementById(id)!.getBoundingClientRect();
        return button.left >= strip.left - 0.5 && button.right <= strip.right + 0.5;
      }, buttonId),
    )
    .toBe(true);
}

/** Each view waits for what it draws once its data is in, so the width is measured on the finished layout. */
const settled: Record<string, (page: Page) => Promise<void>> = {
  today: (page) => expect(page.locator("#tbody")).not.toContainText("Loading…"),
  plans: (page) => expect(page.locator("#filelist .file").first()).toBeVisible(),
  calendar: (page) => expect(page.locator("#cgrid .cday").first()).toBeVisible(),
  activities: (page) => expect(page.locator("#alist .arow").first()).toBeVisible(),
  recovery: (page) => expect(page.locator("#rbody")).not.toContainText("Loading…"),
  weight: (page) => expect(page.locator("#bbody")).not.toContainText("Loading…"),
  food: (page) => expect(page.locator("#fbody .fmeal").first()).toBeVisible(),
  settings: (page) => expect(page.locator("#sbody h2").first()).toBeVisible(),
};

test.describe("the strip of views", () => {
  test("is a sideways-scrolling strip when the views do not all fit", async ({ alice }) => {
    await openView(alice, "today");
    const strip = alice.locator("#views");
    await expect(strip).toHaveCSS("overflow-x", "auto");
    const sizes = await strip.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(sizes.scroll).toBeGreaterThan(sizes.client);
  });

  test("brings the open view's button into sight when the page opens on it", async ({ alice }) => {
    await openView(alice, "food");
    await expectInStrip(alice, "vFood");
    await expect(alice.locator("#vFood")).toHaveAttribute("aria-pressed", "true");
  });

  test("scrolls to a view at the far end when it is tapped, and back to the first one", async ({ alice }) => {
    await openView(alice, "today");
    await alice.locator("#vFood").tap();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "food");
    await expectInStrip(alice, "vFood");
    await alice.locator("#vToday").tap();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "today");
    await expectInStrip(alice, "vToday");
  });

  test("keeps each view's button on one line, the strip does not wrap", async ({ alice }) => {
    await openView(alice, "plans");
    const heights = await alice.locator("#views button:visible").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(heights.length).toBeGreaterThanOrEqual(6);
    for (const h of heights) expect(h).toBeLessThanOrEqual(44);
  });

  test("the browser's Back button returns to the view before on a phone", async ({ alice }) => {
    await openView(alice, "today");
    await alice.locator("#vCalendar").tap();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "calendar");
    await alice.goBack();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "today");
  });
});

test.describe("no view scrolls the page sideways at 412 px", () => {
  for (const view of Object.keys(settled)) {
    test(`${view} fits the width`, async ({ alice }) => {
      await openView(alice, view);
      await settled[view](alice);
      await expect.poll(() => stickingOut(alice)).toEqual([]);
      const w = await pageWidth(alice);
      expect(w.scroll).toBeLessThanOrEqual(w.client);
    });
  }
});

test.describe("the header and the account menu", () => {
  test("the header is one row, and the account button sits beside the strip, not over it", async ({ alice }) => {
    await openView(alice, "plans");
    const r = await alice.evaluate(() => {
      const rect = (el: Element | null) => el!.getBoundingClientRect();
      const header = rect(document.querySelector("header")), strip = rect(document.getElementById("views")), account = rect(document.getElementById("accountBtn")), toolbar = rect(document.getElementById("toolbar"));
      return { headerHeight: header.height, stripRight: strip.right, accountLeft: account.left, accountRight: account.right, headerBottom: header.bottom, toolbarTop: toolbar.top, accountTop: account.top, stripTop: strip.top };
    });
    expect(r.headerHeight).toBeLessThan(72);
    expect(Math.abs(r.accountTop - r.stripTop)).toBeLessThan(4);
    expect(r.accountLeft).toBeGreaterThanOrEqual(r.stripRight - 0.5);
    expect(r.accountRight).toBeLessThanOrEqual(412.5);
    expect(r.headerBottom).toBeLessThanOrEqual(r.toolbarTop + 0.5);
  });

  test("on a narrow phone the account shows its avatar alone, not the name", async ({ alice }) => {
    await openView(alice, "today");
    await expect(alice.locator("#accountName")).toBeHidden();
    await expect(alice.locator("#accountAvatar")).toBeVisible();
    await expect(alice.locator("#accountBtn")).toHaveAttribute("title", "Signed in as alice");
  });

  test("the account menu opens on a tap and says who is signed in", async ({ alice }) => {
    await openView(alice, "today");
    const button = alice.locator("#accountBtn");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.tap();
    await expect(alice.locator("#accountMenu")).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    await expect(alice.locator("#accountWho")).toHaveText("alice");
    await expect(alice.locator("#accountRole")).toContainText("Profile login");
    await expect(alice.locator("#logout")).toBeVisible();
  });

  test("a tap outside the account menu closes it", async ({ alice }) => {
    await openView(alice, "today");
    await alice.locator("#accountBtn").tap();
    await expect(alice.locator("#accountMenu")).toBeVisible();
    await alice.locator("#tscroll").tap({ position: { x: 200, y: 400 } });
    await expect(alice.locator("#accountMenu")).toBeHidden();
    await expect(alice.locator("#accountBtn")).toHaveAttribute("aria-expanded", "false");
  });

  test("Escape closes the account menu", async ({ alice }) => {
    await openView(alice, "today");
    await alice.locator("#accountBtn").tap();
    await expect(alice.locator("#accountMenu")).toBeVisible();
    await alice.keyboard.press("Escape");
    await expect(alice.locator("#accountMenu")).toBeHidden();
  });

  test("Settings in the account menu opens Settings on a tap and closes the menu", async ({ alice }) => {
    await openView(alice, "food");
    await alice.locator("#accountBtn").tap();
    await alice.locator("#openSettings").tap();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "settings");
    await expect(alice.locator("#accountMenu")).toBeHidden();
    await expect(alice.locator("#sbody h2").first()).toBeVisible();
  });
});
