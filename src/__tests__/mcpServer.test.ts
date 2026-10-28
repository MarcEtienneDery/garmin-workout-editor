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
import { seedProfile } from "./fixtures/profiles";

const EXPECTED_TOOLS = [
  "create_workout",
  "delete_meal_entry",
  "export_workouts",
  "get_activities",
  "get_nutrition",
  "get_readiness",
  "get_wellness",
  "get_workout",
  "list_devices",
  "list_exercise_names",
  "list_plans",
  "list_profiles",
  "list_workouts",
  "log_meal",
  "read_plan",
  "schedule_plan",
  "schedule_workout",
  "send_to_device",
  "set_nutrition_goals",
  "update_meal_entry",
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

  for (const key of ["GARMIN_DATA_DIR", "GARMIN_STORE_PATH"]) {
    saved[key] = process.env[key];
  }
  process.env.GARMIN_DATA_DIR = dataDir;
  delete process.env.GARMIN_STORE_PATH;

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
    for (const name of ["upload_workouts", "upload_and_schedule_plan", "schedule_plan", "create_workout", "schedule_workout", "send_to_device", "write_plan"]) {
      expect(byName[name].annotations?.destructiveHint).toBe(true);
    }
    for (const name of ["list_workouts", "get_activities", "validate_plan", "read_plan", "get_nutrition"]) {
      expect(byName[name].annotations?.readOnlyHint).toBe(true);
    }
    // the food log is the database only: nothing there reaches Garmin, and only a delete is destructive
    for (const name of ["log_meal", "update_meal_entry", "delete_meal_entry", "get_nutrition", "set_nutrition_goals"]) expect(byName[name].annotations?.openWorldHint).toBe(false);
    expect(byName.delete_meal_entry.annotations?.destructiveHint).toBe(true);
    expect(byName.log_meal.annotations?.destructiveHint).toBe(false);
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

  it("returns mock workouts and activities, keeping nothing in the database", async () => {
    const workouts = await callTool(client, "list_workouts");
    expect(workouts.isError).toBe(false);
    expect(workouts.value.count).toBeGreaterThan(0);

    const activities = await callTool(client, "get_activities", { limit: 8, period: "all" });
    expect(activities.isError).toBe(false);
    expect(activities.value.mock).toBe(true);
    expect(activities.value.totalActivities).toBeGreaterThan(0);
    // Mock activities are generated, so they are never stored: no table rows and no document.
    expect(getStore().activities.counts("mock").total).toBe(0);
    expect(getStore().head("data/mock/activities.json")).toBeUndefined();
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
    expect(out.value.data.map((f: any) => f.path)).not.toContain("data/mock/activities.json");
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

    it("makes a new plan under workout-plans/ belong to the profile, and an overwrite keeps its owner", async () => {
      const mock = getMockProfile().name;
      const made = await callTool(client, "write_plan", { path: "workout-plans/owned.json", content: [{ workoutName: "v1" }] });
      expect(made.value.owner).toBe(mock);
      expect(getStore().head("workout-plans/owned.json")!.owner).toBe(mock);
      getStore().setOwner("workout-plans/owned.json", null);
      const again = await callTool(client, "write_plan", { path: "workout-plans/owned.json", content: [{ workoutName: "v2" }] });
      expect(again.value.owner).toBeUndefined();
      expect(getStore().head("workout-plans/owned.json")!.owner).toBeNull();
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

  describe("the food log", () => {
    beforeEach(() => {
      getStore().nutrition.remove("mock", getStore().nutrition.range("mock", "2000-01-01", "2100-01-01").map((e) => e.id));
    });

    it("logs the foods of a meal, works the calories out, and answers with the ids and the day's totals", async () => {
      const out = await callTool(client, "log_meal", {
        date: "2026-10-17",
        meal: "breakfast",
        items: [{ name: "Oats", kcal: 300, proteinG: 10, carbsG: 50, fatG: 6 }, { name: "Egg", proteinG: 6, fatG: 5 }],
      });
      expect(out.isError).toBe(false);
      expect(out.value).toMatchObject({
        profile: "mock",
        date: "2026-10-17",
        meal: "breakfast",
        added: [expect.objectContaining({ name: "Oats", kcal: 300 }), expect.objectContaining({ name: "Egg", kcal: 69, proteinG: 6, fatG: 5 })],
        mealTotals: { kcal: 369, proteinG: 16, carbsG: 50, fatG: 11, entries: 2 },
        dayTotals: { kcal: 369, entries: 2 },
        burnedKcal: null,
        netKcal: null,
      });
      const ids = out.value.added.map((a: any) => a.id);
      expect(new Set(ids).size).toBe(2);
    });

    it("logs on the user's today when no date is given", async () => {
      const out = await callTool(client, "log_meal", { meal: "snack", items: [{ name: "Apple", kcal: 80 }] });
      const today = (await callTool(client, "get_nutrition", { days: 1 })).value;
      expect(out.value.date).toBe(today.to);
      expect(today.days).toHaveLength(1);
    });

    it("reads the log back newest first, leaves unlogged days out and counts them", async () => {
      await callTool(client, "log_meal", { date: "2026-10-15", meal: "dinner", items: [{ name: "Fish", kcal: 400, proteinG: 40, carbsG: 0, fatG: 20 }] });
      await callTool(client, "log_meal", { date: "2026-10-17", meal: "lunch", items: [{ name: "Wrap", kcal: 500, proteinG: 25, carbsG: 50, fatG: 20 }] });
      const out = await callTool(client, "get_nutrition", { from: "2026-10-14", to: "2026-10-17" });
      expect(out.isError).toBe(false);
      expect(out.value).toMatchObject({ loggedDays: 2, unloggedDays: 2, total: { kcal: 900, proteinG: 65, entries: 2 } });
      expect(out.value.days.map((d: any) => d.day)).toEqual(["2026-10-17", "2026-10-15"]);
      expect(out.value.days[0].meals).toEqual([expect.objectContaining({ meal: "lunch", entries: [expect.objectContaining({ id: expect.any(Number), name: "Wrap" })] })]);
    });

    it("corrects and deletes an entry by id", async () => {
      const added = (await callTool(client, "log_meal", { date: "2026-10-17", meal: "lunch", items: [{ name: "Rice", kcal: 200, carbsG: 45 }, { name: "Rice", kcal: 200, carbsG: 45 }] })).value.added;
      const fixed = await callTool(client, "update_meal_entry", { id: added[0].id, kcal: 260, meal: "dinner" });
      expect(fixed.value.entry).toMatchObject({ id: added[0].id, name: "Rice", kcal: 260, carbsG: 45, meal: "dinner", day: "2026-10-17" });
      const gone = await callTool(client, "delete_meal_entry", { ids: [added[1].id, 999999] });
      expect(gone.value).toMatchObject({ deleted: [added[1].id], missing: [999999] });
      const left = (await callTool(client, "get_nutrition", { from: "2026-10-17", to: "2026-10-17" })).value;
      expect(left.total).toMatchObject({ kcal: 260, entries: 1 });
    });

    it("logs the nutrients a food states, answers with the totals and how many foods state each, and reads them back", async () => {
      const out = await callTool(client, "log_meal", {
        date: "2026-10-17",
        meal: "lunch",
        items: [{ name: "Lentil soup", kcal: 230, nutrients: { fiberG: 15.6, sodiumMg: 480, ironMg: 6.6 } }, { name: "Bread", kcal: 90, nutrients: { fiberG: 2 } }, { name: "Tea", kcal: 2 }],
      });
      expect(out.isError).toBe(false);
      expect(out.value.added[0].nutrients).toEqual({ fiberG: 15.6, sodiumMg: 480, ironMg: 6.6 });
      expect(out.value.added[2].nutrients).toEqual({}); // unknown, not zero
      expect(out.value.dayTotals).toMatchObject({ entries: 3, nutrients: { fiberG: { amount: 17.6, foods: 2 }, sodiumMg: { amount: 480, foods: 1 }, ironMg: { amount: 6.6, foods: 1 } } });
      const read = (await callTool(client, "get_nutrition", { from: "2026-10-17", to: "2026-10-17" })).value;
      expect(read.total.nutrients.fiberG).toEqual({ amount: 17.6, foods: 2 });
      expect(read.days[0].nutrients.fiberG).toEqual({ amount: 17.6, foods: 2 });
      expect(read.days[0].meals[0].entries[0]).toMatchObject({ name: "Lentil soup", nutrients: { fiberG: 15.6, sodiumMg: 480, ironMg: 6.6 } });
    });

    it("sets, keeps and clears the nutrients of an entry, a null making a nutrient unknown again", async () => {
      const [rice] = (await callTool(client, "log_meal", { date: "2026-10-17", meal: "lunch", items: [{ name: "Rice", kcal: 200, nutrients: { fiberG: 1, sodiumMg: 5 } }] })).value.added;
      expect((await callTool(client, "update_meal_entry", { id: rice.id, kcal: 210 })).value.entry.nutrients).toEqual({ fiberG: 1, sodiumMg: 5 });
      expect((await callTool(client, "update_meal_entry", { id: rice.id, nutrients: { fiberG: 2.5 } })).value.entry.nutrients).toEqual({ fiberG: 2.5, sodiumMg: 5 });
      expect((await callTool(client, "update_meal_entry", { id: rice.id, nutrients: { sodiumMg: null } })).value.entry.nutrients).toEqual({ fiberG: 2.5 });
      expect((await callTool(client, "update_meal_entry", { id: rice.id, nutrients: { fiberG: null } })).value.entry.nutrients).toEqual({});
    });

    it("refuses a nutrient that is negative or too large, and keeps none of the call", async () => {
      const items = (nutrients: object) => [{ name: "Fine", kcal: 100 }, { name: "Odd", kcal: 100, nutrients }];
      expect((await callTool(client, "log_meal", { date: "2026-10-17", meal: "lunch", items: items({ fiberG: -1 }) })).isError).toBe(true);
      expect((await callTool(client, "log_meal", { date: "2026-10-17", meal: "lunch", items: items({ sodiumMg: 100001 }) })).isError).toBe(true);
      expect((await callTool(client, "get_nutrition", { from: "2026-10-17", to: "2026-10-17" })).value.loggedDays).toBe(0);
    });

    it("refuses a nutrient key it does not know, so a misspelling is not a nutrient quietly lost", async () => {
      const bad = await callTool(client, "log_meal", { date: "2026-10-17", meal: "lunch", items: [{ name: "Bread", kcal: 90, nutrients: { fibreG: 3 } }] });
      expect(bad.isError).toBe(true);
      expect(bad.text).toMatch(/fibreG|unrecognized/i);
      const rice = (await callTool(client, "log_meal", { date: "2026-10-17", meal: "lunch", items: [{ name: "Rice", kcal: 200 }] })).value.added[0];
      expect((await callTool(client, "update_meal_entry", { id: rice.id, nutrients: { fibreG: 3 } })).isError).toBe(true);
      expect((await callTool(client, "get_nutrition", { from: "2026-10-17", to: "2026-10-17" })).value.total.entries).toBe(1); // only the rice was logged
    });

    it("explains what was refused, and keeps none of a bad call", async () => {
      const bad = await callTool(client, "log_meal", { date: "2026-10-17", meal: "lunch", items: [{ name: "Fine", kcal: 100 }, { name: "Air" }] });
      expect(bad.isError).toBe(true);
      expect(bad.text).toMatch(/needs calories or at least one macro/);
      expect((await callTool(client, "log_meal", { date: "2026-02-30", meal: "lunch", items: [{ name: "x", kcal: 1 }] })).text).toMatch(/not a day/);
      expect((await callTool(client, "update_meal_entry", { id: 424242, kcal: 1 })).text).toMatch(/no food entry 424242/);
      expect((await callTool(client, "get_nutrition", { from: "2026-10-17", to: "2026-10-01" })).text).toMatch(/after to/);
      expect((await callTool(client, "get_nutrition", { from: "2026-10-14", to: "2026-10-17" })).value.loggedDays).toBe(0);
    });

    it("refuses a profile that does not exist, as the web editor does, rather than logging under a made-up name", async () => {
      seedProfile("TESTER");
      configureMcp({ mock: false, defaultProfile: undefined });
      try {
        const item = { name: "Soup", kcal: 120 };
        const bad = await callTool(client, "log_meal", { profile: "NOPE", date: "2026-10-17", meal: "lunch", items: [item] });
        expect(bad.isError).toBe(true);
        expect(bad.text).toMatch(/Unknown profile "NOPE".*list_profiles/);
        expect((await callTool(client, "get_nutrition", { profile: "NOPE", days: 1 })).isError).toBe(true);
        expect(getStore().nutrition.range("NOPE", "2000-01-01", "2100-01-01")).toEqual([]);
        const ok = await callTool(client, "log_meal", { profile: "tester", date: "2026-10-17", meal: "lunch", items: [item] }); // any case
        expect(ok.value.profile).toBe("TESTER");
        getStore().nutrition.remove("TESTER", getStore().nutrition.range("TESTER", "2000-01-01", "2100-01-01").map((e) => e.id));
      } finally {
        configureMcp({ mock: true, defaultProfile: undefined });
      }
    });

    describe("the daily goals", () => {
      beforeEach(() => getStore().goals.set("mock", {}));
      afterAll(() => getStore().goals.set("mock", {}));

      it("sets them, keeps the ones not mentioned, removes one given as null, and reports where today stands", async () => {
        const first = await callTool(client, "set_nutrition_goals", { goals: { kcal: 2200, proteinG: 140, sodiumMg: 2300 } });
        expect(first.isError).toBe(false);
        expect(first.value.goals).toEqual([
          { key: "kcal", label: "Calories", unit: "kcal", kind: "target", goal: 2200 },
          { key: "proteinG", label: "Protein", unit: "g", kind: "min", goal: 140 },
          { key: "sodiumMg", label: "Sodium", unit: "mg", kind: "max", goal: 2300 },
        ]);
        expect(first.value.goalProgress.every((p: any) => p.state === "unknown")).toBe(true); // nothing logged today yet: not zero
        const second = await callTool(client, "set_nutrition_goals", { goals: { proteinG: null, fiberG: 30 } });
        expect(second.value.goals.map((g: any) => g.key)).toEqual(["kcal", "fiberG", "sodiumMg"]);
        expect(getStore().goals.get("mock")).toEqual({ kcal: 2200, fiberG: 30, sodiumMg: 2300 });
      });

      it("reports the day against the goals when food is logged and when the log is read", async () => {
        await callTool(client, "set_nutrition_goals", { goals: { kcal: 2000, proteinG: 100 } });
        const out = await callTool(client, "log_meal", { date: "2026-10-17", meal: "lunch", items: [{ name: "Chicken", kcal: 500, proteinG: 60 }] });
        expect(out.value.goalProgress).toEqual([
          expect.objectContaining({ key: "kcal", amount: 500, left: 1500, state: "short" }),
          expect.objectContaining({ key: "proteinG", amount: 60, left: 40, pct: 60 }),
        ]);
        const read = (await callTool(client, "get_nutrition", { from: "2026-10-17", to: "2026-10-17" })).value;
        expect(read.goals.map((g: any) => g.key)).toEqual(["kcal", "proteinG"]);
        expect(read.goalProgress[1]).toMatchObject({ key: "proteinG", amount: 60 });
      });

      it("follows the burn only when asked to: a share of the active calories added to the calorie goal", async () => {
        const off = await callTool(client, "set_nutrition_goals", { goals: { kcal: 2200 } });
        expect(off.value.kcalBurnPct).toBeNull();
        expect(off.value.goalProgress[0].adjust).toBeUndefined();
        expect((await callTool(client, "set_nutrition_goals", { goals: { kcalBurnPct: 50 } })).value.kcalBurnPct).toBe(50);
        expect(getStore().goals.get("mock")).toEqual({ kcal: 2200, kcalBurnPct: 50 });
        const read = (await callTool(client, "get_nutrition", { days: 1 })).value;
        expect(read.kcalBurnPct).toBe(50);
        expect(read.goals.map((g: any) => g.key)).toEqual(["kcal"]); // the share is not a goal
        expect(read.goalProgress[0]).toMatchObject({ key: "kcal", adjust: { base: 2200, pct: 50 } });
        expect((await callTool(client, "set_nutrition_goals", { goals: { kcalBurnPct: null } })).value.kcalBurnPct).toBeNull();
        for (const goals of [{ kcalBurnPct: 0 }, { kcalBurnPct: 101 }, { kcalBurnPct: 12.5 }]) expect((await callTool(client, "set_nutrition_goals", { goals })).isError).toBe(true);
        await callTool(client, "set_nutrition_goals", { goals: { kcal: null } });
        const none = await callTool(client, "set_nutrition_goals", { goals: { kcalBurnPct: 50 } });
        expect(none.isError).toBe(true);
        expect(getStore().goals.get("mock")).toEqual({});
      });

      it("has no goals to report until some are set", async () => {
        const read = (await callTool(client, "get_nutrition", { days: 1 })).value;
        expect(read.goals).toEqual([]);
        expect(read.goalProgress).toEqual([]);
      });

      it("refuses a goal that is not one, a zero and a number too big, and changes nothing", async () => {
        await callTool(client, "set_nutrition_goals", { goals: { kcal: 2000 } });
        for (const goals of [{ fibreG: 30 }, { kcal: 0 }, { kcal: 10001 }, { proteinG: 150, sodiumMg: -1 }, { proteinG: "lots" }]) expect((await callTool(client, "set_nutrition_goals", { goals })).isError).toBe(true);
        expect(getStore().goals.get("mock")).toEqual({ kcal: 2000 });
      });

      it("needs no Garmin login, and refuses a profile that does not exist rather than keeping goals under a made-up name", async () => {
        expect((await callTool(client, "set_nutrition_goals", { goals: { kcal: 2000 } })).log).toBe("");
        seedProfile("TESTER");
        configureMcp({ mock: false, defaultProfile: undefined });
        try {
          expect((await callTool(client, "set_nutrition_goals", { profile: "NOPE", goals: { kcal: 2000 } })).isError).toBe(true);
          expect(getStore().goals.get("NOPE")).toEqual({});
          expect((await callTool(client, "set_nutrition_goals", { profile: "tester", goals: { kcal: 1800 } })).value.profile).toBe("TESTER"); // any case
        } finally {
          getStore().goals.set("TESTER", {});
          configureMcp({ mock: true, defaultProfile: undefined });
        }
      });
    });

    it("needs no Garmin login: it works from the database in mock mode", async () => {
      const out = await callTool(client, "log_meal", { date: "2026-10-17", meal: "snack", items: [{ name: "Nuts", kcal: 180 }] });
      expect(out.isError).toBe(false);
      expect(out.log).toBe("");
    });
  });

  describe("create_workout and schedule_workout (one workout, no plan file)", () => {
    /** The message when the arguments are refused: an error result or a rejected call, depending on the SDK. */
    async function refusal(name: string, args: Record<string, unknown>): Promise<string | undefined> {
      const result: any = await client.callTool({ name, arguments: args }).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
      return result.isError ? result.content[0].text : undefined;
    }
    const withStep = (step: object) => ({ ...STRENGTH_WORKOUT, steps: [{ ...STRENGTH_WORKOUT.steps[0], ...step }] });

    it("validates a workout with dryRun, sends nothing and writes no plan", async () => {
      const plans = getStore().list("workout-plans/").length;
      const out = await callTool(client, "create_workout", { workout: STRENGTH_WORKOUT, dryRun: true });
      expect(out.isError).toBe(false);
      expect(out.value).toMatchObject({ dryRun: true, valid: true, workoutName: "Bench Day", workoutType: "strength_training", stepCount: 1 });
      expect(out.value.workoutId).toBeUndefined();
      expect(getStore().list("workout-plans/")).toHaveLength(plans);
    });

    it("says what is wrong with a workout, whether or not it is a dryRun", async () => {
      for (const dryRun of [true, false]) {
        const out = await callTool(client, "create_workout", { workout: withStep({ exerciseName: "NOT_A_REAL_EXERCISE" }), dryRun });
        expect(out.isError).toBe(true);
        expect(out.text).toMatch(/Workout not created: .*Unknown exerciseName/);
      }
    });

    it.each([
      ["workoutId", { workoutId: 5 }],
      ["scheduledDate", { scheduledDate: "2026-11-02" }],
      ["sendToDevice", { sendToDevice: true }],
      ["distanceMeters", { distanceMeters: 5000 }],
    ])("refuses %s, which only a plan has, rather than ignoring it", async (key, extra) => {
      expect(await refusal("create_workout", { workout: { ...STRENGTH_WORKOUT, ...extra }, dryRun: true })).toContain(key);
    });

    it("needs a workout type from the list and at least one step", async () => {
      const untyped = { workoutName: STRENGTH_WORKOUT.workoutName, steps: STRENGTH_WORKOUT.steps };
      expect(await refusal("create_workout", { workout: untyped, dryRun: true })).toContain("workoutType");
      expect(await refusal("create_workout", { workout: { ...STRENGTH_WORKOUT, workoutType: "strength" }, dryRun: true })).toContain("workoutType");
      expect(await refusal("create_workout", { workout: { ...STRENGTH_WORKOUT, steps: [] }, dryRun: true })).toContain("steps");
    });

    it("takes a distance-only run as one step", async () => {
      const run = { workoutName: "Easy 5k", workoutType: "running", steps: [{ stepType: "interval", targetType: "no.target", endCondition: "distance", endConditionValue: 5000, distanceMeters: 5000 }] };
      const out = await callTool(client, "create_workout", { workout: run, dryRun: true });
      expect(out.value).toMatchObject({ valid: true, workoutType: "running", stepCount: 1 });
    });

    it("refuses a day that does not exist and an id that is not one, before anything else", async () => {
      for (const date of ["2026-02-30", "2026-13-01", "2026-11-31"]) {
        expect(await refusal("schedule_workout", { workoutId: 12345, date })).toContain("is not a day");
      }
      expect(await refusal("schedule_workout", { workoutId: 12345, date: "next tuesday" })).toContain("YYYY-MM-DD");
      for (const workoutId of ["abc", "12ab", 0, -3, 1.5]) {
        expect(await refusal("schedule_workout", { workoutId, date: "2026-11-02" })).toContain("workoutId must be the number of a workout");
      }
    });
  });

  describe("mock mode never writes to Garmin", () => {
    const plan = "workout-plans/valid.json";

    it.each([
      ["upload_workouts", { path: plan }],
      ["upload_single_workout", { path: plan, workoutName: "Bench Day" }],
      ["schedule_plan", { path: plan }],
      ["upload_and_schedule_plan", { path: plan }],
      ["create_workout", { workout: STRENGTH_WORKOUT }],
      ["schedule_workout", { workoutId: 12345, date: "2026-11-02" }],
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

describe("Garmin and Renpho are optional (a profile without a Garmin login)", () => {
  let client: Client;
  beforeAll(async () => {
    seedProfile("PLAIN");
    seedProfile("WITHGARMIN", { garmin: true });
    configureMcp({ mock: false, defaultProfile: "PLAIN" });
    client = await connect();
  });
  afterAll(async () => {
    await client.close();
    configureMcp({ mock: true, defaultProfile: undefined });
  });

  it("list_profiles says which profiles have a Garmin login", async () => {
    const out = await callTool(client, "list_profiles");
    expect(out.value.profiles).toEqual(expect.arrayContaining(["PLAIN", "WITHGARMIN"]));
    expect(out.value.garminProfiles).toEqual(["WITHGARMIN"]);
  });

  it("the Garmin tools say there is no login instead of failing at the sign-in", async () => {
    for (const [name, args] of [["list_workouts", {}], ["list_devices", {}]] as const) {
      const out = await callTool(client, name, args);
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/Profile "PLAIN" has no Garmin login/);
    }
  });

  it("get_activities, get_readiness and get_wellness answer from what is stored, and say Garmin is not connected", async () => {
    const activities = await callTool(client, "get_activities", { period: "all" });
    expect(activities.isError).toBe(false);
    expect(activities.value.activities).toEqual([]);
    expect(activities.value.sync).toEqual(expect.objectContaining({ garmin: "not connected", note: expect.stringMatching(/no Garmin login/) }));
    const readiness = await callTool(client, "get_readiness");
    expect(readiness.isError).toBe(false);
    expect(readiness.value.profile).toBe("PLAIN");
    expect(readiness.value.sync.garmin).toBe("not connected");
    const wellness = await callTool(client, "get_wellness", { days: 7 });
    expect(wellness.isError).toBe(false);
    expect(wellness.value.sync.garmin).toBe("not connected");
  });

  it("the plan and food tools work for it as for any profile", async () => {
    const out = await callTool(client, "log_meal", { date: "2026-10-17", meal: "lunch", items: [{ name: "Soup", kcal: 120 }] });
    expect(out.isError).toBe(false);
    expect(out.value.profile).toBe("PLAIN");
    expect((await callTool(client, "list_plans")).isError).toBe(false);
  });

  it("write_plan gives a new plan to the named profile, else to the default, and an existing plan keeps its owner", async () => {
    const byDefault = await callTool(client, "write_plan", { path: "workout-plans/own-default.json", content: [{ workoutName: "a" }] });
    expect(byDefault.value.owner).toBe("PLAIN");
    expect(getStore().head("workout-plans/own-default.json")!.owner).toBe("PLAIN");
    const named = await callTool(client, "write_plan", { path: "workout-plans/own-named.json", content: [{ workoutName: "a" }], profile: "WITHGARMIN" });
    expect(named.value.owner).toBe("WITHGARMIN");
    expect(getStore().head("workout-plans/own-named.json")!.owner).toBe("WITHGARMIN");
    await callTool(client, "write_plan", { path: "workout-plans/own-named.json", content: [{ workoutName: "b" }], profile: "PLAIN" });
    expect(getStore().head("workout-plans/own-named.json")!.owner).toBe("WITHGARMIN");
    const unknown = await callTool(client, "write_plan", { path: "workout-plans/own-nobody.json", content: [], profile: "NOBODY" });
    expect(unknown.isError).toBe(true);
    expect(getStore().head("workout-plans/own-nobody.json")).toBeUndefined();
  });

  it("write_plan asks which profile a new plan is for when there are several and no default", async () => {
    configureMcp({ mock: false, defaultProfile: undefined });
    try {
      const out = await callTool(client, "write_plan", { path: "workout-plans/own-ambiguous.json", content: [] });
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/Multiple profiles are available/);
      expect(getStore().head("workout-plans/own-ambiguous.json")).toBeUndefined();
      // a plan under data/<profile>/ needs no profile argument: its path says whose it is
      expect((await callTool(client, "write_plan", { path: "data/PLAIN/note.json", content: { a: 1 } })).isError).toBe(false);
    } finally {
      configureMcp({ mock: false, defaultProfile: "PLAIN" });
    }
  });

  it("get_wellness counts the weigh-ins of a Renpho scale in the body trend, with or without Garmin", async () => {
    const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;
    for (let n = 1; n <= 20; n += 3) {
      getStore().renpho.addMeasurement("PLAIN", { id: `w${n}`, measuredAt: Date.parse(`${day(n)}T08:00:00Z`), day: day(n), data: { weight: 80 + n / 10, timeStamp: Date.parse(`${day(n)}T08:00:00Z`) / 1000, bodyfat: 18 } });
    }
    const out = await callTool(client, "get_wellness", { from: "2026-10-01", to: "2026-10-20" });
    expect(out.value.body.weighIns).toBe(7);
    expect(out.value.body.latest).toEqual({ day: "2026-10-19", kg: 81.9, bodyFatPercent: 18 });
    expect(out.value.body.direction).toBe("gaining");
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

  it("serves the icon at the root of the host without the token, and nothing else that way", async () => {
    const favicon = await fetch(`${base}/favicon.ico`);
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await favicon.arrayBuffer())).toEqual(fs.readFileSync(path.join(__dirname, "../web/public/apple-touch-icon.png")));
    const svg = await fetch(`${base}/icon.svg`);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect((await fetch(`${base}/icon.svg`, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(`${base}/icon.svg`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/apple-touch-icon.png`)).status).toBe(404);
  });

  it("answers initialize and tools/list with the token in the path", async () => {
    const res = await post(`${base}/mcp/${token}`, init);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.result.serverInfo.name).toBe("garmin-workout-editor");
    const [png, svg] = body.result.serverInfo.icons; // the website's icon, inline: the endpoint is behind the token
    expect(png).toMatchObject({ mimeType: "image/png", sizes: ["180x180"] });
    expect(svg).toMatchObject({ mimeType: "image/svg+xml", sizes: ["any"] });
    const decode = (src: string) => Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
    const site = (file: string) => fs.readFileSync(path.join(__dirname, "../web/public", file));
    expect(decode(png.src)).toEqual(site("apple-touch-icon.png"));
    expect(decode(svg.src)).toEqual(site("icon.svg"));

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
  });

  describe("profile loader overrides", () => {
    it("lists the profiles of the database and keeps mock data under GARMIN_DATA_DIR", () => {
      seedProfile("LISTED");
      expect(getAvailableProfiles()).toContain("LISTED");

      expect(getMockProfile().dataDir).toBe(path.join(dataDir, "mock"));
    });
  });
});
