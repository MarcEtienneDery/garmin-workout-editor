import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "../shared/store";
import { NUTRIENTS, nutrientTotals } from "../shared/nutrients";
import { NutritionError, addFoods, changeFood, nutritionDays, parseFood, parseNutrients, recentFoods, totalsOf } from "../shared/nutrition";

const TODAY = "2026-10-18";
const where = { day: TODAY, meal: "lunch" as const };

describe("a database made before the nutrients existed", () => {
  let dir: string, file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nutrients-"));
    file = path.join(dir, "garmin.db");
    // the table exactly as it was before the `extras` column, with a food in it
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE nutrition (id INTEGER PRIMARY KEY AUTOINCREMENT, profile TEXT NOT NULL, day TEXT NOT NULL, meal TEXT NOT NULL, name TEXT NOT NULL, kcal REAL NOT NULL, protein_g REAL NOT NULL, carbs_g REAL NOT NULL, fat_g REAL NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO nutrition (profile, day, meal, name, kcal, protein_g, carbs_g, fat_g, source, created_at, updated_at) VALUES ('MED', '${TODAY}', 'lunch', 'Old rice', 205, 4, 45, 0.4, 'web', 1, 1);`);
    old.close();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("keeps its foods, which hold no nutrients, and takes new ones", () => {
    const store = SqliteStore.open(file);
    try {
      const [kept] = store.nutrition.range("MED", TODAY, TODAY);
      expect(kept).toMatchObject({ name: "Old rice", kcal: 205, proteinG: 4, carbsG: 45, fatG: 0.4, nutrients: {} });
      const [added] = addFoods(store, "MED", { meal: "dinner", items: [{ name: "Oats", kcal: 150, nutrients: { fiberG: 4 } }] }, TODAY, "test");
      expect(store.nutrition.get("MED", added.id)?.nutrients).toEqual({ fiberG: 4 });
      expect(store.nutrition.get("MED", kept.id)?.nutrients).toEqual({});
    } finally {
      store.close();
    }
  });

  it("is opened again, by the other process or the next start, without trouble", () => {
    SqliteStore.open(file).close();
    const again = SqliteStore.open(file);
    try {
      const [a] = addFoods(again, "MED", { meal: "snack", items: [{ name: "Apple", kcal: 80, nutrients: { fiberG: 4.4 } }] }, TODAY, "test");
      again.close();
      const third = SqliteStore.open(file);
      expect(third.nutrition.get("MED", a.id)?.nutrients).toEqual({ fiberG: 4.4 });
      expect(third.nutrition.range("MED", TODAY, TODAY)).toHaveLength(2);
      third.close();
    } finally {
      /* the stores are closed above */
    }
  });
});

describe("checking the nutrients of a food", () => {
  it("keeps the known keys, rounded, in the unit of the list", () => {
    expect(parseNutrients({ fiberG: "3,45", sodiumMg: 410.04, ironMg: 0 })).toEqual({ fiberG: 3.5, sodiumMg: 410, ironMg: 0 });
  });

  it("takes a nutrient that is null, empty or left out for unknown, never for zero", () => {
    expect(parseNutrients({ fiberG: null, sugarsG: "", sodiumMg: undefined })).toEqual({});
    expect(parseNutrients(undefined)).toEqual({});
    expect(parseNutrients(null)).toEqual({});
    expect(parseFood({ name: "Bread", kcal: 100 }, where).nutrients).toEqual({});
  });

  it.each([
    ["fibre", { fibre: 3 }, /"fibre" is not a nutrient the log holds \(fiberG, /],
    ["a text", "fiber", /nutrients must be an object/],
    ["a list", [3], /nutrients must be an object/],
    ["a negative", { fiberG: -1 }, /Fiber must be a number from 0 to 2000/],
    ["not a number", { sodiumMg: "salty" }, /Sodium must be a number from 0 to 100000/],
    ["too much", { calciumMg: 100001 }, /Calcium/],
  ])("refuses %s", (_what, input, message) => {
    expect(() => parseNutrients(input)).toThrow(NutritionError);
    expect(() => parseNutrients(input)).toThrow(message);
  });

  it("lists the nutrients of a Canadian label, each in grams or milligrams", () => {
    expect(NUTRIENTS.map((n) => `${n.key}:${n.unit}`)).toEqual(["fiberG:g", "sugarsG:g", "satFatG:g", "transFatG:g", "cholesterolMg:mg", "sodiumMg:mg", "potassiumMg:mg", "calciumMg:mg", "ironMg:mg"]);
  });
});

describe("the nutrients of an entry", () => {
  let store: SqliteStore;
  beforeEach(() => {
    store = SqliteStore.open(":memory:");
  });
  afterEach(() => store.close());
  const log = (items: object[], meal = "lunch") => addFoods(store, "MED", { meal, items }, TODAY, "test");

  it("are kept with the entry and come back with it", () => {
    const [a] = log([{ name: "Lentils", kcal: 230, nutrients: { fiberG: 15.6, ironMg: 6.6, sodiumMg: 4 } }]);
    expect(store.nutrition.get("MED", a.id)?.nutrients).toEqual({ fiberG: 15.6, ironMg: 6.6, sodiumMg: 4 });
    expect(store.nutrition.range("MED", TODAY, TODAY)[0].nutrients).toEqual({ fiberG: 15.6, ironMg: 6.6, sodiumMg: 4 });
  });

  it("are left as they were when only something else is changed", () => {
    const [a] = log([{ name: "Lentils", kcal: 230, nutrients: { fiberG: 15.6, ironMg: 6.6 } }]);
    expect(changeFood(store, "MED", a.id, { kcal: 240, meal: "dinner" }).nutrients).toEqual({ fiberG: 15.6, ironMg: 6.6 });
    expect(changeFood(store, "MED", a.id, { nutrients: undefined }).nutrients).toEqual({ fiberG: 15.6, ironMg: 6.6 });
    expect(changeFood(store, "MED", a.id, { nutrients: {} }).nutrients).toEqual({ fiberG: 15.6, ironMg: 6.6 });
  });

  it("are set one by one when changed, and a null removes one: unknown again, not zero", () => {
    const [a] = log([{ name: "Lentils", kcal: 230, nutrients: { fiberG: 15.6, ironMg: 6.6 } }]);
    expect(changeFood(store, "MED", a.id, { nutrients: { fiberG: 12, sodiumMg: 5 } }).nutrients).toEqual({ fiberG: 12, ironMg: 6.6, sodiumMg: 5 });
    expect(changeFood(store, "MED", a.id, { nutrients: { ironMg: null } }).nutrients).toEqual({ fiberG: 12, sodiumMg: 5 });
    expect(changeFood(store, "MED", a.id, { nutrients: { ironMg: 0 } }).nutrients).toEqual({ fiberG: 12, sodiumMg: 5, ironMg: 0 }); // zero is a value
    const cleared = changeFood(store, "MED", a.id, { nutrients: { fiberG: null, sodiumMg: "", ironMg: null } });
    expect(cleared.nutrients).toEqual({});
    expect(store.nutrition.get("MED", a.id)?.nutrients).toEqual({});
  });

  it("refuse a bad patch and leave the entry as it was", () => {
    const [a] = log([{ name: "Lentils", kcal: 230, nutrients: { fiberG: 15.6 } }]);
    expect(() => changeFood(store, "MED", a.id, { nutrients: { fiberG: -2 } })).toThrow(/Fiber/);
    expect(() => changeFood(store, "MED", a.id, { nutrients: "all" })).toThrow(/object/);
    expect(() => changeFood(store, "MED", a.id, { nutrients: { zinc: 2 } })).toThrow(/not a nutrient/);
    expect(store.nutrition.get("MED", a.id)?.nutrients).toEqual({ fiberG: 15.6 });
  });

  it("are offered again with the recent food", () => {
    log([{ name: "Lentils", kcal: 230, nutrients: { fiberG: 15.6 } }, { name: "Toast", kcal: 90 }]);
    expect(recentFoods(store, "MED").map(({ name, nutrients }) => [name, nutrients])).toEqual([["Toast", {}], ["Lentils", { fiberG: 15.6 }]]);
  });
});

describe("the totals of nutrients", () => {
  it("add what is stated and count the foods that state it, so a short sum is known to be short", () => {
    const foods = [{ nutrients: { fiberG: 3, sodiumMg: 400 } }, { nutrients: { fiberG: 5.5 } }, { nutrients: {} }, {}];
    expect(nutrientTotals(foods)).toEqual({ fiberG: { amount: 8.5, foods: 2 }, sodiumMg: { amount: 400, foods: 1 } });
  });

  it("leave out a nutrient no food states, and count a stated zero", () => {
    expect(nutrientTotals([{ nutrients: {} }, {}])).toEqual({});
    expect(nutrientTotals([{ nutrients: { ironMg: 0 } }])).toEqual({ ironMg: { amount: 0, foods: 1 } });
  });

  it("go with the macros in the totals of a meal, a day and a range", () => {
    const store = SqliteStore.open(":memory:");
    try {
      addFoods(store, "MED", { meal: "lunch", items: [{ name: "Lentils", kcal: 230, nutrients: { fiberG: 15 } }, { name: "Bread", kcal: 90 }] }, TODAY, "test");
      addFoods(store, "MED", { meal: "dinner", items: [{ name: "Beans", kcal: 120, nutrients: { fiberG: 7.2, sodiumMg: 300 } }] }, TODAY, "test");
      const [day] = nutritionDays(store, "MED", TODAY, TODAY, TODAY);
      expect(day.entries).toBe(3);
      expect(day.nutrients).toEqual({ fiberG: { amount: 22.2, foods: 2 }, sodiumMg: { amount: 300, foods: 1 } });
      expect(day.meals.find((m) => m.meal === "lunch")?.totals.nutrients).toEqual({ fiberG: { amount: 15, foods: 1 } });
      expect(day.meals.find((m) => m.meal === "snack")?.totals.nutrients).toEqual({});
      expect(totalsOf(store.nutrition.range("MED", TODAY, TODAY)).nutrients.fiberG).toEqual({ amount: 22.2, foods: 2 });
    } finally {
      store.close();
    }
  });
});
