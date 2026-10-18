/**
 * nutrition.ts — the food log: what a food item may hold, the totals of a meal and a day, and the days of a range next to
 * the calories Garmin says they burned. The MCP tools and the web view both write and answer from these functions, so they
 * cannot disagree. Garmin has nowhere to store food, so the log lives in the `nutrition` table (store/nutrition.ts).
 */
import { type FoodEntry, type FoodFields, MEALS, type Meal, type SqliteStore } from "./store";
import { addDays } from "./wellnessSync";

export { MEALS, type Meal };

/** A food the person gave is refused with a message they can act on. */
export class NutritionError extends Error {}

export const MAX_KCAL = 10_000;
export const MAX_GRAMS = 2_000;
export const MAX_NAME = 120;
export const MAX_ITEMS = 50;
export const MAX_RANGE_DAYS = 120;
/** How many foods the entry form offers to fill in again. */
export const RECENT_FOODS = 40;

/** What the log holds energy-wise for a gram of each macro (Atwater factors; labels, fibre and alcohol make the real value differ). */
export const kcalOfMacros = (proteinG: number, carbsG: number, fatG: number): number => Math.round(4 * proteinG + 4 * carbsG + 9 * fatG);

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** A day as YYYY-MM-DD, or `fallback` when none was given. */
export function parseDay(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  const text = typeof value === "string" ? value : "";
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text) throw new NutritionError(`"${String(value)}" is not a day (use YYYY-MM-DD).`);
  return text;
}

export function parseMeal(value: unknown): Meal {
  const meal = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!(MEALS as readonly string[]).includes(meal)) throw new NutritionError(`The meal must be one of ${MEALS.join(", ")}.`);
  return meal as Meal;
}

/** A number from 0 to `max` (a numeric string is read too), undefined when none was given. */
function amount(value: unknown, label: string, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "string" ? Number(value.trim().replace(",", ".")) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > max) throw new NutritionError(`${label} must be a number from 0 to ${max}.`);
  return round1(n);
}

/** A food as the person or the assistant gives it: calories are worked out from the macros when left out. */
export interface FoodInput {
  name?: unknown;
  kcal?: unknown;
  proteinG?: unknown;
  carbsG?: unknown;
  fatG?: unknown;
}

export function parseFood(input: FoodInput, where: { day: string; meal: Meal }): FoodFields {
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new NutritionError("Each food needs a name.");
  if (name.length > MAX_NAME) throw new NutritionError(`A food name is at most ${MAX_NAME} characters.`);
  const proteinG = amount(input.proteinG, "Protein", MAX_GRAMS), carbsG = amount(input.carbsG, "Carbs", MAX_GRAMS), fatG = amount(input.fatG, "Fat", MAX_GRAMS);
  let kcal = amount(input.kcal, "Calories", MAX_KCAL);
  if (kcal === undefined) {
    if (proteinG === undefined && carbsG === undefined && fatG === undefined) throw new NutritionError(`"${name}" needs calories or at least one macro.`);
    kcal = kcalOfMacros(proteinG ?? 0, carbsG ?? 0, fatG ?? 0);
  }
  return { ...where, name, kcal: Math.round(kcal), proteinG: proteinG ?? 0, carbsG: carbsG ?? 0, fatG: fatG ?? 0 };
}

export interface AddFoods {
  day?: unknown;
  meal: unknown;
  items: FoodInput[];
}

/** Log foods for a meal of a day (`today` by default). All are checked before any is kept. */
export function addFoods(store: SqliteStore, profile: string, input: AddFoods, today: string, source: string): FoodEntry[] {
  if (!Array.isArray(input.items) || !input.items.length) throw new NutritionError("Give at least one food.");
  if (input.items.length > MAX_ITEMS) throw new NutritionError(`Give at most ${MAX_ITEMS} foods at a time.`);
  const where = { day: parseDay(input.day, today), meal: parseMeal(input.meal) };
  return store.nutrition.add(profile, input.items.map((item) => parseFood(item ?? {}, where)), source);
}

export interface FoodPatch extends FoodInput {
  day?: unknown;
  meal?: unknown;
}

/** Change a food item: what the patch leaves out stays (the calories are not worked out again from changed macros). */
export function changeFood(store: SqliteStore, profile: string, id: number, patch: FoodPatch): FoodEntry {
  const current = store.nutrition.get(profile, id);
  if (!current) throw new NutritionError(`There is no food entry ${id}.`);
  const keep = (key: "name" | "kcal" | "proteinG" | "carbsG" | "fatG") => (patch[key] === undefined ? current[key] : patch[key]);
  const food = parseFood(
    { name: keep("name"), kcal: keep("kcal"), proteinG: keep("proteinG"), carbsG: keep("carbsG"), fatG: keep("fatG") },
    { day: parseDay(patch.day, current.day), meal: patch.meal === undefined ? current.meal : parseMeal(patch.meal) }
  );
  const changed = store.nutrition.update(profile, id, food);
  if (!changed) throw new NutritionError(`There is no food entry ${id}.`);
  return changed;
}

/** Delete food entries; the ids that did not exist are reported, not an error (a retry finds them gone). */
export function deleteFoods(store: SqliteStore, profile: string, ids: number[]): { deleted: number[]; missing: number[] } {
  const deleted = store.nutrition.remove(profile, ids);
  return { deleted, missing: ids.filter((id) => !deleted.includes(id)) };
}

// ── Totals and days ─────────────────────────────────────────────────────

export interface Totals {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** How many food items. */
  entries: number;
}

export function totalsOf(entries: FoodFields[]): Totals {
  const sum = (pick: (f: FoodFields) => number) => round1(entries.reduce((t, f) => t + pick(f), 0));
  return { kcal: Math.round(sum((f) => f.kcal)), proteinG: sum((f) => f.proteinG), carbsG: sum((f) => f.carbsG), fatG: sum((f) => f.fatG), entries: entries.length };
}

export interface MealBlock {
  meal: Meal;
  entries: FoodEntry[];
  totals: Totals;
}

/** A day of the log: its totals, the calories Garmin says it burned, and the meals. */
export interface NutritionDay extends Totals {
  day: string;
  /** What the day burned, from the watch; null when no day summary is stored. Today's is what has burned so far. */
  burnedKcal: number | null;
  burnedSoFar: boolean;
  /** Eaten minus burned; null on a day nothing was logged or Garmin has no burn for. */
  netKcal: number | null;
  meals: MealBlock[];
}

/** The days from `from` to `to` inclusive, oldest first, a day nothing was logged on included. */
export function nutritionDays(store: SqliteStore, profile: string, from: string, to: string, today: string): NutritionDay[] {
  if (from > to) throw new NutritionError("from is after to.");
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > MAX_RANGE_DAYS * 86_400_000) throw new NutritionError(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
  const entries = store.nutrition.range(profile, from, to);
  const burned = new Map(store.wellness.metrics(profile, from, to).map((m) => [m.day, m.totalKcal]));
  const days: NutritionDay[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const ofDay = entries.filter((e) => e.day === day);
    const meals = MEALS.map((meal) => {
      const mine = ofDay.filter((e) => e.meal === meal);
      return { meal, entries: mine, totals: totalsOf(mine) };
    });
    const totals = totalsOf(ofDay), burnedKcal = burned.get(day) ?? null;
    days.push({ day, ...totals, burnedKcal, burnedSoFar: day === today && burnedKcal !== null, netKcal: burnedKcal !== null && totals.entries ? totals.kcal - burnedKcal : null, meals });
  }
  return days;
}

export interface Average {
  days: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

/** The mean of the days that were logged and are over (today is still being filled in); null when there is none. */
export function averageOf(days: NutritionDay[], today: string): Average | null {
  const logged = days.filter((d) => d.entries && d.day < today);
  if (!logged.length) return null;
  const mean = (pick: (d: NutritionDay) => number) => round1(logged.reduce((t, d) => t + pick(d), 0) / logged.length);
  return { days: logged.length, kcal: Math.round(mean((d) => d.kcal)), proteinG: mean((d) => d.proteinG), carbsG: mean((d) => d.carbsG), fatG: mean((d) => d.fatG) };
}

/** The foods the entry form offers to fill in again, the newest of each name first. */
export function recentFoods(store: SqliteStore, profile: string): { name: string; meal: Meal; kcal: number; proteinG: number; carbsG: number; fatG: number }[] {
  return store.nutrition.recentFoods(profile, RECENT_FOODS).map(({ name, meal, kcal, proteinG, carbsG, fatG }) => ({ name, meal, kcal, proteinG, carbsG, fatG }));
}
