import { SqliteStore } from "../shared/store";
import { NUTRIENTS } from "../shared/nutrients";
import { addFoods, nutritionDays } from "../shared/nutrition";
import { GOALS, NUTRIENT_KINDS, getGoals, goalList, goalProgress, setGoals } from "../shared/nutritionGoals";

let store: SqliteStore;
beforeEach(() => {
  store = SqliteStore.open(":memory:");
});
afterEach(() => store.close());

const TODAY = "2026-10-18";
const dayOf = (profile = "MED") => nutritionDays(store, profile, TODAY, TODAY, TODAY)[0];
const log = (items: Record<string, unknown>[], profile = "MED") => addFoods(store, profile, { day: TODAY, meal: "lunch", items }, TODAY, "test");

describe("the goal list", () => {
  it("has the calories, the macros and every nutrient, each with a kind", () => {
    expect(GOALS.map((g) => g.key)).toEqual(["kcal", "proteinG", "carbsG", "fatG", ...NUTRIENTS.map((n) => n.key)]);
    expect(Object.keys(NUTRIENT_KINDS).sort()).toEqual(NUTRIENTS.map((n) => n.key).sort());
    expect(GOALS.find((g) => g.key === "proteinG")?.kind).toBe("min");
    expect(GOALS.find((g) => g.key === "sodiumMg")?.kind).toBe("max");
    expect(GOALS.find((g) => g.key === "kcal")?.kind).toBe("target");
  });
});

describe("setting goals", () => {
  it("has none to start with, and keeps what is set per profile", () => {
    expect(getGoals(store, "MED")).toEqual({});
    setGoals(store, "MED", { kcal: 2200, proteinG: 140 });
    expect(getGoals(store, "MED")).toEqual({ kcal: 2200, proteinG: 140 });
    expect(getGoals(store, "SAM")).toEqual({});
  });

  it("is a patch: a number sets, null or empty removes, a key left out stays", () => {
    setGoals(store, "MED", { kcal: 2200, proteinG: 140, sodiumMg: 2300 });
    expect(setGoals(store, "MED", { kcal: 2000, proteinG: null, sodiumMg: "" })).toEqual({ kcal: 2000 });
    expect(setGoals(store, "MED", { fiberG: "30,5" })).toEqual({ kcal: 2000, fiberG: 30.5 });
    expect(getGoals(store, "MED")).toEqual({ kcal: 2000, fiberG: 30.5 });
    expect(setGoals(store, "MED", {})).toEqual({ kcal: 2000, fiberG: 30.5 });
  });

  it("rounds calories to whole numbers and grams to a decimal", () => {
    expect(setGoals(store, "MED", { kcal: 2199.6, proteinG: 140.26 })).toEqual({ kcal: 2200, proteinG: 140.3 });
  });

  it("removes the row when the last goal goes", () => {
    setGoals(store, "MED", { kcal: 2000 });
    setGoals(store, "MED", { kcal: null });
    expect(getGoals(store, "MED")).toEqual({});
  });

  it.each([
    [{ kcal: 0 }, /calories goal must be a number above 0/],
    [{ kcal: -5 }, /above 0/],
    [{ kcal: 10001 }, /at most 10000 kcal/],
    [{ proteinG: "lots" }, /protein goal/],
    [{ sodiumMg: 100001 }, /at most 100000 mg/],
    [{ fibreG: 30 }, /"fibreG" is not a goal/],
  ])("refuses %j, and keeps nothing of the patch", (patch, message) => {
    setGoals(store, "MED", { fatG: 70 });
    expect(() => setGoals(store, "MED", { proteinG: 150, ...patch })).toThrow(message);
    expect(getGoals(store, "MED")).toEqual({ fatG: 70 });
  });

  it.each([[null], [[1]], ["kcal"], [undefined]])("refuses %j as the goals", (patch) => {
    expect(() => setGoals(store, "MED", patch)).toThrow(/Goals must be an object/);
  });

  it("lists the goals set, with what each is", () => {
    const goals = setGoals(store, "MED", { proteinG: 140, sodiumMg: 2300 });
    expect(goalList(goals)).toEqual([
      { key: "proteinG", label: "Protein", unit: "g", kind: "min", goal: 140 },
      { key: "sodiumMg", label: "Sodium", unit: "mg", kind: "max", goal: 2300 },
    ]);
  });

  it("reads a damaged cell as no goals", () => {
    store.goals.set("MED", { kcal: 2000 });
    (store as any).db.prepare("UPDATE nutrition_goals SET goals = 'not json' WHERE profile = 'MED'").run();
    expect(getGoals(store, "MED")).toEqual({});
  });
});

describe("where a day stands", () => {
  const goals = { kcal: 2000, proteinG: 140, carbsG: 250, fatG: 70, fiberG: 30, sodiumMg: 2300 };

  it("says nothing is known for a day with nothing logged: not a day of zero", () => {
    const rows = goalProgress(goals, dayOf());
    expect(rows.map((r) => r.key)).toEqual(["kcal", "proteinG", "carbsG", "fatG", "fiberG", "sodiumMg"]);
    for (const r of rows) expect(r).toMatchObject({ amount: null, pct: null, left: null, state: "unknown", partial: false });
  });

  it("gives no rows when no goal is set", () => {
    log([{ name: "Rice", kcal: 200 }]);
    expect(goalProgress({}, dayOf())).toEqual([]);
  });

  it("measures the macros and calories, with what is left", () => {
    log([{ name: "Chicken", kcal: 500, proteinG: 70, carbsG: 0, fatG: 20 }, { name: "Rice", kcal: 400, proteinG: 8, carbsG: 90, fatG: 1 }]);
    const by = Object.fromEntries(goalProgress(goals, dayOf()).map((r) => [r.key, r]));
    expect(by.kcal).toMatchObject({ amount: 900, pct: 45, left: 1100, state: "short", kind: "target" });
    expect(by.proteinG).toMatchObject({ amount: 78, pct: 56, left: 62, state: "short" });
    expect(by.carbsG).toMatchObject({ amount: 90, pct: 36, state: "short" });
  });

  it("calls a floor reached at the goal, a ceiling over above it, and an aim on within 10 %", () => {
    log([{ name: "Big", kcal: 2150, proteinG: 150, carbsG: 250, fatG: 90, nutrients: { fiberG: 30, sodiumMg: 2400 } }]);
    const by = Object.fromEntries(goalProgress(goals, dayOf()).map((r) => [r.key, r]));
    expect(by.proteinG).toMatchObject({ state: "ok", left: -10 }); // a floor passed
    expect(by.kcal).toMatchObject({ state: "ok", pct: 108 }); // 8 % above an aim
    expect(by.carbsG).toMatchObject({ state: "ok", pct: 100 });
    expect(by.fatG).toMatchObject({ state: "over", pct: 129, left: -20 });
    expect(by.fiberG).toMatchObject({ state: "ok", pct: 100 }); // exactly the floor
    expect(by.sodiumMg).toMatchObject({ state: "over", left: -100 }); // a ceiling passed
  });

  it("is short of an aim below 90 % and over it above 110 %", () => {
    const state = (kcal: number) => {
      store.nutrition.remove("MED", store.nutrition.range("MED", TODAY, TODAY).map((e) => e.id));
      log([{ name: "Meal", kcal }]);
      return goalProgress({ kcal: 2000 }, dayOf())[0].state;
    };
    expect([state(1799), state(1800), state(2200), state(2201)]).toEqual(["short", "ok", "ok", "over"]);
  });

  it("leaves a nutrient no food states unknown, and marks a floor from some of the foods as partial", () => {
    log([{ name: "Oats", kcal: 150, nutrients: { fiberG: 4 } }, { name: "Egg", kcal: 80 }]);
    const by = Object.fromEntries(goalProgress(goals, dayOf()).map((r) => [r.key, r]));
    expect(by.fiberG).toMatchObject({ amount: 4, partial: true, state: "short", left: 26 });
    expect(by.sodiumMg).toMatchObject({ amount: null, state: "unknown", partial: false }); // not 0 of 2300
    expect(by.kcal).toMatchObject({ amount: 230 }); // the macros are counted for every food
  });
});
