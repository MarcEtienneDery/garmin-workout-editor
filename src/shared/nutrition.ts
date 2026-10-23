/**
 * nutrition.ts — the food log: what a food item may hold, the totals of a meal and a day, and the days of a range next to
 * the calories Garmin says they burned. The MCP tools and the web view both write and answer from these functions, so they
 * cannot disagree. Garmin has nowhere to store food, so the log lives in the `nutrition` table (store/nutrition.ts).
 */
import { NUTRIENTS, type NutrientTotals, type Nutrients, maxOf, nutrientTotals } from "./nutrients";
import { type FoodEntry, type FoodFields, type FoodProduct, MEALS, type Meal, type SqliteStore } from "./store";
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

/** A number from 0 to `max` (a numeric string is read too), undefined when none was given; rounded to `decimals`. */
function amount(value: unknown, label: string, max: number, decimals = 1): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "string" ? Number(value.trim().replace(",", ".")) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > max) throw new NutritionError(`${label} must be a number from 0 to ${max}.`);
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}

/** A food as the person or the assistant gives it: calories are worked out from the macros when left out. */
export interface FoodInput {
  name?: unknown;
  kcal?: unknown;
  proteinG?: unknown;
  carbsG?: unknown;
  fatG?: unknown;
  /** The nutrients beyond the macros, by key (see shared/nutrients.ts): `{ fiberG: 3, sodiumMg: 410 }`. A key left out, null or empty is unknown, never zero. */
  nutrients?: unknown;
  /** The product the numbers were scaled from (see FoodProduct), so the food can be changed by quantity later; the page sends it, the MCP tools do not. */
  product?: unknown;
}

/** The nutrients of a food as given: known keys with a number from 0; null, empty or left out means unknown. Anything else is refused. */
export function parseNutrients(input: unknown): Nutrients {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new NutritionError(`nutrients must be an object like { ${NUTRIENTS[0].key}: 3 }.`);
  const given = input as Record<string, unknown>, known = new Set<string>(NUTRIENTS.map((n) => n.key));
  const unknown = Object.keys(given).find((key) => !known.has(key));
  if (unknown) throw new NutritionError(`"${unknown}" is not a nutrient the log holds (${NUTRIENTS.map((n) => n.key).join(", ")}).`);
  const found: Nutrients = {};
  for (const def of NUTRIENTS) {
    const v = amount(given[def.key], def.label, maxOf(def));
    if (v !== undefined) found[def.key] = v;
  }
  return found;
}

/** What 100 g (or ml) can hold: at most 950 kcal and 100 g of a macro, as foodSearch's toFood checks; of a nutrient, 100 g or 40 g of sodium (pure salt). */
const PER_100_MAX = { kcal: 950, g: 100, mg: 40_000 };

/** The product a food was scaled from, checked; null when none was given. A product the page could not have made is refused. */
export function parseProduct(input: unknown): FoodProduct | null {
  if (input === undefined || input === null) return null;
  const bad = (what: string): never => {
    throw new NutritionError(`The food's product ${what}.`);
  };
  if (typeof input !== "object" || Array.isArray(input)) bad("is not an object");
  const p = input as Record<string, any>;
  const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const name = text(p.name, MAX_NAME) ?? bad("has no name");
  const code = p.code === undefined || p.code === null ? null : typeof p.code === "string" && /^\d{6,14}$/.test(p.code) ? p.code : bad("has a barcode that is not 6 to 14 digits");
  if (p.unit !== "g" && p.unit !== "ml") bad('unit must be "g" or "ml"');
  if (p.per !== "g" && p.per !== "portion") bad('quantity must be in "g" or "portion"');
  const per100 = p.per100 && typeof p.per100 === "object" ? p.per100 : bad("has no numbers per 100 g");
  const req = (v: unknown, label: string, max: number): number => amount(v, label, max, 2) ?? bad(`has no ${label.toLowerCase()}`);
  const servingG = p.servingG === undefined || p.servingG === null ? null : req(p.servingG, "Portion size", MAX_GRAMS) || bad("portion size is 0");
  const quantity = req(p.amount, "Quantity", MAX_GRAMS);
  if (!(quantity > 0)) bad("quantity is 0");
  if (p.per === "portion" && !servingG) bad("is eaten in portions but has no portion size");
  if (quantity * (p.per === "portion" ? (servingG as number) : 1) > MAX_GRAMS) bad(`quantity is more than ${MAX_GRAMS} g`);
  if (p.nutrients !== undefined && p.nutrients !== null && (typeof p.nutrients !== "object" || Array.isArray(p.nutrients))) bad("nutrients are not an object");
  const nutrients: Nutrients = {};
  for (const def of NUTRIENTS) {
    const v = amount((p.nutrients ?? {})[def.key], `${def.label} per 100 g`, PER_100_MAX[def.unit], 2);
    if (v !== undefined) nutrients[def.key] = v;
  }
  return {
    code,
    name,
    brand: text(p.brand, 60),
    unit: p.unit,
    per100: { kcal: req(per100.kcal, "Calories per 100 g", PER_100_MAX.kcal), proteinG: req(per100.proteinG, "Protein per 100 g", PER_100_MAX.g), carbsG: req(per100.carbsG, "Carbs per 100 g", PER_100_MAX.g), fatG: req(per100.fatG, "Fat per 100 g", PER_100_MAX.g) },
    nutrients,
    servingG,
    servingText: text(p.servingText, 60),
    amount: quantity,
    per: p.per,
  };
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
  return { ...where, name, kcal: Math.round(kcal), proteinG: proteinG ?? 0, carbsG: carbsG ?? 0, fatG: fatG ?? 0, nutrients: parseNutrients(input.nutrients), product: parseProduct(input.product) };
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

/**
 * Log again on `day` (today, from the server) foods already logged, each in the meal it was in, with its numbers and the nutrients
 * it states (one it does not state stays unknown). All are found before any is kept; an id given twice is copied once.
 */
export function copyFoods(store: SqliteStore, profile: string, ids: unknown, day: string, source: string): FoodEntry[] {
  if (!Array.isArray(ids) || !ids.length) throw new NutritionError("Give at least one food to copy.");
  const unique = [...new Set(ids.map(Number))];
  if (unique.length > MAX_ITEMS) throw new NutritionError(`Copy at most ${MAX_ITEMS} foods at a time.`);
  const items = unique.map((id) => {
    const found = store.nutrition.get(profile, id);
    if (!found) throw new NutritionError(`There is no food entry ${id}.`);
    const { meal, name, kcal, proteinG, carbsG, fatG, nutrients, product } = found;
    return { day, meal, name, kcal, proteinG, carbsG, fatG, nutrients, product };
  });
  return store.nutrition.add(profile, items, source);
}

export interface FoodPatch extends FoodInput {
  day?: unknown;
  meal?: unknown;
}

/**
 * Change a food item: what the patch leaves out stays (the calories are not worked out again from changed macros). A nutrient of the
 * patch is set, one given as null is removed (unknown again), one the patch does not mention stays. The product it was scaled from is
 * replaced by the patch's (null removes it), and stays only while the name and numbers stay: a food corrected by hand or by an
 * assistant no longer is that quantity of that product, and changing its quantity later would undo the correction.
 */
export function changeFood(store: SqliteStore, profile: string, id: number, patch: FoodPatch): FoodEntry {
  const current = store.nutrition.get(profile, id);
  if (!current) throw new NutritionError(`There is no food entry ${id}.`);
  const keep = (key: "name" | "kcal" | "proteinG" | "carbsG" | "fatG") => (patch[key] === undefined ? current[key] : patch[key]);
  parseNutrients(patch.nutrients); // refuses a patch that is not an object, names no nutrient or holds a bad number
  const nutrients: Record<string, unknown> = { ...current.nutrients };
  for (const [key, value] of Object.entries((patch.nutrients ?? {}) as Record<string, unknown>)) if (value !== undefined) nutrients[key] = value;
  const food = parseFood(
    { name: keep("name"), kcal: keep("kcal"), proteinG: keep("proteinG"), carbsG: keep("carbsG"), fatG: keep("fatG"), nutrients, product: patch.product },
    { day: parseDay(patch.day, current.day), meal: patch.meal === undefined ? current.meal : parseMeal(patch.meal) }
  );
  if (patch.product === undefined) {
    const same = (["name", "kcal", "proteinG", "carbsG", "fatG"] as const).every((key) => food[key] === current[key]) && JSON.stringify(food.nutrients) === JSON.stringify(current.nutrients);
    food.product = same ? current.product : null;
  }
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
  /** The nutrients beyond the macros that at least one food states, each with how many foods state it: one stated by fewer than `entries` is a lower bound. */
  nutrients: NutrientTotals;
}

export function totalsOf(entries: FoodFields[]): Totals {
  const sum = (pick: (f: FoodFields) => number) => round1(entries.reduce((t, f) => t + pick(f), 0));
  return { kcal: Math.round(sum((f) => f.kcal)), proteinG: sum((f) => f.proteinG), carbsG: sum((f) => f.carbsG), fatG: sum((f) => f.fatG), entries: entries.length, nutrients: nutrientTotals(entries) };
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
export function recentFoods(store: SqliteStore, profile: string): { name: string; meal: Meal; kcal: number; proteinG: number; carbsG: number; fatG: number; nutrients: Nutrients; product: FoodProduct | null }[] {
  return store.nutrition.recentFoods(profile, RECENT_FOODS).map(({ name, meal, kcal, proteinG, carbsG, fatG, nutrients, product }) => ({ name, meal, kcal, proteinG, carbsG, fatG, nutrients, product }));
}
