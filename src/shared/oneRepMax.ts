/**
 * oneRepMax.ts — a one-rep max estimated from what was lifted before.
 *
 * A lift's one-rep max is estimated from the sets in the stored activities: the best set of the exercise, ever, worked into
 * a one-rep max with the Epley formula. A set of 1 rep counts as itself; sets of more than MAX_REPS reps, or without
 * counted reps (Garmin gives 0 when the watch did not count), say too little to be used. The lifetime stats work it out
 * once per exercise (bestLifts); the Stats view and the % of 1RM section both read it from there, so they always agree.
 * No plan file or benchmark is consulted.
 */
import type { ExerciseSet } from "./types";

/** Sets above this many reps are not used for an estimate: the formula is too loose out there. */
export const MAX_REPS = 12;

/** The Epley estimate of a one-rep max from one set, in the unit of the weight; null when the set cannot say. */
export function epley(weight: number, reps: number): number | null {
  if (!(weight > 0) || !(reps > 0) || reps > MAX_REPS) return null;
  return reps === 1 ? weight : weight * (1 + reps / 30);
}

/** One performed set. */
export interface LiftSet {
  weight: number;
  reps: number;
}

/** The sets that are lifts: not the intervals of a workout, and named. */
export function liftSets(sets: ExerciseSet[] | undefined): ExerciseSet[] {
  return (sets ?? []).filter((x) => x && x.category !== "INTERVAL" && x.exerciseName);
}

/** An exercise's sets one by one: `sets` of it, with the per-set lists when the reps or the weight varied. */
export function expandSets(x: Pick<ExerciseSet, "sets" | "reps" | "repsList" | "weight" | "weightList">): LiftSet[] {
  const n = Math.max(1, x.sets || 1);
  const reps = Array.isArray(x.repsList) ? x.repsList : Array(n).fill(x.reps ?? 0);
  const weights = Array.isArray(x.weightList) ? x.weightList : Array(n).fill(x.weight ?? 0);
  return Array.from({ length: Math.max(n, reps.length, weights.length) }, (_, i) => ({ weight: weights[i] ?? 0, reps: reps[i] ?? 0 }));
}

export interface BestLift {
  /** The estimated one-rep max, in the unit of the weights. */
  oneRm: number;
  /** The set it was worked out from, and the day (YYYY-MM-DD) it was done. */
  weight: number;
  reps: number;
  date: string;
}

/**
 * The best estimated one-rep max (to a tenth) of each exercise over some activities, by exercise name. On a tie the later set wins, so
 * the answer names the most recent time the lift was that good.
 */
export function bestLifts(activities: { date: string; sets: ExerciseSet[] | undefined }[]): Record<string, BestLift> {
  const best: Record<string, BestLift> = {};
  for (const a of activities) {
    for (const x of liftSets(a.sets)) {
      for (const s of expandSets(x)) {
        const raw = epley(s.weight, s.reps);
        if (raw === null) continue;
        const oneRm = Math.round(raw * 10) / 10; // a tenth of a pound is as fine as it gets
        const had = best[x.exerciseName];
        if (!had || oneRm > had.oneRm || (oneRm === had.oneRm && a.date > had.date)) best[x.exerciseName] = { oneRm, weight: s.weight, reps: s.reps, date: a.date };
      }
    }
  }
  return best;
}
