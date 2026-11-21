import { type BodyTrend, bodyTrend } from "./bodyTrend";
import { BASELINE_DAYS, type Band, baselines, computeReadiness, dayIntensityMinutes, type Readiness } from "./readiness";
import { nutritionDays } from "./nutrition";
import { toWeighIn } from "./renphoFit";
import { type DayMetrics, type SqliteStore, emptyDayMetrics } from "./store";
import { addDays } from "./wellnessSync";

const LOAD_DAYS = 31;

export function readinessAt(store: SqliteStore, profile: string, date: string): { readiness: Readiness; daysStored: number } {
  const metrics = store.wellness.metrics(profile, addDays(date, -LOAD_DAYS), date);
  const load = store.activities.loadRows(profile, `${addDays(date, -LOAD_DAYS)} 00:00:00`);
  return { readiness: computeReadiness(metrics, load, date), daysStored: metrics.filter((m) => m.day >= addDays(date, -BASELINE_DAYS)).length };
}

export interface ReadinessDay {
  day: string;
  band: Band;
  score: number | null;
}

export function readinessDays(store: SqliteStore, profile: string, from: string, to: string): ReadinessDay[] {
  if (from > to) return [];
  const start = addDays(from, -LOAD_DAYS);
  const metrics = store.wellness.metrics(profile, start, to);
  const load = store.activities.loadRows(profile, `${start} 00:00:00`);
  const days: ReadinessDay[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const { band, score } = computeReadiness(metrics, load, day);
    days.push({ day, band, score });
  }
  return days;
}

export function wellnessRange(store: SqliteStore, profile: string, from: string, to: string): { baselines: ReturnType<typeof baselines>; days: DayMetrics[] } {
  const all = store.wellness.metrics(profile, addDays(from, -BASELINE_DAYS), to);
  return { baselines: baselines(all, to), days: all.filter((m) => m.day >= from) };
}

export type BodyDay = Pick<DayMetrics, "day" | "weightKg" | "bodyFatPercent" | "muscleKg" | "bmi" | "totalKcal" | "activeKcal" | "bmrKcal">;

const mean = (values: (number | undefined)[]): number | null => {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 100) / 100 : null;
};

export function withScaleWeighIns(store: SqliteStore, profile: string, from: string, to: string, stored: DayMetrics[]): DayMetrics[] {
  const ledger = store.renpho.measurements(profile, { sinceDay: from, untilDay: to });
  if (!ledger.length) return stored;
  const byDay = new Map<string, NonNullable<ReturnType<typeof toWeighIn>>[]>();
  for (const m of ledger) {
    const w = toWeighIn(m.data);
    if (w) byDay.set(m.day, [...(byDay.get(m.day) ?? []), w]);
  }
  const days = new Map(stored.map((d) => [d.day, d]));
  for (const [day, list] of byDay) {
    const have = days.get(day);
    if (have && have.weightKg !== null) continue;
    days.set(day, {
      ...(have ?? emptyDayMetrics(day)),
      weightKg: mean(list.map((w) => w.weight)),
      bodyFatPercent: mean(list.map((w) => w.percentFat)),
      muscleKg: mean(list.map((w) => w.muscleMass)),
      bmi: mean(list.map((w) => w.bmi)),
    });
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

export function bodyRange(store: SqliteStore, profile: string, from: string, to: string): { body: BodyTrend; days: BodyDay[] } {
  const days = withScaleWeighIns(store, profile, from, to, store.wellness.metrics(profile, from, to)).map(({ day, weightKg, bodyFatPercent, muscleKg, bmi, totalKcal, activeKcal, bmrKcal }) => ({ day, weightKg, bodyFatPercent, muscleKg, bmi, totalKcal, activeKcal, bmrKcal }));
  return { body: bodyTrend(days), days };
}

export interface IntakeVsBurn {
  loggedDays: number;
  days: number;
  eatenKcal: number | null;
  burnedKcal: number | null;
}

export function intakeVsBurn(store: SqliteStore, profile: string, from: string, to: string, today: string): IntakeVsBurn {
  const logged = nutritionDays(store, profile, from, to, today).filter((d) => d.day < today && d.entries > 0);
  const both = logged.filter((d) => d.burnedKcal !== null);
  const mean = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  return { loggedDays: logged.length, days: both.length, eatenKcal: both.length ? mean(both.map((d) => d.kcal)) : null, burnedKcal: both.length ? mean(both.map((d) => d.burnedKcal as number)) : null };
}

export interface IntensityWeek {
  start: string;
  minutes: number;
  daysStored: number;
  days: number;
}

export function intensityWeek(store: SqliteStore, profile: string, today: string): IntensityWeek {
  const sinceMonday = (new Date(Date.parse(`${today}T00:00:00Z`)).getUTCDay() + 6) % 7;
  const start = addDays(today, -sinceMonday);
  const stored = store.wellness.metrics(profile, start, today).map(dayIntensityMinutes).filter((n): n is number => n !== null);
  return { start, minutes: stored.reduce((total, n) => total + n, 0), daysStored: stored.length, days: sinceMonday + 1 };
}

export const TREND_DAYS = 7;

export interface TrendDay {
  day: string;
  steps: number | null;
  minutes: number | null;
  bodyBatteryWake: number | null;
  sleepSeconds: number | null;
}

export function dayTrend(store: SqliteStore, profile: string, today: string): TrendDay[] {
  const from = addDays(today, -(TREND_DAYS - 1));
  const stored = new Map(store.wellness.metrics(profile, from, today).map((m) => [m.day, m]));
  return Array.from({ length: TREND_DAYS }, (_, i) => {
    const day = addDays(from, i), m = stored.get(day);
    return { day, steps: m?.steps ?? null, minutes: m ? dayIntensityMinutes(m) : null, bodyBatteryWake: m?.bodyBatteryWake ?? null, sleepSeconds: m?.sleepSeconds ?? null };
  });
}
