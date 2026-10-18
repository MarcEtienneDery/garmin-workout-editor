/**
 * foodSearch.ts — looking a food up by name or barcode on Open Food Facts (a free, community-made food database; its data is
 * under the ODbL licence, which the Food view credits). The server asks, never the browser: no CORS, and Open Food Facts
 * wants an application name in the User-Agent. Nothing about the person is sent, only the barcode or the words searched.
 *
 * A food comes back as the nutrition per 100 g (or ml), plus the size of one portion when the product says it, so the page
 * can scale it to the quantity eaten. Products with no usable numbers are left out: bad data is worse than none.
 */
import type { SqliteStore } from "./store";

/** A food looked up, as the Food view shows and scales it. Liquids are per 100 ml and taken as 1 g a ml. */
export interface Food {
  code: string | null;
  name: string;
  brand: string | null;
  per100: { kcal: number; proteinG: number; carbsG: number; fatG: number };
  unit: "g" | "ml";
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
const FIELDS = "code,product_name,product_name_en,product_name_fr,generic_name,brands,serving_size,serving_quantity,quantity,nutriments";
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

/** A food from an Open Food Facts product, or null when it lacks a name or numbers that add up. */
export function toFood(raw: any): Food | null {
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
  const kept = store.foods.get(digits, BARCODE_KEEP_MS, now);
  if (kept) return kept as Food;
  const { body } = await getJson(`${PRODUCT_URL}/${digits}.json?fields=${FIELDS}`, fetcher);
  const food = body && body.status !== 0 ? toFood(body.product) : null;
  if (food) store.foods.put(digits, food, now);
  return food;
}

const searches = new Map<string, { at: number; foods: Food[] }>();

/** The foods whose name matches the words, best first; the same words asked again within ten minutes are answered from memory. */
export async function searchFoods(query: unknown, fetcher: Fetcher = fetch as unknown as Fetcher, now = Date.now()): Promise<Food[]> {
  const words = typeof query === "string" ? query.trim().replace(/\s+/g, " ") : "";
  if (words.length < 2 || words.length > 80) throw new FoodInputError("Search for 2 to 80 characters.");
  const key = words.toLowerCase();
  const kept = searches.get(key);
  if (kept && now - kept.at < SEARCH_KEEP_MS) return kept.foods;
  const { body } = await getJson(`${SEARCH_URL}?q=${encodeURIComponent(words)}&page_size=${SEARCH_LIMIT + 10}&fields=${FIELDS}`, fetcher);
  const seen = new Set<string>();
  const foods: Food[] = [];
  for (const hit of Array.isArray(body?.hits) ? body.hits : []) {
    const food = toFood(hit);
    if (!food || (food.code && seen.has(food.code))) continue;
    if (food.code) seen.add(food.code);
    foods.push(food);
    if (foods.length === SEARCH_LIMIT) break;
  }
  if (searches.size >= SEARCH_KEEP_MAX) searches.delete(searches.keys().next().value as string);
  searches.set(key, { at: now, foods });
  return foods;
}

/** Forget what searches remember (for tests). */
export const forgetSearches = (): void => searches.clear();
