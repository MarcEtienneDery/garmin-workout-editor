/**
 * The Garmin drawer of the Plans view: what to do, the checks before it goes, a line for every workout with a tick, and a button that names the
 * action and the count and is the only confirmation. The server has no Garmin login for these profiles, so Garmin is switched on for the
 * page (e2e/support/garmin.ts) and the page's requests for what Garmin knows are answered there; what the page sends is read back.
 */
import { test, expect, openView, mondayOf, daysAhead, today, type Page, type APIRequestContext } from "../support/fixtures";
import { withGarmin, type GarminCalls, type GarminOptions } from "../support/garmin";

test.describe.configure({ timeout: 60_000 });

const run = (name: string, extra: Record<string, unknown> = {}) => ({
  workoutName: name,
  workoutType: "running",
  steps: [{ stepType: "interval", targetType: "no.target", endCondition: "distance", endConditionValue: 5000 }],
  ...extra,
});

/** Four workouts: up to date (id 11), differing (12), gone from Garmin (13) and not uploaded; the states are what Garmin is said to hold. */
const WORKOUTS = () => [
  run("Easy run", { workoutId: 11, scheduledDate: [mondayOf(today()), daysAhead(7)] }),
  run("Intervals", { workoutId: 12, scheduledDate: [daysAhead(2)] }),
  run("Tempo", { workoutId: 13, scheduledDate: [daysAhead(3)], sendToDevice: true }),
  run("Long run", { scheduledDate: [daysAhead(5)] }),
];
const STATES = ["synced", "modified", "missing", "not-uploaded"];

async function makePlan(api: APIRequestContext, name: string, workouts: unknown[]): Promise<string> {
  const path = `workout-plans/${name}.json`;
  const text = JSON.stringify({ weekStart: mondayOf(today()), weekEnd: daysAhead(13), workouts }, null, 2);
  expect((await api.put(`/api/file?path=${encodeURIComponent(path)}`, { data: { text, create: true } })).status()).toBe(201);
  return path;
}

/** The plan open on a page that has Garmin on. */
async function openPlan(page: Page, api: APIRequestContext, profile: string, options: GarminOptions = { states: STATES }, workouts: unknown[] = WORKOUTS()): Promise<{ calls: GarminCalls; name: string }> {
  const name = `${profile}-drawer`;
  await makePlan(api, name, workouts);
  const calls = await withGarmin(page, profile, options);
  await openView(page, "plans");
  await page.locator("#filelist .file").filter({ hasText: name }).click();
  await expect(page.locator("#current")).toContainText(name);
  await expect(page.locator("#garminBtn")).toBeEnabled();
  await expect(page.locator("#outline .row.wk .chip").first()).toHaveText("✓"); // the checks against Garmin have come in
  return { calls, name };
}

const drawer = (page: Page) => page.locator("#gdrawer");
const ticks = (page: Page) => page.locator("#gdRows input[type=checkbox]");
const openDrawer = async (page: Page) => { await page.locator("#garminBtn").click(); await expect(drawer(page)).toBeVisible(); };

test.describe("the drawer", () => {
  test("opens from the Garmin button with the four actions, the checks, a line for each workout and Upload + schedule chosen; Cancel and Escape send nothing", async ({ me, profile }) => {
    const { calls } = await openPlan(me, profile.api, profile.name);
    await openDrawer(me);
    await expect(me.locator("#gdrawer .gact")).toHaveCount(4);
    await expect(me.locator("#gdrawer .gact[aria-pressed=true]")).toHaveText(/Upload \+ schedule/);
    await expect(me.locator("#gdChecks")).toContainText("Valid — 4 workouts");
    await expect(me.locator("#gdRows .dr")).toHaveCount(4);
    await expect(me.locator("#gdrawer")).toContainText("This changes your Garmin account. Nothing is sent until you press the button.");
    await me.locator("#gdCancel").click();
    await expect(drawer(me)).toBeHidden();
    await openDrawer(me);
    await me.keyboard.press("Escape");
    await expect(drawer(me)).toBeHidden();
    expect(calls.actions).toEqual([]);
  });

  test("an upload starts with only what needs it, the chip says how many, and the button names the action and the count", async ({ me, profile }) => {
    await openPlan(me, profile.api, profile.name);
    await openDrawer(me);
    await expect(ticks(me)).toHaveCount(4);
    await expect.poll(() => ticks(me).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked))).toEqual([false, true, true, true]);
    await expect(me.locator("#gdOnly")).toHaveText("Only what needs it (3)");
    await expect(me.locator("#gdOnly")).toHaveAttribute("aria-pressed", "true");
    await expect(me.locator("#gdGo")).toHaveText("Upload and schedule 3 workouts");
    await me.locator("#gUpload").click();
    await expect(me.locator("#gdGo")).toHaveText("Upload 3 workouts");
    await ticks(me).nth(0).check();
    await expect(me.locator("#gdGo")).toHaveText("Upload 4 workouts");
    await expect(me.locator("#gdOnly")).toHaveAttribute("aria-pressed", "false");
    await me.locator("#gdOnly").click();
    await expect(me.locator("#gdGo")).toHaveText("Upload 3 workouts");
    await ticks(me).nth(1).uncheck();
    await expect(me.locator("#gdGo")).toHaveText("Upload 2 workouts");
    await ticks(me).nth(2).uncheck();
    await ticks(me).nth(3).uncheck();
    await expect(me.locator("#gdGo")).toBeDisabled();
    await expect(me.locator("#gdGo")).toHaveText("Upload 0 workouts");
  });

  test("says what happens to each workout, with the difference from Garmin, and that one with an id is deleted and recreated", async ({ me, profile }) => {
    await openPlan(me, profile.api, profile.name);
    await openDrawer(me);
    const rows = me.locator("#gdRows .dr");
    await expect(rows.nth(0)).toContainText("Up to date on Garmin · left alone");
    await expect(rows.nth(1)).toContainText("Replaces the copy on Garmin (id 12): deleted and recreated");
    await expect(rows.nth(1)).toContainText("Step 2: pace 3:55–4:05 in the plan, 4:00–4:10 on Garmin");
    await expect(rows.nth(2)).toContainText("Garmin has no workout 13: created again");
    await expect(rows.nth(3)).toContainText("New on Garmin");
    await expect(me.locator("#gdWarn")).toContainText("deleted and recreated on Garmin; the new ids are written back into the plan file. 2 of the 3 chosen have one.");
    await me.locator("#gdrawer .gdbody").evaluate((el) => (el.scrollTop = 0));
  });

  test("the button is the confirmation: it sends the action with the places chosen, and the answer is shown under This session", async ({ me, profile }) => {
    const { calls } = await openPlan(me, profile.api, profile.name);
    await openDrawer(me);
    await me.locator("#gdGo").click();
    await expect.poll(() => calls.actions.length).toBe(1);
    expect(calls.actions[0]).toMatchObject({ action: "upload_schedule", indexes: [1, 2, 3], confirm: true, profile: profile.name });
    await expect(me.locator("#activity")).toContainText("✓ Upload + schedule");
    await expect(drawer(me)).toBeVisible(); // it stays, to show how it went
  });

  test("with every workout chosen the whole plan is sent (no indexes)", async ({ me, profile }) => {
    const { calls } = await openPlan(me, profile.api, profile.name);
    await openDrawer(me);
    await me.locator("#gUpload").click();
    await ticks(me).nth(0).check();
    await me.locator("#gdGo").click();
    await expect.poll(() => calls.actions.length).toBe(1);
    expect(calls.actions[0]).toMatchObject({ action: "upload", confirm: true });
    expect(calls.actions[0].indexes).toBeUndefined();
  });

  test("Schedule counts the days it puts on the calendar and skips a workout with no id; Send starts with the workouts flagged for the watch", async ({ me, profile }) => {
    const { calls } = await openPlan(me, profile.api, profile.name);
    await openDrawer(me);
    await me.locator("#gSchedule").click();
    await expect(me.locator("#gdGo")).toHaveText("Schedule 4 days");
    await expect(me.locator("#gdRows .dr").nth(3)).toContainText("No workoutId: skipped");
    await me.locator("#gSend").click();
    await expect(me.locator("#gdGo")).toHaveText("Send 1 workout to the watch");
    await expect.poll(() => ticks(me).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked))).toEqual([false, false, true, false]);
    await me.locator("#gdGo").click();
    await expect.poll(() => calls.actions.length).toBe(1);
    expect(calls.actions[0]).toMatchObject({ action: "send", indexes: [2], confirm: true });
  });

  test("an upload is refused while the plan has validation errors, and a schedule is not", async ({ me, profile }) => {
    await openPlan(me, profile.api, profile.name, { states: STATES }, [...WORKOUTS(), { workoutName: "Broken", workoutType: "running", steps: [{ stepType: "interval", endCondition: "distance", endConditionValue: 5000 }] }]);
    await expect(me.locator("#vpill")).toContainText("error");
    await openDrawer(me);
    await me.locator("#gUpload").click();
    await expect(me.locator("#gdChecks")).toContainText("fix them before uploading");
    await expect(me.locator("#gdGo")).toBeDisabled();
    await me.locator("#gSchedule").click();
    await expect(me.locator("#gdGo")).toBeEnabled();
  });

  test("a plan with unsaved changes says so, and the button asks to save first before it sends anything", async ({ me, profile }) => {
    const { calls } = await openPlan(me, profile.api, profile.name);
    await me.evaluate(() => { const d = JSON.parse(editor.getValue()); d.notes = "changed"; editor.setValue(JSON.stringify(d, null, 2)); });
    await expect(me.locator("#save")).toBeEnabled();
    await openDrawer(me);
    await expect(me.locator("#gdChecks")).toContainText("unsaved changes");
    await me.locator("#gdGo").click();
    await expect(me.locator("#dlg")).toBeVisible();
    await expect(me.locator("#dlgTitle")).toHaveText("Save before running on Garmin?");
    await me.locator("#dlgCancel").click();
    expect(calls.actions).toEqual([]);
    await me.locator("#gdGo").click();
    await me.locator("#dlgOk").click();
    await expect.poll(() => calls.actions.length).toBe(1);
    await expect(me.locator("#save")).toBeDisabled();
  });

  test("a failed action says why under This session, and the workouts are still listed", async ({ me, profile }) => {
    const { calls } = await openPlan(me, profile.api, profile.name, { states: STATES, action: { status: 502 } });
    await openDrawer(me);
    await me.locator("#gdGo").click();
    await expect.poll(() => calls.actions.length).toBe(1);
    await expect(me.locator("#activity")).toContainText("✗ Upload + schedule failed");
    await expect(me.locator("#activity")).toContainText("Garmin said no");
    await expect(me.locator("#gdRows .dr")).toHaveCount(4);
    await expect(me.locator("#gdGo")).toBeEnabled();
  });

  test("a plan's ⋯ menu in the list has Put on Garmin…, which opens the drawer for that plan", async ({ me, profile }) => {
    const { name } = await openPlan(me, profile.api, profile.name);
    await me.locator("#filelist .file").filter({ hasText: name }).locator("button.more").click();
    await me.locator("#pmenu").getByRole("menuitem", { name: /Put on Garmin/ }).click();
    await expect(drawer(me)).toBeVisible();
    await expect(me.locator("#gdTitle")).toContainText("Garmin");
  });

  test("a profile without Garmin has the button disabled, with the reason", async ({ me, profile }) => {
    await makePlan(profile.api, `${profile.name}-nogarmin`, WORKOUTS());
    await openView(me, "plans");
    await me.locator("#filelist .file").filter({ hasText: `${profile.name}-nogarmin` }).click();
    await expect(me.locator("#garminBtn")).toBeDisabled();
    await expect(me.locator("#garminBtn")).toHaveAttribute("title", /no Garmin login/);
    await me.locator("#filelist .file").filter({ hasText: `${profile.name}-nogarmin` }).locator("button.more").click();
    await expect(me.locator("#pmenu").getByRole("menuitem", { name: /Put on Garmin/ })).toHaveCount(0);
  });
});
