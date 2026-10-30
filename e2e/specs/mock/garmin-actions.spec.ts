/**
 * The Garmin actions of a plan in mock mode (MOCK_MODE=true, port 8793).
 *
 * What the app really does here: mock mode turns the Garmin side off for the page. The Plans view's Garmin menu is disabled and
 * says why, the file list and the outline draw no Garmin buttons, and the plan-against-Garmin status bar stays hidden. The server
 * refuses every Garmin request (actions, the device list, the status check) with "Mock mode: Garmin writes are disabled.", and
 * nothing is written to a plan by them. What works is the plan itself: validating, saving, archiving a plan that has no Garmin
 * workouts. Archiving a plan that has Garmin workouts is refused by the page with the same reason.
 */
import { test as base, expect, loginAs, openView, mondayOf, daysAhead, today, type Profile } from "../../support/fixtures";
import { type APIRequestContext, type Page } from "@playwright/test";

const REFUSAL = "Mock mode: Garmin writes are disabled.";
const GARMIN_PASSWORD = "garmin-password";
const ACTIONS = ["upload", "schedule", "upload_schedule", "send"] as const;

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

const run = (name: string, extra: Record<string, unknown> = {}) => ({
  workoutName: name,
  workoutType: "running",
  steps: [{ stepType: "interval", targetType: "no.target", endCondition: "distance", endConditionValue: 5000 }],
  ...extra,
});

/** A plan file of the profile (its path is unique to the test). Returns the version the server gave it. */
async function putPlan(api: APIRequestContext, name: string, workouts: unknown[]): Promise<{ path: string; name: string; version: number }> {
  const path = `workout-plans/${name}.json`;
  const body = { weekStart: mondayOf(today()), weekEnd: daysAhead(6), workouts };
  const res = await api.put(`/api/file?path=${encodeURIComponent(path)}`, { data: { text: JSON.stringify(body, null, 2), create: true } });
  expect(res.status()).toBe(201);
  return { path, name, version: (await res.json()).version };
}

async function readPlan(api: APIRequestContext, path: string): Promise<{ version: number; text: string; data: any }> {
  const res = await api.get(`/api/file?path=${encodeURIComponent(path)}`);
  expect(res.ok()).toBeTruthy();
  const doc = await res.json();
  return { version: doc.version, text: doc.text, data: JSON.parse(doc.text) };
}

/** The archivedAt of a plan as the file list has it. */
async function archivedAt(api: APIRequestContext, path: string): Promise<number | null> {
  const files = await (await api.get("/api/files")).json();
  return files.files.find((f: any) => f.path === path).archivedAt;
}

/** The API paths the page asks for, from now on. */
function trackApi(page: Page): string[] {
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) calls.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  return calls;
}

/** The endpoints that reach Garmin or act on it: GET /api/garmin (what the page knows of the logins) is not one of them. */
const GARMIN_CALLS = /\/api\/(garmin\/|workouts|activities\/sync|wellness\/sync)/;

/** Open the Plans view and the plan with this name in the list. */
async function openPlan(page: Page, name: string): Promise<void> {
  await openView(page, "plans");
  await page.locator("#filelist .file", { hasText: name }).click();
  await expect(page.locator("#current")).toContainText(name);
}

test.describe("Plans view: the Garmin menu in mock mode", () => {
  test("the Garmin menu button is disabled for an open plan and says why", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-menu`, [run("Easy")]);
    await openPlan(gme, plan.name);
    await expect(gme.locator("#garminBtn")).toBeDisabled();
    await expect(gme.locator("#garminBtn")).toHaveAttribute("title", REFUSAL);
  });

  test("each Garmin action in the menu is disabled, and the menu does not open", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-items`, [run("Easy")]);
    await openPlan(gme, plan.name);
    for (const id of ["gUpload", "gSchedule", "gBoth", "gSend"]) {
      await expect(gme.locator(`#${id}`)).toBeDisabled();
      await expect(gme.locator(`#${id}`)).toHaveAttribute("title", REFUSAL);
    }
    await expect(gme.locator("#garminBtn")).toHaveAttribute("aria-expanded", "false");
  });

  test("the Garmin menu is disabled for a plan that has no Garmin ids either", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-noids`, [run("Plain"), run("Also plain")]);
    await openPlan(gme, plan.name);
    await expect(gme.locator("#garminBtn")).toBeDisabled();
    await expect(gme.locator("#gUpload")).toBeDisabled();
  });

  test("the file list offers no Garmin buttons for a plan: only archive, duplicate and delete", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-rows`, [run("Row")]);
    await openView(gme, "plans");
    const row = gme.locator("#filelist .file", { hasText: plan.name });
    await expect(row).toBeVisible();
    await expect(row.locator(".wact button")).toHaveCount(3);
    await expect(row.locator('.wact button[title="Upload the plan to Garmin"]')).toHaveCount(0);
    await expect(row.locator('.wact button[title="Schedule the plan on the Garmin calendar"]')).toHaveCount(0);
    await expect(row.locator('.wact button[title="Send the plan to the watch"]')).toHaveCount(0);
    await expect(row.locator('.wact button[title^="Archive the plan"]')).toHaveCount(1);
  });

  test("the Garmin pane keeps its empty note: no action has run", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-pane`, [run("Pane")]);
    await openPlan(gme, plan.name);
    await gme.locator("#validate").click();
    await expect(gme.locator("#problems")).toContainText("Valid");
    await expect(gme.locator("#activity")).toHaveText("No Garmin action run yet.");
  });

  test("the outline's status bar stays hidden: no plan-against-Garmin check runs", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-status`, [run("Checked"), run("Checked too", { workoutId: 701 })]);
    await openPlan(gme, plan.name);
    await expect(gme.locator("#outline")).toContainText("Checked too");
    await expect(gme.locator("#syncbar")).toBeHidden();
    await expect(gme.locator("#syncSummary")).toBeEmpty();
    await expect(gme.locator("#syncRefresh")).toBeHidden();
  });

  test("the outline marks a workout that has a Garmin id, and checks it against nothing", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-marks`, [run("Plain one"), run("Linked one", { workoutId: 702 })]);
    await openPlan(gme, plan.name);
    await expect(gme.locator("#outline")).toContainText("Linked one");
    await expect(gme.locator("#outline")).toContainText("↑");
    await expect(gme.locator("#outline")).not.toContainText("Up to date on Garmin");
    await expect(gme.locator("#outline")).not.toContainText("Differs from the copy on Garmin");
  });

  test("opening a plan and validating it make no Garmin request", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-quiet`, [run("Quiet", { workoutId: 703 })]);
    const calls = trackApi(gme);
    await openPlan(gme, plan.name);
    await gme.locator("#validate").click();
    await expect(gme.locator("#problems")).toContainText("Valid");
    expect(calls.filter((c) => GARMIN_CALLS.test(c))).toEqual([]);
  });

  test("the Validate button checks the open plan and reports it valid", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-valid`, [run("Good one"), run("Good two")]);
    await openPlan(gme, plan.name);
    await gme.locator("#validate").click();
    await expect(gme.locator("#problems")).toContainText("Valid — 2 workouts.");
  });

  test("a plan with a step type that does not exist shows the error when it opens", async ({ gme, garmin }) => {
    const bad = run("Broken", { steps: [{ stepType: "bogus", targetType: "no.target", endCondition: "time", endConditionValue: 60 }] });
    const plan = await putPlan(garmin.api, `${garmin.name}-broken`, [bad]);
    await openPlan(gme, plan.name);
    await expect(gme.locator("#problems")).toContainText("Invalid stepType 'bogus'");
  });

  test("an edited plan saves in mock mode, without Garmin", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-save`, [run("Before")]);
    const calls = trackApi(gme);
    await openPlan(gme, plan.name);
    const edited = { weekStart: mondayOf(today()), weekEnd: daysAhead(6), workouts: [run("After")] };
    await gme.evaluate((text) => editor.setValue(text), JSON.stringify(edited, null, 2));
    await gme.locator("#save").click();
    await expect(gme.locator("#save")).toBeDisabled();
    const after = await readPlan(garmin.api, plan.path);
    expect(after.version).toBeGreaterThan(plan.version);
    expect(after.data.workouts[0].workoutName).toBe("After");
    expect(calls.filter((c) => GARMIN_CALLS.test(c))).toEqual([]);
  });
});

test.describe("Plans view: archiving in mock mode", () => {
  test("archiving a plan that has Garmin workouts is refused, and the plan stays", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-linked`, [run("Linked", { workoutId: 801 })]);
    await openPlan(gme, plan.name);
    await gme.locator("#fileBtn").click();
    await gme.locator("#archive").click();
    await expect(gme.locator("#toast")).toHaveText(REFUSAL);
    await expect(gme.locator("#dlg")).toBeHidden();
    expect(await archivedAt(garmin.api, plan.path)).toBeNull();
  });

  test("archiving a plan with no Garmin workouts works, and the plan moves under Archived", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-plain`, [run("Plain")]);
    await openPlan(gme, plan.name);
    await gme.locator("#fileBtn").click();
    await gme.locator("#archive").click();
    await expect(gme.locator("#dlg")).toBeVisible();
    await expect(gme.locator("#dlgTitle")).toHaveText("Archive this plan?");
    await expect(gme.locator("#dlgText")).toContainText("This plan has no workouts on Garmin, so nothing changes there.");
    await gme.locator("#dlgOk").click();
    await expect(gme.locator("#toast")).toHaveText("Archived");
    await expect(gme.locator("#filelist details.shelved summary")).toHaveText("Archived (1)");
    expect(await archivedAt(garmin.api, plan.path)).not.toBeNull();
  });

  test("an archived plan has no Garmin buttons: unarchive, duplicate and delete only", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-shelf`, [run("Shelf")]);
    expect((await garmin.api.post("/api/plans/archive", { data: { path: plan.path, version: plan.version, confirm: true } })).ok()).toBeTruthy();
    await openView(gme, "plans");
    await gme.locator("#filelist details.shelved summary").click();
    const row = gme.locator("#filelist .shelved .file", { hasText: plan.name });
    await expect(row.locator(".wact button")).toHaveCount(3);
    await expect(row.locator('.wact button[title="Unarchive the plan"]')).toHaveCount(1);
    await expect(row.locator('.wact button[title^="Upload"]')).toHaveCount(0);
  });

  test("the Garmin button of an archived plan says it is archived, not that mock mode refuses it", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-shelved-open`, [run("Shelved")]);
    expect((await garmin.api.post("/api/plans/archive", { data: { path: plan.path, version: plan.version, confirm: true } })).ok()).toBeTruthy();
    await openView(gme, "plans");
    await gme.locator("#filelist details.shelved summary").click();
    await gme.locator("#filelist .shelved .file", { hasText: plan.name }).click();
    await expect(gme.locator("#current")).toContainText(plan.name);
    await expect(gme.locator("#garminBtn")).toBeDisabled();
    await expect(gme.locator("#garminBtn")).toHaveAttribute("title", "This plan is archived: unarchive it to send its workouts to Garmin.");
  });

  test("unarchiving puts the plan back in the active list, with no Garmin call", async ({ gme, garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-back`, [run("Back")]);
    expect((await garmin.api.post("/api/plans/archive", { data: { path: plan.path, version: plan.version, confirm: true } })).ok()).toBeTruthy();
    const calls = trackApi(gme);
    await openView(gme, "plans");
    await gme.locator("#filelist details.shelved summary").click();
    const row = gme.locator("#filelist .shelved .file", { hasText: plan.name });
    await row.locator('.wact button[title="Unarchive the plan"]').click();
    await expect(gme.locator("#toast")).toContainText("Unarchived");
    await expect(gme.locator("#filelist details.shelved")).toHaveCount(0);
    expect(await archivedAt(garmin.api, plan.path)).toBeNull();
    expect(calls.filter((c) => GARMIN_CALLS.test(c))).toEqual([]);
  });
});

test.describe("Garmin endpoints in mock mode: the refusals behind the menu", () => {
  test("GET /api/garmin says the profile has a Garmin login, and that mock mode refuses Garmin", async ({ garmin }) => {
    const res = await garmin.api.get("/api/garmin");
    expect(res.ok()).toBeTruthy();
    const info = await res.json();
    expect(info).toMatchObject({ enabled: false, mock: true, reason: REFUSAL, connected: [garmin.name] });
    expect(info.profileInfo[garmin.name].garmin).toBe(true);
  });

  test("GET /api/garmin/devices is refused with the mock reason", async ({ garmin }) => {
    const res = await garmin.api.get(`/api/garmin/devices?profile=${garmin.name}`);
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe(REFUSAL);
  });

  test("the device list is refused for a profile without a Garmin login too, with the same mock reason", async ({ admin }) => {
    const name = `nogarmin${Date.now().toString(36)}`;
    expect((await admin.post("/api/profiles", { data: { name, password: GARMIN_PASSWORD, confirm: GARMIN_PASSWORD } })).ok()).toBeTruthy();
    const res = await admin.get(`/api/garmin/devices?profile=${name}`);
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe(REFUSAL);
  });

  for (const action of ACTIONS) {
    test(`POST /api/garmin/action "${action}" is refused with the mock reason, and nothing is written`, async ({ garmin }) => {
      const plan = await putPlan(garmin.api, `${garmin.name}-${action}`, [run("Sent", { sendToDevice: true })]);
      const before = await readPlan(garmin.api, plan.path);
      const res = await garmin.api.post("/api/garmin/action", { data: { action, path: plan.path, profile: garmin.name, confirm: true } });
      expect(res.status()).toBe(409);
      expect((await res.json()).error).toBe(REFUSAL);
      const after = await readPlan(garmin.api, plan.path);
      expect(after.version).toBe(plan.version);
      expect(after.text).toBe(before.text);
    });
  }

  test("the plan-against-Garmin check (POST /api/garmin/status) is refused with the mock reason", async ({ garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-check`, [run("Check", { workoutId: 900 })]);
    const res = await garmin.api.post("/api/garmin/status", { data: { path: plan.path, profile: garmin.name } });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe(REFUSAL);
  });

  test("archiving a plan with Garmin ids through the API is refused with the mock reason", async ({ garmin }) => {
    const plan = await putPlan(garmin.api, `${garmin.name}-apilink`, [run("Linked", { workoutId: 901 })]);
    const res = await garmin.api.post("/api/plans/archive", { data: { path: plan.path, version: plan.version, profile: garmin.name, confirm: true } });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe(REFUSAL);
    expect(await archivedAt(garmin.api, plan.path)).toBeNull();
  });

  test("the dry run (POST /api/validate) accepts a valid plan and needs no Garmin", async ({ garmin }) => {
    const plan = { weekStart: mondayOf(today()), weekEnd: daysAhead(6), workouts: [run("Dry")] };
    const res = await garmin.api.post("/api/validate", { data: { text: JSON.stringify(plan) } });
    expect(res.ok()).toBeTruthy();
    const { validation } = await res.json();
    expect(validation).toMatchObject({ valid: true, errors: [], workoutCount: 1 });
  });

  test("the dry run reports what is wrong with a workout, and still needs no Garmin", async ({ garmin }) => {
    const bad = run("Dry bad", { steps: [{ stepType: "bogus", targetType: "no.target", endCondition: "time", endConditionValue: 60 }] });
    const res = await garmin.api.post("/api/validate", { data: { text: JSON.stringify([bad]) } });
    expect(res.ok()).toBeTruthy();
    const { validation } = await res.json();
    expect(validation.errors.join(" ")).toContain("Invalid stepType 'bogus'");
  });
});
