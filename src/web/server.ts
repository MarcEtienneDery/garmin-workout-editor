import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import * as dotenv from "dotenv";
import { GarminNotConnectedError, PROJECT_ROOT, findProfile, garminConnected, getAvailableProfiles } from "../shared/profileLoader";
import { type DocMeta, InviteError, type StoreErrorCode, StoreError, WELLNESS_KINDS, type WellnessKind, decoyCheck, getStore, normalizeLogicalPath, profileOfPath, profileReaches } from "../shared/store";
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
import { bodyRange, dayTrend, intakeVsBurn, intensityWeek, readinessAt, readinessDays, wellnessRange } from "../shared/wellnessReport";
import { SettingsError, createInvite, createMcpToken, createProfile, inviteList, removeGarminLogin, removeRenpho, saveGarminLogin, savePrefs, saveRenpho, saveWebPassword, settingsView, signUp } from "../shared/accounts";
import exerciseCategoryMap from "../exercise-category-map.json";
import { recentFit, testRenphoLogin } from "../shared/renphoSync";
import { runRenpho, startRenphoTimer } from "../mcp/tools/renpho";
import { testGarminLogin } from "../mcp/tools/settings";
import { addDays, localToday } from "../shared/wellnessSync";
import { FoodInputError, FoodSourceError, lookupBarcode, searchFoods } from "../shared/foodSearch";
import { FoodAiError, type FoodAiErrorKind, estimateFoods, foodAiStatus } from "../shared/foodAi";
import { MAX_ITEMS, MEALS, NutritionError, addFoods, averageOf, changeFood, copyFoods, deleteFoods, nutritionDays, parseDay, recentFoods } from "../shared/nutrition";
import { WEIGHT_KEY, getGoals, goalProgress, kcalGoalOf, setGoals } from "../shared/nutritionGoals";
import {
  LIBRARY_LIMIT,
  type LibraryWorkout,
  archivePlan,
  checkWorkoutSync,
  deleteLibraryWorkout,
  getLibraryWorkout,
  listDevices,
  listLibraryWorkouts,
  moveScheduledWorkout,
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
const MONACO_DIR = path.join(PROJECT_ROOT, "node_modules", "monaco-editor", "min", "vs");
const LEAFLET_DIR = path.join(PROJECT_ROOT, "node_modules", "leaflet", "dist");
const ZXING_DIR = path.join(PROJECT_ROOT, "node_modules", "@zxing", "library", "umd");
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const SESSION_COOKIE = "plan_editor_session";
const SIGNED_OUT_COOKIE = "plan_editor_signed_out";
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 30 * DAY_MS;
const SESSION_MAX_MS = 90 * DAY_MS;
const SESSION_RENEW_AFTER_MS = DAY_MS;
const SIGNED_OUT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const STORE_STATUS: Record<StoreErrorCode, number> = { not_found: 404, exists: 409, conflict: 409, invalid_path: 400 };
const store = () => getStore();

export interface WebServerOptions {
  host: string;
  port: number;
  token?: string;
  trustProxy?: TrustProxy;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: http.OutgoingHttpHeaders = {}
  ) {
    super(message);
  }
}

export const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "::1" || host === "localhost";

const sha256 = (v: string) => createHash("sha256").update(v).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

export type Principal = { admin: true; profile?: undefined } | { admin: false; profile: string };
const ADMIN: Principal = { admin: true };

const profilesWithWebPassword = (): string[] => store().profiles.withWebPassword();

function canReach(who: Principal, logical: string, owner: string | null): boolean {
  return who.admin || profileReaches(who.profile, logical, owner);
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
  version: number;
  updatedAt: number;
  owner: string | null;
  source: string;
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


const GARMIN_ACTIONS = ["upload", "schedule", "upload_schedule", "send"] as const;
type GarminAction = (typeof GARMIN_ACTIONS)[number];

const userInfo = (who: Principal) =>
  who.admin ? { admin: true } : { admin: false, name: who.profile, ...(store().profiles.welcomePending(who.profile) ? { welcome: true } : {}) };

const hasHealth = (profile: string): boolean => garminConnected(profile) || store().wellness.hasRows(profile);

function profileSources(profile: string) {
  const renpho = store().renpho.counts(profile);
  let renphoLogin = false;
  try {
    renphoLogin = store().credentials.get(profile, "renpho") !== null;
  } catch {
    renphoLogin = true;
  }
  return {
    garmin: garminConnected(profile),
    renpho: renphoLogin,
    webPassword: store().profiles.webPasswordHash(profile) !== null,
    hasActivities: store().activities.counts(profile).total > 0,
    hasWellness: store().wellness.hasRows(profile),
    hasWeight: renpho.total > 0 || store().wellness.hasWeighIn(profile),
  };
}

const visibleProfiles = (who: Principal): string[] => {
  const all = getAvailableProfiles();
  return who.admin ? all : all.filter((p) => p === who.profile);
};

const LIMIT_SHOWN_MS = 24 * 3_600_000;

function syncActivity(who: Principal, now = Date.now()) {
  const running = (state: { holder: string | null; leaseUntil: number | null }) => !!state.holder && (state.leaseUntil ?? 0) > now;
  const profiles = Object.fromEntries(
    visibleProfiles(who).map((profile) => {
      const syncing = [
        running(store().activities.state(profile)) && "activities",
        running(store().wellness.state(profile)) && "wellness",
        running(store().renpho.state(profile)) && "renpho",
      ].filter((kind): kind is string => !!kind);
      const limit = store().limits.get(profile);
      return [profile, { syncing, limit: limit && now - limit.lastAt < LIMIT_SHOWN_MS ? limit : null }];
    })
  );
  return { now, profiles };
}

function garminInfo(who: Principal) {
  const profiles = visibleProfiles(who);
  const mock = getSettings().mock;
  const profileInfo = Object.fromEntries(profiles.map((p) => [p, profileSources(p)]));
  const connected = profiles.filter((p) => profileInfo[p].garmin);
  return {
    enabled: connected.length > 0 && !mock,
    mock,
    profiles,
    connected,
    profileInfo,
    prefs: Object.fromEntries(profiles.map((p) => [p, store().prefs.get(p)])),
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

function profileFor(who: Principal, logical: string, requested: unknown): string {
  if (!who.admin) {
    if (!getAvailableProfiles().includes(who.profile)) throw new HttpError(400, `Unknown profile "${who.profile}".`);
    return who.profile;
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
  let only: number[] | undefined;
  if (body.indexes !== undefined) {
    const count = readPlan(logical)?.list.length ?? 0;
    const ok = Array.isArray(body.indexes) && body.indexes.length > 0 && body.indexes.every((i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < count);
    if (!ok) throw new HttpError(400, `indexes must name the places of workouts in the plan (0 to ${Math.max(0, count - 1)}).`);
    only = [...new Set<number>(body.indexes)];
  }

  const outcome = await runCaptured<unknown>(() => {
    switch (action) {
      case "upload":
        return only ? uploadPlan(profile, logical, false, only) : uploadPlan(profile, logical);
      case "schedule":
        return only ? schedulePlan(profile, logical, only) : schedulePlan(profile, logical);
      case "upload_schedule":
        return only ? uploadAndSchedulePlan(profile, logical, only) : uploadAndSchedulePlan(profile, logical);
      case "send":
        return only ? sendPlanToDevice(profile, logical, deviceId, only) : sendPlanToDevice(profile, logical, deviceId);
    }
  });
  const version = store().head(logical)?.version;
  if (!outcome.ok) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return { status: garminFailure(outcome.error), payload: { error: message, log: outcome.log, profile, version } };
  }
  return { status: 200, payload: { action, profile, result: outcome.value, log: outcome.log, version } };
}


interface PlanEntry {
  path: string;
  index: number;
  version: number;
  workout: any;
}

const isWorkout = (w: any): boolean => !!w && typeof w === "object" && typeof w.workoutName === "string";

function readPlan(logical: string): { data: any; list: any[] } | null {
  try {
    const data: any = JSON.parse(store().get(logical)?.text ?? "");
    const list = Array.isArray(data) ? data : data?.workouts;
    return Array.isArray(list) ? { data, list } : null;
  } catch {
    return null;
  }
}

function planEntriesFor(profile: string): PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const meta of activePlanDocs(store(), profile)) {
    readPlan(meta.path)?.list.forEach((workout, index) => {
      if (isWorkout(workout)) entries.push({ path: meta.path, index, version: meta.version, workout });
    });
  }
  return entries;
}


const EXERCISES = Object.entries(exerciseCategoryMap as Record<string, string>).map(([name, category]) => ({ name, category }));
const MAX_USED = 40;

function usedExercises(profile: string): string[] {
  const counts = new Map<string, number>();
  const visit = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const st of steps) {
      if (!st || typeof st !== "object") continue;
      const name = (st as any).exerciseName;
      if (typeof name === "string" && name) counts.set(name, (counts.get(name) ?? 0) + 1);
      visit((st as any).repeatSteps);
    }
  };
  for (const e of planEntriesFor(profile)) visit(e.workout.steps);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_USED).map(([name]) => name);
}


const isoDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === v;
};

const scheduledDates = (w: any): string[] => [...new Set([w.scheduledDate].flat().filter(isoDate))].sort();

const movedDates = (scheduledDate: unknown, from: string, to: string): string | unknown[] => {
  if (!Array.isArray(scheduledDate)) return to;
  const dates = [...new Set(scheduledDate.map((d) => (d === from ? to : d)))];
  return dates.every((d) => typeof d === "string") ? dates.sort() : dates;
};

interface CalendarPlan {
  path: string;
  owner: string | null;
  weekStart?: string;
  weekEnd?: string;
  start: string | null;
  end: string | null;
  workouts: { index: number; workoutName: string; workoutType?: string; workoutId?: number | string; dates: string[]; workout: Record<string, unknown> }[];
}

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
        ? [{ index, workoutName: w.workoutName, workoutType: w.workoutType, workoutId: hasId(w.workoutId) ? w.workoutId : undefined, dates: scheduledDates(w), workout: w as Record<string, unknown> }]
        : []
    );
    const weekStart = isoDate(plan.data.weekStart) ? plan.data.weekStart : undefined;
    const weekEnd = isoDate(plan.data.weekEnd) ? plan.data.weekEnd : undefined;
    const days = [weekStart, weekEnd, ...workouts.flatMap((w) => w.dates)].filter(isoDate).sort();
    plans.push({ path: meta.path, owner: meta.owner, weekStart, weekEnd, start: days[0] ?? null, end: days[days.length - 1] ?? null, workouts });
  }
  return plans.sort((a, b) => Number(a.start === null) - Number(b.start === null) || (a.start ?? "").localeCompare(b.start ?? "") || a.path.localeCompare(b.path));
}

function doneWorkouts(who: Principal, requested: unknown): string[] {
  let profile: string;
  try {
    profile = profileFor(who, "", requested);
  } catch {
    return [];
  }
  return store().activities.summaries(profile, 600).map(activityRow).flatMap((a) => (hasId(a.workoutId) ? [`${a.workoutId}|${a.date}`] : []));
}


interface RunSample {
  date: string;
  km: number;
  pace: number;
  hr: number;
}

const RUN_WINDOW_DAYS = 120;
const RUN_LIMIT = 60;

function recentRuns(profile: string): RunSample[] {
  const runs: RunSample[] = [];
  for (const a of store().activities.between(profile, { type: "running", limit: 400 })) {
    const pace = a.raw?.averageSpeed > 0 ? 1000 / a.raw.averageSpeed : NaN;
    const km = (a.distance ?? 0) / 1000, hr = a.avgHr ?? 0;
    if (!(km >= 2) || !(pace >= 180 && pace <= 540) || !(hr >= 90 && hr <= 210)) continue;
    runs.push({ date: a.startLocal.slice(0, 10), km: +km.toFixed(1), pace: Math.round(pace), hr: Math.round(hr) });
  }
  if (!runs.length) return [];
  const cutoff = new Date(Date.parse(`${runs[0].date}T00:00:00Z`) - RUN_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  return runs.filter((r) => r.date >= cutoff).slice(0, RUN_LIMIT);
}


function settingsAnswer(profile: string) {
  return { ...settingsView(store(), profile), ai: foodAiStatus(profile, localToday(store(), profile)) };
}

function profileOrNull(who: Principal, requested: unknown): string | null {
  try {
    return profileFor(who, "", requested);
  } catch {
    return null;
  }
}

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
    speedKph: a.type === "cycling" && a.speed && a.speed > 0 ? Math.round(a.speed * 36) / 10 : null,
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

function oneRepMaxes(profile: string, sets: ExerciseSet[] | undefined): Record<string, BestLift> {
  const names = new Set(liftSets(sets).map((x) => x.exerciseName));
  if (!names.size) return {};
  const out: Record<string, BestLift> = {};
  for (const e of lifetimeStats(store().activities, profile).strength?.exercises ?? []) if (e.best && names.has(e.name)) out[e.name] = e.best;
  return out;
}

function activityDetail(profile: string, a: StoredActivity) {
  const raw = a.raw ?? {}, summary = a.detail?.summaryDTO ?? {};
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
    chart: buildChart(store().activities.getChart(profile, a.id)),
    planned: entry ? { path: entry.path, index: entry.index, workout: entry.workout } : null,
  };
}

const hasId = (id: unknown): boolean => id !== undefined && id !== null && id !== "";
const sameId = (a: unknown, b: unknown): boolean => hasId(a) && hasId(b) && String(a) === String(b);

type WorkoutRowState = "garmin-only" | "linked" | "not-uploaded";

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
    dates: string[];
    state: WorkoutRowState;
  }[] = [];
  const datesOf = (list: PlanEntry[]) => [...new Set(list.flatMap((e) => scheduledDates(e.workout)))].sort();

  for (const w of library) {
    const linked = entries.filter((e) => sameId(e.workout.workoutId, w.workoutId));
    rows.push({ key: `g:${w.workoutId}`, ...w, plans: linked.map(ref), dates: datesOf(linked), state: linked.length ? "linked" : "garmin-only" });
  }
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

function requireConnected(profile: string): void {
  if (!garminConnected(profile)) throw new HttpError(409, `Profile "${profile}" has no Garmin login: add one in Settings.`);
}

function requireConfirm(body: any): void {
  if (body.confirm !== true) throw new HttpError(400, "Confirmation required (confirm: true).");
}

const garminFailure = (error: unknown): number => (error instanceof GarminNotConnectedError ? 409 : 502);

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

const ownerHint = (files: PlanFile[]): string => files.find((f) => profileOfPath(f.logical) || f.owner)?.logical ?? "";

const changedFiles = (files: PlanFile[]) => files.map((f) => ({ path: f.logical, version: store().head(f.logical)?.version }));

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
    delete toUpload.workoutId;
    ({ value: saved, log } = await viaGarmin(() => saveWorkout(profile, toUpload, body.schedule === true)));
  }
  const created = saved ? { ...workout, workoutId: saved.workoutId } : { ...workout };
  if (!saved) { if (hasId(body.linkWorkoutId)) created.workoutId = body.linkWorkoutId; else delete created.workoutId; }
  let index: number | undefined;
  if (plan) {
    plan.workouts.push(created);
    index = plan.workouts.length - 1;
    savePlanFile(plan);
  }
  return { workoutId: created.workoutId, path: plan?.logical, index, changed: plan ? changedFiles([plan]) : [], validation, log };
}

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
    for (const { file, index } of targets) delete file.workouts[index].workoutId;
  }
  files.forEach(savePlanFile);
  return { deleted: { garmin: fromGarmin, plans: fromPlans }, changed: changedFiles(files), log };
}

async function moveWorkoutDay(body: any, who: Principal): Promise<unknown> {
  const { from, to } = body;
  if (!isoDate(from) || !isoDate(to)) throw new HttpError(400, "from and to must be days written YYYY-MM-DD.");
  if (from === to) throw new HttpError(400, `The workout is on ${from} already.`);
  if (!Array.isArray(body.plans) || !body.plans.length) throw new HttpError(400, "plans must list the plan entries to move.");
  const { files, targets } = loadPlanTargets(who, body.plans);
  for (const { file, index } of targets) {
    const entry = file.workouts[index];
    if (typeof body.workoutName === "string" && entry.workoutName !== body.workoutName) {
      throw new HttpError(409, `${file.logical} workout #${index + 1} is not "${body.workoutName}" any more. Reload and try again.`);
    }
    if (!scheduledDates(entry).includes(from)) throw new HttpError(409, `"${entry.workoutName}" is not on ${from} in ${file.logical} any more. Reload and try again.`);
  }

  const workoutId = targets.map(({ file, index }) => file.workouts[index].workoutId).find(hasId);
  const garminSide = body.garmin === true ? garminForMove(who, body, files, workoutId) : null;

  for (const { file, index } of targets) file.workouts[index].scheduledDate = movedDates(file.workouts[index].scheduledDate, from, to);
  files.forEach(savePlanFile);
  let garmin: { state: string; reason?: string; log?: string } | undefined;
  if (garminSide && "profile" in garminSide) {
    const outcome = await runCaptured(() => moveScheduledWorkout(garminSide.profile, workoutId, from, to));
    garmin = outcome.ok
      ? { state: outcome.value.moved ? "moved" : "not-scheduled", log: outcome.log }
      : { state: "failed", reason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error), log: outcome.log };
  } else if (garminSide) garmin = { state: "skipped", reason: garminSide.skipped };
  return { from, to, changed: changedFiles(files), garmin };
}

function garminForMove(who: Principal, body: any, files: PlanFile[], workoutId: unknown): { profile: string } | { skipped: string } {
  if (!hasId(workoutId)) return { skipped: "The workout is not on Garmin." };
  if (files.some((f) => store().head(f.logical)?.archivedAt != null)) return { skipped: "The plan is archived." };
  const info = garminInfo(who);
  if (!info.enabled) return { skipped: info.reason ?? "Garmin actions are disabled." };
  let profile: string;
  try {
    profile = profileFor(who, ownerHint(files), body.profile);
  } catch (error) {
    return { skipped: (error as Error).message };
  }
  if (!garminConnected(profile)) return { skipped: `Profile "${profile}" has no Garmin login.` };
  requireConfirm(body);
  return { profile };
}

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
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export function assetVersion(dir = PUBLIC_DIR): string {
  const hash = createHash("sha1");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) hash.update(file).update(fs.readFileSync(path.join(dir, file)));
  return hash.digest("hex").slice(0, 10);
}

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
  let content = fs.readFileSync(full);
  if (full === path.join(PUBLIC_DIR, "index.html")) content = Buffer.from(stampScripts(content.toString("utf-8"), assetVersion()));
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  res.end(content);
}

async function foodLookup<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    if (error instanceof FoodInputError) throw new HttpError(400, error.message);
    if (error instanceof FoodSourceError) throw new HttpError(502, error.message);
    throw error;
  }
}

const FOOD_AI_STATUS: Record<FoodAiErrorKind, number> = { input: 400, unconfigured: 503, busy: 429, limit: 429, refused: 422, upstream: 502 };

async function foodAiCall<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    if (error instanceof FoodAiError) throw new HttpError(FOOD_AI_STATUS[error.kind], error.message);
    throw error;
  }
}

function readinessWeek(profile: string, date: string, today: string) {
  const monday = addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7)), sunday = addDays(monday, 6);
  const known = readinessDays(store(), profile, monday, sunday < today ? sunday : today);
  const byDay = new Map(known.map((d) => [d.day, d]));
  return Array.from({ length: 7 }, (_, i) => { const day = addDays(monday, i); return byDay.get(day) ?? { day, band: "unknown" as const, score: null }; });
}

function weekOf(profile: string, date: string, today: string, goals: ReturnType<typeof getGoals>) {
  const monday = addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
  return nutritionDays(store(), profile, monday, addDays(monday, 6), today).map(({ day, kcal, entries, activeKcal }) => ({ day, kcal, entries, kcalGoal: kcalGoalOf(goals, activeKcal) }));
}

function nutritionView(profile: string, asked: unknown, daysAsked: unknown) {
  const today = localToday(store(), profile);
  let date = today;
  try {
    date = parseDay(asked, today);
  } catch {
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
    days: days.map(({ meals, ...totals }) => ({ ...totals, kcalGoal: kcalGoalOf(goals, totals.activeKcal) })),
    week: weekOf(profile, date, today, goals),
    goals,
    progress: goalProgress(goals, day, day.activeKcal),
    average: averageOf(days, today),
    recent: recentFoods(store(), profile),
    ai: foodAiStatus(profile, today),
    burn: hasHealth(profile),
  };
}


const AHEAD_DAYS = 7;

function plannedAhead(profile: string, today: string, doneIds: Set<string>) {
  const last = addDays(today, AHEAD_DAYS), byKey = new Map<string, { date: string; path: string; index: number; name: string; type: string | null; seconds: number | null; done: boolean; workout: unknown }>();
  const entries = planEntriesFor(profile).sort((x, y) => Number(y.path.startsWith("workout-plans/")) - Number(x.path.startsWith("workout-plans/")));
  for (const { path: file, index, workout } of entries) {
    const seconds = Number(workout.estimatedDurationSeconds) > 0 ? Math.round(Number(workout.estimatedDurationSeconds)) : null;
    const type = typeof workout.workoutType === "string" && workout.workoutType ? workout.workoutType : null;
    for (const date of scheduledDates(workout)) {
      if (date < today || date > last) continue;
      const key = `${date}|${hasId(workout.workoutId) ? workout.workoutId : String(workout.workoutName).toLowerCase()}`;
      const done = date === today && hasId(workout.workoutId) && doneIds.has(String(workout.workoutId));
      const kept = byKey.get(key);
      if (!kept) byKey.set(key, { date, path: file, index, name: workout.workoutName, type, seconds, done, workout });
      else { kept.type ??= type; kept.seconds ??= seconds; }
    }
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path) || a.index - b.index);
}

function todayView(profile: string) {
  const today = localToday(store(), profile);
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
    trend: dayTrend(store(), profile, today),
    readiness: { band: readiness.band, score: readiness.score, confidence: readiness.confidence, suggestion: readiness.suggestion },
    workouts: plannedAhead(profile, today, doneIds),
    activities,
    hasActivities: store().activities.counts(profile).total > 0,
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

    case "POST /api/plans/move":
      return send(res, 200, await moveWorkoutDay(await readBody(req), who));

    case "POST /api/plans/unarchive": {
      const body = await readBody(req);
      const logical = scoped(body.path);
      if (!store().head(logical)) throw new HttpError(404, `File not found: ${logical}`);
      return send(res, 200, unarchivePlan(logical));
    }

    case "GET /api/history": {
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

    case "GET /api/sync-activity":
      return send(res, 200, syncActivity(who));

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
        week: readinessWeek(profile, date, today),
        readinessDays: readinessDays(store(), profile, addDays(date, -(days - 1)), date),
        stored: store().wellness.rowsOfDay(profile, date),
        sync: wellnessSyncStatus(profile, Math.max(0, Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000)) + days),
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
      const date = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : range.body.latest?.day ?? today;
      return send(res, 200, { profile, today, date, ...range, goalKg: getGoals(store(), profile)[WEIGHT_KEY] ?? null, intake: intakeVsBurn(store(), profile, addDays(today, -(days - 1)), today, today), stored: store().wellness.rowsOfDay(profile, date), sync: wellnessSyncStatus(profile, days) });
    }

    case "GET /api/foods/search": {
      return send(res, 200, { foods: await foodLookup(() => searchFoods(url.searchParams.get("q"))) });
    }

    case "GET /api/foods/barcode": {
      return send(res, 200, { food: await foodLookup(() => lookupBarcode(store(), url.searchParams.get("code"))) });
    }

    case "POST /api/foods/ai": {
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
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      const today = localToday(store(), profile);
      let date: string, added: number[] = [];
      try {
        if (body.action === "add") {
          const rows = addFoods(store(), profile, body, today, "web");
          date = rows[0].day; added = rows.map((r) => r.id);
        } else if (body.action === "copy") {
          date = parseDay(body.date, today);
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
      return send(res, 200, settingsAnswer(profile));
    }

    case "POST /api/settings/garmin": {
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      let result: Record<string, unknown> = {};
      try {
        if (body.action === "save") saveGarminLogin(store(), profile, body);
        else if (body.action === "remove") removeGarminLogin(store(), profile);
        else if (body.action === "test") {
          if (getSettings().mock) throw new HttpError(409, "Mock mode: Garmin writes are disabled.");
          result = await testGarminLogin(profile);
          store().credentials.recordCheck(profile, "garmin", result.ok === true, String(result.message ?? ""));
        } else throw new HttpError(400, `Unknown action "${body.action}".`);
      } catch (error) {
        if (error instanceof SettingsError) throw new HttpError(400, error.message);
        throw error;
      }
      return send(res, 200, { ...result, ...settingsAnswer(profile) });
    }

    case "POST /api/settings/goals": {
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
      return send(res, 200, settingsAnswer(profile));
    }

    case "POST /api/settings/prefs": {
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      try {
        savePrefs(store(), profile, body.prefs ?? {});
      } catch (error) {
        if (error instanceof SettingsError) throw new HttpError(400, error.message);
        throw error;
      }
      return send(res, 200, settingsAnswer(profile));
    }

    case "POST /api/settings/web": {
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      try {
        if (body.action === "save") saveWebPassword(store(), profile, body);
        else throw new HttpError(400, `Unknown action "${body.action}".`);
      } catch (error) {
        if (error instanceof SettingsError) throw new HttpError(400, error.message);
        throw error;
      }
      return send(res, 200, settingsAnswer(profile));
    }

    case "GET /api/invites": {
      if (!who.admin) throw new HttpError(403, "Only the admin login can see the invites.");
      return send(res, 200, { invites: inviteList(store()) });
    }

    case "POST /api/invites": {
      if (!who.admin) throw new HttpError(403, "Only the admin login can make invites.");
      const body = await readBody(req);
      let created: string | undefined;
      try {
        if (body.action === "create") created = createInvite(store(), body);
        else if (body.action === "revoke" || body.action === "remove") {
          const done = body.action === "revoke" ? store().invites.revoke(body.code) : store().invites.remove(body.code);
          if (!done) throw new HttpError(404, "No such invite.");
        } else throw new HttpError(400, `Unknown action "${body.action}".`);
      } catch (error) {
        if (error instanceof SettingsError) throw new HttpError(400, error.message);
        throw error;
      }
      return send(res, created ? 201 : 200, { ...(created ? { created } : {}), invites: inviteList(store()) });
    }

    case "POST /api/welcome": {
      const body = await readBody(req);
      if (body.action !== "done") throw new HttpError(400, `Unknown action "${body.action}".`);
      if (!who.admin) store().profiles.setWelcomePending(who.profile, false);
      return send(res, 200, { user: userInfo(who) });
    }

    case "POST /api/profiles": {
      if (!who.admin) throw new HttpError(403, "Only the admin login can add a profile.");
      const body = await readBody(req);
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

    case "POST /api/settings/mcp": {
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      let token: string | undefined;
      if (body.action === "create") token = createMcpToken(store(), profile);
      else if (body.action === "remove") store().mcpTokens.remove(profile);
      else throw new HttpError(400, `Unknown action "${body.action}".`);
      return send(res, 200, { ...(token ? { token } : {}), ...settingsView(store(), profile) });
    }

    case "POST /api/settings/renpho": {
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
      return send(res, 200, { ...result, ...settingsAnswer(profile) });
    }

    case "GET /api/settings/renpho/fit": {
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
      requireGarmin(who);
      const body = await readBody(req);
      const profile = profileFor(who, "", body.profile);
      requireConnected(profile);
      if (body.rereadWeight === true) rereadWeighIns(profile);
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
      let profile: string | null = null;
      try {
        profile = profileFor(who, "", url.searchParams.get("profile"));
      } catch {
      }
      return send(res, 200, { profile, runs: profile ? recentRuns(profile) : [] });
    }

    case "GET /api/exercises": {
      const profile = profileOrNull(who, url.searchParams.get("profile"));
      return send(res, 200, { profile, exercises: EXERCISES, used: profile ? usedExercises(profile) : [] });
    }

    case "GET /api/calendar":
      return send(res, 200, { plans: calendarPlans(who), done: doneWorkouts(who, url.searchParams.get("profile")) });

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
  const authRequired = () => !!options.token || profilesWithWebPassword().length > 0;

  const throttle = new LoginThrottle();
  const trustProxy = options.trustProxy ?? trustProxyOf(process.env.TRUST_PROXY);

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
    else if (!profile) await decoyCheck(secret);
    if (who) throttle.clear(address);
    else throttle.fail(address);
    return who;
  };

  const inviteThrottle = new LoginThrottle();
  const inviteAddress = (req: http.IncomingMessage) => clientAddress(req.headers, req.socket.remoteAddress ?? "", trustProxy);
  const inviteWait = (address: string) => {
    const wait = inviteThrottle.waitMs(address);
    if (wait <= 0) return;
    const seconds = Math.ceil(wait / 1000);
    throw new HttpError(429, `Too many wrong invite codes. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`, { retryAfter: seconds }, { "Retry-After": String(seconds) });
  };

  const idHashOf = (id: string) => createHash("sha256").update(id).digest("hex");
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
          console.error("[web] session renewal failed (the next request tries again):", error);
        }
      }
    }
    return who;
  };

  const authenticate = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<Principal | null> => {
    if (!authRequired()) return ADMIN;
    const session = sessionOf(req, res);
    if (session) return session;
    if (cookieValue(req, SIGNED_OUT_COOKIE)) return null;
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
    startSession(req, res, who, 200);
  }

  function startSession(req: http.IncomingMessage, res: http.ServerResponse, who: Principal, status: number): void {
    const now = Date.now();
    const id = randomBytes(32).toString("hex");
    const idHash = idHashOf(id);
    store().sessions.create(idHash, { admin: who.admin, profile: who.profile ?? null }, bindingOf(idHash, currentSecret(who) ?? ""), expiryFor(now, now), now);
    send(res, status, { authRequired: true, user: userInfo(who) }, {
      "Set-Cookie": [setCookie(req, SESSION_COOKIE, id, SESSION_IDLE_MS), setCookie(req, SIGNED_OUT_COOKIE, "", 0)],
    });
  }

  async function checkInvite(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const address = inviteAddress(req);
    inviteWait(address);
    const problem = store().invites.check(url.searchParams.get("code"));
    if (problem === "active") return send(res, 200, { valid: true });
    inviteThrottle.fail(address);
    throw new HttpError(404, new InviteError(problem).message, { valid: false, problem });
  }

  async function signup(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    const address = inviteAddress(req);
    inviteWait(address);
    let name: string;
    try {
      name = signUp(store(), body);
    } catch (error) {
      if (error instanceof InviteError) {
        inviteThrottle.fail(address);
        throw new HttpError(403, error.message, { problem: error.problem });
      }
      if (error instanceof SettingsError) throw new HttpError(400, error.message);
      throw error;
    }
    startSession(req, res, { admin: false, profile: name }, 201);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return void res.end("ok");
      }
      if (!authRequired() && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host ?? "")) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        return void res.end("Forbidden host");
      }
      if (!url.pathname.startsWith("/api/")) {
        return req.method === "GET" ? serveStatic(url.pathname, res) : send(res, 405, { error: "Method not allowed" });
      }
      if (req.method !== "GET" && req.headers["x-requested-with"] !== "plan-editor") {
        throw new HttpError(403, "Missing X-Requested-With header");
      }

      const route = `${req.method} ${url.pathname}`;
      if (route === "POST /api/login") return await login(req, res);
      if (route === "POST /api/signup") return await signup(req, res);
      if (route === "GET /api/invite") return await checkInvite(req, res, url);
      if (route === "POST /api/logout") {
        const id = cookieValue(req, SESSION_COOKIE);
        if (id) store().sessions.delete(idHashOf(id));
        return send(res, 200, { ok: true }, {
          "Set-Cookie": [setCookie(req, SESSION_COOKIE, "", 0), setCookie(req, SIGNED_OUT_COOKIE, "1", SIGNED_OUT_TTL_MS)],
        });
      }
      if (route === "GET /api/session") {
        const who = await authenticate(req, res);
        return send(res, 200, { authRequired: authRequired(), user: who ? userInfo(who) : null });
      }

      const who = await authenticate(req, res);
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
  installConsoleRedirect();
  const host = process.env.WEB_HOST ?? "127.0.0.1";
  const port = Number(process.env.WEB_PORT ?? 8788);
  startWebServer({ host, port, token: process.env.WEB_AUTH_TOKEN || undefined })
    .then(() => {
      console.log(`Plan editor on http://${host}:${port}  (store: ${store().location})`);
      const plain = store().credentials.plainWarning();
      if (plain) console.warn(`[web] ${plain}`);
      startRenphoTimer();
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
