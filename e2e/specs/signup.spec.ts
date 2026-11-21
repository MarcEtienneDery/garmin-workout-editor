/**
 * Signing up with an invite, and the welcome flow a new profile sees once.
 *
 * The admin makes invites in Settings (here mostly through the API, once through the page); a person opens the link or types the code, makes a
 * profile and is signed in as it. Wrong or dead codes are counted per client address by the server (ten in a minute and it waits), and every
 * test here comes from the same address, so each one makes at most a wrong code or a dead link, never a run of them.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, loginAs, ready, ADMIN_TOKEN, PASSWORD } from "../support/fixtures";

let counter = 0;
const newName = () => `s${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** An invite made through the API: its code, as XXXX-XXXX-XXXX. */
async function makeInvite(admin: APIRequestContext, body: Record<string, unknown> = {}): Promise<string> {
  const res = await admin.post("/api/invites", { data: { action: "create", ...body } });
  expect(res.status()).toBe(201);
  const code: string = (await res.json()).created;
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

/** Fill in the sign-up form (the code is filled in already when the page was opened from a link). */
async function fillSignup(page: Page, name: string, password = PASSWORD, code?: string): Promise<void> {
  if (code !== undefined) await page.locator("#signupCode").fill(code);
  await page.locator("#signupName").fill(name);
  await page.locator("#signupPass").fill(password);
  await page.locator("#signupPass2").fill(password);
}

/** The welcome dialog is up on its first step. */
async function welcomeOpen(page: Page, name: string): Promise<void> {
  await expect(page.locator("#ftue")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#ftueTitle")).toHaveText(`Welcome, ${name}`);
}

test.describe("the sign-up form", () => {
  test("opens on an invite link with the code filled in, and makes a signed-in profile", async ({ page, admin }) => {
    const code = await makeInvite(admin);
    const name = newName();
    await page.goto(`/?invite=${code.toLowerCase()}`);
    await expect(page.locator("#signupForm")).toBeVisible();
    await expect(page.locator("#loginForm")).toBeHidden();
    await expect(page.locator("#signupCode")).toHaveValue(code);
    await expect(page.locator("#signupNote")).toHaveText("Your invite is ready. Choose a profile name and a password.");
    expect(page.url()).toContain("invite="); // kept while the form is open: a reload does not lose it

    await fillSignup(page, name);
    await page.locator("#signupSubmit").click();
    await ready(page);
    await expect(page.locator("#signupForm")).toBeHidden();
    await expect(page.locator("#accountName")).toHaveText(name);
    expect(page.url()).not.toContain("invite="); // the code leaves the address once it is used
    await welcomeOpen(page, name);
  });

  test("takes a typed code from the sign-in form, writing it in groups of four", async ({ page, admin }) => {
    const code = await makeInvite(admin);
    await page.goto("/");
    await expect(page.locator("#loginForm")).toBeVisible();
    await page.locator("#toSignup").click();
    await expect(page.locator("#signupForm")).toBeVisible();
    await page.locator("#signupCode").pressSequentially(code.replace(/-/g, "").toLowerCase());
    await expect(page.locator("#signupCode")).toHaveValue(code);
    const name = newName();
    await fillSignup(page, name);
    await page.locator("#signupSubmit").click();
    await ready(page);
    await expect(page.locator("#accountName")).toHaveText(name);
  });

  test("goes back to the sign-in form", async ({ page }) => {
    await page.goto("/");
    await page.locator("#toSignup").click();
    await expect(page.locator("#signupForm")).toBeVisible();
    await page.locator("#toSignin").click();
    await expect(page.locator("#loginForm")).toBeVisible();
    await expect(page.locator("#signupForm")).toBeHidden();
  });

  test("says what is wrong before and after it asks, and keeps what was typed", async ({ page, admin }) => {
    const code = await makeInvite(admin);
    await page.goto("/");
    await page.locator("#toSignup").click();
    const problem = page.locator("#signupError");
    await fillSignup(page, "has space", "long enough", code);
    await page.locator("#signupSubmit").click();
    await expect(problem).toContainText("letters, numbers, hyphens and underscores");
    await fillSignup(page, newName(), "short");
    await page.locator("#signupSubmit").click();
    await expect(problem).toHaveText("The password is at least 8 characters.");
    await page.locator("#signupPass").fill("long enough");
    await page.locator("#signupPass2").fill("not the same");
    await page.locator("#signupSubmit").click();
    await expect(problem).toHaveText("The two passwords are not the same.");
    await expect(page.locator("#signupCode")).toHaveValue(code);
    await page.locator("#signupName").fill("alice"); // taken, whatever the case: the server says so and the code is still good
    await page.locator("#signupPass2").fill("long enough");
    await page.locator("#signupSubmit").click();
    await expect(problem).toHaveText("The name alice is taken. Choose another.");
  });

  test("refuses a wrong code in words", async ({ page }) => {
    await page.goto("/");
    await page.locator("#toSignup").click();
    await fillSignup(page, newName(), PASSWORD, "WRONG-CODE-2345");
    await page.locator("#signupSubmit").click();
    await expect(page.locator("#signupError")).toHaveText("That invite code is not valid.");
    await expect(page.locator("#signupForm")).toBeVisible();
  });

  test("says at once that a link's invite was cancelled", async ({ page, admin }) => {
    const code = await makeInvite(admin);
    expect((await admin.post("/api/invites", { data: { action: "revoke", code } })).ok()).toBe(true);
    await page.goto(`/?invite=${code}`);
    await expect(page.locator("#signupError")).toHaveText("That invite was cancelled. Ask for a new one.");
    await expect(page.locator("#signupCode")).toHaveValue(code);
  });

  test("ignores an invite link when already signed in", async ({ me, admin }) => {
    const code = await makeInvite(admin);
    await me.goto(`/?invite=${code}`);
    await ready(me);
    await expect(me.locator("#signupForm")).toBeHidden();
    expect(me.url()).not.toContain("invite=");
  });
});

test.describe("the welcome flow", () => {
  /** Sign a new profile up through the API and open the page as it, on its welcome. */
  async function newcomer(page: Page, admin: APIRequestContext): Promise<string> {
    const code = await makeInvite(admin);
    const name = newName();
    const res = await page.context().request.post("/api/signup", { data: { code, name, password: PASSWORD, confirm: PASSWORD }, headers: { "X-Requested-With": "plan-editor" } });
    expect(res.status()).toBe(201);
    await page.goto("/");
    await welcomeOpen(page, name);
    return name;
  }

  test("takes the steps, saves the goals, skips Garmin and ends on the view chosen", async ({ page, admin }) => {
    const name = await newcomer(page, admin);
    await expect(page.locator(".fcard")).toHaveCount(3);
    await page.locator("#ftueNext").click();

    await expect(page.locator("#ftueTitle")).toHaveText("Daily food goals");
    await expect(page.locator("#ftueNext")).toHaveText("Skip for now");
    await page.locator("#ftueBody input").nth(0).fill("2,100");
    await expect(page.locator("#ftueNext")).toHaveText("Next");
    await page.locator("#ftueBody input").nth(1).fill("140");
    await page.locator("#ftueNext").click();

    await expect(page.locator("#ftueTitle")).toHaveText("Connect Garmin");
    await expect(page.locator("#ftueNext")).toHaveText("Skip for now");
    await page.locator("#ftueBack").click();
    await expect(page.locator("#ftueTitle")).toHaveText("Daily food goals");
    await expect(page.locator("#ftueBody input").nth(0)).toHaveValue("2100"); // what was saved is what shows when coming back
    await page.locator("#ftueNext").click();
    await page.locator("#ftueNext").click();

    await expect(page.locator("#ftueTitle")).toHaveText("You're all set");
    await expect(page.locator("#ftueNext")).toBeHidden();
    await page.getByRole("button", { name: /Log a meal/ }).click();
    await expect(page.locator("#ftue")).toBeHidden();
    await expect(page.locator("body")).toHaveAttribute("data-view", "food");

    const settings = await (await page.context().request.get(`/api/settings?profile=${name}`)).json();
    expect(settings.goals.values).toEqual({ kcal: 2100, proteinG: 140 });
    expect(settings.garmin.connected).toBe(false);
  });

  test("is not shown again once it was seen, and the menu brings it back", async ({ page, admin }) => {
    const name = await newcomer(page, admin);
    await page.locator("#ftueSkip").click();
    await expect(page.locator("#ftue")).toBeHidden();
    await expect.poll(async () => ((await (await page.context().request.get("/api/session")).json()) as any).user).toEqual({ admin: false, name });

    await page.reload();
    await ready(page);
    await expect(page.locator("#ftue")).toBeHidden();

    await page.locator("#accountBtn").click();
    await page.locator("#welcomeBtn").click();
    await welcomeOpen(page, name);
    await page.keyboard.press("Escape"); // closing it any way is a skip
    await expect(page.locator("#ftue")).toBeHidden();
  });

  test("says what is wrong with a goal and stays on the step", async ({ page, admin }) => {
    await newcomer(page, admin);
    await page.locator("#ftueNext").click();
    await page.locator("#ftueBody input").nth(0).fill("lots");
    await page.locator("#ftueNext").click();
    await expect(page.locator("#ftueBody .fline")).toHaveText("Calories must be a number above 0, or empty for no goal.");
    await expect(page.locator("#ftueTitle")).toHaveText("Daily food goals");
  });

  test("is not shown to a profile the admin added, or to the admin", async ({ page, profile }) => {
    await loginAs(page, profile.name, profile.password);
    await page.goto("/");
    await ready(page);
    await expect(page.locator("#ftue")).toBeHidden();
    await page.locator("#accountBtn").click();
    await expect(page.locator("#welcomeBtn")).toBeVisible(); // a profile can still take the tour
  });
});

test.describe("the admin's invites", () => {
  test("are made in Settings, copied as a link that works, and cancelled", async ({ browser, baseURL, page }) => {
    const adminPage = await (await browser.newContext({ baseURL })).newPage();
    try {
      await loginAs(adminPage, "admin", ADMIN_TOKEN);
      await adminPage.goto("/");
      await ready(adminPage);
      await adminPage.locator("#accountBtn").click();
      await adminPage.locator("#openSettings").click();
      await adminPage.locator('#sbody .snav [data-section="profiles"]').click(); // the invites are kept with the profiles (admin only)
      const card = adminPage.locator(".scard", { has: adminPage.getByRole("heading", { name: /^Invites/ }) });
      await expect(card).toBeVisible({ timeout: 20_000 });

      await card.locator("#s-inv_note").fill("for the e2e");
      await card.locator("#s-inv_uses").fill("2");
      await card.locator("#s-inv_days").selectOption("30");
      await card.getByRole("button", { name: "Make an invite" }).click();
      const row = card.locator(".invrow.fresh");
      await expect(row).toBeVisible();
      await expect(row).toContainText("for the e2e");
      await expect(row).toContainText("0 of 2 used · 30 days left");
      const link = (await row.locator(".ilink").textContent()) ?? "";
      expect(link).toMatch(/\/\?invite=[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

      // the link opens the sign-up form of a visitor who is signed out
      await page.goto(new URL(link).pathname + new URL(link).search);
      await expect(page.locator("#signupForm")).toBeVisible();
      await expect(page.locator("#signupNote")).toContainText("Your invite is ready");

      // cancelling it stops it
      await row.getByRole("button", { name: "Cancel" }).click();
      await adminPage.locator("#dlgOk").click();
      await expect(row).toContainText("Cancelled");
      await expect(row.locator(".ilink")).toHaveCount(0);
      await row.getByRole("button", { name: "Remove" }).click();
      await expect(row).toHaveCount(0);
    } finally {
      await adminPage.context().close();
    }
  });

  test("are not offered to a profile", async ({ me }) => {
    await me.goto("/");
    await ready(me);
    await me.locator("#accountBtn").click();
    await me.locator("#openSettings").click();
    await expect(me.locator("#sview")).toBeVisible();
    await expect(me.locator(".scard").first()).toBeVisible({ timeout: 20_000 });
    await expect(me.getByRole("heading", { name: /^Invites/ })).toHaveCount(0);
  });
});
