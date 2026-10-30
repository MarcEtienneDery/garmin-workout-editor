/**
 * Signing in, staying signed in and signing out, in the page, and what each login is shown.
 *
 * Wrong passwords are counted per client address by the server (ten in a minute and the address waits), so this file sends
 * at most two: the wrong password of alice and the unknown user. Everything else signs in with the right secret.
 */
import type { Page } from "@playwright/test";
import { test, expect as baseExpect, loginAs, daysAgo, CSRF, PASSWORD, ADMIN_TOKEN } from "../support/fixtures";

// This file shares one server with every other run: on a busy machine one answer (the session, the Garmin state) can take several
// seconds, so a check waits up to 45 seconds and a test up to two minutes. The assertions themselves are the same.
const expect = baseExpect.configure({ timeout: 45_000 });
test.describe.configure({ timeout: 120_000 });

/** Open a view of the page, signed in already, and wait until it is drawn (the fixtures' versions keep the shorter default wait). */
async function openView(page: Page, view: string): Promise<void> {
  await page.goto(view === "today" ? "/" : `/#${view}`);
  await expect(page.locator("#login")).toBeHidden();
  await expect(page.locator("#views")).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute("data-view", view);
}

/** The page is signed in and its header is up. */
async function ready(page: Page): Promise<void> {
  await expect(page.locator("#login")).toBeHidden();
  await expect(page.locator("#views")).toBeVisible();
}

/** What the form says for a wrong user name or password, whether or not the profile exists. */
const WRONG = "Wrong user name or password.";

/** Fill in the sign-in form and press its button. */
async function signIn(page: Page, user: string, password: string): Promise<void> {
  await page.locator("#loginUser").fill(user);
  await page.locator("#loginPass").fill(password);
  await page.locator("#loginSubmit").click();
}

/** The page's session check, which every load makes once: it is what decides whether the form shows. */
const sessionCheck = (r: { url(): string }) => new URL(r.url()).pathname === "/api/session";

/** Open the account menu and sign out from it; the page reloads and asks the session check whether to show the form. */
async function signOutFromMenu(page: Page): Promise<void> {
  await page.locator("#accountBtn").click();
  const reloaded = page.waitForResponse(sessionCheck);
  await page.locator("#logout").click();
  await reloaded;
  await expect(page.locator("#login")).toBeVisible();
}

/** Reload the page and wait for the session check that decides whether the form shows. */
async function reloadPage(page: Page): Promise<void> {
  const checked = page.waitForResponse(sessionCheck);
  await page.reload();
  await checked;
}

/** Open Settings from the account menu. */
async function openSettings(page: Page): Promise<void> {
  await page.locator("#accountBtn").click();
  await page.locator("#openSettings").click();
  await expect(page.locator("#sview")).toBeVisible();
}

/** A nutrition answer for a profile, and for a day when one is asked for (the Food view's own query). */
const foodAnswer = (profile: string, date: string | null) => (r: { url(): string }) => {
  const url = new URL(r.url());
  return url.pathname === "/api/nutrition" && url.searchParams.get("profile") === profile && url.searchParams.get("date") === date;
};

/** Open the Food view, then choose the profile (the admin's picker opens on a default one), and wait until today is drawn. */
async function foodFor(page: Page, profile: string): Promise<void> {
  const first = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/nutrition");
  await openView(page, "food");
  await first;
  if ((await page.locator("#fProfile").inputValue()) !== profile) await pickFoodProfile(page, profile);
  await expect(page.locator("#fbody")).toContainText("Today");
}

/** Pick a profile in the Food view and wait until its day is in. */
async function pickFoodProfile(page: Page, profile: string): Promise<void> {
  const answered = page.waitForResponse(foodAnswer(profile, null));
  await page.locator("#fProfile").selectOption(profile);
  await answered;
  await expect(page.locator("#fbody")).toContainText("Today");
}

/** Step the Food view back one day for a profile, and wait until that day is in. */
async function stepFoodBack(page: Page, profile: string): Promise<void> {
  const answered = page.waitForResponse(foodAnswer(profile, daysAgo(1)));
  await page.locator("#fPrev").click();
  await answered;
}

/** The paths of the API calls a page makes, in order. */
function trackApi(page: Page): string[] {
  const calls: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/api/")) calls.push(`${r.method()} ${url.pathname}`);
  });
  return calls;
}

test.describe("the sign-in form", () => {
  test("a signed-out page shows the form and asks the server for nothing but the session", async ({ page }) => {
    const calls = trackApi(page);
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await expect(page.locator("#loginForm")).toBeVisible();
    await expect(page.locator("#loginUser")).toBeVisible();
    await expect(page.locator("#loginPass")).toHaveAttribute("type", "password");
    await expect(page.locator("#loginError")).toBeHidden();
    await expect(page.locator("#account")).toBeHidden();
    expect(calls).toEqual(["GET /api/session"]);
  });

  test("the fields are labelled and the button says Sign in", async ({ page }) => {
    await page.goto("/");
    const form = page.locator("#loginForm");
    await expect(form.getByLabel("User name", { exact: true })).toHaveAttribute("id", "loginUser");
    await expect(form.getByLabel("Password", { exact: true })).toHaveAttribute("id", "loginPass");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  });

  test("empty fields are refused by the form and nothing is sent", async ({ page }) => {
    const calls = trackApi(page);
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await page.locator("#loginSubmit").click();
    await expect(page.locator("#loginUser")).toBeFocused();
    expect(await page.locator("#loginUser").evaluate((el: HTMLInputElement) => el.validationMessage)).not.toBe("");
    await expect(page.locator("#login")).toBeVisible();
    await page.locator("#loginUser").fill("alice");
    await page.locator("#loginSubmit").click();
    await expect(page.locator("#loginPass")).toBeFocused();
    expect(await page.locator("#loginPass").evaluate((el: HTMLInputElement) => el.validationMessage)).not.toBe("");
    await expect(page.locator("#login")).toBeVisible();
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual([]);
  });

  test("Enter in the user name with no password moves to the password and sends nothing", async ({ page }) => {
    const calls = trackApi(page);
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await page.locator("#loginUser").fill("alice");
    await page.locator("#loginUser").press("Enter");
    await expect(page.locator("#loginPass")).toBeFocused();
    await expect(page.locator("#login")).toBeVisible();
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual([]);
  });

  test("Enter in the password field submits the form", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await page.locator("#loginUser").fill("alice");
    await page.locator("#loginPass").fill(PASSWORD);
    await page.locator("#loginPass").press("Enter");
    await expect(page.locator("#login")).toBeHidden();
    await expect(page.locator("#accountName")).toHaveText("alice");
  });

  test("a wrong password shows the error and the page stays signed out", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await signIn(page, "alice", "not the password");
    await expect(page.locator("#loginError")).toBeVisible();
    await expect(page.locator("#loginError")).toHaveText(WRONG);
    await expect(page.locator("#login")).toBeVisible();
    await expect(page.locator("#account")).toBeHidden();
    await expect(page.locator("#views")).toBeVisible(); // the page behind is there, with nothing in it
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === "plan_editor_session")).toBeUndefined();
  });

  test("an unknown user name gets the same message as a wrong password", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await signIn(page, "no-such-person-here", PASSWORD);
    await expect(page.locator("#loginError")).toHaveText(WRONG);
    await expect(page.locator("#login")).toBeVisible();
    await expect(page.locator("#account")).toBeHidden();
  });

  test("the password is cleared when the form signs in, and never kept in the browser", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await signIn(page, "alice", PASSWORD);
    await expect(page.locator("#login")).toBeHidden();
    await expect(page.locator("#loginPass")).toHaveValue("");
    const stored = await page.evaluate(() => {
      const all: string[] = [];
      for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i++) all.push(store.key(i) + "=" + store.getItem(store.key(i)!));
      return all.join("\n") + document.cookie;
    });
    expect(stored).not.toContain(PASSWORD);
  });

  test("after a sign-out the form remembers the user name, not the password", async ({ page, profile }) => {
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await signIn(page, profile.name, profile.password);
    await ready(page);
    await signOutFromMenu(page);
    await expect(page.locator("#loginUser")).toHaveValue(profile.name);
    await expect(page.locator("#loginPass")).toHaveValue("");
  });
});

test.describe("signing in", () => {
  test("a profile signs in with its name and password and lands on Today", async ({ page, profile }) => {
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await signIn(page, profile.name, profile.password);
    await expect(page.locator("#login")).toBeHidden();
    await ready(page);
    await expect(page.locator("body")).toHaveAttribute("data-view", "today");
    await expect(page.locator("#vToday")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#tTitle")).not.toBeEmpty();
    await expect(page.locator("#accountName")).toHaveText(profile.name);
  });

  test("a profile name is matched in any case", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await signIn(page, "ALICE", PASSWORD);
    await ready(page);
    await expect(page.locator("#accountName")).toHaveText("alice");
    await expect(page.locator("#accountWho")).toHaveText("alice");
  });

  test("the account menu shows who is signed in and what the login is for", async ({ me, profile }) => {
    await openView(me, "today");
    await expect(me.locator("#accountBtn")).toHaveAttribute("aria-expanded", "false");
    await me.locator("#accountBtn").click();
    await expect(me.locator("#accountBtn")).toHaveAttribute("aria-expanded", "true");
    await expect(me.locator("#accountMenu")).toBeVisible();
    await expect(me.locator("#accountWho")).toHaveText(profile.name);
    await expect(me.locator("#accountRole")).toHaveText("Profile login: your plans and Garmin account.");
    await expect(me.locator("#logout")).toHaveText("Sign out");
    await expect(me.locator("#accountBtn")).toHaveAttribute("title", "Signed in as " + profile.name);
  });

  test("the admin token signs in as the administrator under any user name", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await signIn(page, "anyone-at-all", ADMIN_TOKEN);
    await ready(page);
    await expect(page.locator("#accountName")).toHaveText("Admin");
    await expect(page.locator("#accountWho")).toHaveText("Admin");
    await expect(page.locator("#accountRole")).toHaveText("Administrator: all profiles.");
  });

  test("the admin token also signs in under a profile's name, as the administrator", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await signIn(page, "bob", ADMIN_TOKEN);
    await ready(page);
    await expect(page.locator("#accountName")).toHaveText("Admin");
  });

  test("the admin sees every profile in the pickers", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await signIn(page, "whoever", ADMIN_TOKEN);
    await ready(page);
    await expect(page.locator("#tProfile")).toBeVisible();
    await expect(page.locator('#tProfile option[value="alice"]')).toHaveCount(1);
    await expect(page.locator('#tProfile option[value="bob"]')).toHaveCount(1);
    await openSettings(page);
    await expect(page.locator("#sProfile")).toBeVisible();
    await expect(page.locator('#sProfile option[value="alice"]')).toHaveCount(1);
    await expect(page.locator('#sProfile option[value="bob"]')).toHaveCount(1);
  });
});

test.describe("staying signed in", () => {
  test("the session survives a reload", async ({ me, profile }) => {
    await openView(me, "today");
    await reloadPage(me);
    await ready(me);
    await expect(me.locator("#login")).toBeHidden();
    await expect(me.locator("#accountName")).toHaveText(profile.name);
  });

  test("the session carries into a new tab of the same browser", async ({ me, profile }) => {
    await openView(me, "today");
    const tab = await me.context().newPage();
    await tab.goto("/");
    await ready(tab);
    await expect(tab.locator("#accountName")).toHaveText(profile.name);
    await tab.close();
  });

  test("the session cookie is HttpOnly and SameSite=Strict, and the page's script cannot read it", async ({ me }) => {
    await openView(me, "today");
    const cookie = (await me.context().cookies()).find((c) => c.name === "plan_editor_session");
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe("Strict");
    expect(cookie!.path).toBe("/");
    expect(cookie!.secure).toBe(false); // plain http on 127.0.0.1
    expect(await me.evaluate(() => document.cookie)).not.toContain("plan_editor_session");
  });

  test("a session that ends while the page is open shows the form, and signing in again returns to the page", async ({ me, profile }) => {
    await openView(me, "plans");
    await expect(me.locator("#filelist")).toBeVisible();
    // the session is ended on the server (as if signed out in another window)
    await me.context().request.post("/api/logout", { headers: CSRF });
    await me.locator("#vCalendar").click();
    await expect(me.locator("#login")).toBeVisible();
    await expect(me.locator("#loginError")).toHaveText("Your session has ended. Sign in again.");
    await me.locator("#loginUser").fill(profile.name);
    await me.locator("#loginPass").fill(profile.password);
    await me.locator("#loginSubmit").click();
    await expect(me.locator("#login")).toBeHidden();
    await expect(me.locator("#toast")).toHaveText("Signed in again");
    await expect(me.locator("#accountName")).toHaveText(profile.name);
  });

  test("changing a profile's password ends the sessions made with the old one", async ({ me, profile, admin }) => {
    await openView(me, "today");
    const next = "a new password 42";
    const saved = await admin.post("/api/settings/web", { data: { profile: profile.name, action: "save", password: next, confirm: next } });
    expect(saved.ok()).toBeTruthy();
    expect((await me.context().request.get("/api/files")).status()).toBe(401);
    const again = await me.context().request.post("/api/login", { data: { user: profile.name, password: next }, headers: CSRF });
    expect(again.status()).toBe(200);
    expect((await me.context().request.get("/api/files")).status()).toBe(200);
  });
});

test.describe("signing out", () => {
  test("Sign out returns to the form and removes the session cookie", async ({ me }) => {
    await openView(me, "today");
    await signOutFromMenu(me);
    await expect(me.locator("#loginError")).toBeHidden();
    const cookies = await me.context().cookies();
    expect(cookies.find((c) => c.name === "plan_editor_session")).toBeUndefined();
  });

  test("a reload after sign-out stays signed out", async ({ me }) => {
    await openView(me, "today");
    await signOutFromMenu(me);
    await reloadPage(me);
    await expect(me.locator("#login")).toBeVisible();
    await expect(me.locator("#account")).toBeHidden();
  });

  test("a new tab after sign-out also shows the form", async ({ me }) => {
    await openView(me, "today");
    await signOutFromMenu(me);
    const tab = await me.context().newPage();
    await tab.goto("/");
    await expect(tab.locator("#login")).toBeVisible();
    await tab.close();
  });

  test("after sign-out the API refuses this browser, even with a valid login header", async ({ me, profile }) => {
    await openView(me, "today");
    await signOutFromMenu(me);
    expect((await me.context().request.get("/api/files")).status()).toBe(401);
    expect((await me.context().request.get("/api/today")).status()).toBe(401);
    expect((await me.context().request.post("/api/validate", { headers: CSRF, data: { text: "{}" } })).status()).toBe(401);
    const basic = `Basic ${Buffer.from(`${profile.name}:${profile.password}`).toString("base64")}`;
    expect((await me.context().request.get("/api/files", { headers: { Authorization: basic } })).status()).toBe(401);
  });
});

test.describe("what each login is shown", () => {
  test("bob's Plans list holds the shared plan and none of alice's", async ({ page }) => {
    await loginAs(page, "bob", PASSWORD);
    await openView(page, "plans");
    await expect(page.locator("#filelist .file", { hasText: "shared-base.json" })).toHaveCount(1);
    await expect(page.locator("#filelist")).not.toContainText("alice-run-block.json");
    await expect(page.locator("#filelist")).not.toContainText("alice-someday.json");
  });

  test("bob's Today has none of alice's workouts", async ({ page }) => {
    await loginAs(page, "bob", PASSWORD);
    await openView(page, "today");
    await expect(page.locator("#tbody")).not.toContainText("Loading");
    await expect(page.locator("#tbody")).toContainText("Shared walk");
    await expect(page.locator("#tbody")).not.toContainText("Tempo intervals");
    await expect(page.locator("#tbody")).not.toContainText("Long run");
    await expect(page.locator("#tbody")).not.toContainText("Full body strength");
  });

  test("bob's Food holds none of alice's meals, on the day alice logged them too", async ({ page }) => {
    await loginAs(page, "bob", PASSWORD);
    await foodFor(page, "bob");
    await stepFoodBack(page, "bob");
    await expect(page.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(page.locator("#fbody")).toContainText("Breakdown");
    await expect(page.locator("#fbody")).not.toContainText("Oatmeal");
    await expect(page.locator("#fbody")).not.toContainText("Salmon and rice");
  });

  test("bob has no Activities or Recovery view, and an address to one of them opens Today", async ({ page }) => {
    await loginAs(page, "bob", PASSWORD);
    await openView(page, "today");
    await expect(page.locator("#vActivities")).toBeHidden();
    await expect(page.locator("#vRecovery")).toBeHidden();
    await expect(page.locator("#vWeight")).toBeHidden();
    await expect(page.locator("#vWorkouts")).toBeHidden();
    await expect(page.locator("#views button:visible")).toHaveText(["Today", "Plans", "Calendar", "Food"]);
    const tab = await page.context().newPage(); // a fresh load of the address, signed in as bob
    await tab.goto("/#activities");
    await ready(tab);
    await expect(tab.locator("body")).toHaveAttribute("data-view", "today");
    await tab.close();
  });

  test("bob has no profile picker and no way to add a profile", async ({ page }) => {
    await loginAs(page, "bob", PASSWORD);
    await openView(page, "today");
    await expect(page.locator("#tProfile")).toBeHidden();
    await openSettings(page);
    await expect(page.locator("#sProfile")).toBeHidden();
    await expect(page.locator("#sAddProfile")).toBeHidden();
  });

  test("a new profile is offered Today, Plans, Calendar and Food, and sees only the shared plan", async ({ me, profile }) => {
    await openView(me, "plans");
    await expect(me.locator("#accountName")).toHaveText(profile.name);
    await expect(me.locator("#views button:visible")).toHaveText(["Today", "Plans", "Calendar", "Food"]);
    await expect(me.locator("#filelist .file", { hasText: "shared-base.json" })).toHaveCount(1);
    await expect(me.locator("#filelist")).not.toContainText("alice-run-block.json");
  });

  test("the admin sees alice's plans, activities and food", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await signIn(page, "admin", ADMIN_TOKEN);
    await ready(page);
    await openView(page, "plans");
    await expect(page.locator("#filelist")).toContainText("alice-run-block.json");

    await openView(page, "activities");
    await page.locator("#aProfile").selectOption("alice");
    await expect(page.locator("#alist .arow", { hasText: "Easy run" }).first()).toBeVisible();

    await foodFor(page, "alice");
    await stepFoodBack(page, "alice");
    await expect(page.locator("#fbody")).toContainText("Oatmeal");
  });

  test("the admin switches the Food view between profiles and sees each one's own log", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await signIn(page, "admin", ADMIN_TOKEN);
    await ready(page);
    await foodFor(page, "bob");
    await stepFoodBack(page, "bob");
    await expect(page.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(page.locator("#fbody")).not.toContainText("Oatmeal");
    await pickFoodProfile(page, "alice");
    await stepFoodBack(page, "alice");
    await expect(page.locator("#fDate")).toHaveValue(daysAgo(1));
    await expect(page.locator("#fbody")).toContainText("Oatmeal");
  });

  test("the admin has the add-a-profile button in Settings", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#login")).toBeVisible();
    await signIn(page, "admin", ADMIN_TOKEN);
    await ready(page);
    await openSettings(page);
    await expect(page.locator("#sAddProfile")).toBeVisible();
    await expect(page.locator("#sAddProfile")).toHaveText("+ Add profile");
  });

  test("a profile has no add-a-profile button in Settings", async ({ me }) => {
    await openView(me, "today");
    await openSettings(me);
    await expect(me.locator("#sAddProfile")).toBeHidden();
  });
});
