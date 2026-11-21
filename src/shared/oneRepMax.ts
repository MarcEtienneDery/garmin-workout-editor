import type { ExerciseSet } from "./types";

export const MAX_REPS = 12;

export function epley(weight: number, reps: number): number | null {
  if (!(weight > 0) || !(reps > 0) || reps > MAX_REPS) return null;
  return reps === 1 ? weight : weight * (1 + reps / 30);
}

export interface LiftSet {
  weight: number;
  reps: number;
}

export function liftSets(sets: ExerciseSet[] | undefined): ExerciseSet[] {
  return (sets ?? []).filter((x) => x && x.category !== "INTERVAL" && x.exerciseName);
}

export function expandSets(x: Pick<ExerciseSet, "sets" | "reps" | "repsList" | "weight" | "weightList">): LiftSet[] {
  const n = Math.max(1, x.sets || 1);
  const reps = Array.isArray(x.repsList) ? x.repsList : Array(n).fill(x.reps ?? 0);
  const weights = Array.isArray(x.weightList) ? x.weightList : Array(n).fill(x.weight ?? 0);
  return Array.from({ length: Math.max(n, reps.length, weights.length) }, (_, i) => ({ weight: weights[i] ?? 0, reps: reps[i] ?? 0 }));
}

export interface BestLift {
  oneRm: number;
  weight: number;
  reps: number;
  date: string;
}

export function bestLifts(activities: { date: string; sets: ExerciseSet[] | undefined }[]): Record<string, BestLift> {
  const best: Record<string, BestLift> = {};
  for (const a of activities) {
    for (const x of liftSets(a.sets)) {
      for (const s of expandSets(x)) {
        const raw = epley(s.weight, s.reps);
        if (raw === null) continue;
        const oneRm = Math.round(raw * 10) / 10;
        const had = best[x.exerciseName];
        if (!had || oneRm > had.oneRm || (oneRm === had.oneRm && a.date > had.date)) best[x.exerciseName] = { oneRm, weight: s.weight, reps: s.reps, date: a.date };
      }
    }
  }
  return best;
}
