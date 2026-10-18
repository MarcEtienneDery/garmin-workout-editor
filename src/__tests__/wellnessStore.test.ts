import { SqliteStore } from "../shared/store";
import { hrvResponse, noWeighIn, sleepResponse, summaryResponse, weightResponse } from "./fixtures/wellness";

let store: SqliteStore;
beforeEach(() => {
  store = SqliteStore.open(":memory:");
});
afterEach(() => store.close());

describe("the wellness table", () => {
  it("keeps a response exactly as Garmin sent it, and an empty answer as an answer", () => {
    store.wellness.put("MED", "2026-01-01", "sleep", sleepResponse(), 1000);
    store.wellness.put("MED", "2026-01-01", "spo2", undefined, 1000);
    expect(store.wellness.get("MED", "2026-01-01", "sleep")).toEqual({ data: sleepResponse(), fetchedAt: 1000 });
    expect(store.wellness.get("MED", "2026-01-01", "spo2")).toEqual({ data: null, fetchedAt: 1000 });
    expect(store.wellness.get("MED", "2026-01-02", "sleep")).toBeNull();
    expect(store.wellness.get("OTHER", "2026-01-01", "sleep")).toBeNull();
  });

  it("replaces a response that is fetched again", () => {
    store.wellness.put("MED", "2026-01-01", "sleep", sleepResponse({ seconds: 20_000 }), 1000);
    store.wellness.put("MED", "2026-01-01", "sleep", sleepResponse({ seconds: 28_000 }), 2000);
    const got = store.wellness.get("MED", "2026-01-01", "sleep")!;
    expect(got.data.dailySleepDTO.sleepTimeSeconds).toBe(28_000);
    expect(got.fetchedAt).toBe(2000);
    expect(store.wellness.counts("MED").rows).toBe(1);
  });

  it("counts what is stored and says when each response was fetched", () => {
    store.wellness.put("MED", "2026-01-01", "sleep", {}, 10);
    store.wellness.put("MED", "2026-01-01", "hrv", {}, 20);
    store.wellness.put("MED", "2026-01-03", "sleep", {}, 30);
    expect(store.wellness.counts("MED")).toEqual({ rows: 3, days: 2, oldest: "2026-01-01", newest: "2026-01-03" });
    expect(store.wellness.counts("NONE")).toEqual({ rows: 0, days: 0, oldest: null, newest: null });
    expect([...store.wellness.fetchedAt("MED", "2026-01-01", "2026-01-02")]).toEqual(expect.arrayContaining([["2026-01-01|sleep", 10], ["2026-01-01|hrv", 20]]));
    expect(store.wellness.fetchedAt("MED", "2026-01-01", "2026-01-02").size).toBe(2);
  });

  it("reads the fields of a day out of its responses, without parsing them in node", () => {
    store.wellness.put("MED", "2026-01-01", "sleep", sleepResponse({ seconds: 25_200, score: 77, needMinutes: 450, hrv: 51, rhr: 49 }));
    store.wellness.put("MED", "2026-01-01", "hrv", hrvResponse({ last: 52, weekly: 56, low: 48, high: 64, lowUpper: 44, status: "UNBALANCED" }));
    store.wellness.put("MED", "2026-01-01", "summary", summaryResponse({ rhr: 51, rhr7: 50, stress: 33, wake: 68, steps: 9000 }));
    const [m] = store.wellness.metrics("MED", "2026-01-01", "2026-01-01");
    expect(m).toEqual(expect.objectContaining({
      day: "2026-01-01", sleepSeconds: 25_200, sleepScore: 77, sleepNeedMinutes: 450, awakeCount: 2, deepSeconds: 4_500,
      hrvLastNight: 52, hrvWeeklyAvg: 56, hrvBalancedLow: 48, hrvBalancedHigh: 64, hrvLowUpper: 44, hrvStatus: "UNBALANCED",
      restingHr: 51, restingHr7d: 50, avgStress: 33, bodyBatteryWake: 68, steps: 9000, moderateMinutes: 20, vigorousMinutes: 10,
    }));
    expect(m.lowestSpo2).toBeNull();
  });

  it("reads the calories burned from the summary and the weigh-in from the weight response, in kilograms", () => {
    store.wellness.put("MED", "2026-01-01", "summary", summaryResponse());
    store.wellness.put("MED", "2026-01-01", "weight", weightResponse({ grams: 81_850, fat: 17.9, muscle: 35_500, bmi: 24.3 }));
    expect(store.wellness.metrics("MED", "2026-01-01", "2026-01-01")[0]).toEqual(
      expect.objectContaining({ totalKcal: 2600, activeKcal: 650, bmrKcal: 1950, weightKg: 81.85, bodyFatPercent: 17.9, muscleKg: 35.5, bmi: 24.3 })
    );
  });

  it("gives no weight for a day nobody weighed, and a body without a scale's extras has only the weight", () => {
    store.wellness.put("MED", "2026-01-01", "weight", noWeighIn);
    store.wellness.put("MED", "2026-01-02", "weight", { dateWeightList: [{ weight: 90_000 }], totalAverage: { weight: null } });
    const [a, b] = store.wellness.metrics("MED", "2026-01-01", "2026-01-02");
    expect(a).toEqual(expect.objectContaining({ weightKg: null, bodyFatPercent: null, muscleKg: null, bmi: null }));
    expect(b).toEqual(expect.objectContaining({ weightKg: 90, bodyFatPercent: null }));
  });

  it("forgets the stored weigh-in answers that held none, so Garmin is asked again, and keeps the ones that did", () => {
    store.wellness.put("MED", "2026-01-01", "weight", noWeighIn);
    store.wellness.put("MED", "2026-01-02", "weight", undefined); // an answer of nothing
    store.wellness.put("MED", "2026-01-03", "weight", weightResponse());
    store.wellness.put("MED", "2026-01-04", "weight", noWeighIn);
    store.wellness.put("MED", "2026-01-01", "summary", summaryResponse());
    store.wellness.put("SAM", "2026-01-01", "weight", noWeighIn);
    expect(store.wellness.forgetEmptyWeighIns("MED", "2026-01-01", "2026-01-03")).toBe(2);
    expect(store.wellness.get("MED", "2026-01-01", "weight")).toBeNull();
    expect(store.wellness.get("MED", "2026-01-02", "weight")).toBeNull();
    expect(store.wellness.get("MED", "2026-01-03", "weight")).not.toBeNull();
    expect(store.wellness.get("MED", "2026-01-04", "weight")).not.toBeNull(); // outside the days
    expect(store.wellness.get("MED", "2026-01-01", "summary")).not.toBeNull(); // another kind
    expect(store.wellness.get("SAM", "2026-01-01", "weight")).not.toBeNull(); // another profile
  });

  it("reads the breathing of a day from the respiration response, and from the summary and sleep when it is missing", () => {
    store.wellness.put("MED", "2026-01-01", "sleep", sleepResponse());
    store.wellness.put("MED", "2026-01-01", "summary", { ...summaryResponse(), avgWakingRespirationValue: 16, highestRespirationValue: 24, lowestRespirationValue: 9 });
    expect(store.wellness.metrics("MED", "2026-01-01", "2026-01-01")[0]).toEqual(
      expect.objectContaining({ avgSleepRespiration: 14, avgWakingRespiration: 16, highRespiration: 24, lowRespiration: 9 })
    );
    store.wellness.put("MED", "2026-01-01", "respiration", { avgSleepRespirationValue: 13.5, avgWakingRespirationValue: 15, highestRespirationValue: 22, lowestRespirationValue: 10 });
    expect(store.wellness.metrics("MED", "2026-01-01", "2026-01-01")[0]).toEqual(
      expect.objectContaining({ avgSleepRespiration: 13.5, avgWakingRespiration: 15, highRespiration: 22, lowRespiration: 10 })
    );
  });

  it("falls back to another kind for a field, and gives null for what no response has", () => {
    store.wellness.put("MED", "2026-01-02", "sleep", sleepResponse({ hrv: 49, rhr: 47 }));
    store.wellness.put("MED", "2026-01-02", "heart_rate", { restingHeartRate: 48, lastSevenDaysAvgRestingHeartRate: 49 });
    store.wellness.put("MED", "2026-01-02", "hrv", null);
    const [m] = store.wellness.metrics("MED", "2026-01-02", "2026-01-02");
    expect(m.hrvLastNight).toBe(49); // the night's HRV from the sleep response, as the HRV one is empty
    expect(m.restingHr).toBe(48); // the heart-rate kind before the sleep one
    expect(m.restingHr7d).toBe(49);
    expect(m.hrvBalancedLow).toBeNull();
    expect(m.bodyBatteryWake).toBeNull();
  });

  it("reads a Body Battery response (an array with one item per day)", () => {
    store.wellness.put("MED", "2026-01-03", "body_battery", [{ date: "2026-01-03", charged: 55, drained: 40, bodyBatteryValuesArray: [] }]);
    const [m] = store.wellness.metrics("MED", "2026-01-03", "2026-01-03");
    expect(m).toEqual(expect.objectContaining({ bodyBatteryCharged: 55, bodyBatteryDrained: 40 }));
  });

  it("lists the days in range, oldest first, for the profile asked for", () => {
    for (const d of ["2026-01-05", "2026-01-03", "2026-01-04", "2026-01-09"]) store.wellness.put("MED", d, "summary", summaryResponse());
    store.wellness.put("OTHER", "2026-01-04", "summary", summaryResponse());
    expect(store.wellness.metrics("MED", "2026-01-03", "2026-01-05").map((m) => m.day)).toEqual(["2026-01-03", "2026-01-04", "2026-01-05"]);
  });
});

describe("the wellness sync lease", () => {
  it("lets one holder sync at a time and takes over a lease that ran out", () => {
    const t = store.wellness;
    expect(t.claim("MED", "a", 1000, 0)).toBe(true);
    expect(t.claim("MED", "b", 1000, 500)).toBe(false);
    expect(t.renew("MED", "a", 1000, 600)).toBe(true);
    expect(t.claim("MED", "b", 1000, 1500)).toBe(false); // renewed to 1600
    expect(t.claim("MED", "b", 1000, 1700)).toBe(true); // it ran out
    expect(t.renew("MED", "a", 1000, 1800)).toBe(false);
    t.release("MED", "b", 1900);
    expect(t.state("MED").holder).toBeNull();
  });

  it("remembers why a sync stopped and when it may try again", () => {
    store.wellness.saveProgress("MED", { error: "too many requests (429)", retryAfter: 5000 });
    expect(store.wellness.state("MED")).toEqual(expect.objectContaining({ error: "too many requests (429)", retryAfter: 5000 }));
    store.wellness.saveProgress("MED", { error: null, retryAfter: null });
    expect(store.wellness.state("MED")).toEqual(expect.objectContaining({ error: null, retryAfter: null }));
  });
});
