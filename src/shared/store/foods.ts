import type { Database } from "./sqliteStore";

/**
 * Products looked up by barcode on Open Food Facts, kept as the food the app made of them (see shared/foodSearch.ts), so a
 * product scanned before is found at once, does not ask the service again and is still there when it is down. Not
 * per profile: a product is the same for everyone. Only a product that was found is kept, never a miss.
 */
export const FOOD_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS food_cache (
  code       TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
`;

export class FoodCacheTable {
  constructor(private readonly db: Database) {}

  /** The kept food of a barcode when it was fetched less than `maxAgeMs` ago. */
  get(code: string, maxAgeMs: number, now = Date.now()): unknown | null {
    const r = this.db.prepare("SELECT data, fetched_at FROM food_cache WHERE code = ?").get(code);
    if (!r || now - r.fetched_at > maxAgeMs) return null;
    try {
      return JSON.parse(r.data);
    } catch {
      return null;
    }
  }

  put(code: string, food: unknown, now = Date.now()): void {
    this.db.prepare("INSERT INTO food_cache (code, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT (code) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at").run(code, JSON.stringify(food), now);
  }
}
