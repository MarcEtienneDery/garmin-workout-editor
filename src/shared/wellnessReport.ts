/**
 * wellnessReport.ts — what the stored daily health data says, read from the database: the readiness for a day, and the
 * days of a range with the person's own normal. The MCP tools and the web view both answer from these, so they cannot disagree.
 */
import { type BodyTrend, bodyTrend } from "./bodyTrend";
import { BASELINE_DAYS, baselines, computeReadiness, dayIntensityMinutes, type Readiness } from "./readiness";
import { toWeighIn } from "./renphoFit";
import { type DayMetrics, type SqliteStore, emptyDayMetrics } from "./store";
import { addDays } from "./wellnessSync";

/** Days of activities the load of a readiness is worked out from. */
const LOAD_DAYS = 31;

/** How ready the person is on `date`, and how many days of data it was worked out from. */
export function readinessAt(store: SqliteStore, profile: string, date: string): { readiness: Readiness; daysStored: number } {
  const metrics = store.wellness.metrics(profile, addDays(date, -LOAD_DAYS), date); // the load looks 31 days back, the baselines 28
  const load = store.activities.loadRows(profile, `${addDays(date, -LOAD_DAYS)} 00:00:00`);
  return { readiness: computeReadiness(metrics, load, date), daysStored: metrics.filter((m) => m.day >= addDays(date, -BASELINE_DAYS)).length };
}

/** The stored days from `from` to `to`, oldest first, with the person's own normal over the 28 days before `to`. */
export function wellnessRange(store: SqliteStore, profile: string, from: string, to: string): { baselines: ReturnType<typeof baselines>; days: DayMetrics[] } {
  const all = store.wellness.metrics(profile, addDays(from, -BASELINE_DAYS), to);
  return { baselines: baselines(all, to), days: all.filter((m) => m.day >= from) };
}

/** What the Weight view shows of a day: the weigh-in, what the scale measured with it, and the calories burned. */
export type BodyDay = Pick<DayMetrics, "day" | "weightKg" | "bodyFatPercent" | "muscleKg" | "bmi" | "totalKcal" | "activeKcal" | "bmrKcal">;

const mean = (values: (number | undefined)[]): number | null => {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 100) / 100 : null;
};

/**
 * The stored days with the weigh-ins of the Renpho scale added on the days that carry no weight of their own from Garmin. A
 * weigh-in Renpho uploaded to Garmin comes back as Garmin's, so Garmin's number wins and nothing is counted twice. It works
 * without Garmin: the scale's weigh-ins are kept as Renpho sent them.
 */
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

/** The stored days from `from` to `to`, oldest first, with their weight and calories, and the weight trend over them. */
export function bodyRange(store: SqliteStore, profile: string, from: string, to: string): { body: BodyTrend; days: BodyDay[] } {
  const days = withScaleWeighIns(store, profile, from, to, store.wellness.metrics(profile, from, to)).map(({ day, weightKg, bodyFatPercent, muscleKg, bmi, totalKcal, activeKcal, bmrKcal }) => ({ day, weightKg, bodyFatPercent, muscleKg, bmi, totalKcal, activeKcal, bmrKcal }));
  return { body: bodyTrend(days), days };
}

export interface IntensityWeek {
  /** The Monday the week began, which is when Garmin starts counting the week's minutes. */
  start: string;
  /** Moderate minutes plus twice the vigorous ones, from `start` to the day asked. */
  minutes: number;
  /** How many of the `days` so far have a summary stored: fewer means the total is short. */
  daysStored: number;
  days: number;
}

/**
 * The intensity minutes of the week so far. Garmin's goal (150) is for the week, so one day's minutes say nothing about it.
 * The week starts on Monday: Garmin's weekly intensity totals (usersummary-service/stats/im/weekly) are keyed by Monday whatever
 * "first day of the week" the account has, and equal the stored daily minutes added up by Monday weeks (checked on a real account).
 */
export function intensityWeek(store: SqliteStore, profile: string, today: string): IntensityWeek {
  const sinceMonday = (new Date(Date.parse(`${today}T00:00:00Z`)).getUTCDay() + 6) % 7;
  const start = addDays(today, -sinceMonday);
  const stored = store.wellness.metrics(profile, start, today).map(dayIntensityMinutes).filter((n): n is number => n !== null);
  return { start, minutes: stored.reduce((total, n) => total + n, 0), daysStored: stored.length, days: sinceMonday + 1 };
}
