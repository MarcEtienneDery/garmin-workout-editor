import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getLastNWeeksStart } from "../../activityExporter";
import { getAvailableProfiles } from "../../shared/profileLoader";
import {
  assertLive,
  getSession,
  getSettings,
  readJsonFile,
  resolveDataPath,
  runTool,
  toLogicalPath,
  writeJsonAtomic,
} from "../context";
import { extractWorkouts } from "./plans";

const profileArg = z
  .string()
  .optional()
  .describe("Garmin profile name (see list_profiles). Optional when a default profile is configured or only one exists.");

const planPath = z
  .string()
  .describe('Logical path starting with "workout-plans/" or "data/", e.g. "workout-plans/workouts-full-body-maintenance.json".');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const READ_GARMIN = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE_GARMIN = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

async function requireAuth(session: ReturnType<typeof getSession>): Promise<void> {
  if (!(await session.garminClient.ensureAuthenticated())) {
    throw new Error("Failed to authenticate with Garmin (check the profile credentials; 2FA accounts need a cached token).");
  }
}

function sameId(a: unknown, b: unknown): boolean {
  return a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
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
      title: "Get recent Garmin activities",
      description:
        "Fetch recent activities from Garmin, reduced to the slim planning format (duration, HR, training effect, RPE/feel, running intervals, strength sets with weights in lbs). Also saves them to data/<profile>/activities.json. `limit` is how many of the most recent activities are fetched BEFORE the date filter, so make it large enough to cover the period. With includeDetails it takes about 1 second per activity.",
      inputSchema: {
        profile: profileArg,
        limit: z.number().int().min(1).max(100).default(20),
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
          .describe("Fetch per-activity details (self evaluation, exercise sets). Slower but needed for RPE/feel and strength sets."),
      },
      annotations: READ_GARMIN,
    },
    ({ profile, limit, period, weekStart, weekEnd, type, includeDetails }) =>
      runTool(
        async () => {
          const session = getSession(profile);
          await requireAuth(session);

          const raw = await session.exporter.fetchActivities(limit, includeDetails);
          if (raw.length === 0) {
            // Mirror the CLI: don't overwrite the saved file with an empty result.
            throw new Error("Garmin returned no activities (see log).");
          }

          let customWeekStart = weekStart;
          if (!customWeekStart && weekEnd) customWeekStart = "1970-01-01";
          if (!customWeekStart && period === "last-4-weeks") customWeekStart = getLastNWeeksStart(4);
          if (!customWeekStart && period === "all") customWeekStart = "1970-01-01";

          const data = session.exporter.buildExtractedActivities(raw, {
            filterToLastWeek: !customWeekStart && period === "last-week",
            filterToThisWeek: !customWeekStart && period === "this-week",
            typeFilter: type,
            customWeekStart,
            customWeekEnd: weekEnd,
          });

          const out = path.join(session.profile.dataDir, "activities.json");
          writeJsonAtomic(out, data);
          return { savedTo: toLogicalPath(out), fetched: raw.length, ...data };
        },
        { serialize: true }
      )
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
          const out = outputPath
            ? resolveDataPath(outputPath)
            : path.join(session.profile.dataDir, "workouts.json");
          await session.editor.exportWorkouts(out, true);
          const count = (JSON.parse(fs.readFileSync(out, "utf-8")) as unknown[]).length;
          return { savedTo: toLogicalPath(out), count };
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
        async () => {
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
        },
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
        async () => {
          const session = getSession(profile);
          if (!dryRun) assertLive(session, "upload_workouts");
          const result = await session.editor.uploadWorkoutsFromFile(
            resolveDataPath(logicalPath),
            dryRun
          );
          return {
            path: logicalPath,
            dryRun,
            status: result.failed === 0 ? "ok" : result.successful === 0 ? "failed" : "partial",
            ...result,
            note: dryRun
              ? "Validation only; nothing was uploaded."
              : "New workoutIds were written back to the plan.",
          };
        },
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

          const absolute = resolveDataPath(logicalPath);
          const data = readJsonFile(absolute, logicalPath);
          const { workouts } = extractWorkouts(data);

          const matches = workouts.filter((w) =>
            workoutId !== undefined ? sameId(w?.workoutId, workoutId) : w?.workoutName === workoutName
          );
          if (matches.length === 0) throw new Error(`No matching workout found in ${logicalPath}.`);
          if (matches.length > 1) throw new Error(`${matches.length} workouts match; use workoutId to pick one.`);

          const workout = matches[0];
          const previousWorkoutId = workout.workoutId;
          const newId = await session.editor.uploadWorkout(workout, dryRun);
          if (newId === null) throw new Error("Upload failed (see log).");
          if (dryRun) return { path: logicalPath, workoutName: workout.workoutName, dryRun: true, valid: true };

          workout.workoutId = newId;
          writeJsonAtomic(absolute, data);
          return { path: logicalPath, workoutName: workout.workoutName, previousWorkoutId, workoutId: newId };
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
        async () => {
          const session = getSession(profile);
          assertLive(session, "schedule_plan");
          const plan = await session.editor.importWorkoutPlan(resolveDataPath(logicalPath));

          const attempted = plan.workouts.flatMap((w) =>
            [w.scheduledDate ?? []].flat().map((date) => ({
              workoutName: w.workoutName,
              workoutId: w.workoutId,
              date,
            }))
          );
          await session.editor.scheduleWorkoutPlan(plan);
          return {
            path: logicalPath,
            attempted,
            note: "These were attempted; the log lists which were scheduled, skipped or failed.",
          };
        },
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
        async () => {
          const session = getSession(profile);
          assertLive(session, "upload_and_schedule_plan");

          const absolute = resolveDataPath(logicalPath);
          const plan = await session.editor.importWorkoutPlan(absolute);
          const before = plan.workouts.map((w) => w.workoutId);

          let changed = false;
          try {
            await session.editor.uploadAndScheduleWorkoutPlan(plan);
          } finally {
            // Persist new ids even if a later step threw, so the next run replaces
            // the right workouts instead of creating duplicates.
            changed = plan.workouts.some((w, i) => String(w.workoutId) !== String(before[i]));
            if (changed) writeJsonAtomic(absolute, plan);
          }

          return {
            path: logicalPath,
            writtenBack: changed,
            workouts: plan.workouts.map((w, i) => ({
              workoutName: w.workoutName,
              workoutId: w.workoutId,
              uploaded: String(w.workoutId) !== String(before[i]),
              scheduledDate: w.scheduledDate,
            })),
            note: "uploaded=false means the workout was not (re)created; see the log.",
          };
        },
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
        async () => {
          const session = getSession(profile);
          assertLive(session, "send_to_device");

          const data = readJsonFile(resolveDataPath(logicalPath), logicalPath);
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
        },
        { serialize: true }
      )
  );
}
