/**
 * The workout form on a phone: a workout tapped in the outline opens in the form on the Editor tab, the JSON is one tap away, a set
 * line is two columns of fields a thumb can use (16 px, so the phone does not zoom in), a ⋯ menu is a sheet at the foot of the screen
 * and the exercise picker fills the screen. Nothing sticks out past the screen's width.
 */
import { test, expect as baseExpect, openView, type Page, type Profile } from "../support/fixtures";

declare const editor: any;

const expect = baseExpect.configure({ timeout: 20_000 });
test.setTimeout(90_000);

const LEGS = {
  workoutName: "Legs", workoutType: "strength_training", scheduledDate: "2026-11-03",
  steps: [
    { stepType: "warmup", targetType: "no.target", endCondition: "lap.button", endConditionValue: 0, stepOrder: 1 },
    { stepType: "interval", targetType: "no.target", endCondition: "reps", endConditionValue: 5, reps: 5, exerciseName: "BARBELL_BACK_SQUAT", weight: 225, restTimeSeconds: 180, numberOfRepeats: 3, repeatGroupIndex: 0, stepOrder: 2 },
  ],
};
const RUN = {
  workoutName: "Intervals", workoutType: "running",
  steps: [
    { stepType: "warmup", targetType: "no.target", endCondition: "time", endConditionValue: 600, durationSeconds: 600, stepOrder: 1 },
    { stepType: "interval", targetType: "pace.zone", targetValueOne: 3.333, targetValueTwo: 3.448, endCondition: "distance", endConditionValue: 1000, distanceMeters: 1000, numberOfRepeats: 5, repeatGroupIndex: 0, stepOrder: 2 },
    { stepType: "recovery", targetType: "no.target", endCondition: "time", endConditionValue: 120, durationSeconds: 120, numberOfRepeats: 5, repeatGroupIndex: 0, stepOrder: 3 },
  ],
};

/** Four exercises, so a set line can be scrolled up to the top of the pane, and notes of two lines (their box grows to them once drawn). */
const PULL = {
  workoutName: "Pull", workoutType: "strength_training", description: "Heavy and short.\nStop each set with two reps in the tank.",
  steps: ["BARBELL_DEADLIFT", "BENT_OVER_ROW_WITH_BARBELL", "PULL_UP", "BARBELL_SHOULDER_PRESS"].map((exerciseName, i) => (
    { stepType: "interval", targetType: "no.target", endCondition: "reps", endConditionValue: 8, reps: 8, exerciseName, weight: 95, restTimeSeconds: 90, numberOfRepeats: 3, repeatGroupIndex: i, stepOrder: i + 1 }
  )),
};

async function openPlan(page: Page, profile: Profile): Promise<void> {
  const path = `workout-plans/${profile.name}-form.json`;
  const made = await profile.api.put(`/api/file?path=${encodeURIComponent(path)}`, { data: { text: JSON.stringify({ weekStart: "2026-11-02", weekEnd: "2026-11-08", workouts: [LEGS, RUN, PULL] }, null, 2), create: true } });
  expect(made.status()).toBe(201);
  const wired = page.waitForResponse((r) => r.url().includes("/api/schema") && r.ok());
  await openView(page, "plans");
  await wired;
  await page.locator("#filelist .file", { hasText: path.split("/").pop()! }).tap();
  await expect(page.locator("#current")).toContainText(path.split("/").pop()!);
}

/** Tap a workout in the Outline tab: it opens in the form, on the Editor tab. */
async function openWorkout(page: Page, name: string): Promise<void> {
  await page.locator(`#tabbar button[data-tab="outline"]`).tap();
  await page.locator("#outline .row.wk .name", { hasText: name }).tap();
  await expect(page.locator("body")).toHaveAttribute("data-tab", "editor");
  await expect(page.locator("#pform .wf-name")).toHaveValue(name);
}

const workoutOf = async (page: Page, i: number) => JSON.parse(await page.evaluate(() => editor.getValue() as string)).workouts[i];

test("a plan opens on its outline, and a workout tapped there opens in the form on the Editor tab", async ({ me, profile }) => {
  await openPlan(me, profile);
  await expect(me.locator("body")).toHaveAttribute("data-tab", "outline");
  await openWorkout(me, "Legs");
  await expect(me.locator("#tabbar button[data-tab=editor]")).toHaveAttribute("aria-selected", "true");
  await expect(me.locator("#editor")).toBeHidden();
  await me.locator("#emode button[data-mode=json]").tap();
  await expect(me.locator("#editor .monaco-editor").first()).toBeVisible();
  await me.locator("#emode button[data-mode=form]").tap();
  await expect(me.locator("#pform .wf-name")).toHaveValue("Legs");
});

test("a set line is two columns, its steppers work with a finger, and its fields do not make the phone zoom", async ({ me, profile }) => {
  await openPlan(me, profile);
  await openWorkout(me, "Legs");
  const line = me.locator("#pform .wf-line").first();
  const columns = await line.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  expect(columns).toBe(2);
  await line.getByRole("button", { name: "Sets: one more" }).tap();
  expect((await workoutOf(me, 0)).steps[1].numberOfRepeats).toBe(4);
  const sizes = await me.locator("#pform").locator("input:not([type=checkbox]), select, textarea").evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16);
  const box = await line.getByRole("button", { name: "Sets: one more" }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(40);
  expect(box!.width).toBeGreaterThanOrEqual(40);
});

test("a step's ⋯ menu is a sheet at the foot of the screen", async ({ me, profile }) => {
  await openPlan(me, profile);
  await openWorkout(me, "Intervals");
  await me.locator("#pform").getByRole("button", { name: "More for this step" }).first().tap();
  const menu = me.locator(".wf-menu");
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!, view = me.viewportSize()!;
  expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(view.height - 2);
  expect(Math.round(box.width)).toBeGreaterThanOrEqual(view.width - 2);
  await menu.getByRole("menuitem", { name: "Add a rest after it" }).tap();
  expect((await workoutOf(me, 1)).steps[0].restTimeSeconds).toBe(60);
});

test("the exercise picker fills the screen, and the exercise tapped is added", async ({ me, profile }) => {
  await openPlan(me, profile);
  await openWorkout(me, "Legs");
  await me.locator("#pform").getByRole("button", { name: "+ Exercise" }).tap();
  const picker = me.locator("dialog.wf-pick");
  await expect(picker).toBeVisible();
  const box = (await picker.boundingBox())!, view = me.viewportSize()!;
  expect(Math.round(box.width)).toBe(view.width);
  await picker.getByLabel("Search Garmin's exercises").fill("hip thrust");
  await picker.locator(".wf-pk-row").first().tap();
  await expect(picker).toBeHidden();
  expect((await workoutOf(me, 0)).steps[2].exerciseName).toMatch(/HIP_THRUST/);
});

test("nothing in the form sticks out past the screen's width", async ({ me, profile }) => {
  await openPlan(me, profile);
  for (const name of ["Legs", "Intervals"]) {
    await openWorkout(me, name);
    const wide = await me.evaluate(() => {
      const width = document.documentElement.clientWidth;
      return [...document.querySelectorAll("#pform *")].filter((el) => el.getBoundingClientRect().right > width + 0.5 && getComputedStyle(el).display !== "none").map((el) => el.className || el.tagName).slice(0, 5);
    });
    expect(wide, name).toEqual([]);
  }
});

test("the form stays where it was scrolled to when a change draws it again", async ({ me, profile }) => {
  await openPlan(me, profile);
  await openWorkout(me, "Legs");
  await me.locator("#pform .wf-pic > summary").tap(); // the muscles it works: the form is then taller than the screen
  await expect(me.locator("#pform .wf-pic .wvbox")).toBeVisible();
  const pane = me.locator("#pform");
  await pane.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const before = await pane.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(100);
  await me.locator("#pform .wf-add").getByRole("button", { name: "+ Rest" }).tap();
  await expect.poll(async () => (await workoutOf(me, 0)).steps.length).toBe(3);
  await expect(me.locator("#pform .wf-list > .wf-card")).toHaveCount(3);
  expect(await pane.evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(before - 2);
});

test("a button tapped near the top of the pane stays under the finger when the form draws again", async ({ me, profile }) => {
  await openPlan(me, profile);
  await openWorkout(me, "Pull");
  const pane = me.locator("#pform");
  const plus = me.locator("#pform .wf-line").nth(1).getByRole("button", { name: "Sets: one more" });
  // the button just under the top of the pane: the browser's scroll anchoring once moved it up by the notes box's second line
  await plus.evaluate((el) => { const box = el.closest("#pform")!; box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12; });
  const top = await pane.evaluate((el) => el.getBoundingClientRect().top);
  const at = (await plus.boundingBox())!.y;
  expect(Math.abs(at - top - 12)).toBeLessThan(2);
  await plus.tap();
  await expect.poll(async () => (await workoutOf(me, 2)).steps[1].numberOfRepeats).toBe(4);
  await expect(me.locator("#pform .wf-line").nth(1).getByLabel("Sets", { exact: true })).toHaveValue("4");
  expect(Math.abs((await plus.boundingBox())!.y - at)).toBeLessThan(2);
});
