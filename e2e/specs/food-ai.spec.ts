/**
 * The Food view's AI box: "Describe or photograph what you ate". The words and photos go to POST /api/foods/ai, which is answered
 * here by stubAi (Claude is never reached). The server of the suite has no Claude key, so the page's own answers from
 * /api/nutrition are made to say the box is set up (enableAi); logging goes to the real server, and the log is read back.
 */
import { test, expect, openView, today, daysAgo, type Page, type APIRequestContext } from "../support/fixtures";

// Estimates as the server answers them: each food for the amount eaten, with that amount, the meal and the nutrients it can give.
const EGGS = { name: "Scrambled eggs", portion: "2 large eggs", meal: "breakfast", amount: 120, unit: "g", kcal: 180, proteinG: 13, carbsG: 2, fatG: 13, nutrients: { sodiumMg: 300 } };
const TOAST = { name: "Whole wheat toast", portion: "1 slice", meal: "breakfast", amount: 35, unit: "g", kcal: 90, proteinG: 4, carbsG: 15, fatG: 1, nutrients: {} };
const SALMON = { name: "Salmon", portion: "100 g", meal: "dinner", amount: 100, unit: "g", kcal: 200, proteinG: 22, carbsG: 0, fatG: 12, nutrients: {} };
const ESTIMATE = { items: [EGGS, TOAST, SALMON], note: "Assumed 1 cup of cooked rice.", remaining: 29 };

interface Answer { status?: number; json: any }
type Handler = (body: any) => Answer | Promise<Answer>;

/**
 * Answers POST /api/foods/ai. Every question asked is recorded, in order (its JSON body: text, images, profile, defaultMeal).
 */
async function stubAi(page: Page, handler: Handler = () => ({ json: ESTIMATE })): Promise<any[]> {
  const asked: any[] = [];
  await page.route("**/api/foods/ai", async (route) => {
    const body = route.request().postDataJSON();
    asked.push(body);
    const answer = await handler(body);
    await route.fulfill({ status: answer.status ?? 200, json: answer.json });
  });
  return asked;
}

/**
 * The page is told that Claude is set up here: the status it reads from /api/nutrition (ai.enabled) is set on, every answer of the
 * log. The server itself is not changed: the estimate is stubAi's, and what is logged goes to the real server.
 * Every POST to the log is recorded, to see that logging is one request.
 */
async function enableAi(page: Page, remaining?: number): Promise<any[]> {
  const posts: any[] = [];
  await page.route("**/api/nutrition*", async (route) => {
    const request = route.request();
    if (request.method() === "POST") posts.push(request.postDataJSON());
    // the answer is the server's own: a connection the server reset under load is asked again, not failed
    let response;
    for (let attempt = 1; ; attempt++) {
      try { response = await route.fetch(); break; } catch (error) { if (attempt === 3) throw error; }
    }
    const json = await response.json();
    if (json.ai) {
      json.ai.enabled = true;
      if (remaining !== undefined) json.ai.remaining = remaining;
    }
    await route.fulfill({ response, json });
  });
  return posts;
}

interface Logged { id: number; meal: string; name: string; kcal: number; proteinG: number; carbsG: number; fatG: number; nutrients: Record<string, number> }

/** The foods of the log on a day, each with its meal. */
async function logged(api: APIRequestContext, day = today()): Promise<Logged[]> {
  const res = await api.get(`/api/nutrition?date=${day}`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.day.meals.flatMap((m: any) => m.entries.map((e: any) => ({ ...e, meal: m.meal })));
}

/** A small JPEG, made by the browser: the photo the box is given. */
async function jpeg(page: Page): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 48; canvas.height = 36;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#c33"; ctx.fillRect(0, 0, 48, 36);
    ctx.fillStyle = "#fc3"; ctx.fillRect(10, 10, 20, 16);
    return canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
  });
  return { name: "meal.jpg", mimeType: "image/jpeg", buffer: Buffer.from(base64, "base64") };
}

const box = (page: Page) => page.locator("#fbody .fai");
const words = (page: Page) => page.locator("#fbody .faitext");
const estimateButton = (page: Page) => page.locator("#fbody .fai").getByRole("button", { name: "Estimate", exact: true });
const rows = (page: Page) => page.locator("#fbody .faires .fair");
const row = (page: Page, name: string) => page.locator("#fbody .faires .fair", { has: page.locator("b", { hasText: name }) });
const logButton = (page: Page) => page.locator("#fbody .faires .fpa button.primary");
const totals = (page: Page) => page.locator("#fbody .faires .fpv");
const fileInput = (page: Page) => page.locator('#fbody .fai input[type="file"]:not([capture])');
const section = (page: Page, meal: string) => page.locator(`#fbody section.fmeal[data-meal="${meal}"]`);

/** Types the words and presses Estimate, and returns once the server has answered (with rows or with an error). */
async function ask(page: Page, text: string) {
  await words(page).fill(text);
  await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/foods/ai")), estimateButton(page).click()]);
}

test.describe("opening the box", () => {
  test("the address #food/ai opens the box, with the words ready to type in", async ({ me }) => {
    await enableAi(me);
    await me.goto("/#food/ai");
    await expect(me.locator("body")).toHaveAttribute("data-view", "food");
    await expect(words(me)).toBeFocused();
    await expect(box(me).locator(".faihead")).toHaveAttribute("aria-expanded", "true");
    expect(me.url()).toMatch(/#food\/ai$/);
  });

  test("on #food the box is shut, and its head opens it and puts #food/ai in the address", async ({ me }) => {
    await enableAi(me);
    await openView(me, "food");
    await expect(box(me).locator(".faihead")).toHaveAttribute("aria-expanded", "false");
    await expect(words(me)).toHaveCount(0);
    await box(me).locator(".faihead").click();
    await expect(words(me)).toBeVisible();
    await expect(me).toHaveURL(/#food\/ai$/);
  });

  test("its head shuts the box again, and the address goes back to #food", async ({ me }) => {
    await enableAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await expect(words(me)).toBeVisible();
    await box(me).locator(".faihead").click();
    await expect(words(me)).toHaveCount(0);
    await expect(me).toHaveURL(/#food$/);
  });

  test("with no Claude set up on the server, the box says so and offers no words to estimate", async ({ me }) => {
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await expect(box(me).locator(".fnote.err")).toContainText("AI logging is not set up on this server");
    await expect(words(me)).toHaveCount(0);
  });

  test("the box says how many estimates are left today", async ({ me }) => {
    await enableAi(me, 4);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await expect(box(me)).toContainText("Logs to today · 4 of 30 daily estimates left.");
  });

  test("the count of the estimate's answer replaces the one the box had", async ({ me }) => {
    await enableAi(me, 4);
    await stubAi(me, () => ({ json: { ...ESTIMATE, remaining: 3 } }));
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    await expect(box(me)).toContainText("3 of 30 daily estimates left.");
  });

  test("the words box holds at most 1000 characters", async ({ me }) => {
    await enableAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await expect(words(me)).toHaveAttribute("maxlength", "1000");
  });
});

test.describe("asking", () => {
  test("Estimate is off until there are three characters, and on from three", async ({ me }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await expect(estimateButton(me)).toBeDisabled();
    await words(me).fill("ab");
    await expect(estimateButton(me)).toBeDisabled();
    await words(me).fill("abc");
    await expect(estimateButton(me)).toBeEnabled();
  });

  test("the words are sent with the profile, and the meal of the hour", async ({ me, profile }) => {
    await enableAi(me);
    const asked = await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast for breakfast");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ profile: profile.name, text: "2 eggs and toast for breakfast", images: [] });
    expect(["breakfast", "lunch", "dinner", "snack"]).toContain(asked[0].defaultMeal);
  });

  test("the meal of the hour is dinner at half past seven", async ({ me }) => {
    await me.clock.install({ time: new Date("2026-10-30T19:30:00Z") });
    await enableAi(me);
    const asked = await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "a bowl of soup");
    expect(asked[0].defaultMeal).toBe("dinner");
  });

  test("Ctrl+Enter in the words asks for the estimate", async ({ me }) => {
    await enableAi(me);
    const asked = await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await words(me).fill("a bowl of oatmeal");
    await words(me).press("Control+Enter");
    await expect(rows(me).first()).toBeVisible();
    expect(asked).toHaveLength(1);
  });

  test("a question with no food in it gets the AI's reason and no rows to log", async ({ me, profile }) => {
    await enableAi(me);
    await stubAi(me, () => ({ json: { items: [], note: "There is no food in that: say what you ate.", remaining: 28 } }));
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "the weather is nice today");
    await expect(me.locator("#fbody .faires")).toContainText("There is no food in that: say what you ate.");
    await expect(rows(me)).toHaveCount(0);
    await expect(logButton(me)).toHaveCount(0);
    expect(await logged(profile.api)).toHaveLength(0);
  });
});

test.describe("checking the estimate", () => {
  test("the rows are grouped by meal, in the day's order", async ({ me }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    const headings = await me.locator("#fbody .faires .fgroup").allTextContents();
    expect(headings).toEqual(["Breakfast", "Dinner"]);
    await expect(row(me, "Scrambled eggs")).toBeVisible();
    await expect(row(me, "Whole wheat toast")).toBeVisible();
    await expect(row(me, "Salmon")).toBeVisible();
    await expect(rows(me)).toHaveCount(3);
  });

  test("each row shows its name with the assumption, its amount in grams, its calories and its nutrients", async ({ me }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    const eggs = row(me, "Scrambled eggs");
    await expect(eggs.locator(".fain")).toContainText("assumed: 2 large eggs");
    await expect(eggs.getByRole("spinbutton", { name: "Amount of Scrambled eggs in g" })).toHaveValue("120");
    await expect(eggs.locator(".fairk")).toHaveText("≈ 180 kcal");
    await expect(eggs.locator(".fnote")).toHaveText("P 13 · C 2 · F 13 · Sodium 300 mg");
    await expect(eggs.getByRole("combobox", { name: "Meal of Scrambled eggs" })).toHaveValue("breakfast");
    await expect(row(me, "Whole wheat toast").locator(".fnote")).toHaveText("P 4 · C 15 · F 1");
  });

  test("the total of the rows and the AI's note are shown under them", async ({ me }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    await expect(totals(me)).toHaveText("≈ 470 kcal · P 39 · C 17 · F 26");
    await expect(me.locator("#fbody .faires")).toContainText("Assumed 1 cup of cooked rice.");
    await expect(logButton(me)).toHaveText("Log 3 foods");
  });

  test("an amount typed rescales its row and the total", async ({ me }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    await row(me, "Scrambled eggs").getByRole("spinbutton", { name: "Amount of Scrambled eggs in g" }).fill("60");
    await expect(row(me, "Scrambled eggs").locator(".fairk")).toHaveText("≈ 90 kcal");
    await expect(row(me, "Scrambled eggs").locator(".fnote")).toHaveText("P 6.5 · C 1 · F 6.5 · Sodium 150 mg");
    await expect(totals(me)).toHaveText("≈ 380 kcal · P 32.5 · C 16 · F 19.5");
  });

  test("an amount of 0 says so on its row, and Log is off until it is fixed", async ({ me }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    const eggs = row(me, "Scrambled eggs");
    await eggs.getByRole("spinbutton", { name: "Amount of Scrambled eggs in g" }).fill("0");
    await expect(eggs.locator(".fnote")).toHaveText("Give an amount above 0 (up to 2000 g).");
    await expect(eggs.locator(".fnote")).toHaveClass(/err/);
    await expect(eggs.locator(".fairk")).toHaveText("–");
    await expect(logButton(me)).toBeDisabled();
    await eggs.getByRole("spinbutton", { name: "Amount of Scrambled eggs in g" }).fill("120");
    await expect(logButton(me)).toBeEnabled();
  });

  test("a row left out with ✕ is not logged, and the total and the count follow", async ({ me }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    await me.getByRole("button", { name: "Leave out Salmon" }).click();
    await expect(rows(me)).toHaveCount(2);
    await expect(totals(me)).toHaveText("≈ 270 kcal · P 17 · C 17 · F 14");
    await expect(logButton(me)).toHaveText("Log 2 foods");
  });

  test("a row's meal can be changed, and the row moves to that meal's group", async ({ me }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    await row(me, "Scrambled eggs").getByRole("combobox", { name: "Meal of Scrambled eggs" }).selectOption("lunch");
    await expect(me.locator("#fbody .faires .fgroup")).toHaveText(["Breakfast", "Lunch", "Dinner"]);
    await expect(row(me, "Scrambled eggs").getByRole("combobox", { name: "Meal of Scrambled eggs" })).toHaveValue("lunch");
  });

  test("a food whose numbers cannot be per 100 g keeps its amount: no amount box, and it is still logged", async ({ me, profile }) => {
    await enableAi(me);
    const butter = { name: "Butter", portion: "1 tsp", meal: "snack", amount: 10, unit: "g", kcal: 72, proteinG: 0, carbsG: 0, fatG: 80, nutrients: {} };
    await stubAi(me, () => ({ json: { items: [butter], note: "", remaining: 27 } }));
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "a teaspoon of butter");
    const fixed = row(me, "Butter");
    await expect(fixed.getByRole("spinbutton")).toHaveCount(0);
    await expect(fixed.locator(".fpq")).toContainText("10 g");
    await expect(fixed.locator(".fairk")).toHaveText("≈ 72 kcal");
    await logButton(me).click();
    await expect(me.locator("#toast")).toContainText("Logged 1 food.");
    const [entry] = await logged(profile.api);
    expect(entry).toMatchObject({ name: "Butter · 10 g", meal: "snack", kcal: 72, fatG: 80 });
  });

  test("closing the box keeps the estimate for when it is opened again", async ({ me }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    await box(me).locator(".faihead").click();
    await expect(words(me)).toHaveCount(0);
    await box(me).locator(".faihead").click();
    await expect(rows(me)).toHaveCount(3);
    await expect(words(me)).toHaveValue("2 eggs and toast, salmon for dinner");
  });

  test("Clear forgets the estimate and keeps the words", async ({ me }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    await me.locator("#fbody .faires").getByRole("button", { name: "Clear", exact: true }).click();
    await expect(rows(me)).toHaveCount(0);
    await expect(logButton(me)).toHaveCount(0);
    await expect(words(me)).toHaveValue("2 eggs and toast, salmon for dinner");
  });

  test("Estimate again asks again, with the words as they are now", async ({ me }) => {
    await enableAi(me);
    const asked = await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast");
    await words(me).fill("2 eggs, toast and a banana");
    await me.locator("#fbody .faires").getByRole("button", { name: "Estimate again" }).click();
    await expect.poll(() => asked.map((a) => a.text)).toEqual(["2 eggs and toast", "2 eggs, toast and a banana"]);
  });
});

test.describe("logging the estimate", () => {
  test("Log sends the kept rows in one request, each with its own meal", async ({ me, profile }) => {
    const posts = await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    await logButton(me).click();
    await expect(me.locator("#toast")).toContainText("Logged 3 foods.");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ action: "add", day: today(), meal: "breakfast" });
    expect(posts[0].items.map((i: any) => [i.name, i.meal])).toEqual([["Scrambled eggs · 120 g", "breakfast"], ["Whole wheat toast · 35 g", "breakfast"], ["Salmon · 100 g", "dinner"]]);
    expect(posts[0].items[0]).toMatchObject({ kcal: 180, proteinG: 13, carbsG: 2, fatG: 13, nutrients: { sodiumMg: 300 } });
    const entries = await logged(profile.api);
    expect(entries.map((e) => [e.name, e.meal, e.kcal]).sort()).toEqual([["Salmon · 100 g", "dinner", 200], ["Scrambled eggs · 120 g", "breakfast", 180], ["Whole wheat toast · 35 g", "breakfast", 90]]);
  });

  test("a row whose meal was changed is logged in that meal", async ({ me, profile }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    await row(me, "Scrambled eggs").getByRole("combobox", { name: "Meal of Scrambled eggs" }).selectOption("snack");
    await logButton(me).click();
    await expect(me.locator("#toast")).toContainText("Logged 3 foods.");
    const entries = await logged(profile.api);
    expect(entries.find((e) => e.name === "Scrambled eggs · 120 g")?.meal).toBe("snack");
    expect(entries.find((e) => e.name === "Whole wheat toast · 35 g")?.meal).toBe("breakfast");
  });

  test("an amount changed before Log is logged with the new amount and its numbers", async ({ me, profile }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    await row(me, "Scrambled eggs").getByRole("spinbutton", { name: "Amount of Scrambled eggs in g" }).fill("60");
    await logButton(me).click();
    await expect(me.locator("#toast")).toContainText("Logged 3 foods.");
    const eggs = (await logged(profile.api)).find((e) => e.name === "Scrambled eggs · 60 g");
    expect(eggs).toMatchObject({ kcal: 90, meal: "breakfast" });
    expect(eggs?.proteinG).toBeCloseTo(6.5);
  });

  test("after Log the box is cleared and the foods show in the log, each in its meal", async ({ me, profile }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    await logButton(me).click();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Scrambled eggs · 120 g" })).toBeVisible();
    await expect(section(me, "breakfast").locator(".fe .fn", { hasText: "Whole wheat toast · 35 g" })).toBeVisible();
    await expect(section(me, "dinner").locator(".fe .fn", { hasText: "Salmon · 100 g" })).toBeVisible();
    await expect(words(me)).toHaveValue("");
    await expect(rows(me)).toHaveCount(0);
    await expect(logButton(me)).toHaveCount(0);
    expect(await logged(profile.api)).toHaveLength(3);
  });

  test("Undo in the toast takes all of the foods back", async ({ me, profile }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast, salmon for dinner");
    await logButton(me).click();
    await expect(me.locator("#toast")).toContainText("Logged 3 foods.");
    await me.locator("#toast").getByRole("button", { name: "Undo" }).click();
    await expect(me.locator("#toast")).toContainText("Removed 3 foods.");
    await expect.poll(async () => (await logged(profile.api)).length).toBe(0);
    await expect(section(me, "breakfast").locator(".fe")).toHaveCount(0);
  });
});

test.describe("a past day", () => {
  test("the box says which day it logs to, and the estimate is logged on that day", async ({ me, profile }) => {
    const posts = await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await me.locator("#fPrev").click();
    await expect(me.locator("#fDate")).toHaveValue(daysAgo(1));
    await box(me).locator(".faihead").click();
    const day = new Date(`${daysAgo(1)}T00:00:00Z`);
    const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    await expect(box(me)).toContainText(`Logs to ${DOW[day.getUTCDay()]} ${day.getUTCDate()} ${MON[day.getUTCMonth()]} ·`);
    await ask(me, "2 eggs and toast, salmon for dinner");
    await logButton(me).click();
    await expect(me.locator("#toast")).toContainText("Logged 3 foods.");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ action: "add", day: daysAgo(1) });
    expect(await logged(profile.api, daysAgo(1))).toHaveLength(3);
    expect(await logged(profile.api)).toHaveLength(0);
  });
});

test.describe("errors, and the estimate under way", () => {
  test("a limit of the day (429) is shown in the box, and nothing is logged", async ({ me, profile }) => {
    const posts = await enableAi(me);
    await stubAi(me, () => ({ status: 429, json: { error: "That is today's limit of 30 AI estimates. It starts again tomorrow." } }));
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast");
    await expect(box(me).locator(".fnote.err")).toHaveText("That is today's limit of 30 AI estimates. It starts again tomorrow.");
    await expect(rows(me)).toHaveCount(0);
    expect(posts).toHaveLength(0);
    expect(await logged(profile.api)).toHaveLength(0);
  });

  test("a server error (500) is shown in the box, and nothing is logged", async ({ me, profile }) => {
    const posts = await enableAi(me);
    await stubAi(me, () => ({ status: 500, json: { error: "Claude is having trouble right now. Try again." } }));
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await words(me).fill("2 eggs and toast");
    await estimateButton(me).click();
    await expect(box(me).locator(".fnote.err")).toHaveText("Claude is having trouble right now. Try again.");
    await expect(estimateButton(me)).toBeEnabled();
    expect(posts).toHaveLength(0);
    expect(await logged(profile.api)).toHaveLength(0);
  });

  test("a refusal from the AI (422) is shown in the box", async ({ me }) => {
    await enableAi(me);
    await stubAi(me, () => ({ status: 422, json: { error: "The AI declined to estimate this. Describe it another way, or enter it by hand." } }));
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "something it will not estimate");
    await expect(box(me).locator(".fnote.err")).toContainText("The AI declined to estimate this.");
  });

  test("a failed estimate keeps the words, so the estimate can be asked again", async ({ me }) => {
    await enableAi(me);
    let failing = true;
    const asked = await stubAi(me, () => (failing ? { status: 500, json: { error: "Claude could not make this estimate. Try again." } } : { json: ESTIMATE }));
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await ask(me, "2 eggs and toast");
    await expect(box(me).locator(".fnote.err")).toBeVisible();
    failing = false;
    await estimateButton(me).click();
    await expect(rows(me)).toHaveCount(3);
    await expect(box(me).locator(".fnote.err")).toHaveCount(0);
    expect(asked.map((a) => a.text)).toEqual(["2 eggs and toast", "2 eggs and toast"]);
  });

  test("while the estimate is under way the box says so, and Estimate cannot be asked again", async ({ me }) => {
    await enableAi(me);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const asked = await stubAi(me, async () => { await released; return { json: ESTIMATE }; });
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await words(me).fill("2 eggs and toast, salmon for dinner");
    await estimateButton(me).click();
    await expect(box(me).locator(".fnote", { hasText: "Estimating…" })).toBeVisible();
    await expect(estimateButton(me)).toBeDisabled();
    await words(me).press("Control+Enter");
    release();
    await expect(rows(me)).toHaveCount(3);
    await expect(box(me).locator(".fnote", { hasText: "Estimating…" })).toHaveCount(0);
    expect(asked).toHaveLength(1); // Control+Enter while it was under way asked nothing more
  });
});

test.describe("photos", () => {
  test("a photo is attached as a JPEG and sent with the estimate, and a photo alone can be estimated", async ({ me }) => {
    await enableAi(me);
    const asked = await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await expect(estimateButton(me)).toBeDisabled();
    await fileInput(me).setInputFiles(await jpeg(me));
    await expect(box(me).locator('img[alt="Photo 1"]')).toBeVisible();
    await expect(estimateButton(me)).toBeEnabled();
    await estimateButton(me).click();
    await expect(rows(me)).toHaveCount(3);
    expect(asked).toHaveLength(1);
    expect(asked[0].text).toBe("");
    expect(asked[0].images).toHaveLength(1);
    expect(asked[0].images[0].mediaType).toBe("image/jpeg");
    // the page sends a JPEG it made (base64 that starts with the JPEG marker), not the file it was given
    expect(asked[0].images[0].data.startsWith("/9j/")).toBe(true);
  });

  test("words and a photo are sent together", async ({ me }) => {
    await enableAi(me);
    const asked = await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await fileInput(me).setInputFiles(await jpeg(me));
    await expect(box(me).locator('img[alt="Photo 1"]')).toBeVisible(); // the photo is ready before the words are typed
    await ask(me, "half of this, and the sauce on the side");
    expect(asked[0].text).toBe("half of this, and the sauce on the side");
    expect(asked[0].images).toHaveLength(1);
  });

  // The app: when the photo is ready the whole box is drawn again, its words box included, so the focus leaves it. Words typed while
  // "Preparing photo…" is shown are then cut short: the box keeps only the start of them (three runs in three kept two to four letters).
  // Expected: every word typed is kept. Un-fixme when the words box keeps its focus and its text across the redraw.
  test.fixme("words typed while a photo is being prepared are all kept", async ({ me }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await me.locator("#fbody .faihead").click();
    const big = await me.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 4000; canvas.height = 3000;
      const ctx = canvas.getContext("2d")!;
      for (let i = 0; i < 4000; i += 4) for (let j = 0; j < 3000; j += 4) { ctx.fillStyle = `rgb(${(i * 7) % 256},${(j * 13) % 256},${(i + j) % 256})`; ctx.fillRect(i, j, 4, 4); }
      return canvas.toDataURL("image/jpeg", 0.95).split(",")[1];
    });
    await fileInput(me).setInputFiles({ name: "big.jpg", mimeType: "image/jpeg", buffer: Buffer.from(big, "base64") });
    const typed = "half of this, and the sauce on the side";
    await words(me).pressSequentially(typed, { delay: 30 });
    await expect(box(me).locator('img[alt="Photo 1"]')).toBeVisible();
    await expect(words(me)).toHaveValue(typed);
  });

  test("at most three photos: a fourth is not added, and the photo buttons say so", async ({ me }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    const photo = await jpeg(me);
    await fileInput(me).setInputFiles([photo, photo, photo, photo]);
    await expect(me.locator("#toast")).toContainText("At most 3 photos at a time.");
    await expect(box(me).locator(".faithumb img")).toHaveCount(3);
    await expect(box(me).getByRole("button", { name: "Upload" })).toBeDisabled();
    await expect(box(me).getByRole("button", { name: "📷 Take photo" })).toBeDisabled();
  });

  test("a photo can be taken off again", async ({ me }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    const photo = await jpeg(me);
    await fileInput(me).setInputFiles([photo, photo]);
    await expect(box(me).locator(".faithumb img")).toHaveCount(2);
    await box(me).getByRole("button", { name: "Remove photo 1" }).click();
    await expect(box(me).locator(".faithumb img")).toHaveCount(1);
    await expect(box(me).getByRole("button", { name: "Upload" })).toBeEnabled();
    await box(me).getByRole("button", { name: "Remove photo 1" }).click();
    await expect(box(me).locator(".faithumb img")).toHaveCount(0);
    await expect(estimateButton(me)).toBeDisabled();
  });

  test("a file that is not a photo is refused in the box", async ({ me }) => {
    await enableAi(me);
    await stubAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await fileInput(me).setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a photo") });
    await expect(box(me).locator(".fnote.err")).toHaveText("That is not a photo.");
    await expect(box(me).locator(".faithumb img")).toHaveCount(0);
  });

  test("Take photo opens the camera dialog, which says when there is no camera", async ({ me }) => {
    await me.context().grantPermissions([]);
    await enableAi(me);
    await openView(me, "food");
    await box(me).locator(".faihead").click();
    await box(me).getByRole("button", { name: "📷 Take photo" }).click();
    await expect(me.locator("#photodlg")).toBeVisible();
    await expect(me.locator("#photoNote")).toHaveText(/No camera was found on this device|The camera was refused/);
    await expect(me.locator("#photoSnap")).toBeDisabled();
    await me.locator("#photoCancel").click();
    await expect(me.locator("#photodlg")).toBeHidden();
  });
});
