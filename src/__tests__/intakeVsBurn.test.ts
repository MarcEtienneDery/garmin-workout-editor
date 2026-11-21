import { addFoods } from "../shared/nutrition";
import { SqliteStore } from "../shared/store";
import { intakeVsBurn } from "../shared/wellnessReport";
import { summaryResponse } from "./fixtures/wellness";

let store: SqliteStore;
beforeEach(() => {
  store = SqliteStore.open(":memory:");
});
afterEach(() => store.close());

const TODAY = "2026-10-18";
const day = (back: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
const eat = (back: number, kcal: number, profile = "MED") => addFoods(store, profile, { day: day(back), meal: "lunch", items: [{ name: "Food", kcal }] }, TODAY, "test");
const burn = (back: number, total: number, profile = "MED") => store.wellness.put(profile, day(back), "summary", { ...summaryResponse(), totalKilocalories: total, activeKilocalories: 500 });

describe("what was eaten against what was burned", () => {
  it("has nothing to say for a profile that logged no food, or one without a burn stored", () => {
    expect(intakeVsBurn(store, "MED", day(29), day(0), TODAY)).toEqual({ loggedDays: 0, days: 0, eatenKcal: null, burnedKcal: null });
    eat(2, 2000);
    expect(intakeVsBurn(store, "MED", day(29), day(0), TODAY)).toEqual({ loggedDays: 1, days: 0, eatenKcal: null, burnedKcal: null });
  });

  it("averages the days that have both, whole, and counts the days with food", () => {
    eat(1, 2000); burn(1, 2600);
    eat(2, 2300); burn(2, 2700);
    eat(3, 1500);
    burn(4, 2900);
    expect(intakeVsBurn(store, "MED", day(29), day(0), TODAY)).toEqual({ loggedDays: 3, days: 2, eatenKcal: 2150, burnedKcal: 2650 });
  });

  it("leaves out today, which is not over, and the days before the range", () => {
    eat(0, 500); burn(0, 1200);
    eat(1, 2000); burn(1, 2600);
    eat(10, 3000); burn(10, 3500);
    expect(intakeVsBurn(store, "MED", day(5), day(0), TODAY)).toEqual({ loggedDays: 1, days: 1, eatenKcal: 2000, burnedKcal: 2600 });
  });

  it("reads one profile's log and no other", () => {
    eat(1, 2000, "SAM"); burn(1, 2600, "SAM");
    expect(intakeVsBurn(store, "MED", day(29), day(0), TODAY).days).toBe(0);
    expect(intakeVsBurn(store, "SAM", day(29), day(0), TODAY).days).toBe(1);
  });
});
