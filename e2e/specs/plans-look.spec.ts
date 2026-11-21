import { test, expect, openView, mondayOf, daysAhead, today, type Page, type APIRequestContext, toggleTheme } from "../support/fixtures";

test.describe.configure({ timeout: 60_000 });

const run = (name: string, dates: unknown, extra: Record<string, unknown> = {}) => ({
  workoutName: name,
  workoutType: "running",
  ...(dates === undefined ? {} : { scheduledDate: dates }),
  steps: [{ stepType: "interval", targetType: "no.target", endCondition: "distance", endConditionValue: 5000 }],
  ...extra,
});
const lift = (name: string, dates: unknown) => ({
  workoutName: name,
  workoutType: "strength_training",
  scheduledDate: dates,
  steps: [
    { stepType: "exercise", exerciseName: "BARBELL_BACK_SQUAT", targetType: "no.target", endCondition: "reps", endConditionValue: 5 },
    { stepType: "rest", targetType: "no.target", endCondition: "time", endConditionValue: 90 },
    { stepType: "exercise", exerciseName: "BARBELL_BENCH_PRESS", targetType: "no.target", endCondition: "reps", endConditionValue: 8 },
  ],
});

const MON = mondayOf(today());
const day = (week: number, dow: number) => daysAhead(Math.round((Date.parse(`${MON}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000) + week * 7 + dow);

async function makePlan(api: APIRequestContext, name: string, workouts: unknown[], extra: Record<string, unknown> = {}): Promise<string> {
  const path = `workout-plans/${name}.json`;
  const text = JSON.stringify({ weekStart: MON, weekEnd: day(2, 6), workouts, ...extra }, null, 2);
  expect((await api.put(`/api/file?path=${encodeURIComponent(path)}`, { data: { text, create: true } })).status()).toBe(201);
  return path;
}

async function openPlan(page: Page, name: string): Promise<void> {
  await openView(page, "plans");
  await expect.poll(() => page.evaluate(() => typeof editor !== "undefined" && !!editor && document.getElementById("new")!.onclick !== null)).toBe(true);
  await page.locator("#filelist .file").filter({ hasText: name }).click();
  await expect(page.locator("#current")).toContainText(name);
  await expect(page.locator("#pform .wf")).toBeVisible();
}
const settle = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));

test.describe("the plan day by day", () => {
  test("has a row for each week from the first day's, Monday to Sunday, with each workout on its day", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-grid`, [lift("Upper", day(0, 0)), run("Easy", day(0, 1)), run("Tempo", [day(2, 2), day(2, 4)])]);
    await openPlan(me, `${profile.name}-grid`);
    await expect(me.locator(".sg .sgh")).toHaveText(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    await expect(me.locator(".sg .sgw b")).toHaveText(["Week 1", "Week 2", "Week 3"]);
    await expect(me.locator(".sg .sgc")).toHaveCount(21);
    await expect(me.locator(".sg .sgc").nth(0).locator(".wc")).toHaveText("Upper");
    await expect(me.locator(".sg .sgc").nth(1).locator(".wc")).toHaveText("Easy");
    await expect(me.locator(".sg .sgc").nth(7 + 3)).toHaveText(/^\d+$/);
    await expect(me.locator(".sg .sgc").nth(14 + 2).locator(".wc")).toHaveText("Tempo");
    await expect(me.locator(".sg .sgc").nth(14 + 4).locator(".wc")).toHaveText("Tempo");
    await expect(me.locator(".sg .sgc.today")).toHaveCount(1);
  });

  test("adds up the plan: sessions, run distance, time and lifting sets, and each week's kilometres", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-sums`, [lift("Upper", day(0, 0)), run("Easy", [day(0, 1), day(1, 1)])]);
    await openPlan(me, `${profile.name}-sums`);
    const tile = (label: string) => me.locator(".psched .sums div", { hasText: label }).locator("b");
    await expect(tile("Sessions")).toHaveText("3");
    await expect(tile("Run distance")).toHaveText("10 km");
    await expect(tile("Lifting sets")).toHaveText("2");
    await expect(me.locator(".sg .sgw").nth(0)).toContainText("5 km");
  });

  test("a tap on a workout opens it in the form, and ‹ The plan comes back to the grid", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-tap`, [run("Easy", day(0, 1)), run("Tempo", day(0, 3))]);
    await openPlan(me, `${profile.name}-tap`);
    await expect(me.locator("#pcrumb")).toHaveText("The plan");
    await me.locator(".sg .wc", { hasText: "Tempo" }).click();
    await expect(me.locator("#pcrumb")).toContainText("Workout 2 of 2");
    await expect(me.locator("#pform .wf-name")).toHaveValue("Tempo");
    await expect(me.locator("#outline .row.wk.sel .name")).toHaveText("Tempo");
    await me.locator("#pcrumb").getByRole("button", { name: "‹ The plan" }).click();
    await expect(me.locator(".sg")).toBeVisible();
    await expect(me.locator("#outline .row.plan")).toHaveClass(/sel/);
  });

  test("lists the workouts with no day, and the dates that are not days, under the grid", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-loose`, [run("Easy", day(0, 1)), run("Someday", undefined), run("Typo", "2026-12-2")]);
    await openPlan(me, `${profile.name}-loose`);
    await expect(me.locator(".ploose li")).toHaveCount(3);
    await expect(me.locator(".ploose")).toContainText("Someday has no day");
    await expect(me.locator(".ploose")).toContainText("Typo has no day");
    await expect(me.locator(".ploose")).toContainText('Typo date "2026-12-2" is not a day (YYYY-MM-DD)');
    await me.locator(".ploose").getByRole("button", { name: "Someday" }).click();
    await expect(me.locator("#pform .wf-name")).toHaveValue("Someday");
  });

  test("a plan with no day at all says so instead of drawing an empty grid", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-nodays`, [run("Someday", undefined)]);
    await openPlan(me, `${profile.name}-nodays`);
    await expect(me.locator(".psched .pnone")).toContainText("No workout has a day yet");
    await expect(me.locator(".sg")).toHaveCount(0);
  });

  test("Open in Calendar shows the plan's first week there", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-cal`, [run("Easy", day(1, 2))]);
    await openPlan(me, `${profile.name}-cal`);
    await me.getByRole("button", { name: "Open in Calendar ›" }).click();
    await expect(me.locator("body")).toHaveAttribute("data-view", "calendar");
    expect(await me.evaluate(() => C.week)).toBe(day(1, 0));
  });

  test("shows the first weeks of a long plan, and the rest on request", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-long`, [run("Easy", Array.from({ length: 14 }, (_, w) => day(w, 1)))]);
    await openPlan(me, `${profile.name}-long`);
    await expect(me.locator(".sg .sgw b")).toHaveCount(12);
    await me.getByRole("button", { name: "Show all 14 weeks ›" }).click();
    await expect(me.locator(".sg .sgw b")).toHaveCount(14);
  });
});

test.describe("the bar", () => {
  test("the title is the plan's name, with the file under it, and a dot and a note while it has unsaved changes", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-title`, [run("Easy", day(0, 1))]);
    await expect(async () => { await openView(me, "plans"); await expect(me.locator("#pName")).toHaveText("Plans"); }).toPass();
    await openPlan(me, `${profile.name}-title`);
    const expected = `${profile.name}-title`.replace(/[-_]+/g, " ");
    await expect(me.locator("#pName")).toHaveText(expected.charAt(0).toUpperCase() + expected.slice(1));
    await expect(me.locator("#current")).toHaveAttribute("data-note", /^saved /);
    await expect(me.locator("#pDot")).toBeHidden();
    await me.evaluate(() => { const d = JSON.parse(editor.getValue()); d.notes = "x"; editor.setValue(JSON.stringify(d, null, 2)); });
    await expect(me.locator("#pDot")).toBeVisible();
    await expect(me.locator("#current")).toHaveAttribute("data-note", "unsaved changes");
    await me.locator("#save").click();
    await expect(me.locator("#pDot")).toBeHidden();
    await expect(me.locator("#current")).toHaveAttribute("data-note", /^saved /);
  });

  test("the pill says Valid with the workout count, or the errors, and opens the checks", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-ok`, [run("Easy", day(0, 1))]);
    await makePlan(profile.api, `${profile.name}-bad`, [run("Easy", day(0, 1), { steps: [{ stepType: "interval", endCondition: "distance", endConditionValue: 5000 }] })]);
    await openPlan(me, `${profile.name}-ok`);
    await expect(me.locator("#vpill")).toHaveText("Valid · 1 workout");
    await expect(me.locator("#vpill")).toHaveClass(/ok/);
    await me.locator("#filelist .file").filter({ hasText: `${profile.name}-bad` }).click();
    await expect(me.locator("#vpill")).toContainText("1 error");
    await expect(me.locator("#vpill")).toHaveClass(/err/);
    await expect(me.locator("#problems .msg.err")).toContainText("targetType");
    await me.locator("#vpill").click();
    await expect(me.locator("#problemsPane")).not.toHaveClass(/open/);
    await me.locator("#vpill").click();
    await expect(me.locator("#problemsPane")).toHaveClass(/open/);
    await expect(me.locator("#problems .msg.err .plink")).toHaveText("Show in editor");
    await me.locator("#problems .msg.err .plink").click();
    await expect(me.locator("body")).toHaveAttribute("data-emode", "json");
  });
});

test.describe("menus", () => {
  test("a file's ⋯ is one button on its row, with Duplicate, Rename, Archive and Delete in a menu", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-menu`, [run("Easy", day(0, 1))]);
    await openPlan(me, `${profile.name}-menu`);
    const row = me.locator("#filelist .file").filter({ hasText: `${profile.name}-menu` });
    await expect(row.locator("button")).toHaveCount(1);
    await row.locator("button.more").click();
    await expect(me.locator("#pmenu").getByRole("menuitem")).toHaveText([/Duplicate/, /Rename/, /Archive/, /Delete/]);
    await me.keyboard.press("Escape");
    await expect(me.locator("#pmenu")).toBeHidden();
  });

  test("a workout's ⋯ in the outline has Duplicate and Remove, which asks first", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-ol`, [run("Easy", day(0, 1)), run("Tempo", day(0, 3))]);
    await openPlan(me, `${profile.name}-ol`);
    await expect(me.locator("#outline .row.wk")).toHaveCount(2);
    await me.locator("#outline .row.wk").nth(0).locator("button.more").click();
    await expect(me.locator("#pmenu").getByRole("menuitem")).toHaveText([/Duplicate/, /Remove from the plan/]);
    await me.locator("#pmenu").getByRole("menuitem", { name: "Duplicate" }).click();
    await expect(me.locator("#outline .row.wk .name")).toHaveText(["Easy", "Easy (copy)", "Tempo"]);
  });

  test("the file menu in the bar has Reload from disk, History, Duplicate, Rename, Archive and Delete", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-fm`, [run("Easy", day(0, 1))]);
    await openPlan(me, `${profile.name}-fm`);
    await me.locator("#fileBtn").click();
    await expect(me.locator("#fileMenu button")).toHaveText(["Reload from disk", "History", "Duplicate", "Rename", "Archive", "Delete"]);
  });
});

test.describe("a lifting workout", () => {
  test("draws its muscles compactly in the overview: the five most worked, and the rest on request", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-mm`, [lift("Legs and chest", day(0, 0))]);
    await openPlan(me, `${profile.name}-mm`);
    await me.locator("#outline .row.wk .name").click();
    const box = me.locator("#pform .wf-pic .mmc");
    await expect(box).toBeVisible();
    await expect(box.locator(".mm-fig")).toHaveCount(2);
    await expect(box.locator(".ammrow")).toHaveCount(5);
    const all = box.getByRole("button", { name: /^Show all \d+ ›$/ });
    await all.click();
    expect(await box.locator(".ammrow").count()).toBeGreaterThan(5);
    await box.getByRole("button", { name: "Show less ‹" }).click();
    await expect(box.locator(".ammrow")).toHaveCount(5);
    const box2 = await box.boundingBox();
    expect(box2!.height).toBeLessThan(260);
  });
});

test.describe("Monaco in the page's colours", () => {
  test("the JSON follows the theme: dark Ember, then the light one", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-theme`, [run("Easy", day(0, 1))]);
    await openPlan(me, `${profile.name}-theme`);
    await me.locator("#emode button[data-mode=json]").click();
    const root = me.locator("#editor .monaco-editor").first();
    await expect(root).toHaveClass(/vs-dark/);
    await expect.poll(() => me.locator("#editor .monaco-editor-background").first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(18, 14, 11)");
    await toggleTheme(me);
    await expect.poll(() => me.locator("#editor .monaco-editor-background").first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 253, 248)");
    await expect(root).not.toHaveClass(/vs-dark/);
    await toggleTheme(me);
  });
});

test.describe("looks", () => {
  test("text keeps its contrast and what is touched is 44 px, in both themes", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-look`, [run("Easy", day(0, 1)), lift("Upper", day(0, 3))]);
    await openPlan(me, `${profile.name}-look`);
    for (const theme of ["dark", "light"]) {
      await me.evaluate((t) => document.body.setAttribute("data-theme", t), theme);
      await settle(me);
      const low = await me.evaluate(() => {
        const lum = (css: string) => {
          const unit = css.startsWith("color(srgb") ? 1 : 255;
          const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => { const c = v / unit; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const bgOf = (el: Element): string => { for (let p: Element | null = el; p; p = p.parentElement) { const c = getComputedStyle(p).backgroundColor; if (!/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(c)) return c; } return "rgb(0, 0, 0)"; };
        const out: string[] = [];
        const check = (selector: string, need: number) => {
          for (const el of document.querySelectorAll(selector)) {
            const r = el.getBoundingClientRect(); if (!r.width) continue;
            const [a, b] = [lum(getComputedStyle(el).color), lum(bgOf(el))], ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            if (ratio < need) out.push(`${selector} ${el.className || el.tagName} ${ratio.toFixed(2)} < ${need}`);
          }
        };
        check("#pName, #outline .row .name, #filelist .file > span:first-child > span, .sgw b, .sums b", 7);
        check("#current, .peyebrow, .sgh, .sgw, .pssub, #outline .row small, #filelist .file small, .pkey, .sums small, #pcrumb, #checksBtn .ctxt, #filelist h2.fold", 4.5);
        return out;
      });
      expect(low, `${theme}: text under its contrast`).toEqual([]);
      const small = await me.evaluate(() => [...document.querySelectorAll<HTMLElement>("#toolbar button, #filelist .file, #filelist button.more, #outline button.more, #outline .row .name, #new, #outAdd, #checksBtn, #ebar button, .sgc .wc")].filter((e) => e.offsetParent && e.getBoundingClientRect().height < (e.matches(".sgc .wc") ? 24 : 43.5)).map((e) => `${e.id || e.className} ${Math.round(e.getBoundingClientRect().height)}`));
      expect(small, `${theme}: under 44 px`).toEqual([]);
    }
    await me.evaluate(() => document.body.setAttribute("data-theme", "dark"));
  });

  test("shows no more than the screen is wide", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-wide`, [run("Easy", day(0, 1)), lift("Upper", day(1, 3))]);
    await openPlan(me, `${profile.name}-wide`);
    expect(await me.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await me.locator("#outline .row.wk .name").first().click();
    expect(await me.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
