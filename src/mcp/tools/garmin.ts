import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAvailableProfiles } from "../../shared/profileLoader";
import { getStore } from "../../shared/store";
import {
  assertLive,
  getSession,
  getSettings,
  getValidatorEditor,
  logicalPath as checkedPath,
  readJsonDoc,
  requireAuth,
  runTool,
  writeJsonDoc,
} from "../context";
import type { DetailedWorkout } from "../../shared/types";
import type { SyncStatus } from "../../shared/workoutSync";
import { getActivities } from "./activities";
import { NEW_WORKOUT_FORMAT, type NewWorkout, diffPlanWorkout, extractWorkouts, newWorkoutSchema } from "./plans";

export const profileArg = z
  .string()
  .optional()
  .describe("Garmin profile name (see list_profiles). Optional when a default profile is configured or only one exists.");

const planPath = z
  .string()
  .describe('Logical path starting with "workout-plans/" or "data/", e.g. "workout-plans/workouts-full-body-maintenance.json".');

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const READ_GARMIN = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE_GARMIN = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

function sameId(a: unknown, b: unknown): boolean {
  return a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
}

function storedText(logical: string): string {
  const doc = getStore().get(logical);
  if (!doc) throw new Error(`File not found: ${logical}`);
  return doc.text;
}

// ── Garmin write/read actions, shared by the MCP tools and the web editor ───
// Callers wrap these in runTool / runCaptured to serialize and capture logs.

export async function listDevices(profile?: string) {
  const session = getSession(profile);
  if (session.mock) return { devices: [], note: "Mock mode: no devices." };
  await requireAuth(session);
  const devices = await session.garminClient.getDevices();
  return {
    devices: (devices ?? []).map((d: any) => ({
      deviceId: d.deviceId,
      displayName: d.displayName,
      deviceTypePk: d.deviceTypePk,
    })),
  };
}

export async function uploadPlan(profile: string | undefined, logicalPath: string, dryRun = false) {
  const session = getSession(profile);
  if (!dryRun) assertLive(session, "upload_workouts");
  const logical = checkedPath(logicalPath);
  const doc = getStore().get(logical);
  if (!doc) throw new Error(`File not found: ${logical}`);
  const result = await session.editor.uploadWorkoutsFromText(doc.text, dryRun, (updated) => getStore().put(logical, updated, { source: "mcp" }), logical);
  return {
    path: logical,
    dryRun,
    status: result.failed === 0 ? "ok" : result.successful === 0 ? "failed" : "partial",
    ...result,
    note: dryRun ? "Validation only; nothing was uploaded." : "New workoutIds were written back to the plan.",
  };
}

export async function schedulePlan(profile: string | undefined, logicalPath: string) {
  const session = getSession(profile);
  assertLive(session, "schedule_plan");
  const logical = checkedPath(logicalPath);
  const plan = session.editor.parseWorkoutPlan(storedText(logical));

  const attempted = plan.workouts.flatMap((w) =>
    [w.scheduledDate ?? []].flat().map((date) => ({
      workoutName: w.workoutName,
      workoutId: w.workoutId,
      date,
    }))
  );
  await session.editor.scheduleWorkoutPlan(plan);
  return {
    path: logical,
    attempted,
    note: "These were attempted; the log lists which were scheduled, skipped or failed.",
  };
}

export async function uploadAndSchedulePlan(profile: string | undefined, logicalPath: string) {
  const session = getSession(profile);
  assertLive(session, "upload_and_schedule_plan");

  const logical = checkedPath(logicalPath);
  const plan = session.editor.parseWorkoutPlan(storedText(logical));
  const before = plan.workouts.map((w) => w.workoutId);

  let changed = false;
  try {
    await session.editor.uploadAndScheduleWorkoutPlan(plan);
  } finally {
    // Persist new ids even if a later step threw, so the next run replaces
    // the right workouts instead of creating duplicates.
    changed = plan.workouts.some((w, i) => String(w.workoutId) !== String(before[i]));
    if (changed) writeJsonDoc(logical, plan);
  }

  return {
    path: logical,
    writtenBack: changed,
    workouts: plan.workouts.map((w, i) => ({
      workoutName: w.workoutName,
      workoutId: w.workoutId,
      uploaded: String(w.workoutId) !== String(before[i]),
      scheduledDate: w.scheduledDate,
    })),
    note: "uploaded=false means the workout was not (re)created; see the log.",
  };
}

export async function sendPlanToDevice(profile: string | undefined, logicalPath: string, deviceId?: number) {
  const session = getSession(profile);
  assertLive(session, "send_to_device");

  const data = readJsonDoc(checkedPath(logicalPath));
  const { workouts } = extractWorkouts(data);
  if (workouts.length === 0) throw new Error("No workouts found in file.");

  const flagged = workouts.filter((w) => w?.sendToDevice);
  const toSend = flagged.length > 0 ? flagged : workouts;

  await session.editor.sendWorkoutsToDevice(
    toSend.map((w) => ({ workoutId: Number(w.workoutId), workoutName: w.workoutName })),
    deviceId
  );
  return {
    path: logicalPath,
    usedSendToDeviceFlag: flagged.length > 0,
    requested: toSend.map((w) => w.workoutName),
    note: "Workouts without a workoutId are skipped; see the log.",
  };
}

// ── Workout library: view, check against plans, save, delete ───────────────
// Used by the web editor's Workouts view and the plan view's "up to date on Garmin" badges.

export interface LibraryWorkout {
  workoutId: number | string;
  workoutName: string;
  workoutType?: string;
  description?: string;
  updatedDate?: string;
}

/** Garmin returns at most this many workouts per listing (see WorkoutEditor.fetchWorkoutsWithRaw). */
export const LIBRARY_LIMIT = 100;
const LIBRARY_TTL_MS = 60_000;

// The library is listed once per minute at most and a workout's steps are re-fetched only when
// its updatedDate changes, so re-checking a plan after every edit costs no extra Garmin calls.
const libraryCache = new Map<string, { at: number; list: LibraryWorkout[] }>();
const detailCache = new Map<string, { updatedDate: string; workout: DetailedWorkout }>();

/** Forget everything fetched for a profile. */
export function invalidateLibrary(profile: string): void {
  libraryCache.delete(profile);
  for (const key of detailCache.keys()) if (key.startsWith(`${profile}:`)) detailCache.delete(key);
}

/**
 * After a change to the library: list it again next time, and forget the steps of the workouts that were replaced or removed.
 * The steps of the others stay: each is stored with the updatedDate it was fetched at, so one that changed misses by itself,
 * and fetching them all again costs a Garmin request per workout of every plan.
 */
function forgetListing(profile: string, ...gone: (number | string | undefined)[]): void {
  libraryCache.delete(profile);
  for (const id of gone) if (id !== undefined) detailCache.delete(`${profile}:${id}`);
}

export async function listLibraryWorkouts(profile: string | undefined, refresh = false): Promise<LibraryWorkout[]> {
  const session = getSession(profile);
  const cached = libraryCache.get(session.profile.name);
  if (!refresh && cached && Date.now() - cached.at < LIBRARY_TTL_MS) return cached.list;
  const list = await session.editor.listWorkoutSummaries();
  libraryCache.set(session.profile.name, { at: Date.now(), list });
  return list;
}

/** One workout from Garmin in the plan format, always fresh; null when Garmin has no such workout. */
export async function getLibraryWorkout(profile: string | undefined, workoutId: number | string): Promise<DetailedWorkout | null> {
  const session = getSession(profile);
  await requireAuth(session);
  const detail = await session.editor.fetchWorkoutDetails(workoutId);
  return detail ? session.editor.fromGarminDetail(detail) : null;
}

/**
 * For each workout of a plan: is the copy on Garmin up to date? Workouts without a
 * workoutId are "not-uploaded"; ids Garmin does not know are "missing".
 */
export async function checkWorkoutSync(profile: string | undefined, workouts: unknown[], refresh = false): Promise<SyncStatus[]> {
  const session = getSession(profile);
  const library = await listLibraryWorkouts(profile, refresh);
  const known = new Map(library.map((w) => [String(w.workoutId), w]));

  const statuses: SyncStatus[] = [];
  for (const [index, w] of workouts.entries()) {
    const planned = w as any;
    if (!planned || typeof planned !== "object" || Array.isArray(planned)) {
      statuses.push({ index, state: "error", differences: ["Not a workout object"] });
      continue;
    }
    if (planned.workoutId === undefined || planned.workoutId === null || planned.workoutId === "") {
      statuses.push({ index, state: "not-uploaded", differences: [] });
      continue;
    }

    const id = String(planned.workoutId);
    const summary = known.get(id);
    const key = `${session.profile.name}:${id}`;
    let garmin: DetailedWorkout | null | undefined;
    const hit = detailCache.get(key);
    if (summary?.updatedDate && hit?.updatedDate === summary.updatedDate) {
      garmin = hit.workout;
    } else {
      const detail = await session.editor.fetchWorkoutDetails(id);
      garmin = detail ? session.editor.fromGarminDetail(detail) : null;
      if (garmin && summary?.updatedDate) detailCache.set(key, { updatedDate: summary.updatedDate, workout: garmin });
    }
    if (!garmin) {
      statuses.push(
        summary
          ? { index, state: "error", differences: ["Could not read the workout from Garmin"] }
          : { index, state: "missing", differences: [] }
      );
      continue;
    }

    try {
      const differences = diffPlanWorkout(planned, garmin);
      statuses.push({ index, state: differences.length ? "modified" : "synced", differences });
    } catch (error) {
      statuses.push({ index, state: "error", differences: [error instanceof Error ? error.message : String(error)] });
    }
  }
  return statuses;
}

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Create or replace ONE workout on Garmin (a workout that has a workoutId is deleted and recreated,
 * so the id changes). `schedule` re-adds its upcoming scheduledDate entries to the calendar, since the
 * old ones belonged to the old workout. Returns the new id.
 */
export async function saveWorkout(
  profile: string | undefined,
  workout: Record<string, any>,
  schedule = false
): Promise<{ workoutId: number | string; previousWorkoutId?: number | string }> {
  const session = getSession(profile);
  assertLive(session, "save_workout");

  const copy = structuredClone(workout);
  const previousWorkoutId = copy.workoutId ?? undefined;
  const dates = [copy.scheduledDate ?? []].flat().filter((d: string) => d >= today());
  if (schedule && dates.length) copy.scheduledDate = dates;
  else delete copy.scheduledDate;

  try {
    await session.editor.uploadAndScheduleWorkoutPlan({
      generatedAt: new Date().toISOString(),
      weekStart: today(),
      weekEnd: today(),
      workouts: [copy as any],
    });
  } finally {
    forgetListing(session.profile.name, previousWorkoutId);
  }
  if (copy.workoutId === undefined || String(copy.workoutId) === String(previousWorkoutId)) {
    throw new Error("Garmin did not accept the workout (see log).");
  }
  return { workoutId: copy.workoutId, previousWorkoutId };
}

export async function deleteLibraryWorkout(profile: string | undefined, workoutId: number | string): Promise<void> {
  const session = getSession(profile);
  assertLive(session, "delete_workout");
  const name = session.profile.name;
  try {
    await session.editor.deleteWorkout(workoutId);
  } catch (error) {
    forgetListing(name, workoutId); // it may be gone already (a 404): look again
    throw error;
  }
  // Garmin confirmed it: take it out of the listing we hold instead of listing the whole library again. A full
  // listing is the exception, since an older workout may now make it into the newest LIBRARY_LIMIT.
  const cached = libraryCache.get(name);
  if (cached && cached.list.length < LIBRARY_LIMIT) {
    libraryCache.set(name, { at: cached.at, list: cached.list.filter((w) => !sameId(w.workoutId, workoutId)) });
    detailCache.delete(`${name}:${workoutId}`);
  } else {
    forgetListing(name, workoutId);
  }
}

// ── One workout and no plan: make it, then put it on a day ──────────────────

/**
 * Create ONE new workout in the Garmin library from the workout itself: no plan file is read or written. It always makes a new
 * workout and never replaces one (saveWorkout replaces, for the web editor), and it schedules nothing (scheduleWorkout does).
 * `dryRun` only checks the workout, so it needs no Garmin login and works in mock mode.
 */
export async function createWorkout(
  profile: string | undefined,
  workout: NewWorkout,
  dryRun = false
): Promise<{ workoutName: string; workoutType: string; stepCount: number; note: string; workoutId?: number; dryRun?: true; valid?: true }> {
  // Only these four fields go on, so a workoutId can never get through to make the upload delete a workout.
  const fresh = { workoutName: workout.workoutName, workoutType: workout.workoutType, description: workout.description, steps: workout.steps };
  try {
    getValidatorEditor().validateWorkout(fresh as any);
  } catch (error) {
    throw new Error(`Workout not created: ${error instanceof Error ? error.message : String(error)}`);
  }

  const summary = { workoutName: fresh.workoutName, workoutType: fresh.workoutType, stepCount: fresh.steps.length };
  if (dryRun) return { ...summary, dryRun: true, valid: true, note: "Validation only; nothing was sent to Garmin." };

  const session = getSession(profile);
  assertLive(session, "create_workout");
  const workoutId = await session.editor.uploadWorkout(fresh as any);
  if (workoutId === null) throw new Error("Garmin did not accept the workout (see log).");
  forgetListing(session.profile.name);
  return { ...summary, workoutId, note: "Created in the Garmin library and not scheduled: schedule_workout puts it on a day." };
}

/** A day as YYYY-MM-DD that exists: new Date("2026-02-30") quietly becomes March 2, so the date it makes must read back the same. */
function calendarDay(value: string): string {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error(`"${value}" is not a day (use YYYY-MM-DD).`);
  return value;
}

/** The id of a workout in the Garmin library as whole digits: the Garmin client turns it into a number for the URL, so anything else would ask Garmin for workout NaN. */
function libraryWorkoutId(value: number | string): string {
  const text = String(value).trim();
  const id = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(id) || id === 0) {
    throw new Error(`workoutId must be the number of a workout in the Garmin library (list_workouts shows them), not ${JSON.stringify(value)}.`);
  }
  return String(id);
}

/**
 * Put a workout of the Garmin library on one day of the calendar, no plan file involved. Any workout will do: one create_workout
 * made, one a plan uploaded, one made in the Garmin app. A workout Garmin does not have is an error, where schedulePlan skips it
 * and goes on. It does not look at what is on the calendar already.
 */
export async function scheduleWorkout(profile: string | undefined, workoutId: number | string, date: string) {
  const id = libraryWorkoutId(workoutId);
  const day = calendarDay(date);

  const session = getSession(profile);
  assertLive(session, "schedule_workout");
  const { workoutName } = await session.editor.scheduleWorkout(id, day);
  return { workoutId: Number(id), workoutName, date: day };
}

export function registerGarminTools(server: McpServer): void {
  // ── Reads ─────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_profiles",
    {
      title: "List Garmin profiles",
      description:
        "List the configured Garmin profiles (one per account), the default profile, and whether the server runs in mock mode (mock data, Garmin writes disabled).",
      annotations: { readOnlyHint: true },
    },
    () =>
      runTool(async () => ({
        mock: getSettings().mock,
        defaultProfile: getSettings().defaultProfile ?? null,
        profiles: getAvailableProfiles(),
      }))
  );

  server.registerTool(
    "get_activities",
    {
      title: "Get Garmin activities",
      description:
        "Activities for a period in the slim planning format (duration, HR, training effect, RPE/feel, running laps, strength sets with weights in lbs), newest first, read from the database. Garmin is asked only for what is new since the last call and for the details of the activities returned that lack them; the full history and every activity's details fill in the background, so a first call on a profile returns what is stored so far (see `sync`). `limit` caps how many are returned (`total` and `truncated` say if more matched). A run\'s `exerciseSets` are its laps as the watch recorded them, in order (`distance` km, `duration` s, `pace` min/km, `avgHR`, `maxHR`), each with its `splitType` (WARMUP, ACTIVE, RECOVERY, COOLDOWN, or INTERVAL for an unstructured run) and, for a structured workout, its `step`: laps that share a step are one rep, so the reps and the heart rate inside each can be compared.",
      inputSchema: {
        profile: profileArg,
        limit: z.number().int().min(1).max(200).default(30),
        period: z
          .enum(["last-week", "this-week", "last-4-weeks", "all"])
          .default("last-week")
          .describe("Monday-Sunday weeks in UTC. Ignored when weekStart is given."),
        weekStart: isoDate.optional().describe("Only activities on/after this date."),
        weekEnd: isoDate.optional().describe("Only activities on/before this date."),
        type: z.enum(["running", "strength_training", "cycling", "swimming", "other"]).optional(),
        includeDetails: z
          .boolean()
          .default(true)
          .describe("Fetch the details (self evaluation, exercise sets) of the returned activities that are not stored yet, up to 30 per call, about 1 second each."),
      },
      annotations: READ_GARMIN,
    },
    (args) => runTool(() => getActivities(args))
  );

  server.registerTool(
    "list_workouts",
    {
      title: "List Garmin workouts",
      description:
        "List workouts in the Garmin Connect workout library (id, name, type, description; the first 100). Fast. Use get_workout for a workout's steps.",
      inputSchema: { profile: profileArg },
      annotations: READ_GARMIN,
    },
    ({ profile }) =>
      runTool(
        async () => {
          const session = getSession(profile);
          const workouts = await session.editor.fetchWorkouts(false);
          return {
            count: workouts.length,
            workouts: workouts.map((w) => ({
              workoutId: w.workoutId,
              workoutName: w.workoutName,
              workoutType: w.workoutType,
              description: w.description,
            })),
          };
        },
        { serialize: true }
      )
  );

  server.registerTool(
    "get_workout",
    {
      title: "Get one Garmin workout",
      description:
        "Fetch a single workout from Garmin by id, transformed to the plan format (flat steps with repeat groups, rest folded into the previous step, weights in lbs).",
      inputSchema: {
        profile: profileArg,
        workoutId: z.union([z.number(), z.string()]),
      },
      annotations: READ_GARMIN,
    },
    ({ profile, workoutId }) =>
      runTool(
        async () => {
          const session = getSession(profile);
          const workout = await session.editor.fetchWorkout(workoutId);
          if (!workout) throw new Error(`Workout ${workoutId} not found.`);
          return workout;
        },
        { serialize: true }
      )
  );

  server.registerTool(
    "export_workouts",
    {
      title: "Export all Garmin workouts",
      description:
        "Fetch every workout (up to 100) with full step details and save them as stored data (default data/<profile>/workouts.json). Returns the path and count, not the contents; read it with read_plan. Slow: about 0.5 s per workout.",
      inputSchema: {
        profile: profileArg,
        outputPath: z.string().optional().describe('Logical .json path under "data/" or "workout-plans/".'),
      },
      annotations: READ_GARMIN,
    },
    ({ profile, outputPath }) =>
      runTool(
        async () => {
          const session = getSession(profile);
          const out = outputPath ? checkedPath(outputPath) : `data/${session.profile.name}/workouts.json`;
          const workouts = await session.editor.fetchWorkouts(true);
          writeJsonDoc(out, workouts);
          console.log(`✅ Workouts saved to ${out}`);
          return { savedTo: out, count: workouts.length };
        },
        { serialize: true }
      )
  );

  server.registerTool(
    "list_devices",
    {
      title: "List Garmin devices",
      description: "List the devices registered to the Garmin account (ids to use with send_to_device).",
      inputSchema: { profile: profileArg },
      annotations: READ_GARMIN,
    },
    ({ profile }) =>
      runTool(
        () => listDevices(profile),
        { serialize: true }
      )
  );

  // ── Writes (change the Garmin account) ────────────────────────────────────

  server.registerTool(
    "upload_workouts",
    {
      title: "Upload workouts to Garmin",
      description:
        "Upload every workout in a plan to Garmin Connect WITHOUT scheduling them. Each workout that already has a workoutId is deleted and recreated, and the new workoutIds are written back to the plan. Confirm with the user first. Use dryRun=true to validate only (nothing is sent).",
      inputSchema: {
        profile: profileArg,
        path: planPath,
        dryRun: z.boolean().default(false),
      },
      annotations: WRITE_GARMIN,
    },
    ({ profile, path: logicalPath, dryRun }) =>
      runTool(
        () => uploadPlan(profile, logicalPath, dryRun),
        { serialize: true }
      )
  );

  server.registerTool(
    "upload_single_workout",
    {
      title: "Upload one workout to Garmin",
      description:
        "Upload a single workout from a plan (matched by workoutId or exact workoutName), without scheduling. An existing Garmin workout with that id is deleted and recreated, and the new workoutId is written back to the plan. Confirm with the user first.",
      inputSchema: {
        profile: profileArg,
        path: planPath,
        workoutId: z.union([z.number(), z.string()]).optional(),
        workoutName: z.string().optional(),
        dryRun: z.boolean().default(false),
      },
      annotations: WRITE_GARMIN,
    },
    ({ profile, path: logicalPath, workoutId, workoutName, dryRun }) =>
      runTool(
        async () => {
          if ((workoutId === undefined) === (workoutName === undefined)) {
            throw new Error("Provide exactly one of workoutId or workoutName.");
          }
          const session = getSession(profile);
          if (!dryRun) assertLive(session, "upload_single_workout");

          const logical = checkedPath(logicalPath);
          const data = readJsonDoc(logical);
          const { workouts } = extractWorkouts(data);

          const matches = workouts.filter((w) =>
            workoutId !== undefined ? sameId(w?.workoutId, workoutId) : w?.workoutName === workoutName
          );
          if (matches.length === 0) throw new Error(`No matching workout found in ${logical}.`);
          if (matches.length > 1) throw new Error(`${matches.length} workouts match; use workoutId to pick one.`);

          const workout = matches[0];
          const previousWorkoutId = workout.workoutId;
          const newId = await session.editor.uploadWorkout(workout, dryRun);
          if (newId === null) throw new Error("Upload failed (see log).");
          if (dryRun) return { path: logical, workoutName: workout.workoutName, dryRun: true, valid: true };

          workout.workoutId = newId;
          writeJsonDoc(logical, data);
          return { path: logical, workoutName: workout.workoutName, previousWorkoutId, workoutId: newId };
        },
        { serialize: true }
      )
  );

  server.registerTool(
    "schedule_plan",
    {
      title: "Schedule an uploaded plan on the Garmin calendar",
      description:
        "Schedule the workouts of a plan on the Garmin calendar using their scheduledDate and existing workoutId (nothing is uploaded; workouts without a workoutId are skipped, except distance-only runs which are created). Confirm with the user first. The log shows per-workout outcomes.",
      inputSchema: { profile: profileArg, path: planPath },
      annotations: WRITE_GARMIN,
    },
    ({ profile, path: logicalPath }) =>
      runTool(
        () => schedulePlan(profile, logicalPath),
        { serialize: true }
      )
  );

  server.registerTool(
    "upload_and_schedule_plan",
    {
      title: "Upload a plan to Garmin and schedule it",
      description:
        "Upload every workout in a plan (existing ones with a workoutId are deleted and recreated) and then schedule them on the Garmin calendar by scheduledDate. New workoutIds are written back to the plan file. Run validate_plan first and get the user's explicit confirmation before calling this.",
      inputSchema: { profile: profileArg, path: planPath },
      annotations: WRITE_GARMIN,
    },
    ({ profile, path: logicalPath }) =>
      runTool(
        () => uploadAndSchedulePlan(profile, logicalPath),
        { serialize: true }
      )
  );

  server.registerTool(
    "send_to_device",
    {
      title: "Send workouts to a Garmin watch",
      description:
        'Send workouts from a plan (already uploaded, i.e. with a workoutId) to a connected device. Only workouts flagged "sendToDevice": true are sent; if none are flagged, all workouts in the file are sent. The device defaults to the first registered one (see list_devices). Confirm with the user first.',
      inputSchema: {
        profile: profileArg,
        path: planPath,
        deviceId: z.number().int().optional(),
      },
      annotations: WRITE_GARMIN,
    },
    ({ profile, path: logicalPath, deviceId }) =>
      runTool(
        () => sendPlanToDevice(profile, logicalPath, deviceId),
        { serialize: true }
      )
  );

  // ── Writes with no plan file: one workout made, one workout put on a day ──

  server.registerTool(
    "create_workout",
    {
      title: "Create a workout on Garmin",
      description:
        "Create one NEW workout in the Garmin Connect library from the workout given here: no plan file is read or written and nothing is scheduled (schedule_workout puts it on a day). It never replaces a workout: every call makes a new one and returns its workoutId. Use dryRun=true to validate only (nothing is sent), and show the user that result. Confirm with the user first.\n\n" +
        NEW_WORKOUT_FORMAT,
      inputSchema: {
        profile: profileArg,
        workout: newWorkoutSchema,
        dryRun: z.boolean().default(false),
      },
      annotations: WRITE_GARMIN,
    },
    ({ profile, workout, dryRun }) =>
      runTool(
        () => createWorkout(profile, workout, dryRun),
        { serialize: true }
      )
  );

  server.registerTool(
    "schedule_workout",
    {
      title: "Schedule a Garmin workout on a day",
      description:
        "Put one workout of the Garmin library on one day of the Garmin calendar, with no plan file: use the workoutId create_workout returned, or one from list_workouts. The workout itself is not changed. It does not look at what is on the calendar already, so scheduling the same workout on the same day twice may add it twice. A workoutId Garmin does not have is an error. Confirm with the user first.",
      inputSchema: {
        profile: profileArg,
        workoutId: z.union([z.number(), z.string()]).describe("Id of a workout in the Garmin library."),
        date: isoDate.describe("The day to put it on, YYYY-MM-DD."),
      },
      annotations: WRITE_GARMIN,
    },
    ({ profile, workoutId, date }) =>
      runTool(
        () => scheduleWorkout(profile, workoutId, date),
        { serialize: true }
      )
  );
}
