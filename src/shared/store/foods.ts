import type { Database } from "./sqliteStore";

export const FOOD_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS food_cache (
  code       TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
`;

export class FoodCacheTable {
  constructor(private readonly db: Database) {}

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
