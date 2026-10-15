/**
 * workoutSync.ts — compare a workout from a plan file with the copy on Garmin.
 *
 * Both sides must already be in the plan format and passed through the same
 * Garmin <-> plan transform (WorkoutEditor.toGarminCanonical for the plan side,
 * WorkoutEditor.fromGarminDetail for the Garmin side), so only real differences
 * remain. Plan-only metadata (workoutId, scheduledDate, sendToDevice) is ignored.
 */
import type { DetailedWorkout, WorkoutStep } from "./types";

/** synced: identical | modified: differs | not-uploaded: no workoutId | missing: id not on Garmin | error: could not check */
export type SyncState = "synced" | "modified" | "not-uploaded" | "missing" | "error";

export interface SyncStatus {
  index: number;
  state: SyncState;
  /** Human-readable differences (state "modified") or the reason (state "error"). */
  differences: string[];
}

const MAX_DIFFERENCES = 10;

// cardio and swimming are uploaded with the running sport id, so Garmin hands them back as running.
const SPORT_ALIAS: Record<string, string> = { cardio: "running", swimming: "running" };
const sportOf = (type: string | undefined): string => SPORT_ALIAS[type ?? ""] ?? type ?? "";

type Plain = Record<string, unknown>;

/** A step without the noise Garmin adds or drops (null/0 values, "no.target", step numbering). */
function cleanStep(step: WorkoutStep): Plain {
  const out: Plain = {};
  for (const [key, value] of Object.entries(step)) {
    if (key === "stepOrder" || value === undefined || value === null || value === "") continue;
    if (value === 0 && key !== "repeatGroupIndex") continue;
    if (key === "targetType" && value === "no.target") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Clean every step and renumber the repeat groups by order of appearance: a group that repeats
 * once is just its steps, and Garmin and the plan may number the groups differently.
 */
function cleanSteps(steps: WorkoutStep[]): Plain[] {
  const groups = new Map<unknown, number>();
  return steps.map((step) => {
    const out = cleanStep(step);
    if (typeof out.numberOfRepeats === "number" && out.numberOfRepeats > 1 && out.repeatGroupIndex !== undefined) {
      if (!groups.has(out.repeatGroupIndex)) groups.set(out.repeatGroupIndex, groups.size);
      out.repeatGroupIndex = groups.get(out.repeatGroupIndex);
    } else {
      delete out.numberOfRepeats;
      delete out.repeatGroupIndex;
    }
    return out;
  });
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const show = (value: unknown): string => (value === undefined ? "none" : JSON.stringify(value));

function stepLabel(step: Plain | undefined, index: number): string {
  const name = step?.exerciseName ?? step?.stepType;
  return `Step ${index + 1}${name ? ` (${name})` : ""}`;
}

export interface CompareOptions {
  /** Skip the steps (e.g. distance-only running workouts, which Garmin builds its own steps for). */
  ignoreSteps?: boolean;
}

/** What differs between the plan's workout and Garmin's; empty when they match. */
export function compareWorkouts(plan: DetailedWorkout, garmin: DetailedWorkout, options: CompareOptions = {}): string[] {
  const found: string[] = [];

  if (text(plan.workoutName) !== text(garmin.workoutName)) {
    found.push(`Name: "${text(plan.workoutName)}" in the plan, "${text(garmin.workoutName)}" on Garmin`);
  }
  if (sportOf(plan.workoutType) !== sportOf(garmin.workoutType)) {
    found.push(`Type: ${plan.workoutType ?? "none"} in the plan, ${garmin.workoutType ?? "none"} on Garmin`);
  }
  if (text(plan.description) !== text(garmin.description)) {
    found.push("Description differs");
  }

  if (!options.ignoreSteps) {
    const planSteps = cleanSteps(plan.steps ?? []);
    const garminSteps = cleanSteps(garmin.steps ?? []);
    if (planSteps.length !== garminSteps.length) {
      found.push(`Steps: ${planSteps.length} in the plan, ${garminSteps.length} on Garmin`);
    }
    for (let i = 0; i < Math.min(planSteps.length, garminSteps.length); i++) {
      const a = planSteps[i];
      const b = garminSteps[i];
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
          found.push(`${stepLabel(a, i)}: ${key} is ${show(a[key])} in the plan, ${show(b[key])} on Garmin`);
        }
      }
    }
  }

  return found.length > MAX_DIFFERENCES
    ? [...found.slice(0, MAX_DIFFERENCES), `…and ${found.length - MAX_DIFFERENCES} more`]
    : found;
}
