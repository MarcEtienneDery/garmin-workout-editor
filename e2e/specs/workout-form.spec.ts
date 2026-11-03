/**
 * The workout form of the Plans view: a plan opens on it (its week, its notes, its workouts) with the JSON one tap away, a workout
 * opens in it from the plan's list, the outline or the picker above it, and every change it makes is in the JSON at once (Undo,
 * Save). Strength workouts are exercises with lines of sets (the exercise picker, supersets, sets of their own, reps or a time,
 * a weight in lb or kg, or a percentage of the 1RM); runs and rides are steps and repeats with one target each.
 *
 * Every test makes its own plan for its own profile: workout-plans/ is one namespace, so the file carries the profile's name.
 */
import { test, expect as baseExpect, openView } from "../support/fixtures";
import type { APIRequestContext, Page } from "@playwright/test";

declare const editor: any;

const expect = baseExpect.configure({ timeout: 20_000 });
test.describe.configure({ timeout: 120_000 });

const enc = (path: string) => `/api/file?path=${encodeURIComponent(path)}`;
type Step = Record<string, any>;

const LEGS = {
  workoutName: "Legs", workoutType: "strength_training", scheduledDate: "2026-11-03", sendToDevice: true,
  steps: [
    { stepType: "warmup", targetType: "no.target", endCondition: "lap.button", endConditionValue: 0, stepOrder: 1 },
    { stepType: "interval", targetType: "no.target", endCondition: "reps", endConditionValue: 5, reps: 5, exerciseName: "BARBELL_BACK_SQUAT", weight: 225, restTimeSeconds: 180, numberOfRepeats: 3, repeatGroupIndex: 0, stepOrder: 2 },
    { stepType: "interval", targetType: "no.target", endCondition: "reps", endConditionValue: 8, reps: 8, exerciseName: "BARBELL_BENCH_PRESS", weight: 155, restTimeSeconds: 120, numberOfRepeats: 3, repeatGroupIndex: 1, stepOrder: 3 },
  ],
};
const INTERVALS = {
  workoutName: "Intervals", workoutType: "running", scheduledDate: "2026-11-04",
  steps: [
    { stepType: "warmup", targetType: "no.target", endCondition: "time", endConditionValue: 600, durationSeconds: 600, stepOrder: 1 },
    { stepType: "interval", targetType: "pace.zone", targetValueOne: 3.333, targetValueTwo: 3.448, endCondition: "distance", endConditionValue: 1000, distanceMeters: 1000, numberOfRepeats: 5, repeatGroupIndex: 0, stepOrder: 2 },
    { stepType: "recovery", targetType: "no.target", endCondition: "time", endConditionValue: 120, durationSeconds: 120, numberOfRepeats: 5, repeatGroupIndex: 0, stepOrder: 3 },
    { stepType: "cooldown", targetType: "no.target", endCondition: "lap.button", endConditionValue: 0, stepOrder: 4 },
  ],
};
const planText = (workouts: unknown[] = [LEGS, INTERVALS]) => JSON.stringify({ weekStart: "2026-11-02", weekEnd: "2026-11-08", notes: "Base block", workouts }, null, 2) + "\n";

async function makePlan(api: APIRequestContext, name: string, workouts?: unknown[]): Promise<string> {
  const path = `workout-plans/${name}-form.json`;
  const res = await api.put(enc(path), { data: { text: planText(workouts), create: true } });
  expect(res.status(), `creating ${path}`).toBe(201);
  return path;
}

/** Open the Plans view with the plan open, once the editor can act. */
async function openPlan(page: Page, path: string): Promise<void> {
  await openView(page, "plans");
  await expect.poll(() => page.evaluate(() => typeof editor !== "undefined" && !!editor && document.getElementById("new")!.onclick !== null)).toBe(true);
  await page.locator("#filelist .file").filter({ hasText: path.split("/").pop()! }).click();
  await expect(page.locator("#current")).toContainText(path.split("/").pop()!);
}

const plan = async (page: Page) => JSON.parse(await page.evaluate(() => editor.getValue() as string));
const workout = async (page: Page, i: number) => (await plan(page)).workouts[i];
const stepsOf = async (page: Page, i: number): Promise<Step[]> => (await workout(page, i)).steps;
const form = (page: Page) => page.locator("#pform");
const card = (page: Page, text: string) => form(page).locator(".wf-list > .wf-card").filter({ hasText: text });

/** Open workout `name` of the open plan in the form, from the plan's list. */
async function openWorkout(page: Page, name: string): Promise<void> {
  await form(page).locator(".wf-pw").filter({ hasText: name }).click();
  await expect(form(page).locator(".wf-name")).toHaveValue(name);
}

/** Type into a field of the form and leave it (a field writes when it is left, like a change typed into the JSON). */
async function typeIn(field: ReturnType<Page["locator"]>, value: string): Promise<void> {
  await field.fill(value);
  await field.press("Tab");
}

/** Pick an item of a ⋯ menu. */
async function menuPick(page: Page, menuLabel: string, item: string, scope = form(page)): Promise<void> {
  await scope.getByRole("button", { name: menuLabel, exact: true }).first().click();
  await page.locator(".wf-menu").getByRole("menuitem", { name: item, exact: true }).click();
}

test.describe("The workout form: opening", () => {
  test("a plan opens on the form: its week, its notes and its workouts, the JSON one tap away", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await expect(me.locator("#emode button[data-mode=form]")).toHaveAttribute("aria-pressed", "true");
    await expect(me.locator("#editor")).toBeHidden();
    await expect(form(me).getByLabel("Week from")).toHaveValue("2026-11-02");
    await expect(form(me).getByLabel("to", { exact: true })).toHaveValue("2026-11-08");
    await expect(form(me).getByLabel("Notes", { exact: true })).toHaveValue("Base block");
    await expect(form(me).locator(".wf-pw b")).toHaveText(["Legs", "Intervals"]);

    await me.locator("#emode button[data-mode=json]").click();
    await expect(me.locator("#editor")).toBeVisible();
    await expect(form(me)).toBeHidden();
    expect(await me.evaluate(() => editor.getValue())).toBe(planText());
    await me.locator("#emode button[data-mode=form]").click();
    await expect(form(me).locator(".wf-plan")).toBeVisible();
  });

  test("the choice of the JSON is kept: the next visit opens on it", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await me.locator("#emode button[data-mode=json]").click();
    await me.reload();
    await openPlan(me, path);
    await expect(me.locator("#emode button[data-mode=json]")).toHaveAttribute("aria-pressed", "true");
    await expect(me.locator("#editor")).toBeVisible();
  });

  test("a workout opens in the form from the plan's list, the outline and the picker above the form", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    await expect(me.locator("#ewk")).toHaveValue("0");
    await expect(me.locator("#outline .row.wk.sel .name")).toHaveText("Legs");

    await me.locator("#outline .row.wk .name").filter({ hasText: "Intervals" }).click();
    await expect(form(me).locator(".wf-name")).toHaveValue("Intervals");
    await expect(me.locator("#outline .row.wk.sel .name")).toHaveText("Intervals");

    await me.locator("#ewk").selectOption("plan");
    await expect(form(me).locator(".wf-plan")).toBeVisible();
    await me.locator("#ewk").selectOption("0");
    await expect(form(me).locator(".wf-name")).toHaveValue("Legs");
  });

  test("what is typed in the JSON shows in the form", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    await me.locator("#emode button[data-mode=json]").click();
    await me.evaluate(() => editor.setValue(editor.getValue().replace('"Legs"', '"Lower body"')));
    await me.locator("#emode button[data-mode=form]").click();
    await expect(form(me).locator(".wf-name")).toHaveValue("Lower body");
  });

  test("JSON with a mistake: the form says so and offers the JSON", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await me.locator("#emode button[data-mode=json]").click();
    await me.evaluate(() => editor.setValue("{ oops"));
    await me.locator("#emode button[data-mode=form]").click();
    await expect(form(me)).toContainText("The JSON has a mistake");
    await form(me).getByRole("button", { name: "Show the JSON" }).click();
    await expect(me.locator("#editor")).toBeVisible();
  });

  test("a swim opens on a note and Edit in JSON, which the form does not edit", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name, [{ workoutName: "Laps", workoutType: "swimming", steps: [] }]);
    await openPlan(me, path);
    await form(me).locator(".wf-pw").filter({ hasText: "Laps" }).click();
    await expect(form(me)).toContainText("The form does not edit swim workouts");
    await form(me).getByRole("button", { name: "Edit in JSON" }).click();
    await expect(me.locator("#editor")).toBeVisible();
  });
});

test.describe("The workout form: name, type, days", () => {
  test("a name typed in the form is in the JSON and the outline at once, and Save keeps it", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    await typeIn(form(me).locator(".wf-name"), "Leg day");
    expect((await workout(me, 0)).workoutName).toBe("Leg day");
    await expect(me.locator("#outline .row.wk .name").first()).toHaveText("Leg day");
    await expect(me.locator("#save")).toBeEnabled();
    await me.locator("#save").click();
    await expect(me.locator("#save")).toBeDisabled();
    const saved = JSON.parse((await (await profile.api.get(enc(path))).json()).text);
    expect(saved.workouts[0].workoutName).toBe("Leg day");
    expect(saved.workouts[0].steps).toEqual(LEGS.steps); // the steps were not touched
  });

  test("Undo takes a change of the form back, and Redo makes it again", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    await typeIn(form(me).locator(".wf-name"), "Leg day");
    await me.locator("#eUndo").click();
    await expect(form(me).locator(".wf-name")).toHaveValue("Legs");
    expect((await workout(me, 0)).workoutName).toBe("Legs");
    await me.locator("#eRedo").click();
    await expect(form(me).locator(".wf-name")).toHaveValue("Leg day");
  });

  test("days: one is a date, two are a list, none is no scheduledDate", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    await expect(form(me).getByLabel("Day 1")).toHaveValue("2026-11-03");
    await form(me).getByRole("button", { name: "+ Day" }).click();
    expect((await workout(me, 0)).scheduledDate).toEqual(["2026-11-03", "2026-11-10"]);
    await form(me).getByRole("button", { name: "Not on 2026-11-03" }).click();
    expect((await workout(me, 0)).scheduledDate).toBe("2026-11-10");
    await form(me).getByRole("button", { name: "Not on 2026-11-10" }).click();
    expect((await workout(me, 0)).scheduledDate).toBeUndefined();
    await expect(form(me).getByRole("button", { name: "+ Schedule" })).toBeVisible();
  });

  test("a run made a ride keeps its steps, its paces become speeds, and a cadence is counted in rpm", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Intervals");
    await form(me).getByLabel("Type of workout").selectOption("cycling");
    const steps = await stepsOf(me, 1);
    expect(steps.map((s) => s.targetType)).toEqual(["no.target", "speed.zone", "no.target", "no.target"]);
    expect([steps[1].targetValueOne, steps[1].targetValueTwo]).toEqual([3.333, 3.448]);
    await expect(form(me).getByLabel("Speed from")).toHaveValue("12");
    await expect(form(me).getByLabel("Speed to")).toHaveValue("12.4");
    await form(me).getByLabel("Target").nth(1).selectOption("cadence.zone");
    await expect(form(me).locator(".wf-tgt").nth(1)).toContainText("rpm");
  });

  test("a lifting workout made a run asks first, and starts its steps again as a run's", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    await form(me).getByLabel("Type of workout").selectOption("running");
    await expect(me.locator("#dlgTitle")).toHaveText("Make it a run workout?");
    await me.locator("#dlgOk").click();
    const w = await workout(me, 0);
    expect(w.workoutType).toBe("running");
    expect(w.steps.map((s: Step) => [s.stepType, s.endCondition, s.endConditionValue])).toEqual([["warmup", "time", 600], ["interval", "distance", 5000], ["cooldown", "time", 300]]);
  });
});

test.describe("The workout form: strength", () => {
  test("sets, reps, weight and rest change that exercise's step and nothing else", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    const squat = card(me, "Barbell Back Squat");
    await expect(squat.getByLabel("Sets", { exact: true })).toHaveValue("3");
    await expect(squat.getByLabel("Weight in lb")).toHaveValue("225");
    await expect(squat.getByLabel("Rest", { exact: true })).toHaveValue("3:00");
    await squat.getByRole("button", { name: "Sets: one more" }).click();
    await typeIn(squat.getByLabel("Reps", { exact: true }), "6");
    await typeIn(squat.getByLabel("Weight in lb"), "235");
    await typeIn(squat.getByLabel("Rest", { exact: true }), "2:30");
    const steps = await stepsOf(me, 0);
    expect(steps[1]).toEqual({ ...LEGS.steps[1], numberOfRepeats: 4, endConditionValue: 6, reps: 6, weight: 235, restTimeSeconds: 150 });
    expect(steps[0]).toEqual(LEGS.steps[0]);
    expect(steps[2]).toEqual(LEGS.steps[2]);
  });

  test("one set is a step done once, and three sets again a repeat of its own", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    const squat = card(me, "Barbell Back Squat");
    await typeIn(squat.getByLabel("Sets", { exact: true }), "1");
    let steps = await stepsOf(me, 0);
    expect([steps[1].numberOfRepeats, steps[1].repeatGroupIndex]).toEqual([undefined, undefined]);
    await squat.getByRole("button", { name: "Sets: one more" }).click();
    await squat.getByRole("button", { name: "Sets: one more" }).click();
    steps = await stepsOf(me, 0);
    expect(steps[1].numberOfRepeats).toBe(3);
    expect(steps[1].repeatGroupIndex).not.toBe(steps[2].repeatGroupIndex);
  });

  test("Settings in kg: weights are shown in kg and a weight typed in kg is kept in lb", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openView(me, "settings");
    await me.getByRole("button", { name: "Kilograms (kg)" }).click();
    await expect(me.getByRole("button", { name: "Kilograms (kg)" })).toHaveAttribute("aria-pressed", "true");
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    const squat = card(me, "Barbell Back Squat");
    await expect(squat.getByText("Weight (kg)")).toBeVisible();
    await expect(squat.getByLabel("Weight in kg")).toHaveValue("102.1");
    await typeIn(squat.getByLabel("Weight in kg"), "100");
    expect((await stepsOf(me, 0))[1].weight).toBe(220.46);
    await expect(squat.getByLabel("Weight in kg")).toHaveValue("100");
  });

  test("+ Exercise picks one of Garmin's exercises, found by shorthand, and adds three sets like the last exercise's", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    await form(me).getByRole("button", { name: "+ Exercise" }).click();
    const picker = me.locator("dialog.wf-pick");
    await expect(picker).toBeVisible();
    await expect(picker.locator(".wf-pk-h").first()).toHaveText("In your plans");
    await expect(picker.locator(".wf-pk-row").first()).toContainText("Barbell");
    await picker.getByLabel("Search Garmin's exercises").fill("rdl");
    await expect(picker.locator(".wf-pk-row").first()).toContainText("Romanian Deadlift");
    await picker.getByLabel("Search Garmin's exercises").press("Enter");
    await expect(picker).toBeHidden();
    const added = (await stepsOf(me, 0))[3];
    expect(added).toEqual(expect.objectContaining({ exerciseName: "ROMANIAN_DEADLIFT", endCondition: "reps", endConditionValue: 8, reps: 8, restTimeSeconds: 120, numberOfRepeats: 3, stepOrder: 4 }));
    await expect(card(me, "Romanian Deadlift")).toBeVisible();
  });

  test("an exercise's name opens the picker, and the one picked replaces it", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    await card(me, "Barbell Back Squat").getByRole("button", { name: "Barbell Back Squat", exact: true }).click();
    const picker = me.locator("dialog.wf-pick");
    await picker.getByLabel("Search Garmin's exercises").fill("front squat");
    await picker.locator(".wf-pk-row").filter({ has: me.locator("b", { hasText: /^Barbell Front Squat$/ }) }).click();
    expect((await stepsOf(me, 0))[1]).toEqual({ ...LEGS.steps[1], exerciseName: "BARBELL_FRONT_SQUAT" });
  });

  test("a superset of two exercises, with the rest after the round only, split again into its exercises", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    await menuPick(me, "More for Barbell Back Squat", "Superset with the next exercise");
    let steps = await stepsOf(me, 0);
    expect(steps[1].repeatGroupIndex).toBe(steps[2].repeatGroupIndex);
    expect([steps[1].numberOfRepeats, steps[2].numberOfRepeats]).toEqual([3, 3]);
    expect([steps[1].restTimeSeconds, steps[2].restTimeSeconds]).toEqual([undefined, 120]);
    const superset = card(me, "Superset");
    await expect(superset.getByLabel("Rounds", { exact: true })).toHaveValue("3");
    await expect(superset.getByLabel("Rest after the round")).toHaveValue("2:00");

    await menuPick(me, "More for the superset", "Split into its exercises");
    steps = await stepsOf(me, 0);
    expect(steps[1].repeatGroupIndex).not.toBe(steps[2].repeatGroupIndex);
    await expect(card(me, "Barbell Back Squat")).toBeVisible();
    await expect(card(me, "Barbell Bench Press")).toBeVisible();
  });

  test("a different set is a line of its own; each set its own line, and alike sets one line again", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    const squat = card(me, "Barbell Back Squat");
    await squat.getByRole("button", { name: "+ Different set" }).click();
    await expect(squat.locator(".wf-line")).toHaveCount(2);
    await typeIn(squat.getByLabel("Weight in lb").nth(1), "245");
    let steps = await stepsOf(me, 0);
    expect(steps[2]).toEqual(expect.objectContaining({ exerciseName: "BARBELL_BACK_SQUAT", weight: 245, reps: 5 }));
    expect(steps[2].numberOfRepeats).toBeUndefined();

    await menuPick(me, "More for Barbell Bench Press", "Give each set its own line");
    steps = await stepsOf(me, 0);
    expect(steps.filter((s) => s.exerciseName === "BARBELL_BENCH_PRESS").map((s) => s.numberOfRepeats)).toEqual([undefined, undefined, undefined]);
    await expect(card(me, "Barbell Bench Press").locator(".wf-line")).toHaveCount(3);
    await menuPick(me, "More for Barbell Bench Press", "Make the sets one line");
    steps = await stepsOf(me, 0);
    expect(steps.filter((s) => s.exerciseName === "BARBELL_BENCH_PRESS").map((s) => s.numberOfRepeats)).toEqual([3]);
  });

  test("an exercise deleted says so, and Undo brings it back", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    await menuPick(me, "More for Barbell Back Squat", "Delete");
    expect((await stepsOf(me, 0)).map((s) => s.exerciseName ?? s.stepType)).toEqual(["warmup", "BARBELL_BENCH_PRESS"]);
    await expect(me.locator("#toast")).toContainText("Barbell Back Squat deleted");
    await me.locator("#toast").getByRole("button", { name: "Undo" }).click();
    expect(await stepsOf(me, 0)).toEqual(LEGS.steps);
  });

  test("an exercise timed instead of counted, and loaded as a percentage of its 1RM", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    await menuPick(me, "More for Barbell Back Squat", "Time each set instead");
    let squat = (await stepsOf(me, 0))[1];
    expect([squat.endCondition, squat.endConditionValue, squat.durationSeconds, squat.reps]).toEqual(["time", 60, 60, undefined]);
    await expect(card(me, "Barbell Back Squat").getByLabel("Time", { exact: true })).toHaveValue("1:00");
    await menuPick(me, "More for Barbell Back Squat", "Load as a % of the 1RM");
    squat = (await stepsOf(me, 0))[1];
    expect([squat.weight, squat.weightPercentage, squat.benchmarkKey]).toEqual([undefined, 70, "BARBELL_BACK_SQUAT"]);
    await typeIn(card(me, "Barbell Back Squat").getByLabel("Percent of the one-rep max"), "80");
    expect((await stepsOf(me, 0))[1].weightPercentage).toBe(80);
  });

  test("an exercise that is not Garmin's is flagged on its card", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name, [{ ...LEGS, steps: [{ ...LEGS.steps[1], exerciseName: "BENCH_THING" }] }]);
    await openPlan(me, path);
    await openWorkout(me, "Legs");
    await expect(card(me, "Bench Thing").locator(".msg.err")).toHaveText("BENCH_THING is not one of Garmin's exercises.");
  });
});

test.describe("The workout form: runs and rides", () => {
  test("a pace range is shown and typed fast end first, and kept as speeds, the slower first", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Intervals");
    await expect(form(me).getByLabel("Pace from")).toHaveValue("4:50");
    await expect(form(me).getByLabel("Pace to")).toHaveValue("5:00");
    await typeIn(form(me).getByLabel("Pace from"), "4:40");
    await typeIn(form(me).getByLabel("Pace to"), "455");
    const run = (await stepsOf(me, 1))[1];
    expect([run.targetValueOne, run.targetValueTwo]).toEqual([3.39, 3.571]);
    await expect(form(me).getByLabel("Pace to")).toHaveValue("4:55");
  });

  test("a distance in km or m, a time as m:ss or with its unit, the lap button", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Intervals");
    const rows = form(me).locator(".wf-step");
    await typeIn(rows.nth(1).getByLabel("Distance in km"), "1.2");
    expect((await stepsOf(me, 1))[1]).toEqual(expect.objectContaining({ endCondition: "distance", endConditionValue: 1200, distanceMeters: 1200 }));
    await rows.nth(1).getByLabel("Ends after").selectOption("m");
    await expect(rows.nth(1).getByLabel("Distance in m")).toHaveValue("1200");
    await typeIn(rows.nth(1).getByLabel("Distance in m"), "800");
    expect((await stepsOf(me, 1))[1].distanceMeters).toBe(800);
    await typeIn(rows.nth(2).getByLabel("Time", { exact: true }), "90s");
    expect((await stepsOf(me, 1))[2]).toEqual(expect.objectContaining({ endConditionValue: 90, durationSeconds: 90 }));
    await rows.nth(0).getByLabel("Ends after").selectOption("lap");
    const warm = (await stepsOf(me, 1))[0];
    expect([warm.endCondition, warm.endConditionValue, warm.durationSeconds]).toEqual(["lap.button", 0, undefined]);
  });

  test("a repeat: its times, a step added in it, and its steps done once", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Intervals");
    const repeat = card(me, "Repeat");
    await repeat.getByRole("button", { name: "Times: one more" }).click();
    expect((await stepsOf(me, 1)).map((s) => s.numberOfRepeats)).toEqual([undefined, 6, 6, undefined]);
    await repeat.getByRole("button", { name: "+ Recovery" }).click();
    expect((await stepsOf(me, 1)).map((s) => [s.stepType, s.numberOfRepeats])).toEqual([["warmup", undefined], ["interval", 6], ["recovery", 6], ["recovery", 6], ["cooldown", undefined]]);
    await menuPick(me, "More for the repeat", "Do these steps once");
    expect((await stepsOf(me, 1)).map((s) => s.numberOfRepeats)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  test("ready-made strides go in before the cool-down", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Intervals");
    await form(me).getByLabel("Add a ready-made part").selectOption({ label: "Strides 4 × 20 s" });
    const steps = await stepsOf(me, 1);
    expect(steps.map((s) => s.stepType)).toEqual(["warmup", "interval", "recovery", "interval", "cooldown"]);
    expect(steps[3]).toEqual(expect.objectContaining({ endConditionValue: 20, durationSeconds: 20, numberOfRepeats: 4, restTimeSeconds: 40, stepOrder: 4 }));
    expect(steps[3].repeatGroupIndex).not.toBe(steps[1].repeatGroupIndex);
  });

  test("a step moved up from its menu, and with Alt+↑; the steps are numbered in their new order", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Intervals");
    const cards = form(me).locator(".wf-list > .wf-card"); // (a step's kind list names every kind, so its text does not tell the cards apart)
    await menuPick(me, "More for this step", "Move up", cards.last());
    let steps = await stepsOf(me, 1);
    expect(steps.map((s) => s.stepType)).toEqual(["warmup", "cooldown", "interval", "recovery"]);
    expect(steps.map((s) => s.stepOrder)).toEqual([1, 2, 3, 4]);
    await cards.nth(1).getByLabel("Kind of step").focus();
    await me.keyboard.press("Alt+ArrowUp");
    steps = await stepsOf(me, 1);
    expect(steps.map((s) => s.stepType)).toEqual(["cooldown", "warmup", "interval", "recovery"]);
  });

  test("+ Add workout asks a name and a type: a ride opens in the form with a ride's steps, and aims for a power", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await form(me).getByRole("button", { name: "+ Add workout" }).click();
    await me.locator("#dlgInput").fill("Sweet spot");
    await me.locator("#dlgChoice").selectOption("cycling");
    await me.locator("#dlgOk").click();
    await expect(form(me).locator(".wf-name")).toHaveValue("Sweet spot");
    await expect(form(me).getByLabel("Type of workout")).toHaveValue("cycling");
    const w = await workout(me, 2);
    expect(w.steps.map((s: Step) => [s.stepType, s.endConditionValue])).toEqual([["warmup", 600], ["interval", 2400], ["cooldown", 300]]);
    const ride = form(me).locator(".wf-step").nth(1);
    await expect(ride.getByLabel("Kind of step")).toHaveValue("interval");
    await expect(ride.getByLabel("Kind of step").locator("option:checked")).toHaveText("Ride");
    await ride.getByLabel("Target").selectOption("power.zone");
    await typeIn(ride.getByLabel("Power from"), "200");
    await typeIn(ride.getByLabel("Power to"), "220");
    expect((await workout(me, 2)).steps[1]).toEqual(expect.objectContaining({ targetType: "power.zone", targetValueOne: 200, targetValueTwo: 220 }));
  });
});

test.describe("The workout form: what the estimate says", () => {
  test("the overview says how long the workout takes, and how it was timed behind its ⓘ", async ({ me, profile }) => {
    // the runs come once the form is drawn (as on a slow line): it is drawn again with them
    await me.route("**/api/runs*", async (route) => { await new Promise((done) => setTimeout(done, 800)); await route.continue(); });
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Intervals");
    const summary = form(me).locator(".wf-pic > summary");
    await expect(summary).toContainText("km");
    await summary.getByRole("button", { name: "About the estimate" }).click();
    await expect(form(me).locator(".wf-pic + .help")).toContainText("Steps with no pace target");
    await expect(form(me).locator(".wf-pic")).toHaveAttribute("open", ""); // the ⓘ opens the note, not the box
  });

  test("a workout with no steps says so, and its first step is a tap away", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name, [{ workoutName: "Empty", workoutType: "running", steps: [] }]);
    await openPlan(me, path);
    await openWorkout(me, "Empty");
    await expect(form(me).locator(".wf")).not.toContainText("null");
    await expect(form(me)).toContainText("No steps yet.");
    await form(me).getByRole("button", { name: "+ Step" }).click();
    expect((await workout(me, 0)).steps).toEqual([expect.objectContaining({ stepType: "interval", endCondition: "distance", endConditionValue: 1000 })]);
  });
});

test.describe("The workout form: moving a card, and a step's JSON", () => {
  test("a card dragged by its grip lands where it is let go, and Escape puts one back", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Intervals");
    const cards = form(me).locator(".wf-list > .wf-card");
    // the cards away from the pane's edges, where a drag scrolls the pane: the picture shut, the pane at its top
    await form(me).locator(".wf-pic > summary").click();
    await expect(form(me).locator(".wf-pic")).not.toHaveAttribute("open", "");
    await form(me).evaluate((el) => { el.scrollTop = 0; });
    const drag = async (from: number, to: number, cancel = false) => {
      const a = (await cards.nth(from).locator(".wf-grip").boundingBox())!, b = (await cards.nth(to).boundingBox())!;
      await me.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await me.mouse.down();
      await me.mouse.move(a.x + a.width / 2, b.y + b.height / 4, { steps: 8 });
      await expect(cards.nth(to)).toHaveClass(/wf-drop-before/);
      await expect(cards.nth(from)).toHaveClass(/wf-lifted/);
      if (cancel) await me.keyboard.press("Escape");
      await me.mouse.up();
    };
    await drag(2, 1);
    expect((await stepsOf(me, 1)).map((s) => s.stepType)).toEqual(["warmup", "cooldown", "interval", "recovery"]);
    await drag(1, 0, true);
    await expect(cards.nth(0)).not.toHaveClass(/wf-lifted|wf-drop/);
    expect((await stepsOf(me, 1)).map((s) => s.stepType)).toEqual(["warmup", "cooldown", "interval", "recovery"]);
  });

  test("Edit in JSON in a step's menu opens the JSON on that step", async ({ me, profile }) => {
    const path = await makePlan(profile.api, profile.name);
    await openPlan(me, path);
    await openWorkout(me, "Intervals");
    await menuPick(me, "More for this step", "Edit in JSON", form(me).locator(".wf-list > .wf-card").last());
    await expect(me.locator("#editor")).toBeVisible();
    await expect
      .poll(() => me.evaluate(() => editor.getModel().getLineContent(editor.getPosition().lineNumber) as string))
      .toContain('"stepType": "cooldown"');
  });
});
