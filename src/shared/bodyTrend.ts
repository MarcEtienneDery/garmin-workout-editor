import type { DayMetrics } from "./store";

export const STEADY_PER_WEEK_KG = 0.1;
export const MIN_WEIGH_INS = 3;
export const MIN_SPAN_DAYS = 7;

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
const round = (v: number, digits = 1) => Math.round(v * 10 ** digits) / 10 ** digits;

export interface BodyTrend {
  weighIns: number;
  latest: { day: string; kg: number; bodyFatPercent: number | null } | null;
  first: { day: string; kg: number } | null;
  perWeekKg: number | null;
  changeKg: number | null;
  direction: "gaining" | "losing" | "steady" | null;
}

export function bodyTrend(days: Pick<DayMetrics, "day" | "weightKg" | "bodyFatPercent">[]): BodyTrend {
  const points = days.filter((d) => d.weightKg !== null).sort((a, b) => (a.day < b.day ? -1 : 1));
  const none: BodyTrend = { weighIns: 0, latest: null, first: null, perWeekKg: null, changeKg: null, direction: null };
  if (!points.length) return none;
  const last = points[points.length - 1], head = points[0];
  const trend: BodyTrend = {
    ...none,
    weighIns: points.length,
    latest: { day: last.day, kg: round(last.weightKg as number), bodyFatPercent: last.bodyFatPercent === null ? null : round(last.bodyFatPercent) },
    first: { day: head.day, kg: round(head.weightKg as number) },
  };
  const span = dayNumber(last.day) - dayNumber(head.day);
  if (points.length < MIN_WEIGH_INS || span < MIN_SPAN_DAYS) return trend;

  const xs = points.map((p) => dayNumber(p.day) - dayNumber(head.day)), ys = points.map((p) => p.weightKg as number);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length, mx = mean(xs), my = mean(ys);
  const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const perWeekKg = round(slope * 7, 2);
  return { ...trend, perWeekKg, changeKg: round(slope * span), direction: Math.abs(perWeekKg) < STEADY_PER_WEEK_KG ? "steady" : perWeekKg > 0 ? "gaining" : "losing" };
}
