import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { closeStore, emptyDayMetrics, getStore } from "../shared/store";
import { bodyRange, withScaleWeighIns } from "../shared/wellnessReport";
import { weightResponse } from "./fixtures/wellness";

const PROFILE = "SAM";
const at = (day: string) => Date.parse(`${day}T07:30:00Z`);
const weigh = (id: string, day: string, data: Record<string, unknown>) =>
  getStore().renpho.addMeasurement(PROFILE, { id, measuredAt: at(day), day, data: { timeStamp: at(day) / 1000, ...data } });

let dir: string, saved: string | undefined;
beforeEach(() => {
  saved = process.env.GARMIN_STORE_PATH;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scale-weighins-"));
  process.env.GARMIN_STORE_PATH = path.join(dir, "garmin.db");
  closeStore();
});
afterEach(() => {
  closeStore();
  fs.rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.GARMIN_STORE_PATH; else process.env.GARMIN_STORE_PATH = saved;
});

describe("the Renpho scale's weigh-ins among the stored days", () => {
  it("add the days Garmin knows nothing of, with the scale's body composition, and average a day's several weigh-ins", () => {
    weigh("1", "2026-10-01", { weight: 80, bodyfat: 20, bmi: 25, muscle: 45 });
    weigh("2", "2026-10-01", { weight: 81, bodyfat: 21, bmi: 25.4, muscle: 45 });
    weigh("3", "2026-10-03", { weight: 79.5 });
    const days = withScaleWeighIns(getStore(), PROFILE, "2026-10-01", "2026-10-05", []);
    expect(days.map((d) => d.day)).toEqual(["2026-10-01", "2026-10-03"]);
    expect(days[0]).toEqual(expect.objectContaining({ weightKg: 80.5, bodyFatPercent: 20.5, bmi: 25.2, totalKcal: null }));
    expect(days[0].muscleKg).toBeCloseTo(36.23, 1); // 45% of 80 and of 81 kg, averaged
    expect(days[1]).toEqual(expect.objectContaining({ weightKg: 79.5, bodyFatPercent: null, muscleKg: null }));
  });

  it("leave a day that has Garmin's own weight alone, and keep the other numbers of a day that has none", () => {
    getStore().wellness.put(PROFILE, "2026-10-01", "weight", weightResponse({ grams: 80_300 }));
    getStore().wellness.put(PROFILE, "2026-10-02", "summary", { totalKilocalories: 2500 });
    weigh("1", "2026-10-01", { weight: 99 });
    weigh("2", "2026-10-02", { weight: 80.1 });
    const stored = getStore().wellness.metrics(PROFILE, "2026-10-01", "2026-10-05");
    const days = withScaleWeighIns(getStore(), PROFILE, "2026-10-01", "2026-10-05", stored);
    expect(days.map((d) => [d.day, d.weightKg])).toEqual([["2026-10-01", 80.3], ["2026-10-02", 80.1]]);
    expect(days[1].totalKcal).toBe(2500);
  });

  it("stay within the days asked for, skip a weigh-in with no weight, and change nothing when there are none", () => {
    weigh("1", "2026-09-30", { weight: 90 });
    weigh("2", "2026-10-02", { bodyfat: 20 });
    weigh("3", "2026-10-06", { weight: 91 });
    const stored = [emptyDayMetrics("2026-10-04")];
    expect(withScaleWeighIns(getStore(), PROFILE, "2026-10-01", "2026-10-05", stored)).toEqual(stored);
    expect(withScaleWeighIns(getStore(), "NOBODY", "2026-10-01", "2026-10-05", stored)).toEqual(stored);
  });

  it("make the weight trend of a profile without Garmin", () => {
    for (let i = 0; i < 6; i++) weigh(`w${i}`, `2026-10-${String(1 + i * 3).padStart(2, "0")}`, { weight: 82 - i * 0.5, bodyfat: 20 });
    const { body, days } = bodyRange(getStore(), PROFILE, "2026-10-01", "2026-10-20");
    expect(days).toHaveLength(6);
    expect(body).toEqual(expect.objectContaining({ weighIns: 6, direction: "losing", latest: { day: "2026-10-16", kg: 79.5, bodyFatPercent: 20 } }));
  });
});
