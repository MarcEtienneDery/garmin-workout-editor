/**
 * The Workouts view in mock mode (MOCK_MODE=true, port 8793).
 *
 * What the app really does here: the Garmin library is never listed. The page knows Garmin is refused and asks for nothing, so
 * the list stays empty under the note "Mock mode: Garmin writes are disabled.". With no row there is nothing to select, so Edit and
 * Delete cannot be reached from the page; the New dialog is the one path that works, and it writes to a plan file only, never to
 * Garmin. The server's refusals are checked through the API. The generated mock library (src/mocks.setup.ts) is what the MCP tools
 * answer with; the web editor does not list it: the README says the Garmin buttons stay disabled in mock mode.
 */
import { test as base, expect, loginAs, openView, mondayOf, daysAhead, today, type Profile } from "../../support/fixtures";
import { type APIRequestContext, type Page, type Response } from "@playwright/test";

const REFUSAL = "Mock mode: Garmin writes are disabled.";
const GARMIN_PASSWORD = "garmin-password";

/**
 * The server closes an idle keep-alive connection a moment before the client reuses it, and that request meets ECONNRESET before
 * the server reads it: the request is sent again (it was never processed, so nothing is written twice).
 */
async function sent<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= 4 || !/ECONNRESET/.test(String(error))) throw error;
    }
  }
}

/** An API client whose requests are sent again when the connection was reset (see `sent`). */
function reliable<A extends APIRequestContext>(api: A): A {
  return new Proxy(api, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "get" || prop === "post" || prop === "put" || prop === "delete") {
        return (...args: unknown[]) => sent(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * A fresh profile with a Garmin login saved, signed in on a page of its own. Mock mode accepts any Garmin login and never checks it.
 * Traces are off in this file: with them on, the API contexts of the shared fixtures lose their recordings at teardown.
 */
const test = base.extend<{ garmin: Profile; gme: Page }>({
  admin: async ({ admin }, use) => use(reliable(admin)),
  profile: async ({ profile }, use) => use({ ...profile, api: reliable(profile.api) }),
  garmin: async ({ profile }, use) => {
    const res = await profile.api.post("/api/settings/garmin", { data: { action: "save", email: `${profile.name}@example.com`, password: GARMIN_PASSWORD } });
    if (!res.ok()) throw new Error(`Could not save the Garmin login: ${res.status()} ${await res.text()}`);
    await use(profile);
  },
  gme: async ({ page, garmin }, use) => {
    await loginAs(page, garmin.name, garmin.password);
    await use(page);
  },
});
test.use({ trace: "off" });

const planWorkout = (name: string, extra: Record<string, unknown> = {}) => ({
  workoutName: name,
  workoutType: "running",
  steps: [{ stepType: "interval", targetType: "no.target", endCondition: "time", endConditionValue: 600 }],
  ...extra,
});

/** A plan file of the profile (its path is unique to the test). Returns the version the server gave it. */
async function putPlan(api: APIRequestContext, path: string, workouts: unknown[]): Promise<number> {
  const body = { weekStart: mondayOf(today()), weekEnd: daysAhead(6), workouts };
  const res = await api.put(`/api/file?path=${encodeURIComponent(path)}`, { data: { text: JSON.stringify(body, null, 2), create: true } });
  expect(res.status()).toBe(201);
  return (await res.json()).version;
}

async function readPlan(api: APIRequestContext, path: string): Promise<{ version: number; data: any }> {
  const res = await api.get(`/api/file?path=${encodeURIComponent(path)}`);
  expect(res.ok()).toBeTruthy();
  const doc = await res.json();
  return { version: doc.version, data: JSON.parse(doc.text) };
}

/** Errors the page raises: uncaught exceptions, and console errors other than the 409s the refusals answer with. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 409/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

/** Monaco loads after the page; the dialog needs it. */
async function waitForEditor(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => typeof monaco !== "undefined" && !!monaco)).toBe(true);
}

/**
 * Replace the text of the dialog's editor. Select-all in Monaco under the test browser leaves its last character behind, so the
 * text is set through the editor itself; the page reacts to it as to typing.
 */
async function typeInDialog(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => dlgEditor.setValue(value), text);
}

/**
 * Open the New dialog. The dialog checks its template twice when it opens (at once, and again once the editor has been quiet for
 * half a second). Both checks are waited for, so one that is still pending cannot clear a message a test is about to look for.
 */
async function openNewDialog(page: Page): Promise<void> {
  await waitForEditor(page);
  let checks = 0;
  const count = (r: Response) => {
    if (r.url().endsWith("/api/validate")) checks++;
  };
  page.on("response", count);
  await page.locator("#wNew").click();
  await expect(page.locator("#wdlg")).toBeVisible();
  await expect.poll(() => checks).toBeGreaterThanOrEqual(2);
  page.off("response", count);
  await expect(page.locator("#wdProblems")).toBeEmpty();
}

test.describe("Workouts view: the list in mock mode", () => {
  test("the view opens and says that Garmin writes are disabled", async ({ gme }) => {
    const errors = watchErrors(gme);
    await openView(gme, "workouts");
    await expect(gme.locator("#wview")).toBeVisible();
    await expect(gme.locator("#wNote")).toBeVisible();
    await expect(gme.locator("#wNote")).toHaveText(REFUSAL);
    expect(errors).toEqual([]);
  });

  test("the list holds no workouts, because the library is refused", async ({ gme }) => {
    await openView(gme, "workouts");
    await expect(gme.locator("#wNote")).toHaveText(REFUSAL);
    await expect(gme.locator("#wrows .wrow")).toHaveCount(0);
    await expect(gme.locator("#wCount")).toBeEmpty();
  });

  test("the detail pane starts empty: Edit and Delete are disabled", async ({ gme }) => {
    await openView(gme, "workouts");
    await expect(gme.locator("#wTitle")).toHaveText("Workout");
    await expect(gme.locator("#wbody")).toHaveText("Select a workout.");
    await expect(gme.locator("#wEdit")).toBeDisabled();
    await expect(gme.locator("#wDelete")).toBeDisabled();
  });

  test("the Garmin profile picker stays hidden for a profile login", async ({ gme }) => {
    await openView(gme, "workouts");
    await expect(gme.locator("#wNote")).toHaveText(REFUSAL);
    await expect(gme.locator("#wProfile")).toBeHidden();
  });

  test("the filter bar, the type chips and Clear stay hidden while there is no list to filter", async ({ gme }) => {
    await openView(gme, "workouts");
    await expect(gme.locator("#wNote")).toHaveText(REFUSAL);
    await expect(gme.locator("#wFilters")).toBeHidden();
    await expect(gme.locator("#wChips")).toBeHidden();
    await expect(gme.locator("#wClear")).toBeHidden();
  });

  test("the filter box keeps what is typed and the refusal stays", async ({ gme }) => {
    const errors = watchErrors(gme);
    await openView(gme, "workouts");
    await expect(gme.locator("#wNote")).toHaveText(REFUSAL);
    await gme.locator("#wFilter").fill("tempo");
    await expect(gme.locator("#wFilter")).toHaveValue("tempo");
    await expect(gme.locator("#wNote")).toHaveText(REFUSAL);
    await expect(gme.locator("#wrows .wrow")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("the refresh button keeps the refusal and asks Garmin for nothing", async ({ gme }) => {
    const calls: string[] = [];
    gme.on("request", (r) => {
      if (r.url().includes("/api/")) calls.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await openView(gme, "workouts");
    await expect(gme.locator("#wNote")).toHaveText(REFUSAL);
    await gme.locator("#wRefresh").click();
    await expect(gme.locator("#wNote")).toHaveText(REFUSAL);
    // the New button is a later click the page answers: the refresh has been handled by then
    await openNewDialog(gme);
    expect(calls.filter((c) => c.includes("/api/workouts") || c.includes("/api/garmin/"))).toEqual([]);
  });

  test("opening the view makes no Garmin request at all: the page already knows Garmin is refused", async ({ gme }) => {
    const calls: string[] = [];
    gme.on("request", (r) => {
      if (r.url().includes("/api/")) calls.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await openView(gme, "workouts");
    await expect(gme.locator("#wNote")).toHaveText(REFUSAL);
    await openNewDialog(gme);
    expect(calls.filter((c) => c.includes("/api/workouts") || c.includes("/api/garmin/") || c.includes("/api/activities/sync"))).toEqual([]);
  });

  test("the view is the same after leaving it and coming back", async ({ gme }) => {
    await openView(gme, "workouts");
    await expect(gme.locator("#wNote")).toHaveText(REFUSAL);
    await gme.locator("#vPlans").click();
    await expect(gme.locator("body")).toHaveAttribute("data-view", "plans");
    await gme.locator("#vWorkouts").click();
    await expect(gme.locator("body")).toHaveAttribute("data-view", "workouts");
    await expect(gme.locator("#wNote")).toHaveText(REFUSAL);
    await expect(gme.locator("#wrows .wrow")).toHaveCount(0);
  });

  test("the empty list does not say 'No workouts.' next to the refusal: none were asked for", async ({ gme }) => {
    await openView(gme, "workouts");
    await expect(gme.locator("#wNote")).toHaveText(REFUSAL);
    await expect(gme.locator("#wrows")).not.toContainText("No workouts.");
  });
});

test.describe("Workouts view: the New dialog in mock mode", () => {
  test("+ New opens the workout dialog titled New workout", async ({ gme }) => {
    await openView(gme, "workouts");
    await openNewDialog(gme);
    await expect(gme.locator("#wdTitle")).toHaveText("New workout");
    await expect(gme.locator("#wdPlanRow")).toBeVisible();
  });

  test("the editor starts from a template named New workout", async ({ gme }) => {
    await openView(gme, "workouts");
    await openNewDialog(gme);
    await expect(gme.locator("#wdEditor .view-lines")).toContainText('"workoutName": "New workout"');
    await expect(gme.locator("#wdEditor .view-lines")).toContainText("BARBELL_BENCH_PRESS");
  });

  test("the plan list offers Garmin only first, then the plans of the profile", async ({ gme, garmin }) => {
    const path = `workout-plans/${garmin.name}-listed.json`;
    await putPlan(garmin.api, path, [planWorkout("Listed run")]);
    await openView(gme, "workouts");
    await openNewDialog(gme);
    await expect(gme.locator("#wdPlan option").first()).toHaveText("(none — Garmin only)");
    await expect(gme.locator("#wdPlan option", { hasText: path })).toHaveCount(1);
    await expect(gme.locator("#wdPlan")).toHaveValue("");
  });

  test("the Apply to Garmin box is unticked and cannot be ticked in mock mode", async ({ gme }) => {
    await openView(gme, "workouts");
    await openNewDialog(gme);
    await expect(gme.locator("#wdUploadLabel")).toHaveText("Upload to Garmin");
    await expect(gme.locator("#wdUpload")).not.toBeChecked();
    await expect(gme.locator("#wdUpload")).toBeDisabled();
    await expect(gme.locator("#wdScheduleRow")).toBeHidden();
  });

  test("Save with no plan chosen is refused in the dialog, which stays open", async ({ gme }) => {
    await openView(gme, "workouts");
    await openNewDialog(gme);
    await gme.locator("#wdSave").click();
    await expect(gme.locator("#wdProblems")).toHaveText("Choose a plan to add it to, or upload it to Garmin.");
    await expect(gme.locator("#wdlg")).toBeVisible();
  });

  test("Save into a plan adds the workout to that plan and sends nothing to Garmin", async ({ gme, garmin }) => {
    const path = `workout-plans/${garmin.name}-target.json`;
    const version = await putPlan(garmin.api, path, [planWorkout("Already here")]);
    await openView(gme, "workouts");
    await openNewDialog(gme);
    await gme.locator("#wdPlan").selectOption(path);
    const [request] = await Promise.all([
      gme.waitForRequest((r) => r.url().includes("/api/garmin/workout") && r.method() === "POST"),
      gme.locator("#wdSave").click(),
    ]);
    expect(request.postDataJSON()).toMatchObject({ planPath: path, upload: false });
    await expect(gme.locator("#wdlg")).toBeHidden();
    await expect(gme.locator("#toast")).toHaveText("Saved to the plan");
    const after = await readPlan(garmin.api, path);
    expect(after.version).toBeGreaterThan(version);
    expect(after.data.workouts.map((w: any) => w.workoutName)).toEqual(["Already here", "New workout"]);
    expect(after.data.workouts[1].workoutId).toBeUndefined();
  });

  test("Cancel closes the dialog and leaves the plan as it was", async ({ gme, garmin }) => {
    const path = `workout-plans/${garmin.name}-cancel.json`;
    const version = await putPlan(garmin.api, path, [planWorkout("Keep me")]);
    await openView(gme, "workouts");
    await openNewDialog(gme);
    await gme.locator("#wdPlan").selectOption(path);
    await gme.locator("#wdCancel").click();
    await expect(gme.locator("#wdlg")).toBeHidden();
    expect((await readPlan(garmin.api, path)).version).toBe(version);
  });

  test("the close button (✕) closes the dialog without saving", async ({ gme }) => {
    await openView(gme, "workouts");
    await openNewDialog(gme);
    await gme.locator("#wdClose").click();
    await expect(gme.locator("#wdlg")).toBeHidden();
  });

  test("Escape closes the dialog", async ({ gme }) => {
    await openView(gme, "workouts");
    await openNewDialog(gme);
    await gme.keyboard.press("Escape");
    await expect(gme.locator("#wdlg")).toBeHidden();
  });

  test("text that is not JSON is named under the editor, and Save sends nothing", async ({ gme }) => {
    await openView(gme, "workouts");
    await openNewDialog(gme);
    const posts: string[] = [];
    gme.on("request", (r) => {
      if (r.url().includes("/api/garmin/workout") && r.method() === "POST") posts.push(r.url());
    });
    await typeInDialog(gme, "{ not json");
    await expect(gme.locator("#wdProblems")).toContainText("Not valid JSON");
    await gme.locator("#wdSave").click();
    await expect(gme.locator("#wdProblems")).toContainText("Not valid JSON");
    await expect(gme.locator("#wdlg")).toBeVisible();
    expect(posts).toEqual([]);
  });

  test("a step type that does not exist is flagged as the workout is edited", async ({ gme }) => {
    await openView(gme, "workouts");
    await openNewDialog(gme);
    await typeInDialog(gme, JSON.stringify({ workoutName: "Bad", workoutType: "running", steps: [{ stepType: "bogus", targetType: "no.target", endCondition: "time", endConditionValue: 60 }] }));
    await expect(gme.locator("#wdProblems")).toContainText("Invalid stepType 'bogus'");
  });

  test("the flag goes once the workout is valid again", async ({ gme }) => {
    await openView(gme, "workouts");
    await openNewDialog(gme);
    await typeInDialog(gme, JSON.stringify({ workoutName: "Bad", workoutType: "running", steps: [{ stepType: "bogus", targetType: "no.target", endCondition: "time", endConditionValue: 60 }] }));
    await expect(gme.locator("#wdProblems")).toContainText("Invalid stepType 'bogus'");
    await typeInDialog(gme, JSON.stringify({ workoutName: "Good", workoutType: "running", steps: [{ stepType: "interval", targetType: "no.target", endCondition: "time", endConditionValue: 60 }] }));
    await expect(gme.locator("#wdProblems")).toBeEmpty();
  });

  test("Ctrl+S in the editor saves like the Save button", async ({ gme }) => {
    await openView(gme, "workouts");
    await openNewDialog(gme);
    await gme.locator("#wdEditor .view-lines").click();
    await gme.keyboard.press("ControlOrMeta+s");
    await expect(gme.locator("#wdProblems")).toHaveText("Choose a plan to add it to, or upload it to Garmin.");
  });

  test("the plan the Plans view has open is the one the New dialog offers first", async ({ gme, garmin }) => {
    const path = `workout-plans/${garmin.name}-open.json`;
    await putPlan(garmin.api, path, [planWorkout("Open one")]);
    await openView(gme, "plans");
    await gme.locator("#filelist .file", { hasText: `${garmin.name}-open` }).click();
    await expect(gme.locator("#current")).toContainText(`${garmin.name}-open`);
    await gme.locator("#vWorkouts").click();
    await expect(gme.locator("body")).toHaveAttribute("data-view", "workouts");
    await openNewDialog(gme);
    await expect(gme.locator("#wdPlan")).toHaveValue(path);
  });

  test("an archived plan is not offered in the New dialog", async ({ gme, garmin }) => {
    const archived = `workout-plans/${garmin.name}-shelved.json`;
    const active = `workout-plans/${garmin.name}-active.json`;
    const version = await putPlan(garmin.api, archived, [planWorkout("Shelved")]);
    await putPlan(garmin.api, active, [planWorkout("Active")]);
    const res = await garmin.api.post("/api/plans/archive", { data: { path: archived, version, confirm: true } });
    expect(res.ok()).toBeTruthy();
    await openView(gme, "workouts");
    await openNewDialog(gme);
    await expect(gme.locator("#wdPlan option", { hasText: active })).toHaveCount(1);
    await expect(gme.locator("#wdPlan option", { hasText: archived })).toHaveCount(0);
  });
});

test.describe("Workouts API in mock mode: the refusals behind the view", () => {
  test("GET /api/workouts answers 409 with the mock reason", async ({ garmin }) => {
    const res = await garmin.api.get(`/api/workouts?profile=${garmin.name}`);
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe(REFUSAL);
  });

  test("a refresh of the library is refused the same way", async ({ garmin }) => {
    const res = await garmin.api.get(`/api/workouts?profile=${garmin.name}&refresh=1`);
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe(REFUSAL);
  });

  test("the Garmin workout detail is refused with the mock reason", async ({ garmin }) => {
    const res = await garmin.api.get(`/api/garmin/workout?id=mock-workout-1&profile=${garmin.name}`);
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe(REFUSAL);
  });

  test("an upload from the dialog is refused by the server, and the plan is not touched", async ({ garmin }) => {
    const path = `workout-plans/${garmin.name}-upload.json`;
    const version = await putPlan(garmin.api, path, [planWorkout("Upload me")]);
    const res = await garmin.api.post("/api/garmin/workout", {
      data: { workout: planWorkout("Upload me"), planPath: path, version, upload: true, schedule: false, profile: garmin.name, confirm: true },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe(REFUSAL);
    const after = await readPlan(garmin.api, path);
    expect(after.version).toBe(version);
    expect(after.data.workouts).toHaveLength(1);
  });

  test("a Garmin copy replaced from an edited workout is refused, and the plan keeps its id", async ({ garmin }) => {
    const path = `workout-plans/${garmin.name}-replace.json`;
    const version = await putPlan(garmin.api, path, [planWorkout("Linked", { workoutId: 4242 })]);
    const res = await garmin.api.put("/api/garmin/workout", {
      data: { workoutId: 4242, workout: planWorkout("Linked, edited"), plans: [{ path, index: 0, version }], upload: true, schedule: false, profile: garmin.name, confirm: true },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe(REFUSAL);
    const after = await readPlan(garmin.api, path);
    expect(after.version).toBe(version);
    expect(after.data.workouts[0]).toMatchObject({ workoutId: 4242, workoutName: "Linked" });
  });

  test("deleting a workout from Garmin is refused, and the plan keeps it", async ({ garmin }) => {
    const path = `workout-plans/${garmin.name}-keep.json`;
    const version = await putPlan(garmin.api, path, [planWorkout("Keep", { workoutId: 5151 })]);
    const res = await garmin.api.delete("/api/garmin/workout", {
      data: { workoutId: 5151, plans: [{ path, index: 0, version }], garmin: true, removeFromPlans: false, profile: garmin.name, confirm: true },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe(REFUSAL);
    const after = await readPlan(garmin.api, path);
    expect(after.data.workouts).toHaveLength(1);
    expect(after.data.workouts[0].workoutId).toBe(5151);
  });

  test("taking a workout out of a plan needs no Garmin, so it works in mock mode", async ({ garmin }) => {
    const path = `workout-plans/${garmin.name}-remove.json`;
    const version = await putPlan(garmin.api, path, [planWorkout("Gone"), planWorkout("Stays")]);
    const res = await garmin.api.delete("/api/garmin/workout", {
      data: { plans: [{ path, index: 0, version }], garmin: false, removeFromPlans: true, profile: garmin.name, confirm: true },
    });
    expect(res.status()).toBe(200);
    const after = await readPlan(garmin.api, path);
    expect(after.data.workouts.map((w: any) => w.workoutName)).toEqual(["Stays"]);
  });
});
