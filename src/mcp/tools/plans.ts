import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import exerciseCategoryMap from "../../exercise-category-map.json";
import {
  VALID_END_CONDITIONS,
  VALID_STEP_TYPES,
  VALID_TARGET_TYPES,
} from "../../workoutEditor";
import { PROFILE_NAME_REGEX } from "../../shared/store/paths";
import { getStore } from "../../shared/store";
import type { DetailedWorkout } from "../../shared/types";
import { compareWorkouts } from "../../shared/workoutSync";
import {
  dataProfile,
  getValidatorEditor,
  logicalPath as checkedPath,
  readJsonDoc,
  runTool,
  updateJsonDoc,
  writeJsonDoc,
} from "../context";

const EXERCISES = exerciseCategoryMap as Record<string, string>;

// ─── Schemas ────────────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const workoutStepSchema = z.looseObject({
  stepType: z.enum(VALID_STEP_TYPES),
  targetType: z.enum(VALID_TARGET_TYPES),
  endCondition: z.enum(VALID_END_CONDITIONS).optional(),
  endConditionValue: z.number().optional(),
  exerciseName: z.string().optional(),
  targetValueOne: z.number().optional(),
  targetValueTwo: z.number().optional(),
  reps: z.number().optional(),
  durationSeconds: z.number().optional(),
  distanceMeters: z.number().optional(),
  weight: z.number().optional().describe("Pounds"),
  weightPercentage: z.number().optional().describe("Percent of 1RM; requires benchmarkKey"),
  benchmarkKey: z.string().optional(),
  restTimeSeconds: z.number().optional(),
  numberOfRepeats: z.number().optional(),
  repeatGroupIndex: z.number().optional(),
  stepOrder: z.number().optional(),
});

export const plannedWorkoutSchema = z.looseObject({
  workoutName: z.string().min(1),
  workoutId: z.union([z.number(), z.string()]).optional(),
  workoutType: z.string().optional(),
  description: z.string().optional(),
  distanceMeters: z.number().optional(),
  scheduledDate: z.union([isoDate, z.array(isoDate)]).optional(),
  sendToDevice: z.boolean().optional(),
  steps: z.array(workoutStepSchema).optional(),
});

const WORKOUT_TYPES = ["running", "strength_training", "cycling", "cardio", "swimming", "other"] as const;

/**
 * The workout create_workout takes: one that is in no plan, so it has no workoutId (it is always a new workout), no
 * scheduledDate (schedule_workout does that) and none of the plan-only fields. It is strict, so a plan field is refused
 * instead of being quietly ignored (a scheduledDate that did nothing would read as a workout that was scheduled). The type is
 * required because Garmin files a workout with none under running, which would be wrong for a strength workout.
 */
export const newWorkoutSchema = z.strictObject({
  workoutName: z.string().min(1),
  workoutType: z.enum(WORKOUT_TYPES),
  description: z.string().optional(),
  steps: z.array(workoutStepSchema).min(1),
});

export type NewWorkout = z.infer<typeof newWorkoutSchema>;

const STEP_FORMAT = `- steps is a flat list. Each step needs stepType, targetType and endCondition (except stepType "rest"), and endConditionValue > 0. Use endCondition "lap.button" with endConditionValue 0 for open-ended steps the athlete ends on the watch.
- Mirror endConditionValue in the matching field, and keep them equal: reps -> reps, time -> durationSeconds (seconds), distance -> distanceMeters (meters).
- Repeats: give consecutive steps the same repeatGroupIndex and numberOfRepeats. restTimeSeconds on a step adds a rest after it.
- Strength steps: exerciseName must be a Garmin exercise (look it up with list_exercise_names); weight is in lbs; weightPercentage (percent of 1RM) also needs benchmarkKey.
- Targets: heart.rate.zone -> targetValueOne/Two are bpm (min/max); pace.zone -> m/s (slower limit first); no.target needs no values.`;

export const WORKOUT_FORMAT = `Workout format:
- workoutName (required); workoutType: "running" | "strength_training" | "cycling" | "cardio" | "swimming" | "other"; description; workoutId (assigned by Garmin on upload — keep it so a re-upload replaces the old workout); scheduledDate ("YYYY-MM-DD" or an array of them); sendToDevice (bool); distanceMeters (running workouts with no steps).
${STEP_FORMAT}`;

/** WORKOUT_FORMAT for a workout that is in no plan (see newWorkoutSchema). */
export const NEW_WORKOUT_FORMAT = `Workout format:
- workoutName and workoutType ("running" | "strength_training" | "cycling" | "cardio" | "swimming" | "other") are required; description is optional. No workoutId, scheduledDate or sendToDevice: it is always a new workout, and schedule_workout puts it on a day.
${STEP_FORMAT}
- At least one step is needed (a distance-only run is one step with endCondition "distance").`;

// ─── Plan data helpers ──────────────────────────────────────────────────────

export interface WorkoutsFile {
  /** The workouts array (live reference into `data`). */
  workouts: any[];
  /** True for { ..., workouts: [] } plan files, false for bare arrays. */
  isPlan: boolean;
}

export function extractWorkouts(data: unknown): WorkoutsFile {
  if (Array.isArray(data)) return { workouts: data, isPlan: false };
  if (data && typeof data === "object" && Array.isArray((data as any).workouts)) {
    return { workouts: (data as any).workouts, isPlan: true };
  }
  throw new Error(
    'Expected a JSON array of workouts or a plan object with a "workouts" array.'
  );
}

function looksLikeWorkoutsFile(data: unknown): boolean {
  return (
    Array.isArray(data) ||
    (!!data && typeof data === "object" && Array.isArray((data as any).workouts))
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface WorkoutRow {
  name: string;
  workoutId?: number | string;
  type?: string;
  stepCount: number;
  scheduledDate?: string | string[];
  kind: "structured" | "simple-running";
}

export interface PlanValidation {
  valid: boolean;
  format: "plan" | "array";
  workoutCount: number;
  errors: string[];
  warnings: string[];
  workouts: WorkoutRow[];
}

export function isSimpleRunning(w: any): boolean {
  return (
    w.workoutType === "running" &&
    !!w.distanceMeters &&
    (!Array.isArray(w.steps) || w.steps.length === 0)
  );
}

/** Pure validation (no Garmin calls) using the editor's upload validators. */
export function validatePlanData(data: unknown): PlanValidation {
  const editor = getValidatorEditor();
  const { workouts, isPlan } = extractWorkouts(data);
  const errors: string[] = [];
  const warnings: string[] = [];
  const rows: WorkoutRow[] = [];

  if (isPlan) {
    try {
      editor.validateWorkoutPlan(data as any);
    } catch (error) {
      errors.push(messageOf(error));
    }
  }

  workouts.forEach((w, i) => {
    if (!w || typeof w !== "object") {
      errors.push(`Workout ${i + 1}: not an object`);
      return;
    }
    const label = `Workout ${i + 1}${w.workoutName ? ` ("${w.workoutName}")` : ""}`;
    const simple = isSimpleRunning(w);

    if (!simple) {
      try {
        editor.validateWorkout(w);
      } catch (error) {
        errors.push(`${label}: ${messageOf(error)}`);
      }
    }

    const dates: unknown[] =
      w.scheduledDate === undefined
        ? []
        : Array.isArray(w.scheduledDate)
          ? w.scheduledDate
          : [w.scheduledDate];
    for (const d of dates) {
      if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(new Date(d).getTime())) {
        warnings.push(`${label}: scheduledDate ${JSON.stringify(d)} is not a valid YYYY-MM-DD date and will be skipped when scheduling.`);
      }
    }

    rows.push({
      name: w.workoutName,
      workoutId: w.workoutId,
      type: w.workoutType,
      stepCount: Array.isArray(w.steps) ? w.steps.length : 0,
      scheduledDate: w.scheduledDate,
      kind: simple ? "simple-running" : "structured",
    });
  });

  return {
    valid: errors.length === 0,
    format: isPlan ? "plan" : "array",
    workoutCount: workouts.length,
    errors,
    warnings,
    workouts: rows,
  };
}

/**
 * How a plan's workout differs from the copy fetched from Garmin (empty = up to date).
 * Pure: the plan side is converted to Garmin's format and back first, so the
 * comparison only sees what Garmin would actually store.
 */
export function diffPlanWorkout(plan: any, garmin: DetailedWorkout): string[] {
  const canonical = getValidatorEditor().toGarminCanonical(plan);
  return compareWorkouts(canonical, garmin, { ignoreSteps: isSimpleRunning(plan) });
}

// ─── Tools ──────────────────────────────────────────────────────────────────

interface FileEntry {
  path: string;
  sizeBytes: number;
  modified: string;
  [summary: string]: unknown;
}

const MAX_SUMMARY_BYTES = 20 * 1024 * 1024;
const NOTES_PREVIEW_CHARS = 300;

/** Cheap description of a document's content so callers can pick one without reading each. */
function summarizeJsonText(text: string, sizeBytes: number): Record<string, unknown> {
  if (sizeBytes > MAX_SUMMARY_BYTES) return { summaryError: "file too large to summarize" };
  try {
    const data: unknown = JSON.parse(text);
    if (Array.isArray(data)) return { kind: "array", itemCount: data.length };
    if (data === null || typeof data !== "object") return { kind: typeof data };
    const obj = data as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    if (Array.isArray(obj.workouts)) {
      const workouts = obj.workouts as Array<Record<string, unknown>>;
      const dates = workouts
        .flatMap((w) => (Array.isArray(w.scheduledDate) ? w.scheduledDate : [w.scheduledDate]))
        .filter((d): d is string => typeof d === "string")
        .sort();
      const types: Record<string, number> = {};
      for (const w of workouts) {
        const t = typeof w.workoutType === "string" ? w.workoutType : "unknown";
        types[t] = (types[t] ?? 0) + 1;
      }
      summary.kind = "workout-plan";
      for (const k of ["generatedAt", "weekStart", "weekEnd", "source"]) {
        if (obj[k] !== undefined) summary[k] = obj[k];
      }
      if (typeof obj.notes === "string") {
        summary.notes =
          obj.notes.length > NOTES_PREVIEW_CHARS ? `${obj.notes.slice(0, NOTES_PREVIEW_CHARS)}…` : obj.notes;
      }
      summary.workoutCount = workouts.length;
      summary.workoutTypes = types;
      summary.uploadedCount = workouts.filter((w) => w.workoutId !== undefined).length;
      summary.scheduledCount = dates.length;
      if (dates.length) summary.scheduledRange = [dates[0], dates[dates.length - 1]];
      summary.workoutNames = workouts.map((w) => w.workoutName).filter((n) => typeof n === "string");
    } else {
      summary.kind = "object";
      summary.keys = Object.keys(obj).slice(0, 30);
      const arrays: Record<string, number> = {};
      for (const [k, v] of Object.entries(obj)) if (Array.isArray(v)) arrays[k] = v.length;
      if (Object.keys(arrays).length) summary.arrayLengths = arrays;
    }
    return summary;
  } catch (err) {
    return { summaryError: `not valid JSON: ${(err as Error).message}` };
  }
}

function listDocuments(prefix: string): FileEntry[] {
  const store = getStore();
  return store.list(prefix).map((meta) => ({
    path: meta.path,
    sizeBytes: meta.size,
    modified: new Date(meta.updatedAt).toISOString(),
    ...(meta.owner && !meta.path.startsWith("data/") ? { owner: meta.owner } : {}),
    ...summarizeJsonText(store.get(meta.path)?.text ?? "", meta.size),
  }));
}

export function registerPlanTools(server: McpServer): void {
  server.registerTool(
    "list_plans",
    {
      title: "List plans",
      description:
        "List the stored plans and data the other plan tools can reach: workout plans under workout-plans/ and per-profile data under data/<profile>/ (workouts.json, training-plan.json, ...; activities are not documents, get_activities reads them). Each entry includes metadata about its content (for plans: dates, source, notes preview, workout count/types/names, uploaded and scheduled counts).",
      inputSchema: {
        profile: z.string().optional().describe("Only list data/<profile>/. Omit to list every profile."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ profile }) =>
      runTool(async () => {
        if (profile !== undefined && !PROFILE_NAME_REGEX.test(profile)) {
          throw new Error(`Invalid profile name "${profile}".`);
        }
        return {
          "workout-plans": listDocuments("workout-plans/"),
          data: listDocuments(profile ? `data/${profile}/` : "data/"),
        };
      })
  );

  server.registerTool(
    "read_plan",
    {
      title: "Read plan",
      description:
        'Read a plan or stored data, e.g. "workout-plans/workouts-full-body-maintenance.json" or "data/MED/training-plan.json", and return its parsed content.',
      inputSchema: {
        path: z.string().describe('Logical path starting with "workout-plans/" or "data/".'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ path: logicalPath }) =>
      runTool(async () => {
        const logical = checkedPath(logicalPath);
        return { path: logical, content: readJsonDoc(logical) };
      })
  );

  server.registerTool(
    "write_plan",
    {
      title: "Write plan",
      description:
        "Create or overwrite a plan with the given content. A new plan under workout-plans/ belongs to the profile (see list_profiles; optional when a default profile is configured or only one exists), and other profiles do not see it; an existing plan keeps its owner. Workout plans/arrays are validated afterwards; the plan is saved even if validation reports errors, so check `validation`. To change a single workout, prefer upsert_plan_workout. The version it replaces stays in the plan's history, so an overwrite can be undone from the web editor.\n\n" +
        WORKOUT_FORMAT,
      inputSchema: {
        path: z.string().describe('Logical path starting with "workout-plans/" or "data/", ending in .json.'),
        content: z
          .union([z.array(z.any()), z.record(z.string(), z.any())])
          .describe("The full JSON document: a plan object ({ generatedAt, weekStart, weekEnd, workouts }) or an array."),
        profile: z
          .string()
          .optional()
          .describe("Profile name that owns a new plan under workout-plans/ (see list_profiles). Optional when a default profile is configured or only one exists; ignored for a plan that exists and for data/<profile>/ paths."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ path: logicalPath, content, profile }) =>
      runTool(async () => {
        const logical = checkedPath(logicalPath);
        const existed = getStore().head(logical) !== undefined;
        // only a new plan needs an owner, so overwriting one never fails for want of a profile
        const owner = !existed && logical.startsWith("workout-plans/") ? dataProfile(profile) : null;
        writeJsonDoc(logical, content, "mcp", owner);
        return {
          path: logical,
          overwritten: existed,
          ...(owner ? { owner } : {}),
          validation: looksLikeWorkoutsFile(content) ? validatePlanData(content) : undefined,
        };
      })
  );

  server.registerTool(
    "upsert_plan_workout",
    {
      title: "Add or replace a workout in a plan",
      description:
        "Replace one workout in a plan (matched by matchName, else by workoutId, else by workoutName) or append it if there is no match. The rest of the plan is untouched. The workout is validated first and nothing is written if validation fails.\n\n" +
        WORKOUT_FORMAT,
      inputSchema: {
        path: z.string().describe('Existing plan, e.g. "workout-plans/workouts-full-body-maintenance.json".'),
        workout: plannedWorkoutSchema,
        matchName: z.string().optional().describe("Name of the existing workout to replace; use it when renaming."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ path: logicalPath, workout, matchName }) =>
      runTool(async () => {
        const logical = checkedPath(logicalPath);
        extractWorkouts(readJsonDoc(logical)); // is it a plan at all? (a clear error before anything is validated)

        if (!isSimpleRunning(workout)) {
          try {
            getValidatorEditor().validateWorkout(workout as any);
          } catch (error) {
            throw new Error(`Workout not saved: ${messageOf(error)}`);
          }
        }

        let result: { action: "replaced" | "appended"; index: number; workoutCount: number } | undefined;
        updateJsonDoc(logical, (data) => {
          const { workouts } = extractWorkouts(data);
          const index = workouts.findIndex((w) =>
            matchName !== undefined
              ? w?.workoutName === matchName
              : (workout.workoutId !== undefined && String(w?.workoutId) === String(workout.workoutId)) ||
                w?.workoutName === workout.workoutName
          );

          if (index >= 0) workouts[index] = workout;
          else workouts.push(workout);
          result = { action: index >= 0 ? "replaced" : "appended", index: index >= 0 ? index : workouts.length - 1, workoutCount: workouts.length };
        });
        return { path: logical, ...result! };
      })
  );

  server.registerTool(
    "validate_plan",
    {
      title: "Validate plan",
      description:
        "Validate a workout plan with the same checks used before upload (step fields, exercise names, repeat/rest fields, dates). No Garmin calls. Returns errors, warnings and a per-workout summary (workoutId, steps, scheduledDate). Distance-only running workouts without steps are accepted (kind \"simple-running\").",
      inputSchema: {
        path: z.string().describe('Logical path starting with "workout-plans/" or "data/".'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ path: logicalPath }) =>
      runTool(async () => {
        const logical = checkedPath(logicalPath);
        return { path: logical, ...validatePlanData(readJsonDoc(logical)) };
      })
  );

  server.registerTool(
    "list_exercise_names",
    {
      title: "Look up Garmin exercise names",
      description:
        'Search the Garmin exercise list used to validate strength steps. exerciseName in a step must be one of these keys (or text that normalizes to one, e.g. "Barbell Bench Press" -> BARBELL_BENCH_PRESS). Every word in `query` must appear in the key.',
      inputSchema: {
        query: z.string().optional().describe('Words to search for, e.g. "romanian deadlift".'),
        category: z.string().optional().describe('Garmin category to filter by, e.g. "SQUAT" or "CORE".'),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, category, limit }) =>
      runTool(async () => {
        const tokens = (query ?? "")
          .toUpperCase()
          .split(/[^A-Z0-9]+/)
          .filter(Boolean);
        const wantedCategory = category?.trim().toUpperCase();

        const matches = Object.entries(EXERCISES)
          .filter(
            ([key, cat]) =>
              tokens.every((t) => key.includes(t)) && (!wantedCategory || cat === wantedCategory)
          )
          .sort((a, b) => a[0].length - b[0].length || a[0].localeCompare(b[0]));

        return {
          totalMatches: matches.length,
          returned: Math.min(matches.length, limit),
          exercises: matches.slice(0, limit).map(([name, cat]) => ({ name, category: cat })),
        };
      })
  );
}
