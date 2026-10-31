/**
 * The views on a phone: Activities (list, detail pane, calendar), the Calendar, Recovery, Weight, Today and Settings. Each one fits
 * the 412 px width, its charts scale to it, and its panes move the way a phone expects. alice's data, read only.
 */
import { test, expect, openView, type Page } from "../support/fixtures";

// The suite shares this machine with other runs, so a step can take longer than the default 30 s on a loaded box.
test.setTimeout(60_000);

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

/** The number of columns a grid's track list makes ("12px 380px" is two). */
const columnsOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length);

test.describe("Activities on a phone", () => {
  test("tapping a row opens its detail pane, and Back returns to the list", async ({ alice }) => {
    await openView(alice, "activities");
    const row = alice.locator("#alist .arow").first();
    await expect(row).toBeVisible();
    const name = (await row.locator(".nm").textContent()) ?? "";
    await row.tap();
    await expect(alice.locator("body")).toHaveAttribute("data-wpane", "detail");
    await expect(alice.locator("#adetail")).toBeVisible();
    await expect(alice.locator("#amain")).toBeHidden();
    await expect(alice.locator("#aDetailTitle")).toHaveText(name);
    await expect(alice.locator("#aBack")).toBeVisible();
    await alice.locator("#aBack").tap();
    await expect(alice.locator("body")).toHaveAttribute("data-wpane", "list");
    await expect(alice.locator("#amain")).toBeVisible();
    await expect(alice.locator("#adetail")).toBeHidden();
  });

  test("the detail's graphs and map fit the width", async ({ alice }) => {
    // the map's tiles come from OpenStreetMap, which the suite never reaches
    await alice.route("**/tile.openstreetmap.org/**", (route) => route.abort());
    await openView(alice, "activities");
    await alice.locator("#alist .arow", { hasText: "Easy run" }).first().tap();
    await expect(alice.locator("body")).toHaveAttribute("data-wpane", "detail");
    await expect(alice.locator("#abody .acsvg").first()).toBeVisible();
    const boxes = await alice.locator("#abody svg.acsvg").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    expect(boxes.length).toBeGreaterThanOrEqual(1);
    for (const w of boxes) expect(w).toBeLessThanOrEqual(412);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("the calendar mode shows seven day columns that fit the width", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator('#aModes button[data-mode="calendar"]').tap();
    await expect(alice.locator("#acal")).toBeVisible();
    await expect(alice.locator("#adow span:visible")).toHaveCount(7);
    await expect(alice.locator("#agrid .cday").first()).toBeVisible();
    const grid = await alice.locator("#agrid").evaluate((el) => el.getBoundingClientRect().width);
    expect(grid).toBeLessThanOrEqual(412);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("tapping a day of the calendar lists that day's activities below the grid", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator('#aModes button[data-mode="calendar"]').tap();
    await alice.locator("#agrid .cday.today").tap();
    await expect(alice.locator("#aDay")).toBeVisible();
    await expect(alice.locator("#aDay h3")).toBeVisible();
    await expect(alice.locator("#aDay")).toContainText("Today's shakeout");
  });
});

test.describe("the Calendar on a phone", () => {
  test("tapping a day lists its workouts below the grid", async ({ alice }) => {
    await openView(alice, "calendar");
    await alice.locator("#cgrid .cday.today").tap();
    await expect(alice.locator("#cgrid .cday.sel")).toHaveCount(1);
    await expect(alice.locator("#cDay")).toContainText("Tempo intervals");
    const weekday = new Date().toLocaleDateString("en-CA", { weekday: "long", timeZone: "UTC" });
    await expect(alice.locator("#cDayTitle")).toContainText(weekday);
  });

  test("opens on Both: the workouts are dots inside their plan's bar, under its name", async ({ alice }) => {
    await openView(alice, "calendar");
    await expect(alice.locator("#cModes button[data-mode=both]")).toHaveAttribute("aria-pressed", "true");
    const week = alice.locator("#cgrid .cweek").filter({ has: alice.locator(".cday.today") });
    const bar = week.locator(".cbar.top").first(), dot = week.locator(".cbar.wk").first(), band = week.locator(".cband").first();
    await expect(dot).toBeVisible();
    const [b, d, n] = await Promise.all([bar.boundingBox(), dot.boundingBox(), band.boundingBox()]);
    expect(d!.y).toBeGreaterThanOrEqual(b!.y + b!.height - 1);
    expect(d!.y + d!.height).toBeLessThanOrEqual(n!.y + n!.height);
    expect(d!.height).toBeLessThanOrEqual(10);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("a day with nothing planned says so", async ({ alice }) => {
    await openView(alice, "calendar");
    // two months ahead, where no plan reaches
    await alice.locator("#cNext").tap();
    await alice.locator("#cNext").tap();
    await alice.locator("#cgrid .cday:not(.out)").first().tap();
    await expect(alice.locator("#cDay")).toContainText("Nothing on this day.");
  });

  test("the month grid is seven columns that fit the width", async ({ alice }) => {
    await openView(alice, "calendar");
    await expect(alice.locator("#cdow span")).toHaveCount(7);
    await expect(alice.locator("#cgrid .cday").first()).toBeVisible();
    const grid = await alice.locator("#cgrid").evaluate((el) => el.getBoundingClientRect().width);
    expect(grid).toBeLessThanOrEqual(412);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("the month arrows move a month, and Today comes back to this one", async ({ alice }) => {
    await openView(alice, "calendar");
    const title = alice.locator("#cTitle");
    const first = (await title.textContent()) ?? "";
    await alice.locator("#cNext").tap();
    await expect(title).not.toHaveText(first);
    await alice.locator("#cToday").tap();
    await expect(title).toHaveText(first);
  });
});

test.describe("Recovery on a phone", () => {
  test("the charts stack one to a row, and each drawing scales to its box", async ({ alice }) => {
    await openView(alice, "recovery");
    await expect(alice.locator("#rbody")).not.toContainText("Loading…");
    await expect(alice.locator("#rbody .rc svg.rcsvg").first()).toBeVisible();
    expect(await columnsOf(alice, "#rbody .rcharts")).toBe(1);
    const ok = await alice.locator("#rbody .rc").evaluateAll((cards) =>
      cards.every((card) => {
        const svg = card.querySelector("svg.rcsvg");
        if (!svg) return true;
        return svg.getBoundingClientRect().width <= card.getBoundingClientRect().width + 0.5 && card.getBoundingClientRect().width <= 412;
      }),
    );
    expect(ok).toBe(true);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("the stored numbers scroll inside their own box, not the page", async ({ alice }) => {
    await openView(alice, "recovery");
    const table = alice.locator("#rbody .rtable").first();
    await expect(table).toBeVisible();
    await expect(table).toHaveCSS("overflow-x", "auto");
    const sizes = await table.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(sizes.scroll).toBeGreaterThan(sizes.client);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });
});

test.describe("Weight on a phone", () => {
  test("the chart fits the width, and the unit switches to kg", async ({ alice }) => {
    await openView(alice, "weight");
    await expect(alice.locator("#bbody")).not.toContainText("Loading…");
    await alice.locator('#bUnits button[data-unit="kg"]').tap();
    await expect(alice.locator('#bUnits button[data-unit="kg"]')).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#bbody")).toContainText("kg");
    const widths = await alice.locator("#bbody svg").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    expect(widths.length).toBeGreaterThanOrEqual(1);
    for (const w of widths) expect(w).toBeLessThanOrEqual(412);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("the day's figures sit two to a row", async ({ alice }) => {
    await openView(alice, "weight");
    await expect(alice.locator("#bbody .rfigs").first()).toBeVisible();
    expect(await columnsOf(alice, "#bbody .rfigs")).toBe(2);
  });

  test("the unit and range controls are at least 40 px tall", async ({ alice }) => {
    await openView(alice, "weight");
    const heights = await alice.locator("#bUnits button, #bRange").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(heights).toHaveLength(3);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(40);
  });
});

test.describe("Today on a phone", () => {
  test("the cards fit the width, and today's workout is listed", async ({ alice }) => {
    await openView(alice, "today");
    await expect(alice.locator("#tbody")).not.toContainText("Loading…");
    await expect(alice.locator("#tbody")).toContainText("Tempo intervals");
    const widths = await alice.locator("#tbody .tcard").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    expect(widths.length).toBeGreaterThanOrEqual(2);
    for (const w of widths) expect(w).toBeLessThanOrEqual(412);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("a tile opens the view it comes from", async ({ alice }) => {
    await openView(alice, "today");
    await expect(alice.locator("#tbody")).not.toContainText("Loading…");
    await alice.locator(".tfig", { hasText: "Steps" }).tap();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "recovery");
    await expect(alice.locator("#rview")).toBeVisible();
  });
});

test.describe("Settings on a phone", () => {
  test("the form is one column, and its fields are 40 px tall with 16 px text", async ({ alice }) => {
    await openView(alice, "settings");
    await expect(alice.locator("#sbody h2").first()).toBeVisible();
    expect(await columnsOf(alice, "#sbody .sform")).toBe(1);
    const fields = await alice.locator("#sbody input:not([type=checkbox]), #sbody select").evaluateAll((els) =>
      els.map((el) => ({ h: el.getBoundingClientRect().height, size: getComputedStyle(el).fontSize })),
    );
    expect(fields.length).toBeGreaterThanOrEqual(6);
    for (const f of fields) {
      expect(f.h).toBeGreaterThanOrEqual(40);
      expect(f.size).toBe("16px");
    }
  });

  test("◀ Back returns to the view Settings was opened from", async ({ alice }) => {
    await openView(alice, "food");
    await alice.locator("#accountBtn").tap();
    await alice.locator("#openSettings").tap();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "settings");
    await alice.locator("#sBack").tap();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "food");
  });

  test("the sections scroll: the password form at the bottom is reachable", async ({ alice }) => {
    await openView(alice, "settings");
    const scroller = alice.locator("#sscroll");
    await expect(alice.locator("#sbody h2").first()).toBeVisible();
    const overflows = await scroller.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(overflows).toBe(true);
    const change = alice.locator("#sbody button", { hasText: "Change password" });
    await change.scrollIntoViewIfNeeded();
    await expect(change).toBeInViewport();
    await expect(change).toBeVisible();
  });
});
