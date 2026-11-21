import { NUTRIENTS, type NutrientKey, maxOf } from "./nutrients";
import { MAX_GRAMS, MAX_KCAL, NutritionError, type Totals } from "./nutrition";
import type { GoalValues, SqliteStore } from "./store";

export type GoalKind = "min" | "max" | "target";

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
  max: number;
}

export const GOALS: readonly GoalField[] = [
  { key: "kcal", label: "Calories", unit: "kcal", kind: "target", max: MAX_KCAL },
  { key: "proteinG", label: "Protein", unit: "g", kind: "min", max: MAX_GRAMS },
  { key: "carbsG", label: "Carbs", unit: "g", kind: "target", max: MAX_GRAMS },
  { key: "fatG", label: "Fat", unit: "g", kind: "target", max: MAX_GRAMS },
  ...NUTRIENTS.map((n): GoalField => ({ key: n.key, label: n.label, unit: n.unit, kind: NUTRIENT_KINDS[n.key], max: maxOf(n) })),
];

export const BURN_KEY = "kcalBurnPct";

export const WEIGHT_KEY = "weightKg";
export const MIN_WEIGHT_GOAL_KG = 20, MAX_WEIGHT_GOAL_KG = 400;

export interface SettingField extends Omit<GoalField, "unit" | "kind"> {
  unit: GoalField["unit"] | "%" | "kg";
  kind: GoalKind | "burn" | "weight";
}

export const SETTING_FIELDS: readonly SettingField[] = [
  GOALS[0],
  { key: BURN_KEY, label: "Share of active calories", unit: "%", kind: "burn", max: 100 },
  ...GOALS.slice(1),
  { key: WEIGHT_KEY, label: "Weight goal", unit: "kg", kind: "weight", max: MAX_WEIGHT_GOAL_KG },
];

export const TARGET_TOLERANCE = 0.1;

export const getGoals = (store: SqliteStore, profile: string): GoalValues => store.goals.get(profile);

export const goalList = (goals: GoalValues) => GOALS.filter((g) => goals[g.key] !== undefined).map(({ max: _max, ...g }) => ({ ...g, goal: goals[g.key] }));

export function setGoals(store: SqliteStore, profile: string, patch: unknown, now = Date.now()): GoalValues {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new NutritionError(`Goals must be an object like { ${GOALS[0].key}: 2200, ${GOALS[1].key}: 140 }.`);
  const given = patch as Record<string, unknown>, fields = new Map(SETTING_FIELDS.map((g) => [g.key, g]));
  const unknown = Object.keys(given).find((key) => !fields.has(key));
  if (unknown) throw new NutritionError(`"${unknown}" is not a goal (${SETTING_FIELDS.map((g) => g.key).join(", ")}).`);
  const goals = { ...store.goals.get(profile) };
  for (const [key, value] of Object.entries(given)) {
    const field = fields.get(key) as SettingField;
    if (value === undefined) continue;
    if (value === null || (typeof value === "string" && !value.trim())) {
      delete goals[key];
      continue;
    }
    const n = typeof value === "string" ? Number(value.trim().replace(",", ".")) : value;
    if (field.kind === "weight") {
      if (typeof n !== "number" || !Number.isFinite(n) || n < MIN_WEIGHT_GOAL_KG || n > MAX_WEIGHT_GOAL_KG) throw new NutritionError(`The weight goal must be a number of kilograms from ${MIN_WEIGHT_GOAL_KG} to ${MAX_WEIGHT_GOAL_KG} (leave it empty for no goal).`);
      goals[key] = Math.round(n * 100) / 100;
      continue;
    }
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > field.max) throw new NutritionError(field.kind === "burn" ? `The share of the active calories added to the calorie goal must be a number from 1 to ${field.max} % (leave it empty for a fixed calorie goal).` : `The ${field.label.toLowerCase()} goal must be a number above 0 and at most ${field.max} ${field.unit} (leave it empty for no goal).`);
    goals[key] = field.key === "kcal" || field.kind === "burn" ? Math.round(n) : Math.round(n * 10) / 10;
  }
  if (goals[BURN_KEY] !== undefined && goals.kcal === undefined) {
    if (typeof given[BURN_KEY] === "number" || (typeof given[BURN_KEY] === "string" && String(given[BURN_KEY]).trim())) throw new NutritionError("Set a calorie goal to add the burned calories to.");
    delete goals[BURN_KEY];
  }
  store.goals.set(profile, goals, now);
  return goals;
}

export type GoalState = "short" | "ok" | "over" | "unknown";

export interface GoalProgress {
  key: string;
  label: string;
  unit: GoalField["unit"];
  kind: GoalKind;
  goal: number;
  amount: number | null;
  partial: boolean;
  pct: number | null;
  state: GoalState;
  left: number | null;
  adjust?: { base: number; pct: number; activeKcal: number | null; added: number | null };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function kcalGoalOf(goals: GoalValues, activeKcal: number | null): number | null {
  const base = goals.kcal;
  if (base === undefined) return null;
  const pct = goals[BURN_KEY];
  return pct === undefined || activeKcal === null || !Number.isFinite(activeKcal) ? base : base + Math.round((Math.max(0, activeKcal) * pct) / 100);
}

export function goalProgress(goals: GoalValues, totals: Totals, activeKcal: number | null = null): GoalProgress[] {
  return GOALS.filter((g) => goals[g.key] !== undefined).map((g) => {
    const base = goals[g.key], pct = g.key === "kcal" ? goals[BURN_KEY] : undefined;
    const known = activeKcal !== null && Number.isFinite(activeKcal);
    const goal = g.key === "kcal" ? (kcalGoalOf(goals, activeKcal) as number) : base;
    const adjust = pct === undefined ? {} : { adjust: { base, pct, activeKcal: known ? activeKcal : null, added: known ? goal - base : null } };
    const macro = g.key === "kcal" || g.key === "proteinG" || g.key === "carbsG" || g.key === "fatG";
    const stated = macro ? undefined : totals.nutrients[g.key as NutrientKey];
    const amount = !totals.entries ? null : macro ? (totals as unknown as Record<string, number>)[g.key] : stated ? stated.amount : null;
    const partial = !macro && !!stated && stated.foods < totals.entries;
    if (amount === null) return { key: g.key, label: g.label, unit: g.unit, kind: g.kind, goal, amount, partial: false, pct: null, state: "unknown" as const, left: null, ...adjust };
    const ratio = amount / goal;
    const state: GoalState = g.kind === "min" ? (ratio >= 1 ? "ok" : "short") : g.kind === "max" ? (ratio > 1 ? "over" : "ok") : ratio < 1 - TARGET_TOLERANCE ? "short" : ratio > 1 + TARGET_TOLERANCE ? "over" : "ok";
    return { key: g.key, label: g.label, unit: g.unit, kind: g.kind, goal, amount, partial, pct: Math.round(ratio * 100), state, left: round1(goal - amount), ...adjust };
  });
}
