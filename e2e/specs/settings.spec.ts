/**
 * The Settings view: the nutrition goals, the Garmin and Renpho logins, the web sign-in password, and (for the admin) adding a profile
 * and choosing which profile Settings shows. Every test that saves changes its own fresh profile; alice is only read. The Garmin and
 * Renpho requests that would reach those services (test, sync, sign-in) are answered by page.route, so nothing leaves the server.
 */
import { request as pwRequest, type APIRequestContext, type Locator, type Page, type Request } from "@playwright/test";
import { test as base, expect, loginAs, ADMIN_TOKEN, CSRF, PASSWORD } from "../support/fixtures";

/**
 * The server closes an idle connection after a few seconds, and a client that sends on it meets a reset (and a loaded machine answers
 * slowly): a request that failed that way is sent again, on a new connection. Only for what is safe to send twice.
 */
async function retried<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 3 || !/ECONNRESET|socket hang up/.test(String(error))) throw error;
    }
  }
}


/** The app is slow on a shared server (every page load asks for the profiles' views and the settings), so these waits are longer than the suite's default. */
const slow = expect.configure({ timeout: 30_000 });

/** Wait for the first view to be drawn: the sign-in form is gone and the header is up. */
async function ready(page: Page): Promise<void> {
  await slow(page.locator("#login")).toBeHidden();
  await slow(page.locator("#views")).toBeVisible();
}

/**
 * Open the page on a view, signed in already, and wait until it is drawn. On a loaded server a script of the page can fail to arrive;
 * the page then keeps its placeholder (the Today view, "Loading…") for good, so a view that is not drawn within 15 seconds is loaded again, once.
 */
async function openView(page: Page, view: string): Promise<void> {
  const address = view === "today" ? "/" : `/#${view}`;
  for (let attempt = 1; ; attempt++) {
    if (attempt === 1) await page.goto(address);
    else await page.reload();
    await ready(page);
    try {
      await slow(page.locator("body")).toHaveAttribute("data-view", view, { timeout: 15_000 });
      if (view === "today") await slow(page.locator("#tbody")).not.toContainText("Loading…", { timeout: 15_000 });
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}

/** The admin login (the access token, any name) on a page of its own. */
const test = base.extend<{ adminPage: Page }>({
  adminPage: async ({ browser, baseURL }, use) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 860 }, timezoneId: "UTC", locale: "en-CA" });
    const page = await context.newPage();
    await retried(() => loginAs(page, "admin", ADMIN_TOKEN));
    await use(page);
    await context.close();
  },
});
test.describe.configure({ timeout: 90_000 });

const NEW_PASSWORD = "a brand new passphrase";
const PROFILE_PASSWORD = "profile pass one";

// ── helpers ──

/** One of the four cards, by its heading. */
const card = (page: Page, heading: string) => page.locator(".scard").filter({ has: page.locator("h2", { hasText: heading }) });
const goalsCard = (page: Page) => card(page, "Nutrition goals");
const garminCard = (page: Page) => card(page, "Garmin account");
const renphoCard = (page: Page) => card(page, "Renpho scale");
const webCard = (page: Page) => card(page, "Web sign-in");

/** The goal field of a key (`kcal`, `proteinG`, ...), the way the page names it. */
const goalField = (page: Page, key: string) => page.locator(`#s-goal_${key}`);

/** The message a card shows after an action: a green or a red line (the notes are not messages). */
const okLine = (c: Locator) => c.locator(".sline.ok:visible");
const errLine = (c: Locator) => c.locator(".sline.err:visible");

/** Open Settings (signed in already) and wait until its four cards are drawn; loaded again once if they are not (see openView). */
async function openSettings(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    if (attempt === 1) await page.goto("/#settings");
    else await page.reload();
    await ready(page);
    try {
      await slow(page.locator("#sbody .scard")).toHaveCount(4, { timeout: 15_000 });
      await slow(page.locator("#sbody .empty")).toHaveCount(0);
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}

/** Every goal field as the page shows it now (the ones with a value). */
const shownGoals = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLInputElement>("#sbody input[id^=s-goal_]")].filter((i) => i.value !== "").map((i) => [i.id.replace("s-goal_", ""), i.value])));

const basic = (user: string, secret: string) => ({ Authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}` });

/** Whether a name and password sign in (the API answers 200 for the right ones, 401 for the others). */
async function signsIn(baseURL: string | undefined, user: string, secret: string): Promise<number> {
  const api: APIRequestContext = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { ...CSRF, ...basic(user, secret) } });
  try {
    return (await api.get("/api/settings")).status();
  } finally {
    await api.dispose();
  }
}

/** The settings a profile holds, as the API gives them (the same shape the page draws). */
const settingsOf = (api: APIRequestContext, query = "") => retried(async () => (await api.get(`/api/settings${query}`)).json());

/** A Renpho login saved for a profile through the API (stored only: Renpho is never reached by a save). */
const seedRenpho = (profile: { name: string; api: APIRequestContext }) =>
  retried(() => profile.api.post("/api/settings/renpho", { data: { profile: profile.name, action: "save", email: "scale@example.com", password: "scale-pass-123", areaCode: "US" } }));

/** A name for a profile the admin makes in a test: unique, and within the rules (letters, digits, hyphens, underscores). */
const freshName = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The requests of the page that change something (anything but a GET to the app). */
function writesOf(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", (request: Request) => {
    if (request.method() !== "GET" && request.url().includes("/api/")) writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return writes;
}

// ── nutrition goals ──

test.describe("nutrition goals", () => {
  test("a fresh profile has no goals: 'none set', every field empty, and 'Clear all goals' disabled", async ({ me, profile }) => {
    await openSettings(me);
    const c = goalsCard(me);
    await slow(c.locator(".chip")).toHaveText("none set");
    await slow(goalField(me, "kcal")).toHaveValue("");
    await slow(goalField(me, "proteinG")).toHaveValue("");
    await slow(c.getByRole("button", { name: "Clear all goals" })).toBeDisabled();
    await slow(c.getByRole("button", { name: "Save goals" })).toBeEnabled();
    slow(await shownGoals(me)).toEqual({});
    slow((await settingsOf(profile.api)).goals.values).toEqual({});
  });

  test("each goal says whether it is a goal to reach (at least), a limit (at most) or an aim", async ({ me }) => {
    await openSettings(me);
    await slow(goalField(me, "kcal")).toHaveAttribute("placeholder", "the aim");
    await slow(goalField(me, "proteinG")).toHaveAttribute("placeholder", "at least");
    await slow(goalField(me, "fiberG")).toHaveAttribute("placeholder", "at least");
    await slow(goalField(me, "sodiumMg")).toHaveAttribute("placeholder", "at most");
    await slow(goalField(me, "sugarsG")).toHaveAttribute("placeholder", "at most");
    await slow(goalField(me, "carbsG")).toHaveAttribute("placeholder", "the aim");
  });

  test("the goals saved stay after a reload, and the server holds the same numbers", async ({ me, profile }) => {
    await openSettings(me);
    await goalField(me, "kcal").fill("2200");
    await goalField(me, "proteinG").fill("130");
    await goalField(me, "carbsG").fill("250");
    await goalField(me, "fatG").fill("70");
    await goalField(me, "sodiumMg").fill("2300");
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(okLine(goalsCard(me))).toHaveText("Goals saved.");
    await slow(goalsCard(me).locator(".chip")).toHaveText("5 set");
    await slow(goalsCard(me).getByRole("button", { name: "Clear all goals" })).toBeEnabled();
    slow((await settingsOf(profile.api)).goals.values).toEqual({ kcal: 2200, proteinG: 130, carbsG: 250, fatG: 70, sodiumMg: 2300 });

    await me.reload();
    await ready(me);
    await slow(goalField(me, "kcal")).toHaveValue("2200");
    slow(await shownGoals(me)).toEqual({ kcal: "2200", proteinG: "130", carbsG: "250", fatG: "70", sodiumMg: "2300" });
  });

  test("a field left empty removes that goal on save, and the others stay", async ({ me, profile }) => {
    await retried(() => profile.api.post("/api/settings/goals", { data: { profile: profile.name, action: "save", goals: { kcal: 2000, proteinG: 120 } } }));
    await openSettings(me);
    await slow(goalField(me, "kcal")).toHaveValue("2000");
    await goalField(me, "kcal").fill("");
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(okLine(goalsCard(me))).toHaveText("Goals saved.");
    slow((await settingsOf(profile.api)).goals.values).toEqual({ proteinG: 120 });
    await me.reload();
    await ready(me);
    await slow(goalField(me, "kcal")).toHaveValue("");
    await slow(goalField(me, "proteinG")).toHaveValue("120");
    await slow(goalsCard(me).locator(".chip")).toHaveText("1 set");
  });

  test("'Clear all goals' removes every goal and says so", async ({ me, profile }) => {
    await retried(() => profile.api.post("/api/settings/goals", { data: { profile: profile.name, action: "save", goals: { kcal: 2000, fatG: 60, ironMg: 18 } } }));
    await openSettings(me);
    await slow(goalsCard(me).locator(".chip")).toHaveText("3 set");
    await goalsCard(me).getByRole("button", { name: "Clear all goals" }).click();
    await slow(okLine(goalsCard(me))).toHaveText("Goals cleared.");
    await slow(goalsCard(me).locator(".chip")).toHaveText("none set");
    await slow(goalsCard(me).getByRole("button", { name: "Clear all goals" })).toBeDisabled();
    slow((await settingsOf(profile.api)).goals.values).toEqual({});
    await me.reload();
    await ready(me);
    slow(await shownGoals(me)).toEqual({});
  });

  test("a negative calorie goal is refused on the page, and nothing is saved", async ({ me, profile }) => {
    await openSettings(me);
    await goalField(me, "kcal").fill("-5");
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(errLine(goalsCard(me))).toHaveText("Calories must be a number above 0, or empty for no goal.");
    slow((await settingsOf(profile.api)).goals.values).toEqual({});
  });

  test("zero and text that is not a number are refused the same way, for a macro too", async ({ me, profile }) => {
    await openSettings(me);
    await goalField(me, "kcal").fill("0");
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(errLine(goalsCard(me))).toHaveText("Calories must be a number above 0, or empty for no goal.");
    await goalField(me, "kcal").fill("");
    await goalField(me, "proteinG").fill("lots");
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(errLine(goalsCard(me))).toHaveText("Protein must be a number above 0, or empty for no goal.");
    slow((await settingsOf(profile.api)).goals.values).toEqual({});
  });

  test("an absurd calorie goal is refused by the server, with its upper limit", async ({ me, profile }) => {
    await openSettings(me);
    await goalField(me, "kcal").fill("99999");
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(errLine(goalsCard(me))).toHaveText("The calories goal must be a number above 0 and at most 10000 kcal (leave it empty for no goal).");
    slow((await settingsOf(profile.api)).goals.values).toEqual({});
  });

  test("an absurd protein goal is refused by the server, with its upper limit", async ({ me, profile }) => {
    await openSettings(me);
    await goalField(me, "proteinG").fill("9999");
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(errLine(goalsCard(me))).toHaveText("The protein goal must be a number above 0 and at most 2000 g (leave it empty for no goal).");
    slow((await settingsOf(profile.api)).goals.values).toEqual({});
  });

  test("a decimal comma is read as a decimal point: 150,5 g of protein is saved as 150.5", async ({ me, profile }) => {
    await openSettings(me);
    await goalField(me, "proteinG").fill("150,5");
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(okLine(goalsCard(me))).toHaveText("Goals saved.");
    slow((await settingsOf(profile.api)).goals.values).toEqual({ proteinG: 150.5 });
  });

  // The page reads a comma as a decimal point, so a calorie goal typed with a thousands separator becomes 2 kcal.
  test.fixme("a calorie goal typed as 2,000 is saved as 2,000 kcal (the app saves 2 kcal, and says 'Goals saved.')", async ({ me, profile }) => {
    await openSettings(me);
    await goalField(me, "kcal").fill("2,000");
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(okLine(goalsCard(me))).toHaveText("Goals saved.");
    slow((await settingsOf(profile.api)).goals.values).toEqual({ kcal: 2000 });
  });

  test("the line under the goals adds protein, carbs and fat in calories and compares them with the calorie goal, as you type", async ({ me }) => {
    await openSettings(me);
    const note = () => goalsCard(me).locator(".sline.dim:visible");
    await goalField(me, "proteinG").fill("130");
    await goalField(me, "carbsG").fill("250");
    await slow(note()).toBeHidden(); // fat is not typed yet
    await goalField(me, "fatG").fill("70");
    await slow(note()).toHaveText("Protein, carbs and fat add up to 2,150 kcal.");
    await goalField(me, "kcal").fill("2000");
    await slow(note()).toHaveText("Protein, carbs and fat add up to 2,150 kcal, 8 % above the calorie goal of 2,000.");
    await goalField(me, "kcal").fill("2150");
    await slow(note()).toHaveText("Protein, carbs and fat add up to 2,150 kcal, in line with the calorie goal.");
    await goalField(me, "kcal").fill("2400");
    await slow(note()).toHaveText("Protein, carbs and fat add up to 2,150 kcal, 10 % below the calorie goal of 2,400.");
  });

  test("the calorie goal can follow the burn: off by default, and its share field appears only when turned on", async ({ me }) => {
    await openSettings(me);
    const toggle = me.getByRole("checkbox", { name: "Add the calories I burn to the calorie goal" });
    await slow(toggle).not.toBeChecked();
    await slow(me.locator("#s-goal_kcalBurnPct")).toHaveCount(0);
    await toggle.check();
    await slow(me.locator("#s-goal_kcalBurnPct")).toHaveValue("100");
    await toggle.uncheck();
    await slow(me.locator("#s-goal_kcalBurnPct")).toHaveCount(0);
  });

  test("following the burn needs a calorie goal: saving without one says so, and saves nothing", async ({ me, profile }) => {
    await openSettings(me);
    await me.getByRole("checkbox", { name: "Add the calories I burn to the calorie goal" }).check();
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(errLine(goalsCard(me))).toHaveText("Set a calorie goal to add the burned calories to.");
    slow((await settingsOf(profile.api)).goals.values).toEqual({});
  });

  test("a share of the burn above 100 % is refused", async ({ me, profile }) => {
    await openSettings(me);
    await goalField(me, "kcal").fill("2000");
    await me.getByRole("checkbox", { name: "Add the calories I burn to the calorie goal" }).check();
    await goalField(me, "kcalBurnPct").fill("150");
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(errLine(goalsCard(me))).toHaveText("The share of the active calories added to the calorie goal is at most 100 %.");
    slow((await settingsOf(profile.api)).goals.values).toEqual({});
  });

  test("a share of the burn saved with a calorie goal stays after a reload; turning it off removes it", async ({ me, profile }) => {
    await openSettings(me);
    await goalField(me, "kcal").fill("2000");
    await me.getByRole("checkbox", { name: "Add the calories I burn to the calorie goal" }).check();
    await goalField(me, "kcalBurnPct").fill("50");
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(okLine(goalsCard(me))).toHaveText("Goals saved.");
    slow((await settingsOf(profile.api)).goals.values).toEqual({ kcal: 2000, kcalBurnPct: 50 });

    await me.reload();
    await ready(me);
    await slow(me.getByRole("checkbox", { name: "Add the calories I burn to the calorie goal" })).toBeChecked();
    await slow(goalField(me, "kcalBurnPct")).toHaveValue("50");

    await me.getByRole("checkbox", { name: "Add the calories I burn to the calorie goal" }).uncheck();
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(okLine(goalsCard(me))).toHaveText("Goals saved.");
    slow((await settingsOf(profile.api)).goals.values).toEqual({ kcal: 2000 });
    await me.reload();
    await ready(me);
    await slow(me.getByRole("checkbox", { name: "Add the calories I burn to the calorie goal" })).not.toBeChecked();
  });

  test("a goal refused on the page keeps what was typed, so it can be corrected and saved", async ({ me, profile }) => {
    await openSettings(me);
    await goalField(me, "kcal").fill("-5");
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(errLine(goalsCard(me))).toHaveText("Calories must be a number above 0, or empty for no goal.");
    await slow(goalField(me, "kcal")).toHaveValue("-5");
    await goalField(me, "kcal").fill("2100");
    await goalsCard(me).getByRole("button", { name: "Save goals" }).click();
    await slow(okLine(goalsCard(me))).toHaveText("Goals saved.");
    slow((await settingsOf(profile.api)).goals.values).toEqual({ kcal: 2100 });
  });

  // Read only: what the page shows is what alice's own settings hold (whatever goals the suite's data has), with the count of them.
  test("alice's goals are shown to her as her settings hold them (read only): the page and the server agree", async ({ alice }) => {
    const stored = await (await alice.context().request.get("/api/settings")).json();
    const goals = Object.fromEntries(Object.entries(stored.goals.values as Record<string, number>).filter(([key]) => key !== "kcalBurnPct"));
    const count = Object.keys(goals).length;
    await openSettings(alice);
    await slow(goalsCard(alice).locator(".chip")).toHaveText(count ? `${count} set` : "none set");
    slow(await shownGoals(alice)).toEqual(Object.fromEntries(Object.entries(goals).map(([key, value]) => [key, String(value)])));
  });
});

// ── Garmin ──

test.describe("the Garmin account card, for a profile without a login", () => {
  test("the form is there: email, password, 'Connect Garmin', and 'Test login' disabled, as an optional connection", async ({ me }) => {
    await openSettings(me);
    const c = garminCard(me);
    await slow(c.locator(".chip")).toHaveText("not connected (optional)");
    await slow(c.getByLabel("Email", { exact: true })).toHaveValue("");
    await slow(c.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");
    await slow(c.getByRole("button", { name: "Connect Garmin" })).toBeEnabled();
    await slow(c.getByRole("button", { name: "Test login" })).toBeDisabled();
    await slow(c.getByRole("button", { name: "Disconnect Garmin" })).toHaveCount(0);
  });

  test("connecting with an email and no password says 'Enter the password.', and stores nothing", async ({ me, profile }) => {
    await openSettings(me);
    await garminCard(me).getByLabel("Email", { exact: true }).fill("runner@example.com");
    await garminCard(me).getByRole("button", { name: "Connect Garmin" }).click();
    await slow(errLine(garminCard(me))).toHaveText("Enter the password.");
    slow((await settingsOf(profile.api)).garmin).toEqual({ connected: false, email: null, hasPassword: false });
  });

  test("an email that is not one is refused: \"Enter the account's email address.\"", async ({ me, profile }) => {
    await openSettings(me);
    await garminCard(me).getByLabel("Email", { exact: true }).fill("not-an-email");
    await garminCard(me).getByLabel("Password", { exact: true }).fill("garmin-pass-1");
    await garminCard(me).getByRole("button", { name: "Connect Garmin" }).click();
    await slow(errLine(garminCard(me))).toHaveText("Enter the account's email address.");
    slow((await settingsOf(profile.api)).garmin.connected).toBe(false);
  });

  test("a login answered as saved shows 'Saved.', connected, with Disconnect; the request carries the typed email and password", async ({ me, profile }) => {
    const snapshot = await settingsOf(profile.api);
    const sent: unknown[] = [];
    await me.route("**/api/settings/garmin", async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: { ...snapshot, garmin: { connected: true, email: "runner@example.com", hasPassword: true } } });
    });
    await openSettings(me);
    await garminCard(me).getByLabel("Email", { exact: true }).fill("runner@example.com");
    await garminCard(me).getByLabel("Password", { exact: true }).fill("garmin-pass-1");
    await garminCard(me).getByRole("button", { name: "Connect Garmin" }).click();
    await slow(okLine(garminCard(me))).toHaveText("Saved.");
    await slow(garminCard(me).locator(".chip")).toHaveText("connected");
    await slow(garminCard(me).getByRole("button", { name: "Disconnect Garmin" })).toBeVisible();
    await slow(garminCard(me).getByRole("button", { name: "Test login" })).toBeEnabled();
    slow(sent).toEqual([{ profile: profile.name, action: "save", email: "runner@example.com", password: "garmin-pass-1" }]);
  });

  test("a save the server refuses shows its message, in red, and the card stays as it was", async ({ me, profile }) => {
    await me.route("**/api/settings/garmin", (route) => route.fulfill({ status: 500, json: { error: "The Garmin login could not be saved." } }));
    await openSettings(me);
    await garminCard(me).getByLabel("Email", { exact: true }).fill("runner@example.com");
    await garminCard(me).getByLabel("Password", { exact: true }).fill("garmin-pass-1");
    await garminCard(me).getByRole("button", { name: "Connect Garmin" }).click();
    await slow(errLine(garminCard(me))).toHaveText("The Garmin login could not be saved.");
    await slow(garminCard(me).locator(".chip")).toHaveText("not connected (optional)");
    await slow(garminCard(me).getByLabel("Email", { exact: true })).toHaveValue("runner@example.com");
    slow((await settingsOf(profile.api)).garmin.connected).toBe(false);
  });

  test("Test login (answered as accepted) reports Garmin's answer, and never reaches Garmin", async ({ me, profile }) => {
    const snapshot = await settingsOf(profile.api);
    const actions: string[] = [];
    await me.route("**/api/settings/garmin", async (route) => {
      const body = route.request().postDataJSON();
      actions.push(body.action);
      if (body.action === "save") return route.fulfill({ json: { ...snapshot, garmin: { connected: true, email: "runner@example.com", hasPassword: true } } });
      return route.fulfill({ json: { ok: true, message: "Garmin accepted the login.", ...snapshot, garmin: { connected: true, email: "runner@example.com", hasPassword: true } } });
    });
    await openSettings(me);
    await garminCard(me).getByLabel("Email", { exact: true }).fill("runner@example.com");
    await garminCard(me).getByLabel("Password", { exact: true }).fill("garmin-pass-1");
    await garminCard(me).getByRole("button", { name: "Connect Garmin" }).click();
    await slow(garminCard(me).getByRole("button", { name: "Test login" })).toBeEnabled();
    await garminCard(me).getByRole("button", { name: "Test login" }).click();
    await slow(okLine(garminCard(me))).toHaveText("Garmin accepted the login.");
    slow(actions).toEqual(["save", "test"]);
  });

  test("Test login (answered as refused) shows the reason in red", async ({ me, profile }) => {
    const snapshot = await settingsOf(profile.api);
    await me.route("**/api/settings/garmin", async (route) => {
      const body = route.request().postDataJSON();
      if (body.action === "test") return route.fulfill({ json: { ok: false, message: "Garmin refused the password.", ...snapshot, garmin: { connected: true, email: "runner@example.com", hasPassword: true } } });
      return route.fulfill({ json: { ...snapshot, garmin: { connected: true, email: "runner@example.com", hasPassword: true } } });
    });
    await openSettings(me);
    await garminCard(me).getByLabel("Email", { exact: true }).fill("runner@example.com");
    await garminCard(me).getByLabel("Password", { exact: true }).fill("garmin-pass-1");
    await garminCard(me).getByRole("button", { name: "Connect Garmin" }).click();
    await slow(garminCard(me).getByRole("button", { name: "Test login" })).toBeEnabled();
    await garminCard(me).getByRole("button", { name: "Test login" }).click();
    await slow(errLine(garminCard(me))).toHaveText("Garmin refused the password.");
  });

  test("Disconnect asks first: Cancel sends nothing and keeps the login", async ({ me, profile }) => {
    const snapshot = await settingsOf(profile.api);
    const actions: string[] = [];
    await me.route("**/api/settings/garmin", async (route) => {
      actions.push(route.request().postDataJSON().action);
      return route.fulfill({ json: { ...snapshot, garmin: { connected: true, email: "runner@example.com", hasPassword: true } } });
    });
    await openSettings(me);
    await garminCard(me).getByLabel("Email", { exact: true }).fill("runner@example.com");
    await garminCard(me).getByLabel("Password", { exact: true }).fill("garmin-pass-1");
    await garminCard(me).getByRole("button", { name: "Connect Garmin" }).click();
    await slow(garminCard(me).getByRole("button", { name: "Disconnect Garmin" })).toBeVisible();
    await garminCard(me).getByRole("button", { name: "Disconnect Garmin" }).click();
    await slow(me.locator("#dlgTitle")).toHaveText("Disconnect Garmin?");
    await me.locator("#dlgCancel").click();
    await slow(me.locator("#dlg")).toBeHidden();
    slow(actions).toEqual(["save"]);
    await slow(garminCard(me).locator(".chip")).toHaveText("connected");
  });

  test("Disconnect, confirmed, says 'Garmin is disconnected.' and the card goes back to the connect form", async ({ me, profile }) => {
    const snapshot = await settingsOf(profile.api);
    const actions: string[] = [];
    await me.route("**/api/settings/garmin", async (route) => {
      const body = route.request().postDataJSON();
      actions.push(body.action);
      if (body.action === "remove") return route.fulfill({ json: { ...snapshot, garmin: { connected: false, email: null, hasPassword: false } } });
      return route.fulfill({ json: { ...snapshot, garmin: { connected: true, email: "runner@example.com", hasPassword: true } } });
    });
    await openSettings(me);
    await garminCard(me).getByLabel("Email", { exact: true }).fill("runner@example.com");
    await garminCard(me).getByLabel("Password", { exact: true }).fill("garmin-pass-1");
    await garminCard(me).getByRole("button", { name: "Connect Garmin" }).click();
    await garminCard(me).getByRole("button", { name: "Disconnect Garmin" }).click();
    await me.locator("#dlgOk").click();
    await slow(okLine(garminCard(me))).toHaveText("Garmin is disconnected.");
    await slow(garminCard(me).getByRole("button", { name: "Connect Garmin" })).toBeVisible();
    slow(actions).toEqual(["save", "remove"]);
  });
});

// ── Renpho ──

test.describe("the Renpho scale card, for a profile without a login", () => {
  test("the form is there: email, password, the area code (US), 'Connect Renpho'; no sync controls until a login is saved", async ({ me }) => {
    await openSettings(me);
    const c = renphoCard(me);
    await slow(c.locator(".chip")).toHaveText("not connected (optional)");
    await slow(c.getByLabel("Renpho email", { exact: true })).toHaveValue("");
    await slow(c.getByLabel("Password", { exact: true })).toHaveValue("");
    await slow(c.getByLabel("Area code", { exact: true })).toHaveValue("US");
    await slow(c.getByRole("button", { name: "Connect Renpho" })).toBeEnabled();
    await slow(c.getByRole("button", { name: "Test login" })).toBeDisabled();
    await slow(c.getByRole("checkbox", { name: /Fetch my weigh-ins/ })).toHaveCount(0);
    await slow(c.getByRole("button", { name: "Sync now" })).toHaveCount(0);
  });

  test("an area code that is not two or three letters is refused, and no login is saved", async ({ me, profile }) => {
    await openSettings(me);
    await renphoCard(me).getByLabel("Renpho email", { exact: true }).fill("scale@example.com");
    await renphoCard(me).getByLabel("Password", { exact: true }).fill("scale-pass-123");
    await renphoCard(me).getByLabel("Area code", { exact: true }).fill("1");
    await renphoCard(me).getByRole("button", { name: "Connect Renpho" }).click();
    await slow(errLine(renphoCard(me))).toHaveText("The area code is two or three letters, such as US or CA.");
    slow((await settingsOf(profile.api)).renpho.account).toBeNull();
  });

  test("an email that is not one is refused: \"Enter the account's email address.\"", async ({ me, profile }) => {
    await openSettings(me);
    await renphoCard(me).getByLabel("Renpho email", { exact: true }).fill("not-an-email");
    await renphoCard(me).getByLabel("Password", { exact: true }).fill("scale-pass-123");
    await renphoCard(me).getByRole("button", { name: "Connect Renpho" }).click();
    await slow(errLine(renphoCard(me))).toHaveText("Enter the account's email address.");
    slow((await settingsOf(profile.api)).renpho.account).toBeNull();
  });

  test("a login with no password is refused: 'Enter the password.'", async ({ me, profile }) => {
    await openSettings(me);
    await renphoCard(me).getByLabel("Renpho email", { exact: true }).fill("scale@example.com");
    await renphoCard(me).getByRole("button", { name: "Connect Renpho" }).click();
    await slow(errLine(renphoCard(me))).toHaveText("Enter the password.");
    slow((await settingsOf(profile.api)).renpho.account).toBeNull();
  });

  test("saving a login stores it (no request leaves for Renpho): 'Login saved.', the email, the area code in capitals, and the sync switches", async ({ me, profile }) => {
    await openSettings(me);
    await renphoCard(me).getByLabel("Renpho email", { exact: true }).fill("scale@example.com");
    await renphoCard(me).getByLabel("Password", { exact: true }).fill("scale-pass-123");
    await renphoCard(me).getByLabel("Area code", { exact: true }).fill("ca");
    await renphoCard(me).getByRole("button", { name: "Connect Renpho" }).click();
    await slow(okLine(renphoCard(me))).toHaveText("Login saved.");
    await slow(renphoCard(me).locator(".chip")).toHaveText("Off");
    await slow(renphoCard(me).getByLabel("Renpho email", { exact: true })).toHaveValue("scale@example.com");
    await slow(renphoCard(me).getByLabel("Password", { exact: true })).toHaveValue("");
    await slow(renphoCard(me).getByLabel("Password", { exact: true })).toHaveAttribute("placeholder", "saved: leave empty to keep it");
    await slow(renphoCard(me).getByRole("checkbox", { name: /Fetch my weigh-ins/ })).not.toBeChecked();
    await slow(renphoCard(me).getByRole("button", { name: "Download the latest 3 as a FIT file" })).toBeDisabled();
    const saved = await settingsOf(profile.api);
    slow(saved.renpho.account).toEqual({ email: "scale@example.com", hasPassword: true });
    slow(saved.renpho.settings.areaCode).toBe("CA");
  });

  test("switching the fetch on shows 'On, waiting for the first run', and the log says so", async ({ me, profile }) => {
    await seedRenpho(profile);
    await openSettings(me);
    await renphoCard(me).getByRole("checkbox", { name: /Fetch my weigh-ins/ }).check();
    await slow(renphoCard(me).locator(".chip")).toHaveText("On, waiting for the first run");
    await slow(renphoCard(me).locator(".slog")).toContainText("Fetching from Renpho switched on.");
    slow((await settingsOf(profile.api)).renpho.settings.fetchEnabled).toBe(true);
  });

  test("the upload to Garmin cannot be switched on without a Garmin login: the card says to connect Garmin first", async ({ me, profile }) => {
    await seedRenpho(profile);
    await openSettings(me);
    const upload = renphoCard(me).getByRole("checkbox", { name: /Upload new weigh-ins to Garmin/ });
    await slow(upload).toBeDisabled();
    await slow(renphoCard(me)).toContainText("Connect Garmin first: the weigh-ins are uploaded to a Garmin account.");
  });

  test("Remove login asks first; confirmed, it says 'Login removed.' and the form comes back", async ({ me, profile }) => {
    await seedRenpho(profile);
    await openSettings(me);
    await renphoCard(me).getByRole("button", { name: "Remove login" }).click();
    await slow(me.locator("#dlgTitle")).toHaveText("Remove the Renpho login?");
    await me.locator("#dlgCancel").click();
    await slow(me.locator("#dlg")).toBeHidden();
    slow((await settingsOf(profile.api)).renpho.account).not.toBeNull();

    await renphoCard(me).getByRole("button", { name: "Remove login" }).click();
    await me.locator("#dlgOk").click();
    await slow(okLine(renphoCard(me))).toHaveText("Login removed.");
    await slow(renphoCard(me).locator(".chip")).toHaveText("not connected (optional)");
    slow((await settingsOf(profile.api)).renpho.account).toBeNull();
  });

  test("Test login (answered as accepted) shows Renpho's answer, and never reaches Renpho", async ({ me, profile }) => {
    await seedRenpho(profile);
    const actions: string[] = [];
    await me.route("**/api/settings/renpho", async (route) => {
      const body = route.request().postDataJSON();
      actions.push(body.action);
      if (body.action !== "test") return route.continue();
      return route.fulfill({ json: { ok: true, message: "Renpho accepted the login (1 scale table on the account).", ...(await settingsOf(profile.api)) } });
    });
    await openSettings(me);
    await renphoCard(me).getByRole("button", { name: "Test login" }).click();
    await slow(okLine(renphoCard(me))).toHaveText("Renpho accepted the login (1 scale table on the account).");
    slow(actions).toEqual(["test"]);
  });

  test("Sync now (answered with a run) reports the weigh-ins Renpho holds, and never reaches Renpho", async ({ me, profile }) => {
    await seedRenpho(profile);
    await me.route("**/api/settings/renpho", async (route) => {
      const body = route.request().postDataJSON();
      if (body.action !== "sync") return route.continue();
      return route.fulfill({ json: { run: { ran: true, error: null, seen: 3, added: 2, uploaded: 0 }, ...(await settingsOf(profile.api)) } });
    });
    await openSettings(me);
    await renphoCard(me).getByRole("button", { name: "Sync now" }).click();
    await slow(okLine(renphoCard(me))).toHaveText("Renpho holds 3 weigh-ins; 2 new.");
  });

  test("a run that failed says why, in red", async ({ me, profile }) => {
    await seedRenpho(profile);
    await me.route("**/api/settings/renpho", async (route) => {
      const body = route.request().postDataJSON();
      if (body.action !== "sync") return route.continue();
      return route.fulfill({ json: { run: { ran: true, error: "Renpho refused the login.", seen: 0, added: 0, uploaded: 0 }, ...(await settingsOf(profile.api)) } });
    });
    await openSettings(me);
    await renphoCard(me).getByRole("button", { name: "Sync now" }).click();
    await slow(errLine(renphoCard(me))).toHaveText("Renpho refused the login.");
  });
});

// ── web sign-in password ──

test.describe("the web sign-in password card", () => {
  test("a profile's card says its password is set, and asks for a new one typed twice", async ({ me }) => {
    await openSettings(me);
    const c = webCard(me);
    await slow(c.locator(".chip")).toHaveText("password set");
    await slow(c.getByLabel("New password", { exact: true })).toHaveValue("");
    await slow(c.getByLabel("Repeat password", { exact: true })).toHaveValue("");
    await slow(c.getByRole("button", { name: "Change password" })).toBeEnabled();
  });

  test("two passwords that differ are said so as they are typed, and Change password refuses them with no request", async ({ me, profile, baseURL }) => {
    const writes = writesOf(me);
    await openSettings(me);
    await webCard(me).getByLabel("New password", { exact: true }).fill("longenough1");
    await webCard(me).getByLabel("Repeat password", { exact: true }).fill("longenough2");
    await slow(webCard(me).locator(".sline.err:visible")).toHaveText("The two passwords are not the same.");
    await webCard(me).getByRole("button", { name: "Change password" }).click();
    await slow(errLine(webCard(me))).toHaveText("The two passwords are not the same.");
    slow(writes).toEqual([]);
    slow(await signsIn(baseURL, profile.name, PASSWORD)).toBe(200);
  });

  test("a password under 8 characters is refused, and so is a 7-character one", async ({ me, profile, baseURL }) => {
    const writes = writesOf(me);
    await openSettings(me);
    await webCard(me).getByLabel("New password", { exact: true }).fill("short");
    await webCard(me).getByLabel("Repeat password", { exact: true }).fill("short");
    await webCard(me).getByRole("button", { name: "Change password" }).click();
    await slow(errLine(webCard(me))).toHaveText("The password is at least 8 characters.");
    await webCard(me).getByLabel("New password", { exact: true }).fill("1234567");
    await webCard(me).getByLabel("Repeat password", { exact: true }).fill("1234567");
    await webCard(me).getByRole("button", { name: "Change password" }).click();
    await slow(errLine(webCard(me))).toHaveText("The password is at least 8 characters.");
    slow(writes).toEqual([]);
    slow(await signsIn(baseURL, profile.name, PASSWORD)).toBe(200);
  });

  test("an empty password is refused: 'Enter a password.'", async ({ me }) => {
    await openSettings(me);
    await webCard(me).getByRole("button", { name: "Change password" }).click();
    await slow(errLine(webCard(me))).toHaveText("Enter a password.");
  });

  test("changing the password says 'Password saved.' and clears the fields; the old password stops signing in, the new one signs in", async ({ me, profile, baseURL }) => {
    await openSettings(me);
    await webCard(me).getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await webCard(me).getByLabel("Repeat password", { exact: true }).fill(NEW_PASSWORD);
    await webCard(me).getByRole("button", { name: "Change password" }).click();
    await slow(okLine(webCard(me))).toHaveText("Password saved.");
    await slow(webCard(me).getByLabel("New password", { exact: true })).toHaveValue("");
    await slow(webCard(me).getByLabel("Repeat password", { exact: true })).toHaveValue("");
    await slow(me.locator("body")).not.toContainText(NEW_PASSWORD);
    slow(await signsIn(baseURL, profile.name, PASSWORD)).toBe(401);
    slow(await signsIn(baseURL, profile.name, NEW_PASSWORD)).toBe(200);
  });

  test("the browser that changed it stays signed in; another browser signed in with the old password is signed out", async ({ me, profile, browser, baseURL }) => {
    const other = await browser.newContext({ baseURL });
    try {
      await loginAs(other, profile.name, PASSWORD);
      slow((await other.request.get("/api/settings")).status()).toBe(200);
      await openSettings(me);
      await webCard(me).getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
      await webCard(me).getByLabel("Repeat password", { exact: true }).fill(NEW_PASSWORD);
      await webCard(me).getByRole("button", { name: "Change password" }).click();
      await slow(okLine(webCard(me))).toHaveText("Password saved.");
      slow((await other.request.get("/api/settings")).status()).toBe(401);
      slow((await me.context().request.get("/api/settings")).status()).toBe(200);
      await me.reload();
      await ready(me);
      await slow(me.locator("#login")).toBeHidden();
      await slow(me.locator("#sbody .scard")).toHaveCount(4);
    } finally {
      await other.close();
    }
  });

  test("the server refuses a short password and a mismatched pair too, with the same words", async ({ profile, baseURL }) => {
    const short = await profile.api.post("/api/settings/web", { data: { profile: profile.name, action: "save", password: "short", confirm: "short" } });
    slow(short.status()).toBe(400);
    slow((await short.json()).error).toBe("The password is at least 8 characters.");
    const mismatch = await profile.api.post("/api/settings/web", { data: { profile: profile.name, action: "save", password: "longenough1", confirm: "longenough2" } });
    slow(mismatch.status()).toBe(400);
    slow((await mismatch.json()).error).toBe("The two passwords are not the same.");
    slow(await signsIn(baseURL, profile.name, PASSWORD)).toBe(200);
  });

  test("the password is kept as a hash: Settings never gives it back, only that one is set", async ({ profile }) => {
    const settings = await settingsOf(profile.api);
    slow(settings.web).toEqual({ hasPassword: true });
    slow(JSON.stringify(settings)).not.toContain(PASSWORD);
  });
});

// ── the admin: adding a profile and choosing which one Settings shows ──

test.describe("the admin's profile controls", () => {
  test("the admin sees '+ Add profile' and the profile selector", async ({ adminPage }) => {
    await openSettings(adminPage);
    await slow(adminPage.locator("#sAddProfile")).toBeVisible();
    await slow(adminPage.locator("#sAddProfile")).toHaveText("+ Add profile");
    await slow(adminPage.locator("#sProfile")).toBeVisible();
    await slow(adminPage.locator("#sProfile option", { hasText: "alice" })).toHaveCount(1);
  });

  test("the add-profile dialog opens empty, says what a profile is for, and asks for the password twice", async ({ adminPage }) => {
    await openSettings(adminPage);
    await adminPage.locator("#sAddProfile").click();
    const dlg = adminPage.locator("#pdlg");
    await slow(dlg).toBeVisible();
    await slow(dlg.locator(".dhead")).toHaveText("Add a profile");
    await slow(dlg).toContainText("A profile keeps its own plans, calendar and food log.");
    await slow(adminPage.locator("#pdlgName")).toHaveValue("");
    await slow(adminPage.locator("#pdlgPass")).toHaveValue("");
    await slow(adminPage.locator("#pdlgPass2")).toHaveValue("");
    await adminPage.locator("#pdlgCancel").click();
    await slow(dlg).toBeHidden();
  });

  test("a name with a space or a symbol is refused, and the dialog stays open", async ({ adminPage }) => {
    await openSettings(adminPage);
    await adminPage.locator("#sAddProfile").click();
    await adminPage.locator("#pdlgName").fill("bad name!");
    await adminPage.locator("#pdlgPass").fill("longenough1");
    await adminPage.locator("#pdlgPass2").fill("longenough1");
    await adminPage.locator("#pdlgOk").click();
    await slow(adminPage.locator("#pdlgError")).toHaveText("A profile name is letters, numbers, hyphens and underscores, at most 64.");
    await slow(adminPage.locator("#pdlg")).toBeVisible();
    await adminPage.locator("#pdlgName").fill("");
    await adminPage.locator("#pdlgOk").click();
    await slow(adminPage.locator("#pdlgError")).toHaveText("A profile name is letters, numbers, hyphens and underscores, at most 64.");
  });

  test("a name longer than 64 characters is refused", async ({ adminPage }) => {
    await openSettings(adminPage);
    await adminPage.locator("#sAddProfile").click();
    await adminPage.locator("#pdlgName").fill("a".repeat(65));
    await adminPage.locator("#pdlgPass").fill("longenough1");
    await adminPage.locator("#pdlgPass2").fill("longenough1");
    await adminPage.locator("#pdlgOk").click();
    await slow(adminPage.locator("#pdlgError")).toHaveText("A profile name is letters, numbers, hyphens and underscores, at most 64.");
  });

  test("a missing password is refused: 'Enter a password.'", async ({ adminPage }) => {
    await openSettings(adminPage);
    await adminPage.locator("#sAddProfile").click();
    await adminPage.locator("#pdlgName").fill(freshName("pdmiss"));
    await adminPage.locator("#pdlgOk").click();
    await slow(adminPage.locator("#pdlgError")).toHaveText("Enter a password.");
    await slow(adminPage.locator("#pdlg")).toBeVisible();
  });

  test("a password under 8 characters is refused", async ({ adminPage }) => {
    await openSettings(adminPage);
    await adminPage.locator("#sAddProfile").click();
    await adminPage.locator("#pdlgName").fill(freshName("pdshort"));
    await adminPage.locator("#pdlgPass").fill("short");
    await adminPage.locator("#pdlgPass2").fill("short");
    await adminPage.locator("#pdlgOk").click();
    await slow(adminPage.locator("#pdlgError")).toHaveText("The password is at least 8 characters.");
  });

  test("two passwords that differ are refused: 'The two passwords are not the same.'", async ({ adminPage }) => {
    await openSettings(adminPage);
    await adminPage.locator("#sAddProfile").click();
    await adminPage.locator("#pdlgName").fill(freshName("pdmismatch"));
    await adminPage.locator("#pdlgPass").fill("longenough1");
    await adminPage.locator("#pdlgPass2").fill("longenough2");
    await adminPage.locator("#pdlgOk").click();
    await slow(adminPage.locator("#pdlgError")).toHaveText("The two passwords are not the same.");
    await slow(adminPage.locator("#pdlg")).toBeVisible();
  });

  test("a name that is taken is refused by the server, whatever its case: 'Profile \"alice\" exists already.'", async ({ adminPage }) => {
    await openSettings(adminPage);
    await adminPage.locator("#sAddProfile").click();
    await adminPage.locator("#pdlgName").fill("ALICE");
    await adminPage.locator("#pdlgPass").fill("longenough1");
    await adminPage.locator("#pdlgPass2").fill("longenough1");
    await adminPage.locator("#pdlgOk").click();
    await slow(adminPage.locator("#pdlgError")).toHaveText('Profile "alice" exists already.');
    await slow(adminPage.locator("#pdlg")).toBeVisible();
  });

  test("Cancel closes the dialog and adds nothing", async ({ adminPage }) => {
    await openSettings(adminPage);
    const before = await adminPage.locator("#sProfile option").count();
    await adminPage.locator("#sAddProfile").click();
    await adminPage.locator("#pdlgName").fill(freshName("pdcancel"));
    await adminPage.locator("#pdlgPass").fill("longenough1");
    await adminPage.locator("#pdlgPass2").fill("longenough1");
    await adminPage.locator("#pdlgCancel").click();
    await slow(adminPage.locator("#pdlg")).toBeHidden();
    await slow(adminPage.locator("#sProfile option")).toHaveCount(before);
  });

  test("Escape closes the dialog and adds nothing", async ({ adminPage }) => {
    await openSettings(adminPage);
    const before = await adminPage.locator("#sProfile option").count();
    await adminPage.locator("#sAddProfile").click();
    await adminPage.locator("#pdlgName").fill(freshName("pdesc"));
    await adminPage.keyboard.press("Escape");
    await slow(adminPage.locator("#pdlg")).toBeHidden();
    await slow(adminPage.locator("#sProfile option")).toHaveCount(before);
  });

  test("a profile added is in the selector, Settings opens on it with nothing set, and it signs in with the password chosen", async ({ adminPage, baseURL }) => {
    const name = freshName("pdnew");
    await openSettings(adminPage);
    await adminPage.locator("#sAddProfile").click();
    await adminPage.locator("#pdlgName").fill(name);
    await adminPage.locator("#pdlgPass").fill(PROFILE_PASSWORD);
    await adminPage.locator("#pdlgPass2").fill(PROFILE_PASSWORD);
    await adminPage.locator("#pdlgOk").click();
    await slow(adminPage.locator("#pdlg")).toBeHidden();
    await slow(adminPage.locator("#sProfile")).toHaveValue(name);
    await slow(adminPage.locator("#sProfile option", { hasText: name })).toHaveCount(1);
    await slow(goalsCard(adminPage).locator(".chip")).toHaveText("none set");
    await slow(webCard(adminPage).locator(".chip")).toHaveText("password set");
    await slow(garminCard(adminPage).locator(".chip")).toHaveText("not connected (optional)");
    await slow(renphoCard(adminPage).locator(".chip")).toHaveText("not connected (optional)");
    slow(await signsIn(baseURL, name, PROFILE_PASSWORD)).toBe(200);
  });

  test("Enter in the password field adds the profile", async ({ adminPage }) => {
    const name = freshName("pdenter");
    await openSettings(adminPage);
    await adminPage.locator("#sAddProfile").click();
    await adminPage.locator("#pdlgName").fill(name);
    await adminPage.locator("#pdlgPass").fill(PROFILE_PASSWORD);
    await adminPage.locator("#pdlgPass2").fill(PROFILE_PASSWORD);
    await adminPage.locator("#pdlgPass2").press("Enter");
    await slow(adminPage.locator("#sProfile")).toHaveValue(name);
  });

  test("choosing a profile in the selector shows its goals: alice's 2200 kcal, 130 g protein, 250 g carbs, 70 g fat", async ({ adminPage }) => {
    await openSettings(adminPage);
    await adminPage.locator("#sProfile").selectOption("alice");
    await slow(goalField(adminPage, "kcal")).toHaveValue("2200");
    await slow(goalField(adminPage, "proteinG")).toHaveValue("130");
    await slow(goalField(adminPage, "carbsG")).toHaveValue("250");
    await slow(goalField(adminPage, "fatG")).toHaveValue("70");
    await slow(goalsCard(adminPage).locator(".chip")).toHaveText("4 set");
  });

  test("choosing a profile with no goals shows none set, not the goals of the one before", async ({ adminPage, profile }) => {
    await openSettings(adminPage);
    await adminPage.locator("#sProfile").selectOption("alice");
    await slow(goalField(adminPage, "kcal")).toHaveValue("2200");
    await adminPage.locator("#sProfile").selectOption(profile.name);
    await slow(goalsCard(adminPage).locator(".chip")).toHaveText("none set");
    await slow(goalField(adminPage, "kcal")).toHaveValue("");
    await slow(webCard(adminPage).locator(".chip")).toHaveText("password set");
  });

  test("what was typed for one profile is not carried to another when the selector changes", async ({ adminPage, profile }) => {
    await openSettings(adminPage);
    await adminPage.locator("#sProfile").selectOption(profile.name);
    await slow(goalsCard(adminPage).locator(".chip")).toHaveText("none set");
    await goalField(adminPage, "kcal").fill("1777");
    await adminPage.locator("#sProfile").selectOption("alice");
    await slow(goalField(adminPage, "kcal")).toHaveValue("2200");
    await adminPage.locator("#sProfile").selectOption(profile.name);
    await slow(goalField(adminPage, "kcal")).toHaveValue("");
  });

  test("a goal the admin saves goes to the profile chosen, not to the one shown first", async ({ adminPage, profile }) => {
    await openSettings(adminPage);
    await adminPage.locator("#sProfile").selectOption(profile.name);
    await slow(goalsCard(adminPage).locator(".chip")).toHaveText("none set");
    await goalField(adminPage, "kcal").fill("1900");
    await goalsCard(adminPage).getByRole("button", { name: "Save goals" }).click();
    await slow(okLine(goalsCard(adminPage))).toHaveText("Goals saved.");
    slow((await settingsOf(profile.api)).goals.values).toEqual({ kcal: 1900 });
    slow((await (await adminPage.context().request.get("/api/settings?profile=alice")).json()).goals.values).toMatchObject({ kcal: 2200 });
  });
});

// ── a profile's own Settings ──

test.describe("a profile's own Settings", () => {
  test("a profile sees no profile selector and no '+ Add profile', and its only profile is itself", async ({ me, profile }) => {
    await openSettings(me);
    await slow(me.locator("#sProfile")).toBeHidden();
    await slow(me.locator("#sAddProfile")).toBeHidden();
    slow(await me.locator("#sProfile option").allTextContents()).toEqual([profile.name]);
  });

  test("the page of a profile shows no other profile's name", async ({ me }) => {
    await openSettings(me);
    await slow(me.locator("#sbody")).not.toContainText("alice");
    await slow(me.locator("#sbody")).not.toContainText("bob");
  });

  test("the server refuses a profile's attempt to add a profile", async ({ profile }) => {
    const res = await profile.api.post("/api/profiles", { data: { name: freshName("pdself"), password: PROFILE_PASSWORD, confirm: PROFILE_PASSWORD } });
    slow(res.status()).toBe(403);
    slow((await res.json()).error).toBe("Only the admin login can add a profile.");
  });

  test("asking for another profile's settings gives the profile's own", async ({ profile }) => {
    const settings = await settingsOf(profile.api, "?profile=alice");
    slow(settings.profile).toBe(profile.name);
    slow(settings.goals.values).toEqual({});
  });

  test("a goal saved naming another profile is saved to the profile's own, and alice's are untouched", async ({ profile, baseURL }) => {
    const res = await profile.api.post("/api/settings/goals", { data: { profile: "alice", action: "save", goals: { kcal: 1234 } } });
    slow(res.ok()).toBeTruthy();
    slow((await settingsOf(profile.api)).goals.values).toEqual({ kcal: 1234 });
    const alice = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { ...CSRF, ...basic("alice", PASSWORD) } });
    try {
      slow((await settingsOf(alice)).goals.values).toMatchObject({ kcal: 2200 });
    } finally {
      await alice.dispose();
    }
  });
});

// ── the Settings view as a whole ──

test.describe("the Settings view", () => {
  test("the four cards come in order: nutrition goals, Garmin, Renpho, web sign-in; the note is never shown", async ({ me }) => {
    await openSettings(me);
    await slow(me.locator("#sbody h2").nth(0)).toContainText("Nutrition goals");
    await slow(me.locator("#sbody h2").nth(1)).toContainText("Garmin account");
    await slow(me.locator("#sbody h2").nth(2)).toContainText("Renpho scale");
    await slow(me.locator("#sbody h2").nth(3)).toContainText("Web sign-in");
    await slow(me.locator("#sNote")).toBeHidden();
  });

  test("the encryption note says what the server holds: plain text when CREDENTIALS_KEY is not set", async ({ me, profile }) => {
    const settings = await settingsOf(profile.api);
    await openSettings(me);
    const banner = me.locator("#sbody > .sline").first();
    if (settings.encryption.enabled && settings.encryption.plain === 0) await slow(banner).toHaveText("Saved passwords are encrypted in the database (CREDENTIALS_KEY).");
    else if (!settings.encryption.enabled) await slow(banner).toContainText("Saved passwords are stored as plain text in the database.");
    else await slow(banner).toContainText("is still plain text");
  });

  test("alice's Settings show her cards: Garmin and Renpho not connected, the password set (read only)", async ({ alice }) => {
    await openSettings(alice);
    await slow(garminCard(alice).locator(".chip")).toHaveText("not connected (optional)");
    await slow(renphoCard(alice).locator(".chip")).toHaveText("not connected (optional)");
    await slow(webCard(alice).locator(".chip")).toHaveText("password set");
  });
});
