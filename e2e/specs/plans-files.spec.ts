/**
 * The Plans view's files: the list and its order, New, Duplicate, Rename, Delete, History, the unsaved-changes guard when
 * switching files or leaving the page, and Archive / Unarchive (with the Calendar), for a profile without a Garmin login.
 *
 * Files written by a test carry the profile's name: workout-plans/ is one namespace for every profile, so a bare name would
 * collide with another test's file. alice's plans are read only; bob sees only the shared plan.
 */
import { test, expect as baseExpect, openView, loginAs, PASSWORD, daysAgo, daysAhead, today } from "../support/fixtures";
import type { APIRequestContext, Page } from "@playwright/test";

// The Monaco editor of the page: the top-level `editor` of the page's own script (window.editor is the #editor element).
declare const editor: any;

// The suite's server is shared, and can be slow when several suites run at once: give each step more time than the default.
const expect = baseExpect.configure({ timeout: 20_000 });
test.describe.configure({ timeout: 120_000 });

const enc = (path: string) => `/api/file?path=${encodeURIComponent(path)}`;

/** A small valid plan with one workout (and, optionally, workoutIds for the Garmin copies). */
const planJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    { weekStart: "2026-11-02", weekEnd: "2026-11-08", workouts: [{ workoutName: "Easy run", workoutType: "running", distanceMeters: 5000, scheduledDate: "2026-11-03" }], ...extra },
    null,
    2,
  ) + "\n";
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

async function fileGone(api: APIRequestContext, path: string): Promise<boolean> {
  return (await api.get(enc(path))).status() === 404;
}

/** Open a file from the list by its name, and wait until the page says it is the open file. */
async function openPlan(page: Page, name: string): Promise<void> {
  await page.locator("#filelist .file").filter({ hasText: name }).click();
  await expect(page.locator("#current")).toContainText(name);
}

/**
 * Open the Plans view and wait until the editor can act: the toolbar's buttons get their handlers only once Monaco and the
 * workout schema have loaded, which openView does not wait for.
 */
async function openPlans(page: Page): Promise<void> {
  await openView(page, "plans");
  await expect.poll(() => page.evaluate(() => typeof editor !== "undefined" && !!editor && document.getElementById("new")!.onclick !== null)).toBe(true);
}

const rowOf = (page: Page, name: string) => page.locator("#filelist .file").filter({ hasText: name });
const textOf = (page: Page) => page.evaluate(() => editor.getValue() as string);
const setText = (page: Page, value: string) => page.evaluate((v) => editor.setValue(v), value);
async function typeAtEnd(page: Page, text: string): Promise<void> {
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}
/** The File menu's item, opened from its button (the menu closes when an item is chosen). */
async function fileMenu(page: Page, id: string): Promise<void> {
  await page.locator("#fileBtn").click();
  await page.locator(`#${id}`).click();
}

const GARMIN_REASON = "This profile has no Garmin login: add one in Settings.";
const SHARED = "shared-base.json";
const ALICE_FILES = ["alice-run-block.json", "alice-someday.json", SHARED];

/** The names of alice's list rows that belong to the seeded plans, in the order the page shows them. */
async function seededOrder(page: Page): Promise<string[]> {
  const names = await page.locator("#filelist .file > span:first-child").allTextContents();
  return names.filter((n) => ALICE_FILES.includes(n));
}

test.describe("Plans: the file list", () => {
  test("alice sees her two plans and the shared one, under one folder heading", async ({ alice }) => {
    await openPlans(alice);
    await expect(alice.locator("#filelist .file").filter({ hasText: "alice-run-block.json" })).toHaveCount(1);
    await expect(alice.locator("#filelist .file").filter({ hasText: "alice-someday.json" })).toHaveCount(1);
    await expect(alice.locator("#filelist .file").filter({ hasText: SHARED })).toHaveCount(1);
    await expect(alice.locator("#filelist h2", { hasText: "workout-plans" })).toHaveCount(1);
    expect(await seededOrder(alice)).toEqual(["alice-run-block.json", "alice-someday.json", SHARED]);
  });

  test("each plan's row shows its workout count and its plan week", async ({ alice }) => {
    await openPlans(alice);
    await expect(rowOf(alice, "alice-run-block.json").locator("small")).toContainText("4 workouts");
    await expect(rowOf(alice, "alice-run-block.json").locator("small")).toContainText("2026-10-26");
    await expect(rowOf(alice, "alice-someday.json").locator("small")).toContainText("1 workouts");
    await expect(rowOf(alice, "alice-someday.json").locator("small")).toContainText("2026-01-05");
    await expect(rowOf(alice, SHARED).locator("small")).toContainText("1 workouts");
  });

  test("the default order is by file name", async ({ alice }) => {
    await openPlans(alice);
    await expect(alice.locator("#fileSort")).toHaveValue("name");
    expect(await seededOrder(alice)).toEqual([...ALICE_FILES].sort());
  });

  test("the sort menu offers the five orders", async ({ alice }) => {
    await openPlans(alice);
    await expect(alice.locator("#fileSort option")).toHaveText([
      "Name (A–Z)",
      "Plan date (newest first)",
      "Plan date (oldest first)",
      "Last modified",
      "Most workouts",
    ]);
  });

  test("Plan date, newest first: the latest week first, undated files last", async ({ alice }) => {
    await openPlans(alice);
    await alice.locator("#fileSort").selectOption("newest");
    expect(await seededOrder(alice)).toEqual(["alice-run-block.json", SHARED, "alice-someday.json"]);
  });

  test("Plan date, oldest first: the earliest week first", async ({ alice }) => {
    await openPlans(alice);
    await alice.locator("#fileSort").selectOption("oldest");
    expect(await seededOrder(alice)).toEqual(["alice-someday.json", "alice-run-block.json", SHARED]);
  });

  test("Most workouts: the plan with the most workouts first", async ({ alice }) => {
    await openPlans(alice);
    await alice.locator("#fileSort").selectOption("workouts");
    expect(await seededOrder(alice)).toEqual(["alice-run-block.json", "alice-someday.json", SHARED]);
  });

  test("Last modified shows when each plan was saved", async ({ alice }) => {
    await openPlans(alice);
    await alice.locator("#fileSort").selectOption("modified");
    await expect(rowOf(alice, "alice-run-block.json").locator("small")).toContainText(/saved \d{4}-\d{2}-\d{2}/);
    await expect(rowOf(alice, SHARED).locator("small")).toContainText(/saved \d{4}-\d{2}-\d{2}/);
  });

  test("the chosen order is kept when the page is opened again", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-sort-a.json`, planJson({ notes: "a" }));
    await makeFile(profile.api, `workout-plans/${profile.name}-sort-b.json`, planJson({ notes: "b" }));
    await openPlans(me);
    await me.locator("#fileSort").selectOption("oldest");
    await me.reload();
    await expect(me.locator("#fileSort")).toHaveValue("oldest");
  });

  test("bob sees the shared plan and nothing of alice's, and the sort menu is hidden with one file", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, timezoneId: "UTC", locale: "en-CA", viewport: { width: 1280, height: 860 } });
    try {
      const bob = await context.newPage();
      await loginAs(bob, "bob", PASSWORD);
      await openPlans(bob);
      await expect(bob.locator("#filelist .file").filter({ hasText: SHARED })).toHaveCount(1);
      await expect(bob.locator("#filelist")).not.toContainText("alice-");
      await expect(bob.locator("#filebar")).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test("a profile's API refuses another profile's plan with 403", async ({ browser, baseURL, admin }) => {
    const context = await browser.newContext({ baseURL });
    try {
      await loginAs(context, "bob", PASSWORD);
      const res = await context.request.get(enc("workout-plans/alice-run-block.json"), { headers: { "X-Requested-With": "plan-editor" } });
      expect(res.status()).toBe(403);
      expect((await res.json()).error).toContain("belongs to another profile");
      expect((await admin.get(enc("workout-plans/alice-run-block.json"))).ok()).toBeTruthy();
    } finally {
      await context.close();
    }
  });

  test("a fresh profile's list has none of alice's plans", async ({ me }) => {
    await openPlans(me);
    await expect(me.locator("#filelist")).toContainText(SHARED);
    await expect(me.locator("#filelist")).not.toContainText("alice-");
  });

  test("a profile's own data files sit under their own heading, with only Duplicate and Delete", async ({ me, profile }) => {
    await makeFile(profile.api, `data/${profile.name}/notes.json`, JSON.stringify({ hello: 1 }));
    await makeFile(profile.api, `workout-plans/${profile.name}-listed.json`, planJson());
    await openPlans(me);
    await expect(rowOf(me, "notes.json")).toHaveCount(1);
    await expect(me.locator("#filelist h2", { hasText: `data/${profile.name}` })).toHaveCount(1);
    const buttons = rowOf(me, "notes.json").locator("button");
    await expect(buttons).toHaveCount(2);
    await expect(buttons.nth(0)).toHaveAttribute("title", "Duplicate the file");
    await expect(buttons.nth(1)).toHaveAttribute("title", "Delete the file");
  });

  test("a plan's row offers Archive, Duplicate and Delete, and no Garmin button for a profile without Garmin", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-rowbtns.json`, planJson());
    await openPlans(me);
    const buttons = rowOf(me, `${profile.name}-rowbtns.json`).locator("button");
    await expect(buttons).toHaveCount(3);
    await expect(buttons.nth(0)).toHaveAttribute("title", /^Archive the plan/);
    await expect(buttons.nth(1)).toHaveAttribute("title", "Duplicate the file");
    await expect(buttons.nth(2)).toHaveAttribute("title", "Delete the file");
  });

  test("the open file's row is highlighted, and a click on a row opens that file", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-hl-a.json`, planJson({ notes: "a" }));
    await makeFile(profile.api, `workout-plans/${profile.name}-hl-b.json`, planJson({ notes: "b" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-hl-a.json`);
    await expect(me.locator("#filelist .file.active")).toHaveCount(1);
    await expect(me.locator("#filelist .file.active")).toContainText(`${profile.name}-hl-a.json`);
    await openPlan(me, `${profile.name}-hl-b.json`);
    await expect(me.locator("#filelist .file.active")).toContainText(`${profile.name}-hl-b.json`);
    await expect(me.locator("#filelist .file.active")).toHaveCount(1);
  });

  test("a plan file that is valid JSON but not a workout list is listed with no workout count and says so in Checks", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-notaplan.json`;
    await makeFile(profile.api, path, JSON.stringify({ hello: "world" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-notaplan.json`);
    await expect(me.locator("#problems")).toHaveText("Valid JSON (not a workout file, no further checks).");
    await expect(me.locator("#outline")).toHaveText("Not a workout plan.");
    await expect(me.locator("#badge")).toHaveText("");
    await me.locator("#fileBtn").click();
    await expect(me.locator("#archive")).toBeDisabled();
    await expect(me.locator("#dup")).toBeEnabled();
  });
});

test.describe("Plans: New", () => {
  test("Create stays off for an empty name, and for a name of spaces", async ({ me }) => {
    await openPlans(me);
    await me.locator("#new").click();
    await expect(me.locator("#dlgTitle")).toHaveText("New plan file");
    await expect(me.locator("#dlgInput")).toHaveValue("workouts-new.json");
    await me.locator("#dlgInput").fill("");
    await expect(me.locator("#dlgOk")).toBeDisabled();
    await me.locator("#dlgInput").fill("   ");
    await expect(me.locator("#dlgOk")).toBeDisabled();
    await me.locator("#dlgCancel").click();
    await expect(me.locator("#dlg")).toBeHidden();
  });

  test("Cancel makes nothing", async ({ me, profile }) => {
    await openPlans(me);
    await me.locator("#new").click();
    await me.locator("#dlgInput").fill(`${profile.name}-cancelled`);
    await me.locator("#dlgCancel").click();
    await expect(me.locator("#dlg")).toBeHidden();
    expect(await fileGone(profile.api, `workout-plans/${profile.name}-cancelled.json`)).toBeTruthy();
    await expect(me.locator("#current")).toHaveText("No file open");
  });

  test("a name becomes a plan in workout-plans/, with .json added, and opens with one workout for today", async ({ me, profile }) => {
    await openPlans(me);
    await me.locator("#new").click();
    await me.locator("#dlgInput").fill(`${profile.name}-fresh`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#current")).toContainText(`${profile.name}-fresh.json`);
    const stored = JSON.parse((await readFile(profile.api, `workout-plans/${profile.name}-fresh.json`)).text);
    expect(stored.workouts.map((w: { workoutName: string }) => w.workoutName)).toEqual(["New workout"]);
    expect(stored.weekStart).toBe(today());
    await expect(me.locator("#outline .row.wk .name")).toHaveText(["New workout"]);
    await expect(me.locator("#problems")).toContainText("Valid");
  });

  // newFile() creates the file, then opens it, and only then asks about the unsaved edits: Cancel leaves the new file behind.
  test.fixme("with unsaved edits in the open file, Cancel on the discard question after New leaves no new file behind", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-newcancel.json`, planJson({ notes: "saved" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-newcancel.json`);
    await setText(me, planJson({ notes: "unsaved edit" }));
    await me.locator("#new").click();
    await me.locator("#dlgInput").fill(`${profile.name}-newcancel-two`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#dlgTitle")).toHaveText("Discard unsaved changes?");
    await me.locator("#dlgCancel").click();
    await expect(me.locator("#dlg")).toBeHidden();
    expect(await fileGone(profile.api, `workout-plans/${profile.name}-newcancel-two.json`)).toBeTruthy();
  });

  test("a name with spaces and punctuation is kept as typed", async ({ me, profile }) => {
    await openPlans(me);
    await me.locator("#new").click();
    await me.locator("#dlgInput").fill(`${profile.name} draft!`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#current")).toContainText(`${profile.name} draft!.json`);
    expect((await profile.api.get(enc(`workout-plans/${profile.name} draft!.json`))).ok()).toBeTruthy();
  });

  test("a name that already exists is refused, and the open file stays open", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-taken.json`, planJson({ notes: "taken" }));
    await makeFile(profile.api, `workout-plans/${profile.name}-open.json`, planJson({ notes: "open" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-open.json`);
    await me.locator("#new").click();
    await me.locator("#dlgInput").fill(`${profile.name}-taken`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#toast")).toContainText("already exists");
    await expect(me.locator("#current")).toContainText(`${profile.name}-open.json`);
    expect((await readFile(profile.api, `workout-plans/${profile.name}-taken.json`)).text).toContain("taken");
  });

  test("a name that climbs out of the folder is refused", async ({ me, profile }) => {
    await openPlans(me);
    await me.locator("#new").click();
    await me.locator("#dlgInput").fill(`../${profile.name}-evil`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#toast")).toContainText('not allowed');
    await expect(me.locator("#current")).toHaveText("No file open");
  });

  test("a path into another profile's data folder is refused", async ({ me, profile }) => {
    await openPlans(me);
    await me.locator("#new").click();
    await me.locator("#dlgInput").fill(`data/nobody-${profile.name}/x`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#toast")).toContainText("belongs to another profile");
    await expect(me.locator("#current")).toHaveText("No file open");
  });

  test("with unsaved edits in the open file, Cancel on the discard question keeps the edits", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-keep.json`, planJson({ notes: "saved" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-keep.json`);
    await setText(me, planJson({ notes: "unsaved edit" }));
    await me.locator("#new").click();
    await me.locator("#dlgInput").fill(`${profile.name}-second`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#dlgTitle")).toHaveText("Discard unsaved changes?");
    await me.locator("#dlgCancel").click();
    await expect(me.locator("#dlg")).toBeHidden();
    await expect(me.locator("#current")).toContainText(`${profile.name}-keep.json`);
    expect(await textOf(me)).toContain("unsaved edit");
    await expect(me.locator("#save")).toBeEnabled();
  });
});

test.describe("Plans: Duplicate", () => {
  test("Duplicate copies the file under the name given and opens the copy", async ({ me, profile }) => {
    const original = planJson({ notes: "original" });
    await makeFile(profile.api, `workout-plans/${profile.name}-src.json`, original);
    await openPlans(me);
    await openPlan(me, `${profile.name}-src.json`);
    await fileMenu(me, "dup");
    await expect(me.locator("#dlgTitle")).toHaveText("Duplicate file");
    await expect(me.locator("#dlgInput")).toHaveValue(`workout-plans/${profile.name}-src-copy.json`);
    await me.locator("#dlgInput").fill(`workout-plans/${profile.name}-src-two.json`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#current")).toContainText(`${profile.name}-src-two.json`);
    expect((await readFile(profile.api, `workout-plans/${profile.name}-src-two.json`)).text).toBe(original);
  });

  test("the copy drops the workoutIds by default, so uploading it cannot replace the originals", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-ids.json`;
    await makeFile(profile.api, path, planWithIds());
    await openPlans(me);
    await openPlan(me, `${profile.name}-ids.json`);
    await fileMenu(me, "dup");
    await expect(me.locator("#dlgOpts input")).toBeChecked();
    await expect(me.locator("#dlgOpts")).toContainText("Remove the workoutIds from the copy");
    await me.locator("#dlgInput").fill(`workout-plans/${profile.name}-ids-copy.json`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#current")).toContainText(`${profile.name}-ids-copy.json`);
    expect((await readFile(profile.api, `workout-plans/${profile.name}-ids-copy.json`)).text).not.toContain("workoutId");
    expect((await readFile(profile.api, path)).text).toContain("5511");
  });

  test("with the box unticked, the copy keeps the workoutIds", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-keepids.json`, planWithIds());
    await openPlans(me);
    await openPlan(me, `${profile.name}-keepids.json`);
    await fileMenu(me, "dup");
    await me.locator("#dlgOpts input").uncheck();
    await me.locator("#dlgInput").fill(`workout-plans/${profile.name}-keepids-copy.json`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#current")).toContainText(`${profile.name}-keepids-copy.json`);
    expect((await readFile(profile.api, `workout-plans/${profile.name}-keepids-copy.json`)).text).toContain("5511");
  });

  test("the copy is made from the editor's unsaved text, and the original keeps its saved text", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-unsaved-src.json`;
    const saved = planJson({ notes: "saved" });
    await makeFile(profile.api, path, saved);
    await openPlans(me);
    await openPlan(me, `${profile.name}-unsaved-src.json`);
    await setText(me, planJson({ notes: "typed but not saved" }));
    await fileMenu(me, "dup");
    await me.locator("#dlgInput").fill(`workout-plans/${profile.name}-unsaved-copy.json`);
    await me.locator("#dlgOk").click();
    // the copy opens; the editor's unsaved edits are in the copy, so the discard question is answered yes
    await expect(me.locator("#dlgTitle")).toHaveText("Discard unsaved changes?");
    await me.locator("#dlgOk").click();
    await expect(me.locator("#current")).toContainText(`${profile.name}-unsaved-copy.json`);
    expect((await readFile(profile.api, `workout-plans/${profile.name}-unsaved-copy.json`)).text).toContain("typed but not saved");
    expect((await readFile(profile.api, path)).text).toBe(saved);
  });

  test("a copy under a name that already exists is refused", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-dupsrc.json`, planJson());
    await makeFile(profile.api, `workout-plans/${profile.name}-dupexists.json`, planJson({ notes: "exists" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-dupsrc.json`);
    await fileMenu(me, "dup");
    await me.locator("#dlgInput").fill(`workout-plans/${profile.name}-dupexists.json`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#toast")).toContainText("already exists");
    await expect(me.locator("#current")).toContainText(`${profile.name}-dupsrc.json`);
    expect((await readFile(profile.api, `workout-plans/${profile.name}-dupexists.json`)).text).toContain("exists");
  });

  test("a row's Duplicate copies that file, not the open one", async ({ me, profile }) => {
    const other = planJson({ notes: "row file" });
    await makeFile(profile.api, `workout-plans/${profile.name}-rowsrc.json`, other);
    await makeFile(profile.api, `workout-plans/${profile.name}-rowopen.json`, planJson({ notes: "open file" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-rowopen.json`);
    await rowOf(me, `${profile.name}-rowsrc.json`).locator("button[title='Duplicate the file']").click();
    await expect(me.locator("#dlgInput")).toHaveValue(`workout-plans/${profile.name}-rowsrc-copy.json`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#current")).toContainText(`${profile.name}-rowsrc-copy.json`);
    expect((await readFile(profile.api, `workout-plans/${profile.name}-rowsrc-copy.json`)).text).toBe(other);
  });
});

test.describe("Plans: Rename", () => {
  test("Rename moves the file, the editor follows it, and the list shows the new name", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-ren.json`;
    const text = planJson({ notes: "moving" });
    await makeFile(profile.api, path, text);
    await openPlans(me);
    await openPlan(me, `${profile.name}-ren.json`);
    await fileMenu(me, "rename");
    await expect(me.locator("#dlgTitle")).toHaveText("Rename file");
    await expect(me.locator("#dlgInput")).toHaveValue(path);
    await me.locator("#dlgInput").fill(`workout-plans/${profile.name}-ren2.json`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#current")).toContainText(`${profile.name}-ren2.json`);
    await expect(rowOf(me, `${profile.name}-ren2.json`)).toHaveCount(1);
    await expect(rowOf(me, `${profile.name}-ren.json`)).toHaveCount(0);
    expect(await fileGone(profile.api, path)).toBeTruthy();
    expect((await readFile(profile.api, `workout-plans/${profile.name}-ren2.json`)).text).toBe(text);
    expect(await textOf(me)).toBe(text);
  });

  test("Rename to a name that exists is refused and nothing moves", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-r-a.json`, planJson({ notes: "a" }));
    await makeFile(profile.api, `workout-plans/${profile.name}-r-b.json`, planJson({ notes: "b" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-r-a.json`);
    await fileMenu(me, "rename");
    await me.locator("#dlgInput").fill(`workout-plans/${profile.name}-r-b.json`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#toast")).toContainText("already exists");
    await expect(me.locator("#current")).toContainText(`${profile.name}-r-a.json`);
    expect((await readFile(profile.api, `workout-plans/${profile.name}-r-a.json`)).text).toContain('"a"');
  });

  test("Rename outside workout-plans/ and data/ is refused", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-out.json`, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-out.json`);
    await fileMenu(me, "rename");
    await me.locator("#dlgInput").fill("elsewhere/out.json");
    await me.locator("#dlgOk").click();
    await expect(me.locator("#toast")).toContainText("must start with");
    await expect(me.locator("#current")).toContainText(`${profile.name}-out.json`);
  });

  test("Rename keeps the file's earlier versions", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-hist.json`, planJson({ notes: "v1" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-hist.json`);
    await setText(me, planJson({ notes: "v2" }));
    await me.locator("#save").click();
    await expect(me.locator("#save")).toBeDisabled();
    await fileMenu(me, "rename");
    await me.locator("#dlgInput").fill(`workout-plans/${profile.name}-hist2.json`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#current")).toContainText(`${profile.name}-hist2.json`);
    const history = await me.request.get(`/api/history?path=${encodeURIComponent(`workout-plans/${profile.name}-hist2.json`)}`, { headers: { "X-Requested-With": "plan-editor" } });
    expect((await history.json()).revisions.length).toBe(1);
  });

  test("Rename to the same name does nothing", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-same.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-same.json`);
    await fileMenu(me, "rename");
    await me.locator("#dlgOk").click();
    await expect(me.locator("#dlg")).toBeHidden();
    await expect(me.locator("#current")).toContainText(`${profile.name}-same.json`);
    expect((await readFile(profile.api, path)).version).toBeGreaterThan(0);
  });

  // The page saves the open file before a rename, and ignores the save's failure: the rename goes ahead with the other
  // change, and the editor keeps the unsaved edits under the new name with the other change's version. The next Save then
  // overwrites what someone else saved.
  test.fixme("renaming a plan with unsaved edits that conflict with a change elsewhere does not rename it", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-rconf.json`;
    await makeFile(profile.api, path, planJson({ notes: "start" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-rconf.json`);
    await setText(me, planJson({ notes: "mine" }));
    const theirs = planJson({ notes: "theirs" });
    await writeFile(profile.api, path, theirs);
    await fileMenu(me, "rename");
    await me.locator("#dlgInput").fill(`workout-plans/${profile.name}-rconf2.json`);
    await me.locator("#dlgOk").click();
    await expect(me.locator("#toast")).toContainText("changed since you opened it");
    expect((await readFile(profile.api, path)).text).toBe(theirs);
    await expect(me.locator("#current")).toContainText(`${profile.name}-rconf.json`);
  });
});

test.describe("Plans: Delete", () => {
  test("Delete asks first, and Cancel keeps the file", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-keepme.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-keepme.json`);
    await fileMenu(me, "delete");
    await expect(me.locator("#dlgTitle")).toHaveText(`Delete ${path}?`);
    await expect(me.locator("#dlgOk")).toHaveText("Delete");
    await me.locator("#dlgCancel").click();
    await expect(me.locator("#dlg")).toBeHidden();
    expect((await readFile(profile.api, path)).text).toBe(planJson());
    await expect(me.locator("#current")).toContainText(`${profile.name}-keepme.json`);
  });

  test("Delete removes the file, empties the editor and says so", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-gone.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-gone.json`);
    await fileMenu(me, "delete");
    await me.locator("#dlgOk").click();
    await expect(me.locator("#current")).toHaveText("No file open");
    await expect(me.locator("#toast")).toHaveText("Deleted");
    await expect(rowOf(me, `${profile.name}-gone.json`)).toHaveCount(0);
    await expect(me.locator("#outline")).toHaveText("Open a plan.");
    expect(await fileGone(profile.api, path)).toBeTruthy();
  });

  // remove() hands showValidation(null), which prints the "Valid JSON (not a workout file...)" line; with no file open the
  // pane should say "Nothing to report." as it does on a fresh page, but keeps that line.
  test.fixme("after the open file is deleted, Checks says nothing instead of the last file's result", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-stale.json`, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-stale.json`);
    await fileMenu(me, "delete");
    await me.locator("#dlgOk").click();
    await expect(me.locator("#current")).toHaveText("No file open");
    await expect(me.locator("#problems")).toHaveText("Nothing to report.");
  });

  test("a row's Delete removes that file and leaves the open one alone", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-rowdel.json`, planJson());
    await makeFile(profile.api, `workout-plans/${profile.name}-rowkeep.json`, planJson({ notes: "keep" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-rowkeep.json`);
    await rowOf(me, `${profile.name}-rowdel.json`).locator("button[title='Delete the file']").click();
    await me.locator("#dlgOk").click();
    await expect(rowOf(me, `${profile.name}-rowdel.json`)).toHaveCount(0);
    await expect(me.locator("#current")).toContainText(`${profile.name}-rowkeep.json`);
    expect(await fileGone(profile.api, `workout-plans/${profile.name}-rowdel.json`)).toBeTruthy();
  });
});

test.describe("Plans: History", () => {
  test("a file never changed since it was made says so, with only the current version listed", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-nohist.json`, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-nohist.json`);
    await fileMenu(me, "history");
    await expect(me.locator("#hdlg")).toBeVisible();
    await expect(me.locator("#hdlgTitle")).toHaveText(`History of workout-plans/${profile.name}-nohist.json`);
    await expect(me.locator("#hdlgText")).toHaveText("No earlier version: this file has not been changed since it was created.");
    await expect(me.locator("#hdlgList .hrow")).toHaveCount(1);
    await expect(me.locator("#hdlgList .hrow button")).toHaveCount(0);
    await me.locator("#hdlgClose").click();
    await expect(me.locator("#hdlg")).toBeHidden();
  });

  test("the history lists the earlier versions, newest first, with who saved each", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-twov.json`, planJson({ notes: "v1" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-twov.json`);
    await setText(me, planJson({ notes: "v2" }));
    await me.locator("#save").click();
    await expect(me.locator("#save")).toBeDisabled();
    await setText(me, planJson({ notes: "v3" }));
    await me.locator("#save").click();
    await expect(me.locator("#save")).toBeDisabled();
    await fileMenu(me, "history");
    await expect(me.locator("#hdlgText")).toHaveText("Load an earlier version into the editor, then Save to keep it.");
    const rows = me.locator("#hdlgList .hrow");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Now");
    await expect(rows.nth(1)).toContainText("saved by web");
    await expect(rows.nth(2)).toContainText("saved by web");
    await expect(rows.nth(1).locator("button")).toHaveText("Load");
    await expect(rows.nth(0).locator("button")).toHaveCount(0);
  });

  test("Load puts an earlier version in the editor, and Save makes it the current one", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-loadv.json`;
    const v1 = planJson({ notes: "v1" });
    await makeFile(profile.api, path, v1);
    await openPlans(me);
    await openPlan(me, `${profile.name}-loadv.json`);
    await setText(me, planJson({ notes: "v2" }));
    await me.locator("#save").click();
    await expect(me.locator("#save")).toBeDisabled();
    await fileMenu(me, "history");
    await me.locator("#hdlgList .hrow").nth(1).locator("button").click();
    await expect(me.locator("#hdlg")).toBeHidden();
    await expect(me.locator("#toast")).toContainText("press Save to make it the current one");
    expect(await textOf(me)).toBe(v1);
    await expect(me.locator("#save")).toBeEnabled();
    await me.locator("#save").click();
    await expect(me.locator("#save")).toBeDisabled();
    expect((await readFile(profile.api, path)).text).toBe(v1);
    await fileMenu(me, "history");
    await expect(me.locator("#hdlgList .hrow")).toHaveCount(3); // now, and the two versions saved before it
    await me.locator("#hdlgClose").click();
  });

  test("Load over unsaved edits asks first, and Cancel keeps the edits", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-loadkeep.json`, planJson({ notes: "v1" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-loadkeep.json`);
    await setText(me, planJson({ notes: "v2" }));
    await me.locator("#save").click();
    await expect(me.locator("#save")).toBeDisabled();
    await setText(me, planJson({ notes: "unsaved" }));
    await fileMenu(me, "history");
    await me.locator("#hdlgList .hrow").nth(1).locator("button").click();
    await expect(me.locator("#dlgTitle")).toHaveText("Replace the unsaved changes?");
    await me.locator("#dlgCancel").click();
    await expect(me.locator("#dlg")).toBeHidden();
    expect(await textOf(me)).toContain("unsaved");
    await expect(me.locator("#hdlg")).toBeVisible();
  });
});

test.describe("Plans: switching files and leaving the page", () => {
  test("opening another file with unsaved edits asks; Cancel keeps the file open and the edits", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-sw-a.json`, planJson({ notes: "a" }));
    await makeFile(profile.api, `workout-plans/${profile.name}-sw-b.json`, planJson({ notes: "b" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-sw-a.json`);
    await setText(me, planJson({ notes: "dirty" }));
    await rowOf(me, `${profile.name}-sw-b.json`).click();
    await expect(me.locator("#dlgTitle")).toHaveText("Discard unsaved changes?");
    await me.locator("#dlgCancel").click();
    await expect(me.locator("#dlg")).toBeHidden();
    await expect(me.locator("#current")).toContainText(`${profile.name}-sw-a.json`);
    expect(await textOf(me)).toContain("dirty");
  });

  test("Discard on the same question opens the other file as it was saved", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-sd-a.json`, planJson({ notes: "a" }));
    const bText = planJson({ notes: "b saved" });
    await makeFile(profile.api, `workout-plans/${profile.name}-sd-b.json`, bText);
    await openPlans(me);
    await openPlan(me, `${profile.name}-sd-a.json`);
    await setText(me, planJson({ notes: "dirty" }));
    await rowOf(me, `${profile.name}-sd-b.json`).click();
    await me.locator("#dlgOk").click();
    await expect(me.locator("#current")).toContainText(`${profile.name}-sd-b.json`);
    await expect.poll(() => textOf(me)).toBe(bText);
    await expect(me.locator("#save")).toBeDisabled();
  });

  test("reloading the page with unsaved edits asks before leaving", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-leave.json`, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-leave.json`);
    await typeAtEnd(me, " ");
    await expect(me.locator("#save")).toBeEnabled();
    const asked: string[] = [];
    me.on("dialog", (dialog) => {
      asked.push(dialog.type());
      void dialog.dismiss();
    });
    await me.evaluate(() => setTimeout(() => location.reload(), 0));
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    expect(asked).toEqual(["beforeunload"]);
    await expect(me.locator("#save")).toBeEnabled();
    expect(await textOf(me)).toMatch(/\s$/);
  });
});

test.describe("Plans: Archive", () => {
  test("a plan whose workouts are on Garmin cannot be archived without a Garmin login: nothing changes", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-noarch.json`;
    await makeFile(profile.api, path, planWithIds());
    await openPlans(me);
    await openPlan(me, `${profile.name}-noarch.json`);
    await fileMenu(me, "archive");
    await expect(me.locator("#toast")).toContainText(GARMIN_REASON);
    await expect(me.locator("#dlg")).toBeHidden();
    expect(((await (await profile.api.get("/api/files")).json()).files as { path: string; archivedAt: number | null }[]).find((f) => f.path === path)?.archivedAt).toBeNull();
  });

  test("Archive asks, then lists the plan under Archived, with its Garmin button off", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-arch.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-arch.json`);
    await fileMenu(me, "archive");
    await expect(me.locator("#dlgTitle")).toHaveText("Archive this plan?");
    await expect(me.locator("#dlgOk")).toHaveText("Archive");
    await me.locator("#dlgOk").click();
    await expect(me.locator("#filelist details.shelved summary")).toHaveText("Archived (1)");
    await expect(me.locator("#filelist details.shelved")).toContainText(`${profile.name}-arch.json`);
    await expect(me.locator("#current")).toHaveClass(/archived/);
    await expect(me.locator("#garminBtn")).toBeDisabled();
    await expect(me.locator("#garminBtn")).toHaveAttribute("title", "This plan is archived: unarchive it to send its workouts to Garmin.");
    expect(((await (await profile.api.get("/api/files")).json()).files as { path: string; archivedAt: number | null }[]).find((f) => f.path === path)?.archivedAt).not.toBeNull();
    expect((await readFile(profile.api, path)).text).toBe(planJson());
  });

  test("an archived plan's File menu offers Unarchive, and its row offers Unarchive, Duplicate and Delete", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-arbtn.json`, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-arbtn.json`);
    await fileMenu(me, "archive");
    await me.locator("#dlgOk").click();
    await expect(me.locator("#filelist details.shelved summary")).toHaveText("Archived (1)");
    await me.locator("#fileBtn").click();
    await expect(me.locator("#archive")).toHaveText("Unarchive");
    await expect(me.locator("#archive")).toBeEnabled();
    await me.locator("#fileBtn").click(); // close the menu again
    const buttons = rowOf(me, `${profile.name}-arbtn.json`).locator("button");
    await expect(buttons).toHaveCount(3);
    await expect(buttons.nth(0)).toHaveAttribute("title", "Unarchive the plan");
    await expect(buttons.nth(1)).toHaveAttribute("title", "Duplicate the file");
    await expect(buttons.nth(2)).toHaveAttribute("title", "Delete the file");
  });

  test("Unarchive brings the plan back to the list", async ({ me, profile }) => {
    const path = `workout-plans/${profile.name}-back.json`;
    await makeFile(profile.api, path, planJson());
    await openPlans(me);
    await openPlan(me, `${profile.name}-back.json`);
    await fileMenu(me, "archive");
    await me.locator("#dlgOk").click();
    await expect(me.locator("#filelist details.shelved summary")).toHaveText("Archived (1)");
    await fileMenu(me, "archive");
    await expect(me.locator("#toast")).toContainText("Unarchived");
    await expect(me.locator("#filelist details.shelved")).toHaveCount(0);
    await expect(me.locator("#current")).not.toHaveClass(/archived/);
    await expect(me.locator("#garminBtn")).toBeDisabled();
    await expect(me.locator("#garminBtn")).toHaveAttribute("title", GARMIN_REASON);
    expect(((await (await profile.api.get("/api/files")).json()).files as { path: string; archivedAt: number | null }[]).find((f) => f.path === path)?.archivedAt).toBeNull();
  });

  test("an archived plan leaves the Calendar, and comes back when unarchived", async ({ me, profile }) => {
    const name = `${profile.name}-cal`;
    await makeFile(profile.api, `workout-plans/${name}.json`, planJson());
    await openPlans(me);
    await openPlan(me, `${name}.json`);
    await me.locator("#vCalendar").click();
    await expect(me.locator("#cLegend")).toContainText(name);
    await openPlans(me);
    await openPlan(me, `${name}.json`);
    await fileMenu(me, "archive");
    await me.locator("#dlgOk").click();
    await expect(me.locator("#filelist details.shelved summary")).toHaveText("Archived (1)");
    await me.locator("#vCalendar").click();
    await expect(me.locator("body")).toHaveAttribute("data-view", "calendar");
    await expect(me.locator("#cLegend")).not.toContainText(name);
    await openPlans(me);
    await openPlan(me, `${name}.json`);
    await fileMenu(me, "archive"); // for an archived plan the File menu's Archive is Unarchive
    await expect(me.locator("#toast")).toContainText("Unarchived");
    await me.locator("#vCalendar").click();
    await expect(me.locator("#cLegend")).toContainText(name);
  });

  // The group opens itself when the open file is archived, and that programmatic open fires its toggle handler, which
  // records it as the user's choice (showArchived). So the group stays open after the open file moves out of it.
  test.fixme("the Archived group is closed unless the open file is in it", async ({ me, profile }) => {
    await makeFile(profile.api, `workout-plans/${profile.name}-grp-a.json`, planJson({ notes: "a" }));
    await makeFile(profile.api, `workout-plans/${profile.name}-grp-b.json`, planJson({ notes: "b" }));
    await openPlans(me);
    await openPlan(me, `${profile.name}-grp-a.json`);
    await fileMenu(me, "archive");
    await me.locator("#dlgOk").click();
    await expect(me.locator("#filelist details.shelved")).toHaveAttribute("open", "");
    await openPlan(me, `${profile.name}-grp-b.json`);
    await expect(me.locator("#filelist details.shelved")).not.toHaveAttribute("open", "");
    await expect(me.locator("#filelist details.shelved summary")).toHaveText("Archived (1)");
  });

});
