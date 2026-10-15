jest.mock("@flow-js/garmin-connect", () => ({
  GarminConnect: jest.fn().mockImplementation(function () {
    return {};
  }),
}));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type * as http from "http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../mcp/createServer";
import { configureMcp, logicalPath } from "../mcp/context";
import { closeStore, getStore } from "../shared/store";
import { installConsoleRedirect } from "../mcp/logCapture";
import { startHttpServer } from "../mcp/http";
import { getLastNWeeksStart } from "../activityExporter";
import ActivityExporter from "../activityExporter";
import { GarminClient } from "../shared/garminClient";
import { getAvailableProfiles, getMockProfile } from "../shared/profileLoader";

const EXPECTED_TOOLS = [
  "export_workouts",
  "get_activities",
  "get_workout",
  "list_devices",
  "list_exercise_names",
  "list_plans",
  "list_profiles",
  "list_workouts",
  "read_plan",
  "schedule_plan",
  "send_to_device",
  "upload_and_schedule_plan",
  "upload_single_workout",
  "upload_workouts",
  "upsert_plan_workout",
  "validate_plan",
  "write_plan",
];

const STRENGTH_WORKOUT = {
  workoutName: "Bench Day",
  workoutType: "strength_training",
  steps: [
    {
      stepType: "interval",
      exerciseName: "BARBELL_BENCH_PRESS",
      targetType: "no.target",
      endCondition: "reps",
      endConditionValue: 5,
      reps: 5,
      weight: 135,
      numberOfRepeats: 3,
      repeatGroupIndex: 0,
      restTimeSeconds: 90,
    },
  ],
};

let tmpRoot: string;
let dataDir: string;
const stored = (logical: string) => getStore().get(logical)?.text;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  // The editor/exporter log heavily; keep the test output readable.
  jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  installConsoleRedirect();

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "garmin-mcp-test-"));
  dataDir = path.join(tmpRoot, "data");

  for (const key of ["GARMIN_DATA_DIR", "GARMIN_PROFILES_DIR"]) {
    saved[key] = process.env[key];
  }
  process.env.GARMIN_DATA_DIR = dataDir;
  process.env.GARMIN_PROFILES_DIR = path.join(tmpRoot, "config"); // does not exist yet

  configureMcp({ mock: true, defaultProfile: undefined });
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeStore();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function writePlan(name: string, content: unknown): string {
  getStore().put(`workout-plans/${name}`, JSON.stringify(content, null, 2), { source: "test" });
  return `workout-plans/${name}`;
}

async function connect(): Promise<Client> {
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

interface ToolOutcome {
  isError: boolean;
  value: any;
  text: string;
  log: string;
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const result: any = await client.callTool({ name, arguments: args });
  const texts: string[] = result.content.map((c: any) => c.text);
  const isError = result.isError === true;
  let value: any = texts[0];
  if (!isError) {
    try {
      value = JSON.parse(texts[0]);
    } catch {
      /* plain text result */
    }
  }
  const logEntry = texts.find((t, i) => i > 0 && t.startsWith("Log:\n"));
  return { isError, value, text: texts[0], log: logEntry ?? "" };
}

describe("MCP server (mock mode, in-memory transport)", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connect();
  });

  it("registers exactly the planned tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("marks Garmin writes destructive and reads read-only", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ["upload_workouts", "upload_and_schedule_plan", "schedule_plan", "send_to_device", "write_plan"]) {
      expect(byName[name].annotations?.destructiveHint).toBe(true);
    }
    for (const name of ["list_workouts", "get_activities", "validate_plan", "read_plan"]) {
      expect(byName[name].annotations?.readOnlyHint).toBe(true);
    }
  });

  it("exposes the weekly update prompt", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("update_weekly_workouts");
    const prompt = await client.getPrompt({ name: "update_weekly_workouts", arguments: { planFile: "workout-plans/a.json" } });
    const text = (prompt.messages[0].content as any).text as string;
    expect(text).toContain("workout-plans/a.json");
    expect(text).toContain("explicit confirmation");
  });

  it("reports mock mode in list_profiles", async () => {
    const out = await callTool(client, "list_profiles");
    expect(out.value.mock).toBe(true);
  });

  it("returns mock workouts and activities, saving activities under the data override", async () => {
    const workouts = await callTool(client, "list_workouts");
    expect(workouts.isError).toBe(false);
    expect(workouts.value.count).toBeGreaterThan(0);

    const activities = await callTool(client, "get_activities", { limit: 8, period: "all" });
    expect(activities.isError).toBe(false);
    expect(activities.value.savedTo).toBe("data/mock/activities.json");
    expect(activities.value.totalActivities).toBeGreaterThan(0);
    expect(getStore().head("data/mock/activities.json")).toBeDefined();
    // Console output of the exporter is returned with the result.
    expect(activities.log).toContain("Fetching last 8 activities");
  });

  it("get_workout returns a transformed workout and errors for unknown ids", async () => {
    const list = await callTool(client, "list_workouts");
    const id = list.value.workouts[0].workoutId;
    const found = await callTool(client, "get_workout", { workoutId: id });
    expect(found.value.workoutId).toBe(id);

    const missing = await callTool(client, "get_workout", { workoutId: 999999999 });
    expect(missing.isError).toBe(true);
  });

  it("lists plan files from the overridden directories", async () => {
    writePlan("listed.json", []);
    const out = await callTool(client, "list_plans");
    expect(out.value["workout-plans"].map((f: any) => f.path)).toContain("workout-plans/listed.json");
    expect(out.value.data.map((f: any) => f.path)).toContain("data/mock/activities.json");
  });

  describe("validate_plan", () => {
    it("accepts a valid plan", async () => {
      const file = writePlan("valid.json", {
        generatedAt: "2026-10-11T00:00:00Z",
        weekStart: "2026-10-12",
        weekEnd: "2026-10-18",
        workouts: [{ ...STRENGTH_WORKOUT, scheduledDate: "2026-10-13" }],
      });
      const out = await callTool(client, "validate_plan", { path: file });
      expect(out.value).toMatchObject({ valid: true, format: "plan", workoutCount: 1, errors: [] });
      expect(out.value.workouts[0]).toMatchObject({ name: "Bench Day", stepCount: 1, kind: "structured" });
    });

    it("reports structural, step and date problems without throwing", async () => {
      const file = writePlan("invalid.json", {
        weekStart: "2026-10-12",
        weekEnd: "2026-10-18",
        workouts: [
          { ...STRENGTH_WORKOUT, scheduledDate: "next tuesday" },
          { workoutName: "No Steps", workoutType: "strength_training" },
          {
            workoutName: "Bad Exercise",
            steps: [{ ...STRENGTH_WORKOUT.steps[0], exerciseName: "NOT_A_REAL_EXERCISE" }],
          },
        ],
      });
      const out = await callTool(client, "validate_plan", { path: file });
      expect(out.isError).toBe(false);
      expect(out.value.valid).toBe(false);
      expect(out.value.errors.join("\n")).toContain("Unknown exerciseName");
      expect(out.value.errors.join("\n")).toContain("steps");
      expect(out.value.warnings.join("\n")).toContain("next tuesday");
    });

    it("treats distance-only running workouts as valid", async () => {
      const file = writePlan("easy-run.json", [
        { workoutName: "Easy 5k", workoutType: "running", distanceMeters: 5000 },
      ]);
      const out = await callTool(client, "validate_plan", { path: file });
      expect(out.value.valid).toBe(true);
      expect(out.value.workouts[0].kind).toBe("simple-running");
    });

    it("errors on files that are not workout plans", async () => {
      const file = writePlan("not-a-plan.json", { hello: "world" });
      const out = await callTool(client, "validate_plan", { path: file });
      expect(out.isError).toBe(true);
    });
  });

  describe("upsert_plan_workout", () => {
    it("appends, then replaces by name, leaving the rest of the file alone", async () => {
      const file = writePlan("upsert.json", {
        generatedAt: "x",
        weekStart: "2026-10-12",
        weekEnd: "2026-10-18",
        notes: "keep me",
        workouts: [{ workoutName: "Easy 5k", workoutType: "running", distanceMeters: 5000 }],
      });

      const appended = await callTool(client, "upsert_plan_workout", { path: file, workout: STRENGTH_WORKOUT });
      expect(appended.value).toMatchObject({ action: "appended", workoutCount: 2, index: 1 });

      const replaced = await callTool(client, "upsert_plan_workout", {
        path: file,
        workout: { ...STRENGTH_WORKOUT, description: "v2" },
      });
      expect(replaced.value).toMatchObject({ action: "replaced", workoutCount: 2, index: 1 });

      const onDisk = JSON.parse(stored("workout-plans/upsert.json")!);
      expect(onDisk.notes).toBe("keep me");
      expect(onDisk.workouts).toHaveLength(2);
      expect(onDisk.workouts[1].description).toBe("v2");
    });

    it("renames via matchName", async () => {
      const file = writePlan("rename.json", [{ ...STRENGTH_WORKOUT }]);
      const out = await callTool(client, "upsert_plan_workout", {
        path: file,
        matchName: "Bench Day",
        workout: { ...STRENGTH_WORKOUT, workoutName: "Heavy Bench Day" },
      });
      expect(out.value.action).toBe("replaced");
      const onDisk = JSON.parse(stored("workout-plans/rename.json")!);
      expect(onDisk.map((w: any) => w.workoutName)).toEqual(["Heavy Bench Day"]);
    });

    it("rejects an invalid workout without touching the file", async () => {
      const file = writePlan("untouched.json", [{ ...STRENGTH_WORKOUT }]);
      const before = stored("workout-plans/untouched.json");

      const out = await callTool(client, "upsert_plan_workout", {
        path: file,
        workout: {
          ...STRENGTH_WORKOUT,
          workoutName: "Broken",
          steps: [{ ...STRENGTH_WORKOUT.steps[0], exerciseName: "NOT_A_REAL_EXERCISE" }],
        },
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Unknown exerciseName");
      expect(stored("workout-plans/untouched.json")).toBe(before);
    });

    it("rejects enum violations at the schema boundary", async () => {
      const file = writePlan("schema.json", []);
      const result: any = await client
        .callTool({
          name: "upsert_plan_workout",
          arguments: { path: file, workout: { workoutName: "X", steps: [{ stepType: "sprint", targetType: "no.target" }] } },
        })
        .catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
      expect(result.isError).toBe(true);
    });
  });

  describe("read/write_plan", () => {
    it("round-trips content and reports whether it overwrote", async () => {
      const first = await callTool(client, "write_plan", {
        path: "data/mock/training-plan.json",
        content: { version: "1.0", periodization: { currentPhase: "Hypertrophy" } },
      });
      expect(first.value).toMatchObject({ path: "data/mock/training-plan.json", overwritten: false });
      expect(first.value.validation).toBeUndefined();

      const second = await callTool(client, "write_plan", {
        path: "data/mock/training-plan.json",
        content: { version: "2.0" },
      });
      expect(second.value.overwritten).toBe(true);

      const read = await callTool(client, "read_plan", { path: "data/mock/training-plan.json" });
      expect(read.value.content).toEqual({ version: "2.0" });
    });

    it("writes workout arrays but returns their validation result", async () => {
      const out = await callTool(client, "write_plan", {
        path: "workout-plans/written.json",
        content: [{ workoutName: "No Steps", workoutType: "strength_training" }],
      });
      expect(out.isError).toBe(false);
      expect(out.value.validation.valid).toBe(false);
      expect(getStore().head("workout-plans/written.json")).toBeDefined();
    });

    it("keeps the version it overwrites in the history", async () => {
      await callTool(client, "write_plan", { path: "workout-plans/history.json", content: [{ workoutName: "v1" }] });
      await callTool(client, "write_plan", { path: "workout-plans/history.json", content: [{ workoutName: "v2" }] });
      const [previous] = getStore().history("workout-plans/history.json");
      expect(previous).toMatchObject({ source: "mcp" });
      expect(JSON.parse(getStore().revision("workout-plans/history.json", previous.id)!.text)).toEqual([{ workoutName: "v1" }]);
    });

    it("reports a missing file clearly", async () => {
      const out = await callTool(client, "read_plan", { path: "workout-plans/nope.json" });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("File not found");
    });
  });

  describe("path guard", () => {
    it.each([
      "../.env.example",
      "workout-plans/../../etc/passwd.json",
      "workout-plans/../secret.json",
      "data/mock/.garmin-token-cache.json",
      "workout-plans/.hidden.json",
      "workout-plans/notes.txt",
      "workout-plans/",
      "/etc/passwd",
      "package.json",
      "data\\..\\..\\x.json",
    ])("rejects %s", async (bad) => {
      const out = await callTool(client, "read_plan", { path: bad });
      expect(out.isError).toBe(true);
    });

    it("maps paths to their canonical form", () => {
      expect(logicalPath("./workout-plans/a.json")).toBe("workout-plans/a.json");
      expect(logicalPath("data\\MED\\activities.json")).toBe("data/MED/activities.json");
      expect(() => logicalPath("data/activities.json")).toThrow(/data\/<profile>/);
    });
  });

  describe("list_exercise_names", () => {
    it("matches every word of the query and honors limit", async () => {
      const out = await callTool(client, "list_exercise_names", { query: "romanian deadlift", limit: 3 });
      expect(out.value.returned).toBeLessThanOrEqual(3);
      expect(out.value.totalMatches).toBeGreaterThan(0);
      for (const e of out.value.exercises) {
        expect(e.name).toContain("ROMANIAN");
        expect(e.name).toContain("DEADLIFT");
      }
    });

    it("filters by category", async () => {
      const out = await callTool(client, "list_exercise_names", { category: "squat", limit: 5 });
      expect(out.value.exercises.length).toBeGreaterThan(0);
      expect(out.value.exercises.every((e: any) => e.category === "SQUAT")).toBe(true);
    });
  });

  describe("mock mode never writes to Garmin", () => {
    const plan = "workout-plans/valid.json";

    it.each([
      ["upload_workouts", { path: plan }],
      ["upload_single_workout", { path: plan, workoutName: "Bench Day" }],
      ["schedule_plan", { path: plan }],
      ["upload_and_schedule_plan", { path: plan }],
      ["send_to_device", { path: plan }],
    ])("%s is refused", async (name, args) => {
      const out = await callTool(client, name, args as Record<string, unknown>);
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Mock mode");
    });

    it("upload_workouts still supports dryRun", async () => {
      const out = await callTool(client, "upload_workouts", { path: plan, dryRun: true });
      expect(out.isError).toBe(false);
      expect(out.value).toMatchObject({ dryRun: true, status: "ok", successful: 1, failed: 0 });
      expect(out.log).toContain("Would upload");
    });

    it("list_devices returns an empty list", async () => {
      const out = await callTool(client, "list_devices");
      expect(out.value.devices).toEqual([]);
    });
  });
});

describe("HTTP transport", () => {
  const token = "t".repeat(40);
  let server: http.Server;
  let base: string;

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });
  const init = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  };

  beforeAll(async () => {
    server = await startHttpServer({ host: "127.0.0.1", port: 0, token });
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("refuses to start with a short token", () => {
    expect(() => startHttpServer({ host: "127.0.0.1", port: 0, token: "short" })).toThrow(/at least 32/);
  });

  it("serves /healthz without auth", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
  });

  it("answers initialize and tools/list with the token in the path", async () => {
    const res = await post(`${base}/mcp/${token}`, init);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.result.serverInfo.name).toBe("garmin-workout-editor");

    const list = await post(`${base}/mcp/${token}`, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools: any = await list.json();
    expect(tools.result.tools.map((t: any) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("accepts the token as a bearer header on /mcp", async () => {
    const res = await post(`${base}/mcp`, init, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
  });

  it("calls a tool end-to-end", async () => {
    const res = await post(`${base}/mcp/${token}`, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_profiles", arguments: {} },
    });
    const body: any = await res.json();
    expect(JSON.parse(body.result.content[0].text).mock).toBe(true);
  });

  it.each([
    ["wrong path token", () => post(`${base}/mcp/${"x".repeat(40)}`, init)],
    ["no credentials", () => post(`${base}/mcp`, init)],
    ["wrong bearer", () => post(`${base}/mcp`, init, { Authorization: "Bearer nope" })],
    ["token on an unrelated path", () => post(`${base}/other/${token}`, init)],
    ["oauth discovery", () => fetch(`${base}/.well-known/oauth-protected-resource`)],
  ])("returns 404 for %s", async (_label, request) => {
    expect((await request()).status).toBe(404);
  });

  it("rejects non-POST methods with 405 once authorized", async () => {
    expect((await fetch(`${base}/mcp/${token}`)).status).toBe(405);
    expect((await fetch(`${base}/mcp/${token}`, { method: "DELETE" })).status).toBe(405);
  });
});

describe("supporting refactors", () => {
  afterEach(() => jest.useRealTimers());

  describe("getLastNWeeksStart", () => {
    it("returns this week's Monday for n=1 and steps back whole weeks", () => {
      jest.useFakeTimers({ now: new Date("2026-10-14T12:00:00Z") }); // Wednesday
      expect(getLastNWeeksStart(1)).toBe("2026-10-12");
      expect(getLastNWeeksStart(4)).toBe("2026-09-21");
    });

    it("treats Sunday as the end of the week", () => {
      jest.useFakeTimers({ now: new Date("2026-10-11T09:00:00Z") }); // Sunday
      expect(getLastNWeeksStart(1)).toBe("2026-10-05");
      expect(getLastNWeeksStart(4)).toBe("2026-09-14");
    });
  });

  describe("ActivityExporter.buildExtractedActivities", () => {
    const exporter = new ActivityExporter(new GarminClient("a@example.com", "x", true, path.join(os.tmpdir(), "garmin-mcp-build-test")));
    const raw = [
      { activityId: 1, activityName: "Morning Run", activityType: { typeKey: "running" }, startTimeGMT: "2026-10-06 07:00:00", duration: 1800, distance: 5000 },
      { activityId: 2, activityName: "Lifting", activityType: { typeKey: "strength_training" }, startTimeGMT: "2026-10-08 17:00:00", duration: 3600 },
      { activityId: 3, activityName: "Old Run", activityType: { typeKey: "running" }, startTimeGMT: "2026-09-01 07:00:00", duration: 1800, distance: 4000 },
    ];

    it("filters by custom date range and reports the range", () => {
      const out = exporter.buildExtractedActivities(raw, { customWeekStart: "2026-10-05", customWeekEnd: "2026-10-11" });
      expect(out.weekStart).toBe("2026-10-05");
      expect(out.weekEnd).toBe("2026-10-11");
      expect(out.totalActivities).toBe(2);
    });

    it("applies the type filter after transformation", () => {
      const out = exporter.buildExtractedActivities(raw, { customWeekStart: "2026-01-01", typeFilter: "running" });
      expect(out.activities.every((a: any) => a.activityType === "running")).toBe(true);
      expect(out.totalActivities).toBe(2);
    });

    it("is exactly what the CLI save path writes to disk", async () => {
      const options = { customWeekStart: "2026-10-05", customWeekEnd: "2026-10-11", typeFilter: "running" };
      const built = exporter.buildExtractedActivities(raw, options);

      const out = path.join(tmpRoot, "cli-save", "activities.json");
      await exporter.saveActivitiesToFile(raw, out, false, false, false, options.typeFilter, options.customWeekStart, options.customWeekEnd);
      const written = JSON.parse(fs.readFileSync(out, "utf-8"));

      expect({ ...written, extractedAt: undefined }).toEqual({ ...JSON.parse(JSON.stringify(built)), extractedAt: undefined });
      expect(written.totalActivities).toBe(1);
    });
  });

  describe("profile loader overrides", () => {
    it("reads profiles from GARMIN_PROFILES_DIR and keeps mock data under GARMIN_DATA_DIR", () => {
      const configDir = process.env.GARMIN_PROFILES_DIR!;
      expect(getAvailableProfiles()).toEqual([]); // directory does not exist yet

      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, ".env.TESTER"), 'GARMIN_EMAIL=t@example.com\nGARMIN_PASSWORD="pw"\n');
      fs.writeFileSync(path.join(configDir, ".env.example"), "");
      expect(getAvailableProfiles()).toEqual(["TESTER"]);

      expect(getMockProfile().dataDir).toBe(path.join(dataDir, "mock"));
    });
  });
});
