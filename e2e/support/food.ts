import { expect as baseExpect, type Locator, type Page } from "@playwright/test";
import { today, daysAgo } from "./dates";

const expect = baseExpect.configure({ timeout: 20_000 });

export type Meal = "breakfast" | "lunch" | "dinner" | "snack";
export const MEAL_LABEL: Record<Meal, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snacks" };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const labelOf = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};
export const dayButton = (day: string): string => `${day === today() ? "Today · " : day === daysAgo(1) ? "Yesterday · " : ""}${labelOf(day)}`;

export async function openFood(page: Page): Promise<void> {
  await page.goto("/#food", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#fbody .fsum")).toBeVisible({ timeout: 10_000 }).catch(() => page.reload({ waitUntil: "domcontentloaded" }));
  await expect(page.locator("#fbody .fsum")).toBeVisible();
}


export const pills = (page: Page): Locator => page.locator("#fbody .fpills");
export async function pickMeal(page: Page, m: Meal): Promise<void> {
  await pills(page).getByRole("button", { name: MEAL_LABEL[m], exact: true }).click();
  await expect(pills(page).getByRole("button", { name: MEAL_LABEL[m], exact: true })).toHaveAttribute("aria-pressed", "true");
}
export const part = (page: Page, name: "Log" | "Insights"): Locator => page.locator("#fTabs").getByRole("button", { name, exact: true });
export async function openInsights(page: Page): Promise<void> {
  await part(page, "Insights").click();
  await expect(part(page, "Insights")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#fbody .rcharts")).toBeVisible();
}
export async function everyDay(page: Page): Promise<Locator> {
  const box = page.locator("#fbody details.fevery");
  if (!(await box.evaluate((el: HTMLDetailsElement) => el.open))) await box.locator("summary").click();
  await expect(box).toHaveAttribute("open", "");
  return box.locator("table.rmetrics");
}


export const summary = (page: Page): Locator => page.locator("#fbody .fsum");
export const ring = (page: Page): Locator => summary(page).locator(".fring");
export const ringBig = (page: Page): Locator => ring(page).locator(".fctr b");
export const ringSmall = (page: Page): Locator => ring(page).locator(".fctr small");
export const dayLine = (page: Page): Locator => summary(page).locator(".fsumlines .fhn");
export const macro = (page: Page, key: "protein" | "carbs" | "fat"): Locator => summary(page).locator(`.fmacs .fmr.${key}`);

export async function nutrients(page: Page): Promise<Locator> {
  const box = summary(page).locator("details.fnuts");
  if (!(await box.evaluate((el: HTMLDetailsElement) => el.open))) await box.locator("summary").click();
  await expect(box).toHaveAttribute("open", "");
  return box.locator(".fnlist");
}
export const nutrientRow = (page: Page, label: string): Locator => summary(page).locator(".fnuts .fnrow").filter({ hasText: new RegExp(`^${label}`) });


export const meal = (page: Page, m: Meal): Locator => page.locator(`#fbody section.fmeal[data-meal="${m}"]`);
export const mealKcal = (page: Page, m: Meal): Locator => meal(page, m).locator(".fmh .fmk");
export const mealMacros = (page: Page, m: Meal): Locator => meal(page, m).locator(".fmh .fmt span");
export const rowOf = (page: Page, m: Meal, name: string): Locator => meal(page, m).locator(".fe").filter({ has: page.locator(".fn", { hasText: name }) });

export async function openRow(page: Page, m: Meal, name: string): Promise<Locator> {
  await closeSheet(page);
  const row = rowOf(page, m, name), head = row.locator("button.fhead");
  await expect(head).toBeVisible();
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  return row;
}

export const toast = (page: Page): Locator => page.locator("#toast");


export const sheet = (page: Page): Locator => page.locator("#fsheet");
export const sheetMeal = (page: Page, m: Meal): Locator => page.locator("#fsh .fsh-meals").getByRole("button", { name: MEAL_LABEL[m], exact: true });
export const sheetTab = (page: Page, name: "Search" | "Scan" | "AI" | "By hand"): Locator => page.locator("#fsh").getByRole("tab", { name });
export const sheetClose = (page: Page): Locator => page.locator("#fsh").getByRole("button", { name: "Close", exact: true });
const sheetOpen = (page: Page): Promise<boolean> => sheet(page).evaluate((d: HTMLDialogElement) => d.open);

export async function openSheet(page: Page, m: Meal): Promise<void> {
  if (await sheetOpen(page)) await sheetMeal(page, m).click();
  else await meal(page, m).getByRole("button", { name: `Add a food to ${MEAL_LABEL[m]}`, exact: true }).click();
  await expect(sheetMeal(page, m)).toHaveAttribute("aria-pressed", "true");
}

export async function closeSheet(page: Page): Promise<void> {
  if (await sheetOpen(page)) await sheetClose(page).click();
  await expect(sheet(page)).toBeHidden();
}

export async function chooseTab(page: Page, name: "Search" | "AI" | "By hand"): Promise<void> {
  const tab = sheetTab(page, name);
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}


export async function byHandForm(page: Page, m: Meal): Promise<Locator> {
  await openSheet(page, m);
  await chooseTab(page, "By hand");
  return page.locator("#fsh form.fform");
}

export const sheetForm = (page: Page): Locator => page.locator("#fsh form.fform");

export function fieldOf(form: Locator, key: string): Locator {
  if (key === "name") return form.locator(".fname");
  return form.locator(`input[aria-label="${key === "P" ? "P g" : key === "C" ? "C g" : key === "F" ? "F g" : key}"]`);
}

export async function fillForm(form: Locator, draft: Record<string, string>): Promise<void> {
  if (Object.keys(draft).some((key) => key.includes("("))) {
    const more = form.locator("details.fmore");
    if (!(await more.evaluate((el: HTMLDetailsElement) => el.open))) await more.locator("summary").first().click();
  }
  for (const [key, value] of Object.entries(draft)) await fieldOf(form, key).fill(value);
}

export async function enterByHand(page: Page, m: Meal, draft: Record<string, string>, { refused = false, shown }: { refused?: boolean; shown?: string } = {}): Promise<void> {
  const form = await byHandForm(page, m);
  await fillForm(form, draft);
  await form.locator('button[type="submit"]').click();
  if (refused) return;
  const name = (shown ?? draft.name ?? "").trim().replace(/\s+/g, " ");
  await expect(meal(page, m).locator(".fn", { hasText: name })).toBeVisible();
}
