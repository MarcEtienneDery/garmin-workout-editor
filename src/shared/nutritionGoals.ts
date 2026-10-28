/**
 * nutritionGoals.ts — the daily goals of a profile for the food log: calories, the three macros and the nutrients of shared/nutrients.ts,
 * how a change to them is checked, and how a day's totals stand against them. The Settings view, the Food and Today views and the MCP tools
 * all read and write through these functions, so they cannot disagree.
 *
 * A goal is one number a day. What reaching it means depends on the nutrient, not on the person: protein, fiber and the minerals are a
 * floor (`min`), sodium, sugars and the fats a ceiling (`max`), calories and the other two macros an aim (`target`, within 10 %). To track
 * another nutrient, add a line to NUTRIENTS (shared/nutrients.ts) and its kind to NUTRIENT_KINDS (the compiler asks for it).
 *
 * Unknown is never zero: a day with nothing logged, or a nutrient no food of the day states, has no amount and no state, not an empty bar.
 */
import { NUTRIENTS, type NutrientKey, maxOf } from "./nutrients";
import { MAX_GRAMS, MAX_KCAL, NutritionError, type Totals } from "./nutrition";
import type { GoalValues, SqliteStore } from "./store";

export type GoalKind = "min" | "max" | "target";

/** Whether each nutrient's goal is a floor or a ceiling. */
export const NUTRIENT_KINDS: Record<NutrientKey, GoalKind> = {
  fiberG: "min",
  sugarsG: "max",
  satFatG: "max",
  transFatG: "max",
  cholesterolMg: "max",
  sodiumMg: "max",
  potassiumMg: "min",
  calciumMg: "min",
  ironMg: "min",
};

export interface GoalField {
  key: string;
  label: string;
  unit: "kcal" | "g" | "mg";
  kind: GoalKind;
  /** The most a goal may be, in the unit. */
  max: number;
}

/** What a goal can be set for, in the order the Settings view lists them: calories, the macros, then the nutrients. */
export const GOALS: readonly GoalField[] = [
  { key: "kcal", label: "Calories", unit: "kcal", kind: "target", max: MAX_KCAL },
  { key: "proteinG", label: "Protein", unit: "g", kind: "min", max: MAX_GRAMS },
  { key: "carbsG", label: "Carbs", unit: "g", kind: "target", max: MAX_GRAMS },
  { key: "fatG", label: "Fat", unit: "g", kind: "target", max: MAX_GRAMS },
  ...NUTRIENTS.map((n): GoalField => ({ key: n.key, label: n.label, unit: n.unit, kind: NUTRIENT_KINDS[n.key], max: maxOf(n) })),
];

/** A day within this share of a target (above or below) is on it. */
export const TARGET_TOLERANCE = 0.1;

/** The goals of a profile by key; `{}` when it has set none. */
export const getGoals = (store: SqliteStore, profile: string): GoalValues => store.goals.get(profile);

/** The goals the profile holds, with what each is (label, unit, kind), in the list's order: what a tool or a page shows of them. */
export const goalList = (goals: GoalValues) => GOALS.filter((g) => goals[g.key] !== undefined).map(({ max: _max, ...g }) => ({ ...g, goal: goals[g.key] }));

/**
 * Change a profile's goals. A key given a number sets that goal, one given as null (or empty text) removes it, one left out stays: the
 * same rule as the nutrients of a food. All of the patch is checked before any is kept. Returns the goals as they are now.
 */
export function setGoals(store: SqliteStore, profile: string, patch: unknown, now = Date.now()): GoalValues {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new NutritionError(`Goals must be an object like { ${GOALS[0].key}: 2200, ${GOALS[1].key}: 140 }.`);
  const given = patch as Record<string, unknown>, fields = new Map(GOALS.map((g) => [g.key, g]));
  const unknown = Object.keys(given).find((key) => !fields.has(key));
  if (unknown) throw new NutritionError(`"${unknown}" is not a goal (${GOALS.map((g) => g.key).join(", ")}).`);
  const goals = { ...store.goals.get(profile) };
  for (const [key, value] of Object.entries(given)) {
    const field = fields.get(key) as GoalField;
    if (value === undefined) continue;
    if (value === null || (typeof value === "string" && !value.trim())) {
      delete goals[key];
      continue;
    }
    const n = typeof value === "string" ? Number(value.trim().replace(",", ".")) : value;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > field.max) throw new NutritionError(`The ${field.label.toLowerCase()} goal must be a number above 0 and at most ${field.max} ${field.unit} (leave it empty for no goal).`);
    goals[key] = field.key === "kcal" ? Math.round(n) : Math.round(n * 10) / 10;
  }
  store.goals.set(profile, goals, now);
  return goals;
}

/** Where a day stands against a goal: `short` (not there yet, or below the aim), `ok` (reached the floor, under the ceiling, on the aim), `over`, `unknown` (nothing to say). */
export type GoalState = "short" | "ok" | "over" | "unknown";

export interface GoalProgress {
  key: string;
  label: string;
  unit: GoalField["unit"];
  kind: GoalKind;
  goal: number;
  /** What the day holds of it; null when nothing is logged or no food of the day states it (unknown, not zero). */
  amount: number | null;
  /** A nutrient that fewer foods than the day has state: the amount is a floor, not the intake. */
  partial: boolean;
  /** The amount as a percentage of the goal, whole; null when the amount is unknown. */
  pct: number | null;
  state: GoalState;
  /** The goal minus the amount: what is left to eat (or to stay under), negative when over. Null when the amount is unknown. */
  left: number | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** How the totals of a day (or a meal, or the day so far) stand against each goal that is set, in the list's order. */
export function goalProgress(goals: GoalValues, totals: Totals): GoalProgress[] {
  return GOALS.filter((g) => goals[g.key] !== undefined).map((g) => {
    const goal = goals[g.key];
    const macro = g.key === "kcal" || g.key === "proteinG" || g.key === "carbsG" || g.key === "fatG";
    const stated = macro ? undefined : totals.nutrients[g.key as NutrientKey];
    const amount = !totals.entries ? null : macro ? (totals as unknown as Record<string, number>)[g.key] : stated ? stated.amount : null;
    const partial = !macro && !!stated && stated.foods < totals.entries;
    if (amount === null) return { key: g.key, label: g.label, unit: g.unit, kind: g.kind, goal, amount, partial: false, pct: null, state: "unknown" as const, left: null };
    const ratio = amount / goal;
    const state: GoalState = g.kind === "min" ? (ratio >= 1 ? "ok" : "short") : g.kind === "max" ? (ratio > 1 ? "over" : "ok") : ratio < 1 - TARGET_TOLERANCE ? "short" : ratio > 1 + TARGET_TOLERANCE ? "over" : "ok";
    return { key: g.key, label: g.label, unit: g.unit, kind: g.kind, goal, amount, partial, pct: Math.round(ratio * 100), state, left: round1(goal - amount) };
  });
}
