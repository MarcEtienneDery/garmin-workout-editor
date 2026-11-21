import { test, expect, openView, today, daysAgo, type APIRequestContext, type Page, chooseTheme, toggleTheme } from "../support/fixtures";

interface Row { id: number; type: string; date: string; speedKph: number | null; km: number | null; name: string }
async function rowsOf(admin: APIRequestContext): Promise<Row[]> {
  const res = await admin.get("/api/activities?profile=alice");
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { activities: Row[] }).activities;
}

async function stub(page: Page, pattern: RegExp, edit: (json: any) => void): Promise<void> {
  await page.route(pattern, async (route) => {
    const response = await route.fetch(), json = await response.json();
    edit(json);
    await route.fulfill({ response, json });
  });
}

const openLog = async (page: Page) => { await openView(page, "activities"); await expect(page.locator("#alist .arow").first()).toBeVisible(); };
const openProgress = async (page: Page) => {
  await openView(page, "activities");
  await page.locator('#aModes button[data-mode="stats"]').click();
  await expect(page.locator("#astats .aoverall")).toBeVisible();
};

const lowContrast = (page: Page, selectors: string[]) => page.evaluate((sels) => {
  const px = (css: string): number[] => { const c = document.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d")!; g.fillStyle = css; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const lum = ([r, g, b]: number[]) => { const [x, y, z] = [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * x + 0.7152 * y + 0.0722 * z; };
  const bgOf = (el: Element): number[] => {
    const chain: number[][] = [];
    for (let p: Element | null = el; p; p = p.parentElement) chain.push(px(getComputedStyle(p).backgroundColor));
    let [r, g, b] = [0, 0, 0];
    for (const [cr, cg, cb, a] of chain.reverse()) { r = cr * a + r * (1 - a); g = cg * a + g * (1 - a); b = cb * a + b * (1 - a); }
    return [r, g, b];
  };
  const out: string[] = [];
  for (const sel of sels) {
    for (const el of document.querySelectorAll(sel)) {
      if ((el as HTMLElement).offsetParent === null || !(el.textContent || "").trim()) continue;
      const [a, b] = [lum(px(getComputedStyle(el).color)), lum(bgOf(el))];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < 4.5) out.push(`${sel} "${(el.textContent || "").trim().slice(0, 24)}" ${getComputedStyle(el).color}: ${ratio.toFixed(2)}`);
    }
  }
  return out;
}, selectors);

test.describe("the Log", () => {
  test("the bar names the view, says what is stored, and switches between Log and Progress", async ({ alice }) => {
    await openLog(alice);
    await expect(alice.locator("#abar h1")).toHaveText("Activities");
    await expect(alice.locator("#aNote")).toHaveText("27 stored · 3 with details · 1 with graphs");
    await expect(alice.locator("#aModes button")).toHaveText(["Log", "Progress"]);
    await expect(alice.locator("#aModes button", { hasText: "Log" })).toHaveAttribute("aria-pressed", "true");
    await alice.locator("#aModes button", { hasText: "Progress" }).click();
    await expect(alice.locator("#aModes button", { hasText: "Progress" })).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#astats")).toBeVisible();
    await expect(alice.locator("#alist")).toBeHidden();
    await expect(alice.locator("#afilters")).toBeHidden();
    await expect(alice.locator("#aribbon")).toBeHidden();
    await alice.locator("#aModes button", { hasText: "Log" }).click();
    await expect(alice.locator("#alist .arow").first()).toBeVisible();
  });

  test("the ribbon is the last 12 weeks in time, the sports stacked, the current week at the right end", async ({ alice }) => {
    await openLog(alice);
    const weeks = alice.locator("#aribbon .awk12");
    await expect(weeks).toHaveCount(12);
    await expect(alice.locator("#aribbon .aeyebrow")).toHaveText("Last 12 weeks · time");
    await expect(alice.locator("#aribbon .aaxis")).toContainText("this week");
    for (const label of await weeks.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))) expect(label).toMatch(/^Week of [A-Z][a-z]+ \d+: \d+ sessions?(, .+)?$/);
    await expect(weeks.last().locator("i")).not.toHaveCount(0);
  });

  test("a sport has one colour in the row, the ribbon and the filter; the three sports differ", async ({ alice, admin }) => {
    await openLog(alice);
    const rows = await rowsOf(admin);
    const colour = async (id: number) => alice.locator(`#alist .arow[data-id="${id}"]`).evaluate((el) => getComputedStyle(el.querySelector(".aico")!).color);
    const run = rows.find((r) => r.type === "running")!, gym = rows.find((r) => r.type === "strength_training")!, ride = rows.find((r) => r.type === "cycling")!;
    const [r, g, c] = [await colour(run.id), await colour(gym.id), await colour(ride.id)];
    expect(new Set([r, g, c]).size).toBe(3);
  });

  test("a ride's row gives its speed in km/h, a run's its pace, a lift's its time", async ({ alice, admin }) => {
    await openLog(alice);
    const rows = await rowsOf(admin);
    const ride = rows.find((r) => r.type === "cycling" && r.speedKph)!;
    const small = alice.locator(`#alist .arow[data-id="${ride.id}"] .ak small`);
    await expect(small).toContainText(`${ride.speedKph!.toLocaleString("en-CA", { minimumFractionDigits: 1 })} km/h`);
    await expect(alice.locator(`#alist .arow[data-id="9018"] .ak small`)).toContainText("/km");
  });

  test("the type chips narrow the list, and the one pressed is marked", async ({ alice }) => {
    await openLog(alice);
    const chip = alice.locator("#aTypes .tchip", { hasText: "Cycling" });
    await expect(chip).toContainText("2");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(alice.locator("#alist .arow")).toHaveCount(2);
    await chip.click();
    await expect(alice.locator("#alist .arow").first()).toBeVisible();
    expect(await alice.locator("#alist .arow").count()).toBeGreaterThan(2);
  });

  test("a planned run is tagged in its row, and its detail sets the planned bars beside the effort and effect", async ({ alice }) => {
    await openLog(alice);
    await expect(alice.locator('#alist .arow[data-id="9018"] .atag.plan')).toHaveText("✓ planned");
    await alice.locator('#alist .arow[data-id="9018"]').click();
    const planned = alice.locator("#abody .aplanned"), effect = alice.locator("#abody .aeffect");
    await expect(planned).toBeVisible();
    await expect(effect).toBeVisible();
    const [p, e] = [(await planned.boundingBox())!, (await effect.boundingBox())!];
    expect(Math.abs(p.y - e.y), "side by side, on the same row").toBeLessThan(6);
    expect(p.x + p.width).toBeLessThanOrEqual(e.x + 1);
  });
});

test.describe("the muscle map", () => {
  test("on Progress it is compact: some of the muscles, the short list of the least worked, and a way to the rest", async ({ alice }) => {
    await openProgress(alice);
    const card = alice.locator("#astats .ammc");
    await expect(card).not.toHaveClass(/open/);
    await expect(card.locator(".ammt")).toHaveText(/^Show all \d+ ›$/);
    await expect(card.locator(".ammt")).toHaveAttribute("aria-expanded", "false");
    await expect(card.locator(".ammbal")).toHaveCount(0);
    expect(await card.locator(".ammrow").count()).toBeLessThanOrEqual(8);
    await expect(card.locator(".ammunder .aeyebrow")).toHaveText("Under 4 sets");
    expect(await card.locator(".ammunder .acchip").count()).toBeLessThanOrEqual(4);
    await expect(card.locator(".ammunder .ammnone")).toContainText(/^\+\d+ more$/);
  });

  test("Show all opens the rest in place, with the share of push, pull, legs and core, and Show less closes it again", async ({ alice }) => {
    await openProgress(alice);
    const card = () => alice.locator("#astats .ammc");
    const compact = await card().locator(".ammrow").count();
    await card().locator(".ammt").click();
    await expect(card()).toHaveClass(/open/);
    await expect(card().locator(".ammt")).toHaveText("Show less ‹");
    await expect(card().locator(".ammt")).toBeFocused();
    expect(await card().locator(".ammrow").count()).toBeGreaterThan(compact);
    await expect(card().locator(".ammbal .aeyebrow")).toHaveText("Share of the muscle work");
    const stack = card().locator(".ammstack");
    await expect(stack).toHaveAttribute("role", "img");
    await expect(stack).toHaveAttribute("aria-label", /Push \d+ percent, Pull \d+ percent, Legs \d+ percent, Core \d+ percent/);
    await card().locator(".ammt").click();
    await expect(card()).not.toHaveClass(/open/);
    await expect(card().locator(".ammrow")).toHaveCount(compact);
  });

  test("the drawing is the app's own, and a muscle in the list lights the same muscle in the drawing", async ({ alice }) => {
    await openProgress(alice);
    const card = alice.locator("#astats .ammc");
    await expect(card.locator("svg .mm-muscle").first()).toBeAttached();
    const row = card.locator(".ammrow", { hasText: "Chest" });
    await row.hover();
    await expect(card.locator('.mm-muscle[data-muscle="chest"].on').first()).toBeAttached();
    await expect(row).toHaveClass(/on/);
    await expect(card.locator(".ammread")).toContainText(/^Chest · \d+ sets: /);
    await alice.mouse.move(0, 0);
    await expect(card.locator(".mm-muscle.on")).toHaveCount(0);
    await expect(card.locator(".ammread")).toContainText("Darker means more sets");
  });

  test("a muscle in the drawing is a button: the keyboard reaches it, and it names itself and its sets", async ({ alice }) => {
    await openProgress(alice);
    const card = alice.locator("#astats .ammc");
    const muscle = card.locator('.mm-muscle.t[data-muscle="chest"]').first();
    await expect(muscle).toHaveAttribute("role", "button");
    await expect(muscle).toHaveAttribute("aria-label", /^Chest, \d+ sets$/);
    await muscle.focus();
    await expect(card.locator(".ammread")).toContainText(/^Chest · /);
    await expect(card.locator(".ammrow", { hasText: "Chest" })).toHaveClass(/on/);
    await muscle.blur();
    await expect(card.locator(".ammrow.on")).toHaveCount(0);
  });

  test("the fill follows the sets, and a muscle that only helped is hatched where one that was worked directly is not", async ({ alice }) => {
    await openProgress(alice);
    await alice.locator("#astats .ammc .ammt").click();
    const fills = await alice.locator("#astats .ammc .mm-muscle").evaluateAll((els) => els.map((e) => e.getAttribute("fill") || ""));
    expect(fills.some((f) => f.startsWith("color-mix(in srgb, var(--accent)"))).toBe(true);
    expect(fills).toContain("url(#mmhat)");
    expect(fills).toContain("var(--mm-idle)");
  });

  test("the period buttons change the card and its note: 7 days, 4 weeks and 12 weeks", async ({ alice }) => {
    await openProgress(alice);
    const card = alice.locator("#astats .ammc");
    await expect(card.locator(".aeyebrow").first()).toHaveText("Muscles · last 4 weeks");
    await expect(card.locator(".amperiods button")).toHaveText(["7 days", "4 weeks", "12 weeks"]);
    await expect(card.locator(".amperiods button", { hasText: "4 weeks" })).toHaveAttribute("aria-pressed", "true");
    await card.locator(".amperiods button", { hasText: "12 weeks" }).click();
    await expect(alice.locator("#astats .ammc .aeyebrow").first()).toHaveText("Muscles · last 12 weeks");
    await expect(alice.locator("#astats .ammc .ammnote").first()).toContainText(/^From the sets of \d+ strength sessions? with details stored\.$/);
    await alice.locator("#astats .ammc .amperiods button", { hasText: "7 days" }).click();
    await expect(alice.locator("#astats .ammc .aeyebrow").first()).toHaveText("Muscles · last 7 days");
  });

  test("with no stored sets at all the card is left out, and with none in the period it says so instead of drawing an empty body", async ({ alice }) => {
    await stub(alice, /\/api\/activities\/stats\?/, (json) => { json.stats.strength.recent = []; });
    await openProgress(alice);
    await expect(alice.locator("#astats .astrength")).toBeVisible();
    await expect(alice.locator("#astats .ammc")).toHaveCount(0);
    await alice.unroute(/\/api\/activities\/stats\?/);
    await stub(alice, /\/api\/activities\/stats\?/, (json) => { for (const s of json.stats.strength.recent) s.date = "2020-01-01"; });
    await alice.reload({ waitUntil: "domcontentloaded" });
    await alice.locator('#aModes button[data-mode="stats"]').click();
    const card = alice.locator("#astats .ammc");
    await expect(card.locator(".anote")).toHaveText("No strength session with details in this period.");
    await expect(card.locator("svg")).toHaveCount(0);
    await expect(card.locator(".amperiods button")).toHaveCount(3);
  });

  test("the sets worked in each muscle match the stored sets of the sessions of the period, by 2 for a direct set and 1 for a helping one", async ({ alice }) => {
    const res = await alice.request.get("/api/activities/stats?profile=alice");
    const stats = (await res.json()).stats;
    expect(stats.strength.recent.length).toBeGreaterThan(0);
    await openProgress(alice);
    await alice.locator("#astats .ammc .amperiods button", { hasText: "12 weeks" }).click();
    await alice.locator("#astats .ammc .ammt").click();
    const rows = await alice.locator("#astats .ammc .ammrow").evaluateAll((els) => els.map((e) => ({ label: e.getAttribute("aria-label") || "" })));
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) expect(r.label).toMatch(/^.+, \d+(\.\d)? sets$/);
  });
});

test.describe("Progress", () => {
  test("the cards: overall, time by week, by year, the consistency map, running, records and strength", async ({ alice }) => {
    await openProgress(alice);
    const eyebrows = await alice.locator("#astats .aeyebrow").allTextContents();
    for (const title of ["Overall", "Time by week · last 26 weeks", "By year", "Consistency · last 12 months", "Running", "Best efforts and records", "Strength", "Muscles · last 4 weeks"]) {
      expect(eyebrows.map((t) => t.trim()), title).toContain(title);
    }
  });

  test("the consistency map has a cell for each day of 52 weeks, and the figures beside it count the days with a session", async ({ alice, admin }) => {
    await openProgress(alice);
    await expect(alice.locator("#astats .aheat i")).toHaveCount(364);
    const rows = await rowsOf(admin);
    const from = daysAgo(364), days = new Set(rows.filter((r) => r.date >= from && r.date <= today()).map((r) => r.date));
    const shown = Number(await alice.locator("#astats .aheatstats span").first().locator("b").innerText());
    expect(shown).toBe(days.size);
    await expect(alice.locator("#astats .aheat")).toHaveAttribute("aria-label", new RegExp(`^${days.size} active days in the last 52 weeks`));
    expect(await alice.locator("#astats .aheat i.l1, #astats .aheat i.l2, #astats .aheat i.l3, #astats .aheat i.l4").count()).toBeGreaterThan(0);
  });

  test("a cell of the map says its day: the sessions and their time, or nothing", async ({ alice }) => {
    await openProgress(alice);
    const titles = await alice.locator("#astats .aheat i[title]").evaluateAll((els) => els.map((e) => e.getAttribute("title") || ""));
    expect(titles.some((t) => /: \d+ sessions?, /.test(t))).toBe(true);
    expect(titles.some((t) => t.endsWith(": nothing"))).toBe(true);
  });

  test("the running card draws the VO2 max trend when the server sends one, and says nothing when it does not", async ({ alice }) => {
    await stub(alice, /\/api\/activities\/stats\?/, (json) => { json.stats.running.vo2max = { latest: { value: 52, date: daysAgo(2) }, best: { value: 54, date: daysAgo(90) }, series: [{ date: daysAgo(40), value: 49 }, { date: daysAgo(20), value: 51 }, { date: daysAgo(2), value: 52 }] }; });
    await openProgress(alice);
    const card = alice.locator("#astats .avo2");
    await expect(card.locator("svg.aline")).toHaveAttribute("aria-label", /^VO2max: 49 on .+, 52 on /);
    await expect(card.locator(".anote")).toContainText("52 now · best 54 on ");
  });

  test("an exercise's card carries its estimated 1RM over time when it has more than one session", async ({ alice }) => {
    await stub(alice, /\/api\/activities\/stats\?/, (json) => {
      const ex = json.stats.strength.exercises[0];
      ex.history = [{ date: daysAgo(30), oneRm: 200 }, { date: daysAgo(15), oneRm: 210 }, { date: daysAgo(3), oneRm: 220 }];
    });
    await openProgress(alice);
    const first = alice.locator("#astats .alifts .aexc2").first();
    await expect(first.locator("svg.aspark")).toHaveAttribute("aria-label", /^200 on .+, 220 on /);
  });
});

test.describe("the empty states", () => {
  test("nothing stored and no Garmin login: the Log says so with the reason, and offers nothing to fetch", async ({ alice }) => {
    await stub(alice, /\/api\/activities\?/, (json) => { json.activities = []; });
    await openView(alice, "activities");
    await expect(alice.locator("#alist .aemptycard h2")).toHaveText("No activities are stored yet");
    await expect(alice.locator("#alist .aemptycard button")).toHaveCount(0);
    await expect(alice.locator("#aribbon .acard")).toHaveCount(0);
    await expect(alice.locator("#afilters")).toBeHidden();
  });

  test("a search with no match says so, and the ribbon and the filters stay", async ({ alice }) => {
    await openLog(alice);
    await alice.locator("#aSearch").fill("zzzz no such activity");
    await expect(alice.locator("#alist .empty")).toHaveText("No activity matches.");
    await expect(alice.locator("#afilters")).toBeVisible();
    await expect(alice.locator("#aribbon .awk12")).toHaveCount(12);
  });
});

test.describe("the look, in both themes", () => {
  test("the Log, the detail and Progress keep their contrast: 4.5 to 1 for each text against what it sits on", async ({ alice }) => {
    await openLog(alice);
    for (const theme of ["dark", "light"]) {
      await alice.locator('#aModes button[data-mode="list"]').click();
      await expect(alice.locator("#alist .arow").first()).toBeVisible();
      if (theme === "light") await chooseTheme(alice, "light");
      await expect(alice.locator("body")).toHaveAttribute("data-theme", theme);
      await alice.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
      expect(await lowContrast(alice, ["#abar h1", "#aNote", "#aview .arow .nm", "#aview .arow .ameta", "#aview .arow .ak b", "#aview .arow .ak small", "#aribbon .aeyebrow", "#aribbon .aaxis span", "#aTypes .tchip"]), `${theme}: the Log`).toEqual([]);
      await alice.locator('#alist .arow[data-id="9018"]').click();
      await expect(alice.locator("#abody .ahero")).toBeVisible();
      expect(await lowContrast(alice, ["#abody .afig b", "#abody .afig small", "#abody .amini", "#abody .aeyebrow", "#abody .aeff", "#abody .abl", "#abody .abn span", "#abody .anote", "#abody .alaprow"]), `${theme}: the detail`).toEqual([]);
      await alice.locator('#alist .arow[data-id="9019"]').click();
      await expect(alice.locator("#abody .aexercises")).toBeVisible();
      expect(await lowContrast(alice, ["#abody .aexn", "#abody .aext", "#abody .aexchip", "#abody .aexnote", "#abody .ammrow", "#abody .ammread"]), `${theme}: the lift`).toEqual([]);
      await alice.locator('#aModes button[data-mode="stats"]').click();
      await expect(alice.locator("#astats .aoverall")).toBeVisible();
      expect(await lowContrast(alice, ["#astats .aeyebrow", "#astats .aoverall *", "#astats .aheatstats span", "#astats .ammrow", "#astats .ammread", "#astats .ammunder .acchip", "#astats .ammnote", "#astats .ammt", "#astats .amperiods button"]), `${theme}: Progress`).toEqual([]);
    }
    await toggleTheme(alice);
  });

  test("the muscle map is drawn in the theme's colours: the idle body and the fills change with the theme", async ({ alice }) => {
    await openProgress(alice);
    const idle = () => alice.locator("#astats .ammc").evaluate((el) => getComputedStyle(el).getPropertyValue("--mm-idle").trim());
    const dark = await idle();
    await toggleTheme(alice);
    await expect(alice.locator("body")).toHaveAttribute("data-theme", "light");
    const light = await idle();
    expect(light).not.toBe(dark);
    await toggleTheme(alice);
  });

  test("the controls of the bar, the filters and the ribbon are at least 44 px high", async ({ alice }) => {
    await openLog(alice);
    for (const sel of ["#aModes button", "#aRange", ".asearch", "#aTypes .tchip", "#aribbon .awk12"]) {
      for (const [w, h] of await alice.locator(sel).evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]))) {
        expect(h, `${sel} height`).toBeGreaterThanOrEqual(44);
        expect(w, `${sel} width`).toBeGreaterThanOrEqual(sel.includes("awk12") ? 16 : 44);
      }
    }
  });

  test("the button in the bar switches between dark and light, one choice shared with the other views", async ({ alice }) => {
    await openLog(alice);
    const body = alice.locator("body");
    await expect(body).toHaveAttribute("data-theme", "dark");
    await toggleTheme(alice);
    await expect(body).toHaveAttribute("data-theme", "light");
    await expect(alice.locator("body")).toHaveAttribute("data-theme", "light");
    await alice.reload({ waitUntil: "domcontentloaded" });
    await expect(alice.locator("#alist .arow").first()).toBeVisible();
    await expect(body).toHaveAttribute("data-theme", "light");
    await toggleTheme(alice);
    await expect(body).toHaveAttribute("data-theme", "dark");
  });
});
