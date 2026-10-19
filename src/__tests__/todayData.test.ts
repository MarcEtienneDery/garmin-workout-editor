import { SqliteStore } from "../shared/store";
import { intensityWeek } from "../shared/wellnessReport";
import { summaryResponse } from "./fixtures/wellness";

let store: SqliteStore;
beforeEach(() => {
  store = SqliteStore.open(":memory:");
});
afterEach(() => store.close());

const SUNDAY = "2026-10-18", MONDAY = "2026-10-12", WEDNESDAY = "2026-10-14";

describe("what a day's summary says for a progress page", () => {
  it("is nothing when no summary is stored for the day", () => {
    expect(store.wellness.progress("MED", SUNDAY)).toBeNull();
  });

  it("reads the goals, the distance, the Body Battery now, the watch's last sync and when we fetched it", () => {
    store.wellness.put("MED", SUNDAY, "summary", { ...summaryResponse(), dailyStepGoal: 6230, intensityMinutesGoal: 150, totalDistanceMeters: 3444, bodyBatteryMostRecentValue: 31, lastSyncTimestampGMT: "2026-10-18T18:08:03.727" }, 1234);
    expect(store.wellness.progress("MED", SUNDAY)).toEqual({ fetchedAt: 1234, stepGoal: 6230, intensityGoal: 150, distanceMeters: 3444, bodyBatteryNow: 31, watchSyncedAt: Date.parse("2026-10-18T18:08:03.727Z") });
  });

  it("leaves out what the response lacks, and a response of null (Garmin has nothing that day) has no fields at all", () => {
    store.wellness.put("MED", SUNDAY, "summary", { totalSteps: 10 }, 5);
    expect(store.wellness.progress("MED", SUNDAY)).toEqual({ fetchedAt: 5, stepGoal: null, intensityGoal: null, distanceMeters: null, bodyBatteryNow: null, watchSyncedAt: null });
    store.wellness.put("MED", MONDAY, "summary", null, 6);
    expect(store.wellness.progress("MED", MONDAY)).toEqual({ fetchedAt: 6, stepGoal: null, intensityGoal: null, distanceMeters: null, bodyBatteryNow: null, watchSyncedAt: null });
  });

  it("does not take a garbled watch time for a time", () => {
    store.wellness.put("MED", SUNDAY, "summary", { lastSyncTimestampGMT: "yesterday" });
    expect(store.wellness.progress("MED", SUNDAY)!.watchSyncedAt).toBeNull();
  });

  it("keeps one profile's day from another's", () => {
    store.wellness.put("MED", SUNDAY, "summary", summaryResponse());
    expect(store.wellness.progress("SAM", SUNDAY)).toBeNull();
  });
});

describe("the intensity minutes of the week", () => {
  const put = (day: string, moderate: number, vigorous: number) => store.wellness.put("MED", day, "summary", { ...summaryResponse(), moderateIntensityMinutes: moderate, vigorousIntensityMinutes: vigorous });

  it("adds a vigorous minute twice, from the Monday of the week", () => {
    put("2026-10-11", 99, 99); // the Sunday before: another week
    put(MONDAY, 10, 5);
    put(WEDNESDAY, 30, 0);
    put(SUNDAY, 0, 20);
    expect(intensityWeek(store, "MED", SUNDAY)).toEqual({ start: MONDAY, minutes: 10 + 10 + 30 + 40, daysStored: 3, days: 7 });
  });

  it("says how many of the days so far have a summary, so a total that is short can be told", () => {
    put(MONDAY, 10, 0);
    expect(intensityWeek(store, "MED", WEDNESDAY)).toEqual({ start: MONDAY, minutes: 10, daysStored: 1, days: 3 });
  });

  it("starts the week on the day itself when it is a Monday, and has nothing before anything is stored", () => {
    expect(intensityWeek(store, "MED", MONDAY)).toEqual({ start: MONDAY, minutes: 0, daysStored: 0, days: 1 });
  });

  it("does not count a day with no summary as a day of zero minutes", () => {
    store.wellness.put("MED", MONDAY, "sleep", {});
    store.wellness.put("MED", WEDNESDAY, "summary", null);
    expect(intensityWeek(store, "MED", WEDNESDAY).daysStored).toBe(0);
  });

  it("keeps one profile's minutes from another's", () => {
    put(MONDAY, 10, 0);
    expect(intensityWeek(store, "SAM", WEDNESDAY).minutes).toBe(0);
  });
});
