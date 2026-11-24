import { test, expect, openView, monthView, type Page, type Profile, chooseTheme, toggleTheme } from "../support/fixtures";

test.setTimeout(60_000);

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

  test("the Progress mode stacks its cards inside the width, with a heatmap of 26 weeks", async ({ alice }) => {
    await openView(alice, "activities");
    await alice.locator('#aModes button[data-mode="stats"]').tap();
    await expect(alice.locator("#astats")).toBeVisible();
    await expect(alice.locator("#astats .aheatcard")).toBeVisible();
    await expect(alice.locator("#astats .aheatcard .aeyebrow")).toContainText("last 26 weeks");
    const widest = await alice.locator("#astats .acard").evaluateAll((els) => Math.max(...els.map((el) => el.getBoundingClientRect().width)));
    expect(widest).toBeLessThanOrEqual(412);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("tapping a week of the ribbon narrows the list to that week, and the same week again lets it go", async ({ alice }) => {
    await openView(alice, "activities");
    const weeks = alice.locator("#aribbon .awk12");
    await expect(weeks.first()).toBeVisible();
    const all = await alice.locator("#alist .arow").count();
    await alice.locator("#aribbon .awk12:has(i)").last().tap();
    await expect(alice.locator("#aribbon .awk12.sel")).toHaveCount(1);
    expect(await alice.locator("#alist .arow").count()).toBeLessThan(all);
    await alice.locator("#aribbon .awk12.sel").tap();
    await expect(alice.locator("#aribbon .awk12.sel")).toHaveCount(0);
    await expect(alice.locator("#alist .arow")).toHaveCount(all);
  });
});

test.describe("the Calendar on a phone", () => {
  test("tapping a day lists its workouts below the grid", async ({ alice }) => {
    await monthView(alice);
    await openView(alice, "calendar");
    await alice.locator("#cgrid .cday.today").tap();
    await expect(alice.locator("#cgrid .cday.sel")).toHaveCount(1);
    await expect(alice.locator("#cDay")).toContainText("Tempo intervals");
    const weekday = new Date().toLocaleDateString("en-CA", { weekday: "long", timeZone: "UTC" });
    await expect(alice.locator("#cDayTitle")).toContainText(weekday);
  });

  test("opens on Both: the workouts are dots inside their plan's bar, under its name", async ({ alice }) => {
    await monthView(alice);
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
    await monthView(alice);
    await openView(alice, "calendar");
    await alice.locator("#cNext").tap();
    await alice.locator("#cNext").tap();
    await alice.locator("#cgrid .cday:not(.out)").first().tap();
    await expect(alice.locator("#cDay")).toContainText("Nothing on this day.");
  });

  test("the month grid is seven columns that fit the width", async ({ alice }) => {
    await monthView(alice);
    await openView(alice, "calendar");
    await expect(alice.locator("#cdow span")).toHaveCount(7);
    await expect(alice.locator("#cgrid .cday").first()).toBeVisible();
    const grid = await alice.locator("#cgrid").evaluate((el) => el.getBoundingClientRect().width);
    expect(grid).toBeLessThanOrEqual(412);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("the month arrows move a month, and Today comes back to this one", async ({ alice }) => {
    await monthView(alice);
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
    await alice.locator("#rTabT").tap();
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
    await alice.locator("#rTabD").tap();
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

  test("the figures under the verdict sit two to a row", async ({ alice }) => {
    await openView(alice, "weight");
    await expect(alice.locator("#bbody .bkv").first()).toBeVisible();
    expect(await columnsOf(alice, "#bbody .bkv")).toBe(2);
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

  test("the tiles make two columns, the hero and the cards one, and the food and the days ahead stack", async ({ alice }) => {
    await openView(alice, "today");
    await expect(alice.locator("#tbody")).not.toContainText("Loading…");
    expect(await columnsOf(alice, "#tbody .tfigs")).toBe(2);
    expect(await columnsOf(alice, "#tbody .thero")).toBe(1);
    expect(await columnsOf(alice, "#tbody .trow")).toBe(1);
    const tops = await alice.locator("#tbody .trow > *").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(tops.length);
  });

  test("everything that is tapped on Today is at least 44 px high, in both themes", async ({ alice }) => {
    await openView(alice, "today");
    await expect(alice.locator("#tbody")).not.toContainText("Loading…");
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await chooseTheme(alice, "light");
      const small = await alice.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("#tbar button, #tbody .tgo, #tbody .tcal, #tbody .tgauge ~ .tch button, #tbody .twk, #tbody .tfig")]
          .filter((el) => el.offsetParent !== null)
          .map((el) => [el.className || el.id, Math.round(el.getBoundingClientRect().height)] as const)
          .filter(([, h]) => h < 44),
      );
      expect(small, `${theme}: targets under 44 px`).toEqual([]);
    }
  });

  test("the light theme fits the width too", async ({ alice }) => {
    await openView(alice, "today");
    await expect(alice.locator("#tbody")).not.toContainText("Loading…");
    await toggleTheme(alice);
    await expect(alice.locator("body")).toHaveAttribute("data-theme", "light");
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("a tile opens the view it comes from", async ({ alice }) => {
    await openView(alice, "today");
    await expect(alice.locator("#tbody")).not.toContainText("Loading…");
    await alice.locator(".tfig", { hasText: "Sleep" }).tap();
    await expect(alice.locator("body")).toHaveAttribute("data-view", "recovery");
    await expect(alice.locator("#rview")).toBeVisible();
  });
});

test.describe("Settings on a phone", () => {
  test("the form is one column, and its fields are 40 px tall with 16 px text", async ({ alice }) => {
    await openView(alice, "settings");
    await alice.locator("#sbody .snav [data-section='goals']").tap();
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
    await alice.locator("#sbody .snav [data-section='connections']").tap();
    const scroller = alice.locator("#sscroll");
    await expect(alice.locator("#sbody h2").first()).toBeVisible();
    const overflows = await scroller.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(overflows).toBe(true);
    await alice.locator("#sbody .sback").tap();
    await alice.locator("#sbody .snav [data-section='signin']").tap();
    const change = alice.locator("#sbody button", { hasText: "Change password" });
    await change.scrollIntoViewIfNeeded();
    await expect(change).toBeInViewport();
    await expect(change).toBeVisible();
  });
});

test.describe("the Calendar's new look on a phone", () => {
  test("the bar fits with its theme button, the month is a card that does not scroll by itself, and nothing goes sideways in either theme", async ({ alice }) => {
    await monthView(alice);
    await openView(alice, "calendar");
    await expect(alice.locator("#cgrid .cday").first()).toBeVisible();
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await chooseTheme(alice, "light");
      await expect(alice.locator("body")).toHaveAttribute("data-theme", theme);
      expect(await alice.locator("#cdow").evaluate((el) => getComputedStyle(el).position)).toBe("static");
      await expect.poll(() => stickingOut(alice)).toEqual([]);
      const small = await alice.evaluate(() => [...document.querySelectorAll<HTMLElement>("#cbar button")].filter((el) => el.offsetParent !== null).map((el) => [el.id || el.dataset.mode || "", Math.round(el.getBoundingClientRect().height)] as const).filter(([, h]) => h < 44));
      expect(small, `${theme}: controls under 44 px`).toEqual([]);
    }
  });

  test("the first of a month shows its whole name and number, such as Dec 1, in a cell", async ({ alice }) => {
    await monthView(alice);
    await openView(alice, "calendar");
    const label = alice.locator("#cgrid .cday .dnum", { hasText: /^[A-Z][a-z]{2} 1$/ }).first();
    await expect(label).toBeVisible();
    const fits = await label.evaluate((el) => { const cell = el.closest(".cday")!.getBoundingClientRect(), r = el.getBoundingClientRect(); return r.left >= cell.left - 0.5 && r.right <= cell.right + 0.5 && r.height < 30; });
    expect(fits).toBe(true);
  });
});

test.describe("the Calendar's week on a phone", () => {
  const enc = (path: string) => `/api/file?path=${encodeURIComponent(path)}`;
  async function openWeek(page: Page) {
    await openView(page, "calendar");
    await expect(page.locator("#cwBoard .wday")).toHaveCount(7);
  }
  async function planOf(page: Page, profile: Profile) {
    const name = `${profile.name}-phone`, path = `workout-plans/${name}.json`;
    const res = await profile.api.put(enc(path), { data: { text: JSON.stringify({ weekStart: "2031-09-01", weekEnd: "2031-09-07", workouts: [{ workoutName: "Morning run", workoutType: "running", scheduledDate: "2031-09-03" }] }), create: true } });
    expect(res.status()).toBe(201);
    await openWeek(page);
    await page.locator("#cLegend .citem", { hasText: name }).tap();
    await expect(page.locator("#cwBoard .wday").first()).toHaveAttribute("data-day", "2031-09-01");
  }

  test("the days are one under another with the numbers of the week on top, and nothing goes sideways in either theme", async ({ alice }) => {
    await openWeek(alice);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await chooseTheme(alice, "light");
      await expect(alice.locator("body")).toHaveAttribute("data-theme", theme);
      const lefts = await alice.locator("#cwBoard .wday").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
      expect(new Set(lefts).size).toBe(1);
      const tops = await alice.locator("#cwBoard .wday").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
      expect(tops).toEqual([...tops].sort((a, b) => a - b));
      expect(new Set(tops).size).toBe(7);
      await expect(alice.locator("#cwSum .cws")).toHaveCount(4);
      await expect.poll(() => stickingOut(alice)).toEqual([]);
    }
  });

  test("brings today into sight when the week opens", async ({ alice }) => {
    await openWeek(alice);
    await expect.poll(() => alice.locator("#cwBoard .wday.today").evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; })).toBe(true);
  });

  test("a tap on a card opens its plan, and the ⋯ on it is 44 px and moves the workout", async ({ me, profile }) => {
    await planOf(me, profile);
    const run = me.locator("#cwBoard .wcard", { hasText: "Morning run" });
    const box = (await run.locator(".wcmv").boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await run.locator(".wcmv").tap();
    await expect(me.locator("#moveMenu")).toBeVisible();
    await me.locator("#mvNext").tap();
    await expect(me.locator("#toast")).toContainText("Moved Morning run to");
    await expect(me.locator('#cwBoard .wday[data-day="2031-09-04"] .wcard')).toHaveCount(1);
    await me.locator("#cwBoard .wcard", { hasText: "Morning run" }).tap();
    await expect(me.locator("body")).toHaveAttribute("data-view", "plans");
  });

  test("the bar, the day headers and the cards' controls are at least 44 px", async ({ alice }) => {
    await openWeek(alice);
    const small = await alice.evaluate(() => [...document.querySelectorAll<HTMLElement>("#cbar button, #cwBoard .wdh, #cwBoard .wcmv")].filter((el) => el.offsetParent !== null).map((el) => [el.id || el.className || el.dataset.view || "", Math.round(el.getBoundingClientRect().height)] as const).filter(([, h]) => h < 44));
    expect(small).toEqual([]);
  });
});
