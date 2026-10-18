/**
 * Synthetic Garmin wellness responses with the key shapes the real ones have (nothing here is anyone's data).
 */
import type { DayMetrics } from "../../shared/store";

export const sleepResponse = (over: { seconds?: number; score?: number; needMinutes?: number; awake?: number; hrv?: number; rhr?: number } = {}) => ({
  dailySleepDTO: {
    calendarDate: "2026-01-01",
    sleepTimeSeconds: over.seconds ?? 27_000,
    deepSleepSeconds: 4_500,
    lightSleepSeconds: 16_000,
    remSleepSeconds: 6_500,
    awakeSleepSeconds: 900,
    awakeCount: over.awake ?? 2,
    avgSleepStress: 18,
    averageRespirationValue: 14,
    sleepScores: { overall: { value: over.score ?? 82, qualifierKey: "GOOD" }, totalDuration: { qualifierKey: "GOOD" } },
    sleepNeed: { baseline: 480, actual: over.needMinutes ?? 480 },
  },
  avgOvernightHrv: over.hrv ?? 55,
  hrvStatus: "BALANCED",
  restingHeartRate: over.rhr ?? 50,
  bodyBatteryChange: 60,
  sleepLevels: [],
});

export const hrvResponse = (over: { last?: number; weekly?: number; low?: number; high?: number; lowUpper?: number; status?: string } = {}) => ({
  hrvSummary: {
    calendarDate: "2026-01-01",
    weeklyAvg: over.weekly ?? 55,
    lastNightAvg: over.last ?? 57,
    lastNight5MinHigh: 80,
    baseline: { lowUpper: over.lowUpper ?? 46, balancedLow: over.low ?? 50, balancedUpper: over.high ?? 65, markerValue: 0.5 },
    status: over.status ?? "BALANCED",
    feedbackPhrase: "HRV_BALANCED_2",
  },
  hrvReadings: [],
});

export const summaryResponse = (over: { rhr?: number; rhr7?: number; stress?: number; wake?: number; steps?: number } = {}) => ({
  calendarDate: "2026-01-01",
  totalSteps: over.steps ?? 8000,
  restingHeartRate: over.rhr ?? 50,
  lastSevenDaysAvgRestingHeartRate: over.rhr7 ?? 50,
  averageStressLevel: over.stress ?? 30,
  maxStressLevel: 80,
  bodyBatteryAtWakeTime: over.wake ?? 75,
  bodyBatteryHighestValue: 90,
  bodyBatteryLowestValue: 20,
  bodyBatteryChargedValue: 70,
  bodyBatteryDrainedValue: 65,
  moderateIntensityMinutes: 20,
  vigorousIntensityMinutes: 10,
});

/** A day's metrics with every field empty, then what the test sets. */
export const metricsFor = (day: string, over: Partial<DayMetrics> = {}): DayMetrics => ({
  day,
  sleepSeconds: null, sleepScore: null, deepSeconds: null, lightSeconds: null, remSeconds: null, awakeSeconds: null, awakeCount: null, sleepStress: null, sleepNeedMinutes: null, overnightHrv: null,
  hrvLastNight: null, hrvWeeklyAvg: null, hrvLowUpper: null, hrvBalancedLow: null, hrvBalancedHigh: null, hrvStatus: null,
  restingHr: null, restingHr7d: null, avgStress: null, maxStress: null,
  bodyBatteryWake: null, bodyBatteryHigh: null, bodyBatteryLow: null, bodyBatteryCharged: null, bodyBatteryDrained: null,
  steps: null, moderateMinutes: null, vigorousMinutes: null, avgSleepRespiration: null, avgSleepSpo2: null, lowestSpo2: null,
  ...over,
});
