/**
 * The Garmin-backed views in mock mode (MOCK_MODE=true, port 8793): Today, Activities, Recovery and Weight, and which views a
 * profile is offered.
 *
 * What the app really does here: the mock server stores nothing from Garmin, so each view is its empty state, with the note
 * "Mock mode: Garmin writes are disabled." where the view has a note. The Sync buttons are hidden: the page shows Garmin's controls
 * only when Garmin is enabled, and mock mode never enables it (the README: the buttons stay disabled in mock mode). The Garmin
 * endpoints that would fill the views refuse with the same reason. The generated mock data is what the MCP tools answer with.
 */
import { test as base, expect, loginAs, openView, mondayOf, daysAhead, today, ADMIN_TOKEN, type Profile } from "../../support/fixtures";
import { type APIRequestContext, type Page } from "@playwright/test";

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
 * Fresh profiles, with or without a Garmin login saved, signed in on a page of their own. `gme` has the Garmin login; `me` (from the
 * shared fixtures) has none. Traces are off in this file: with them on, the API contexts of the shared fixtures lose their
 * recordings at teardown.
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

/** Errors the page raises: uncaught exceptions, and console errors other than the 409s the refusals answer with. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 409/.test(m.text())) errors.push(m.text());
  });
  return errors;
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

/** A plan of the profile with one workout scheduled today, so the Today view has a planned workout to draw. */
async function putTodayPlan(api: APIRequestContext, name: string, workoutName: string): Promise<void> {
  const body = {
    weekStart: mondayOf(today()),
    weekEnd: daysAhead(6),
    workouts: [{ workoutName, workoutType: "running", scheduledDate: today(), steps: [{ stepType: "interval", targetType: "no.target", endCondition: "time", endConditionValue: 600 }] }],
  };
  const res = await api.put(`/api/file?path=${encodeURIComponent(`workout-plans/${name}.json`)}`, { data: { text: JSON.stringify(body, null, 2), create: true } });
  expect(res.status()).toBe(201);
}

test.describe("Which views a profile is offered", () => {
  test("a profile with a Garmin login is offered Workouts, Activities, Recovery and Weight", async ({ gme }) => {
    await openView(gme, "today");
    for (const id of ["vWorkouts", "vActivities", "vRecovery", "vWeight"]) await expect(gme.locator(`#${id}`)).toBeVisible();
    for (const id of ["vToday", "vPlans", "vCalendar", "vFood"]) await expect(gme.locator(`#${id}`)).toBeVisible();
  });

  test("a profile without a Garmin login is not offered those four views", async ({ me }) => {
    await openView(me, "today");
    for (const id of ["vWorkouts", "vActivities", "vRecovery", "vWeight"]) await expect(me.locator(`#${id}`)).toBeHidden();
    await expect(me.locator("#vPlans")).toBeVisible();
    await expect(me.locator("#vFood")).toBeVisible();
  });

  test("the admin login is offered Workouts once any profile has a Garmin login", async ({ page, garmin }) => {
    await loginAs(page, "admin", ADMIN_TOKEN);
    await openView(page, "today");
    await expect(page.locator("#vWorkouts")).toBeVisible();
    await expect(page.locator("#vRecovery")).toBeVisible();
  });

  test("a view the profile is not offered cannot be opened from the address", async ({ me }) => {
    await openView(me, "today");
    await me.goto("/#workouts");
    await expect(me.locator("body")).toHaveAttribute("data-view", "today");
    await expect(me.locator("#vWorkouts")).toBeHidden();
  });
});

test.describe("Today in mock mode", () => {
  test("Today opens for a Garmin profile without errors, with its health numbers not synced yet", async ({ gme }) => {
    const errors = watchErrors(gme);
    await openView(gme, "today");
    await expect(gme.locator("#tbody")).not.toContainText("Loading…");
    await expect(gme.locator("#tbody")).toContainText("Steps");
    await expect(gme.locator("#tbody")).toContainText("not synced yet");
    await expect(gme.locator("#tTitle")).not.toBeEmpty();
    expect(errors).toEqual([]);
  });

  test("Today has no Sync button in mock mode", async ({ gme }) => {
    await openView(gme, "today");
    await expect(gme.locator("#tbody")).not.toContainText("Loading…");
    await expect(gme.locator("#tSync")).toBeHidden();
  });

  test("Today draws the plan workout scheduled for today", async ({ gme, garmin }) => {
    await putTodayPlan(garmin.api, `${garmin.name}-today`, "Mock tempo today");
    await openView(gme, "today");
    await expect(gme.locator("#tbody")).toContainText("Today's workout");
    await expect(gme.locator("#tbody")).toContainText("Mock tempo today");
  });

  test("opening Today asks Garmin for nothing", async ({ gme }) => {
    const calls = trackApi(gme);
    await openView(gme, "today");
    await expect(gme.locator("#tbody")).toContainText("not synced yet");
    expect(calls.filter((c) => GARMIN_CALLS.test(c))).toEqual([]);
  });
});

test.describe("Activities in mock mode", () => {
  test("Activities opens with the refusal note and an empty list", async ({ gme }) => {
    const errors = watchErrors(gme);
    await openView(gme, "activities");
    await expect(gme.locator("#aNote")).toHaveText(REFUSAL);
    await expect(gme.locator("#alist .aemptycard")).toContainText("No activities are stored yet");
    await expect(gme.locator("#alist .aemptycard")).toContainText("Mock mode: Garmin writes are disabled.");
    await expect(gme.locator("#alist .aemptycard button")).toHaveCount(0); // nothing to fetch from
    expect(errors).toEqual([]);
  });

  test("Activities has no Sync button, and no profile picker for a profile login", async ({ gme }) => {
    await openView(gme, "activities");
    await expect(gme.locator("#aNote")).toHaveText(REFUSAL);
    await expect(gme.locator("#aSync")).toBeHidden();
    await expect(gme.locator("#aProfile")).toBeHidden();
  });

  test("the Progress mode says no activities are stored yet", async ({ gme }) => {
    const errors = watchErrors(gme);
    await openView(gme, "activities");
    await gme.locator("#aModes button", { hasText: "Progress" }).click();
    await expect(gme.locator("#astats")).toContainText("No activities are stored yet.");
    expect(errors).toEqual([]);
  });

  test("the Log mode comes back after Progress", async ({ gme }) => {
    await openView(gme, "activities");
    await expect(gme.locator("#aModes button")).toHaveText(["Log", "Progress"]);
    await gme.locator("#aModes button", { hasText: "Progress" }).click();
    await expect(gme.locator("#astats")).toBeVisible();
    await gme.locator("#aModes button", { hasText: "Log" }).click();
    await expect(gme.locator("#aModes button", { hasText: "Log" })).toHaveAttribute("aria-pressed", "true");
    await expect(gme.locator("#astats")).toBeHidden();
    await expect(gme.locator("#alist .aemptycard")).toBeVisible();
    await expect(gme.locator("#aNote")).toHaveText(REFUSAL);
  });

  test("the filters (types, search, range) stay out of the way while nothing is stored, and no error is raised", async ({ gme }) => {
    const errors = watchErrors(gme);
    await openView(gme, "activities");
    await expect(gme.locator("#alist .aemptycard")).toBeVisible();
    await expect(gme.locator("#afilters")).toBeHidden();
    await expect(gme.locator("#aRange option")).toHaveText(["4 weeks", "12 weeks", "1 year", "All"]);
    await expect(gme.locator("#aribbon .acard")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe("Recovery in mock mode", () => {
  test("Recovery opens with its empty state, and no Sync button", async ({ gme }) => {
    const errors = watchErrors(gme);
    await openView(gme, "recovery");
    await expect(gme.locator("#rbody")).toContainText("No health data is stored yet");
    await expect(gme.locator("#rSync")).toBeHidden();
    await expect(gme.locator("#rbody button")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("the previous day moves the date back, and Today brings it back and disables the next day", async ({ gme }) => {
    await openView(gme, "recovery");
    await expect(gme.locator("#rbody")).toContainText("No health data is stored yet");
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await gme.locator("#rPrev").click();
    await expect(gme.locator("#rDate")).toHaveValue(yesterday);
    await expect(gme.locator("#rNext")).toBeEnabled();
    await gme.locator("#rToday").click();
    await expect(gme.locator("#rNext")).toBeDisabled();
  });

  test("the range menu offers 14, 30, 60 and 90 days, and each draws the empty state", async ({ gme }) => {
    await openView(gme, "recovery");
    await expect(gme.locator("#rRange option")).toHaveText(["14 days", "30 days", "60 days", "90 days"]);
    for (const value of ["14", "60", "90", "30"]) {
      await gme.locator("#rRange").selectOption(value);
      await expect(gme.locator("#rRange")).toHaveValue(value);
      await expect(gme.locator("#rbody")).toContainText("No health data is stored yet");
    }
  });

  test("moving through the days asks Garmin for nothing", async ({ gme }) => {
    await openView(gme, "recovery");
    await expect(gme.locator("#rbody")).toContainText("No health data is stored yet");
    const calls = trackApi(gme);
    await gme.locator("#rPrev").click();
    await expect(gme.locator("#rDate")).not.toHaveValue(today());
    await gme.locator("#rToday").click();
    await expect(gme.locator("#rbody")).toContainText("No health data is stored yet");
    expect(calls.filter((c) => GARMIN_CALLS.test(c))).toEqual([]);
  });

  test("the empty state blames mock mode, not a missing login, for a profile that has a Garmin login", async ({ gme }) => {
    await openView(gme, "recovery");
    await expect(gme.locator("#rbody")).toContainText("No health data is stored yet. Mock mode does not fetch it from Garmin.");
    await expect(gme.locator("#rbody")).not.toContainText("Garmin is not connected");
  });
});

test.describe("Weight in mock mode", () => {
  test("Weight opens with its empty state, and no Sync button", async ({ gme }) => {
    const errors = watchErrors(gme);
    await openView(gme, "weight");
    await expect(gme.locator("#bbody")).toContainText("No weigh-ins are stored yet");
    await expect(gme.locator("#bSync")).toBeHidden();
    await expect(gme.locator("#bbody button")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("the lb and kg switch changes the unit that is pressed", async ({ gme }) => {
    await openView(gme, "weight");
    await expect(gme.locator("#bUnits button[data-unit=lb]")).toHaveAttribute("aria-pressed", "true");
    await gme.locator("#bUnits button[data-unit=kg]").click();
    await expect(gme.locator("#bUnits button[data-unit=kg]")).toHaveAttribute("aria-pressed", "true");
    await expect(gme.locator("#bUnits button[data-unit=lb]")).toHaveAttribute("aria-pressed", "false");
    await gme.locator("#bUnits button[data-unit=lb]").click();
    await expect(gme.locator("#bUnits button[data-unit=lb]")).toHaveAttribute("aria-pressed", "true");
  });

  test("the range menu offers 14, 30, 60 and 90 days, and each keeps the empty state", async ({ gme }) => {
    await openView(gme, "weight");
    await expect(gme.locator("#bRange option")).toHaveText(["14 days", "30 days", "60 days", "90 days"]);
    for (const value of ["14", "90", "30", "60"]) {
      await gme.locator("#bRange").selectOption(value);
      await expect(gme.locator("#bRange")).toHaveValue(value);
      await expect(gme.locator("#bbody")).toContainText("No weigh-ins are stored yet");
    }
  });

  test("opening Weight asks Garmin for nothing", async ({ gme }) => {
    const calls = trackApi(gme);
    await openView(gme, "weight");
    await expect(gme.locator("#bbody")).toContainText("No weigh-ins are stored yet");
    expect(calls.filter((c) => GARMIN_CALLS.test(c))).toEqual([]);
  });

  test("the empty state does not tell a Garmin profile to connect Garmin: mock mode is why nothing is fetched", async ({ gme }) => {
    await openView(gme, "weight");
    await expect(gme.locator("#bbody .bempty h2")).toHaveText("No weigh-ins are stored yet");
    await expect(gme.locator("#bbody .bempty p")).toHaveText("Mock mode does not fetch them from Garmin.");
    await expect(gme.locator("#bbody")).not.toContainText("Connect a Renpho scale or Garmin");
  });
});

test.describe("Sync in mock mode", () => {
  test("the activities sync is refused with the mock reason", async ({ garmin }) => {
    const res = await garmin.api.post("/api/activities/sync", { data: { profile: garmin.name } });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe(REFUSAL);
  });

  test("the wellness sync is refused with the mock reason, even for the manual sync of every kind", async ({ garmin }) => {
    const res = await garmin.api.post("/api/wellness/sync", { data: { profile: garmin.name, manual: true, days: 60, rereadWeight: true } });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe(REFUSAL);
  });

  test("the stored views answer with nothing: no activities, no weigh-ins, no readiness", async ({ garmin }) => {
    const activities = await (await garmin.api.get(`/api/activities?profile=${garmin.name}`)).json();
    expect(activities.activities).toEqual([]);
    const weight = await (await garmin.api.get(`/api/weight?profile=${garmin.name}`)).json();
    expect(weight.body.weighIns).toBe(0);
    const wellness = await (await garmin.api.get(`/api/wellness?profile=${garmin.name}`)).json();
    expect(wellness.readiness.band).toBe("unknown");
  });

});

test.describe("Walking the views in mock mode", () => {
  test("every view a Garmin profile is offered opens without a page error", async ({ gme }) => {
    const errors = watchErrors(gme);
    await openView(gme, "today");
    for (const [id, view] of [
      ["vPlans", "plans"],
      ["vWorkouts", "workouts"],
      ["vCalendar", "calendar"],
      ["vActivities", "activities"],
      ["vRecovery", "recovery"],
      ["vWeight", "weight"],
      ["vFood", "food"],
      ["vToday", "today"],
    ] as const) {
      await gme.locator(`#${id}`).click();
      await expect(gme.locator("body")).toHaveAttribute("data-view", view);
    }
    expect(errors).toEqual([]);
  });

  test("a reload on each Garmin view draws it again with the same note", async ({ gme }) => {
    for (const view of ["workouts", "activities", "recovery", "weight"]) {
      await openView(gme, view);
      await expect(gme.locator("body")).toHaveAttribute("data-view", view);
    }
    await openView(gme, "weight");
    await expect(gme.locator("#bbody")).toContainText("No weigh-ins are stored yet");
    await openView(gme, "workouts");
    await expect(gme.locator("#wNote")).toHaveText(REFUSAL);
  });
});
