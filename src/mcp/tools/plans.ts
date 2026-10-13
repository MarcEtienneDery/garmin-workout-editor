import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import exerciseCategoryMap from "../../exercise-category-map.json";
import {
  VALID_END_CONDITIONS,
  VALID_STEP_TYPES,
  VALID_TARGET_TYPES,
} from "../../workoutEditor";
import { getDataRoot } from "../../shared/profileLoader";
import {
  getPlansDir,
  getValidatorEditor,
  readJsonFile,
  resolveDataPath,
  runTool,
  writeJsonAtomic,
} from "../context";

const EXERCISES = exerciseCategoryMap as Record<string, string>;
const PROFILE_DIR_REGEX = /^[a-zA-Z0-9_-]+$/;

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

export const WORKOUT_FORMAT = `Workout format:
- workoutName (required); workoutType: "running" | "strength_training" | "cycling" | "cardio" | "swimming" | "other"; description; workoutId (assigned by Garmin on upload — keep it so a re-upload replaces the old workout); scheduledDate ("YYYY-MM-DD" or an array of them); sendToDevice (bool); distanceMeters (running workouts with no steps).
- steps is a flat list. Each step needs stepType, targetType and endCondition (except stepType "rest"), and endConditionValue > 0. Use endCondition "lap.button" with endConditionValue 0 for open-ended steps the athlete ends on the watch.
- Mirror endConditionValue in the matching field, and keep them equal: reps -> reps, time -> durationSeconds (seconds), distance -> distanceMeters (meters).
- Repeats: give consecutive steps the same repeatGroupIndex and numberOfRepeats. restTimeSeconds on a step adds a rest after it.
- Strength steps: exerciseName must be a Garmin exercise (look it up with list_exercise_names); weight is in lbs; weightPercentage (percent of 1RM) also needs benchmarkKey.
- Targets: heart.rate.zone -> targetValueOne/Two are bpm (min/max); pace.zone -> m/s (slower limit first); no.target needs no values.`;

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

function isSimpleRunning(w: any): boolean {
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

// ─── Tools ──────────────────────────────────────────────────────────────────

interface FileEntry {
  path: string;
  sizeBytes: number;
  modified: string;
  [summary: string]: unknown;
}

const MAX_SUMMARY_BYTES = 20 * 1024 * 1024;
const NOTES_PREVIEW_CHARS = 300;

/** Cheap description of a JSON file's content so callers can pick a file without reading each one. */
function summarizeJsonFile(fullPath: string, sizeBytes: number): Record<string, unknown> {
  if (sizeBytes > MAX_SUMMARY_BYTES) return { summaryError: "file too large to summarize" };
  try {
    const data: unknown = JSON.parse(fs.readFileSync(fullPath, "utf8"));
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

function listJsonFiles(dir: string, logicalPrefix: string): FileEntry[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith("."))
    .map((e) => {
      const stat = fs.statSync(path.join(dir, e.name));
      return {
        path: `${logicalPrefix}/${e.name}`,
        sizeBytes: stat.size,
        modified: stat.mtime.toISOString(),
        ...summarizeJsonFile(path.join(dir, e.name), stat.size),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function registerPlanTools(server: McpServer): void {
  server.registerTool(
    "list_plans",
    {
      title: "List plans",
      description:
        "List the stored plans and data the other plan tools can reach: editable plan drafts (a plan = a JSON file of planned workouts) under workout-plans/ and per-profile data under data/<profile>/ (activities.json, workouts.json, training-plan.json, ...). Each entry includes metadata about its content (for plans: dates, source, notes preview, workout count/types/names, uploaded and scheduled counts).",
      inputSchema: {
        profile: z.string().optional().describe("Only list data/<profile>/. Omit to list every profile."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ profile }) =>
      runTool(async () => {
        if (profile !== undefined && !PROFILE_DIR_REGEX.test(profile)) {
          throw new Error(`Invalid profile name "${profile}".`);
        }
        const dataRoot = getDataRoot();
        const dataDirs = profile
          ? [profile]
          : fs.existsSync(dataRoot)
            ? fs
                .readdirSync(dataRoot, { withFileTypes: true })
                .filter((e) => e.isDirectory() && !e.name.startsWith("."))
                .map((e) => e.name)
                .sort()
            : [];

        return {
          "workout-plans": listJsonFiles(getPlansDir(), "workout-plans"),
          data: dataDirs.flatMap((d) => listJsonFiles(path.join(dataRoot, d), `data/${d}`)),
        };
      })
  );

  server.registerTool(
    "read_plan",
    {
      title: "Read plan",
      description:
        'Read a plan or stored data (local files only; nothing is fetched from Garmin). data/<profile>/training-plan.json holds long-term goals and phase (context, never uploaded); data/<profile>/activities.json is completed history; data/<profile>/workouts.json is a snapshot of the Garmin library. E.g. "workout-plans/workouts-full-body-maintenance.json" or "data/MED/training-plan.json", and return its parsed content.',
      inputSchema: {
        path: z.string().describe('Logical path starting with "workout-plans/" or "data/".'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ path: logicalPath }) =>
      runTool(async () => {
        const content = readJsonFile(resolveDataPath(logicalPath), logicalPath);
        return { path: logicalPath, content };
      })
  );

  server.registerTool(
    "write_plan",
    {
      title: "Write plan",
      description:
        "Create or overwrite a local plan file with the given content (nothing reaches Garmin until an upload tool runs). Workout plans/arrays are validated afterwards; the plan is saved even if validation reports errors, so check `validation`. To change a single workout, prefer upsert_plan_workout.\n\n" +
        WORKOUT_FORMAT,
      inputSchema: {
        path: z.string().describe('Logical path starting with "workout-plans/" or "data/", ending in .json.'),
        content: z
          .union([z.array(z.any()), z.record(z.string(), z.any())])
          .describe("The full JSON document: a plan object ({ generatedAt, weekStart, weekEnd, workouts }) or an array."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ path: logicalPath, content }) =>
      runTool(async () => {
        const absolute = resolveDataPath(logicalPath);
        const existed = fs.existsSync(absolute);
        writeJsonAtomic(absolute, content);
        return {
          path: logicalPath,
          overwritten: existed,
          validation: looksLikeWorkoutsFile(content) ? validatePlanData(content) : undefined,
        };
      })
  );

  server.registerTool(
    "upsert_plan_workout",
    {
      title: "Add or replace a workout in a plan",
      description:
        "Replace one workout in a local plan file (nothing reaches Garmin until an upload tool runs; matched by matchName, else by workoutId, else by workoutName) or append it if there is no match. The rest of the plan is untouched. The workout is validated first and nothing is written if validation fails.\n\n" +
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
        const absolute = resolveDataPath(logicalPath);
        const data = readJsonFile(absolute, logicalPath);
        const { workouts } = extractWorkouts(data);

        if (!isSimpleRunning(workout)) {
          try {
            getValidatorEditor().validateWorkout(workout as any);
          } catch (error) {
            throw new Error(`Workout not saved: ${messageOf(error)}`);
          }
        }

        const index = workouts.findIndex((w) =>
          matchName !== undefined
            ? w?.workoutName === matchName
            : (workout.workoutId !== undefined && String(w?.workoutId) === String(workout.workoutId)) ||
              w?.workoutName === workout.workoutName
        );

        if (index >= 0) workouts[index] = workout;
        else workouts.push(workout);

        writeJsonAtomic(absolute, data);
        return {
          path: logicalPath,
          action: index >= 0 ? "replaced" : "appended",
          index: index >= 0 ? index : workouts.length - 1,
          workoutCount: workouts.length,
        };
      })
  );

  server.registerTool(
    "validate_plan",
    {
      title: "Validate plan",
      description:
        "Validate a local workout plan file with the same checks used before upload (step fields, exercise names, repeat/rest fields, dates). No Garmin calls. Returns errors, warnings and a per-workout summary (workoutId, steps, scheduledDate). Distance-only running workouts without steps are accepted (kind \"simple-running\").",
      inputSchema: {
        path: z.string().describe('Logical path starting with "workout-plans/" or "data/".'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ path: logicalPath }) =>
      runTool(async () => {
        const data = readJsonFile(resolveDataPath(logicalPath), logicalPath);
        return { path: logicalPath, ...validatePlanData(data) };
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
