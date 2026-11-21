import { test, expect, loginAs, openView, ADMIN_TOKEN, type Page } from "../support/fixtures";

test.describe.configure({ timeout: 60_000 });

const open = async (page: Page, section = "overview") => {
  await page.goto("/#settings");
  await expect(page.locator("#sbody .snav")).toBeVisible({ timeout: 20_000 });
  await page.locator(`#sbody .snav [data-section="${section}"]`).click();
  await expect(page.locator(`#sbody .spane[data-section="${section}"]`)).toBeVisible();
};
const answering = (page: Page, patch: (json: any) => void) =>
  page.route("**/api/settings?*", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    patch(json);
    await route.fulfill({ response, json });
  });
const settle = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));

test.describe("the sections", () => {
  test("a profile has five, the admin six (Profiles), and the one shown is marked", async ({ me }) => {
    await open(me);
    await expect(me.locator("#sbody .snav button")).toHaveText([/Overview/, /Connections/, /Goals/, /Display/, /Sign-in & security/]);
    await expect(me.locator("#sbody .snav [aria-current='page']")).toHaveText(/Overview/);
    await me.locator("#sbody .snav [data-section='goals']").click();
    await expect(me.locator("#sbody .snav [aria-current='page']")).toHaveText(/Goals/);
    await expect(me.locator("#sbody .spane[data-section='goals'] .scard h2").first()).toBeVisible();
  });

  test("the admin also has the Profiles section, with every profile, what each has connected and the one shown", async ({ page }) => {
    await loginAs(page, "admin", ADMIN_TOKEN);
    await open(page, "profiles");
    await expect(page.locator("#sbody .snav button")).toHaveCount(6);
    await expect(page.locator("#sbody .sprow.here .stag")).toHaveText("showing in Settings");
    await expect(page.locator("#sbody .sprow").first().locator(".chip")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "+ Add profile" }).first()).toBeVisible();
  });
});

test.describe("the overview", () => {
  test("says everything is set up, with four tiles, for a profile with nothing wrong", async ({ me }) => {
    await answering(me, (json) => { json.encryption = { enabled: true, plain: 0 }; });
    await open(me);
    await expect(me.locator(".sverdict h2")).toHaveText("Everything is set up");
    await expect(me.locator(".stile .sth b")).toHaveText(["Garmin", "Renpho scale", "Food AI", "Sign-in & storage"]);
    await expect(me.locator(".sgoalchips")).toContainText("No goals set yet.");
  });

  test("lists what needs attention, each with a button to where it is fixed, and the list shows a dot", async ({ me }) => {
    await answering(me, (json) => { json.garmin = { connected: true, email: "a@b.c", hasPassword: true, check: { ok: false, message: "Garmin said no", at: Date.now() - 60_000 } }; json.encryption = { enabled: false, plain: 2 }; });
    await open(me);
    await expect(me.locator(".sverdict h2")).toHaveText("2 things need attention");
    await expect(me.locator(".sattn")).toHaveCount(2);
    await expect(me.locator("#sbody .snav [data-section='connections'] .sdot")).toHaveAttribute("aria-label", "needs attention");
    await expect(me.locator("#sbody .snav [data-section='signin'] .sdot")).toBeVisible();
    await me.locator(".sattn").first().getByRole("button").click();
    await expect(me.locator("#sbody .snav [aria-current='page']")).toHaveText(/Connections/);
    await expect(me.locator(".scard").first()).toContainText("Garmin said no");
  });

  test("shows the goals set as chips, and the tile of the Food AI with the estimates left", async ({ me, profile }) => {
    expect((await profile.api.post("/api/settings/goals", { data: { action: "save", goals: { kcal: 2400, proteinG: 150 } } })).ok()).toBeTruthy();
    await answering(me, (json) => { json.ai = { enabled: true, backend: "gemini", remaining: 14, limit: 20 }; });
    await open(me);
    await expect(me.locator(".sgoalchips span")).toHaveCount(2);
    await expect(me.locator(".sgoalchips")).toContainText("2,400");
    await expect(me.locator(".stile").nth(2)).toContainText("14 of 20 estimates left today");
  });
});

test.describe("the goals", () => {
  test("a preview follows what is typed, and the slider moves the sample day", async ({ me }) => {
    await open(me, "goals");
    await expect(me.locator(".spreview")).toContainText("Set a calorie or macro goal");
    await me.locator("#s-goal_kcal").fill("2000");
    await expect(me.locator(".spreview .sprow2").first()).toContainText("1,100 / 2,000 kcal");
    await me.locator(".spreview input[type='range']").fill("100");
    await expect(me.locator(".spreview .sprow2").first()).toContainText("2,000 / 2,000 kcal");
    await expect(me.locator(".spreview .sprow2.st-ok")).toHaveCount(1);
    await me.locator(".spreview input[type='range']").fill("125");
    await expect(me.locator(".spreview .sprow2.st-over")).toHaveCount(1);
  });

  test("an unsaved bar appears at the first change, Discard puts the saved goals back, Save saves", async ({ me, profile }) => {
    await open(me, "goals");
    await expect(me.locator(".sunsaved")).toBeHidden();
    await me.locator("#s-goal_kcal").fill("1800");
    await expect(me.locator(".sunsaved")).toBeVisible();
    await me.locator(".sunsaved").getByRole("button", { name: "Discard" }).click();
    await expect(me.locator("#s-goal_kcal")).toHaveValue("");
    await expect(me.locator(".sunsaved")).toBeHidden();
    await me.locator("#s-goal_kcal").fill("1800");
    await me.locator(".sunsaved").getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await (await profile.api.get("/api/settings")).json()).goals.values.kcal).toBe(1800);
    await expect(me.locator(".sunsaved")).toBeHidden();
  });

  test("Clear all goals asks first, and its Undo puts every goal back", async ({ me, profile }) => {
    expect((await profile.api.post("/api/settings/goals", { data: { action: "save", goals: { kcal: 2200, proteinG: 120 } } })).ok()).toBeTruthy();
    await open(me, "goals");
    await me.getByRole("button", { name: "Clear all goals" }).click();
    await me.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    expect((await (await profile.api.get("/api/settings")).json()).goals.values.kcal).toBe(2200);
    await me.getByRole("button", { name: "Clear all goals" }).click();
    await me.getByRole("dialog").getByRole("button", { name: "Clear all" }).click();
    await expect.poll(async () => (await (await profile.api.get("/api/settings")).json()).goals.values).toEqual({});
    await me.locator("#toast").getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => (await (await profile.api.get("/api/settings")).json()).goals.values).toEqual({ kcal: 2200, proteinG: 120 });
  });
});

test.describe("the display", () => {
  test("the theme and the explanations are chosen here, and the unit of lifting weights is with them", async ({ me }) => {
    await open(me, "display");
    await me.locator(".seg button", { hasText: "Light" }).click();
    await expect(me.locator("body")).toHaveAttribute("data-theme", "light");
    await me.locator(".seg button", { hasText: "Dark" }).click();
    await expect(me.locator("body")).toHaveAttribute("data-theme", "dark");
    const explain = me.getByLabel("Show every explanation");
    await explain.check();
    await expect(me.locator("body")).toHaveClass(/explain/);
    await explain.uncheck();
    await expect(me.locator("body")).not.toHaveClass(/explain/);
    await expect(me.getByRole("group", { name: "Lifting weights in" })).toBeVisible();
  });
});

test.describe("the look", () => {
  test("text keeps its contrast and what is touched is 44 px, in both themes", async ({ me }) => {
    for (const theme of ["dark", "light"]) {
      await open(me, "goals");
      await me.evaluate((t) => document.body.setAttribute("data-theme", t), theme);
      await settle(me);
      const low = await me.evaluate(() => {
        const lum = (css: string) => {
          const unit = css.startsWith("color(srgb") ? 1 : 255;
          const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => { const c = v / unit; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const bgOf = (el: Element): string => { for (let p: Element | null = el; p; p = p.parentElement) { const c = getComputedStyle(p).backgroundColor; if (!/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(c)) return c; } return "rgb(0,0,0)"; };
        const out: string[] = [];
        for (const el of document.querySelectorAll("#sbody .snav button span, #sbody .scard h2, #sbody .sline, #sbody .sform label")) {
          const r = el.getBoundingClientRect(); if (!r.width) continue;
          const [a, b] = [lum(getComputedStyle(el).color), lum(bgOf(el))], ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          if (ratio < 4.5) out.push(`${el.className || el.tagName} ${ratio.toFixed(2)}`);
        }
        return out;
      });
      expect(low, `${theme}: text under 4.5 to 1`).toEqual([]);
      const small = await me.evaluate(() => [...document.querySelectorAll<HTMLElement>("#sbody .snav button, #sbody .sbtns button, #sbar button")].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => e.textContent!.trim().slice(0, 20)));
      expect(small, `${theme}: under 44 px`).toEqual([]);
    }
  });
});

test.describe("the theme is chosen in Settings only", () => {
  test("no view has a theme button, and every view takes the choice made in Display", async ({ alice }) => {
    await open(alice, "display");
    await alice.locator(".seg button", { hasText: "Light" }).click();
    for (const [view, button] of [["today", "vToday"], ["plans", "vPlans"], ["calendar", "vCalendar"], ["activities", "vActivities"], ["recovery", "vRecovery"], ["weight", "vWeight"], ["food", "vFood"]] as const) {
      await alice.locator(`#${button}`).click();
      await expect(alice.locator("body")).toHaveAttribute("data-view", view);
      await expect(alice.locator("body")).toHaveAttribute("data-theme", "light");
      await expect(alice.locator(".themebtn")).toHaveCount(0);
    }
    await expect(alice.locator(".themebtn")).toHaveCount(0);
  });
});
