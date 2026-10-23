import { SqliteStore } from "../shared/store";
import { NutritionError, addFoods, averageOf, changeFood, copyFoods, deleteFoods, kcalOfMacros, nutritionDays, parseDay, parseFood, parseMeal, parseProduct, recentFoods, totalsOf } from "../shared/nutrition";
import { summaryResponse } from "./fixtures/wellness";

let store: SqliteStore;
beforeEach(() => {
  store = SqliteStore.open(":memory:");
});
afterEach(() => store.close());

const TODAY = "2026-10-18";
const log = (input: Parameters<typeof addFoods>[2], profile = "MED") => addFoods(store, profile, input, TODAY, "test");

describe("checking a food", () => {
  const where = { day: TODAY, meal: "lunch" as const };

  it("works the calories out from the macros when they are left out", () => {
    expect(parseFood({ name: "Chicken", proteinG: 30, carbsG: 0, fatG: 5 }, where)).toEqual({ ...where, name: "Chicken", kcal: 165, proteinG: 30, carbsG: 0, fatG: 5, nutrients: {}, product: null });
    expect(kcalOfMacros(10, 20, 3)).toBe(147);
    expect(parseFood({ name: "Oil", fatG: 14 }, where)).toMatchObject({ kcal: 126, proteinG: 0, carbsG: 0, fatG: 14 });
  });

  it("keeps the calories given, as labels and fibre make them differ from the macros", () => {
    expect(parseFood({ name: "Bread", kcal: 240, proteinG: 8, carbsG: 45, fatG: 2 }, where).kcal).toBe(240);
  });

  it("reads numbers typed as text, with a comma, and rounds them", () => {
    expect(parseFood({ name: "Rice", kcal: "205,4", proteinG: "4.26", carbsG: " 45 " }, where)).toMatchObject({ kcal: 205, proteinG: 4.3, carbsG: 45, fatG: 0 });
  });

  it("tidies the name", () => {
    expect(parseFood({ name: "  Greek   yogurt \n", kcal: 100 }, where).name).toBe("Greek yogurt");
  });

  it.each([
    [{ kcal: 100 }, /name/],
    [{ name: "  ", kcal: 100 }, /name/],
    [{ name: "x".repeat(121), kcal: 1 }, /at most 120/],
    [{ name: "Air" }, /calories or at least one macro/],
    [{ name: "Neg", kcal: -1 }, /Calories must be a number from 0 to 10000/],
    [{ name: "Huge", kcal: 10001 }, /Calories/],
    [{ name: "Nan", kcal: "lots" }, /Calories/],
    [{ name: "Fat", kcal: 10, fatG: 2001 }, /Fat must be a number from 0 to 2000/],
    [{ name: "Inf", kcal: Infinity }, /Calories/],
  ])("refuses %j", (input, message) => {
    expect(() => parseFood(input as any, where)).toThrow(NutritionError);
    expect(() => parseFood(input as any, where)).toThrow(message);
  });

  it("checks the meal and the day", () => {
    expect(parseMeal(" Lunch ")).toBe("lunch");
    expect(() => parseMeal("brunch")).toThrow(/breakfast, lunch, dinner, snack/);
    expect(() => parseMeal(undefined)).toThrow(NutritionError);
    expect(parseDay(undefined, TODAY)).toBe(TODAY);
    expect(parseDay("", TODAY)).toBe(TODAY);
    expect(parseDay("2026-02-28", TODAY)).toBe("2026-02-28");
    for (const bad of ["2026-02-30", "2026-13-01", "18/10/2026", "today", 20261018]) expect(() => parseDay(bad, TODAY)).toThrow(/not a day/);
  });
});

describe("logging, changing and deleting foods", () => {
  it("keeps the foods of a meal with their ids, on today by default", () => {
    const added = log({ meal: "breakfast", items: [{ name: "Oats", kcal: 300, proteinG: 10, carbsG: 50, fatG: 6 }, { name: "Milk", proteinG: 8, carbsG: 12, fatG: 5 }] });
    expect(added.map((a) => [a.name, a.day, a.meal, a.kcal, a.source])).toEqual([["Oats", TODAY, "breakfast", 300, "test"], ["Milk", TODAY, "breakfast", 125, "test"]]);
    expect(added[0].id).toBeLessThan(added[1].id);
    expect(store.nutrition.get("MED", added[0].id)).toMatchObject({ name: "Oats", proteinG: 10 });
  });

  it("keeps none when one is refused", () => {
    expect(() => log({ meal: "lunch", items: [{ name: "Fine", kcal: 100 }, { name: "Bad", kcal: -5 }] })).toThrow(NutritionError);
    expect(store.nutrition.range("MED", "2000-01-01", "2100-01-01")).toEqual([]);
  });

  it("refuses an empty or oversized list and a malformed item", () => {
    expect(() => log({ meal: "lunch", items: [] })).toThrow(/at least one food/);
    expect(() => log({ meal: "lunch", items: Array.from({ length: 51 }, () => ({ name: "x", kcal: 1 })) })).toThrow(/at most 50/);
    expect(() => log({ meal: "lunch", items: [null as any] })).toThrow(/needs a name|Each food needs a name/);
  });

  it("changes what the patch names and keeps the rest", () => {
    const [food] = log({ meal: "lunch", items: [{ name: "Pasta", kcal: 400, proteinG: 14, carbsG: 80, fatG: 2 }] });
    const changed = changeFood(store, "MED", food.id, { proteinG: 20, meal: "dinner", day: "2026-10-17" });
    expect(changed).toMatchObject({ id: food.id, name: "Pasta", kcal: 400, proteinG: 20, carbsG: 80, fatG: 2, meal: "dinner", day: "2026-10-17", source: "test" });
    expect(changed.updatedAt).toBeGreaterThanOrEqual(food.createdAt);
    expect(() => changeFood(store, "MED", food.id, { kcal: -1 })).toThrow(NutritionError);
    expect(store.nutrition.get("MED", food.id)!.kcal).toBe(400);
  });

  it("does not touch another profile's food", () => {
    const [food] = log({ meal: "lunch", items: [{ name: "Mine", kcal: 100 }] });
    expect(() => changeFood(store, "SAM", food.id, { kcal: 1 })).toThrow(/no food entry/);
    expect(deleteFoods(store, "SAM", [food.id])).toEqual({ deleted: [], missing: [food.id] });
    expect(store.nutrition.get("MED", food.id)).not.toBeNull();
  });

  it("deletes entries, and reports the ids already gone", () => {
    const [a, b] = log({ meal: "snack", items: [{ name: "A", kcal: 1 }, { name: "B", kcal: 2 }] });
    expect(deleteFoods(store, "MED", [a.id, 999])).toEqual({ deleted: [a.id], missing: [999] });
    expect(store.nutrition.range("MED", TODAY, TODAY).map((e) => e.id)).toEqual([b.id]);
    expect(deleteFoods(store, "MED", [a.id])).toEqual({ deleted: [], missing: [a.id] });
  });
});

describe("copying foods to today", () => {
  const OLD = "2026-10-15";
  const old = (meal: string, items: object[]) => addFoods(store, "MED", { day: OLD, meal, items }, TODAY, "mcp");

  it("logs them again today, each in its meal, with its numbers and the nutrients it states", () => {
    const [chili, cheese] = old("dinner", [{ name: "Chili", kcal: 390, proteinG: 27, carbsG: 34, fatG: 16, nutrients: { fiberG: 9, sodiumMg: 850 } }, { name: "Cheese", kcal: 85, proteinG: 6, carbsG: 1, fatG: 6.5 }]);
    const [oats] = old("breakfast", [{ name: "Oats", kcal: 150 }]);
    const copies = copyFoods(store, "MED", [chili.id, oats.id, cheese.id], TODAY, "web");
    expect(copies.map((c) => [c.day, c.meal, c.name, c.kcal, c.proteinG, c.source])).toEqual([[TODAY, "dinner", "Chili", 390, 27, "web"], [TODAY, "breakfast", "Oats", 150, 0, "web"], [TODAY, "dinner", "Cheese", 85, 6, "web"]]);
    expect(store.nutrition.get("MED", copies[0].id)!.nutrients).toEqual({ fiberG: 9, sodiumMg: 850 });
    expect(store.nutrition.get("MED", copies[2].id)!.nutrients).toEqual({}); // stated none: still unknown, not zero
    expect(store.nutrition.range("MED", OLD, OLD)).toHaveLength(3); // the old day keeps its foods
    expect(copies.every((c) => ![chili.id, cheese.id, oats.id].includes(c.id))).toBe(true);
  });

  it("copies a food given twice once", () => {
    const [a] = old("snack", [{ name: "Apple", kcal: 80 }]);
    expect(copyFoods(store, "MED", [a.id, a.id, String(a.id)], TODAY, "web")).toHaveLength(1);
  });

  it("copies none when one is not found, or is another profile's", () => {
    const [a] = old("lunch", [{ name: "Rice", kcal: 200 }]);
    const [sams] = addFoods(store, "SAM", { day: OLD, meal: "lunch", items: [{ name: "Sam's", kcal: 1 }] }, TODAY, "test");
    expect(() => copyFoods(store, "MED", [a.id, 999], TODAY, "web")).toThrow(/no food entry 999/);
    expect(() => copyFoods(store, "MED", [a.id, sams.id], TODAY, "web")).toThrow(/no food entry/);
    expect(store.nutrition.range("MED", TODAY, TODAY)).toEqual([]);
  });

  it("refuses an empty or oversized list", () => {
    expect(() => copyFoods(store, "MED", [], TODAY, "web")).toThrow(/at least one food/);
    expect(() => copyFoods(store, "MED", "1", TODAY, "web")).toThrow(/at least one food/);
    expect(() => copyFoods(store, "MED", Array.from({ length: 51 }, (_, i) => i + 1), TODAY, "web")).toThrow(/at most 50/);
  });
});

describe("a food scaled from a product", () => {
  // 150 g of a yogurt that holds 52 kcal, 9.6 g of protein... in 100 g, as the page sends it
  const OIKOS = { code: "0056800202458", name: "OIKOS", brand: "Oikos", unit: "g", per100: { kcal: 52, proteinG: 9.6, carbsG: 3.5, fatG: 0 }, nutrients: { sugarsG: 3.5, calciumMg: 117.33 }, servingG: 115, servingText: "115 g", amount: 150, per: "g" };
  const scanned = () => log({ meal: "breakfast", items: [{ name: "OIKOS · 150 g", kcal: 78, proteinG: 14.4, carbsG: 5.3, fatG: 0, nutrients: { sugarsG: 5.3, calciumMg: 176 }, product: OIKOS }] })[0];

  it("keeps the product with it, as it was then", () => {
    const food = scanned();
    expect(store.nutrition.get("MED", food.id)!.product).toEqual(OIKOS);
    expect(log({ meal: "lunch", items: [{ name: "Soup", kcal: 200 }] })[0].product).toBeNull();
    expect(store.nutrition.range("MED", TODAY, TODAY).map((e) => e.product && e.product.code)).toEqual([OIKOS.code, null]);
  });

  it("is changed by quantity: the numbers and the product's amount together", () => {
    const food = scanned();
    const changed = changeFood(store, "MED", food.id, { name: "OIKOS · 1 × 115 g", kcal: 60, proteinG: 11, carbsG: 4, fatG: 0, nutrients: { sugarsG: 4, calciumMg: 134.9 }, product: { ...OIKOS, amount: 1, per: "portion" } });
    expect(changed).toMatchObject({ name: "OIKOS · 1 × 115 g", kcal: 60, meal: "breakfast", day: TODAY, product: { amount: 1, per: "portion", servingG: 115 } });
  });

  it("keeps its product while only its meal or day moves, and loses it when its numbers are changed without one", () => {
    const food = scanned();
    expect(changeFood(store, "MED", food.id, { meal: "snack", day: "2026-10-17" }).product).toEqual(OIKOS);
    expect(changeFood(store, "MED", food.id, { name: "OIKOS · 150 g", kcal: 78 }).product).toEqual(OIKOS); // the same numbers again
    // corrected by hand or by an assistant, it no longer is 150 g of the product: a later change of quantity would undo the correction
    expect(changeFood(store, "MED", food.id, { kcal: 90 }).product).toBeNull();
    const other = scanned();
    expect(changeFood(store, "MED", other.id, { nutrients: { ironMg: 0.1 } }).product).toBeNull();
    const third = scanned();
    expect(changeFood(store, "MED", third.id, { product: null }).product).toBeNull();
  });

  it("goes with it when it is copied or offered again", () => {
    const food = scanned();
    expect(copyFoods(store, "MED", [food.id], TODAY, "web")[0].product).toEqual(OIKOS);
    expect(recentFoods(store, "MED")[0]).toMatchObject({ name: "OIKOS · 150 g", product: OIKOS });
  });

  it("is checked: a product the page could not have made is refused", () => {
    expect(parseProduct(undefined)).toBeNull();
    expect(parseProduct({ ...OIKOS, name: "  OIKOS ", brand: "", code: null, servingG: null, servingText: undefined, per100: { kcal: "52", proteinG: 9.6, carbsG: 3.5, fatG: 0 } })).toEqual({ ...OIKOS, brand: null, code: null, servingG: null, servingText: null });
    // per 100 g, a nutrient can be more than a food may hold of it (salt holds 38 758 mg of sodium in 100 g), and keeps two decimals
    expect(parseProduct({ ...OIKOS, nutrients: { sodiumMg: 38758.4, ironMg: 0.05, satFatG: null } })!.nutrients).toEqual({ sodiumMg: 38758.4, ironMg: 0.05 });
    for (const [bad, message] of [
      ["yogurt", /not an object/],
      [{ ...OIKOS, name: " " }, /no name/],
      [{ ...OIKOS, code: "12ab" }, /barcode/],
      [{ ...OIKOS, unit: "oz" }, /unit/],
      [{ ...OIKOS, per: "cup" }, /quantity must be/],
      [{ ...OIKOS, per100: null }, /per 100 g/],
      [{ ...OIKOS, per100: { ...OIKOS.per100, kcal: 951 } }, /Calories per 100 g/],
      [{ ...OIKOS, per100: { ...OIKOS.per100, fatG: undefined } }, /no fat per 100 g/],
      [{ ...OIKOS, amount: 0 }, /quantity is 0/],
      [{ ...OIKOS, amount: 2001 }, /Quantity/],
      [{ ...OIKOS, per: "portion", servingG: null }, /no portion size/],
      [{ ...OIKOS, per: "portion", amount: 20 }, /more than 2000 g/],
      [{ ...OIKOS, nutrients: { fiberG: 101 } }, /Fiber per 100 g/],
      [{ ...OIKOS, nutrients: [1] }, /nutrients are not an object/],
    ] as [unknown, RegExp][]) expect(() => parseProduct(bad)).toThrow(message);
    expect(() => log({ meal: "lunch", items: [{ name: "Yogurt", kcal: 78, product: { ...OIKOS, amount: -1 } }] })).toThrow(NutritionError);
    expect(store.nutrition.range("MED", TODAY, TODAY)).toEqual([]);
  });
});

describe("the days", () => {
  beforeEach(() => {
    log({ day: "2026-10-16", meal: "dinner", items: [{ name: "Steak", kcal: 600, proteinG: 50, fatG: 40 }] });
    log({ day: "2026-10-17", meal: "snack", items: [{ name: "Nuts", kcal: 200, proteinG: 6, carbsG: 6, fatG: 17 }] });
    log({ day: "2026-10-17", meal: "breakfast", items: [{ name: "Oats", kcal: 300, proteinG: 10, carbsG: 50, fatG: 6 }, { name: "Egg", kcal: 80, proteinG: 6.5, fatG: 5.5 }] });
    log({ day: TODAY, meal: "lunch", items: [{ name: "Salad", kcal: 150, proteinG: 5, carbsG: 10, fatG: 9 }] });
    log({ day: "2026-10-17", meal: "lunch", items: [{ name: "Other person's", kcal: 9999 }] }, "SAM");
  });

  it("lists every day of the range, the meals in their order and the totals summed", () => {
    const days = nutritionDays(store, "MED", "2026-10-15", TODAY, TODAY);
    expect(days.map((d) => d.day)).toEqual(["2026-10-15", "2026-10-16", "2026-10-17", TODAY]);
    expect(days[0]).toMatchObject({ entries: 0, kcal: 0 });
    const d17 = days[2];
    expect(d17.meals.map((m) => m.meal)).toEqual(["breakfast", "lunch", "dinner", "snack"]);
    expect(d17.meals[0].entries.map((e) => e.name)).toEqual(["Oats", "Egg"]);
    expect(d17.meals[0].totals).toEqual({ kcal: 380, proteinG: 16.5, carbsG: 50, fatG: 11.5, entries: 2, nutrients: {} });
    expect(d17).toMatchObject({ kcal: 580, proteinG: 22.5, carbsG: 56, fatG: 28.5, entries: 3 });
  });

  it("puts the calories Garmin says the day burned next to what was eaten", () => {
    store.wellness.put("MED", "2026-10-17", "summary", { ...summaryResponse(), totalKilocalories: 2500 });
    store.wellness.put("MED", TODAY, "summary", { ...summaryResponse(), totalKilocalories: 1200 });
    const [, d16, d17, d18] = nutritionDays(store, "MED", "2026-10-15", TODAY, TODAY);
    expect(d17).toMatchObject({ burnedKcal: 2500, burnedSoFar: false, netKcal: 580 - 2500 });
    expect(d18).toMatchObject({ burnedKcal: 1200, burnedSoFar: true, netKcal: 150 - 1200 });
    expect(d16).toMatchObject({ burnedKcal: null, burnedSoFar: false, netKcal: null });
  });

  it("has no net for a day nothing was logged on", () => {
    store.wellness.put("MED", "2026-10-15", "summary", summaryResponse());
    expect(nutritionDays(store, "MED", "2026-10-15", "2026-10-15", TODAY)[0]).toMatchObject({ burnedKcal: 2600, entries: 0, netKcal: null });
  });

  it("averages the logged days that are over, not today and not the empty days", () => {
    const days = nutritionDays(store, "MED", "2026-10-14", TODAY, TODAY);
    expect(averageOf(days, TODAY)).toEqual({ days: 2, kcal: 590, proteinG: 36.3, carbsG: 28, fatG: 34.3 });
    expect(averageOf(nutritionDays(store, "MED", TODAY, TODAY, TODAY), TODAY)).toBeNull();
  });

  it("refuses a backwards or oversized range", () => {
    expect(() => nutritionDays(store, "MED", TODAY, "2026-10-17", TODAY)).toThrow(/after to/);
    expect(() => nutritionDays(store, "MED", "2026-01-01", TODAY, TODAY)).toThrow(/at most 120/);
  });

  it("sums foods", () => {
    expect(totalsOf([])).toEqual({ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, entries: 0, nutrients: {} });
  });
});

describe("the foods used lately", () => {
  it("lists the newest of each name, ignoring case, newest first, of this profile", () => {
    log({ day: "2026-10-10", meal: "lunch", items: [{ name: "Rice", kcal: 200 }] });
    log({ day: "2026-10-11", meal: "dinner", items: [{ name: "Chicken", kcal: 300 }] });
    log({ day: "2026-10-12", meal: "lunch", items: [{ name: "rice", kcal: 260 }] });
    log({ day: "2026-10-12", meal: "lunch", items: [{ name: "Theirs", kcal: 1 }] }, "SAM");
    expect(recentFoods(store, "MED").map((f) => [f.name, f.kcal, f.meal])).toEqual([["rice", 260, "lunch"], ["Chicken", 300, "dinner"]]);
  });
});
