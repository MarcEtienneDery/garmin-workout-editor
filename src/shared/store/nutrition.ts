import { NUTRIENTS, type Nutrients } from "../nutrients";
import type { Database } from "./sqliteStore";

/**
 * The food a profile ate, one row per food item: the day, the meal it belongs to, its name, its calories and its
 * protein, carbohydrate and fat in grams. Garmin has no place to write food to, so this is the only copy; the web editor
 * and the MCP server both write it (`source` says which).
 *
 * The nutrients beyond the macros (fiber, sodium...: see shared/nutrients.ts) are one JSON object in `extras`, holding only the ones
 * the food states; NULL is none. A food scaled from a product (a barcode scan or a search on Open Food Facts) keeps that product in
 * `product`, as JSON: its numbers per 100 g as they were then and how much was eaten, so it can be changed by quantity later; NULL
 * for a food typed in or estimated. A database made before a column existed gets it when it is opened (migrateNutrition).
 *
 * A meal is a name for the rows that share a day and a meal slot: one row per meal is a total typed in, several rows are a
 * meal broken into foods. Nothing is derived here: totals are summed on read (see shared/nutrition.ts).
 */
export const NUTRITION_SCHEMA = `
CREATE TABLE IF NOT EXISTS nutrition (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile    TEXT NOT NULL,
  day        TEXT NOT NULL,
  meal       TEXT NOT NULL,
  name       TEXT NOT NULL,
  kcal       REAL NOT NULL,
  protein_g  REAL NOT NULL,
  carbs_g    REAL NOT NULL,
  fat_g      REAL NOT NULL,
  extras     TEXT,
  product    TEXT,
  source     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nutrition_by_day ON nutrition (profile, day);
`;

/**
 * Give a table made before the nutrients the `extras` column, and one made before products the `product` column. The store runs it
 * inside the transaction that creates the schema, and a transaction is exclusive, so the MCP server and the web editor opening the
 * same file together cannot both add a column.
 */
export function migrateNutrition(db: Database): void {
  const columns = new Set(db.prepare("PRAGMA table_info(nutrition)").all().map((column) => column.name));
  for (const name of ["extras", "product"]) if (!columns.has(name)) db.exec(`ALTER TABLE nutrition ADD COLUMN ${name} TEXT`);
}

/** The slots of a day, in the order they are listed. */
export const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
export type Meal = (typeof MEALS)[number];

/**
 * The product a food was scaled from, as it was when it was logged (Open Food Facts may change it since): its nutrition per 100 g (or
 * ml), the size of a portion when it states one, and how much was eaten, in grams (or ml) or portions.
 */
export interface FoodProduct {
  code: string | null;
  name: string;
  brand: string | null;
  unit: "g" | "ml";
  per100: { kcal: number; proteinG: number; carbsG: number; fatG: number };
  /** The nutrients it states per 100 g (or ml). */
  nutrients: Nutrients;
  servingG: number | null;
  servingText: string | null;
  amount: number;
  per: "g" | "portion";
}

/** What is stored of a food item, without its id and times. */
export interface FoodFields {
  day: string;
  meal: Meal;
  name: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** The nutrients beyond the macros the food states; none when left out. */
  nutrients?: Nutrients;
  /** The product it was scaled from; none for a food typed in or estimated. */
  product?: FoodProduct | null;
}

export interface FoodEntry extends FoodFields {
  nutrients: Nutrients;
  product: FoodProduct | null;
  id: number;
  source: string;
  createdAt: number;
  updatedAt: number;
}

/** The nutrients of an `extras` cell: the known keys with a number, whatever else the text holds is ignored. */
function readExtras(text: unknown): Nutrients {
  let raw: unknown;
  try {
    raw = typeof text === "string" ? JSON.parse(text) : null;
  } catch {
    return {};
  }
  const found: Nutrients = {};
  if (raw && typeof raw === "object") for (const { key } of NUTRIENTS) if (typeof (raw as Record<string, unknown>)[key] === "number" && Number.isFinite((raw as Record<string, number>)[key])) found[key] = (raw as Record<string, number>)[key];
  return found;
}

const writeExtras = (nutrients: Nutrients | undefined): string | null => (nutrients && Object.keys(nutrients).length ? JSON.stringify(nutrients) : null);
const writeProduct = (product: FoodProduct | null | undefined): string | null => (product ? JSON.stringify(product) : null);

/** The product of a `product` cell; null when there is none or it is not one (it was checked when written: see parseProduct). */
function readProduct(text: unknown): FoodProduct | null {
  try {
    const raw = typeof text === "string" ? JSON.parse(text) : null;
    return raw && typeof raw === "object" && raw.per100 && typeof raw.per100 === "object" && typeof raw.amount === "number" ? (raw as FoodProduct) : null;
  } catch {
    return null;
  }
}

const toEntry = (r: any): FoodEntry => ({
  id: r.id,
  day: r.day,
  meal: r.meal,
  name: r.name,
  kcal: r.kcal,
  proteinG: r.protein_g,
  carbsG: r.carbs_g,
  fatG: r.fat_g,
  nutrients: readExtras(r.extras),
  product: readProduct(r.product),
  source: r.source,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class NutritionTable {
  constructor(
    private readonly db: Database,
    private readonly tx: <T>(fn: () => T) => T
  ) {}

  /** Keep food items, all or none; returns them with their ids, in the order given. */
  add(profile: string, items: FoodFields[], source: string, now = Date.now()): FoodEntry[] {
    return this.tx(() => {
      const insert = this.db.prepare("INSERT INTO nutrition (profile, day, meal, name, kcal, protein_g, carbs_g, fat_g, extras, product, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      return items.map((f) => {
        const r = insert.run(profile, f.day, f.meal, f.name, f.kcal, f.proteinG, f.carbsG, f.fatG, writeExtras(f.nutrients), writeProduct(f.product), source, now, now) as { lastInsertRowid: number | bigint };
        return { ...f, nutrients: f.nutrients ?? {}, product: f.product ?? null, id: Number(r.lastInsertRowid), source, createdAt: now, updatedAt: now };
      });
    });
  }

  get(profile: string, id: number): FoodEntry | null {
    const r = this.db.prepare("SELECT * FROM nutrition WHERE profile = ? AND id = ?").get(profile, id);
    return r ? toEntry(r) : null;
  }

  /** Replace an item's fields; null when this profile has no such item. */
  update(profile: string, id: number, f: FoodFields, now = Date.now()): FoodEntry | null {
    return this.tx(() => {
      const r = this.db
        .prepare("UPDATE nutrition SET day = ?, meal = ?, name = ?, kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ?, extras = ?, product = ?, updated_at = ? WHERE profile = ? AND id = ?")
        .run(f.day, f.meal, f.name, f.kcal, f.proteinG, f.carbsG, f.fatG, writeExtras(f.nutrients), writeProduct(f.product), now, profile, id) as { changes: number | bigint };
      return Number(r.changes) ? this.get(profile, id) : null;
    });
  }

  /** Delete the items with these ids that belong to this profile; returns the ids that were deleted. */
  remove(profile: string, ids: number[]): number[] {
    return this.tx(() => {
      const found = ids.filter((id) => this.get(profile, id));
      for (const id of found) this.db.prepare("DELETE FROM nutrition WHERE profile = ? AND id = ?").run(profile, id);
      return found;
    });
  }

  /** The items of the days from `from` to `to` inclusive: by day, then meal slot, then the order they were entered. */
  range(profile: string, from: string, to: string): FoodEntry[] {
    const slot = `CASE meal ${MEALS.map((m, i) => `WHEN '${m}' THEN ${i}`).join(" ")} ELSE ${MEALS.length} END`;
    return this.db.prepare(`SELECT * FROM nutrition WHERE profile = ? AND day BETWEEN ? AND ? ORDER BY day, ${slot}, id`).all(profile, from, to).map(toEntry);
  }

  /** The newest item of each food name (ignoring case), newest first: what the entry form offers to fill in again. */
  recentFoods(profile: string, limit: number): FoodEntry[] {
    return this.db
      .prepare("SELECT * FROM nutrition WHERE id IN (SELECT MAX(id) FROM nutrition WHERE profile = ? GROUP BY lower(name)) ORDER BY id DESC LIMIT ?")
      .all(profile, limit)
      .map(toEntry);
  }
}
