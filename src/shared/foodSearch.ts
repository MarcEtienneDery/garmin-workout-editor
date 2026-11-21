import { NUTRIENTS, type Nutrients } from "./nutrients";
import type { SqliteStore } from "./store";

export interface Food {
  code: string | null;
  name: string;
  brand: string | null;
  per100: { kcal: number; proteinG: number; carbsG: number; fatG: number };
  nutrients: Nutrients;
  complete: boolean;
  unit: "g" | "ml";
  canada?: boolean;
  servingG: number | null;
  servingText: string | null;
}

export class FoodInputError extends Error {}
export class FoodSourceError extends Error {}

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product";
const SEARCH_URL = "https://search.openfoodfacts.org/search";
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

const firstText = (v: unknown): string => {
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" ? first.split(",")[0].trim() : "";
};

const SODIUM_PER_SALT = 0.4;
const MAX_PER_100G = { g: 100, mg: 40_000 };

function nutrientsOf(n: Record<string, unknown>): Nutrients {
  const found: Nutrients = {};
  const stated = (key: string): number | null => (typeof n[key] === "string" && !(n[key] as string).trim() ? null : num(n[key]));
  for (const def of NUTRIENTS) {
    let grams = stated(`${def.off}_100g`);
    if (grams === null && def.key === "sodiumMg") {
      const salt = stated("salt_100g");
      if (salt !== null) grams = salt * SODIUM_PER_SALT;
    }
    if (grams === null) continue;
    const value = def.unit === "mg" ? grams * 1000 : grams;
    if (value >= 0 && value <= MAX_PER_100G[def.unit]) found[def.key] = Math.round(value * 100) / 100;
  }
  return found;
}

export function toFood(raw: any, complete = true): Food | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw.nutriments && typeof raw.nutriments === "object" ? raw.nutriments : {};
  const kj = num(n["energy-kj_100g"] ?? n["energy_100g"]);
  const kcal = num(n["energy-kcal_100g"]) ?? (kj === null ? null : kj / KJ_PER_KCAL);
  const [protein, carbs, fat] = [num(n["proteins_100g"]), num(n["carbohydrates_100g"]), num(n["fat_100g"])];
  if (kcal === null || (protein === null && carbs === null && fat === null)) return null;
  const macros = [protein ?? 0, carbs ?? 0, fat ?? 0];
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

export async function lookupBarcode(store: SqliteStore, code: unknown, fetcher: Fetcher = fetch as unknown as Fetcher, now = Date.now()): Promise<Food | null> {
  const digits = typeof code === "string" ? code.trim() : "";
  if (!/^\d{8,14}$/.test(digits)) throw new FoodInputError("A barcode is 8 to 14 digits.");
  const kept = store.foods.get(digits, BARCODE_KEEP_MS, now) as Food | null;
  if (kept && kept.nutrients) return kept;
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

const MIN_CANADIAN = 10;
const CANADA = 'countries_tags:"en:canada"';

const plainWords = (words: string): string => words.toLowerCase().replace(/[^\p{L}\p{N}\s'’&%.,-]/gu, " ").replace(/\s+/g, " ").trim();

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

export const forgetSearches = (): void => searches.clear();
