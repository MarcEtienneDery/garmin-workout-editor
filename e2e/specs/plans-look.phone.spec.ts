import { test, expect, openView, mondayOf, daysAhead, today, type Page, type APIRequestContext } from "../support/fixtures";
import { withGarmin } from "../support/garmin";

test.describe.configure({ timeout: 60_000 });

const run = (name: string, dates: unknown, extra: Record<string, unknown> = {}) => ({
  workoutName: name,
  workoutType: "running",
  scheduledDate: dates,
  steps: [{ stepType: "interval", targetType: "no.target", endCondition: "distance", endConditionValue: 5000 }],
  ...extra,
});
const MON = mondayOf(today());
const day = (week: number, dow: number) => daysAhead(Math.round((Date.parse(`${MON}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000) + week * 7 + dow);

async function makePlan(api: APIRequestContext, name: string, workouts: unknown[]): Promise<void> {
  const text = JSON.stringify({ weekStart: MON, weekEnd: day(1, 6), workouts }, null, 2);
  expect((await api.put(`/api/file?path=${encodeURIComponent(`workout-plans/${name}.json`)}`, { data: { text, create: true } })).status()).toBe(201);
}

async function openPlan(page: Page, name: string): Promise<void> {
  await openView(page, "plans");
  await expect.poll(() => page.evaluate(() => typeof editor !== "undefined" && !!editor && document.getElementById("new")!.onclick !== null)).toBe(true);
  await page.locator("#filelist .file").filter({ hasText: name }).tap();
  await expect(page.locator("#current")).toContainText(name);
  await page.locator("#tabbar button[data-tab=editor]").tap();
  await expect(page.locator("#pform .wf")).toBeVisible();
}

async function stickingOut(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const shownRight = (el: Element) => {
      let right = el.getBoundingClientRect().right;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== "visible") right = Math.min(right, p.getBoundingClientRect().right);
      return right;
    };
    return [...document.body.querySelectorAll("#pview *, #gdrawer *, #pmenu *")]
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

test.describe("the Plans view on a phone", () => {
  test("has the bar under the title, with Save, Garmin and ⋯, and the tabs at the foot", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-ph`, [run("Easy", day(0, 1)), run("Tempo", day(1, 3))]);
    await openPlan(me, `${profile.name}-ph`);
    const [title, save, tabs] = await Promise.all([me.locator("#pTitle").boundingBox(), me.locator("#save").boundingBox(), me.locator("#tabbar").boundingBox()]);
    expect(save!.y).toBeGreaterThan(title!.y + title!.height - 1);
    expect(tabs!.y + tabs!.height).toBeGreaterThanOrEqual(me.viewportSize()!.height - 1);
    await expect(me.locator("#emode button")).toHaveText(["Form", "JSON"]);
    await expect.poll(() => stickingOut(me)).toEqual([]);
  });

  test("fits the plan day by day to the width: a row for each week, the workouts as colour", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-phgrid`, [run("Easy", day(0, 1)), run("Tempo", day(1, 3))]);
    await openPlan(me, `${profile.name}-phgrid`);
    await expect(me.locator(".sg .sgw b")).toHaveText(["Week 1", "Week 2"]);
    const grid = (await me.locator(".sg").boundingBox())!;
    expect(grid.x + grid.width).toBeLessThanOrEqual(me.viewportSize()!.width);
    const chip = (await me.locator(".sg .wc").first().boundingBox())!;
    expect(chip.width).toBeGreaterThanOrEqual(24);
    await me.locator(".sg .wc", { hasText: "Tempo" }).tap();
    await expect(me.locator("#pcrumb")).toContainText("Workout 2 of 2");
  });

  test("the Checks tab shows the checks alone, and the pill goes there", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-phck`, [run("Easy", day(0, 1), { steps: [{ stepType: "interval", endCondition: "distance", endConditionValue: 5000 }] })]);
    await openPlan(me, `${profile.name}-phck`);
    await expect(me.locator("#problemsPane")).not.toHaveClass(/open/);
    await me.locator("#vpill").tap();
    await expect(me.locator("body")).toHaveAttribute("data-tab", "problems");
    await expect(me.locator("#problems .msg.err")).toBeVisible();
    await expect(me.locator("#pform")).toBeHidden();
  });

  test("what is touched is 44 px tall", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-phsz`, [run("Easy", day(0, 1))]);
    await openPlan(me, `${profile.name}-phsz`);
    const small = await me.evaluate(() => [...document.querySelectorAll<HTMLElement>("#toolbar button, #tabbar button, #ebar button, #outAdd")].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 43.5).map((e) => `${e.id || e.className} ${Math.round(e.getBoundingClientRect().height)}`));
    expect(small).toEqual([]);
    await me.locator("#tabbar button[data-tab=files]").tap();
    const rows = await me.locator("#filelist .file, #filelist button.more").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(Math.min(...rows)).toBeGreaterThanOrEqual(44);
  });

  test("a menu opens as a sheet at the foot of the screen", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-phmenu`, [run("Easy", day(0, 1))]);
    await openPlan(me, `${profile.name}-phmenu`);
    await me.locator("#tabbar button[data-tab=files]").tap();
    await me.locator("#filelist .file").filter({ hasText: `${profile.name}-phmenu` }).locator("button.more").tap();
    const menu = (await me.locator("#pmenu").boundingBox())!;
    expect(menu.x).toBeLessThanOrEqual(1);
    expect(menu.width).toBeGreaterThanOrEqual(me.viewportSize()!.width - 2);
    expect(menu.y + menu.height).toBeGreaterThanOrEqual(me.viewportSize()!.height - 2);
    for (const h of await me.locator("#pmenu button").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
  });
});

test.describe("the Garmin drawer on a phone", () => {
  test("comes up from the foot as a sheet, with the button that confirms in reach, and nothing sticking out", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-phdr`, [run("Easy", day(0, 1), { workoutId: 5 }), run("Tempo", day(1, 3))]);
    await withGarmin(me, profile.name, { states: ["modified", "not-uploaded"] });
    await openView(me, "plans");
    await expect.poll(() => me.evaluate(() => typeof editor !== "undefined" && !!editor && document.getElementById("new")!.onclick !== null)).toBe(true);
    await me.locator("#filelist .file").filter({ hasText: `${profile.name}-phdr` }).tap();
    await expect(me.locator("#garminBtn")).toBeEnabled();
    await me.locator("#garminBtn").tap();
    const sheet = (await me.locator("#gdrawer").boundingBox())!, view = me.viewportSize()!;
    expect(sheet.width).toBeGreaterThanOrEqual(view.width - 2);
    expect(sheet.y).toBeGreaterThan(0);
    expect(sheet.y + sheet.height).toBeGreaterThanOrEqual(view.height - 2);
    const go = (await me.locator("#gdGo").boundingBox())!;
    expect(go.y + go.height).toBeLessThanOrEqual(view.height);
    expect(go.height).toBeGreaterThanOrEqual(44);
    await expect(me.locator("#gdGo")).toHaveText("Upload and schedule 2 workouts");
    await expect(me.locator("#gdrawer .gact")).toHaveCount(4);
    await expect.poll(() => stickingOut(me)).toEqual([]);
    for (const h of await me.locator("#gdrawer .gact, #gdrawer .dr").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
  });
});
