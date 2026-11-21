
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

export type Nutrients = Partial<Record<NutrientKey, number>>;

export type NutrientTotals = Partial<Record<NutrientKey, { amount: number; foods: number }>>;

export const maxOf = (def: NutrientDef): number => (def.unit === "g" ? 2_000 : 100_000);

const round1 = (n: number): number => Math.round(n * 10) / 10;

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
