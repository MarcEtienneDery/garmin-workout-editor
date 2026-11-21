import { NUTRIENTS, type Nutrients } from "../nutrients";
import type { Database } from "./sqliteStore";

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
CREATE TABLE IF NOT EXISTS nutrition_goals (
  profile    TEXT PRIMARY KEY,
  goals      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
`;

export function migrateNutrition(db: Database): void {
  const columns = new Set(db.prepare("PRAGMA table_info(nutrition)").all().map((column) => column.name));
  for (const name of ["extras", "product"]) if (!columns.has(name)) db.exec(`ALTER TABLE nutrition ADD COLUMN ${name} TEXT`);
}

export type GoalValues = Record<string, number>;

export const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
export type Meal = (typeof MEALS)[number];

export interface FoodProduct {
  code: string | null;
  name: string;
  brand: string | null;
  unit: "g" | "ml";
  per100: { kcal: number; proteinG: number; carbsG: number; fatG: number };
  nutrients: Nutrients;
  servingG: number | null;
  servingText: string | null;
  amount: number;
  per: "g" | "portion";
}

export interface FoodFields {
  day: string;
  meal: Meal;
  name: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  nutrients?: Nutrients;
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

  update(profile: string, id: number, f: FoodFields, now = Date.now()): FoodEntry | null {
    return this.tx(() => {
      const r = this.db
        .prepare("UPDATE nutrition SET day = ?, meal = ?, name = ?, kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ?, extras = ?, product = ?, updated_at = ? WHERE profile = ? AND id = ?")
        .run(f.day, f.meal, f.name, f.kcal, f.proteinG, f.carbsG, f.fatG, writeExtras(f.nutrients), writeProduct(f.product), now, profile, id) as { changes: number | bigint };
      return Number(r.changes) ? this.get(profile, id) : null;
    });
  }

  remove(profile: string, ids: number[]): number[] {
    return this.tx(() => {
      const found = ids.filter((id) => this.get(profile, id));
      for (const id of found) this.db.prepare("DELETE FROM nutrition WHERE profile = ? AND id = ?").run(profile, id);
      return found;
    });
  }

  range(profile: string, from: string, to: string): FoodEntry[] {
    const slot = `CASE meal ${MEALS.map((m, i) => `WHEN '${m}' THEN ${i}`).join(" ")} ELSE ${MEALS.length} END`;
    return this.db.prepare(`SELECT * FROM nutrition WHERE profile = ? AND day BETWEEN ? AND ? ORDER BY day, ${slot}, id`).all(profile, from, to).map(toEntry);
  }

  recentFoods(profile: string, limit: number): FoodEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM nutrition WHERE id IN (SELECT MAX(id) FROM nutrition WHERE profile = ? GROUP BY lower(name)) ORDER BY id DESC")
      .all(profile)
      .map(toEntry);
    const seen = new Set<string>();
    const found: FoodEntry[] = [];
    for (const row of rows) {
      const key = row.name.replace(/ · (?:\d+(?:\.\d+)? × )?\d+(?:\.\d+)? (?:g|ml)$/, "").trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(row);
      if (found.length >= limit) break;
    }
    return found;
  }
}

export class GoalTable {
  constructor(private readonly db: Database) {}

  get(profile: string): GoalValues {
    const r = this.db.prepare("SELECT goals FROM nutrition_goals WHERE profile = ?").get(profile);
    try {
      const raw = r && typeof r.goals === "string" ? JSON.parse(r.goals) : null;
      const found: GoalValues = {};
      if (raw && typeof raw === "object") for (const [key, value] of Object.entries(raw)) if (typeof value === "number" && Number.isFinite(value)) found[key] = value;
      return found;
    } catch {
      return {};
    }
  }

  set(profile: string, goals: GoalValues, now = Date.now()): void {
    if (!Object.keys(goals).length) this.db.prepare("DELETE FROM nutrition_goals WHERE profile = ?").run(profile);
    else this.db.prepare("INSERT INTO nutrition_goals (profile, goals, updated_at) VALUES (?, ?, ?) ON CONFLICT (profile) DO UPDATE SET goals = excluded.goals, updated_at = excluded.updated_at").run(profile, JSON.stringify(goals), now);
  }
}
