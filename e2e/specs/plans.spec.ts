/**
 * The Plans view's editor: opening a plan and its outline, the file tools' enabled state, editing and saving, the Checks pane
 * (validation, Validate, Format), the conflict with a change made elsewhere, Reload, and the Garmin buttons for a profile
 * without a Garmin login.
 *
 * Files written by a test carry the profile's name: workout-plans/ is one namespace for every profile, so a bare name would
 * collide with another test's file. alice's plans are read only.
 */
import { test, expect as baseExpect, openView, daysAgo, daysAhead, today } from "../support/fixtures";
import type { APIRequestContext, Page } from "@playwright/test";

// The Monaco editor of the page: the top-level `editor` of the page's own script (window.editor is the #editor element).
declare const editor: any;

// The suite's server is shared, and can be slow when several suites run at once: give each step more time than the default.
const expect = baseExpect.configure({ timeout: 20_000 });
test.describe.configure({ timeout: 120_000 });

const enc = (path: string) => `/api/file?path=${encodeURIComponent(path)}`;

/** A small valid plan with one workout. */
const planJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    { weekStart: "2026-11-02", weekEnd: "2026-11-08", workouts: [{ workoutName: "Easy run", workoutType: "running", distanceMeters: 5000, scheduledDate: "2026-11-03" }], ...extra },
    null,
    2,
  ) + "\n";

/** The same plan with a workoutId on its workout: the Garmin copy of it exists. */
const planWithIds = (extra: Record<string, unknown> = {}) =>
  planJson({ workouts: [{ workoutName: "Easy run", workoutType: "running", distanceMeters: 5000, scheduledDate: "2026-11-03", workoutId: 5511 }], ...extra });

async function makeFile(api: APIRequestContext, path: string, text: string): Promise<void> {
  const res = await api.put(enc(path), { data: { text, create: true } });
  expect(res.status(), `creating ${path}`).toBe(201);
}

async function readFile(api: APIRequestContext, path: string): Promise<{ text: string; version: number }> {
  const res = await api.get(enc(path));
  expect(res.ok(), `reading ${path}`).toBeTruthy();
  const body = await res.json();
  return { text: body.text, version: body.version };
}

async function writeFile(api: APIRequestContext, path: string, text: string): Promise<void> {
  const res = await api.put(enc(path), { data: { text } });
  expect(res.ok(), `saving ${path} elsewhere`).toBeTruthy();
}

/** Open a file from the list by its name, and wait until the page says it is the open file. */
async function openPlan(page: Page, name: string): Promise<void> {
  await page.locator("#filelist .file").filter({ hasText: name }).click();
  await expect(page.locator("#current")).toContainText(name);
}

const textOf = (page: Page) => page.evaluate(() => editor.getValue() as string);
const setText = (page: Page, value: string) => page.evaluate((v) => editor.setValue(v), value);
/** Type at the end of the JSON, with the keyboard, so the editor sees real key presses (and the unsaved mark follows). */
async function typeAtEnd(page: Page, text: string): Promise<void> {
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}

/**
 * Open the Plans view and wait until the editor can act: the toolbar's buttons get their handlers only once Monaco and the
 * workout schema have loaded, which openView does not wait for.
 */
async function openPlans(page: Page): Promise<void> {
  await openView(page, "plans");
  await expect.poll(() => page.evaluate(() => typeof editor !== "undefined" && !!editor && document.getElementById("new")!.onclick !== null)).toBe(true);
}

const GARMIN_REASON = "This profile has no Garmin login: add one in Settings.";

test.describe("Plans: opening a plan", () => {
  test("with nothing open, the file tools are off and the panes say so", async ({ alice }) => {
    await openPlans(alice);
    await expect(alice.locator("#current")).toHaveText("No file open");
    for (const id of ["save", "validate", "format", "fileBtn", "garminBtn"]) await expect(alice.locator(`#${id}`)).toBeDisabled();
    await expect(alice.locator("#outline")).toHaveText("Open a plan.");
    await expect(alice.locator("#problems")).toHaveText("Nothing to report.");
    await expect(alice.locator("#new")).toBeEnabled();
  });

  test("opening a plan turns the file tools on, with Save still off until something changes", async ({ alice }) => {
    await openPlans(alice);
    await openPlan(alice, "alice-run-block.json");
    for (const id of ["validate", "format", "fileBtn"]) await expect(alice.locator(`#${id}`)).toBeEnabled();
    await expect(alice.locator("#save")).toBeDisabled();
    await alice.locator("#fileBtn").click();
    for (const id of ["reload", "history", "dup", "rename", "archive", "delete"]) await expect(alice.locator(`#${id}`)).toBeEnabled();
    await expect(alice.locator("#archive")).toHaveText("Archive");
  });

  test("the open plan's JSON is in the editor, as the server holds it", async ({ alice, admin }) => {
    await openPlans(alice);
    await openPlan(alice, "alice-run-block.json");
    const stored = await admin.get(enc("workout-plans/alice-run-block.json"));
    expect((await stored.json()).text).toBe(await textOf(alice));
    const plan = JSON.parse(await textOf(alice));
    expect(plan.workouts.map((w: { workoutName: string }) => w.workoutName)).toEqual(["Easy run", "Tempo intervals", "Long run", "Full body strength"]);
    expect(plan.workouts.map((w: { workoutType: string }) => w.workoutType)).toEqual(["running", "running", "running", "strength_training"]);
  });

  test("the outline lists the plan's workouts in order, with their scheduled dates", async ({ alice }) => {
    await openPlans(alice);
    await openPlan(alice, "alice-run-block.json");
    const rows = alice.locator("#outline .row.wk");
    await expect(rows).toHaveCount(4);
    await expect(rows.locator(".name")).toHaveText(["Easy run", "Tempo intervals", "Long run", "Full body strength"]);
    await expect(rows.nth(0).locator("small")).toContainText(daysAgo(2));
    await expect(rows.nth(1).locator("small")).toContainText(today());
    await expect(rows.nth(2).locator("small")).toContainText(daysAhead(3));
    await expect(rows.nth(3).locator("small")).toContainText(`${daysAhead(1)}, ${daysAhead(5)}`);
  });

  test("each workout row shows its step count and a small picture of its steps", async ({ alice }) => {
    await openPlans(alice);
    await openPlan(alice, "alice-run-block.json");
    const rows = alice.locator("#outline .row.wk");
    await expect(rows.nth(1).locator("small")).toContainText("3 steps");
    await expect(rows.nth(1).locator(".wv-chart.mini")).toHaveAttribute("aria-label", /^Workout profile: 3 steps, about \d+ min/);
    await expect(rows.nth(3).locator("small")).toContainText("3 steps");
  });

  test("a workout's name opens its picture (steps and totals) and closes it again", async ({ alice }) => {
    await openPlans(alice);
    await openPlan(alice, "alice-run-block.json");
    const tempo = alice.locator("#outline .row.wk").nth(1);
    await expect(tempo.locator(".wv-host")).toHaveCount(0);
    await tempo.locator(".name").click();
    await expect(tempo.locator(".name")).toHaveAttribute("aria-expanded", "true");
    const picture = tempo.locator(".wv-host");
    await expect(picture).toBeVisible();
    await expect(picture).toContainText("Warm up");
    await expect(picture).toContainText("4 times");
    await expect(picture).toContainText("Cool down");
    await expect(picture).toContainText("Est. time");
    await tempo.locator(".name").click();
    await expect(tempo.locator(".name")).toHaveAttribute("aria-expanded", "false");
    await expect(picture).toHaveCount(0);
  });

  test("a strength workout's picture names its exercises, sets and reps", async ({ alice }) => {
    await openPlans(alice);
    await openPlan(alice, "alice-run-block.json");
    const strength = alice.locator("#outline .row.wk").nth(3);
    await strength.locator(".name").click();
    const picture = strength.locator(".wv-host");
    await expect(picture).toContainText("Barbell Back Squat");
    await expect(picture).toContainText("5 reps");
    await expect(picture).toContainText("Barbell Bench Press");
    await expect(picture).toContainText("8 reps");
  });

  test("Edit in JSON puts the editor's cursor on that workout", async ({ alice }) => {
    await openPlans(alice);
    await openPlan(alice, "alice-run-block.json");
    const tempo = alice.locator("#outline .row.wk").nth(1);
    await tempo.locator(".name").click();
    await tempo.getByRole("button", { name: "Edit in JSON" }).click();
    await expect
      .poll(() => alice.evaluate(() => {
        const at = editor.getPosition();
        return at ? editor.getModel().getLineContent(at.lineNumber) : "";
      }))
      .toContain('"workoutName": "Tempo intervals"');
  });

  test("the file title shows the folder and the file name, and the open file's row is highlighted", async ({ alice }) => {
    await openPlans(alice);
    await openPlan(alice, "alice-run-block.json");
    await expect(alice.locator("#current .dir")).toHaveText("workout-plans/");
    await expect(alice.locator("#current b")).toHaveText("alice-run-block.json");
    await expect(alice.locator("#filelist .file.active")).toContainText("alice-run-block.json");
  });
});

test.describe("Plans: editing and saving", () => {
  test("an edit marks the open plan unsaved and turns Save on", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-edit.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-edit.json`);
    await expect(me.locator("#save")).toBeDisabled();
    await typeAtEnd(me, " ");
    await expect(me.locator("#save")).toBeEnabled();
    await expect(me.locator("#save")).toHaveClass(/dirty/);
    expect((await readFile(profile.api, path)).text).toBe(planJson());
  });

  test("Save writes the edit to the database, clears the unsaved mark and bumps the version", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-save.json`;
    await makeFile(profile.api, path, planJson());
    const before = await readFile(profile.api, path);
    await openPlans(me);
    await openPlan(me, `${profile.name}-save.json`);
    await setText(me, planJson({ notes: "after the edit" }));
    await me.locator("#save").click();
    await expect(me.locator("#save")).toBeDisabled();
    await expect(me.locator("#toast")).toHaveText("Saved");
    const after = await readFile(profile.api, path);
    expect(after.text).toBe(planJson({ notes: "after the edit" }));
    expect(after.version).toBeGreaterThan(before.version);
  });

  test("Ctrl+S in the editor saves the plan", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-ctrls.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-ctrls.json`);
    await typeAtEnd(me, " ");
    await expect(me.locator("#save")).toBeEnabled();
    await me.keyboard.press("Control+s");
    await expect(me.locator("#save")).toBeDisabled();
    expect((await readFile(profile.api, path)).text).toBe(await textOf(me));
  });

  test("undoing an edit back to the saved text is no longer an unsaved change", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-undo.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-undo.json`);
    await typeAtEnd(me, " ");
    await expect(me.locator("#save")).toBeEnabled();
    await me.keyboard.press("Control+z");
    await expect(me.locator("#save")).toBeDisabled();
  });

  test("the outline follows the JSON as it changes", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-outline.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-outline.json`);
    await expect(me.locator("#outline .row.wk")).toHaveCount(1);
    await setText(me, planJson({ workouts: [{ workoutName: "Easy run", workoutType: "running", distanceMeters: 5000 }, { workoutName: "Hills", workoutType: "running", distanceMeters: 3000 }] }));
    await expect(me.locator("#outline .row.wk")).toHaveCount(2);
    await expect(me.locator("#outline .row.wk .name")).toHaveText(["Easy run", "Hills"]);
  });

  test("a valid plan says so in Checks, with its workout count, and the badge stays empty", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-valid.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-valid.json`);
    await expect(me.locator("#problems")).toContainText("Valid");
    await expect(me.locator("#problems")).toContainText("1 workouts");
    await expect(me.locator("#badge")).toHaveText("");
  });

  test("a plan with a bad step saves, and the problem is listed in Checks with the count on the badge", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-badstep.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-badstep.json`);
    await setText(me, planJson({ workouts: [{ workoutName: "Broken", workoutType: "running", steps: [{ stepType: "nope", targetType: "no.target" }] }] }));
    await me.locator("#save").click();
    await expect(me.locator("#save")).toBeDisabled();
    await expect(me.locator("#problems .msg.err").first()).toContainText("Invalid stepType 'nope'");
    await expect(me.locator("#badge")).not.toHaveText("");
    expect((await readFile(profile.api, path)).text).toContain("nope");
  });

  test("a bad step and a date that is not YYYY-MM-DD are both counted on the Checks badge", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-twoproblems.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-twoproblems.json`);
    await setText(me, planJson({ workouts: [{ workoutName: "Odd", workoutType: "running", scheduledDate: "tomorrow", steps: [{ stepType: "nope", targetType: "no.target" }] }] }));
    await expect(me.locator("#badge")).toHaveText("2");
    await expect(me.locator("#problems .msg.err")).toContainText("Invalid stepType");
    await expect(me.locator("#problems .msg.warn")).toContainText("is not a valid YYYY-MM-DD date");
  });

  test("invalid JSON in the editor is reported in Checks with a badge", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-badjson.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-badjson.json`);
    await setText(me, '{"workouts": [');
    await expect(me.locator("#badge")).toHaveText("1");
    await expect(me.locator("#problems .msg.err")).toContainText("Not valid JSON");
    await expect(me.locator("#outline")).toHaveText("Not a workout plan.");
  });

  test("Save refuses invalid JSON: the edits stay in the editor and the file is unchanged", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-refuse.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-refuse.json`);
    await setText(me, '{"workouts": [');
    await me.locator("#save").click();
    await expect(me.locator("#toast")).toContainText("Not valid JSON");
    await expect(me.locator("#save")).toBeEnabled();
    expect(await textOf(me)).toBe('{"workouts": [');
    expect((await readFile(profile.api, path)).text).toBe(planJson());
  });

  test("Validate checks the editor's text on demand", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-validate.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-validate.json`);
    await setText(me, planJson({ workouts: [{ workoutName: "Bad", workoutType: "running", steps: [{ stepType: "nope", targetType: "no.target" }] }] }));
    const checked = me.waitForResponse((r) => r.url().endsWith("/api/validate") && r.request().method() === "POST");
    await me.locator("#validate").click();
    expect((await checked).ok()).toBeTruthy();
    await expect(me.locator("#problems .msg.err").first()).toContainText("Invalid stepType");
    await expect(me.locator("#badge")).not.toHaveText("");
  });

  test("Format re-indents the JSON with two spaces", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-format.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-format.json`);
    const compact = { weekStart: "2026-11-02", weekEnd: "2026-11-08", workouts: [{ workoutName: "Compact", workoutType: "running", distanceMeters: 1000 }] };
    await setText(me, JSON.stringify(compact));
    await me.locator("#format").click();
    expect(await textOf(me)).toBe(JSON.stringify(compact, null, 2) + "\n");
    await expect(me.locator("#save")).toBeEnabled();
  });

  test("Format on text that is not JSON says why and leaves the text alone", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-formatbad.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-formatbad.json`);
    await setText(me, '{"workouts": [');
    await me.locator("#format").click();
    await expect(me.locator("#toast")).toContainText("Cannot format");
    expect(await textOf(me)).toBe('{"workouts": [');
  });

  test("Format on a plan that is already formatted changes nothing", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-formatted.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-formatted.json`);
    await me.locator("#format").click();
    expect(await textOf(me)).toBe(planJson());
    await expect(me.locator("#save")).toBeDisabled();
  });
});

test.describe("Plans: a change made elsewhere, and Reload", () => {
  test("saving a plan someone else changed reports the conflict and overwrites nothing", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-conflict.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-conflict.json`);
    await setText(me, planJson({ notes: "mine" }));
    const theirs = planJson({ notes: "theirs" });
    await writeFile(profile.api, path, theirs);
    await me.locator("#save").click();
    await expect(me.locator("#toast")).toContainText("changed since you opened it");
    expect((await readFile(profile.api, path)).text).toBe(theirs);
    expect(await textOf(me)).toContain('"mine"');
    await expect(me.locator("#save")).toBeEnabled();
  });

  test("after a conflict, Reload takes the saved version once the discard is confirmed", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-reloadconflict.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-reloadconflict.json`);
    await setText(me, planJson({ notes: "mine" }));
    const theirs = planJson({ notes: "theirs" });
    await writeFile(profile.api, path, theirs);
    await me.locator("#save").click();
    await expect(me.locator("#toast")).toContainText("changed since you opened it");
    await me.locator("#fileBtn").click();
    await me.locator("#reload").click();
    await expect(me.locator("#dlgTitle")).toHaveText("Discard unsaved changes?");
    await me.locator("#dlgOk").click();
    await expect(me.locator("#dlg")).toBeHidden();
    await expect.poll(() => textOf(me)).toBe(theirs);
    await expect(me.locator("#save")).toBeDisabled();
  });

  test("Cancel on Reload keeps the unsaved edits", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-reloadcancel.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-reloadcancel.json`);
    await setText(me, planJson({ notes: "still here" }));
    await me.locator("#fileBtn").click();
    await me.locator("#reload").click();
    await expect(me.locator("#dlg")).toBeVisible();
    await me.locator("#dlgCancel").click();
    await expect(me.locator("#dlg")).toBeHidden();
    expect(await textOf(me)).toContain("still here");
    await expect(me.locator("#save")).toBeEnabled();
  });

  test("Reload with no edits takes in a change made elsewhere, without asking", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-reloadclean.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-reloadclean.json`);
    const theirs = planJson({ notes: "changed elsewhere" });
    await writeFile(profile.api, path, theirs);
    await me.locator("#fileBtn").click();
    await me.locator("#reload").click();
    await expect.poll(() => textOf(me)).toBe(theirs);
    await expect(me.locator("#dlg")).toBeHidden();
  });
});

test.describe("Plans: the outline's workout buttons", () => {
  test("+ Add workout asks for a name and appends that workout to the plan", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-add.json`, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-add.json`);
    await me.getByRole("button", { name: "+ Add workout" }).click();
    await expect(me.locator("#dlgTitle")).toHaveText("Add a workout");
    await expect(me.locator("#dlgInput")).toHaveValue("New workout");
    await me.locator("#dlgInput").fill("Hill sprints");
    await me.locator("#dlgOk").click();
    await expect(me.locator("#outline .row.wk .name")).toHaveText(["Easy run", "Hill sprints"]);
    expect(JSON.parse(await textOf(me)).workouts.at(-1).workoutName).toBe("Hill sprints");
    await expect(me.locator("#save")).toBeEnabled();
  });

  test("a workout's Duplicate adds a copy named '(copy)', without the workoutId", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-dupw.json`, planWithIds());
    await openPlans(me);
    await openPlan(me, `${profile.name}-dupw.json`);
    await me.locator("#outline .row.wk").first().locator("button[title='Duplicate']").click();
    await expect(me.locator("#outline .row.wk .name")).toHaveText(["Easy run", "Easy run (copy)"]);
    const [original, copy] = JSON.parse(await textOf(me)).workouts;
    expect(original.workoutId).toBe(5511);
    expect(copy.workoutId).toBeUndefined();
  });

  test("Remove from the plan asks first: Cancel keeps the workout, OK takes it out", async ({ me, profile }) => {
    await makeFile(
      profile.api,
      `workout-plans/${profile.name}-rm.json`,
      planJson({ workouts: [{ workoutName: "Easy run", workoutType: "running", distanceMeters: 5000 }, { workoutName: "Hills", workoutType: "running", distanceMeters: 3000 }] }),
    );
    await openPlans(me);
    await openPlan(me, `${profile.name}-rm.json`);
    await me.locator("#outline .row.wk").nth(1).locator("button[title='Remove from the plan']").click();
    await expect(me.locator("#dlgTitle")).toHaveText('Remove "Hills"?');
    await me.locator("#dlgCancel").click();
    await expect(me.locator("#dlg")).toBeHidden();
    await expect(me.locator("#outline .row.wk .name")).toHaveText(["Easy run", "Hills"]);
    await me.locator("#outline .row.wk").nth(1).locator("button[title='Remove from the plan']").click();
    await me.locator("#dlgOk").click();
    await expect(me.locator("#outline .row.wk .name")).toHaveText(["Easy run"]);
    expect(JSON.parse(await textOf(me)).workouts.map((w: { workoutName: string }) => w.workoutName)).toEqual(["Easy run"]);
  });
});

test.describe("Plans: a profile without Garmin", () => {
  test("the Garmin buttons are off for an open plan, and each one says why", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-garmin.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-garmin.json`);
    await expect(me.locator("#garminBtn")).toBeDisabled();
    await expect(me.locator("#garminBtn")).toHaveAttribute("title", GARMIN_REASON);
    for (const id of ["gUpload", "gSchedule", "gBoth", "gSend"]) {
      await expect(me.locator(`#${id}`)).toBeDisabled();
      await expect(me.locator(`#${id}`)).toHaveAttribute("title", GARMIN_REASON);
    }
  });

  test("the Garmin sync bar over the outline stays hidden without a Garmin login", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-syncbar.json`, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-syncbar.json`);
    await expect(me.locator("#outline .row.wk")).toHaveCount(1);
    await expect(me.locator("#syncbar")).toBeHidden();
  });

  test("with nothing open, the Garmin button is still off and gives the same reason", async ({ me }) => {
    await openPlans(me);
    await expect(me.locator("#current")).toHaveText("No file open");
    await expect(me.locator("#garminBtn")).toBeDisabled();
    await expect(me.locator("#garminBtn")).toHaveAttribute("title", GARMIN_REASON);
  });
});
