import { AsyncLocalStorage } from "async_hooks";
import * as os from "os";
import * as path from "path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GarminClient } from "../shared/garminClient";
import { GarminNotConnectedError, ProfileConfig, findProfile, garminConnected, getAvailableProfiles, getMockProfile, loadProfile, unknownProfileMessage } from "../shared/profileLoader";
import { type DocMeta, StoreError, getStore, normalizeLogicalPath, profileReaches } from "../shared/store";
import WorkoutEditor from "../workoutEditor";
import ActivityExporter from "../activityExporter";
import { captureLogs, CaptureOutcome } from "./logCapture";


export interface McpSettings {
  mock: boolean;
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


const scope = new AsyncLocalStorage<{ profile: string }>();

export const runScoped = <T>(profile: string, fn: () => T): T => scope.run({ profile }, fn);

export const scopedProfile = (): string | undefined => scope.getStore()?.profile;

export function mayReach(logical: string, owner: string | null): boolean {
  const only = scopedProfile();
  return only === undefined || profileReaches(only, logical, owner);
}


export interface Session {
  profile: ProfileConfig;
  mock: boolean;
  garminClient: GarminClient;
  editor: WorkoutEditor;
  exporter: ActivityExporter;
}

const sessions = new Map<string, Session>();

export function resolveProfileName(requested?: string): string {
  const only = scopedProfile();
  if (only) {
    if (requested && findProfile(requested) !== only) throw new Error(`Profile "${requested}" is not available: this connection can only use the profile "${only}".`);
    return only;
  }
  const name = requested || settings.defaultProfile;
  if (name) return findProfile(name) ?? name;

  const available = getAvailableProfiles();
  if (available.length === 1) return available[0];
  if (available.length === 0) {
    throw new Error("No profiles exist yet: add one in the web editor's Settings.");
  }
  throw new Error(
    `Multiple profiles are available (${available.join(", ")}). Pass the "profile" argument.`
  );
}

export function dataProfile(requested?: string): string {
  if (settings.mock) return getMockProfile().name;
  const name = resolveProfileName(requested);
  const available = getAvailableProfiles();
  if (!available.includes(name)) {
    const similar = available.filter((p) => p.toLowerCase() === name.toLowerCase());
    throw new Error(similar.length > 1 ? unknownProfileMessage(name) : `Unknown profile "${name}" (list_profiles shows the ones that exist).`);
  }
  return name;
}

export function garminAvailable(name: string): boolean {
  return settings.mock || garminConnected(name);
}

export function getSession(requested?: string): Session {
  const mock = settings.mock;
  const profile = mock ? getMockProfile() : loadProfile(resolveProfileName(requested));
  if (!profile.login) throw new GarminNotConnectedError(profile.name);

  const cached = sessions.get(profile.name);
  if (cached && cached.profile.login?.email === profile.login.email && cached.profile.login.password === profile.login.password) return cached;

  const garminClient = new GarminClient(
    profile.login.email,
    profile.login.password,
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

export async function requireAuth(session: Session): Promise<void> {
  if (!(await session.garminClient.ensureAuthenticated())) {
    throw session.garminClient.authError();
  }
}

export function assertLive(session: Session, action: string): void {
  if (session.mock) {
    throw new Error(
      `Mock mode is on: "${action}" would write to Garmin and is disabled. Use dryRun/validate_plan instead.`
    );
  }
}

let validatorEditor: WorkoutEditor | undefined;

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

let dataExporter: ActivityExporter | undefined;

export function getDataExporter(): ActivityExporter {
  if (!dataExporter) {
    dataExporter = new ActivityExporter(new GarminClient("data@example.com", "unused", true, path.join(os.tmpdir(), "garmin-mcp-validator")));
  }
  return dataExporter;
}


export function logicalPath(input: string): string {
  let logical: string;
  try {
    logical = normalizeLogicalPath(input);
  } catch (error) {
    if (error instanceof StoreError) throw new Error(error.message);
    throw error;
  }
  if (!mayReach(logical, getStore().head(logical)?.owner ?? null)) throw new Error(`${logical} belongs to another profile.`);
  return logical;
}

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

export function writeJsonDoc(logical: string, data: unknown, source = "mcp", owner: string | null = null): DocMeta {
  return getStore().put(logical, jsonText(data), { source, owner });
}

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


let lockTail: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lockTail.then(fn);
  lockTail = run.catch(() => undefined);
  return run;
}

export function runCaptured<T>(fn: () => Promise<T>): Promise<CaptureOutcome<T>> {
  return withLock(() => captureLogs(fn));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
