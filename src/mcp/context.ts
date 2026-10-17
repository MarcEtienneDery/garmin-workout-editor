import * as os from "os";
import * as path from "path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GarminClient } from "../shared/garminClient";
import { ProfileConfig, findProfile, getAvailableProfiles, getMockProfile, loadProfile } from "../shared/profileLoader";
import { type DocMeta, StoreError, getStore, normalizeLogicalPath } from "../shared/store";
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
  if (name) return findProfile(name) ?? name;

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

/** Log in to Garmin (a cached token is reused), or say why not. */
export async function requireAuth(session: Session): Promise<void> {
  if (!(await session.garminClient.ensureAuthenticated())) {
    throw new Error("Failed to authenticate with Garmin (check the profile credentials; 2FA accounts need a cached token).");
  }
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
 * Gets a throwaway data dir, so its token cache is never the one of a real profile.
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

// ─── Documents (plans and per-profile data) ─────────────────────────────────

/**
 * Canonical logical path ("workout-plans/x.json", "data/MED/x.json") of a tool-supplied path.
 * Only .json documents under the two roots exist; hidden segments and ".." are rejected.
 */
export function logicalPath(input: string): string {
  try {
    return normalizeLogicalPath(input);
  } catch (error) {
    if (error instanceof StoreError) throw new Error(error.message);
    throw error;
  }
}

/** The parsed content of a stored document. */
export function readJsonDoc(logical: string): unknown {
  const doc = getStore().get(logical);
  if (!doc) throw new Error(`File not found: ${logical}`);
  try {
    return JSON.parse(doc.text);
  } catch (error: any) {
    throw new Error(`${logical} is not valid JSON: ${error.message}`);
  }
}

const jsonText = (data: unknown): string => JSON.stringify(data, null, 2);

/** Create or replace a stored document; the previous version stays in its history. */
export function writeJsonDoc(logical: string, data: unknown, source = "mcp"): DocMeta {
  return getStore().put(logical, jsonText(data), { source });
}

/** Read, change and save a document as one step, so another writer cannot slip in between. */
export function updateJsonDoc(logical: string, change: (data: any) => void, source = "mcp"): DocMeta {
  return getStore().update(
    logical,
    (text) => {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch (error: any) {
        throw new Error(`${logical} is not valid JSON: ${error.message}`);
      }
      change(data);
      return jsonText(data);
    },
    { source }
  );
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
