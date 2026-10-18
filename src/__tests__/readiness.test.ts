import { BACK_OFF_AT, GO_HARDER_AT, MIN_BASELINE_DAYS, baselines, computeReadiness, loadSummary } from "../shared/readiness";
import type { DayMetrics, LoadRow } from "../shared/store";
import { metricsFor } from "./fixtures/wellness";

const DATE = "2026-10-18";
const day = (back: number) => new Date(Date.parse(`${DATE}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);

/** A normal day: HRV in its band, resting heart rate 50, a full night, a charged battery, a calm day before. */
const normal = (d: string, over: Partial<DayMetrics> = {}): DayMetrics =>
  metricsFor(d, {
    hrvLastNight: 57, hrvWeeklyAvg: 55, hrvLowUpper: 46, hrvBalancedLow: 50, hrvBalancedHigh: 65, hrvStatus: "BALANCED",
    restingHr: 50, restingHr7d: 50, sleepSeconds: 27_000, sleepScore: 82, sleepNeedMinutes: 480, awakeCount: 2,
    bodyBatteryWake: 75, avgStress: 28, ...over,
  });

/** Four weeks of normal days, then the day asked about. */
const month = (today: Partial<DayMetrics> = {}, yesterday: Partial<DayMetrics> = {}): DayMetrics[] => [
  ...Array.from({ length: 28 }, (_, i) => normal(day(28 - i), i === 27 ? yesterday : {})),
  normal(DATE, today),
];

const session = (daysBefore: number, hour: number, over: Partial<LoadRow> = {}): LoadRow => ({
  id: `${daysBefore}-${hour}`, type: "running", name: "Run", seconds: 3600, avgHr: 150, maxHr: 180, rpe: 50,
  startLocal: `${day(daysBefore)} ${String(hour).padStart(2, "0")}:00:00`, ...over,
});
/** A steady month of training: an hour at RPE 5 every other day. */
const usualTraining = (): LoadRow[] => Array.from({ length: 15 }, (_, i) => session(2 + i * 2, 8));

describe("readiness", () => {
  it("is as-planned on a normal day, and says why for each signal", () => {
    const r = computeReadiness(month(), usualTraining(), DATE);
    expect(r.band).toBe("as-planned");
    expect(r.confidence).toBe("high");
    expect(r.score).toBeGreaterThanOrEqual(50);
    expect(r.signals.map((s) => s.name).sort()).toEqual(["bodyBattery", "hrv", "load", "restingHr", "sleep", "stress"]);
    expect(r.signals.every((s) => s.reason.length > 0)).toBe(true);
    expect(r.suggestion).toMatch(/as planned/);
  });

  it("says go harder when everything is better than usual", () => {
    const today = { hrvLastNight: 66, restingHr: 47, sleepSeconds: 30_000, sleepScore: 92, bodyBatteryWake: 92 };
    const r = computeReadiness(month(today, { avgStress: 20 }), usualTraining().slice(1), DATE); // the last session was 4 days ago
    expect(r.band).toBe("go-harder");
    expect(r.score!).toBeGreaterThan(50);
    expect(r.signals.find((s) => s.name === "hrv")).toEqual(expect.objectContaining({ score: 1, reason: expect.stringContaining("above") }));
    expect(r.suggestion).toMatch(/push/);
  });

  it("does not say go harder when one core signal is below normal", () => {
    const today = { hrvLastNight: 66, restingHr: 52, sleepSeconds: 30_000, sleepScore: 92, bodyBatteryWake: 95 }; // 2 bpm up is still fine, so lift it further
    const r = computeReadiness(month({ ...today, restingHr: 54 }, { avgStress: 20 }), [], DATE);
    expect(r.signals.find((s) => s.name === "restingHr")!.score).toBe(-1);
    expect(r.band).not.toBe("go-harder");
  });

  it("says back off when HRV is well below the baseline band, whatever else says", () => {
    const r = computeReadiness(month({ hrvLastNight: 38, sleepScore: 90, bodyBatteryWake: 90 }), [], DATE);
    expect(r.signals.find((s) => s.name === "hrv")).toEqual(expect.objectContaining({ score: -2, reason: expect.stringContaining("well below") }));
    expect(r.band).toBe("back-off");
    expect(r.suggestion).toMatch(/lighter|easy/);
  });

  it("says back off after a short night, a raised resting heart rate and a drained battery", () => {
    const r = computeReadiness(month({ sleepSeconds: 18_000, sleepScore: 52, restingHr: 56, bodyBatteryWake: 28, hrvLastNight: 49 }), [], DATE);
    expect(r.signals.find((s) => s.name === "sleep")!.score).toBeLessThan(0);
    expect(r.signals.find((s) => s.name === "restingHr")!.score).toBe(-2);
    expect(r.band).toBe("back-off");
    expect(r.score!).toBeLessThan(50);
  });

  it("compares the resting heart rate with the person's own median, not a fixed number", () => {
    const history = Array.from({ length: 28 }, (_, i) => normal(day(28 - i), { restingHr: 40 }));
    const r = computeReadiness([...history, normal(DATE, { restingHr: 44 })], [], DATE);
    expect(r.signals.find((s) => s.name === "restingHr")).toEqual(expect.objectContaining({ score: -1, value: "44 bpm", baseline: expect.stringContaining("40 bpm") }));
  });

  it("uses Garmin's 7-day average when fewer than 14 days are stored, and says so", () => {
    const few = [normal(day(3)), normal(day(2)), normal(day(1)), normal(DATE, { restingHr: 55, restingHr7d: 50 })];
    expect(few.length).toBeLessThan(MIN_BASELINE_DAYS);
    const rhr = computeReadiness(few, [], DATE).signals.find((s) => s.name === "restingHr")!;
    expect(rhr.baseline).toMatch(/7-day average/);
    expect(rhr.score).toBe(-2);
  });

  it("leaves out a signal the data cannot say, names it, and lowers the confidence", () => {
    const r = computeReadiness(month({ hrvLastNight: null, hrvBalancedLow: null, hrvBalancedHigh: null, hrvWeeklyAvg: null, bodyBatteryWake: null }), [], DATE);
    expect(r.signals.map((s) => s.name)).not.toContain("hrv");
    expect(r.missing.join("\n")).toMatch(/hrv: no HRV/);
    expect(r.missing.join("\n")).toMatch(/bodyBattery/);
    expect(r.missing.join("\n")).toMatch(/load: no sessions/);
    expect(r.confidence).toBe("medium");
  });

  it("is unknown, with no score, without the core signals", () => {
    const r = computeReadiness([metricsFor(DATE, { bodyBatteryWake: 80 })], [], DATE);
    expect(r.band).toBe("unknown");
    expect(r.score).toBeNull();
    expect(r.suggestion).toMatch(/Not enough data/);
    expect(computeReadiness([], [], DATE).band).toBe("unknown");
  });

  it("reads the night that ended on the day, and yesterday's stress", () => {
    const stressedYesterday = computeReadiness(month({}, { avgStress: 65 }), [], DATE).signals.find((s) => s.name === "stress")!;
    expect(stressedYesterday.score).toBe(-2);
    // a stressful day today and a bad night tomorrow change nothing about today
    const withLater = [...month(), normal(day(-1), { avgStress: 90, sleepSeconds: 10_000, hrvLastNight: 20 })];
    expect(computeReadiness(withLater, [], DATE)).toEqual(computeReadiness(month(), [], DATE));
  });

  it("does not depend on the clock: the same stored data gives the same answer", () => {
    expect(computeReadiness(month(), usualTraining(), DATE)).toEqual(computeReadiness(month(), usualTraining(), DATE));
  });

  it("keeps its thresholds in order", () => {
    expect(BACK_OFF_AT).toBeLessThan(0);
    expect(GO_HARDER_AT).toBeGreaterThan(0);
  });
});

describe("the load of the last days", () => {
  it("weighs a hard session of yesterday and a heavy 3 days against the usual", () => {
    const heavy = [...usualTraining().filter((r) => !r.id.startsWith("2-")), session(1, 18, { rpe: 85, seconds: 5400 }), session(2, 18, { rpe: 80, seconds: 5400 })];
    const l = loadSummary(heavy, DATE)!;
    expect(l.sessions).toBe(2);
    expect(l.ratio!).toBeGreaterThan(1.3);
    expect(l.hoursSinceHard).toBe(6); // 18:00 the day before, from the start of the day
    expect(l.score).toBeLessThanOrEqual(-1);
  });

  it("counts a rest period as a fresher day", () => {
    const l = loadSummary(usualTraining().filter((r) => !/^[2-4]-/.test(r.id)), DATE)!;
    expect(l.ratio).toBeLessThanOrEqual(0.7);
    expect(l.score).toBe(1);
  });

  it("falls back to heart rate when no effort was rated, and to a plain figure without it", () => {
    const byHr = loadSummary([session(1, 8, { rpe: null, avgHr: 171, maxHr: 180 })], DATE)!; // 95% of the highest seen
    expect(byHr.hoursSinceHard).toBe(16);
    const plain = loadSummary([session(1, 8, { rpe: null, avgHr: null, maxHr: null })], DATE)!;
    expect(plain.acute).toBe(240); // 60 minutes x 4
  });

  it("ignores sessions on or after the day, and has nothing without sessions", () => {
    expect(loadSummary([session(0, 9)], DATE)).toBeNull();
    expect(loadSummary([session(40, 9)], DATE)).toBeNull();
    expect(loadSummary([], DATE)).toBeNull();
  });
});

describe("baselines", () => {
  it("gives the medians of the 28 days before, once there are enough", () => {
    const b = baselines(month(), DATE);
    expect(b).toEqual({ days: 28, hrv: 57, restingHr: 50, sleepHours: 7.5, bodyBatteryWake: 75, sleepRespiration: null });
    const breathing = baselines(month().map((m) => ({ ...m, avgSleepRespiration: 14.4 })), DATE);
    expect(breathing.sleepRespiration).toBe(14.4);
    expect(baselines(month().slice(-5), DATE)).toEqual({ days: 4, hrv: null, restingHr: null, sleepHours: null, bodyBatteryWake: null, sleepRespiration: null });
  });
});
