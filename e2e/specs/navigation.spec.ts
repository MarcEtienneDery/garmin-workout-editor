/**
 * The views, the address, the account menu and the Today tiles: which view buttons each profile sees (navModel.js), how a click, an
 * address, Back and Forward open a view, and that the page raises no error on the way. Reads only: alice's data is never changed.
 */
import type { Page } from "@playwright/test";
import { test as base, expect, loginAs, ADMIN_TOKEN } from "../support/fixtures";

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

/** The admin login (the access token, any name): its own page in its own browser context, the way a person on the admin's machine has it. */
const test = base.extend<{ adminPage: Page }>({
  adminPage: async ({ browser, baseURL }, use) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 860 }, timezoneId: "UTC", locale: "en-CA" });
    const page = await context.newPage();
    await page.route("**/tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
    await retried(() => loginAs(page, "admin", ADMIN_TOKEN));
    await use(page);
    await context.close();
  },
});
test.describe.configure({ timeout: 90_000 });

/** The view buttons, by view name, as the page has them. */
const BUTTON = {
  today: "vToday",
  plans: "vPlans",
  workouts: "vWorkouts",
  calendar: "vCalendar",
  activities: "vActivities",
  recovery: "vRecovery",
  weight: "vWeight",
  food: "vFood",
} as const;
type View = keyof typeof BUTTON;

const ALL_BUTTONS = Object.values(BUTTON);

/** The view buttons a page shows, in the strip's order (hidden ones left out). */
const strip = (page: Page) => page.locator("#views button:visible");

/** Only the button of `view` is pressed (Settings has none). */
async function expectOnly(page: Page, view: View | "settings"): Promise<void> {
  for (const id of ALL_BUTTONS) await slow(page.locator(`#${id}`)).toHaveAttribute("aria-pressed", id === BUTTON[view as View] ? "true" : "false");
}

const isOn = (page: Page, view: View | "settings") => slow(page.locator("body")).toHaveAttribute("data-view", view);

/** Map tiles are never reached: a spec that opens a map answers them itself. */
test.beforeEach(async ({ page }) => {
  await page.route("**/tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204, body: "" }));
});

test.describe("which views a profile sees", () => {
  test("alice (a profile with data, no Garmin login) sees every view but Workouts, in strip order", async ({ alice }) => {
    await openView(alice, "today");
    await slow(strip(alice)).toHaveText(["Today", "Plans", "Calendar", "Activities", "Recovery", "Weight", "Food"]);
    await slow(alice.locator("#vWorkouts")).toBeHidden();
  });

  test("a fresh profile sees only Today, Plans, Calendar and Food", async ({ me }) => {
    await openView(me, "today");
    await slow(strip(me)).toHaveText(["Today", "Plans", "Calendar", "Food"]);
    for (const id of ["vWorkouts", "vActivities", "vRecovery", "vWeight"]) await slow(me.locator(`#${id}`)).toBeHidden();
  });

  test("the admin sees the views any profile can use: Activities, Recovery and Weight (alice has data), and Workouts exactly when some profile has Garmin", async ({ adminPage }) => {
    // the admin sees every profile, so Workouts shows when any of them has a Garmin login (the database is shared by the whole suite)
    await openView(adminPage, "today");
    await slow(adminPage.locator("#vActivities")).toBeVisible(); // the page has the profiles' views by now
    const anyGarmin = await adminPage.evaluate(() => (Object.values(garmin.profileInfo) as { garmin: boolean }[]).some((p) => p.garmin));
    const expected = anyGarmin
      ? ["Today", "Plans", "Workouts", "Calendar", "Activities", "Recovery", "Weight", "Food"]
      : ["Today", "Plans", "Calendar", "Activities", "Recovery", "Weight", "Food"];
    await slow(strip(adminPage)).toHaveText(expected);
  });

  test("a Renpho login alone shows the Weight view for a profile without Garmin", async ({ me, profile }) => {
    await openView(me, "today");
    await slow(me.locator("#vWeight")).toBeHidden();
    const saved = await retried(() => profile.api.post("/api/settings/renpho", { data: { action: "save", profile: profile.name, email: "scale@example.com", password: "scale-pass-123", areaCode: "US" } }));
    slow(saved.ok()).toBeTruthy();
    await openView(me, "today");
    await slow(me.locator("#vWeight")).toBeVisible();
    await slow(me.locator("#vActivities")).toBeHidden();
    await slow(me.locator("#vWorkouts")).toBeHidden();
  });
});

test.describe("clicking a view", () => {
  for (const view of ["plans", "calendar", "activities", "recovery", "weight", "food"] as const) {
    test(`opens ${view}: body[data-view], its button is pressed and the address is #${view}`, async ({ alice }) => {
      await openView(alice, "today");
      await alice.locator(`#${BUTTON[view]}`).click();
      await isOn(alice, view);
      await slow(alice).toHaveURL(new RegExp(`#${view}$`));
      await expectOnly(alice, view);
    });
  }

  test("clicking Today from another view returns to Today, with no view in the address", async ({ alice }) => {
    await openView(alice, "plans");
    await alice.locator("#vToday").click();
    await isOn(alice, "today");
    await slow(alice).toHaveURL(/\/$/);
    await expectOnly(alice, "today");
  });

  test("the view button of the view you are on is pressed, and no other", async ({ alice }) => {
    await openView(alice, "today");
    for (const view of ["food", "recovery", "plans"] as const) {
      await alice.locator(`#${BUTTON[view]}`).click();
      await isOn(alice, view);
      await expectOnly(alice, view);
    }
  });

  test("Settings is in no view button: opening it presses none", async ({ alice }) => {
    await openView(alice, "food");
    await alice.locator("#accountBtn").click();
    await alice.locator("#openSettings").click();
    await isOn(alice, "settings");
    await expectOnly(alice, "settings");
  });
});

test.describe("the address", () => {
  for (const view of ["plans", "calendar", "activities", "recovery", "weight", "food", "settings"] as const) {
    test(`loading #${view} opens ${view}`, async ({ alice }) => {
      await openView(alice, view);
      if (view !== "settings") await expectOnly(alice, view);
      else await slow(alice.locator("#sbody .scard").first()).toBeVisible();
    });
  }

  test("loading #workouts for a profile without Garmin falls back to Today", async ({ alice }) => {
    await alice.goto("/#workouts");
    await ready(alice);
    await isOn(alice, "today");
    await expectOnly(alice, "today");
    await slow(alice.locator("#vWorkouts")).toBeHidden();
    await slow(alice).toHaveURL(/\/$/);
  });

  test("loading #workouts as a fresh profile falls back to Today too", async ({ me }) => {
    await me.goto("/#workouts");
    await ready(me);
    await isOn(me, "today");
    await expectOnly(me, "today");
  });

  test("an unknown address opens Today", async ({ alice }) => {
    await alice.goto("/#nonsense");
    await ready(alice);
    await isOn(alice, "today");
    await expectOnly(alice, "today");
  });

  test("reloading the page stays on the view it was on", async ({ alice }) => {
    await openView(alice, "recovery");
    await alice.reload();
    await ready(alice);
    await isOn(alice, "recovery");
    await expectOnly(alice, "recovery");
  });

  test("the root address (no hash) opens Today", async ({ alice }) => {
    await alice.goto("/");
    await ready(alice);
    await isOn(alice, "today");
    await expectOnly(alice, "today");
  });
});

test.describe("Back and Forward", () => {
  test("Back and Forward walk through the views in the order they were opened", async ({ alice }) => {
    await openView(alice, "today");
    for (const id of ["vPlans", "vFood", "vRecovery"]) await alice.locator(`#${id}`).click();
    await isOn(alice, "recovery");
    await alice.goBack();
    await isOn(alice, "food");
    await alice.goBack();
    await isOn(alice, "plans");
    await alice.goBack();
    await isOn(alice, "today");
    await alice.goForward();
    await isOn(alice, "plans");
    await alice.goForward();
    await isOn(alice, "food");
    await expectOnly(alice, "food");
  });

  test("Back from Settings returns to the view it was opened from", async ({ alice }) => {
    await openView(alice, "food");
    await alice.locator("#accountBtn").click();
    await alice.locator("#openSettings").click();
    await isOn(alice, "settings");
    await alice.goBack();
    await isOn(alice, "food");
    await expectOnly(alice, "food");
  });

  test("the browser's Back from Settings returns to the view it was opened from", async ({ alice }) => {
    await openView(alice, "calendar");
    await alice.locator("#accountBtn").click();
    await alice.locator("#openSettings").click();
    await isOn(alice, "settings");
    await alice.goBack();
    await isOn(alice, "calendar");
    await expectOnly(alice, "calendar");
  });
});

test.describe("the account menu", () => {
  test("opens from the name and offers Settings and Sign out", async ({ alice }) => {
    await openView(alice, "today");
    await slow(alice.locator("#accountMenu")).toBeHidden();
    await alice.locator("#accountBtn").click();
    await slow(alice.locator("#accountBtn")).toHaveAttribute("aria-expanded", "true");
    await slow(alice.locator("#accountMenu")).toBeVisible();
    await slow(alice.locator("#accountMenu")).toContainText("Signed in as");
    await slow(alice.locator("#openSettings")).toHaveText("Settings");
    await slow(alice.locator("#logout")).toHaveText("Sign out");
  });

  test("closes when a click lands elsewhere on the page", async ({ alice }) => {
    await openView(alice, "today");
    await alice.locator("#accountBtn").click();
    await slow(alice.locator("#accountMenu")).toBeVisible();
    await alice.locator("header h1").click();
    await slow(alice.locator("#accountMenu")).toBeHidden();
    await slow(alice.locator("#accountBtn")).toHaveAttribute("aria-expanded", "false");
  });

  test("closes on Escape, and the focus goes back to the account button", async ({ alice }) => {
    await openView(alice, "today");
    await alice.locator("#accountBtn").click();
    await slow(alice.locator("#accountMenu")).toBeVisible();
    await alice.keyboard.press("Escape");
    await slow(alice.locator("#accountMenu")).toBeHidden();
    await slow(alice.locator("#accountBtn")).toBeFocused();
  });

  test("a second click on the name closes it again", async ({ alice }) => {
    await openView(alice, "today");
    await alice.locator("#accountBtn").click();
    await alice.locator("#accountBtn").click();
    await slow(alice.locator("#accountMenu")).toBeHidden();
  });

  test("shows who is signed in: the profile's name, its role and the button's tooltip", async ({ alice }) => {
    await openView(alice, "today");
    await slow(alice.locator("#accountName")).toHaveText("alice");
    await slow(alice.locator("#accountAvatar")).toHaveText("A");
    await slow(alice.locator("#accountBtn")).toHaveAttribute("title", "Signed in as alice");
    await alice.locator("#accountBtn").click();
    await slow(alice.locator("#accountWho")).toHaveText("alice");
    await slow(alice.locator("#accountRole")).toHaveText("Profile login: your plans and Garmin account.");
  });

  test("a fresh profile shows its own name", async ({ me, profile }) => {
    await openView(me, "today");
    await slow(me.locator("#accountName")).toHaveText(profile.name);
    await me.locator("#accountBtn").click();
    await slow(me.locator("#accountWho")).toHaveText(profile.name);
  });

  test("the admin is shown as Admin, with the administrator's role", async ({ adminPage }) => {
    await openView(adminPage, "today");
    await slow(adminPage.locator("#accountName")).toHaveText("Admin");
    await adminPage.locator("#accountBtn").click();
    await slow(adminPage.locator("#accountWho")).toHaveText("Admin");
    await slow(adminPage.locator("#accountRole")).toHaveText("Administrator: all profiles.");
  });

  test("Settings in the menu opens Settings and closes the menu", async ({ alice }) => {
    await openView(alice, "today");
    await alice.locator("#accountBtn").click();
    await alice.locator("#openSettings").click();
    await isOn(alice, "settings");
    await slow(alice).toHaveURL(/#settings$/);
    await slow(alice.locator("#accountMenu")).toBeHidden();
    await slow(alice.locator("#accountBtn")).toHaveAttribute("aria-expanded", "false");
  });

  test("Sign out ends the session and shows the sign-in form", async ({ me }) => {
    await openView(me, "today");
    await me.locator("#accountBtn").click();
    await me.locator("#logout").click();
    await slow(me.locator("#login")).toBeVisible();
    await slow(me.locator("#loginUser")).toBeVisible();
    const session = await (await me.context().request.get("/api/session")).json();
    slow(session.user).toBeNull();
  });
});

test.describe("Settings", () => {
  for (const from of ["today", "plans", "calendar", "food"] as const) {
    test(`Back (#sBack) returns to ${from}, the view Settings was opened from`, async ({ alice }) => {
      await openView(alice, from);
      await alice.locator("#accountBtn").click();
      await alice.locator("#openSettings").click();
      await isOn(alice, "settings");
      await alice.locator("#sBack").click();
      await isOn(alice, from);
      await expectOnly(alice, from);
    });
  }

  test("Back (#sBack) from Settings opened after another visit to Settings still returns to the view before it", async ({ alice }) => {
    await openView(alice, "recovery");
    await alice.locator("#accountBtn").click();
    await alice.locator("#openSettings").click();
    await isOn(alice, "settings");
    await alice.locator("#sBack").click();
    await isOn(alice, "recovery");
    await alice.locator("#vFood").click();
    await alice.locator("#accountBtn").click();
    await alice.locator("#openSettings").click();
    await isOn(alice, "settings");
    await alice.locator("#sBack").click();
    await isOn(alice, "food");
  });
});

test.describe("the Today view's links", () => {
  for (const label of ["Steps", "Intensity minutes", "Body Battery", "Sleep"]) {
    test(`the ${label} tile opens Recovery`, async ({ alice }) => {
      await openView(alice, "today");
      const tile = alice.locator(".tfig", { hasText: label });
      await slow(tile).toBeVisible();
      await slow(tile).toHaveAttribute("role", "link");
      await tile.click();
      await isOn(alice, "recovery");
      await expectOnly(alice, "recovery");
    });
  }

  test("the tiles are four, and each can be reached and opened with the keyboard", async ({ alice }) => {
    await openView(alice, "today");
    const tiles = alice.locator(".tfig");
    await slow(tiles).toHaveCount(4);
    for (let i = 0; i < 4; i++) await slow(tiles.nth(i)).toHaveAttribute("tabindex", "0");
    // Today can draw its tiles again a moment after they first show, which drops a focus that was set before: so focus and press again until it opens
    await slow(async () => {
      await tiles.nth(1).focus();
      await alice.keyboard.press("Enter");
      await slow(alice.locator("body")).toHaveAttribute("data-view", "recovery", { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await isOn(alice, "recovery");
  });

  test("the Food section's button opens the Food view on today", async ({ alice }) => {
    await openView(alice, "today");
    await alice.locator("button.tgo", { hasText: "Open the Food view" }).click();
    await isOn(alice, "food");
    await expectOnly(alice, "food");
  });

  test("a fresh profile's Today has no health tiles, since nothing is stored from a watch", async ({ me }) => {
    await openView(me, "today");
    await slow(me.locator("#tbody")).not.toContainText("Loading");
    await slow(me.locator(".tfig")).toHaveCount(0);
    await slow(me.locator("button.tgo", { hasText: "Open the Food view" })).toBeVisible();
  });
});

test.describe("the page as a whole", () => {
  test("the document title is Plan Editor on every view", async ({ alice }) => {
    await openView(alice, "today");
    await slow(alice).toHaveTitle("Plan Editor");
    for (const view of ["plans", "calendar", "activities", "recovery", "weight", "food"] as const) {
      await alice.locator(`#${BUTTON[view]}`).click();
      await isOn(alice, view);
      await slow(alice).toHaveTitle("Plan Editor");
    }
    await alice.locator("#accountBtn").click();
    await alice.locator("#openSettings").click();
    await isOn(alice, "settings");
    await slow(alice).toHaveTitle("Plan Editor");
  });

  test("visiting every view as alice raises no page error and no console error (map tiles blocked)", async ({ alice }) => {
    const problems: string[] = [];
    alice.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    alice.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    alice.on("response", (response) => {
      if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
    });
    await openView(alice, "today");
    await alice.waitForLoadState("networkidle");
    for (const view of ["plans", "calendar", "activities", "recovery", "weight", "food"] as const) {
      await alice.locator(`#${BUTTON[view]}`).click();
      await isOn(alice, view);
      await alice.waitForLoadState("networkidle");
    }
    // one activity opened, so its map is drawn (its tiles are blocked above)
    await alice.locator("#vActivities").click();
    await isOn(alice, "activities");
    const row = alice.locator("#aview .arow").first();
    await slow(row).toBeVisible();
    await row.click();
    await alice.waitForLoadState("networkidle");
    await alice.locator("#vToday").click();
    await isOn(alice, "today");
    await alice.locator("#accountBtn").click();
    await alice.locator("#openSettings").click();
    await isOn(alice, "settings");
    await alice.waitForLoadState("networkidle");
    slow(problems).toEqual([]);
  });

  test("the app's own pages are the only ones reached: no request leaves the server for another host", async ({ alice }) => {
    const hosts = new Set<string>();
    alice.on("request", (request) => hosts.add(new URL(request.url()).host));
    await openView(alice, "today");
    await alice.locator("#vActivities").click();
    await isOn(alice, "activities");
    await alice.waitForLoadState("networkidle");
    slow([...hosts]).toEqual(["127.0.0.1:8792"]);
  });
});
