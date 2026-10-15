/**
 * web/server.ts — small web UI to manage plan files (CRUD + Monaco JSON editor).
 *
 *   npm run web                      # http://127.0.0.1:8788
 *   WEB_PORT=8788 WEB_HOST=0.0.0.0 WEB_AUTH_TOKEN=... npm run web
 *
 * Reaches the same files as the MCP plan tools ("workout-plans/*.json" and
 * "data/<profile>/*.json") through the same path guard. Non-loopback binds
 * require WEB_AUTH_TOKEN (HTTP Basic auth: any user name, the token as password).
 *
 * The Garmin actions (upload / schedule / send to device) reuse the MCP tool
 * bodies, so they need the profile credentials (GARMIN_PROFILES_DIR) and are
 * disabled when no profile is configured or in mock mode.
 *
 * The Workouts view lists the Garmin library next to the workouts of the plan files
 * (GET /api/workouts), compares plan workouts with their Garmin copy (POST /api/garmin/status)
 * and creates / replaces / deletes workouts in the plan files and on Garmin together
 * (POST, PUT, DELETE /api/garmin/workout). Each write that touches Garmin needs confirm: true.
 *
 * Logins (HTTP Basic): user = a profile name, password = WEB_PASSWORD from that
 * profile's .env.<profile> -> sees only data/<profile>/ (plus the shared
 * workout-plans/) and its Garmin actions run as that profile. WEB_AUTH_TOKEN
 * as the password (any user name) is the admin login with full access.
 */
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { createHash, timingSafeEqual } from "crypto";
import * as dotenv from "dotenv";
import { PROJECT_ROOT, getAvailableProfiles, getDataRoot, getProfilesDir } from "../shared/profileLoader";
import {
  getPlansDir,
  getSettings,
  resolveDataPath,
  resolveProfileName,
  runCaptured,
  toLogicalPath,
} from "../mcp/context";
import { installConsoleRedirect } from "../mcp/logCapture";
import { diffPlanWorkout, extractWorkouts, validatePlanData } from "../mcp/tools/plans";
import {
  LIBRARY_LIMIT,
  type LibraryWorkout,
  checkWorkoutSync,
  deleteLibraryWorkout,
  getLibraryWorkout,
  listDevices,
  listLibraryWorkouts,
  saveWorkout,
  schedulePlan,
  sendPlanToDevice,
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
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const PROFILE_DIR_REGEX = /^[a-zA-Z0-9_-]+$/;

export interface WebServerOptions {
  host: string;
  port: number;
  /** Optional shared secret (HTTP Basic password). Required unless host is loopback. */
  token?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Extra fields for the JSON error body (e.g. the Garmin log). */
    readonly extra: Record<string, unknown> = {}
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

/** WEB_PASSWORD from a profile's .env file; read per request so edits apply without a restart. */
function profileWebPassword(name: string): string | undefined {
  try {
    const file = path.join(getProfilesDir(), `.env.${name}`);
    return dotenv.parse(fs.readFileSync(file, "utf8")).WEB_PASSWORD || undefined;
  } catch {
    return undefined;
  }
}
const profilesWithWebPassword = (): string[] => getAvailableProfiles().filter((p) => profileWebPassword(p));

/** A profile login may only reach its own data/<profile>/ folder (workout-plans/ is shared). */
function assertScope(who: Principal, logical: string): void {
  if (who.admin || !logical.startsWith("data/")) return;
  if (!logical.startsWith(`data/${who.profile}/`)) {
    throw new HttpError(403, `${logical} belongs to another profile.`);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

function resolveOr400(logicalPath: unknown): { logical: string; absolute: string } {
  if (typeof logicalPath !== "string" || !logicalPath) throw new HttpError(400, "Missing path");
  try {
    const absolute = resolveDataPath(logicalPath);
    return { logical: toLogicalPath(absolute), absolute };
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}

function writeTextAtomic(absolute: string, text: string): void {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const tmp = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, absolute);
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
  mtimeMs: number;
  workoutCount?: number;
  weekStart?: string;
  weekEnd?: string;
}

function describe(absolute: string): FileInfo {
  const stat = fs.statSync(absolute);
  const info: FileInfo = { path: toLogicalPath(absolute), size: stat.size, mtimeMs: stat.mtimeMs };
  if (stat.size < 5 * 1024 * 1024) {
    try {
      const data: any = JSON.parse(fs.readFileSync(absolute, "utf8"));
      const workouts = Array.isArray(data) ? data : data?.workouts;
      if (Array.isArray(workouts)) info.workoutCount = workouts.length;
      if (typeof data?.weekStart === "string") info.weekStart = data.weekStart;
      if (typeof data?.weekEnd === "string") info.weekEnd = data.weekEnd;
    } catch {
      /* listed anyway; the editor will flag it */
    }
  }
  return info;
}

function jsonFilesIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith("."))
    .map((e) => path.join(dir, e.name));
}

function listFiles(who: Principal): FileInfo[] {
  const dataRoot = getDataRoot();
  const profileDirs = fs.existsSync(dataRoot)
    ? fs
        .readdirSync(dataRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && PROFILE_DIR_REGEX.test(e.name) && (who.admin || e.name === who.profile))
        .map((e) => path.join(dataRoot, e.name))
    : [];
  return [getPlansDir(), ...profileDirs]
    .flatMap(jsonFilesIn)
    .map(describe)
    .sort((a, b) => a.path.localeCompare(b.path));
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

function garminInfo(who: Principal) {
  const all = getAvailableProfiles();
  const profiles = who.admin ? all : all.filter((p) => p === who.profile);
  const mock = getSettings().mock;
  return {
    enabled: profiles.length > 0 && !mock,
    mock,
    profiles,
    user: who.admin ? { admin: true } : { admin: false, name: who.profile },
    defaultProfile: who.admin
      ? (getSettings().defaultProfile ?? (profiles.length === 1 ? profiles[0] : null))
      : who.profile,
    reason: mock
      ? "Mock mode: Garmin writes are disabled."
      : profiles.length === 0
        ? "No Garmin profiles configured (mount the .env.<profile> files at GARMIN_PROFILES_DIR)."
        : null,
  };
}

/** data/<PROFILE>/... files belong to that profile; plans in workout-plans/ need an explicit or default one. */
function profileFor(who: Principal, logical: string, requested: unknown): string {
  if (!who.admin) {
    if (!getAvailableProfiles().includes(who.profile)) throw new HttpError(400, `Unknown Garmin profile "${who.profile}".`);
    return who.profile; // a profile login always acts as itself
  }
  const owner = /^data\/([^/]+)\//.exec(logical)?.[1];
  const name = owner ?? (typeof requested === "string" && requested ? requested : undefined);
  let resolved: string;
  try {
    resolved = resolveProfileName(name);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  if (!getAvailableProfiles().includes(resolved)) throw new HttpError(400, `Unknown Garmin profile "${resolved}".`);
  return resolved;
}

async function garminAction(body: any, who: Principal): Promise<{ status: number; payload: unknown }> {
  const info = garminInfo(who);
  if (!info.enabled) throw new HttpError(409, info.reason ?? "Garmin actions are disabled.");
  if (!GARMIN_ACTIONS.includes(body.action)) throw new HttpError(400, `Unknown action "${body.action}".`);
  // The UI shows what will happen and asks first; the API insists on it so a stray request can't change the account.
  if (body.confirm !== true) throw new HttpError(400, "Confirmation required (confirm: true).");
  const action = body.action as GarminAction;

  const { logical, absolute } = resolveOr400(body.path);
  assertScope(who, logical);
  if (!fs.existsSync(absolute)) throw new HttpError(404, `File not found: ${logical}`);
  const profile = profileFor(who, logical, body.profile);

  if (action === "upload" || action === "upload_schedule") {
    const validation = validateText(fs.readFileSync(absolute, "utf8")) as { errors: string[] } | null;
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
  const mtimeMs = fs.existsSync(absolute) ? fs.statSync(absolute).mtimeMs : undefined;
  if (!outcome.ok) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    return { status: 502, payload: { error: message, log: outcome.log, profile, mtimeMs } };
  }
  return { status: 200, payload: { action, profile, result: outcome.value, log: outcome.log, mtimeMs } };
}

// ── Workouts view: the Garmin library next to the plan entries that carry the same workouts ──

const MAX_SCAN_BYTES = 5 * 1024 * 1024;
// Library snapshots written by export_workouts: copies of Garmin's list, not plans to edit.
const EXPORT_FILE = /^workouts(-raw)?\.json$/;

interface PlanEntry {
  path: string;
  index: number;
  mtimeMs: number;
  workout: any;
}

/** Every workout in the plan files a profile works with: the shared workout-plans/ and its own data/<profile>/. */
function planEntriesFor(profile: string): PlanEntry[] {
  const files = [
    ...jsonFilesIn(getPlansDir()),
    ...jsonFilesIn(path.join(getDataRoot(), profile)).filter((f) => !EXPORT_FILE.test(path.basename(f))),
  ];
  const entries: PlanEntry[] = [];
  for (const absolute of files) {
    try {
      const stat = fs.statSync(absolute);
      if (stat.size > MAX_SCAN_BYTES) continue;
      const data: any = JSON.parse(fs.readFileSync(absolute, "utf8"));
      const list = Array.isArray(data) ? data : data?.workouts;
      if (!Array.isArray(list)) continue;
      list.forEach((workout, index) => {
        if (workout && typeof workout === "object" && typeof workout.workoutName === "string") {
          entries.push({ path: toLogicalPath(absolute), index, mtimeMs: stat.mtimeMs, workout });
        }
      });
    } catch {
      /* not JSON: the editor flags it */
    }
  }
  return entries;
}

const hasId = (id: unknown): boolean => id !== undefined && id !== null && id !== "";
const sameId = (a: unknown, b: unknown): boolean => hasId(a) && hasId(b) && String(a) === String(b);

type WorkoutRowState = "garmin-only" | "linked" | "not-uploaded";

/**
 * One row per workout on Garmin plus one per plan workout Garmin does not list. "linked" rows
 * have a workoutId and plan entries to compare (checked afterwards through /api/garmin/status).
 */
function workoutRows(library: LibraryWorkout[], entries: PlanEntry[]) {
  const ref = (e: PlanEntry) => ({ path: e.path, index: e.index, mtimeMs: e.mtimeMs });
  const listed = new Set(library.map((w) => String(w.workoutId)));
  const rows: {
    key: string;
    workoutId?: number | string;
    workoutName: string;
    workoutType?: string;
    description?: string;
    updatedDate?: string;
    plans: ReturnType<typeof ref>[];
    state: WorkoutRowState;
  }[] = [];

  for (const w of library) {
    const plans = entries.filter((e) => sameId(e.workout.workoutId, w.workoutId)).map(ref);
    rows.push({ key: `g:${w.workoutId}`, ...w, plans, state: plans.length ? "linked" : "garmin-only" });
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
      state: hasId(e.workout.workoutId) ? "linked" : "not-uploaded",
    });
  }
  return { rows, truncated: library.length >= LIBRARY_LIMIT };
}

function requireGarmin(who: Principal): void {
  const info = garminInfo(who);
  if (!info.enabled) throw new HttpError(409, info.reason ?? "Garmin actions are disabled.");
}

function requireConfirm(body: any): void {
  // The UI asks first; the API insists so a stray request can't change the account.
  if (body.confirm !== true) throw new HttpError(400, "Confirmation required (confirm: true).");
}

/** Run a Garmin call serialized with the others; a failure becomes a 502 that carries the Garmin log. */
async function viaGarmin<T>(fn: () => Promise<T>): Promise<{ value: T; log: string }> {
  const outcome = await runCaptured(fn);
  if (!outcome.ok) {
    throw new HttpError(502, outcome.error instanceof Error ? outcome.error.message : String(outcome.error), { log: outcome.log });
  }
  return { value: outcome.value, log: outcome.log };
}

interface PlanFile {
  logical: string;
  absolute: string;
  data: unknown;
  /** Live reference into `data`. */
  workouts: any[];
}

function loadPlanFile(who: Principal, logicalPath: unknown, mtimeMs?: unknown): PlanFile {
  const { logical, absolute } = resolveOr400(logicalPath);
  assertScope(who, logical);
  if (!fs.existsSync(absolute)) throw new HttpError(404, `File not found: ${logical}`);
  if (typeof mtimeMs === "number" && fs.statSync(absolute).mtimeMs !== mtimeMs) {
    throw new HttpError(409, `${logical} changed on disk since you opened it. Reload and try again.`);
  }
  const data = parseOr400(fs.readFileSync(absolute, "utf8"));
  try {
    return { logical, absolute, data, workouts: extractWorkouts(data).workouts };
  } catch {
    throw new HttpError(400, `${logical} is not a workout plan.`);
  }
}

const savePlanFile = (file: PlanFile): void => writeTextAtomic(file.absolute, JSON.stringify(file.data, null, 2) + "\n");

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
    const file = files.get(resolveOr400(ref?.path).logical) ?? loadPlanFile(who, ref?.path, ref?.mtimeMs);
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

/** data/<PROFILE>/ plans decide the Garmin profile; otherwise the request (or default) does. */
const ownerHint = (files: PlanFile[]): string => files.find((f) => f.logical.startsWith("data/"))?.logical ?? "";

const changedFiles = (files: PlanFile[]) => files.map((f) => ({ path: f.logical, mtimeMs: fs.statSync(f.absolute).mtimeMs }));

/** Add a new workout to a plan and/or Garmin. */
async function createWorkout(body: any, who: Principal): Promise<unknown> {
  const workout = workoutFrom(body);
  const upload = body.upload === true;
  const validation = validatePlanData([workout]);
  if (upload && validation.errors.length) {
    throw new HttpError(422, "Fix the validation errors before uploading.", { errors: validation.errors });
  }
  const plan = hasId(body.planPath) ? loadPlanFile(who, body.planPath, body.mtimeMs) : undefined;
  if (!plan && !upload) throw new HttpError(400, "Choose a plan to add it to, or upload it to Garmin.");

  let saved: { workoutId: number | string } | undefined;
  let log = "";
  if (upload) {
    requireGarmin(who);
    requireConfirm(body);
    const profile = profileFor(who, plan?.logical ?? "", body.profile);
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
    const profile = profileFor(who, ownerHint(files), body.profile);
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

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
};

function serveStatic(pathname: string, res: http.ServerResponse): void {
  let root = PUBLIC_DIR;
  let name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (name.startsWith("vendor/monaco/")) {
    root = MONACO_DIR;
    name = name.slice("vendor/monaco/".length);
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
  const content = fs.readFileSync(full); // read first: a failure must still be able to send a 500
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  res.end(content);
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, who: Principal): Promise<void> {
  const route = `${req.method} ${url.pathname}`;
  const queryPath = url.searchParams.get("path");
  const scoped = (logicalPath: unknown) => {
    const resolved = resolveOr400(logicalPath);
    assertScope(who, resolved.logical);
    return resolved;
  };

  switch (route) {
    case "GET /api/files":
      return send(res, 200, { files: listFiles(who) });

    case "GET /api/schema":
      return send(res, 200, workoutSchema());

    case "GET /api/file": {
      const { logical, absolute } = scoped(queryPath);
      if (!fs.existsSync(absolute)) throw new HttpError(404, `File not found: ${logical}`);
      return send(res, 200, {
        path: logical,
        text: fs.readFileSync(absolute, "utf8"),
        mtimeMs: fs.statSync(absolute).mtimeMs,
      });
    }

    case "PUT /api/file": {
      // Body: { text, mtimeMs? } to update (409 if the file changed on disk since mtimeMs),
      //       { text, create: true } to create (409 if it already exists).
      const body = await readBody(req);
      const { logical, absolute } = scoped(queryPath);
      parseOr400(body.text);
      const exists = fs.existsSync(absolute);
      if (body.create && exists) throw new HttpError(409, `${logical} already exists`);
      if (!body.create && !exists) throw new HttpError(404, `File not found: ${logical}`);
      if (!body.create && typeof body.mtimeMs === "number" && fs.statSync(absolute).mtimeMs !== body.mtimeMs) {
        throw new HttpError(409, `${logical} changed on disk since you opened it. Reload to see the new version.`);
      }
      writeTextAtomic(absolute, body.text);
      return send(res, exists ? 200 : 201, {
        path: logical,
        mtimeMs: fs.statSync(absolute).mtimeMs,
        validation: validateText(body.text),
      });
    }

    case "DELETE /api/file": {
      const { logical, absolute } = scoped(queryPath);
      if (!fs.existsSync(absolute)) throw new HttpError(404, `File not found: ${logical}`);
      fs.unlinkSync(absolute);
      return send(res, 200, { path: logical, deleted: true });
    }

    case "POST /api/rename": {
      const body = await readBody(req);
      const from = scoped(body.from);
      const to = scoped(body.to);
      if (!fs.existsSync(from.absolute)) throw new HttpError(404, `File not found: ${from.logical}`);
      if (fs.existsSync(to.absolute)) throw new HttpError(409, `${to.logical} already exists`);
      fs.mkdirSync(path.dirname(to.absolute), { recursive: true });
      fs.renameSync(from.absolute, to.absolute);
      return send(res, 200, { from: from.logical, to: to.logical, mtimeMs: fs.statSync(to.absolute).mtimeMs });
    }

    case "GET /api/garmin":
      return send(res, 200, garminInfo(who));

    case "GET /api/garmin/devices": {
      const info = garminInfo(who);
      if (!info.enabled) throw new HttpError(409, info.reason ?? "Garmin actions are disabled.");
      const profile = profileFor(who, queryPath && /^data\/[^/]+\//.test(queryPath) ? queryPath : "", url.searchParams.get("profile"));
      const outcome = await runCaptured(() => listDevices(profile));
      if (!outcome.ok) throw new HttpError(502, outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
      return send(res, 200, outcome.value);
    }

    case "POST /api/garmin/action": {
      const { status, payload } = await garminAction(await readBody(req), who);
      return send(res, status, payload);
    }

    case "GET /api/workouts": {
      requireGarmin(who);
      const profile = profileFor(who, "", url.searchParams.get("profile"));
      const { value: library } = await viaGarmin(() => listLibraryWorkouts(profile, url.searchParams.get("refresh") === "1"));
      return send(res, 200, { profile, ...workoutRows(library, planEntriesFor(profile)) });
    }

    case "GET /api/garmin/workout": {
      requireGarmin(who);
      const id = url.searchParams.get("id") ?? "";
      if (!/^[\w-]+$/.test(id)) throw new HttpError(400, "Missing or invalid workout id");
      const profile = profileFor(who, "", url.searchParams.get("profile"));
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
          return { path: e.path, index: e.index, mtimeMs: e.mtimeMs, workout: e.workout, differences };
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
      const { logical, absolute } = scoped(body.path);
      let text = body.text;
      if (typeof text !== "string") {
        if (!fs.existsSync(absolute)) throw new HttpError(404, `File not found: ${logical}`);
        text = fs.readFileSync(absolute, "utf8");
      }
      const data: any = parseOr400(text);
      const workouts = Array.isArray(data) ? data : Array.isArray(data?.workouts) ? data.workouts : null;
      if (!workouts) return send(res, 200, { statuses: [] });
      const profile = profileFor(who, logical, body.profile);
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
    throw new Error("WEB_AUTH_TOKEN (or a WEB_PASSWORD in a profile .env file) is required when binding to a non-loopback host.");
  }
  // Checked per request: WEB_PASSWORD edits in a profile file apply without a restart.
  const authRequired = () => !!options.token || profilesWithWebPassword().length > 0;

  const authenticate = (header: string | undefined): Principal | null => {
    if (!authRequired()) return ADMIN;
    const m = /^Basic\s+(.+)$/i.exec(header ?? "");
    if (!m) return null;
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    const user = colon < 0 ? "" : decoded.slice(0, colon);
    const secret = decoded.slice(colon + 1);

    const profilePassword = user && getAvailableProfiles().includes(user) ? profileWebPassword(user) : undefined;
    if (profilePassword && sameSecret(secret, profilePassword)) return { admin: false, profile: user };
    if (options.token && sameSecret(secret, options.token)) return ADMIN;
    return null;
  };

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
      const who = authenticate(req.headers.authorization);
      if (!who) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Plan editor"' });
        return void res.end("Authentication required");
      }
      if (!url.pathname.startsWith("/api/")) {
        return req.method === "GET" ? serveStatic(url.pathname, res) : send(res, 405, { error: "Method not allowed" });
      }
      // Custom header forces a CORS preflight, so other sites can't drive the API from a browser.
      if (req.method !== "GET" && req.headers["x-requested-with"] !== "plan-editor") {
        throw new HttpError(403, "Missing X-Requested-With header");
      }
      await handleApi(req, res, url, who);
    } catch (error) {
      if (res.headersSent) return void res.destroy();
      if (error instanceof HttpError) return send(res, error.status, { error: error.message, ...error.extra });
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
    .then(() => console.log(`Plan editor on http://${host}:${port}  (plans: ${getPlansDir()})`))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
