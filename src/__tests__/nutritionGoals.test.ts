import { SqliteStore } from "../shared/store";
import { NUTRIENTS } from "../shared/nutrients";
import { addFoods, nutritionDays } from "../shared/nutrition";
import { GOALS, NUTRIENT_KINDS, SETTING_FIELDS, getGoals, goalList, goalProgress, kcalGoalOf, setGoals } from "../shared/nutritionGoals";
import { summaryResponse } from "./fixtures/wellness";

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

describe("a calorie goal that follows the burn", () => {
  it("is off until it is set: the calorie goal stays the number given, whatever the day burned", () => {
    setGoals(store, "MED", { kcal: 2000 });
    expect(getGoals(store, "MED")).toEqual({ kcal: 2000 });
    expect(kcalGoalOf({ kcal: 2000 }, 650)).toBe(2000);
    log([{ name: "Rice", kcal: 500 }]);
    const [row] = goalProgress({ kcal: 2000 }, dayOf(), 650);
    expect(row).toMatchObject({ goal: 2000, left: 1500 });
    expect(row.adjust).toBeUndefined();
  });

  it("is listed in Settings right after the calories, apart from the goals", () => {
    expect(SETTING_FIELDS.map((f) => f.key).slice(0, 3)).toEqual(["kcal", "kcalBurnPct", "proteinG"]);
    expect(SETTING_FIELDS[1]).toMatchObject({ unit: "%", kind: "burn", max: 100 });
    expect(GOALS.map((g) => g.key)).not.toContain("kcalBurnPct");
  });

  it("adds the chosen share of the active calories to the goal, whole", () => {
    expect(setGoals(store, "MED", { kcal: 2200, kcalBurnPct: 50 })).toEqual({ kcal: 2200, kcalBurnPct: 50 });
    expect(kcalGoalOf(getGoals(store, "MED"), 620)).toBe(2510);
    expect(kcalGoalOf({ kcal: 2200, kcalBurnPct: 100 }, 333)).toBe(2533);
    expect(kcalGoalOf({ kcal: 2200, kcalBurnPct: 33 }, 101)).toBe(2233); // 33.33 added, rounded
    expect(kcalGoalOf({ kcal: 2200, kcalBurnPct: 50 }, 0)).toBe(2200);
    expect(kcalGoalOf({ kcalBurnPct: 50 }, 620)).toBeNull(); // no calorie goal, nothing to add to
  });

  it("measures the day against the adjusted goal, and says how it came about", () => {
    log([{ name: "Rice", kcal: 1000 }]);
    const [row] = goalProgress({ kcal: 2200, kcalBurnPct: 50 }, dayOf(), 620);
    expect(row).toMatchObject({ goal: 2510, amount: 1000, left: 1510, pct: 40, state: "short", adjust: { base: 2200, pct: 50, activeKcal: 620, added: 310 } });
  });

  it("keeps the set goal, flagged, when the day has no burn: unknown is not zero", () => {
    log([{ name: "Rice", kcal: 1000 }]);
    const [row] = goalProgress({ kcal: 2200, kcalBurnPct: 50 }, dayOf(), null);
    expect(row).toMatchObject({ goal: 2200, adjust: { base: 2200, pct: 50, activeKcal: null, added: null } });
    const [none] = goalProgress({ kcal: 2200, kcalBurnPct: 50 }, dayOf("SAM"), null); // nothing logged
    expect(none).toMatchObject({ goal: 2200, amount: null, state: "unknown", adjust: { added: null } });
    expect(goalProgress({ kcal: 2200, kcalBurnPct: 50 }, dayOf(), 0)[0]).toMatchObject({ goal: 2200, adjust: { activeKcal: 0, added: 0 } }); // a burn of 0 is known
  });

  it("leaves the other goals alone", () => {
    log([{ name: "Rice", kcal: 500, proteinG: 40 }]);
    const rows = goalProgress({ kcal: 2200, kcalBurnPct: 100, proteinG: 140 }, dayOf(), 800);
    expect(rows.map((r) => [r.key, r.goal])).toEqual([["kcal", 3000], ["proteinG", 140]]);
    expect(rows[1].adjust).toBeUndefined();
  });

  it("takes a share from 1 to 100, whole, as a patch like the goals", () => {
    setGoals(store, "MED", { kcal: 2000 });
    expect(setGoals(store, "MED", { kcalBurnPct: "50" })).toEqual({ kcal: 2000, kcalBurnPct: 50 });
    expect(setGoals(store, "MED", { kcalBurnPct: 62.6 })).toEqual({ kcal: 2000, kcalBurnPct: 63 });
    expect(setGoals(store, "MED", { kcal: 1800 })).toEqual({ kcal: 1800, kcalBurnPct: 63 }); // stays
    expect(setGoals(store, "MED", { kcalBurnPct: null })).toEqual({ kcal: 1800 }); // fixed again
    for (const bad of [0, -5, 101, "lots", Infinity]) expect(() => setGoals(store, "MED", { kcalBurnPct: bad })).toThrow(/share of the active calories/);
    expect(getGoals(store, "MED")).toEqual({ kcal: 1800 });
  });

  it("needs a calorie goal: asking for it with none is refused, and removing the goal drops it", () => {
    expect(() => setGoals(store, "MED", { kcalBurnPct: 50 })).toThrow(/Set a calorie goal/);
    expect(getGoals(store, "MED")).toEqual({});
    expect(setGoals(store, "MED", { kcal: 2000, kcalBurnPct: 50 })).toEqual({ kcal: 2000, kcalBurnPct: 50 }); // both at once
    expect(setGoals(store, "MED", { kcal: null })).toEqual({});
    expect(getGoals(store, "MED")).toEqual({});
  });

  it("reaches the day through its summary: the active calories Garmin states, null when it has none", () => {
    store.wellness.put("MED", TODAY, "summary", { ...summaryResponse(), totalKilocalories: 2600, activeKilocalories: 650 });
    expect(dayOf()).toMatchObject({ burnedKcal: 2600, activeKcal: 650 });
    expect(dayOf("SAM").activeKcal).toBeNull();
  });
});
