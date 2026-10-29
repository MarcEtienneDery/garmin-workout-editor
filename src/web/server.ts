/**
 * web/server.ts — small web UI to manage plans (CRUD + Monaco JSON editor).
 *
 *   npm run web                      # http://127.0.0.1:8788
 *   WEB_PORT=8788 WEB_HOST=0.0.0.0 WEB_AUTH_TOKEN=... npm run web
 *
 * Reaches the same documents as the MCP plan tools ("workout-plans/*.json" and
 * "data/<profile>/*.json") through the same store, which keeps the earlier versions
 * of every document (GET /api/history). Non-loopback binds
 * require WEB_AUTH_TOKEN or a profile with a web sign-in password (below).
 *
 * Profiles live in the database (POST /api/profiles adds one; the Settings view shows them). Garmin and Renpho are optional
 * for each: GET /api/garmin says which profile has what (profileInfo), the Garmin parts of the page show for the profiles that
 * have a Garmin login, and a request that needs Garmin for a profile without one is answered 409.
 *
 * The Garmin actions (upload / schedule / send to device) reuse the MCP tool
 * bodies, so they need the profile's Garmin login and are disabled for a profile
 * without one and in mock mode.
 *
 * The Workouts view lists the Garmin library next to the workouts of the plan files
 * (GET /api/workouts), compares plan workouts with their Garmin copy (POST /api/garmin/status)
 * and creates / replaces / deletes workouts in the plan files and on Garmin together
 * (POST, PUT, DELETE /api/garmin/workout). Each write that touches Garmin needs confirm: true.
 *
 * A plan can be archived (POST /api/plans/archive, POST /api/plans/unarchive): its workouts are deleted from Garmin (confirm: true when it has
 * any), their workoutIds leave the plan, and the plan stays in the database, listed apart (archivedAt in GET /api/files) and left out of the
 * Today, Calendar and Workouts views. An archived plan is refused by the Garmin actions until it is unarchived.
 *
 * The Food view logs what was eaten per meal (GET /api/nutrition: a day's meals with their totals, the totals of a range next to
 * the calories Garmin says were burned, and the foods used lately; POST /api/nutrition adds, copies to today, changes or deletes entries). The log
 * is in the database only, Garmin has nowhere to keep food, so it needs no Garmin login and works with Garmin disabled.
 *
 * Food search and the barcode scan look foods up on Open Food Facts from the server (GET /api/foods/search?q=, GET
 * /api/foods/barcode?code=): the page scales what they return to the quantity eaten and logs it with POST /api/nutrition.
 *
 * The daily food goals (calories, protein, carbs, fat and the nutrients) are set in Settings (POST /api/settings/goals; GET /api/settings has them) and
 * come back with the Food view (`goals` and `progress`, where the day shown stands against each) and the Today view (`goals`, `foodProgress`).
 *
 * The Food view's AI box estimates a meal from the person's words and photos with Claude (POST /api/foods/ai; needs ANTHROPIC_API_KEY):
 * it writes nothing, the page shows the estimate and logs what is kept with POST /api/nutrition.
 *
 * The Calendar view shows where the plan files put their workouts (GET /api/calendar): each plan's span
 * and the dates of its workouts. It reads the stored plans only, not Garmin's own calendar.
 *
 * The Activities view lists and draws the profile's activities from the database (GET /api/activities,
 * GET /api/activity, GET /api/activities/stats for the lifetime totals and records); it never calls Garmin on a read. POST /api/activities/sync asks Garmin for what is new
 * (and, with history: true, starts the background fill of the whole history and the details), and POST
 * /api/activities/detail and /chart fetch one activity's details or chart data now.
 *
 * The Recovery view shows the daily health data the database keeps (GET /api/wellness: the readiness for a day, the days
 * of a range with the person's own normal, and what is stored for the day; GET /api/wellness/raw: Garmin's complete stored
 * response of one kind for a day); it never calls Garmin on a read. POST /api/wellness/sync fetches the last days now
 * (a Sync button, with manual: true, every kind; what was fetched lately is kept: see refreshMs) and starts the background fill of the
 * rest, as far back as the page shows. The Weight view (GET /api/weight: the weight, body composition and calories burned of the last
 * days, with the weight trend) reads the same table and syncs through that POST.
 *
 * The Today view (GET /api/today) is the landing page: the day's steps, intensity minutes of the week, Body Battery, sleep and food
 * next to the workouts the plans put on the coming days and the activities done today. It reads the database and the plan files
 * only; the page's Sync button asks Garmin (POST /api/wellness/sync, then POST /api/activities/sync).
 *
 * The workout picture times steps that name no pace from the profile's recent runs (GET /api/runs),
 * read from the activities table that the Garmin sync fills.
 *
 * Logins: the page shows a sign-in form (POST /api/login, GET /api/session, POST /api/logout)
 * and keeps the login in an HttpOnly session cookie; the session is kept in the database, so it survives a restart, and lasts
 * SESSION_IDLE_MS from its last use (at most SESSION_MAX_MS from the sign-in). user = a profile name (any case),
 * password = the web sign-in password set for that profile in Settings (kept as a hash) -> sees only data/<profile>/ and
 * the plans in workout-plans/ that are shared or its own, and its Garmin actions run as that
 * profile. WEB_AUTH_TOKEN as the password (any user name) is the admin login with full access.
 * Scripts can send the same credentials as HTTP Basic instead of using a session.
 */
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import * as dotenv from "dotenv";
import { GarminNotConnectedError, PROJECT_ROOT, findProfile, garminConnected, getAvailableProfiles } from "../shared/profileLoader";
import { type DocMeta, type StoreErrorCode, StoreError, WELLNESS_KINDS, type WellnessKind, decoyCheck, getStore, normalizeLogicalPath, profileOfPath } from "../shared/store";
import { LoginThrottle, type TrustProxy, clientAddress, trustProxyOf } from "./loginThrottle";
import { getSettings, resolveProfileName, runCaptured } from "../mcp/context";
import { installConsoleRedirect } from "../mcp/logCapture";
import { slimStored } from "../activityExporter";
import { activityStats, buildChart } from "../shared/activityChart";
import { type BestLift, liftSets } from "../shared/oneRepMax";
import { lifetimeStats } from "../shared/lifetimeStats";
import type { ExerciseSet } from "../shared/types";
import { syncStatus } from "../shared/activitySync";
import type { ActivitySummary, StoredActivity } from "../shared/store";
import { fetchChartNow, fetchDetailsNow, refreshActivities, startBackgroundSync } from "../mcp/tools/activities";
import { diffPlanWorkout, extractWorkouts, validatePlanData } from "../mcp/tools/plans";
import { MAX_SCAN_BYTES, activePlanDocs, isExportSnapshot } from "../shared/planDocs";
import { refreshWellness, rereadWeighIns, startBackgroundWellness, wellnessSyncStatus } from "../mcp/tools/wellness";
import { bodyRange, intensityWeek, readinessAt, wellnessRange } from "../shared/wellnessReport";
import { SettingsError, createProfile, removeGarminLogin, removeRenpho, saveGarminLogin, saveRenpho, saveWebPassword, settingsView } from "../shared/accounts";
import { recentFit, testRenphoLogin } from "../shared/renphoSync";
import { runRenpho, startRenphoTimer } from "../mcp/tools/renpho";
import { testGarminLogin } from "../mcp/tools/settings";
import { addDays, localToday } from "../shared/wellnessSync";
import { FoodInputError, FoodSourceError, lookupBarcode, searchFoods } from "../shared/foodSearch";
import { FoodAiError, type FoodAiErrorKind, estimateFoods, foodAiStatus } from "../shared/foodAi";
import { MAX_ITEMS, MEALS, NutritionError, addFoods, averageOf, changeFood, copyFoods, deleteFoods, nutritionDays, parseDay, recentFoods } from "../shared/nutrition";
import { getGoals, goalProgress, kcalGoalOf, setGoals } from "../shared/nutritionGoals";
import {
  LIBRARY_LIMIT,
  type LibraryWorkout,
  archivePlan,
  checkWorkoutSync,
  deleteLibraryWorkout,
  getLibraryWorkout,
  listDevices,
  listLibraryWorkouts,
  plannedOnGarmin,
  saveWorkout,
  schedulePlan,
  sendPlanToDevice,
  unarchivePlan,
  uploadAndSchedulePlan,
  uploadPlan,
} from "../mcp/tools/garmin";
import {
  VALID_END_CONDITIONS,
  VALID_STEP_TYPES,
  VALID_TARGET_TYPES,
} from "../workoutEditor";

const PUBLIC_DIR = path.join(__dirname, "public");
// Monaco is served from node_modules so the editor works offline (e.g. on the NAS).
const MONACO_DIR = path.join(PROJECT_ROOT, "node_modules", "monaco-editor", "min", "vs");
const LEAFLET_DIR = path.join(PROJECT_ROOT, "node_modules", "leaflet", "dist");
// ZXing reads barcodes in browsers that have no BarcodeDetector (Safari on iPhone); the page loads it only then.
const ZXING_DIR = path.join(PROJECT_ROOT, "node_modules", "@zxing", "library", "umd");
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const SESSION_COOKIE = "plan_editor_session";
/** Set by sign out: a browser that cached Basic credentials (earlier versions asked for them) keeps sending them, so they are ignored while this is set. */
const SIGNED_OUT_COOKIE = "plan_editor_signed_out";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A session ends after this long without use ... */
const SESSION_IDLE_MS = 30 * DAY_MS;
/** ... and this long after the sign-in however much it is used. */
const SESSION_MAX_MS = 90 * DAY_MS;
/** A session in use is renewed (a write, and a new cookie) at most this often. */
const SESSION_RENEW_AFTER_MS = DAY_MS;
const SIGNED_OUT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const STORE_STATUS: Record<StoreErrorCode, number> = { not_found: 404, exists: 409, conflict: 409, invalid_path: 400 };
const store = () => getStore();

export interface WebServerOptions {
  host: string;
  port: number;
  /** Optional shared secret (HTTP Basic password). Required unless host is loopback. */
  token?: string;
  /** Which forwarding header names the client behind a proxy or tunnel (default: TRUST_PROXY, else none: the socket's address). */
  trustProxy?: TrustProxy;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Extra fields for the JSON error body (e.g. the Garmin log). */
    readonly extra: Record<string, unknown> = {},
    /** Extra response headers (Retry-After). */
    readonly headers: http.OutgoingHttpHeaders = {}
  ) {
    super(message);
  }
}

export const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "::1" || host === "localhost";

const sha256 = (v: string) => createHash("sha256").update(v).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

/** Who is calling: the admin (token, or no auth configured) or a single profile. */
export type Principal = { admin: true; profile?: undefined } | { admin: false; profile: string };
const ADMIN: Principal = { admin: true };

/** The profiles that sign in with a password of their own; read per request so one set in Settings applies at once. */
const profilesWithWebPassword = (): string[] => store().profiles.withWebPassword();

/** A profile login reaches its own data/<profile>/ and the plans in workout-plans/ that are shared or its own. */
function canReach(who: Principal, logical: string, owner: string | null): boolean {
  if (who.admin) return true;
  const folder = profileOfPath(logical);
  return folder ? folder === who.profile : owner === null || owner === who.profile;
}

function assertScope(who: Principal, logical: string): void {
  if (who.admin) return;
  if (!canReach(who, logical, store().head(logical)?.owner ?? null)) {
    throw new HttpError(403, `${logical} belongs to another profile.`);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
  // every route reads fields off the body: null, a number or a list would be a crash, not a bad request
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Request body must be a JSON object");
  return body;
}

function logicalOr400(logicalPath: unknown): string {
  if (typeof logicalPath !== "string" || !logicalPath) throw new HttpError(400, "Missing path");
  try {
    return normalizeLogicalPath(logicalPath);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}

/** The logical path of a request, checked against what this login may reach. */
function scopedPath(who: Principal, logicalPath: unknown): string {
  const logical = logicalOr400(logicalPath);
  assertScope(who, logical);
  return logical;
}

function parseOr400(text: unknown): unknown {
  if (typeof text !== "string") throw new HttpError(400, "Missing text");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HttpError(400, `Not valid JSON: ${(error as Error).message}`);
  }
}

/** Validation for workout-shaped JSON; other documents (e.g. training-plan.json) just need to parse. */
function validateText(text: string): unknown {
  const data = parseOr400(text);
  const isWorkouts =
    Array.isArray(data) ||
    (!!data && typeof data === "object" && Array.isArray((data as any).workouts));
  return isWorkouts ? validatePlanData(data) : null;
}

interface FileInfo {
  path: string;
  size: number;
  /** Changes with every save: send it back with a save to find out whether someone else saved first. */
  version: number;
  updatedAt: number;
  owner: string | null;
  /** Who saved this version: web, mcp, cli, import. */
  source: string;
  /** When the plan was archived; null for an active one. */
  archivedAt: number | null;
  workoutCount?: number;
  weekStart?: string;
  weekEnd?: string;
}

const fileInfo = (m: DocMeta): FileInfo => ({
  path: m.path,
  size: m.size,
  version: m.version,
  updatedAt: m.updatedAt,
  owner: m.owner,
  source: m.source,
  archivedAt: m.archivedAt,
  ...m.summary,
});

function listFiles(who: Principal): FileInfo[] {
  return store()
    .list()
    .filter((m) => canReach(who, m.path, m.owner))
    .map(fileInfo);
}

/** JSON Schema for the Monaco editor: autocompletion and hover docs for plan files. */
function workoutSchema() {
  const step = {
    type: "object",
    required: ["stepType", "targetType"],
    properties: {
      stepType: { enum: [...VALID_STEP_TYPES] },
      targetType: { enum: [...VALID_TARGET_TYPES] },
      endCondition: { enum: [...VALID_END_CONDITIONS] },
      endConditionValue: { type: "number" },
      exerciseName: { type: "string", description: "Garmin exercise key, e.g. BARBELL_BENCH_PRESS" },
      targetValueOne: { type: "number" },
      targetValueTwo: { type: "number" },
      reps: { type: "number" },
      durationSeconds: { type: "number" },
      distanceMeters: { type: "number" },
      weight: { type: "number", description: "Pounds" },
      weightPercentage: { type: "number", description: "Percent of 1RM; requires benchmarkKey" },
      benchmarkKey: { type: "string" },
      restTimeSeconds: { type: "number" },
      numberOfRepeats: { type: "number" },
      repeatGroupIndex: { type: "number" },
      stepOrder: { type: "number" },
    },
  };
  const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
  const workout = {
    type: "object",
    required: ["workoutName"],
    properties: {
      workoutName: { type: "string", minLength: 1 },
      workoutId: { type: ["number", "string"], description: "Assigned by Garmin on upload" },
      workoutType: { enum: ["running", "strength_training", "cycling", "cardio", "swimming", "other"] },
      description: { type: "string" },
      distanceMeters: { type: "number" },
      scheduledDate: { oneOf: [date, { type: "array", items: date }] },
      sendToDevice: { type: "boolean" },
      steps: { type: "array", items: step },
    },
  };
  return {
    oneOf: [
      {
        type: "object",
        properties: {
          generatedAt: { type: "string" },
          weekStart: date,
          weekEnd: date,
          source: { type: "string" },
          notes: { type: "string" },
          workouts: { type: "array", items: workout },
        },
      },
      { type: "array", items: workout },
    ],
  };
}

// ── Garmin actions ──────────────────────────────────────────────────────────

const GARMIN_ACTIONS = ["upload", "schedule", "upload_schedule", "send"] as const;
type GarminAction = (typeof GARMIN_ACTIONS)[number];

/** What the page shows about the login: the profile name, or admin. */
const userInfo = (who: Principal) => (who.admin ? { admin: true } : { admin: false, name: who.profile });

/** Whether the profile has Garmin health data to show: a Garmin login, or rows stored from one that was disconnected. */
const hasHealth = (profile: string): boolean => garminConnected(profile) || store().wellness.hasRows(profile);

/** What one profile has: the connections it made and whether the views that depend on them have anything stored. */
function profileSources(profile: string) {
  const renpho = store().renpho.counts(profile);
  let renphoLogin = false;
  try {
    renphoLogin = store().credentials.get(profile, "renpho") !== null;
  } catch {
    renphoLogin = true; // saved, but encrypted with a key this process lacks
  }
  return {
    garmin: garminConnected(profile),
    renpho: renphoLogin,
    // every profile needs a web sign-in password; one made before that was a rule, or imported without one, is asked to set it
    webPassword: store().profiles.webPasswordHash(profile) !== null,
    hasActivities: store().activities.counts(profile).total > 0,
    hasWellness: store().wellness.hasRows(profile),
    hasWeight: renpho.total > 0 || store().wellness.hasWeighIn(profile),
  };
}

function garminInfo(who: Principal) {
  const all = getAvailableProfiles();
  const profiles = who.admin ? all : all.filter((p) => p === who.profile);
  const mock = getSettings().mock;
  const profileInfo = Object.fromEntries(profiles.map((p) => [p, profileSources(p)]));
  const connected = profiles.filter((p) => profileInfo[p].garmin);
  return {
    // some profile can reach Garmin; the page asks per profile (profileInfo) before it shows a Garmin button
    enabled: connected.length > 0 && !mock,
    mock,
    profiles,
    connected,
    profileInfo,
    user: userInfo(who),
    defaultProfile: who.admin
      ? (getSettings().defaultProfile ?? (profiles.length === 1 ? profiles[0] : null))
      : who.profile,
    reason: mock
      ? "Mock mode: Garmin writes are disabled."
      : connected.length === 0
        ? "Garmin is not connected: add a Garmin login in Settings to sync and send workouts."
        : null,
  };
}

/** data/<PROFILE>/... files and owned plans belong to that profile; other plans need an explicit or default one. */
function profileFor(who: Principal, logical: string, requested: unknown): string {
  if (!who.admin) {
    if (!getAvailableProfiles().includes(who.profile)) throw new HttpError(400, `Unknown profile "${who.profile}".`);
    return who.profile; // a profile login always acts as itself
  }
  const owner = profileOfPath(logical) ?? (logical ? (store().head(logical)?.owner ?? undefined) : undefined);
  const name = owner ?? (typeof requested === "string" && requested ? requested : undefined);
  let resolved: string;
  try {
    resolved = resolveProfileName(name);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  if (!getAvailableProfiles().includes(resolved)) throw new HttpError(400, `Unknown profile "${resolved}".`);
  return resolved;
}

async function garminAction(body: any, who: Principal): Promise<{ status: number; payload: unknown }> {
  const info = garminInfo(who);
  if (!info.enabled) throw new HttpError(409, info.reason ?? "Garmin actions are disabled.");
  if (!GARMIN_ACTIONS.includes(body.action)) throw new HttpError(400, `Unknown action "${body.action}".`);
  // The UI shows what will happen and asks first; the API insists on it so a stray request can't change the account.
  if (body.confirm !== true) throw new HttpError(400, "Confirmation required (confirm: true).");
  const action = body.action as GarminAction;

  const logical = scopedPath(who, body.path);
  const doc = store().get(logical);
  if (!doc) throw new HttpError(404, `File not found: ${logical}`);
  if (doc.archivedAt !== null) throw new HttpError(409, `${logical} is archived: unarchive it before sending its workouts to Garmin.`);
  const profile = profileFor(who, logical, body.profile);
  requireConnected(profile);

  if (action === "upload" || action === "upload_schedule") {
    const validation = validateText(doc.text) as { errors: string[] } | null;
    if (validation && validation.errors.length > 0) {
      return { status: 422, payload: { error: "Fix the validation errors before uploading.", errors: validation.errors } };
    }
  }
  const deviceId = Number.isInteger(body.deviceId) ? (body.deviceId as number) : undefined;

  const outcome = await runCaptured<unknown>(() => {
    switch (action) {
      case "upload":
        return uploadPlan(profile, logical);
      case "schedule":
        return schedulePlan(profile, logical);
      case "upload_schedule":
        return uploadAndSchedulePlan(profile, logical);
      case "send":
        return sendPlanToDevice(profile, logical, deviceId);
    }
  });
  const version = store().head(logical)?.version;
  if (!outcome.ok) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return { status: garminFailure(outcome.error), payload: { error: message, log: outcome.log, profile, version } };
  }
  return { status: 200, payload: { action, profile, result: outcome.value, log: outcome.log, version } };
}

// ── Workouts view: the Garmin library next to the plan entries that carry the same workouts ──

interface PlanEntry {
  path: string;
  index: number;
  version: number;
  workout: any;
}

const isWorkout = (w: any): boolean => !!w && typeof w === "object" && typeof w.workoutName === "string";

/** A stored document as plan data: the parsed JSON and its workout list. null when it is not JSON or holds no list (the editor flags those). */
function readPlan(logical: string): { data: any; list: any[] } | null {
  try {
    const data: any = JSON.parse(store().get(logical)?.text ?? "");
    const list = Array.isArray(data) ? data : data?.workouts;
    return Array.isArray(list) ? { data, list } : null;
  } catch {
    return null;
  }
}

/** Every workout in the plans a profile works with (see activePlanDocs: archived plans are not among them). */
function planEntriesFor(profile: string): PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const meta of activePlanDocs(store(), profile)) {
    readPlan(meta.path)?.list.forEach((workout, index) => {
      if (isWorkout(workout)) entries.push({ path: meta.path, index, version: meta.version, workout });
    });
  }
  return entries;
}

// ── Calendar view: where the plan files put their workouts (this is the files, not Garmin's own calendar) ──

/** A real calendar date written YYYY-MM-DD. */
const isoDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === v;
};

/** The valid dates of a workout's scheduledDate (one date or a list), sorted and without repeats. */
const scheduledDates = (w: any): string[] => [...new Set([w.scheduledDate].flat().filter(isoDate))].sort();

interface CalendarPlan {
  path: string;
  owner: string | null;
  weekStart?: string;
  weekEnd?: string;
  /**
   * The span the plan covers: weekStart / weekEnd widened by every scheduledDate. The week range alone is not
   * reliable (a plan keeps its first week after it grows), and a plan may have no scheduledDate at all. null: no dates.
   */
  start: string | null;
  end: string | null;
  workouts: { index: number; workoutName: string; workoutType?: string; workoutId?: number | string; dates: string[] }[];
}

/** Every plan this login can reach with its dates: workout-plans/ and data/<profile>/ (export snapshots are copies of Garmin's list, not plans; archived plans are put away). */
function calendarPlans(who: Principal): CalendarPlan[] {
  const plans: CalendarPlan[] = [];
  for (const meta of store().list()) {
    const inPlans = meta.path.startsWith("workout-plans/");
    if (!inPlans && (!meta.path.startsWith("data/") || isExportSnapshot(meta.path))) continue;
    if (meta.archivedAt !== null || meta.size > MAX_SCAN_BYTES || !canReach(who, meta.path, meta.owner)) continue;
    const plan = readPlan(meta.path);
    if (!plan) continue;
    const workouts = plan.list.flatMap((w, index) =>
      isWorkout(w)
        ? [{ index, workoutName: w.workoutName, workoutType: w.workoutType, workoutId: hasId(w.workoutId) ? w.workoutId : undefined, dates: scheduledDates(w) }]
        : []
    );
    const weekStart = isoDate(plan.data.weekStart) ? plan.data.weekStart : undefined;
    const weekEnd = isoDate(plan.data.weekEnd) ? plan.data.weekEnd : undefined;
    const days = [weekStart, weekEnd, ...workouts.flatMap((w) => w.dates)].filter(isoDate).sort();
    plans.push({ path: meta.path, owner: meta.owner, weekStart, weekEnd, start: days[0] ?? null, end: days[days.length - 1] ?? null, workouts });
  }
  // dated plans in calendar order, the undated ones last
  return plans.sort((a, b) => Number(a.start === null) - Number(b.start === null) || (a.start ?? "").localeCompare(b.start ?? "") || a.path.localeCompare(b.path));
}

// ── Pace from your runs: what the workout picture times steps with when the workout names no pace ──

/** One run from the activities table; pace is seconds per km. */
interface RunSample {
  date: string;
  km: number;
  pace: number;
  hr: number;
}

const RUN_WINDOW_DAYS = 120; // counted back from the newest run, so stale files still give an answer
const RUN_LIMIT = 60;

/** The profile's recent runs, newest first, from the activities table. Reads the database only, so it needs no Garmin login. */
function recentRuns(profile: string): RunSample[] {
  const runs: RunSample[] = [];
  for (const a of store().activities.between(profile, { type: "running", limit: 400 })) {
    const pace = a.raw?.averageSpeed > 0 ? 1000 / a.raw.averageSpeed : NaN; // seconds per km, from the speed in m/s
    const km = (a.distance ?? 0) / 1000, hr = a.avgHr ?? 0;
    // short runs, treadmill readings and watch glitches would skew the pace
    if (!(km >= 2) || !(pace >= 180 && pace <= 540) || !(hr >= 90 && hr <= 210)) continue;
    runs.push({ date: a.startLocal.slice(0, 10), km: +km.toFixed(1), pace: Math.round(pace), hr: Math.round(hr) });
  }
  if (!runs.length) return [];
  const cutoff = new Date(Date.parse(`${runs[0].date}T00:00:00Z`) - RUN_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  return runs.filter((r) => r.date >= cutoff).slice(0, RUN_LIMIT);
}

// ── Activities view: what the activities table holds, never a call to Garmin on a read ──

/** The profile a read is about, or null when none is configured (nothing is stored then). */
function profileOrNull(who: Principal, requested: unknown): string | null {
  try {
    return profileFor(who, "", requested);
  } catch {
    return null;
  }
}

/** A row of the activity list; seconds per km for a run. */
function activityRow(a: Omit<ActivitySummary, "detailed"> & { detailed?: boolean }) {
  return {
    id: a.id,
    date: a.startLocal.slice(0, 10),
    time: a.startLocal.slice(11, 16),
    type: a.type,
    name: a.name,
    km: a.distance ? +(a.distance / 1000).toFixed(2) : null,
    seconds: a.duration ? Math.round(a.duration) : null,
    paceSec: a.type === "running" && a.speed && a.speed > 0 ? Math.round(1000 / a.speed) : null,
    avgHr: a.avgHr ? Math.round(a.avgHr) : null,
    maxHr: a.maxHr ? Math.round(a.maxHr) : null,
    effect: a.trainingEffectLabel,
    aerobic: a.aerobicEffect,
    elevation: a.elevationGain ? Math.round(a.elevationGain) : null,
    calories: a.calories ? Math.round(a.calories) : null,
    sets: a.sets,
    reps: a.reps,
    workoutId: a.workoutId,
    detailed: !!a.detailed,
  };
}

/** The one-rep max of each exercise of this activity: the same ones the Stats view shows (see lifetimeStats). */
function oneRepMaxes(profile: string, sets: ExerciseSet[] | undefined): Record<string, BestLift> {
  const names = new Set(liftSets(sets).map((x) => x.exerciseName));
  if (!names.size) return {};
  const out: Record<string, BestLift> = {};
  for (const e of lifetimeStats(store().activities, profile).strength?.exercises ?? []) if (e.best && names.has(e.name)) out[e.name] = e.best;
  return out;
}

/** One activity with everything stored: its row, the slim form (sets, intervals, feel and RPE), and the plan workout it came from. */
function activityDetail(profile: string, a: StoredActivity) {
  const raw = a.raw ?? {}, summary = a.detail?.summaryDTO ?? {}; // what the list lacks, the details may carry
  const row = activityRow({
    id: a.id, startLocal: a.startLocal, type: a.type, name: a.name, distance: a.distance, duration: a.duration, avgHr: a.avgHr,
    maxHr: raw.maxHR ?? summary.maxHR ?? null, speed: raw.averageSpeed ?? summary.averageSpeed ?? null, trainingEffectLabel: raw.trainingEffectLabel ?? summary.trainingEffectLabel ?? null,
    aerobicEffect: raw.aerobicTrainingEffect ?? null, elevationGain: raw.elevationGain ?? null, calories: raw.calories ?? summary.calories ?? null,
    sets: raw.totalSets ?? null, reps: raw.totalReps ?? null, workoutId: a.workoutId, detailed: a.detail !== null,
  });
  const slim = slimStored(raw, a.detail);
  const entry = hasId(a.workoutId) ? planEntriesFor(profile).find((e) => sameId(e.workout.workoutId, a.workoutId)) : undefined;
  return {
    activity: row,
    slim,
    detailed: a.detail !== null,
    stats: activityStats(raw, a.detail),
    oneRepMax: a.type === "strength_training" ? oneRepMaxes(profile, slim?.exerciseSets) : {},
    // the charts, read from what was stored; null until the chart data has been fetched
    chart: buildChart(store().activities.getChart(profile, a.id)),
    planned: entry ? { path: entry.path, index: entry.index, workout: entry.workout } : null,
  };
}

const hasId = (id: unknown): boolean => id !== undefined && id !== null && id !== "";
const sameId = (a: unknown, b: unknown): boolean => hasId(a) && hasId(b) && String(a) === String(b);

type WorkoutRowState = "garmin-only" | "linked" | "not-uploaded";

/**
 * One row per workout on Garmin plus one per plan workout Garmin does not list. "linked" rows
 * have a workoutId and plan entries to compare (checked afterwards through /api/garmin/status).
 */
function workoutRows(library: LibraryWorkout[], entries: PlanEntry[]) {
  const ref = (e: PlanEntry) => ({ path: e.path, index: e.index, version: e.version });
  const listed = new Set(library.map((w) => String(w.workoutId)));
  const rows: {
    key: string;
    workoutId?: number | string;
    workoutName: string;
    workoutType?: string;
    description?: string;
    updatedDate?: string;
    plans: ReturnType<typeof ref>[];
    /** The days the plans schedule it on, sorted. */
    dates: string[];
    state: WorkoutRowState;
  }[] = [];
  const datesOf = (list: PlanEntry[]) => [...new Set(list.flatMap((e) => scheduledDates(e.workout)))].sort();

  for (const w of library) {
    const linked = entries.filter((e) => sameId(e.workout.workoutId, w.workoutId));
    rows.push({ key: `g:${w.workoutId}`, ...w, plans: linked.map(ref), dates: datesOf(linked), state: linked.length ? "linked" : "garmin-only" });
  }
  // Not in the (at most LIBRARY_LIMIT long) listing: unverified until the status check asks Garmin for it.
  for (const e of entries) {
    if (hasId(e.workout.workoutId) && listed.has(String(e.workout.workoutId))) continue;
    rows.push({
      key: `p:${e.path}#${e.index}`,
      workoutId: hasId(e.workout.workoutId) ? e.workout.workoutId : undefined,
      workoutName: e.workout.workoutName,
      workoutType: e.workout.workoutType,
      description: e.workout.description || undefined,
      plans: [ref(e)],
      dates: datesOf([e]),
      state: hasId(e.workout.workoutId) ? "linked" : "not-uploaded",
    });
  }
  return { rows, truncated: library.length >= LIBRARY_LIMIT };
}

function requireGarmin(who: Principal): void {
  const info = garminInfo(who);
  if (!info.enabled) throw new HttpError(409, info.reason ?? "Garmin actions are disabled.");
}

/** The profile a Garmin request is about must have a Garmin login of its own; the others work without Garmin. */
function requireConnected(profile: string): void {
  if (!garminConnected(profile)) throw new HttpError(409, `Profile "${profile}" has no Garmin login: add one in Settings.`);
}

function requireConfirm(body: any): void {
  // The UI asks first; the API insists so a stray request can't change the account.
  if (body.confirm !== true) throw new HttpError(400, "Confirmation required (confirm: true).");
}

/** A call that failed on Garmin's side is a 502; one that could not start because the profile has no Garmin login is a 409. */
const garminFailure = (error: unknown): number => (error instanceof GarminNotConnectedError ? 409 : 502);

/** Run a Garmin call serialized with the others; a failure becomes a 502 that carries the Garmin log. */
async function viaGarmin<T>(fn: () => Promise<T>): Promise<{ value: T; log: string }> {
  const outcome = await runCaptured(fn);
  if (!outcome.ok) {
    throw new HttpError(garminFailure(outcome.error), outcome.error instanceof Error ? outcome.error.message : String(outcome.error), { log: outcome.log });
  }
  return { value: outcome.value, log: outcome.log };
}

interface PlanFile {
  logical: string;
  owner: string | null;
  data: unknown;
  /** Live reference into `data`. */
  workouts: any[];
}

function loadPlanFile(who: Principal, logicalPath: unknown, version?: unknown): PlanFile {
  const logical = scopedPath(who, logicalPath);
  const doc = store().get(logical);
  if (!doc) throw new HttpError(404, `File not found: ${logical}`);
  if (typeof version === "number" && doc.version !== version) {
    throw new HttpError(409, `${logical} changed since you opened it. Reload and try again.`);
  }
  const data = parseOr400(doc.text);
  try {
    return { logical, owner: doc.owner, data, workouts: extractWorkouts(data).workouts };
  } catch {
    throw new HttpError(400, `${logical} is not a workout plan.`);
  }
}

const savePlanFile = (file: PlanFile): void => {
  store().put(file.logical, JSON.stringify(file.data, null, 2) + "\n", { source: "web", replace: true });
};

interface PlanTarget {
  file: PlanFile;
  index: number;
}

/** Check that each referenced plan entry still exists and carries the workout we think it does, before anything is changed. */
function loadPlanTargets(who: Principal, refs: unknown, workoutId?: unknown): { files: PlanFile[]; targets: PlanTarget[] } {
  if (refs === undefined) return { files: [], targets: [] };
  if (!Array.isArray(refs)) throw new HttpError(400, "plans must be a list");
  const files = new Map<string, PlanFile>();
  const targets: PlanTarget[] = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") throw new HttpError(400, "Each plan reference needs a path and index");
    const file = files.get(logicalOr400(ref?.path)) ?? loadPlanFile(who, ref?.path, ref?.version);
    files.set(file.logical, file);
    const entry = file.workouts[ref.index];
    if (!Number.isInteger(ref.index) || !entry || typeof entry !== "object") {
      throw new HttpError(409, `${file.logical} no longer has workout #${ref.index}. Reload and try again.`);
    }
    if (hasId(workoutId) && hasId(entry.workoutId) && !sameId(entry.workoutId, workoutId)) {
      throw new HttpError(409, `${file.logical} workout #${ref.index} is not workout ${workoutId} any more. Reload and try again.`);
    }
    targets.push({ file, index: ref.index });
  }
  return { files: [...files.values()], targets };
}

function workoutFrom(body: any): Record<string, any> {
  const workout = body.workout;
  if (!workout || typeof workout !== "object" || Array.isArray(workout)) throw new HttpError(400, "Missing workout");
  return workout;
}

/** data/<PROFILE>/ plans and owned plans decide the Garmin profile; otherwise the request (or default) does. */
const ownerHint = (files: PlanFile[]): string => files.find((f) => profileOfPath(f.logical) || f.owner)?.logical ?? "";

const changedFiles = (files: PlanFile[]) => files.map((f) => ({ path: f.logical, version: store().head(f.logical)?.version }));

/** Add a new workout to a plan and/or Garmin. */
async function createWorkout(body: any, who: Principal): Promise<unknown> {
  const workout = workoutFrom(body);
  const upload = body.upload === true;
  const validation = validatePlanData([workout]);
  if (upload && validation.errors.length) {
    throw new HttpError(422, "Fix the validation errors before uploading.", { errors: validation.errors });
  }
  const plan = hasId(body.planPath) ? loadPlanFile(who, body.planPath, body.version) : undefined;
  if (!plan && !upload) throw new HttpError(400, "Choose a plan to add it to, or upload it to Garmin.");

  let saved: { workoutId: number | string } | undefined;
  let log = "";
  if (upload) {
    requireGarmin(who);
    requireConfirm(body);
    if (plan) assertNotArchived([plan]);
    const profile = profileFor(who, plan?.logical ?? "", body.profile);
    requireConnected(profile);
    const toUpload = { ...workout };
    delete toUpload.workoutId; // a new workout never replaces an existing one
    ({ value: saved, log } = await viaGarmin(() => saveWorkout(profile, toUpload, body.schedule === true)));
  }
  const created = saved ? { ...workout, workoutId: saved.workoutId } : { ...workout };
  // Not uploaded: the entry is unlinked, unless it is a copy of a workout that is already on Garmin (linkWorkoutId).
  if (!saved) { if (hasId(body.linkWorkoutId)) created.workoutId = body.linkWorkoutId; else delete created.workoutId; }
  let index: number | undefined;
  if (plan) {
    plan.workouts.push(created);
    index = plan.workouts.length - 1;
    savePlanFile(plan);
  }
  return { workoutId: created.workoutId, path: plan?.logical, index, changed: plan ? changedFiles([plan]) : [], validation, log };
}

/**
 * Save an edited workout: into its plan entry (plans[0]) and/or onto Garmin. Garmin replaces the workout
 * (new workoutId), so every plan entry that pointed at the old one is repointed.
 */
async function updateWorkout(body: any, who: Principal): Promise<unknown> {
  const workout = workoutFrom(body);
  const upload = body.upload === true;
  const validation = validatePlanData([workout]);
  if (upload && validation.errors.length) {
    throw new HttpError(422, "Fix the validation errors before uploading.", { errors: validation.errors });
  }
  const { files, targets } = loadPlanTargets(who, body.plans ?? [], body.workoutId);
  if (!upload && !targets.length) throw new HttpError(400, "Nothing to save: no plan entry and no upload.");

  let newId: number | string | undefined;
  let log = "";
  if (upload) {
    requireGarmin(who);
    requireConfirm(body);
    assertNotArchived(files);
    const profile = profileFor(who, ownerHint(files), body.profile);
    requireConnected(profile);
    const toUpload = { ...workout };
    if (hasId(body.workoutId)) toUpload.workoutId = body.workoutId;
    else delete toUpload.workoutId;
    const result = await viaGarmin(() => saveWorkout(profile, toUpload, body.schedule === true));
    newId = result.value.workoutId;
    log = result.log;
  }

  targets.forEach(({ file, index }, i) => {
    if (i === 0) file.workouts[index] = { ...workout };
    if (newId !== undefined) file.workouts[index].workoutId = newId;
  });
  files.forEach(savePlanFile);
  return { workoutId: newId ?? workout.workoutId, changed: changedFiles(files), validation, log };
}

/** Remove a workout from Garmin and/or from the plan entries that carry it. */
async function deleteWorkout(body: any, who: Principal): Promise<unknown> {
  const fromGarmin = body.garmin === true;
  const fromPlans = body.removeFromPlans === true;
  if (!fromGarmin && !fromPlans) throw new HttpError(400, "Nothing to delete: choose Garmin and/or the plan.");
  const { files, targets } = loadPlanTargets(who, body.plans ?? [], body.workoutId);

  let log = "";
  if (fromGarmin) {
    requireGarmin(who);
    requireConfirm(body);
    if (!hasId(body.workoutId)) throw new HttpError(400, "Missing workoutId");
    const profile = profileFor(who, ownerHint(files), body.profile);
    requireConnected(profile);
    ({ log } = await viaGarmin(() => deleteLibraryWorkout(profile, body.workoutId)));
  }

  if (fromPlans) {
    for (const file of files) {
      const gone = new Set(targets.filter((t) => t.file === file).map((t) => t.index));
      file.workouts.splice(0, file.workouts.length, ...file.workouts.filter((_, i) => !gone.has(i)));
    }
  } else {
    // Only Garmin's copy is gone: the plan keeps the workout, as "not uploaded".
    for (const { file, index } of targets) delete file.workouts[index].workoutId;
  }
  files.forEach(savePlanFile);
  return { deleted: { garmin: fromGarmin, plans: fromPlans }, changed: changedFiles(files), log };
}

/** Archive a plan: its workouts leave Garmin, the plan stays in the database (see archivePlan). Garmin is only touched, and confirm only asked for, when the plan has workoutIds. */
async function archiveFile(body: any, who: Principal): Promise<unknown> {
  const logical = scopedPath(who, body.path);
  const doc = store().get(logical);
  if (!doc) throw new HttpError(404, `File not found: ${logical}`);
  if (typeof body.version === "number" && doc.version !== body.version) {
    throw new HttpError(409, `${logical} changed since you opened it. Reload and try again.`);
  }
  let planned: ReturnType<typeof plannedOnGarmin>;
  try {
    planned = plannedOnGarmin(parseOr400(doc.text));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, `${logical} is not a workout plan.`);
  }

  let profile: string | undefined;
  if (planned.length) {
    requireGarmin(who);
    requireConfirm(body);
    profile = profileFor(who, logical, body.profile);
    requireConnected(profile);
  }
  const { value, log } = await viaGarmin(() => archivePlan(profile, logical));
  return { ...value, version: store().head(logical)?.version, log };
}

/** A save that would put workouts on Garmin must not land in an archived plan: it would be listed there again with ids. */
function assertNotArchived(files: PlanFile[]): void {
  for (const file of files) {
    if (store().head(file.logical)?.archivedAt != null) throw new HttpError(409, `${file.logical} is archived: unarchive it before sending its workouts to Garmin.`);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/**
 * A short hash of the page's own scripts. The page stamps it on their URLs (?v=), so a browser or CDN that keeps a script for
 * hours fetches the new one after a deploy: behind Cloudflare every .js is kept 4 hours by the browser whatever the server
 * says, and a page that ran new code against an old script failed without a word. The page itself is never cached. A page
 * load reads a few hundred KB to work it out, which a single-user editor does not notice.
 */
export function assetVersion(dir = PUBLIC_DIR): string {
  const hash = createHash("sha1");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) hash.update(file).update(fs.readFileSync(path.join(dir, file)));
  return hash.digest("hex").slice(0, 10);
}

/** The page with ?v=<version> on the URL of each of its own scripts (the vendored libraries have versions of their own). */
export const stampScripts = (html: string, version: string): string =>
  html.replace(/(<script\s+src="\/)([^"?#]+\.js)"/g, (match, head: string, file: string) => (file.startsWith("vendor/") ? match : `${head}${file}?v=${version}"`));

function serveStatic(pathname: string, res: http.ServerResponse): void {
  let root = PUBLIC_DIR;
  let name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (name.startsWith("vendor/monaco/")) {
    root = MONACO_DIR;
    name = name.slice("vendor/monaco/".length);
  } else if (name.startsWith("vendor/leaflet/")) {
    root = LEAFLET_DIR;
    name = name.slice("vendor/leaflet/".length);
  } else if (name.startsWith("vendor/zxing/")) {
    root = ZXING_DIR;
    name = name.slice("vendor/zxing/".length);
  }
  let full: string;
  try {
    full = path.resolve(root, decodeURIComponent(name));
  } catch {
    full = root;
  }
  if (!full.startsWith(root + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return void res.end("Not found");
  }
  let content = fs.readFileSync(full); // read first: a failure must still be able to send a 500
  if (full === path.join(PUBLIC_DIR, "index.html")) content = Buffer.from(stampScripts(content.toString("utf-8"), assetVersion()));
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  res.end(content);
}

/** A food lookup, its refusals and failures as the status and words the page shows: a bad question is 400, Open Food Facts not answering 502. */
async function foodLookup<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    if (error instanceof FoodInputError) throw new HttpError(400, error.message);
    if (error instanceof FoodSourceError) throw new HttpError(502, error.message);
    throw error;
  }
}

/** The status each kind of failed AI estimate is answered with. */
const FOOD_AI_STATUS: Record<FoodAiErrorKind, number> = { input: 400, unconfigured: 503, busy: 429, limit: 429, refused: 422, upstream: 502 };

/** An AI estimate, its refusals and failures as the status and words the page shows. */
async function foodAiCall<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    if (error instanceof FoodAiError) throw new HttpError(FOOD_AI_STATUS[error.kind], error.message);
    throw error;
  }
}

/** What the Food view shows: one day with its meals, the days of a range for the trend, the foods the form offers again, and whether the AI box works. */
function nutritionView(profile: string, asked: unknown, daysAsked: unknown) {
  const today = localToday(store(), profile);
  let date = today;
  try {
    date = parseDay(asked, today);
  } catch {
    // a date that is not one shows today
  }
  const n = Math.min(90, Math.max(7, Math.floor(Number(daysAsked)) || 30));
  const days = nutritionDays(store(), profile, addDays(today, -(n - 1)), today, today);
  const day = days.find((d) => d.day === date) ?? nutritionDays(store(), profile, date, date, today)[0];
  const goals = getGoals(store(), profile);
  return {
    profile,
    today,
    date,
    meals: MEALS,
    day,
    // the trend carries totals only (and each day's calorie goal, which follows the burn when the person set it so); the entries are in `day`
    days: days.map(({ meals, ...totals }) => ({ ...totals, kcalGoal: kcalGoalOf(goals, totals.activeKcal) })),
    // the daily goals by key, and where the day shown stands against each (the meals' own totals are in `day`)
    goals,
    progress: goalProgress(goals, day, day.activeKcal),
    average: averageOf(days, today),
    recent: recentFoods(store(), profile),
    ai: foodAiStatus(profile, today),
    // false: no Garmin and nothing stored from it, so there is no burn to set the food against
    burn: hasHealth(profile),
  };
}

// ── Today view: the day so far and the days to come, from what the database and the plan files hold ──

/** How many days after today the Today view looks ahead for planned workouts (a week: the same weekday next week is in). */
const AHEAD_DAYS = 7;

/**
 * The workouts the plans put on today and the next 7 days, in date order. One workout in several plan files, or listed twice on
 * a date, shows once. `done` is only said of today: an activity of today that was started from the workout (same Garmin workout id).
 */
function plannedAhead(profile: string, today: string, doneIds: Set<string>) {
  const last = addDays(today, AHEAD_DAYS), byKey = new Map<string, { date: string; path: string; index: number; name: string; type: string | null; seconds: number | null; done: boolean; workout: unknown }>();
  // the plan files first, so that a copy kept in the profile's data folder is the duplicate and the click opens the plan
  const entries = planEntriesFor(profile).sort((x, y) => Number(y.path.startsWith("workout-plans/")) - Number(x.path.startsWith("workout-plans/")));
  for (const { path: file, index, workout } of entries) {
    const seconds = Number(workout.estimatedDurationSeconds) > 0 ? Math.round(Number(workout.estimatedDurationSeconds)) : null;
    const type = typeof workout.workoutType === "string" && workout.workoutType ? workout.workoutType : null;
    for (const date of scheduledDates(workout)) {
      if (date < today || date > last) continue;
      const key = `${date}|${hasId(workout.workoutId) ? workout.workoutId : String(workout.workoutName).toLowerCase()}`;
      const done = date === today && hasId(workout.workoutId) && doneIds.has(String(workout.workoutId));
      const kept = byKey.get(key);
      if (!kept) byKey.set(key, { date, path: file, index, name: workout.workoutName, type, seconds, done, workout }); // the whole workout, for the page to total its steps
      else { kept.type ??= type; kept.seconds ??= seconds; } // the copy may know what the plan does not
    }
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path) || a.index - b.index);
}

/** What the Today view shows. Steps and the rest are null when the day's summary is not stored yet: that is "not synced", never zero. */
function todayView(profile: string) {
  const today = localToday(store(), profile);
  // today's activities by the watch's own clock (a day's start is local, the table's range is GMT), earliest first
  const activities = store().activities.summaries(profile, 40).map(activityRow).filter((a) => a.date === today).sort((a, b) => a.time.localeCompare(b.time));
  const doneIds = new Set(activities.flatMap((a) => (hasId(a.workoutId) ? [String(a.workoutId)] : [])));
  const { readiness } = readinessAt(store(), profile, today);
  const goals = getGoals(store(), profile);
  const { meals, ...food } = nutritionDays(store(), profile, today, today, today)[0];
  return {
    profile,
    today,
    day: store().wellness.metrics(profile, today, today)[0] ?? null,
    progress: store().wellness.progress(profile, today),
    week: intensityWeek(store(), profile, today),
    readiness: { band: readiness.band, score: readiness.score, confidence: readiness.confidence, suggestion: readiness.suggestion },
    workouts: plannedAhead(profile, today, doneIds),
    activities,
    hasActivities: store().activities.counts(profile).total > 0,
    // false: no Garmin and nothing stored from it, so the page leaves out the steps, sleep and readiness
    health: hasHealth(profile),
    food,
    goals,
    foodProgress: goalProgress(goals, food, food.activeKcal),
    sync: wellnessSyncStatus(profile),
  };
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, who: Principal): Promise<void> {
  const route = `${req.method} ${url.pathname}`;
  const queryPath = url.searchParams.get("path");
  const scoped = (logicalPath: unknown) => scopedPath(who, logicalPath);

  switch (route) {
    case "GET /api/files":
      return send(res, 200, { files: listFiles(who) });

    case "GET /api/schema":
      return send(res, 200, workoutSchema());

    case "GET /api/file": {
      const logical = scoped(queryPath);
      const doc = store().get(logical);
      if (!doc) throw new HttpError(404, `File not found: ${logical}`);
      return send(res, 200, { path: logical, text: doc.text, version: doc.version, updatedAt: doc.updatedAt });
    }

    case "PUT /api/file": {
      // Body: { text, version? } to update (409 if the file was saved by someone else since `version`),
      //       { text, create: true } to create (409 if it already exists).
      const body = await readBody(req);
      const logical = scoped(queryPath);
      parseOr400(body.text);
      const meta = body.create
        ? store().put(logical, body.text, { create: true, source: "web", owner: who.admin ? null : who.profile })
        : store().put(logical, body.text, {
            replace: true,
            expectedVersion: typeof body.version === "number" ? body.version : undefined,
            source: "web",
          });
      return send(res, body.create ? 201 : 200, { path: logical, version: meta.version, validation: validateText(body.text) });
    }

    case "DELETE /api/file": {
      const logical = scoped(queryPath);
      store().remove(logical, { source: "web" });
      return send(res, 200, { path: logical, deleted: true });
    }

    case "POST /api/rename": {
      const body = await readBody(req);
      const from = scoped(body.from);
      const to = scoped(body.to);
      const meta = store().rename(from, to);
      return send(res, 200, { from, to, version: meta.version });
    }

    case "POST /api/plans/archive":
      return send(res, 200, await archiveFile(await readBody(req), who));

    case "POST /api/plans/unarchive": {
      const body = await readBody(req);
      const logical = scoped(body.path);
      if (!store().head(logical)) throw new HttpError(404, `File not found: ${logical}`);
      return send(res, 200, unarchivePlan(logical));
    }

    case "GET /api/history": {
      // The versions this document had before its latest save, newest first.
      const logical = scoped(queryPath);
      const current = store().head(logical);
      if (!current) throw new HttpError(404, `File not found: ${logical}`);
      return send(res, 200, { path: logical, current: fileInfo(current), revisions: store().history(logical) });
    }

    case "GET /api/revision": {
      const logical = scoped(queryPath);
      const revision = store().revision(logical, Number(url.searchParams.get("id")));
      if (!revision) throw new HttpError(404, "No such revision");
      return send(res, 200, { path: logical, ...revision });
    }

    case "GET /api/garmin":
      return send(res, 200, garminInfo(who));

    case "GET /api/garmin/devices": {
      const info = garminInfo(who);
      if (!info.enabled) throw new HttpError(409, info.reason ?? "Garmin actions are disabled.");
      const profile = profileFor(who, queryPath && /^data\/[^/]+\//.test(queryPath) ? queryPath : "", url.searchParams.get("profile"));
      requireConnected(profile);
      const outcome = await runCaptured(() => listDevices(profile));
      if (!outcome.ok) throw new HttpError(garminFailure(outcome.error), outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
      return send(res, 200, outcome.value);
    }

    case "POST /api/garmin/action": {
      const { status, payload } = await garminAction(await readBody(req), who);
      return send(res, status, payload);
    }

    case "GET /api/workouts": {
      requireGarmin(who);
      const profile = profileFor(who, "", url.searchParams.get("profile"));
      requireConnected(profile);
      const { value: library } = await viaGarmin(() => listLibraryWorkouts(profile, url.searchParams.get("refresh") === "1"));
      return send(res, 200, { profile, ...workoutRows(library, planEntriesFor(profile)) });
    }

    case "GET /api/activities": {
      const profile = profileOrNull(who, url.searchParams.get("profile"));
      if (!profile) return send(res, 200, { profile: null, activities: [], sync: null });
      return send(res, 200, { profile, activities: store().activities.summaries(profile).map(activityRow), sync: syncStatus(store(), profile) });
    }

    case "GET /api/activities/stats": {
      const profile = profileOrNull(who, url.searchParams.get("profile"));
      if (!profile) return send(res, 200, { profile: null, stats: null });
      return send(res, 200, { profile, stats: lifetimeStats(store().activities, profile) });
    }

    case "GET /api/wellness": {
      const profile = profileOrNull(who, url.searchParams.get("profile"));
      if (!profile) return send(res, 200, { profile: null });
      const today = localToday(store(), profile), asked = url.searchParams.get("date");
      const date = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : today;
      const days = Math.min(90, Math.max(7, Math.floor(Number(url.searchParams.get("days"))) || 30));
      return send(res, 200, {
        profile, today, date,
        ...readinessAt(store(), profile, date),
        ...wellnessRange(store(), profile, addDays(date, -(days - 1)), date),
        stored: store().wellness.rowsOfDay(profile, date),
        sync: wellnessSyncStatus(profile, Math.max(0, Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000)) + days), // all the days the page shows
      });
    }

    case "GET /api/today": {
      const profile = profileOrNull(who, url.searchParams.get("profile"));
      if (!profile) return send(res, 200, { profile: null });
      return send(res, 200, todayView(profile));
    }

    case "GET /api/weight": {
      const profile = profileOrNull(who, url.searchParams.get("profile"));
      if (!profile) return send(res, 200, { profile: null });
      const today = localToday(store(), profile), asked = url.searchParams.get("date");
      const days = Math.min(90, Math.max(7, Math.floor(Number(url.searchParams.get("days"))) || 60));
      const range = bodyRange(store(), profile, addDays(today, -(days - 1)), today);
      // the day whose stored responses are listed: the one asked for, else the last weigh-in, else today
      const date = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : range.body.latest?.day ?? today;
      return send(res, 200, { profile, today, date, ...range, stored: store().wellness.rowsOfDay(profile, date), sync: wellnessSyncStatus(profile, days) });
    }

    case "GET /api/foods/search": {
      // Foods by name from Open Food Facts, with their nutrition per 100 g. The server asks them; nothing about the person is sent.
      return send(res, 200, { foods: await foodLookup(() => searchFoods(url.searchParams.get("q"))) });
    }

    case "GET /api/foods/barcode": {
      // The food of a scanned barcode; null when Open Food Facts has none.
      return send(res, 200, { food: await foodLookup(() => lookupBarcode(store(), url.searchParams.get("code"))) });
    }

    case "POST /api/foods/ai": {
      // Foods estimated from words and photos by Claude. Nothing is logged: the page shows the estimate and logs what is kept with POST /api/nutrition.
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      return send(res, 200, await foodAiCall(() => estimateFoods({ profile, text: body.text, images: body.images, defaultMeal: body.defaultMeal, today: localToday(store(), profile) })));
    }

    case "GET /api/nutrition": {
      const profile = profileOrNull(who, url.searchParams.get("profile"));
      if (!profile) return send(res, 200, { profile: null });
      return send(res, 200, nutritionView(profile, url.searchParams.get("date"), url.searchParams.get("days")));
    }

    case "POST /api/nutrition": {
      // The food log: add the foods of a meal, copy logged foods to today, change one entry, delete some. It touches the database
      // only, never Garmin. The answer is the day shown (`date` when given) and the ids of the foods just written (`added`), to undo.
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      const today = localToday(store(), profile);
      let date: string, added: number[] = [];
      try {
        if (body.action === "add") {
          const rows = addFoods(store(), profile, body, today, "web");
          date = rows[0].day; added = rows.map((r) => r.id);
        } else if (body.action === "copy") {
          date = parseDay(body.date, today); // checked first: a refused request writes nothing
          added = copyFoods(store(), profile, body.ids, today, "web").map((r) => r.id);
        } else if (body.action === "update") date = changeFood(store(), profile, Number(body.id), body).day;
        else if (body.action === "delete") {
          const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(Number);
          if (!ids.length || ids.length > MAX_ITEMS) throw new NutritionError(`Delete from 1 to ${MAX_ITEMS} foods at a time.`);
          const asked = body.date ? parseDay(body.date, today) : null, found = store().nutrition.get(profile, ids[0]);
          deleteFoods(store(), profile, ids);
          date = asked ?? found?.day ?? today;
        } else throw new HttpError(400, `Unknown action "${body.action}".`);
      } catch (error) {
        if (error instanceof NutritionError) throw new HttpError(400, error.message);
        throw error;
      }
      return send(res, 200, { ...nutritionView(profile, date, body.days), added });
    }

    case "GET /api/settings": {
      const profile = profileOrNull(who, url.searchParams.get("profile"));
      if (!profile) return send(res, 200, { profile: null });
      return send(res, 200, settingsView(store(), profile));
    }

    case "POST /api/settings/garmin": {
      // The Garmin login of a profile (optional): saved in the database, checked or removed.
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      let result: Record<string, unknown> = {};
      try {
        if (body.action === "save") saveGarminLogin(store(), profile, body);
        else if (body.action === "remove") removeGarminLogin(store(), profile);
        else if (body.action === "test") {
          if (getSettings().mock) throw new HttpError(409, "Mock mode: Garmin writes are disabled.");
          result = await testGarminLogin(profile);
        } else throw new HttpError(400, `Unknown action "${body.action}".`);
      } catch (error) {
        if (error instanceof SettingsError) throw new HttpError(400, error.message);
        throw error;
      }
      return send(res, 200, { ...result, ...settingsView(store(), profile) });
    }

    case "POST /api/settings/goals": {
      // The daily food goals of a profile: a patch of calories, macros and nutrients (a number sets, null removes, a key left out stays), or all cleared.
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      try {
        if (body.action === "save") setGoals(store(), profile, body.goals);
        else if (body.action === "clear") store().goals.set(profile, {});
        else throw new HttpError(400, `Unknown action "${body.action}".`);
      } catch (error) {
        if (error instanceof NutritionError) throw new HttpError(400, error.message);
        throw error;
      }
      return send(res, 200, settingsView(store(), profile));
    }

    case "POST /api/settings/web": {
      // The password the profile signs in to the web editor with, typed twice (password, confirm). It is mandatory: it can be changed, not removed.
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      try {
        if (body.action === "save") saveWebPassword(store(), profile, body);
        else throw new HttpError(400, `Unknown action "${body.action}".`);
      } catch (error) {
        if (error instanceof SettingsError) throw new HttpError(400, error.message);
        throw error;
      }
      return send(res, 200, settingsView(store(), profile));
    }

    case "POST /api/profiles": {
      // A new profile: a name and the password it signs in with, typed twice (name, password, confirm). Garmin and Renpho are connected
      // afterwards, in Settings, if the person wants them. Once a profile has a password the editor asks for a sign-in.
      if (!who.admin) throw new HttpError(403, "Only the admin login can add a profile.");
      const body = await readBody(req);
      // a name is taken whatever its case: "med" next to "MED" would be two folders the lookups cannot tell apart
      const wanted = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
      const taken = wanted ? getAvailableProfiles().find((p) => p.toLowerCase() === wanted) : undefined;
      if (taken) throw new HttpError(409, `Profile "${taken}" exists already.`);
      let name: string;
      try {
        name = createProfile(store(), body);
      } catch (error) {
        if (error instanceof SettingsError) throw new HttpError(400, error.message);
        throw error;
      }
      return send(res, 201, { name, ...garminInfo(who) });
    }

    case "POST /api/settings/renpho": {
      // The Renpho scale's login and sync: settings, a login check, a run now, or clearing what is kept.
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      let result: Record<string, unknown> = {};
      try {
        if (body.action === "save") saveRenpho(store(), profile, body);
        else if (body.action === "remove") removeRenpho(store(), profile);
        else if (body.action === "test") result = await testRenphoLogin(store(), profile);
        else if (body.action === "sync") result = { run: await runRenpho(profile, true) };
        else if (body.action === "clear-log") store().renpho.clearLog(profile);
        else if (body.action === "clear-weighins") store().renpho.clearMeasurements(profile);
        else throw new HttpError(400, `Unknown action "${body.action}".`);
      } catch (error) {
        if (error instanceof SettingsError) throw new HttpError(400, error.message);
        throw error;
      }
      return send(res, 200, { ...result, ...settingsView(store(), profile) });
    }

    case "GET /api/settings/renpho/fit": {
      // The newest weigh-ins as a FIT file, to try an import on Garmin Connect's website by hand.
      const profile = profileOrNull(who, url.searchParams.get("profile"));
      const count = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("count"))) || 3));
      const fit = profile ? recentFit(store(), profile, count) : null;
      if (!profile || !fit) throw new HttpError(404, "No weigh-in is kept yet: run a sync first.");
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="renpho-${localToday(store(), profile)}.fit"`, "Cache-Control": "no-store" });
      return void res.end(Buffer.from(fit.bytes));
    }

    case "GET /api/wellness/raw": {
      const profile = profileOrNull(who, url.searchParams.get("profile"));
      const day = url.searchParams.get("date") ?? "", kind = url.searchParams.get("kind") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !(WELLNESS_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "Missing or invalid date or kind");
      const found = profile ? store().wellness.get(profile, day, kind as WellnessKind) : null;
      if (!profile || !found) throw new HttpError(404, `No ${kind} data is stored for ${day}.`);
      return send(res, 200, { profile, date: day, kind, fetchedAt: found.fetchedAt, data: found.data });
    }

    case "POST /api/wellness/sync": {
      // Fetches the last days' sleep, HRV and summary now, and starts the background fill of the rest.
      requireGarmin(who);
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      requireConnected(profile);
      // the Weight view's button asks for the weigh-ins again: one may have been added on Garmin since the empty answer was stored
      if (body.rereadWeight === true) rereadWeighIns(profile);
      // manual: a Sync button, which fetches every kind and keeps today's responses a minute; the look a view takes on opening is not (five
      // minutes, the kinds a readiness is made of). days: how far back the page shows, so a button fills in all of it, not only the days kept
      const manual = body.manual === true, span = manual ? Math.floor(Number(body.days)) || 0 : 0;
      const refreshed = await refreshWellness(profile, { manual });
      const background = startBackgroundWellness(profile, span);
      return send(res, 200, { ...refreshed, background, sync: wellnessSyncStatus(profile, span) });
    }

    case "GET /api/activity": {
      const profile = profileOrNull(who, url.searchParams.get("profile"));
      const id = url.searchParams.get("id") ?? "";
      if (!/^[\w-]+$/.test(id)) throw new HttpError(400, "Missing or invalid activity id");
      const found = profile ? store().activities.get(profile, id) : undefined;
      if (!profile || !found) throw new HttpError(404, `Activity ${id} is not stored.`);
      return send(res, 200, activityDetail(profile, found));
    }

    case "POST /api/activities/sync": {
      // Asks Garmin for what is new. history: true also starts the background fill of the whole history and the details.
      requireGarmin(who);
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      requireConnected(profile);
      const refreshed = await refreshActivities(profile);
      const background = body.history === true ? startBackgroundSync(profile) : null;
      return send(res, 200, { ...refreshed, background, sync: syncStatus(store(), profile) });
    }

    case "POST /api/activities/chart": {
      requireGarmin(who);
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      requireConnected(profile);
      const id = String(body.id ?? "");
      if (!/^[\w-]+$/.test(id) || !store().activities.get(profile, id)) throw new HttpError(404, `Activity ${id} is not stored.`);
      const fetched = await fetchChartNow(profile, id);
      return send(res, 200, { ...activityDetail(profile, store().activities.get(profile, id)!), fetched });
    }

    case "POST /api/activities/detail": {
      requireGarmin(who);
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      requireConnected(profile);
      const id = String(body.id ?? "");
      if (!/^[\w-]+$/.test(id) || !store().activities.get(profile, id)) throw new HttpError(404, `Activity ${id} is not stored.`);
      const fetched = await fetchDetailsNow(profile, [id]);
      return send(res, 200, { ...activityDetail(profile, store().activities.get(profile, id)!), fetched });
    }

    case "GET /api/runs": {
      // From the saved activity files alone, like the calendar: no Garmin login needed.
      let profile: string | null = null;
      try {
        profile = profileFor(who, "", url.searchParams.get("profile"));
      } catch {
        // no usable profile: nothing to learn a pace from
      }
      return send(res, 200, { profile, runs: profile ? recentRuns(profile) : [] });
    }

    case "GET /api/calendar":
      // Read from the stored plans alone, so it works without a Garmin profile and in mock mode.
      return send(res, 200, { plans: calendarPlans(who) });

    case "GET /api/garmin/workout": {
      requireGarmin(who);
      const id = url.searchParams.get("id") ?? "";
      if (!/^[\w-]+$/.test(id)) throw new HttpError(400, "Missing or invalid workout id");
      const profile = profileFor(who, "", url.searchParams.get("profile"));
      requireConnected(profile);
      const { value: workout } = await viaGarmin(() => getLibraryWorkout(profile, id));
      if (!workout) throw new HttpError(404, `Workout ${id} not found on Garmin.`);
      const plans = planEntriesFor(profile)
        .filter((e) => sameId(e.workout.workoutId, id))
        .map((e) => {
          let differences: string[];
          try {
            differences = diffPlanWorkout(e.workout, workout);
          } catch (error) {
            differences = [`Could not compare: ${(error as Error).message}`];
          }
          return { path: e.path, index: e.index, version: e.version, workout: e.workout, differences };
        });
      return send(res, 200, { profile, workout, plans });
    }

    case "POST /api/garmin/workout":
      return send(res, 201, await createWorkout(await readBody(req), who));

    case "PUT /api/garmin/workout":
      return send(res, 200, await updateWorkout(await readBody(req), who));

    case "DELETE /api/garmin/workout":
      return send(res, 200, await deleteWorkout(await readBody(req), who));

    case "POST /api/garmin/status": {
      // Is each workout of a plan up to date on Garmin? Body: { path, text? (unsaved editor content), profile?, refresh? }.
      const body = await readBody(req);
      requireGarmin(who);
      const logical = scoped(body.path);
      let text = body.text;
      if (typeof text !== "string") {
        const doc = store().get(logical);
        if (!doc) throw new HttpError(404, `File not found: ${logical}`);
        text = doc.text;
      }
      const data: any = parseOr400(text);
      const workouts = Array.isArray(data) ? data : Array.isArray(data?.workouts) ? data.workouts : null;
      if (!workouts) return send(res, 200, { statuses: [] });
      const profile = profileFor(who, logical, body.profile);
      requireConnected(profile);
      const { value: statuses } = await viaGarmin(() => checkWorkoutSync(profile, workouts, body.refresh === true));
      return send(res, 200, { profile, statuses });
    }

    case "POST /api/validate": {
      const body = await readBody(req);
      return send(res, 200, { validation: validateText(body.text) });
    }

    default:
      throw new HttpError(404, "Unknown API route");
  }
}

export function startWebServer(options: WebServerOptions): Promise<http.Server> {
  if (!isLoopback(options.host) && !options.token && profilesWithWebPassword().length === 0) {
    throw new Error("WEB_AUTH_TOKEN (or a profile with a web sign-in password) is required when binding to a non-loopback host.");
  }
  // Checked per request: a web sign-in password set or removed in Settings applies without a restart.
  const authRequired = () => !!options.token || profilesWithWebPassword().length > 0;

  // Wrong passwords per client address. A password is checked with scrypt, so a flood of guesses is slowed, and each costs the same.
  const throttle = new LoginThrottle();
  const trustProxy = options.trustProxy ?? trustProxyOf(process.env.TRUST_PROXY);

  /**
   * Who a user name and secret stand for. A profile name matches in any case; the token is the admin login. A wrong guess from an
   * address that has made too many waits (429), and takes as long whichever name it was made with, so the time says nothing.
   */
  const verify = async (req: http.IncomingMessage, user: string, secret: string): Promise<Principal | null> => {
    const address = clientAddress(req.headers, req.socket.remoteAddress ?? "", trustProxy);
    const wait = throttle.waitMs(address);
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      throw new HttpError(429, `Too many wrong passwords. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`, { retryAfter: seconds }, { "Retry-After": String(seconds) });
    }
    const profile = user ? findProfile(user) : undefined;
    let who: Principal | null = null;
    if (profile && (await store().profiles.checkWebPasswordAsync(profile, secret))) who = { admin: false, profile };
    else if (options.token && sameSecret(secret, options.token)) who = ADMIN;
    else if (!profile) await decoyCheck(secret); // no such profile: spend what a real check would
    if (who) throttle.clear(address);
    else throttle.fail(address);
    return who;
  };

  // Logins made through the form, kept in the database so they outlive a restart. A session ends when it has gone unused for
  // SESSION_IDLE_MS, SESSION_MAX_MS after the sign-in, on logout, or when the secret it was made with changes (a changed or removed
  // web sign-in password), just as Basic credentials stop working then.
  const idHashOf = (id: string) => createHash("sha256").update(id).digest("hex");
  /** What ties a session to the secret it was made with; the id hash salts it, so the table holds no bare hash of the token. */
  const bindingOf = (idHash: string, secret: string) => createHash("sha256").update(`${idHash}:${secret}`).digest("hex");
  const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const expiryFor = (createdAt: number, now: number) => Math.min(now + SESSION_IDLE_MS, createdAt + SESSION_MAX_MS);
  const currentSecret = (who: Principal) => (who.admin ? options.token : (store().profiles.webPasswordHash(who.profile) ?? undefined));

  const cookieValue = (req: http.IncomingMessage, name: string): string | undefined => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const eq = part.indexOf("=");
      if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return undefined;
  };
  const setCookie = (req: http.IncomingMessage, name: string, value: string, maxAgeMs: number): string => {
    const secure = req.headers["x-forwarded-proto"] === "https" || (req.socket as { encrypted?: boolean }).encrypted;
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`;
  };
  /** Who the session cookie stands for. A session in use is renewed once a day: its expiry moves out and the cookie is sent again. */
  const sessionOf = (req: http.IncomingMessage, res: http.ServerResponse): Principal | null => {
    const id = cookieValue(req, SESSION_COOKIE);
    if (!id) return null;
    const idHash = idHashOf(id);
    const session = store().sessions.get(idHash);
    if (!session) return null;
    const who: Principal | null = session.admin ? ADMIN : session.profile ? { admin: false, profile: session.profile } : null;
    const secret = who && currentSecret(who);
    const now = Date.now();
    if (!who || !secret || session.expiresAt < now || !sameHex(bindingOf(idHash, secret), session.bound)) {
      store().sessions.delete(idHash);
      return null;
    }
    if (now - session.renewedAt >= SESSION_RENEW_AFTER_MS) {
      const expiresAt = expiryFor(session.createdAt, now);
      if (expiresAt > session.expiresAt) {
        try {
          store().sessions.renew(idHash, expiresAt, now);
          res.setHeader("Set-Cookie", setCookie(req, SESSION_COOKIE, id, expiresAt - now));
        } catch (error) {
          console.error("[web] session renewal failed (the next request tries again):", error); // the request itself is fine
        }
      }
    }
    return who;
  };

  const authenticate = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<Principal | null> => {
    if (!authRequired()) return ADMIN;
    const session = sessionOf(req, res);
    if (session) return session;
    if (cookieValue(req, SIGNED_OUT_COOKIE)) return null; // signed out of this browser; scripts carry no cookies
    const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (!m) return null;
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return await verify(req, colon < 0 ? "" : decoded.slice(0, colon), decoded.slice(colon + 1));
  };

  async function login(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (!authRequired()) return send(res, 200, { authRequired: false, user: userInfo(ADMIN) });
    const user = typeof body.user === "string" ? body.user.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const who = password ? await verify(req, user, password) : null;
    if (!who) throw new HttpError(401, "Wrong user name or password.");
    const now = Date.now();
    const id = randomBytes(32).toString("hex");
    const idHash = idHashOf(id);
    store().sessions.create(idHash, { admin: who.admin, profile: who.profile ?? null }, bindingOf(idHash, currentSecret(who) ?? ""), expiryFor(now, now), now);
    send(res, 200, { authRequired: true, user: userInfo(who) }, {
      "Set-Cookie": [setCookie(req, SESSION_COOKIE, id, SESSION_IDLE_MS), setCookie(req, SIGNED_OUT_COOKIE, "", 0)],
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return void res.end("ok");
      }
      // Without a token on loopback, reject foreign Host headers (DNS rebinding).
      if (!authRequired() && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host ?? "")) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        return void res.end("Forbidden host");
      }
      // The page and the editor's scripts hold no data, so they load without a login: the page shows the sign-in form itself.
      if (!url.pathname.startsWith("/api/")) {
        return req.method === "GET" ? serveStatic(url.pathname, res) : send(res, 405, { error: "Method not allowed" });
      }
      // Custom header forces a CORS preflight, so other sites can't drive the API from a browser (or sign it in).
      if (req.method !== "GET" && req.headers["x-requested-with"] !== "plan-editor") {
        throw new HttpError(403, "Missing X-Requested-With header");
      }

      const route = `${req.method} ${url.pathname}`;
      if (route === "POST /api/login") return await login(req, res);
      if (route === "POST /api/logout") {
        const id = cookieValue(req, SESSION_COOKIE);
        if (id) store().sessions.delete(idHashOf(id));
        return send(res, 200, { ok: true }, {
          "Set-Cookie": [setCookie(req, SESSION_COOKIE, "", 0), setCookie(req, SIGNED_OUT_COOKIE, "1", SIGNED_OUT_TTL_MS)],
        });
      }
      if (route === "GET /api/session") {
        // 200 even when signed out, so the page can tell "show the form" from a failure.
        const who = await authenticate(req, res);
        return send(res, 200, { authRequired: authRequired(), user: who ? userInfo(who) : null });
      }

      const who = await authenticate(req, res);
      // No WWW-Authenticate: the browser must not open its own login dialog over the form.
      if (!who) return send(res, 401, { error: "Authentication required" });
      await handleApi(req, res, url, who);
    } catch (error) {
      if (res.headersSent) return void res.destroy();
      if (error instanceof HttpError) return send(res, error.status, { error: error.message, ...error.extra }, error.headers);
      if (error instanceof GarminNotConnectedError) return send(res, 409, { error: error.message });
      if (error instanceof StoreError) return send(res, STORE_STATUS[error.code], { error: error.message });
      console.error("[web] error:", error);
      send(res, 500, { error: "Internal error" });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}

if (require.main === module) {
  dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
  installConsoleRedirect(); // capture the editor's console output for the Garmin action log
  const host = process.env.WEB_HOST ?? "127.0.0.1";
  const port = Number(process.env.WEB_PORT ?? 8788);
  startWebServer({ host, port, token: process.env.WEB_AUTH_TOKEN || undefined })
    .then(() => {
      console.log(`Plan editor on http://${host}:${port}  (store: ${store().location})`);
      const plain = store().credentials.plainWarning();
      if (plain) console.warn(`[web] ${plain}`);
      startRenphoTimer(); // the Renpho runs that are due, from the Settings view's switches
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
