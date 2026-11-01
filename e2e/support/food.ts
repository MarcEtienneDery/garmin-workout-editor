/**
 * The Food view's parts, for the specs that drive it: the day in the bar, the summary card, the meals and their foods, the add sheet and the
 * bar at the bottom that opens it. The sheet is a modal dialog (the whole screen on a phone, a panel on the right on a desktop): the page
 * under it takes no tap while it is open, so the helpers that tap the page (a food's row) shut it first.
 */
import { expect as baseExpect, type Locator, type Page } from "@playwright/test";
import { today, daysAgo } from "./dates";

/** The page's assertions wait this long: the server is shared by every spec of the run and answers slowly when it is busy. */
const expect = baseExpect.configure({ timeout: 20_000 });

export type Meal = "breakfast" | "lunch" | "dinner" | "snack";
/** The names the page gives the meals. */
export const MEAL_LABEL: Record<Meal, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snacks" };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The label the Food view gives a day: "Thu 29 Oct". */
export const labelOf = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};
/** What the day button in the bar says: "Today · Sun 1 Nov", "Yesterday · Sat 31 Oct", "Thu 29 Oct". */
export const dayButton = (day: string): string => `${day === today() ? "Today · " : day === daysAgo(1) ? "Yesterday · " : ""}${labelOf(day)}`;

/**
 * Opens the Food view and waits until its day is drawn: the day buttons do nothing before the first load. A load that lands on
 * another view (seen now and then on a busy server) is reloaded, as a person would.
 */
export async function openFood(page: Page): Promise<void> {
  await page.goto("/#food", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#fbody .fsum")).toBeVisible({ timeout: 10_000 }).catch(() => page.reload({ waitUntil: "domcontentloaded" }));
  await expect(page.locator("#fbody .fsum")).toBeVisible();
}

// ── The summary card ─────────────────────────────────────────────────────

/** The summary card of the day shown. */
export const summary = (page: Page): Locator => page.locator("#fbody .fsum");
/** The calorie ring: its class says the state (st-short, st-ok, st-over, st-none, st-unknown), its label says it in words. */
export const ring = (page: Page): Locator => summary(page).locator(".fring");
/** The number in the ring's middle (what is left of the goal, past it, or eaten without one) and the words under it. */
export const ringBig = (page: Page): Locator => ring(page).locator(".fctr b");
export const ringSmall = (page: Page): Locator => ring(page).locator(".fctr small");
/** The line under the ring: "1,695 kcal eaten · goal 2,200 kcal", "2 foods", "Nothing logged". */
export const dayLine = (page: Page): Locator => summary(page).locator(".fsumlines .fhn");
/** A macro's row beside the ring. */
export const macro = (page: Page, key: "protein" | "carbs" | "fat"): Locator => summary(page).locator(`.fmacs .fmr.${key}`);

/** Opens the nutrients under the summary (a tap on their line), and gives their list. */
export async function nutrients(page: Page): Promise<Locator> {
  const box = summary(page).locator("details.fnuts");
  if (!(await box.evaluate((el: HTMLDetailsElement) => el.open))) await box.locator("summary").click();
  await expect(box).toHaveAttribute("open", "");
  return box.locator(".fnlist");
}
/** A nutrient's row in the list, by its label. */
export const nutrientRow = (page: Page, label: string): Locator => summary(page).locator(".fnuts .fnrow").filter({ hasText: new RegExp(`^${label}`) });

// ── The meals ────────────────────────────────────────────────────────────

/** One meal of the day on the page: its section. */
export const meal = (page: Page, m: Meal): Locator => page.locator(`#fbody section.fmeal[data-meal="${m}"]`);
/** A meal's calories and its macros, in its head: "285 kcal", and "P 10 · C 50 · F 5" (or "Nothing logged"). */
export const mealKcal = (page: Page, m: Meal): Locator => meal(page, m).locator(".fmh .fmk");
export const mealMacros = (page: Page, m: Meal): Locator => meal(page, m).locator(".fmh .fmt span");
/** The row of a food in a meal, by its name (a row is one button and, when open, its actions). */
export const rowOf = (page: Page, m: Meal, name: string): Locator => meal(page, m).locator(".fe").filter({ has: page.locator(".fn", { hasText: name }) });

/** Opens a food's row (its nutrients and actions), once: the sheet is shut first, and a tap on an open row would close it. */
export async function openRow(page: Page, m: Meal, name: string): Promise<Locator> {
  await closeSheet(page);
  const row = rowOf(page, m, name), head = row.locator("button.fhead");
  await expect(head).toBeVisible();
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  return row;
}

/** The toast: its message, and an Undo button when the action has one. It moves into the sheet while the sheet is open. */
export const toast = (page: Page): Locator => page.locator("#toast");

// ── The add sheet ────────────────────────────────────────────────────────

export const sheet = (page: Page): Locator => page.locator("#fsheet");
/** The meal buttons at the top of the sheet (absent while a food is changed). */
export const sheetMeal = (page: Page, m: Meal): Locator => page.locator("#fsh .fsh-meals").getByRole("button", { name: MEAL_LABEL[m], exact: true });
/** A way of adding, at the top of the sheet. */
export const sheetTab = (page: Page, name: "Search" | "Scan" | "AI" | "By hand"): Locator => page.locator("#fsh").getByRole("tab", { name });
/** The sheet's ✕. */
export const sheetClose = (page: Page): Locator => page.locator("#fsh").getByRole("button", { name: "Close", exact: true });
const sheetOpen = (page: Page): Promise<boolean> => sheet(page).evaluate((d: HTMLDialogElement) => d.open);

/** Opens the sheet on a meal from that meal's + (on the search), or chooses the meal at its top when it is open already. */
export async function openSheet(page: Page, m: Meal): Promise<void> {
  if (await sheetOpen(page)) await sheetMeal(page, m).click();
  else await meal(page, m).getByRole("button", { name: `Add a food to ${MEAL_LABEL[m]}`, exact: true }).click();
  await expect(sheetMeal(page, m)).toHaveAttribute("aria-pressed", "true");
}

/** Shuts the sheet with its ✕, when it is open. */
export async function closeSheet(page: Page): Promise<void> {
  if (await sheetOpen(page)) await sheetClose(page).click();
  await expect(sheet(page)).toBeHidden();
}

/** Turns the open sheet to a way of adding. */
export async function chooseTab(page: Page, name: "Search" | "AI" | "By hand"): Promise<void> {
  const tab = sheetTab(page, name);
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

// ── The form by hand ─────────────────────────────────────────────────────

/** The sheet's form by hand, on a meal: the sheet opens on it, or turns to it. */
export async function byHandForm(page: Page, m: Meal): Promise<Locator> {
  await openSheet(page, m);
  await chooseTab(page, "By hand");
  return page.locator("#fsh form.fform");
}

/** The form of the sheet as it is (to add a food, or the one a Change opened). */
export const sheetForm = (page: Page): Locator => page.locator("#fsh form.fform");

/** The field of the form for a key: "name", "kcal", "P", "C", "F", or a nutrient's own label such as "Fiber (g)". */
export function fieldOf(form: Locator, key: string): Locator {
  if (key === "name") return form.locator(".fname");
  return form.locator(`input[aria-label="${key === "P" ? "P g" : key === "C" ? "C g" : key === "F" ? "F g" : key}"]`);
}

/** Fills the form's fields given by key; an empty string leaves the field empty. Opens "More nutrients" when a nutrient is filled. */
export async function fillForm(form: Locator, draft: Record<string, string>): Promise<void> {
  if (Object.keys(draft).some((key) => key.includes("("))) {
    const more = form.locator("details.fmore");
    if (!(await more.evaluate((el: HTMLDetailsElement) => el.open))) await more.locator("summary").first().click();
  }
  for (const [key, value] of Object.entries(draft)) await fieldOf(form, key).fill(value);
}

/**
 * Enters a food by hand in a meal with the given fields and presses Add; the sheet stays open for the next one. A food that is saved is
 * waited for in its meal before the function returns (the page drops a second add while one is being saved); `refused` for a food the
 * page is meant to refuse.
 */
export async function enterByHand(page: Page, m: Meal, draft: Record<string, string>, { refused = false, shown }: { refused?: boolean; shown?: string } = {}): Promise<void> {
  const form = await byHandForm(page, m);
  await fillForm(form, draft);
  await form.locator('button[type="submit"]').click();
  if (refused) return;
  const name = (shown ?? draft.name ?? "").trim().replace(/\s+/g, " ");
  await expect(meal(page, m).locator(".fn", { hasText: name })).toBeVisible();
}
