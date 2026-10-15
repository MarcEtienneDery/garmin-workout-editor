import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GarminClient } from "../shared/garminClient";
import {
  PROJECT_ROOT,
  ProfileConfig,
  getAvailableProfiles,
  getDataRoot,
  getMockProfile,
  loadProfile,
} from "../shared/profileLoader";
import WorkoutEditor from "../workoutEditor";
import ActivityExporter from "../activityExporter";
import { captureLogs, CaptureOutcome } from "./logCapture";

// ─── Settings ───────────────────────────────────────────────────────────────

export interface McpSettings {
  /** Use mock data and refuse Garmin writes. */
  mock: boolean;
  /** Profile used when a tool call doesn't name one. */
  defaultProfile?: string;
}

const settings: McpSettings = {
  mock: process.env.MOCK_MODE === "true",
  defaultProfile: process.env.GARMIN_PROFILE || undefined,
};

export function configureMcp(overrides: Partial<McpSettings>): void {
  Object.assign(settings, overrides);
  sessions.clear();
}

export function getSettings(): Readonly<McpSettings> {
  return settings;
}

// ─── Sessions (one cached Garmin client per profile) ────────────────────────

export interface Session {
  profile: ProfileConfig;
  mock: boolean;
  garminClient: GarminClient;
  editor: WorkoutEditor;
  exporter: ActivityExporter;
}

const sessions = new Map<string, Session>();

export function resolveProfileName(requested?: string): string {
  const name = requested || settings.defaultProfile;
  if (name) return name;

  const available = getAvailableProfiles();
  if (available.length === 1) return available[0];
  if (available.length === 0) {
    throw new Error(
      "No Garmin profiles are configured (expected .env.<profile> files in the profiles directory)."
    );
  }
  throw new Error(
    `Multiple profiles are available (${available.join(", ")}). Pass the "profile" argument.`
  );
}

/**
 * Get (or lazily create) the Garmin client/editor/exporter for a profile.
 * The client is cached so the Garmin login and token cache are reused across calls.
 */
export function getSession(requested?: string): Session {
  const mock = settings.mock;
  const profile = mock ? getMockProfile() : loadProfile(resolveProfileName(requested));

  const cached = sessions.get(profile.name);
  if (cached) return cached;

  const garminClient = new GarminClient(
    profile.email,
    profile.password,
    mock,
    profile.dataDir
  );
  const session: Session = {
    profile,
    mock,
    garminClient,
    editor: new WorkoutEditor(garminClient),
    exporter: new ActivityExporter(garminClient),
  };
  sessions.set(profile.name, session);
  return session;
}

/** Garmin write operations must never run against the mock client. */
export function assertLive(session: Session, action: string): void {
  if (session.mock) {
    throw new Error(
      `Mock mode is on: "${action}" would write to Garmin and is disabled. Use dryRun/validate_plan instead.`
    );
  }
}

let validatorEditor: WorkoutEditor | undefined;

/**
 * An editor for the pure validation helpers; needs no profile and never talks to Garmin.
 * Uses a temp data dir because the GarminClient constructor creates its token-cache dir.
 */
export function getValidatorEditor(): WorkoutEditor {
  if (!validatorEditor) {
    const client = new GarminClient(
      "validator@example.com",
      "unused",
      true,
      path.join(os.tmpdir(), "garmin-mcp-validator")
    );
    validatorEditor = new WorkoutEditor(client);
  }
  return validatorEditor;
}

// ─── File access guard ──────────────────────────────────────────────────────

export function getPlansDir(): string {
  return process.env.WORKOUT_PLANS_DIR
    ? path.resolve(process.env.WORKOUT_PLANS_DIR)
    : path.join(PROJECT_ROOT, "workout-plans");
}

function rootFor(logicalRoot: "data" | "workout-plans"): string {
  return logicalRoot === "data" ? getDataRoot() : getPlansDir();
}

function nearestExistingRealpath(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fs.realpathSync(current);
}

/**
 * Map a tool-supplied logical path ("workout-plans/x.json", "data/MED/x.json")
 * to an absolute file path. Only .json files under the two roots are reachable;
 * dotfiles (token cache, .env*) and anything escaping the roots are rejected.
 */
export function resolveDataPath(logicalPath: string): string {
  if (logicalPath.includes("\0")) throw new Error("Invalid path");
  const normalized = logicalPath.replace(/\\/g, "/").replace(/^\.\//, "");

  const match = /^(workout-plans|data)\/(.+)$/.exec(normalized);
  if (!match) {
    throw new Error(
      `Path must start with "workout-plans/" or "data/" (got "${logicalPath}").`
    );
  }
  const logicalRoot = match[1] as "data" | "workout-plans";
  const rest = match[2];

  const segments = rest.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) {
    throw new Error(`Path "${logicalPath}" is not allowed (no "..", empty or hidden segments).`);
  }
  if (!rest.endsWith(".json")) {
    throw new Error(`Only .json files are accessible (got "${logicalPath}").`);
  }

  const base = rootFor(logicalRoot);
  const full = path.resolve(base, rest);
  const rel = path.relative(base, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path "${logicalPath}" escapes ${logicalRoot}/.`);
  }

  // Symlinks inside the volume must not lead outside it.
  const realBase = nearestExistingRealpath(base);
  const realFull = nearestExistingRealpath(full);
  if (realFull !== realBase && !realFull.startsWith(realBase + path.sep)) {
    throw new Error(`Path "${logicalPath}" escapes ${logicalRoot}/.`);
  }

  return full;
}

/** Inverse of resolveDataPath, for results shown to the model. */
export function toLogicalPath(absolute: string): string {
  for (const logicalRoot of ["data", "workout-plans"] as const) {
    const rel = path.relative(rootFor(logicalRoot), absolute);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return `${logicalRoot}/${rel.split(path.sep).join("/")}`;
    }
  }
  return path.basename(absolute);
}

/** Write JSON via a temp file + rename so a crash can't leave a truncated plan. */
export function writeJsonAtomic(absolute: string, data: unknown): void {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const tmp = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, absolute);
}

export function readJsonFile(absolute: string, logicalPath: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(absolute, "utf-8");
  } catch (error: any) {
    if (error.code === "ENOENT") throw new Error(`File not found: ${logicalPath}`);
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error: any) {
    throw new Error(`${logicalPath} is not valid JSON: ${error.message}`);
  }
}

// ─── Tool execution ─────────────────────────────────────────────────────────

// Garmin calls are serialized: one session, rate limits, and shared token cache.
let lockTail: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lockTail.then(fn);
  lockTail = run.catch(() => undefined);
  return run;
}

/** Like runTool's serialized path, for non-MCP callers (the web editor): returns the outcome and captured log. */
export function runCaptured<T>(fn: () => Promise<T>): Promise<CaptureOutcome<T>> {
  return withLock(() => captureLogs(fn));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run a tool body: capture its console output, turn throws into isError
 * results, and (for Garmin-touching tools) serialize against other calls.
 */
export async function runTool(
  fn: () => Promise<unknown>,
  options: { serialize?: boolean } = {}
): Promise<CallToolResult> {
  const execute = () => captureLogs(fn);
  const outcome = options.serialize ? await withLock(execute) : await execute();

  const content: CallToolResult["content"] = [];
  if (outcome.ok) {
    content.push({
      type: "text",
      text: outcome.value === undefined ? "OK" : JSON.stringify(outcome.value),
    });
  } else {
    content.push({ type: "text", text: `Error: ${errorMessage(outcome.error)}` });
  }
  if (outcome.log) {
    content.push({ type: "text", text: `Log:\n${outcome.log}` });
  }

  return outcome.ok ? { content } : { content, isError: true };
}
