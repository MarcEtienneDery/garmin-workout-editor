/**
 * nutrients.ts — the nutrients the food log holds besides the calories and the three macros: the ones on a Canadian
 * Nutrition Facts table. One list drives everything (the checks, the sums, the Open Food Facts fields, the MCP tool inputs);
 * to track another nutrient, add a line here and to NUTRIENTS in web/public/nutritionModel.js (a test keeps the two equal).
 *
 * A food item holds a nutrient or it does not: a nutrient nobody gave is unknown, never zero, and the totals say how many
 * foods they come from. Vitamins are left out on purpose: labels rarely state them, so Open Food Facts has almost none.
 */

export const NUTRIENTS = [
  { key: "fiberG", label: "Fiber", unit: "g", off: "fiber" },
  { key: "sugarsG", label: "Sugars", unit: "g", off: "sugars" },
  { key: "satFatG", label: "Saturated fat", unit: "g", off: "saturated-fat" },
  { key: "transFatG", label: "Trans fat", unit: "g", off: "trans-fat" },
  { key: "cholesterolMg", label: "Cholesterol", unit: "mg", off: "cholesterol" },
  { key: "sodiumMg", label: "Sodium", unit: "mg", off: "sodium" },
  { key: "potassiumMg", label: "Potassium", unit: "mg", off: "potassium" },
  { key: "calciumMg", label: "Calcium", unit: "mg", off: "calcium" },
  { key: "ironMg", label: "Iron", unit: "mg", off: "iron" },
] as const;

export type NutrientKey = (typeof NUTRIENTS)[number]["key"];
export type NutrientDef = (typeof NUTRIENTS)[number];

/** The nutrients a food holds, by key, in the unit of the list (grams or milligrams); a key that is absent is unknown. */
export type Nutrients = Partial<Record<NutrientKey, number>>;

/** A day's, a meal's or a range's sum of one nutrient, and how many of its foods stated it (fewer than all means a total that is too low). */
export type NutrientTotals = Partial<Record<NutrientKey, { amount: number; foods: number }>>;

/** The most a food item may hold of a nutrient, in its unit. */
export const maxOf = (def: NutrientDef): number => (def.unit === "g" ? 2_000 : 100_000);

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The sum of each nutrient over foods, counting only the foods that state it. A nutrient no food states is left out. */
export function nutrientTotals(foods: { nutrients?: Nutrients }[]): NutrientTotals {
  const totals: NutrientTotals = {};
  for (const { key } of NUTRIENTS) {
    let amount = 0, count = 0;
    for (const food of foods) {
      const v = food.nutrients?.[key];
      if (v !== undefined) {
        amount += v;
        count++;
      }
    }
    if (count) totals[key] = { amount: round1(amount), foods: count };
  }
  return totals;
}
