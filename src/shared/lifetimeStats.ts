import { slimStored } from "../activityExporter";
import { type BestLift, bestLifts, epley, expandSets, liftSets } from "./oneRepMax";
import type { ActivityTable, LifetimeRow } from "./store/activities";
import type { ExerciseSet } from "./types";

export interface Effort {
  id: string;
  date: string;
  name: string;
}

export interface RunStats {
  runs: number;
  meters: number;
  seconds: number;
  gain: number;
  avgPaceSec: number | null;
  longest: (Effort & { meters: number; seconds: number }) | null;
  bestPace: (Effort & { meters: number; paceSec: number }) | null;
  biggestClimb: (Effort & { gain: number }) | null;
  biggestWeek: { start: string; meters: number; runs: number } | null;
  biggestMonth: { month: string; meters: number; runs: number } | null;
  efforts: (Effort & { meters: number; seconds: number })[];
  vo2max: {
    latest: { value: number; date: string } | null;
    best: { value: number; date: string } | null;
    series: { date: string; value: number }[];
  };
}

export interface ExerciseStats {
  name: string;
  sessions: number;
  sets: number;
  reps: number;
  volume: number;
  best: BestLift | null;
  heaviest: { weight: number; reps: number; date: string } | null;
  firstDate: string;
  lastDate: string;
  history: { date: string; oneRm: number }[];
}

export interface RecentSession {
  date: string;
  exercises: { name: string; sets: number }[];
}

export const RECENT_DAYS = 120;

export interface StrengthStats {
  sessions: number;
  seconds: number;
  sets: number;
  reps: number;
  volume: number;
  detailed: number;
  exercises: ExerciseStats[];
  recent: RecentSession[];
}

export interface YearStats {
  year: string;
  activities: number;
  seconds: number;
  runs: number;
  runMeters: number;
  lifts: number;
  liftSets: number;
}

export interface LifetimeStats {
  profile: string;
  activities: number;
  seconds: number;
  calories: number;
  activeDays: number;
  since: string | null;
  until: string | null;
  byType: { type: string; count: number; seconds: number; meters: number }[];
  running: RunStats | null;
  strength: StrengthStats | null;
  years: YearStats[];
}

export interface LifetimeInput {
  profile: string;
  rows: LifetimeRow[];
  splits: { id: string; meters: number; seconds: number }[];
  lifts: { id: string; date: string; sets: ExerciseSet[] | undefined }[];
}

const RUN = "running";
const STRENGTH = "strength_training";
const MIN_PACE_METERS = 3000;

const day = (startLocal: string): string => startLocal.slice(0, 10);

export function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

function top<T extends { meters: number }>(groups: Map<string, T>): [string, T] | null {
  let best: [string, T] | null = null;
  for (const entry of groups) if (!best || entry[1].meters >= best[1].meters) best = entry;
  return best;
}

function runStats(rows: LifetimeRow[], splits: LifetimeInput["splits"]): RunStats | null {
  const runs = rows.filter((r) => r.type === RUN);
  if (!runs.length) return null;
  const meters = runs.reduce((a, r) => a + (r.distance ?? 0), 0), seconds = runs.reduce((a, r) => a + (r.duration ?? 0), 0);
  const who = (r: LifetimeRow): Effort => ({ id: r.id, date: day(r.startLocal), name: r.name });

  let longest: RunStats["longest"] = null, bestPace: RunStats["bestPace"] = null, biggestClimb: RunStats["biggestClimb"] = null;
  let latest: { value: number; date: string } | null = null, bestVo2: { value: number; date: string } | null = null;
  const series: { date: string; value: number }[] = [];
  const weeks = new Map<string, { meters: number; runs: number }>(), months = new Map<string, { meters: number; runs: number }>();
  for (const r of runs) {
    const m = r.distance ?? 0, s = r.duration ?? 0, date = day(r.startLocal);
    if (m > 0 && (!longest || m > longest.meters)) longest = { ...who(r), meters: Math.round(m), seconds: Math.round(s) };
    if (m >= MIN_PACE_METERS && s > 0) {
      const paceSec = (s / m) * 1000;
      if (!bestPace || paceSec < bestPace.paceSec) bestPace = { ...who(r), meters: Math.round(m), paceSec: Math.round(paceSec) };
    }
    if (r.gain !== null && r.gain > 0 && (!biggestClimb || r.gain > biggestClimb.gain)) biggestClimb = { ...who(r), gain: Math.round(r.gain) };
    if (r.vo2 !== null && r.vo2 > 0) {
      latest = { value: r.vo2, date };
      if (!bestVo2 || r.vo2 > bestVo2.value) bestVo2 = { value: r.vo2, date };
      if (series.length && series[series.length - 1].date === date) series[series.length - 1].value = r.vo2; else series.push({ date, value: r.vo2 });
    }
    for (const [map, key] of [[weeks, mondayOf(date)], [months, date.slice(0, 7)]] as const) {
      const g = map.get(key) ?? { meters: 0, runs: 0 };
      g.meters += m; g.runs++;
      map.set(key, g);
    }
  }

  const byId = new Map(runs.map((r) => [r.id, r]));
  const fastest = new Map<number, Effort & { meters: number; seconds: number }>();
  for (const sp of splits) {
    const r = byId.get(sp.id);
    if (!r || !(sp.seconds > 0) || !(sp.meters > 0)) continue;
    const had = fastest.get(sp.meters);
    if (!had || sp.seconds < had.seconds) fastest.set(sp.meters, { ...who(r), meters: sp.meters, seconds: Math.round(sp.seconds * 10) / 10 });
  }

  const week = top(weeks), month = top(months);
  return {
    runs: runs.length, meters: Math.round(meters), seconds: Math.round(seconds), gain: Math.round(runs.reduce((a, r) => a + (r.gain ?? 0), 0)),
    avgPaceSec: meters > 0 ? Math.round((seconds / meters) * 1000) : null,
    longest, bestPace, biggestClimb,
    biggestWeek: week ? { start: week[0], meters: Math.round(week[1].meters), runs: week[1].runs } : null,
    biggestMonth: month ? { month: month[0], meters: Math.round(month[1].meters), runs: month[1].runs } : null,
    efforts: [...fastest.values()].sort((a, b) => a.meters - b.meters),
    vo2max: { latest, best: bestVo2, series },
  };
}

function strengthStats(rows: LifetimeRow[], lifts: LifetimeInput["lifts"]): StrengthStats | null {
  const sessions = rows.filter((r) => r.type === STRENGTH);
  if (!sessions.length) return null;

  const by = new Map<string, ExerciseStats>();
  let volume = 0, detailed = 0;
  const ordered = [...lifts].sort((x, y) => x.date.localeCompare(y.date));
  const sessionsDone: RecentSession[] = [];
  for (const a of ordered) {
    const sets = liftSets(a.sets);
    if (!sets.length) continue;
    detailed++;
    const done = new Set<string>(), best = new Map<string, number>(), counts = new Map<string, number>();
    for (const x of sets) {
      let e = by.get(x.exerciseName);
      if (!e) by.set(x.exerciseName, (e = { name: x.exerciseName, sessions: 0, sets: 0, reps: 0, volume: 0, best: null, heaviest: null, firstDate: a.date, lastDate: a.date, history: [] }));
      if (!done.has(x.exerciseName)) { done.add(x.exerciseName); e.sessions++; }
      for (const s of expandSets(x)) {
        e.sets++; e.reps += s.reps; e.volume += s.reps * s.weight;
        counts.set(x.exerciseName, (counts.get(x.exerciseName) ?? 0) + 1);
        const est = epley(s.weight, s.reps);
        if (est !== null && est > (best.get(x.exerciseName) ?? 0)) best.set(x.exerciseName, est);
        if (s.weight > 0 && (!e.heaviest || s.weight > e.heaviest.weight || (s.weight === e.heaviest.weight && s.reps >= e.heaviest.reps))) e.heaviest = { weight: s.weight, reps: s.reps, date: a.date };
      }
      e.lastDate = a.date;
    }
    for (const [name, oneRm] of best) by.get(name)!.history.push({ date: a.date, oneRm: Math.round(oneRm * 10) / 10 });
    sessionsDone.push({ date: a.date, exercises: [...counts].map(([name, n]) => ({ name, sets: n })) });
  }
  const newest = sessionsDone.length ? sessionsDone[sessionsDone.length - 1].date : null;
  const since = newest ? new Date(Date.parse(`${newest}T00:00:00Z`) - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10) : null;
  const recent = since ? sessionsDone.filter((s) => s.date >= since) : [];
  const best = bestLifts(ordered);
  const exercises = [...by.values()].map((e) => ({ ...e, volume: Math.round(e.volume), best: best[e.name] ?? null }));
  for (const e of exercises) volume += e.volume;
  exercises.sort((a, b) => b.sessions - a.sessions || b.volume - a.volume || a.name.localeCompare(b.name));
  return {
    sessions: sessions.length, seconds: Math.round(sessions.reduce((a, r) => a + (r.duration ?? 0), 0)),
    sets: sessions.reduce((a, r) => a + (r.sets ?? 0), 0), reps: sessions.reduce((a, r) => a + (r.reps ?? 0), 0),
    volume, detailed, exercises, recent,
  };
}

export function computeLifetime(input: LifetimeInput): LifetimeStats {
  const rows = [...input.rows].sort((a, b) => a.startLocal.localeCompare(b.startLocal));
  const types = new Map<string, { type: string; count: number; seconds: number; meters: number }>();
  const years = new Map<string, YearStats>();
  const days = new Set<string>();
  let seconds = 0, calories = 0;
  for (const r of rows) {
    const s = r.duration ?? 0, m = r.distance ?? 0;
    seconds += s; calories += r.calories ?? 0;
    days.add(day(r.startLocal));
    const t = types.get(r.type) ?? { type: r.type, count: 0, seconds: 0, meters: 0 };
    t.count++; t.seconds += s; t.meters += m;
    types.set(r.type, t);
    const y = years.get(r.startLocal.slice(0, 4)) ?? { year: r.startLocal.slice(0, 4), activities: 0, seconds: 0, runs: 0, runMeters: 0, lifts: 0, liftSets: 0 };
    y.activities++; y.seconds += s;
    if (r.type === RUN) { y.runs++; y.runMeters += m; }
    if (r.type === STRENGTH) { y.lifts++; y.liftSets += r.sets ?? 0; }
    years.set(y.year, y);
  }
  return {
    profile: input.profile,
    activities: rows.length, seconds: Math.round(seconds), calories: Math.round(calories), activeDays: days.size,
    since: rows.length ? day(rows[0].startLocal) : null, until: rows.length ? day(rows[rows.length - 1].startLocal) : null,
    byType: [...types.values()].map((t) => ({ ...t, seconds: Math.round(t.seconds), meters: Math.round(t.meters) })).sort((a, b) => b.count - a.count),
    running: runStats(rows, input.splits),
    strength: strengthStats(rows, input.lifts),
    years: [...years.values()].map((y) => ({ ...y, seconds: Math.round(y.seconds), runMeters: Math.round(y.runMeters) })).sort((a, b) => b.year.localeCompare(a.year)),
  };
}


const caches = new WeakMap<ActivityTable, Map<string, { key: string; stats: LifetimeStats }>>();

export function lifetimeStats(activities: ActivityTable, profile: string): LifetimeStats {
  let cache = caches.get(activities);
  if (!cache) caches.set(activities, (cache = new Map()));
  const key = activities.fingerprint(profile);
  const had = cache.get(profile);
  if (had && had.key === key) return had.stats;
  const stats = computeLifetime({
    profile,
    rows: activities.lifetimeRows(profile),
    splits: activities.fastestSplits(profile),
    lifts: activities
      .between(profile, { type: STRENGTH })
      .filter((a) => a.detail)
      .map((a) => ({ id: a.id, date: day(a.startLocal), sets: slimStored(a.raw, a.detail)?.exerciseSets as ExerciseSet[] | undefined })),
  });
  cache.set(profile, { key, stats });
  return stats;
}
