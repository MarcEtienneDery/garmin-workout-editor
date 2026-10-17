/**
 * lifetimeStats.ts — what the stored activities add up to over a lifetime, for runs and for strength training.
 *
 * Nothing here is kept as a second copy: the totals and records are worked out from the activities table, and the answer
 * is remembered only while the table has not changed (see ActivityTable.fingerprint). A new activity, or the details of
 * one that arrived later, change the fingerprint, so the next look works it out again and the numbers are always current.
 *
 * Distances are meters, times seconds, loads pounds, dates the strings of the rows (YYYY-MM-DD; local time).
 */
import ActivityExporter from "../activityExporter";
import { type BestLift, type LiftMax, bestLifts, expandSets, liftMax } from "./oneRepMax";
import type { ActivityTable, LifetimeRow, StrengthRow } from "./store/activities";
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
  /** Climb over all the runs, in meters. */
  gain: number;
  /** Seconds per km over all of it; null without distance. */
  avgPaceSec: number | null;
  longest: (Effort & { meters: number; seconds: number }) | null;
  /** The fastest average pace of a run of at least 3 km. */
  bestPace: (Effort & { meters: number; paceSec: number }) | null;
  biggestClimb: (Effort & { gain: number }) | null;
  /** The week (its Monday) and the month (YYYY-MM) with the most distance. */
  biggestWeek: { start: string; meters: number; runs: number } | null;
  biggestMonth: { month: string; meters: number; runs: number } | null;
  /** The fastest time over each distance the watch timed inside a run, shortest distance first. */
  efforts: (Effort & { meters: number; seconds: number })[];
  vo2max: { latest: { value: number; date: string } | null; best: { value: number; date: string } | null };
}

export interface ExerciseStats {
  name: string;
  /** Activities it was done in, sets and reps counted, and the load (reps × weight). */
  sessions: number;
  sets: number;
  reps: number;
  volume: number;
  /** The best estimated one-rep max (Epley, sets of up to 12 counted reps), and the heaviest weight lifted. */
  best: BestLift | null;
  /** The one-rep max in use for the exercise (its benchmark, else `best`): what the % of 1RM section measures against. */
  max: LiftMax | null;
  heaviest: { weight: number; reps: number; date: string } | null;
  firstDate: string;
  lastDate: string;
}

export interface StrengthStats {
  sessions: number;
  seconds: number;
  /** From the list items, so they cover every session. */
  sets: number;
  reps: number;
  /** From the exercise sets of the sessions whose details are stored; `detailed` says how many that is. */
  volume: number;
  detailed: number;
  exercises: ExerciseStats[];
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
  /** Newest year first. */
  years: YearStats[];
}

export interface LifetimeInput {
  profile: string;
  rows: LifetimeRow[];
  /** The fastest split the watch timed inside an activity: its distance and time. */
  splits: { id: string; meters: number; seconds: number }[];
  /** The exercise sets of the strength sessions whose details are stored. */
  lifts: { id: string; date: string; sets: ExerciseSet[] | undefined }[];
  /** The profile's one-rep max benchmarks by Garmin exercise key, in pounds. */
  benchmarks?: Record<string, number>;
}

const RUN = "running";
const STRENGTH = "strength_training";
/** A pace over less than this says little about a runner. */
const MIN_PACE_METERS = 3000;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const day = (startLocal: string): string => startLocal.slice(0, 10);

/** The Monday of the week a date (YYYY-MM-DD) falls in. */
export function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

/** The key whose total is the biggest; the later key wins a tie. */
function top<T extends { meters: number }>(groups: Map<string, T>): [string, T] | null {
  let best: [string, T] | null = null;
  for (const entry of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) if (!best || entry[1].meters >= best[1].meters) best = entry;
  return best;
}

function runStats(rows: LifetimeRow[], splits: LifetimeInput["splits"]): RunStats | null {
  const runs = rows.filter((r) => r.type === RUN);
  if (!runs.length) return null;
  const meters = runs.reduce((a, r) => a + (r.distance ?? 0), 0), seconds = runs.reduce((a, r) => a + (r.duration ?? 0), 0);
  const who = (r: LifetimeRow): Effort => ({ id: r.id, date: day(r.startLocal), name: r.name });

  let longest: RunStats["longest"] = null, bestPace: RunStats["bestPace"] = null, biggestClimb: RunStats["biggestClimb"] = null;
  let latest: { value: number; date: string } | null = null, bestVo2: { value: number; date: string } | null = null;
  const weeks = new Map<string, { meters: number; runs: number }>(), months = new Map<string, { meters: number; runs: number }>();
  for (const r of runs) { // oldest first
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
    vo2max: { latest, best: bestVo2 },
  };
}

function strengthStats(rows: LifetimeRow[], lifts: LifetimeInput["lifts"], benchmarks: LifetimeInput["benchmarks"]): StrengthStats | null {
  const sessions = rows.filter((r) => r.type === STRENGTH);
  if (!sessions.length) return null;

  const by = new Map<string, ExerciseStats & { sessionIds: Set<string> }>();
  let volume = 0, detailed = 0;
  for (const a of [...lifts].sort((x, y) => x.date.localeCompare(y.date))) { // oldest first
    const sets = (a.sets ?? []).filter((x) => x && x.category !== "INTERVAL" && x.exerciseName);
    if (!sets.length) continue;
    detailed++;
    for (const x of sets) {
      const e = by.get(x.exerciseName) ?? { name: x.exerciseName, sessions: 0, sets: 0, reps: 0, volume: 0, best: null, heaviest: null, max: null, firstDate: a.date, lastDate: a.date, sessionIds: new Set<string>() };
      e.sessionIds.add(a.id);
      for (const s of expandSets(x)) {
        e.sets++; e.reps += s.reps; e.volume += s.reps * s.weight;
        if (s.weight > 0 && (!e.heaviest || s.weight > e.heaviest.weight || (s.weight === e.heaviest.weight && s.reps >= e.heaviest.reps))) e.heaviest = { weight: s.weight, reps: s.reps, date: a.date };
      }
      e.lastDate = a.date;
      by.set(x.exerciseName, e);
    }
  }
  const best = bestLifts(lifts.map((a) => ({ date: a.date, sets: a.sets })));
  const exercises = [...by.values()].map(({ sessionIds, ...e }) => ({ ...e, sessions: sessionIds.size, volume: Math.round(e.volume), best: best[e.name] ?? null, max: liftMax(e.name, benchmarks, best[e.name]) }));
  for (const e of exercises) volume += e.volume;
  exercises.sort((a, b) => b.sessions - a.sessions || b.volume - a.volume || a.name.localeCompare(b.name));
  return {
    sessions: sessions.length, seconds: Math.round(sessions.reduce((a, r) => a + (r.duration ?? 0), 0)),
    sets: sessions.reduce((a, r) => a + (r.sets ?? 0), 0), reps: sessions.reduce((a, r) => a + (r.reps ?? 0), 0),
    volume, detailed, exercises,
  };
}

/** The lifetime numbers over some stored activities. Pure: what goes in is what comes out. */
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
    strength: strengthStats(rows, input.lifts, input.benchmarks),
    years: [...years.values()].map((y) => ({ ...y, seconds: Math.round(y.seconds), runMeters: Math.round(y.runMeters) })).sort((a, b) => b.year.localeCompare(a.year)),
  };
}

// ── From the database ────────────────────────────────────────────────────

let slimmer: ActivityExporter | undefined;
const cache = new Map<string, { key: string; stats: LifetimeStats }>();
const NO_BENCHMARKS: Record<string, number> = {};

/**
 * The profile's lifetime stats, read from the activities table. The answer is kept while the table's fingerprint is the
 * same (and so are the benchmarks), so a page that asks again costs one small query; when an activity is added, or one
 * gets its details, the numbers are worked out again.
 */
export function lifetimeStats(activities: ActivityTable, profile: string, benchmarks: Record<string, number> = NO_BENCHMARKS): LifetimeStats {
  const key = `${activities.fingerprint(profile)}|${JSON.stringify(benchmarks)}`;
  const had = cache.get(profile);
  if (had && had.key === key) return had.stats;
  slimmer ??= new ActivityExporter(null as never); // the transform needs no Garmin client
  const strength: StrengthRow[] = activities.strengthRows(profile);
  const stats = computeLifetime({
    profile,
    rows: activities.lifetimeRows(profile),
    splits: activities.fastestSplits(profile),
    benchmarks,
    lifts: strength.map((r) => ({ id: r.id, date: day(r.startLocal), sets: slimmer!.slim([{ ...r.raw, ...r.detail }])[0]?.exerciseSets as ExerciseSet[] | undefined })),
  });
  cache.set(profile, { key, stats });
  return stats;
}

/** Forget what was kept (for tests; a changed table forgets by itself). */
export function forgetLifetimeStats(): void {
  cache.clear();
}
