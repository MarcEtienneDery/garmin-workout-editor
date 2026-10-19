/**
 * foodSearch.ts — looking a food up by name or barcode on Open Food Facts (a free, community-made food database; its data is
 * under the ODbL licence, which the Food view credits). The server asks, never the browser: no CORS, and Open Food Facts
 * wants an application name in the User-Agent. Nothing about the person is sent, only the barcode or the words searched.
 *
 * A food comes back as the nutrition per 100 g (or ml), plus the size of one portion when the product says it, so the page
 * can scale it to the quantity eaten. Products with no usable numbers are left out: bad data is worse than none. Beyond the
 * calories and macros it carries the nutrients of shared/nutrients.ts the product states (fiber, sodium...): the product call
 * has all of them, the search index only some, which `complete` says.
 */
import { NUTRIENTS, type Nutrients } from "./nutrients";
import type { SqliteStore } from "./store";

/** A food looked up, as the Food view shows and scales it. Liquids are per 100 ml and taken as 1 g a ml. */
export interface Food {
  code: string | null;
  name: string;
  brand: string | null;
  per100: { kcal: number; proteinG: number; carbsG: number; fatG: number };
  /** The nutrients beyond the macros the product states, per 100 g (or ml), in the unit of shared/nutrients.ts. Unknown ones are absent. */
  nutrients: Nutrients;
  /** True for a product asked for by its barcode, which carries every nutrient it has; the search index leaves some out, so a food from a search has them only in part. */
  complete: boolean;
  unit: "g" | "ml";
  /** True when Open Food Facts says the product is sold in Canada. */
  canada?: boolean;
  /** The grams (or ml) of one portion as the product states it, and how it says it. */
  servingG: number | null;
  servingText: string | null;
}

/** The question was not one that can be asked (a bad barcode, an empty search). */
export class FoodInputError extends Error {}
/** Open Food Facts could not answer; the message says why in words for the person. */
export class FoodSourceError extends Error {}

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product";
const SEARCH_URL = "https://search.openfoodfacts.org/search";
/** What is asked of Open Food Facts: the names in a few languages (a product bought in Toronto may be French only) and the nutrition. */
const FIELDS = "code,product_name,product_name_en,product_name_fr,generic_name,brands,serving_size,serving_quantity,quantity,countries_tags,nutriments";
const USER_AGENT = "garmin-workout-editor/1.0 (personal food log)";
const TIMEOUT_MS = 8000;
export const SEARCH_LIMIT = 20;
const BARCODE_KEEP_MS = 30 * 86_400_000;
const SEARCH_KEEP_MS = 10 * 60_000;
const SEARCH_KEEP_MAX = 200;

const KJ_PER_KCAL = 4.184;

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.trim().replace(",", ".")) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The text of a field that is a string or, as the search answers, a list of them. */
const firstText = (v: unknown): string => {
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" ? first.split(",")[0].trim() : "";
};

/** A gram of salt holds 0.4 g of sodium. */
const SODIUM_PER_SALT = 0.4;
/** What 100 g (or ml) of a food can hold of a nutrient: a gram of anything is at most 100 g, and salt is 40 % sodium. */
const MAX_PER_100G = { g: 100, mg: 40_000 };

/** The nutrients of an Open Food Facts `nutriments` object (every `_100g` value is in grams): the ones in range, in the list's unit. One out of range is dropped alone, not the food. */
function nutrientsOf(n: Record<string, unknown>): Nutrients {
  const found: Nutrients = {};
  // an empty string is no number here, though num() would read it as 0: a nutrient the product leaves blank is unknown
  const stated = (key: string): number | null => (typeof n[key] === "string" && !(n[key] as string).trim() ? null : num(n[key]));
  for (const def of NUTRIENTS) {
    let grams = stated(`${def.off}_100g`);
    if (grams === null && def.key === "sodiumMg") {
      const salt = stated("salt_100g");
      if (salt !== null) grams = salt * SODIUM_PER_SALT; // a label that states salt only
    }
    if (grams === null) continue;
    const value = def.unit === "mg" ? grams * 1000 : grams;
    if (value >= 0 && value <= MAX_PER_100G[def.unit]) found[def.key] = Math.round(value * 100) / 100;
  }
  return found;
}

/** A food from an Open Food Facts product, or null when it lacks a name or numbers that add up. `complete`: it came from the product call, not the search index. */
export function toFood(raw: any, complete = true): Food | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw.nutriments && typeof raw.nutriments === "object" ? raw.nutriments : {};
  const kj = num(n["energy-kj_100g"] ?? n["energy_100g"]);
  const kcal = num(n["energy-kcal_100g"]) ?? (kj === null ? null : kj / KJ_PER_KCAL);
  const [protein, carbs, fat] = [num(n["proteins_100g"]), num(n["carbohydrates_100g"]), num(n["fat_100g"])];
  if (kcal === null || (protein === null && carbs === null && fat === null)) return null;
  const macros = [protein ?? 0, carbs ?? 0, fat ?? 0];
  // a gram of food holds at most 9 kcal and its macros cannot outweigh it: anything else is a typing error in the database
  if (kcal < 0 || kcal > 950 || macros.some((m) => m < 0 || m > 100) || macros.reduce((a, b) => a + b, 0) > 101) return null;
  const name = [raw.product_name, raw.product_name_en, raw.product_name_fr, raw.generic_name].map((v) => (typeof v === "string" ? v.trim() : "")).find(Boolean);
  if (!name) return null;
  const serving = num(raw.serving_quantity);
  const servingText = typeof raw.serving_size === "string" && raw.serving_size.trim() ? raw.serving_size.trim() : null;
  const sized = `${servingText ?? ""} ${typeof raw.quantity === "string" ? raw.quantity : ""}`;
  return {
    code: typeof raw.code === "string" && /^\d{6,14}$/.test(raw.code) ? raw.code : null,
    name: name.slice(0, 100),
    brand: firstText(raw.brands).slice(0, 40) || null,
    per100: { kcal: round1(kcal), proteinG: round1(macros[0]), carbsG: round1(macros[1]), fatG: round1(macros[2]) },
    nutrients: nutrientsOf(n),
    complete,
    canada: Array.isArray(raw.countries_tags) && raw.countries_tags.includes("en:canada"),
    unit: /\d\s*(ml|cl|dl|l)\b/i.test(sized) ? "ml" : "g",
    servingG: serving !== null && serving > 0 && serving <= 2000 ? serving : null,
    servingText,
  };
}

/** One GET of JSON from Open Food Facts; every way it can go wrong becomes a FoodSourceError the person can read. */
async function getJson(url: string, fetcher: Fetcher): Promise<{ status: number; body: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetcher(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: controller.signal });
    if (res.status === 404) return { status: 404, body: null };
    if (res.status === 429) throw new FoodSourceError("Open Food Facts asks to slow down: try again in a minute.");
    if (!res.ok) throw new FoodSourceError(`Open Food Facts is unavailable right now (${res.status}).`);
    try {
      return { status: res.status, body: await res.json() };
    } catch {
      throw new FoodSourceError("Open Food Facts is unavailable right now.");
    }
  } catch (error) {
    if (error instanceof FoodSourceError) throw error;
    throw new FoodSourceError(controller.signal.aborted ? "Open Food Facts did not answer in time." : "Open Food Facts could not be reached.");
  } finally {
    clearTimeout(timer);
  }
}

/** The food of a barcode (EAN-8, UPC-A, EAN-13 and EAN-14 alike: Open Food Facts matches them), or null when it has none. */
export async function lookupBarcode(store: SqliteStore, code: unknown, fetcher: Fetcher = fetch as unknown as Fetcher, now = Date.now()): Promise<Food | null> {
  const digits = typeof code === "string" ? code.trim() : "";
  if (!/^\d{8,14}$/.test(digits)) throw new FoodInputError("A barcode is 8 to 14 digits.");
  const kept = store.foods.get(digits, BARCODE_KEEP_MS, now) as Food | null;
  if (kept && kept.nutrients) return kept;
  // A food kept before the nutrients were read has none: ask again, and if the service cannot answer the kept food is still the better answer.
  const old = kept && { ...kept, nutrients: {}, complete: true };
  try {
    const { body } = await getJson(`${PRODUCT_URL}/${digits}.json?fields=${FIELDS}`, fetcher);
    const food = body && body.status !== 0 ? toFood(body.product) : null;
    if (food) store.foods.put(digits, food, now);
    return food ?? old;
  } catch (error) {
    if (old && error instanceof FoodSourceError) return old;
    throw error;
  }
}

const searches = new Map<string, { at: number; foods: Food[] }>();

/** A search that returns fewer usable Canadian foods than this is filled up with foods from anywhere. */
const MIN_CANADIAN = 10;
/** Open Food Facts' query for the products sold in Canada, added to the words. */
const CANADA = 'countries_tags:"en:canada"';

/**
 * The words as plain words for the search index, which reads quotes, brackets, colons and AND, OR, NOT as query syntax (an unbalanced
 * bracket, or the word AND, makes it ignore the rest, the Canada filter included). Letters, digits, apostrophes, hyphens, "%", "&", "."
 * and "," stay, in lower case so that AND, OR and NOT are only words.
 */
const plainWords = (words: string): string => words.toLowerCase().replace(/[^\p{L}\p{N}\s'’&%.,-]/gu, " ").replace(/\s+/g, " ").trim();

/** The usable foods of one search of the index, best first, each product once, at most SEARCH_LIMIT. */
async function searchIndex(q: string, fetcher: Fetcher): Promise<Food[]> {
  const { body } = await getJson(`${SEARCH_URL}?q=${encodeURIComponent(q)}&page_size=${SEARCH_LIMIT + 10}&fields=${FIELDS}`, fetcher);
  const seen = new Set<string>();
  const foods: Food[] = [];
  for (const hit of Array.isArray(body?.hits) ? body.hits : []) {
    const food = toFood(hit, false);
    if (!food || (food.code && seen.has(food.code))) continue;
    if (food.code) seen.add(food.code);
    foods.push(food);
    if (foods.length === SEARCH_LIMIT) break;
  }
  return foods;
}

/**
 * The foods whose name matches the words, best first, **the products sold in Canada first**: the world's database is full of look-alikes
 * (a search for "oikos" finds none of the Canadian ones in its first 30). Only when fewer than MIN_CANADIAN usable Canadian foods
 * are found, foods from anywhere follow them up to SEARCH_LIMIT. The same words asked again within ten minutes are answered from memory.
 */
export async function searchFoods(query: unknown, fetcher: Fetcher = fetch as unknown as Fetcher, now = Date.now()): Promise<Food[]> {
  const asked = typeof query === "string" ? query.trim().replace(/\s+/g, " ") : "";
  if (asked.length < 2 || asked.length > 80) throw new FoodInputError("Search for 2 to 80 characters.");
  const words = plainWords(asked);
  if (words.length < 2) throw new FoodInputError("Search for words: letters and digits.");
  const kept = searches.get(words);
  if (kept && now - kept.at < SEARCH_KEEP_MS) return kept.foods;
  let foods = await searchIndex(`${words} ${CANADA}`, fetcher);
  if (foods.length < MIN_CANADIAN) {
    const have = new Set(foods.flatMap((f) => (f.code ? [f.code] : [])));
    foods = [...foods, ...(await searchIndex(words, fetcher)).filter((f) => !f.code || !have.has(f.code))].slice(0, SEARCH_LIMIT);
  }
  if (searches.size >= SEARCH_KEEP_MAX) searches.delete(searches.keys().next().value as string);
  searches.set(words, { at: now, foods });
  return foods;
}

/** Forget what searches remember (for tests). */
export const forgetSearches = (): void => searches.clear();
