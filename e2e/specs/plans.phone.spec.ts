/**
 * Plans on a phone: the bottom tab bar (Files, Editor, Outline, Checks), the toolbar's ⋯ panel, and the Checks badge.
 * alice's plans are read only; anything that writes a file uses a profile of its own (`me`).
 */
import { test, expect, openView, daysAhead, mondayOf, today, type Page, type Profile } from "../support/fixtures";

// The suite shares this machine with other runs, so a step can take longer than the default 30 s on a loaded box.
test.setTimeout(60_000);

/** What sticks out past the phone's width outside any box that scrolls by itself (the page itself never scrolls sideways). */
async function stickingOut(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    // what an element can show of itself: its own box, cut at the edge of every box above it that clips (hidden, scroll, auto)
    const shownRight = (el: Element) => {
      let right = el.getBoundingClientRect().right;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX !== "visible") right = Math.min(right, p.getBoundingClientRect().right);
      }
      return right;
    };
    return [...document.body.querySelectorAll("*")]
      .filter((el) => {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && shownRight(el) > width + 0.5;
      })
      .slice(0, 8)
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} right=${Math.round(el.getBoundingClientRect().right)}`);
  });
}

/** A plan the validator passes: a week and one running workout dated today. */
const validPlan = () =>
  JSON.stringify({
    weekStart: mondayOf(today()),
    weekEnd: daysAhead(6),
    workouts: [
      {
        workoutName: "Easy",
        workoutType: "running",
        scheduledDate: today(),
        distanceMeters: 5000,
        steps: [{ stepType: "interval", targetType: "no.target", endCondition: "distance", endConditionValue: 5000 }],
      },
    ],
  });

/** A plan with two errors: no week, and a workout with no name and an unknown type. */
const invalidPlan = () => JSON.stringify({ workouts: [{ workoutName: "", workoutType: "nope", steps: [] }] });

/**
 * A plan file of the profile's own, named after it: workout-plans/ is one namespace shared by every profile, so a name another test
 * took belongs to that one.
 */
const planPath = (profile: Profile, kind: string) => `workout-plans/${profile.name}-${kind}.json`;

/** Writes a plan into the profile's own plans, through its API (the page then lists it). */
async function putPlan(profile: Profile, kind: string, text: string) {
  const res = await profile.api.put(`/api/file?path=${encodeURIComponent(planPath(profile, kind))}`, { data: { text, create: true } });
  expect(res.status()).toBe(201);
}

const tab = (page: Page, name: "files" | "editor" | "outline" | "problems") => page.locator(`#tabbar button[data-tab="${name}"]`);

/**
 * Plans opens with its toolbar and tabs wired: the page wires them once the editor has its schema, so a tap before that does
 * nothing. Waits for that answer, then for the view.
 */
async function openPlans(page: Page) {
  const wired = page.waitForResponse((r) => r.url().includes("/api/schema") && r.ok());
  await openView(page, "plans");
  await wired;
}

/** Taps a file in Files, and waits until it is the open file (the page moves to its pane once the file has loaded). */
async function openPlanFile(page: Page, name: string) {
  await page.locator("#filelist .file", { hasText: name }).tap();
  await expect(page.locator("#current")).toContainText(name);
}

test.describe("the bottom tab bar", () => {
  test("shows on Plans with its four tabs", async ({ alice }) => {
    await openPlans(alice);
    await expect(alice.locator("#tabbar")).toBeVisible();
    for (const [name, label] of [["files", "Files"], ["editor", "Editor"], ["outline", "Outline"], ["problems", "Checks"]] as const) {
      await expect(tab(alice, name)).toContainText(label);
    }
  });

  test("is hidden on every other view", async ({ alice }) => {
    for (const view of ["today", "calendar", "activities", "recovery", "weight", "food", "settings"]) {
      await openView(alice, view);
      await expect(alice.locator("#tabbar")).toBeHidden();
    }
  });

  test("each tab is at least 44 px tall and wide", async ({ alice }) => {
    await openPlans(alice);
    const boxes = await alice.locator("#tabbar button").evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height })));
    expect(boxes).toHaveLength(4);
    for (const b of boxes) {
      expect(b.h).toBeGreaterThanOrEqual(44);
      expect(b.w).toBeGreaterThanOrEqual(44);
    }
  });

  test("Files is selected when Plans opens, and only the file list shows", async ({ alice }) => {
    await openPlans(alice);
    await expect(alice.locator("body")).toHaveAttribute("data-tab", "files");
    await expect(tab(alice, "files")).toHaveAttribute("aria-selected", "true");
    await expect(alice.locator("#filelist")).toBeVisible();
    await expect(alice.locator("#editor")).toBeHidden();
    await expect(alice.locator("#side")).toBeHidden();
  });

  test("Editor shows the editor and nothing else", async ({ alice }) => {
    await openPlans(alice);
    await tab(alice, "editor").tap();
    await expect(alice.locator("body")).toHaveAttribute("data-tab", "editor");
    await expect(tab(alice, "editor")).toHaveAttribute("aria-selected", "true");
    await expect(alice.locator("#editor")).toBeVisible();
    await expect(alice.locator("#filelist")).toBeHidden();
    await expect(alice.locator("#side")).toBeHidden();
  });

  test("Outline shows the outline pane only", async ({ alice }) => {
    await openPlans(alice);
    await tab(alice, "outline").tap();
    await expect(alice.locator("#side")).toBeVisible();
    await expect(alice.locator("#outlinePane")).toBeVisible();
    await expect(alice.locator("#problemsPane")).toBeHidden();
    await expect(alice.locator("#editor")).toBeHidden();
    await expect(alice.locator("#filelist")).toBeHidden();
  });

  test("Checks shows the validation pane only", async ({ alice }) => {
    await openPlans(alice);
    await tab(alice, "problems").tap();
    await expect(alice.locator("#side")).toBeVisible();
    await expect(alice.locator("#problemsPane")).toBeVisible();
    await expect(alice.locator("#outlinePane")).toBeHidden();
    await expect(alice.locator("#problems")).toContainText("Nothing to report.");
  });

  test("opening a plan from Files moves to its Outline and names the file in the toolbar", async ({ alice }) => {
    await openPlans(alice);
    await alice.locator("#filelist .file", { hasText: "alice-run-block.json" }).tap();
    await expect(alice.locator("body")).toHaveAttribute("data-tab", "outline");
    await expect(alice.locator("#current")).toContainText("alice-run-block.json");
    await expect(alice.locator("#outline")).toContainText("Tempo intervals");
  });

  test("opening a file that is not a plan moves to the Editor", async ({ me, profile }) => {
    await putPlan(profile, "notes", JSON.stringify({ notes: "not a plan" }));
    await openPlans(me);
    await me.locator("#filelist .file", { hasText: `${profile.name}-notes.json` }).tap();
    await expect(me.locator("body")).toHaveAttribute("data-tab", "editor");
    await expect(me.locator("#editor")).toBeVisible();
  });
});

test.describe("the Checks badge and pane", () => {
  test("the badge counts the errors of an invalid plan, in red", async ({ me, profile }) => {
    await putPlan(profile, "bad", invalidPlan());
    await openPlans(me);
    await openPlanFile(me, `${profile.name}-bad.json`);
    await expect(me.locator("#badge")).toHaveText("2");
    await expect(me.locator("#badge")).toHaveClass(/err/);
  });

  test("the badge is empty for a valid plan", async ({ me, profile }) => {
    await putPlan(profile, "good", validPlan());
    await openPlans(me);
    await openPlanFile(me, `${profile.name}-good.json`);
    await expect(me.locator("#problems")).toContainText("Valid");
    await expect(me.locator("#badge")).toBeEmpty();
    await expect(me.locator("#badge")).toBeHidden();
  });

  test("Checks lists the problems of the open plan", async ({ me, profile }) => {
    await putPlan(profile, "bad", invalidPlan());
    await openPlans(me);
    await openPlanFile(me, `${profile.name}-bad.json`);
    await tab(me, "problems").tap();
    await expect(me.locator("#problems .msg.err")).toHaveCount(2);
    await expect(me.locator("#problems")).toContainText("missing weekStart, weekEnd, or workouts");
    await expect(me.locator("#problems")).toContainText("Missing or invalid 'workoutName'");
  });
});

test.describe("the toolbar's ⋯ panel", () => {
  test("⋯ opens a panel with the plan's actions", async ({ alice }) => {
    await openPlans(alice);
    await openPlanFile(alice, "alice-run-block.json");
    await alice.locator("#menu").tap();
    await expect(alice.locator("#menu")).toHaveAttribute("aria-expanded", "true");
    await expect(alice.locator("body")).toHaveClass(/menu-open/);
    await expect(alice.locator("#actions")).toBeVisible();
    for (const id of ["new", "validate", "format", "reload", "history", "dup", "rename", "archive", "delete"]) {
      await expect(alice.locator(`#${id}`)).toBeVisible();
    }
  });

  test("⋯ closes the panel when tapped again", async ({ alice }) => {
    await openPlans(alice);
    await alice.locator("#menu").tap();
    await expect(alice.locator("#actions")).toBeVisible();
    await alice.locator("#menu").tap();
    await expect(alice.locator("#actions")).toBeHidden();
    await expect(alice.locator("#menu")).toHaveAttribute("aria-expanded", "false");
  });

  test("choosing an action runs it and closes the panel", async ({ alice }) => {
    await openPlans(alice);
    await openPlanFile(alice, "alice-run-block.json");
    await alice.locator("#menu").tap();
    const validated = alice.waitForResponse((r) => r.url().includes("/api/validate") && r.request().method() === "POST");
    await alice.locator("#validate").tap();
    await validated;
    await expect(alice.locator("#actions")).toBeHidden();
    await expect(alice.locator("body")).not.toHaveClass(/menu-open/);
  });

  test("the Garmin actions are disabled, with the reason, for a profile with no Garmin login", async ({ me, profile }) => {
    await putPlan(profile, "good", validPlan());
    await openPlans(me);
    await openPlanFile(me, `${profile.name}-good.json`);
    await me.locator("#menu").tap();
    for (const id of ["gUpload", "gSchedule", "gBoth", "gSend"]) {
      await expect(me.locator(`#${id}`)).toBeDisabled();
    }
    await expect(me.locator("#gUpload")).toHaveAttribute("title", /no Garmin login/);
  });

  test("the ⋯ button and its panel buttons are at least 40 px tall", async ({ alice }) => {
    await openPlans(alice);
    await openPlanFile(alice, "alice-run-block.json");
    const menu = await alice.locator("#menu").boundingBox();
    expect(menu!.height).toBeGreaterThanOrEqual(40);
    await alice.locator("#menu").tap();
    const heights = await alice.locator("#actions button:visible").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(5);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(40);
  });

  test("Save stays disabled while the open plan is unchanged", async ({ alice }) => {
    await openPlans(alice);
    await openPlanFile(alice, "alice-run-block.json");
    await expect(alice.locator("#save")).toBeDisabled();
  });
});

test.describe("the file list and the editor on a phone", () => {
  test("the icon buttons beside each file are at least 40 px", async ({ alice }) => {
    await openPlans(alice);
    const heights = await alice.locator("#filelist .file .wact button").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThanOrEqual(3);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(40);
  });

  test("the sort box is 16 px, so the phone does not zoom in on it", async ({ alice }) => {
    await openPlans(alice);
    await expect(alice.locator("#fileSort")).toHaveCSS("font-size", "16px");
  });

  test("the toolbar stays on one row", async ({ alice }) => {
    await openPlans(alice);
    await openPlanFile(alice, "alice-run-block.json");
    const r = await alice.evaluate(() => ({ height: document.getElementById("toolbar")!.getBoundingClientRect().height, wrap: getComputedStyle(document.getElementById("toolbar")!).flexWrap }));
    expect(r.wrap).toBe("nowrap");
    expect(r.height).toBeLessThanOrEqual(64);
  });

  test("the editor fills the width of the phone", async ({ alice }) => {
    await openPlans(alice);
    await openPlanFile(alice, "alice-run-block.json");
    await tab(alice, "editor").tap();
    await expect(alice.locator("#editor .monaco-editor").first()).toBeVisible();
    const width = await alice.locator("#editor .monaco-editor").first().evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(412);
    await expect.poll(() => stickingOut(alice)).toEqual([]);
  });

  test("the outline fits the width with a plan open", async ({ alice }) => {
    await openPlans(alice);
    await openPlanFile(alice, "alice-run-block.json");
    await expect(alice.locator("#outline")).toContainText("Tempo intervals");
    await expect.poll(() => stickingOut(alice)).toEqual([]);
    const w = await alice.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(w.scroll).toBeLessThanOrEqual(w.client);
  });
});
