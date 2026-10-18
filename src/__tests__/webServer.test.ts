import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { startWebServer, isLoopback } from "../web/server";
import * as garmin from "../mcp/tools/garmin";
import * as activitiesTools from "../mcp/tools/activities";
import { closeStore, getStore } from "../shared/store";
import { toNewActivity } from "../shared/activitySync";
import * as wellnessTools from "../mcp/tools/wellness";
import * as renphoTools from "../mcp/tools/renpho";
import * as settingsTools from "../mcp/tools/settings";
import { Decoder, Stream } from "@garmin/fitsdk";
import { renphoRow } from "./fixtures/renpho";
import { hrvResponse, noWeighIn, sleepResponse, summaryResponse, weightResponse } from "./fixtures/wellness";

// The Garmin actions are the MCP tool bodies; stub them so no test touches Garmin.
jest.mock("../mcp/tools/garmin", () => ({
  listDevices: jest.fn(async () => ({ devices: [{ deviceId: 7, displayName: "Watch" }] })),
  uploadPlan: jest.fn(async () => ({ status: "ok", successful: 1, failed: 0 })),
  schedulePlan: jest.fn(async () => ({ attempted: [] })),
  uploadAndSchedulePlan: jest.fn(async () => ({ workouts: [] })),
  sendPlanToDevice: jest.fn(async () => ({ requested: ["Easy run"] })),
  LIBRARY_LIMIT: 100,
  listLibraryWorkouts: jest.fn(async () => []),
  getLibraryWorkout: jest.fn(async () => null),
  checkWorkoutSync: jest.fn(async () => []),
  saveWorkout: jest.fn(async () => ({ workoutId: 999, previousWorkoutId: 5 })),
  deleteLibraryWorkout: jest.fn(async () => undefined),
}));
// Likewise Garmin's side of the activity sync.
jest.mock("../mcp/tools/activities", () => ({
  refreshActivities: jest.fn(async () => ({ added: 2, busy: false, error: null })),
  startBackgroundSync: jest.fn(() => ({ started: true })),
  fetchDetailsNow: jest.fn(async () => ({ fetched: 1, error: null })),
  fetchChartNow: jest.fn(async () => ({ fetched: 1, error: null })),
}));
// And Garmin's side of the wellness sync; what the sync status says is read from the real tables.
jest.mock("../mcp/tools/wellness", () => {
  const sync = jest.requireActual("../shared/wellnessSync");
  const stores = jest.requireActual("../shared/store");
  return {
    refreshWellness: jest.fn(async () => ({ fetched: 3, busy: false, error: null })),
    startBackgroundWellness: jest.fn(() => ({ started: true })),
    rereadWeighIns: jest.fn(() => 4),
    wellnessSyncStatus: (profile: string) => sync.wellnessStatus(stores.getStore(), profile, sync.localToday(stores.getStore(), profile)),
  };
});
// The Renpho and Garmin sides of the Settings view: no network.
jest.mock("../mcp/tools/renpho", () => ({
  runRenpho: jest.fn(async () => ({ ran: true, seen: 2, added: 2, others: 0, uploaded: 0, error: null })),
  startRenphoTimer: jest.fn(),
}));
jest.mock("../mcp/tools/settings", () => ({ testGarminLogin: jest.fn(async () => ({ ok: true, message: "Garmin accepted the login." })) }));
jest.mock("../shared/renphoSync", () => ({
  ...jest.requireActual("../shared/renphoSync"),
  testRenphoLogin: jest.fn(async () => ({ ok: true, message: "Renpho accepted the login (1 scale table on the account)." })),
}));
const g = garmin as jest.Mocked<typeof garmin>;
const a = activitiesTools as jest.Mocked<typeof activitiesTools>;
const w = wellnessTools as jest.Mocked<typeof wellnessTools>;
const rt = renphoTools as jest.Mocked<typeof renphoTools>;
const st = settingsTools as jest.Mocked<typeof settingsTools>;

const store = () => getStore();
const seed = (logical: string, value: unknown) => store().put(logical, typeof value === "string" ? value : JSON.stringify(value), { source: "test" });
const stored = (logical: string) => store().get(logical)?.text;
const versionOf = (logical: string) => store().head(logical)!.version;

const H = { "Content-Type": "application/json", "X-Requested-With": "plan-editor" };

describe("web plan editor", () => {
  let dir: string;
  let server: http.Server;
  let base: string;
  const prevData = process.env.GARMIN_DATA_DIR;
  const prevProfiles = process.env.GARMIN_PROFILES_DIR;
  const prevDefault = process.env.GARMIN_PROFILE;

  const plan = {
    weekStart: "2026-10-12",
    weekEnd: "2026-10-18",
    workouts: [{ workoutName: "Easy run", workoutType: "running", distanceMeters: 5000 }],
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-test-"));
    fs.mkdirSync(path.join(dir, "data"));
    process.env.GARMIN_DATA_DIR = path.join(dir, "data");
    process.env.GARMIN_PROFILES_DIR = path.join(dir, "config");
    delete process.env.GARMIN_PROFILE;
    fs.mkdirSync(path.join(dir, "config"));
    jest.clearAllMocks();
    seed("workout-plans/a.json", plan);
    server = await startWebServer({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    closeStore();
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevData === undefined) delete process.env.GARMIN_DATA_DIR; else process.env.GARMIN_DATA_DIR = prevData;
    if (prevProfiles === undefined) delete process.env.GARMIN_PROFILES_DIR; else process.env.GARMIN_PROFILES_DIR = prevProfiles;
    if (prevDefault === undefined) delete process.env.GARMIN_PROFILE; else process.env.GARMIN_PROFILE = prevDefault;
  });
  const addProfile = (name: string, webPassword?: string) =>
    fs.writeFileSync(
      path.join(dir, "config", `.env.${name}`),
      `GARMIN_EMAIL=a@b.c\nGARMIN_PASSWORD=x\n${webPassword ? `WEB_PASSWORD=${webPassword}\n` : ""}`
    );

  const call = async (method: string, url: string, body?: unknown, headers = H) => {
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  const q = (p: string) => `/api/file?path=${encodeURIComponent(p)}`;

  it("lists, reads, updates, renames and deletes", async () => {
    const list = await call("GET", "/api/files");
    expect(list.json.files).toEqual([expect.objectContaining({ path: "workout-plans/a.json", workoutCount: 1 })]);

    const read = await call("GET", q("workout-plans/a.json"));
    expect(JSON.parse(read.json.text)).toEqual(plan);

    const text = JSON.stringify({ ...plan, notes: "hi" }, null, 2);
    const put = await call("PUT", q("workout-plans/a.json"), { text, version: read.json.version });
    expect(put.status).toBe(200);
    expect(put.json.validation.valid).toBe(true);
    expect(put.json.version).not.toBe(read.json.version);
    expect(stored("workout-plans/a.json")).toBe(text);

    const ren = await call("POST", "/api/rename", { from: "workout-plans/a.json", to: "workout-plans/b.json" });
    expect(ren.status).toBe(200);
    expect(store().head("workout-plans/b.json")).toBeDefined();
    expect((await call("GET", q("workout-plans/a.json"))).status).toBe(404);

    expect((await call("DELETE", q("workout-plans/b.json"))).status).toBe(200);
    expect(store().head("workout-plans/b.json")).toBeUndefined();
    expect((await call("DELETE", q("workout-plans/b.json"))).status).toBe(404);
  });

  it("keeps the versions it replaced and lets the editor read them", async () => {
    const read = await call("GET", q("workout-plans/a.json"));
    expect((await call("GET", `/api/history?path=${encodeURIComponent("workout-plans/a.json")}`)).json.revisions).toEqual([]);

    await call("PUT", q("workout-plans/a.json"), { text: JSON.stringify({ ...plan, notes: "edited" }), version: read.json.version });
    const history = await call("GET", `/api/history?path=${encodeURIComponent("workout-plans/a.json")}`);
    expect(history.json.current).toEqual(expect.objectContaining({ path: "workout-plans/a.json", source: "web" }));
    expect(history.json.revisions).toEqual([expect.objectContaining({ source: "test", version: read.json.version })]);

    const old = await call("GET", `/api/revision?path=${encodeURIComponent("workout-plans/a.json")}&id=${history.json.revisions[0].id}`);
    expect(JSON.parse(old.json.text)).toEqual(plan);
    expect((await call("GET", `/api/revision?path=${encodeURIComponent("workout-plans/a.json")}&id=9999`)).status).toBe(404);
    expect((await call("GET", `/api/history?path=${encodeURIComponent("workout-plans/none.json")}`)).status).toBe(404);
  });

  it("creates new files and refuses to overwrite them", async () => {
    const text = JSON.stringify(plan);
    expect((await call("PUT", q("workout-plans/new.json"), { text, create: true })).status).toBe(201);
    expect((await call("PUT", q("workout-plans/new.json"), { text, create: true })).status).toBe(409);
  });

  it("detects concurrent changes", async () => {
    const read = await call("GET", q("workout-plans/a.json"));
    seed("workout-plans/a.json", "[]"); // someone else saves first
    const put = await call("PUT", q("workout-plans/a.json"), { text: "{}", version: read.json.version });
    expect(put.status).toBe(409);
    expect(stored("workout-plans/a.json")).toBe("[]");
    expect((await call("PUT", q("workout-plans/none.json"), { text: "{}", version: 1 })).status).toBe(404);
  });

  it("rejects invalid JSON, path escapes and missing CSRF header", async () => {
    expect((await call("PUT", q("workout-plans/a.json"), { text: "{oops" })).status).toBe(400);
    expect((await call("GET", q("workout-plans/../secret.json"))).status).toBe(400);
    expect((await call("GET", q("workout-plans/.env.json"))).status).toBe(400);
    expect((await call("DELETE", q("workout-plans/a.json"), undefined, {} as any)).status).toBe(403);
  });

  it("reports validation errors without blocking the save", async () => {
    const bad = { workouts: [{ workoutName: "x", workoutType: "strength_training", steps: [{ stepType: "nope", targetType: "no.target" }] }] };
    const r = await call("POST", "/api/validate", { text: JSON.stringify(bad) });
    expect(r.json.validation.valid).toBe(false);
    expect(r.json.validation.errors.length).toBeGreaterThan(0);
  });

  it("requires a token off loopback and enforces Basic auth when set", async () => {
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(() => startWebServer({ host: "0.0.0.0", port: 0 })).toThrow(/WEB_AUTH_TOKEN/);
    const secured = await startWebServer({ host: "127.0.0.1", port: 0, token: "s3cret" });
    const url = `http://127.0.0.1:${(secured.address() as AddressInfo).port}/api/files`;
    const refused = await fetch(url);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBeNull(); // the page has its own form; no browser dialog
    const auth = "Basic " + Buffer.from("me:s3cret").toString("base64");
    expect((await fetch(url, { headers: { Authorization: auth } })).status).toBe(200);
    await new Promise((r) => secured.close(r));
  });

  it("serves the UI", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("vendor/monaco");
  });

  describe("calendar", () => {
    const run = (workoutName: string, scheduledDate?: unknown, extra: object = {}) => ({ workoutName, workoutType: "running", scheduledDate, ...extra });
    const calendar = async (headers = H) => (await call("GET", "/api/calendar", undefined, headers)).json.plans as any[];
    const byPath = (plans: any[], p: string) => plans.find((x) => x.path === p);

    it("lists each plan's workouts with their dates, whether written as one date or a list", async () => {
      seed("workout-plans/b.json", { workouts: [run("One", "2026-08-01"), run("Many", ["2026-08-05", "2026-08-03", "2026-08-03"]), run("None")] });
      const plans = await calendar();
      expect(plans.map((p) => p.path)).toEqual(["workout-plans/b.json", "workout-plans/a.json"]); // dated first
      expect(byPath(plans, "workout-plans/b.json").workouts).toEqual([
        expect.objectContaining({ index: 0, workoutName: "One", workoutType: "running", dates: ["2026-08-01"] }),
        expect.objectContaining({ index: 1, workoutName: "Many", dates: ["2026-08-03", "2026-08-05"] }),
        expect.objectContaining({ index: 2, workoutName: "None", dates: [] }),
      ]);
    });

    it("widens a plan's span beyond weekStart and weekEnd with its scheduled dates", async () => {
      seed("workout-plans/hm.json", { weekStart: "2026-07-27", weekEnd: "2026-08-02", workouts: [run("Early", "2026-07-20"), run("Late", ["2026-08-16", "2026-09-20"]), run("Undated")] });
      expect(byPath(await calendar(), "workout-plans/hm.json")).toEqual(expect.objectContaining({ weekStart: "2026-07-27", weekEnd: "2026-08-02", start: "2026-07-20", end: "2026-09-20" }));
    });

    it("keeps the week range for a plan with no scheduled workout, and flags a plan with no dates at all", async () => {
      seed("workout-plans/windowed.json", { weekStart: "2026-10-12", weekEnd: "2026-11-08", workouts: [run("A"), run("B")] });
      seed("workout-plans/bare.json", [run("Loose")]);
      const plans = await calendar();
      expect(byPath(plans, "workout-plans/windowed.json")).toEqual(expect.objectContaining({ start: "2026-10-12", end: "2026-11-08" }));
      expect(byPath(plans, "workout-plans/windowed.json").workouts.every((w: any) => w.dates.length === 0)).toBe(true);
      expect(byPath(plans, "workout-plans/bare.json")).toEqual(expect.objectContaining({ start: null, end: null }));
      expect(byPath(plans, "workout-plans/a.json")).toEqual(expect.objectContaining({ start: "2026-10-12", end: "2026-10-18" })); // the default plan: week range only
    });

    it("ignores values that are not real dates", async () => {
      seed("workout-plans/odd.json", { weekStart: "soon", weekEnd: "2026-02-30", workouts: [run("Bad", ["2026-13-01", "2026-8-1", 20260801, null, "2026-08-04"])] });
      const odd = byPath(await calendar(), "workout-plans/odd.json");
      expect(odd.workouts[0].dates).toEqual(["2026-08-04"]);
      expect(odd).toEqual(expect.objectContaining({ start: "2026-08-04", end: "2026-08-04" }));
      expect(odd.weekStart).toBeUndefined();
    });

    it("leaves out Garmin library exports and documents that are not workout lists", async () => {
      seed("data/MED/workouts.json", [run("Exported", "2026-08-01")]);
      seed("data/MED/workouts-raw.json", [run("Raw", "2026-08-01")]);
      seed("data/MED/training-plan.json", { goals: { primary: "HM" } });
      seed("data/MED/mine.json", { workouts: [run("Mine", "2026-08-02")] });
      seed("workout-plans/notes.json", "not json at all");
      expect((await calendar()).map((p) => p.path).sort()).toEqual(["data/MED/mine.json", "workout-plans/a.json"]);
    });

    it("works without any Garmin profile configured", async () => {
      expect((await call("GET", "/api/garmin")).json.enabled).toBe(false);
      expect((await call("GET", "/api/calendar")).status).toBe(200);
    });

    it("keeps a profile login to its own data folder and the plans it may see", async () => {
      addProfile("MED", "med-pw");
      addProfile("SAM", "sam-pw");
      seed("data/MED/w.json", { workouts: [run("Med run", "2026-08-01")] });
      seed("data/SAM/w.json", { workouts: [run("Sam run", "2026-08-01")] });
      const login = (user: string, pass: string) => ({ ...H, Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") });

      expect((await call("GET", "/api/calendar")).status).toBe(401);
      expect((await calendar(login("MED", "med-pw"))).map((p) => p.path).sort()).toEqual(["data/MED/w.json", "workout-plans/a.json"]);
      expect((await calendar(login("SAM", "sam-pw"))).map((p) => p.path).sort()).toEqual(["data/SAM/w.json", "workout-plans/a.json"]);
    });
  });

  describe("runs for the workout picture", () => {
    // A Garmin list item: distance in meters, speed in m/s, the start as GMT and local text.
    const item = (id: number, day: string, paceSecPerKm: number, avgHR: number, extra: Record<string, unknown> = {}) => ({
      activityId: id,
      activityName: "Run",
      activityType: { typeKey: "running" },
      startTimeGMT: `${day} 12:00:00`,
      startTimeLocal: `${day} 08:00:00`,
      distance: 10000,
      duration: paceSecPerKm * 10,
      averageSpeed: 1000 / paceSecPerKm,
      averageHR: avgHR,
      ...extra,
    });
    const keep = (profile: string, ...items: any[]) => store().activities.insertNew(profile, items.map((i) => toNewActivity(i)!));
    const runs = async (query = "", headers = H) => (await call("GET", "/api/runs" + query, undefined, headers)).json as { profile: string | null; runs: any[] };

    it("lists the profile's recent runs, newest first, with the pace in seconds per km", async () => {
      addProfile("MED");
      keep("MED", item(1, "2026-08-01", 330, 150), item(2, "2026-08-20", 315, 155.4, { distance: 8460 }));
      expect(await runs()).toEqual({
        profile: "MED",
        runs: [
          { date: "2026-08-20", km: 8.5, pace: 315, hr: 155 },
          { date: "2026-08-01", km: 10, pace: 330, hr: 150 },
        ],
      });
    });

    it("counts each run once, however often it was listed", async () => {
      addProfile("MED");
      keep("MED", item(1, "2026-08-01", 330, 150));
      keep("MED", item(1, "2026-08-01", 330, 150), item(2, "2026-08-03", 336, 148));
      expect((await runs()).runs.map((r) => r.date)).toEqual(["2026-08-03", "2026-08-01"]);
    });

    it("leaves out what would skew a pace: other sports, short runs, treadmill and glitch readings", async () => {
      addProfile("MED");
      keep(
        "MED",
        item(1, "2026-08-01", 330, 150),
        item(2, "2026-08-02", 330, 150, { activityType: { typeKey: "cycling" } }),
        item(3, "2026-08-03", 330, 150, { distance: 1200 }),
        item(4, "2026-08-04", 642, 136),
        item(5, "2026-08-05", 120, 150),
        item(6, "2026-08-06", 330, 0, { averageHR: null }),
        item(7, "2026-08-07", 330, 150, { averageSpeed: 0 })
      );
      expect((await runs()).runs.map((r) => r.date)).toEqual(["2026-08-01"]);
    });

    it("keeps only the months before the newest run, so old fitness does not set today's pace", async () => {
      addProfile("MED");
      keep("MED", item(1, "2026-03-01", 390, 140), item(2, "2026-07-01", 330, 150), item(3, "2026-08-01", 324, 152));
      expect((await runs()).runs.map((r) => r.date)).toEqual(["2026-08-01", "2026-07-01"]);
    });

    it("needs no Garmin login, and has no runs where there is no profile", async () => {
      expect(await runs()).toEqual({ profile: null, runs: [] });
      addProfile("MED");
      expect((await call("GET", "/api/runs")).status).toBe(200);
    });

    it("gives a profile login its own runs only", async () => {
      addProfile("MED", "med-pw");
      addProfile("SAM", "sam-pw");
      keep("MED", item(1, "2026-08-01", 330, 150));
      keep("SAM", item(2, "2026-08-02", 270, 165));
      const login = (user: string, pass: string) => ({ ...H, Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") });
      expect((await runs("", login("MED", "med-pw"))).runs.map((r) => r.pace)).toEqual([330]);
      expect((await runs("?profile=SAM", login("MED", "med-pw"))).runs.map((r) => r.pace)).toEqual([330]); // a profile login always acts as itself
      expect((await runs("?profile=SAM", login("SAM", "sam-pw"))).runs.map((r) => r.pace)).toEqual([270]);
    });
  });

  describe("map library", () => {
    it("serves Leaflet from node_modules, with its stylesheet and images, without a login", async () => {
      for (const [file, type] of [["leaflet.js", /javascript/], ["leaflet.css", /css/], ["images/marker-icon.png", /image\/png/]] as const) {
        const res = await fetch(`${base}/vendor/leaflet/${file}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toMatch(type);
      }
      expect((await fetch(`${base}/vendor/leaflet/../package.json`)).status).toBe(404);
      expect((await fetch(`${base}/vendor/leaflet/missing.js`)).status).toBe(404);
      expect((await fetch(`${base}/activityMap.js`)).status).toBe(200);
    });
  });

  describe("activities view", () => {
    const item = (id: number, day: string, typeKey: string, extra: Record<string, unknown> = {}) => ({
      activityId: id,
      activityName: `Activity ${id}`,
      activityType: { typeKey },
      startTimeGMT: `${day} 12:00:00`,
      startTimeLocal: `${day} 08:30:00`,
      distance: typeKey === "running" ? 10000 : undefined,
      duration: 3000.4,
      averageSpeed: typeKey === "running" ? 3.2 : undefined,
      averageHR: 148.6,
      maxHR: 171,
      trainingEffectLabel: "TEMPO",
      aerobicTrainingEffect: 3.4,
      calories: 640,
      totalSets: typeKey === "strength_training" ? 18 : undefined,
      totalReps: typeKey === "strength_training" ? 96 : undefined,
      workoutId: 777,
      ...extra,
    });
    const keep = (profile: string, ...items: any[]) => store().activities.insertNew(profile, items.map((i) => toNewActivity(i)!));
    const login = (user: string, pass: string) => ({ ...H, Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") });

    it("lists compact rows, newest first, and never the raw Garmin JSON", async () => {
      addProfile("MED");
      keep("MED", item(1, "2026-08-01", "running"), item(2, "2026-08-03", "strength_training"));
      store().activities.setDetail("MED", "2", { summaryDTO: {} });
      const out = (await call("GET", "/api/activities")).json;
      expect(out.profile).toBe("MED");
      expect(out.activities.map((r: any) => r.id)).toEqual(["2", "1"]);
      expect(out.activities.map((r: any) => r.detailed)).toEqual([true, false]);
    });

    it("rows carry what a list shows: date and time from the local start, km, seconds, pace for a run, HR, effect, sets", async () => {
      addProfile("MED");
      keep("MED", item(1, "2026-08-01", "running"), item(2, "2026-08-03", "strength_training"));
      const [strength, run] = (await call("GET", "/api/activities")).json.activities;
      expect(run).toEqual({
        id: "1", date: "2026-08-01", time: "08:30", type: "running", name: "Activity 1", km: 10, seconds: 3000, paceSec: 313,
        avgHr: 149, maxHr: 171, effect: "TEMPO", aerobic: 3.4, elevation: null, calories: 640, sets: null, reps: null, workoutId: "777", detailed: false,
      });
      expect(strength).toEqual(expect.objectContaining({ type: "strength_training", km: null, paceSec: null, sets: 18, reps: 96 }));
      expect(JSON.stringify((await call("GET", "/api/activities")).json)).not.toMatch(/activityTypeDTO|startTimeGMT/);
    });

    it("says how far the sync is", async () => {
      addProfile("MED");
      keep("MED", item(1, "2026-08-01", "running"));
      const { sync } = (await call("GET", "/api/activities")).json;
      expect(sync).toEqual(expect.objectContaining({ activities: 1, withDetails: 0, pendingDetails: 1, historyComplete: false, syncing: false }));
    });

    it("is empty, not an error, with no profile and in mock mode", async () => {
      expect((await call("GET", "/api/activities")).json).toEqual({ profile: null, activities: [], sync: null });
      addProfile("MED");
      expect((await call("GET", "/api/activities")).json).toEqual(expect.objectContaining({ profile: "MED", activities: [] }));
    });

    it("gives one activity's slim form, whether its details are stored, and the plan workout it came from", async () => {
      addProfile("MED");
      keep("MED", item(1, "2026-08-01", "strength_training", { workoutId: 4242 }));
      seed("workout-plans/lift.json", { workouts: [{ workoutName: "Lift", workoutType: "strength_training", workoutId: 4242 }, { workoutName: "Other", workoutId: 1 }] });
      const bare = (await call("GET", "/api/activity?id=1")).json;
      expect(bare.detailed).toBe(false);
      expect(bare.activity).toEqual(expect.objectContaining({ id: "1", detailed: false, sets: 18 }));
      expect(bare.planned).toEqual({ path: "workout-plans/lift.json", index: 0, workout: expect.objectContaining({ workoutName: "Lift" }) });

      store().activities.setDetail("MED", "1", { summaryDTO: { directWorkoutRpe: 40, directWorkoutFeel: 70 }, fullExerciseSets: [] });
      const full = (await call("GET", "/api/activity?id=1")).json;
      expect(full.detailed).toBe(true);
      expect(full.slim).toEqual(expect.objectContaining({ activityType: "strength_training", directWorkoutRpe: 40, directWorkoutFeel: 70 }));
      expect(a.fetchDetailsNow).not.toHaveBeenCalled(); // a read never calls Garmin
    });

    it("gives each lift of an activity the same one-rep max the Stats view shows: the best set ever, from the stored sets alone", async () => {
      addProfile("MED");
      const lb = (n: number) => n * 453.6; // Garmin's weight unit
      const day = (id: number, date: string, exercise: string, ...sets: [number, number][]) => {
        keep("MED", item(id, date, "strength_training"));
        store().activities.setDetail("MED", String(id), {
          fullExerciseSets: sets.map(([reps, pounds]) => ({ setType: "ACTIVE", exercises: [{ category: "X", name: exercise }], repetitionCount: reps, weight: lb(pounds) })),
        });
      };
      day(1, "2026-01-01", "BARBELL_BENCH_PRESS", [1, 300]); // long ago
      day(2, "2026-07-01", "BARBELL_BENCH_PRESS", [3, 225]);
      day(3, "2026-08-01", "BARBELL_BENCH_PRESS", [6, 200]); // the activity looked at
      day(4, "2026-08-01", "DUMBBELL_CURL", [10, 30]);
      day(5, "2026-09-01", "BARBELL_BENCH_PRESS", [1, 400]); // later than the activity: still counts, it is the best set ever
      const max = async (id: number) => (await call("GET", `/api/activity?id=${id}`)).json.oneRepMax;
      expect(Object.keys(await max(3))).toEqual(["Barbell Bench Press"]); // only this activity's exercises
      expect((await max(3))["Barbell Bench Press"]).toEqual({ oneRm: 400, weight: 400, reps: 1, date: "2026-09-01" });
      expect((await max(1))["Barbell Bench Press"]).toEqual((await max(3))["Barbell Bench Press"]); // the same answer from any activity
      expect(await max(4)).toEqual({ "Dumbbell Curl": { oneRm: 40, weight: 30, reps: 10, date: "2026-08-01" } });
      const bench = (await call("GET", "/api/activities/stats")).json.stats.strength.exercises.find((e: any) => e.name === "Barbell Bench Press");
      expect(bench.best).toEqual((await max(3))["Barbell Bench Press"]); // Stats agrees

      // a training plan with benchmarks is not read: it changes nothing
      seed("data/MED/training-plan.json", { strengthBenchmarks: { BARBELL_BENCH_PRESS: { oneRepMax: 266 } } });
      expect((await max(3))["Barbell Bench Press"]).toEqual({ oneRm: 400, weight: 400, reps: 1, date: "2026-09-01" });

      keep("MED", item(6, "2026-08-02", "running"));
      expect((await call("GET", "/api/activity?id=6")).json.oneRepMax).toEqual({}); // a run has no lifts
    });

    it("gives the lifetime stats of the profile, empty without a profile, and current after an activity is added", async () => {
      expect((await call("GET", "/api/activities/stats")).json).toEqual({ profile: null, stats: null });
      addProfile("MED");
      expect((await call("GET", "/api/activities/stats")).json.stats).toEqual(expect.objectContaining({ activities: 0, running: null, strength: null }));
      keep("MED", item(1, "2026-08-01", "running", { distance: 10000, elevationGain: 55 }));
      const one = (await call("GET", "/api/activities/stats")).json;
      expect(one.profile).toBe("MED");
      expect(one.stats).toEqual(expect.objectContaining({ activities: 1, since: "2026-08-01" }));
      expect(one.stats.running).toEqual(expect.objectContaining({ runs: 1, meters: 10000, gain: 55 }));
      keep("MED", item(2, "2026-08-03", "running", { distance: 5000 }));
      expect((await call("GET", "/api/activities/stats")).json.stats.running.runs).toBe(2);
      expect(a.fetchDetailsNow).not.toHaveBeenCalled(); // a read never calls Garmin
    });

    describe("the Recovery view", () => {
      const savedTz = process.env.GARMIN_TZ;
      beforeEach(() => {
        process.env.GARMIN_TZ = "UTC";
      });
      afterEach(() => {
        if (savedTz === undefined) delete process.env.GARMIN_TZ; else process.env.GARMIN_TZ = savedTz;
      });
      const today = () => new Date().toISOString().slice(0, 10);
      const dayOf = (back: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
      const fill = (profile: string, days: number) => {
        for (let i = 0; i < days; i++) {
          const d = dayOf(i);
          store().wellness.put(profile, d, "sleep", sleepResponse({ hrv: 50 + (i % 5) }));
          store().wellness.put(profile, d, "hrv", hrvResponse({ last: 50 + (i % 5) }));
          store().wellness.put(profile, d, "summary", summaryResponse({ rhr: 50 }));
        }
      };

      it("gives the readiness, the days and what is stored, from the database alone", async () => {
        expect((await call("GET", "/api/wellness")).json).toEqual({ profile: null });
        addProfile("MED");
        const empty = (await call("GET", "/api/wellness")).json;
        expect(empty).toEqual(expect.objectContaining({ profile: "MED", date: today(), today: today(), days: [], stored: [] }));
        expect(empty.readiness.band).toBe("unknown");
        expect(empty.sync).toEqual(expect.objectContaining({ days: 0, rows: 0, syncing: false }));

        fill("MED", 40);
        const out = (await call("GET", "/api/wellness")).json;
        expect(out.days).toHaveLength(30); // the last 30 days by default, oldest first
        expect(out.days[0].day).toBe(dayOf(29));
        expect(out.days[29]).toEqual(expect.objectContaining({ day: today(), hrvLastNight: 50, restingHr: 50, sleepSeconds: 27_000 }));
        expect(out.readiness).toEqual(expect.objectContaining({ date: today(), band: expect.stringMatching(/go-harder|as-planned|back-off/) }));
        expect(out.baselines).toEqual(expect.objectContaining({ restingHr: 50 }));
        expect(out.stored.map((s: any) => s.kind)).toEqual(["summary", "sleep", "hrv"]);
        expect(out.stored[0]).toEqual({ kind: "summary", fetchedAt: expect.any(Number), bytes: expect.any(Number) });
        expect(out.sync).toEqual(expect.objectContaining({ days: 40, rows: 120 }));
        expect(w.refreshWellness).not.toHaveBeenCalled(); // a read never calls Garmin
        expect(w.startBackgroundWellness).not.toHaveBeenCalled();
      });

      it("answers for another day and another number of days, and ignores what is not a date", async () => {
        addProfile("MED");
        fill("MED", 40);
        const past = (await call("GET", `/api/wellness?date=${dayOf(10)}&days=14`)).json;
        expect(past.date).toBe(dayOf(10));
        expect(past.readiness.date).toBe(dayOf(10));
        expect(past.days).toHaveLength(14);
        expect(past.days[13].day).toBe(dayOf(10));
        expect((await call("GET", "/api/wellness?days=3")).json.days).toHaveLength(7); // at least a week
        expect((await call("GET", "/api/wellness?days=500")).json.days).toHaveLength(40); // at most 90, and only what is stored
        expect((await call("GET", "/api/wellness?date=yesterday")).json.date).toBe(today());
      });

      it("keeps one profile's data from another's", async () => {
        addProfile("MED");
        addProfile("SAM");
        fill("MED", 5);
        expect((await call("GET", "/api/wellness?profile=SAM")).json.days).toEqual([]);
        expect((await call("GET", "/api/wellness?profile=MED")).json.days).toHaveLength(5);
      });

      it("returns Garmin's complete stored response of one kind, and says when there is none", async () => {
        addProfile("MED");
        fill("MED", 2);
        const raw = (await call("GET", `/api/wellness/raw?date=${today()}&kind=sleep`)).json;
        expect(raw).toEqual({ profile: "MED", date: today(), kind: "sleep", fetchedAt: expect.any(Number), data: sleepResponse({ hrv: 50 }) });
        expect((await call("GET", `/api/wellness/raw?date=${today()}&kind=stress`)).status).toBe(404);
        expect((await call("GET", `/api/wellness/raw?date=${dayOf(9)}&kind=sleep`)).status).toBe(404);
        expect((await call("GET", `/api/wellness/raw?date=${today()}&kind=nonsense`)).status).toBe(400);
        expect((await call("GET", "/api/wellness/raw?date=today&kind=sleep")).status).toBe(400);
      });

      it("syncs only through a POST that needs a Garmin profile, and starts the background fill with it", async () => {
        expect((await call("POST", "/api/wellness/sync", {})).status).toBe(409); // no profile configured
        addProfile("MED");
        const out = await call("POST", "/api/wellness/sync", {});
        expect(out.status).toBe(200);
        expect(out.json).toEqual(expect.objectContaining({ fetched: 3, busy: false, error: null, background: { started: true } }));
        expect(w.refreshWellness).toHaveBeenLastCalledWith("MED");
        expect(w.startBackgroundWellness).toHaveBeenCalledWith("MED");
        expect(w.rereadWeighIns).not.toHaveBeenCalled(); // only when the Weight view asks
        await call("POST", "/api/wellness/sync", { rereadWeight: true });
        expect(w.rereadWeighIns).toHaveBeenCalledWith("MED");
        expect(out.json.sync).toEqual(expect.objectContaining({ days: 0, syncing: false }));
      });

      it("shows each person only their own profile's data", async () => {
        addProfile("MED", "med-pw");
        addProfile("SAM", "sam-pw");
        fill("MED", 3);
        fill("SAM", 8);
        const login = (user: string, pass: string) => ({ ...H, Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` });
        expect((await call("GET", "/api/wellness", undefined, login("SAM", "sam-pw"))).json.days).toHaveLength(8);
        expect((await call("GET", "/api/wellness?profile=MED", undefined, login("SAM", "sam-pw"))).json.days).toHaveLength(8); // SAM asking for MED gets SAM's
        expect((await call("GET", "/api/wellness", undefined, login("MED", "med-pw"))).json.days).toHaveLength(3);
      });
    });

    describe("the Food view", () => {
      const savedTz = process.env.GARMIN_TZ;
      beforeEach(() => {
        process.env.GARMIN_TZ = "UTC";
      });
      afterEach(() => {
        if (savedTz === undefined) delete process.env.GARMIN_TZ; else process.env.GARMIN_TZ = savedTz;
      });
      const today = () => new Date().toISOString().slice(0, 10);
      const dayOf = (back: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
      const rice = { name: "Rice", kcal: 200, proteinG: 4, carbsG: 45, fatG: 0.5 };

      it("has no profile, no log", async () => {
        expect((await call("GET", "/api/nutrition")).json).toEqual({ profile: null });
        expect((await call("POST", "/api/nutrition", { action: "add", meal: "lunch", items: [rice] })).status).toBe(400);
      });

      it("adds the foods of a meal to a day, and answers with the day as it is now", async () => {
        addProfile("MED");
        const empty = (await call("GET", "/api/nutrition")).json;
        expect(empty).toEqual(expect.objectContaining({ profile: "MED", today: today(), date: today(), meals: ["breakfast", "lunch", "dinner", "snack"], average: null, recent: [] }));
        expect(empty.day.entries).toBe(0);
        expect(empty.days).toHaveLength(30);

        const out = await call("POST", "/api/nutrition", { action: "add", day: today(), meal: "lunch", items: [rice, { name: "Chicken", proteinG: 30, fatG: 5 }] });
        expect(out.status).toBe(200);
        expect(out.json.day).toMatchObject({ day: today(), kcal: 365, entries: 2, proteinG: 34 });
        expect(out.json.day.meals.find((m: any) => m.meal === "lunch").entries.map((e: any) => [e.name, e.source])).toEqual([["Rice", "web"], ["Chicken", "web"]]);
        expect(out.json.days.at(-1)).toMatchObject({ day: today(), kcal: 365 });
        expect(out.json.days[0].meals).toBeUndefined(); // the trend carries totals only
        expect(out.json.recent.map((r: any) => r.name)).toEqual(["Chicken", "Rice"]);
      });

      it("changes and deletes an entry", async () => {
        addProfile("MED");
        const id = (await call("POST", "/api/nutrition", { action: "add", day: dayOf(2), meal: "dinner", items: [rice] })).json.day.meals[2].entries[0].id;
        const changed = await call("POST", "/api/nutrition", { action: "update", id, name: "Brown rice", kcal: 220, proteinG: 5, carbsG: 46, fatG: 2, meal: "lunch" });
        expect(changed.json.date).toBe(dayOf(2));
        expect(changed.json.day.meals[1].entries).toEqual([expect.objectContaining({ id, name: "Brown rice", kcal: 220 })]);
        expect(changed.json.day.meals[2].entries).toEqual([]);
        const gone = await call("POST", "/api/nutrition", { action: "delete", id });
        expect(gone.status).toBe(200);
        expect(gone.json.date).toBe(dayOf(2));
        expect(gone.json.day.entries).toBe(0);
        expect((await call("POST", "/api/nutrition", { action: "update", id, kcal: 1 })).status).toBe(400);
        expect((await call("POST", "/api/nutrition", { action: "delete", id })).status).toBe(200); // a retry finds it gone
        expect((await call("POST", "/api/nutrition", { action: "explode" })).status).toBe(400);
      });

      it("refuses a bad food with its reason, and keeps none of the request", async () => {
        addProfile("MED");
        const bad = await call("POST", "/api/nutrition", { action: "add", meal: "lunch", items: [rice, { name: "Air" }] });
        expect(bad.status).toBe(400);
        expect(bad.json.error).toMatch(/needs calories or at least one macro/);
        expect((await call("POST", "/api/nutrition", { action: "add", meal: "brunch", items: [rice] })).json.error).toMatch(/meal must be/);
        expect((await call("POST", "/api/nutrition", { action: "add", day: "2026-02-30", meal: "lunch", items: [rice] })).json.error).toMatch(/not a day/);
        expect((await call("GET", "/api/nutrition")).json.day.entries).toBe(0);
      });

      it("shows another day, the range asked for, the burn Garmin stored and the average of the days that are over", async () => {
        addProfile("MED");
        await call("POST", "/api/nutrition", { action: "add", day: dayOf(1), meal: "lunch", items: [rice] });
        store().wellness.put("MED", dayOf(1), "summary", summaryResponse());
        const view = (await call("GET", `/api/nutrition?date=${dayOf(1)}&days=7`)).json;
        expect(view.date).toBe(dayOf(1));
        expect(view.days).toHaveLength(7);
        expect(view.day).toMatchObject({ kcal: 200, burnedKcal: 2600, burnedSoFar: false, netKcal: -2400 });
        expect(view.average).toMatchObject({ days: 1, kcal: 200 });
        const old = (await call("GET", `/api/nutrition?date=${dayOf(200)}`)).json; // beyond the range: still shown
        expect(old.date).toBe(dayOf(200));
        expect(old.day.entries).toBe(0);
        expect((await call("GET", "/api/nutrition?date=yesterday")).json.date).toBe(today());
        expect((await call("GET", "/api/nutrition?days=500")).json.days).toHaveLength(90);
        expect((await call("GET", "/api/nutrition?days=2")).json.days).toHaveLength(7);
      });

      it("keeps each profile's food apart: a profile login acts as itself and cannot touch another's entries", async () => {
        addProfile("MED", "med-pw");
        addProfile("SAM", "sam-pw");
        const login = (user: string, pass: string) => ({ ...H, Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") });
        const med = login("MED", "med-pw"), sam = login("SAM", "sam-pw");
        await call("POST", "/api/nutrition", { action: "add", meal: "lunch", items: [rice] }, med);
        expect((await call("GET", "/api/nutrition", undefined, sam)).json).toMatchObject({ profile: "SAM", day: { entries: 0 } });
        expect((await call("GET", "/api/nutrition?profile=MED", undefined, sam)).json).toMatchObject({ profile: "SAM", day: { entries: 0 } }); // whichever profile it names
        const samFood = (await call("POST", "/api/nutrition", { action: "add", profile: "MED", meal: "snack", items: [rice] }, sam)).json;
        expect(samFood).toMatchObject({ profile: "SAM", day: { entries: 1 } });
        const medId = (await call("GET", "/api/nutrition", undefined, med)).json.day.meals[1].entries[0].id;
        expect((await call("POST", "/api/nutrition", { action: "delete", id: samFood.day.meals[3].entries[0].id }, med)).json.day.entries).toBe(1); // nothing of SAM's was deleted
        expect((await call("POST", "/api/nutrition", { action: "update", id: samFood.day.meals[3].entries[0].id, kcal: 1 }, med)).status).toBe(400);
        expect((await call("GET", "/api/nutrition", undefined, sam)).json.day.entries).toBe(1);
        expect((await call("GET", "/api/nutrition", undefined, med)).json.day.meals[1].entries[0].id).toBe(medId);
      });
    });

    describe("the Weight view", () => {
      const savedTz = process.env.GARMIN_TZ;
      beforeEach(() => {
        process.env.GARMIN_TZ = "UTC";
      });
      afterEach(() => {
        if (savedTz === undefined) delete process.env.GARMIN_TZ; else process.env.GARMIN_TZ = savedTz;
      });
      const dayOf = (back: number) => new Date(Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
      const fill = (profile: string, days: number, weighEvery = 3) => {
        for (let i = 0; i < days; i++) {
          store().wellness.put(profile, dayOf(i), "summary", summaryResponse());
          store().wellness.put(profile, dayOf(i), "weight", i % weighEvery === 0 ? weightResponse({ grams: 80_000 + i * 50 }) : noWeighIn);
        }
      };

      it("gives the weight, the calories and the trend of the last days from the database alone", async () => {
        expect((await call("GET", "/api/weight")).json).toEqual({ profile: null });
        addProfile("MED");
        const empty = (await call("GET", "/api/weight")).json;
        expect(empty).toEqual(expect.objectContaining({ profile: "MED", days: [], stored: [] }));
        expect(empty.body.weighIns).toBe(0);

        fill("MED", 30);
        const out = (await call("GET", "/api/weight")).json;
        expect(out.days).toHaveLength(30);
        expect(out.days[29]).toEqual({ day: dayOf(0), weightKg: 80, bodyFatPercent: 18.5, muscleKg: 36, bmi: 24.5, totalKcal: 2600, activeKcal: 650, bmrKcal: 1950 });
        expect(out.days[28]).toEqual(expect.objectContaining({ day: dayOf(1), weightKg: null, totalKcal: 2600 }));
        expect(out.body).toEqual(expect.objectContaining({ weighIns: 10, latest: { day: dayOf(0), kg: 80, bodyFatPercent: 18.5 }, direction: "losing" })); // the older days are heavier
        expect(out.date).toBe(dayOf(0)); // the day whose responses are listed: the last weigh-in
        expect(out.stored.map((s: any) => s.kind)).toEqual(["summary", "weight"]);
        expect((await call("GET", `/api/weight?date=${dayOf(5)}&days=14`)).json).toEqual(expect.objectContaining({ date: dayOf(5) }));
        expect((await call("GET", "/api/weight?days=14")).json.days).toHaveLength(14);
        expect(w.refreshWellness).not.toHaveBeenCalled(); // a read never calls Garmin
      });

      it("keeps one person's weight from another's", async () => {
        addProfile("MED", "med-pw");
        addProfile("SAM", "sam-pw");
        fill("MED", 10);
        const login = (user: string, pass: string) => ({ ...H, Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` });
        expect((await call("GET", "/api/weight", undefined, login("SAM", "sam-pw"))).json.days).toEqual([]);
        expect((await call("GET", "/api/weight?profile=MED", undefined, login("SAM", "sam-pw"))).json.days).toEqual([]);
        expect((await call("GET", "/api/weight", undefined, login("MED", "med-pw"))).json.days).toHaveLength(10);
      });
    });

    describe("the Settings view", () => {
      const login = (user: string, pass: string) => ({ ...H, Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` });
      const prevKey = process.env.CREDENTIALS_KEY;
      beforeEach(() => { delete process.env.CREDENTIALS_KEY; });
      afterEach(() => { if (prevKey === undefined) delete process.env.CREDENTIALS_KEY; else process.env.CREDENTIALS_KEY = prevKey; });

      it("shows where each login comes from, and never a password", async () => {
        expect((await call("GET", "/api/settings")).json).toEqual({ profile: null });
        addProfile("MED");
        const out = (await call("GET", "/api/settings")).json;
        expect(out).toEqual(expect.objectContaining({ profile: "MED", garmin: { source: "file", email: "a@b.c", hasPassword: true, fileHasLogin: true } }));
        expect(out.renpho).toEqual(expect.objectContaining({ account: null, settings: expect.objectContaining({ fetchEnabled: false, pushEnabled: false }), log: [], recent: [] }));
        expect(out.encryption).toEqual({ enabled: false, plain: 0 });
        expect(JSON.stringify(out)).not.toMatch(/"x"|password":"/);
      });

      it("saves the Garmin login in the database, where it comes before the .env file, checks it and gives the file's back", async () => {
        addProfile("MED");
        expect((await call("POST", "/api/settings/garmin", { action: "save", email: "new@x.y", password: "" })).json.error).toBe("Enter the password.");
        const saved = await call("POST", "/api/settings/garmin", { action: "save", email: "new@x.y", password: "newpw" });
        expect(saved.status).toBe(200);
        expect(saved.json.garmin).toEqual({ source: "settings", email: "new@x.y", hasPassword: true, fileHasLogin: true });
        expect(JSON.stringify(saved.json)).not.toContain("newpw");
        expect(store().credentials.get("MED", "garmin")).toEqual(expect.objectContaining({ email: "new@x.y", password: "newpw" }));
        expect((await call("POST", "/api/settings/garmin", { action: "test" })).json).toEqual(expect.objectContaining({ ok: true, message: "Garmin accepted the login." }));
        expect(st.testGarminLogin).toHaveBeenCalledWith("MED");
        expect((await call("POST", "/api/settings/garmin", { action: "remove" })).json.garmin.source).toBe("file");
        expect((await call("POST", "/api/settings/garmin", { action: "import-env" })).json.garmin.source).toBe("settings");
        expect((await call("POST", "/api/settings/garmin", { action: "nonsense" })).status).toBe(400);
      });

      it("saves the Renpho login and switches, tests the login, runs a sync by hand and clears what is kept", async () => {
        addProfile("MED");
        expect((await call("POST", "/api/settings/renpho", { action: "save", fetchEnabled: true })).json.error).toBe("Save the Renpho login first.");
        const saved = (await call("POST", "/api/settings/renpho", { action: "save", email: "me@x.y", password: "rpw", areaCode: "CA", fetchEnabled: true, intervalHours: 6 })).json;
        expect(saved.renpho.account).toEqual({ email: "me@x.y", hasPassword: true });
        expect(saved.renpho.settings).toEqual(expect.objectContaining({ areaCode: "CA", fetchEnabled: true, intervalHours: 6 }));
        expect(JSON.stringify(saved)).not.toContain("rpw");
        expect((await call("POST", "/api/settings/renpho", { action: "test" })).json).toEqual(expect.objectContaining({ ok: true, message: expect.stringMatching(/accepted the login/) }));
        const run = await call("POST", "/api/settings/renpho", { action: "sync" });
        expect(run.json.run).toEqual(expect.objectContaining({ ran: true, added: 2 }));
        expect(rt.runRenpho).toHaveBeenCalledWith("MED", true);
        store().renpho.addMeasurement("MED", { id: "1", measuredAt: 1, day: "2026-01-01", data: renphoRow(1) });
        store().renpho.log("MED", "info", "hello");
        const view = (await call("GET", "/api/settings")).json.renpho;
        expect(view.recent[0].fields.weight).toBe(81.7);
        expect(view.log.some((l: any) => l.message === "hello")).toBe(true);
        expect((await call("POST", "/api/settings/renpho", { action: "clear-log" })).json.renpho.log).toEqual([]);
        expect((await call("POST", "/api/settings/renpho", { action: "clear-weighins" })).json.renpho.counts.total).toBe(0);
        const removed = (await call("POST", "/api/settings/renpho", { action: "remove" })).json.renpho;
        expect(removed.account).toBeNull();
        expect(removed.settings.fetchEnabled).toBe(false);
        expect((await call("POST", "/api/settings/renpho", { action: "nonsense" })).status).toBe(400);
        expect((await call("POST", "/api/settings/renpho", { action: "save", areaCode: "x" })).status).toBe(400);
      });

      it("hands out the newest weigh-ins as a FIT file the FIT SDK reads, and says when there are none", async () => {
        addProfile("MED");
        expect((await call("GET", "/api/settings/renpho/fit")).status).toBe(404);
        for (const id of [1, 2, 3, 4]) store().renpho.addMeasurement("MED", { id: String(id), measuredAt: renphoRow(id).timeStamp * 1000, day: "2026-01-01", data: renphoRow(id) });
        const res = await fetch(`${base}/api/settings/renpho/fit?count=3`, { headers: H });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/octet-stream");
        expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="renpho-\d{4}-\d{2}-\d{2}\.fit"$/);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
        expect(decoder.isFIT() && decoder.checkIntegrity()).toBe(true);
        expect((decoder.read().messages as any).weightScaleMesgs).toHaveLength(3);
      });

      it("lets a profile login change only its own logins", async () => {
        addProfile("MED", "med-pw");
        addProfile("SAM", "sam-pw");
        const as = (user: string, pass: string) => login(user, pass);
        expect((await call("GET", "/api/settings")).status).toBe(401);
        const out = await call("POST", "/api/settings/garmin", { profile: "MED", action: "save", email: "sam-new@x.y", password: "pw" }, as("SAM", "sam-pw"));
        expect(out.json.profile).toBe("SAM"); // a profile login always acts as itself
        expect(store().credentials.get("SAM", "garmin")!.email).toBe("sam-new@x.y");
        expect(store().credentials.get("MED", "garmin")).toBeNull();
        expect((await call("GET", "/api/settings?profile=MED", undefined, as("SAM", "sam-pw"))).json.profile).toBe("SAM");
      });
    });

    it("answers 404 for an activity that is not stored, and 400 for a bad id", async () => {
      addProfile("MED");
      expect((await call("GET", "/api/activity?id=999")).status).toBe(404);
      expect((await call("GET", "/api/activity?id=../x")).status).toBe(400);
    });

    it("keeps a profile login to its own activities", async () => {
      addProfile("MED", "med-pw");
      addProfile("SAM", "sam-pw");
      keep("MED", item(1, "2026-08-01", "running"));
      keep("SAM", item(2, "2026-08-02", "running"));
      const med = login("MED", "med-pw");
      expect((await call("GET", "/api/activities", undefined, med)).json.activities.map((r: any) => r.id)).toEqual(["1"]);
      expect((await call("GET", "/api/activities?profile=SAM", undefined, med)).json.activities.map((r: any) => r.id)).toEqual(["1"]);
      expect((await call("GET", "/api/activity?id=2&profile=SAM", undefined, med)).status).toBe(404);
      expect((await call("GET", "/api/activities", undefined, login("SAM", "sam-pw"))).json.activities.map((r: any) => r.id)).toEqual(["2"]);
    });

    it("syncs only through a POST that needs a Garmin profile, and starts the long fill only when asked", async () => {
      expect((await call("POST", "/api/activities/sync", {})).status).toBe(409); // no profile configured
      addProfile("MED");
      const quick = await call("POST", "/api/activities/sync", {});
      expect(quick.status).toBe(200);
      expect(quick.json).toEqual(expect.objectContaining({ added: 2, busy: false, error: null, background: null }));
      expect(a.refreshActivities).toHaveBeenLastCalledWith("MED");
      expect(a.startBackgroundSync).not.toHaveBeenCalled();

      const full = await call("POST", "/api/activities/sync", { history: true });
      expect(full.json.background).toEqual({ started: true });
      expect(a.startBackgroundSync).toHaveBeenCalledWith("MED");
      expect((await call("GET", "/api/activities/sync")).status).toBe(404); // no GET route
    });

    it("adds the stats and the charts to an activity, once the chart data is stored", async () => {
      addProfile("MED");
      keep("MED", item(1, "2026-08-01", "running", { hrTimeInZone_1: 60, hrTimeInZone_2: 600, fastestSplit_1000: 270.2, locationName: "Nowhere" }));
      const bare = (await call("GET", "/api/activity?id=1")).json;
      expect(bare.chart).toBeNull();
      expect(bare.stats).toEqual(expect.objectContaining({ hrZones: [60, 600, 0, 0, 0], fastest1k: 270.2, location: "Nowhere" }));

      store().activities.setChart("MED", "1", {
        v: 1,
        details: {
          metricDescriptors: [{ metricsIndex: 0, key: "directHeartRate" }, { metricsIndex: 1, key: "sumDistance" }, { metricsIndex: 2, key: "directSpeed" }],
          activityDetailMetrics: [{ metrics: [120, 0, 3] }, { metrics: [130, 600, 3] }],
          geoPolylineDTO: { polyline: [{ lat: 10, lon: 20, distanceInMeters: 0 }, { lat: 10.001, lon: 20.001, distanceInMeters: 600 }] },
        },
        splits: { lapDTOs: [{ lapIndex: 1, distance: 600, duration: 200, intensityType: "ACTIVE" }] },
        zones: [{ zoneNumber: 1, secsInZone: 60, zoneLowBoundary: 100 }],
      });
      const full = (await call("GET", "/api/activity?id=1")).json;
      expect(full.chart.hr).toEqual([120, 130]);
      expect(full.chart.route.lat).toEqual([10, 10.001]);
      expect(full.chart.laps).toEqual([expect.objectContaining({ index: 1, paceSec: 333, kind: "ACTIVE" })]);
      expect(full.chart.zones).toEqual([{ zone: 1, low: 100, high: null, seconds: 60 }]);
      expect(a.fetchChartNow).not.toHaveBeenCalled(); // a read never calls Garmin
    });

    it("fetches one activity's chart data on a POST, and refuses an unknown one or a missing Garmin profile", async () => {
      expect((await call("POST", "/api/activities/chart", { id: "1" })).status).toBe(409);
      addProfile("MED");
      keep("MED", item(1, "2026-08-01", "running"));
      const out = await call("POST", "/api/activities/chart", { id: "1" });
      expect(out.status).toBe(200);
      expect(a.fetchChartNow).toHaveBeenCalledWith("MED", "1");
      expect(out.json).toEqual(expect.objectContaining({ fetched: { fetched: 1, error: null }, chart: null }));
      expect((await call("POST", "/api/activities/chart", { id: "5" })).status).toBe(404);
    });

    it("fetches one activity's details on a POST, and refuses an unknown one", async () => {
      addProfile("MED");
      keep("MED", item(1, "2026-08-01", "running"));
      const out = await call("POST", "/api/activities/detail", { id: "1" });
      expect(out.status).toBe(200);
      expect(a.fetchDetailsNow).toHaveBeenCalledWith("MED", ["1"]);
      expect(out.json).toEqual(expect.objectContaining({ fetched: { fetched: 1, error: null }, detailed: false }));
      expect((await call("POST", "/api/activities/detail", { id: "5" })).status).toBe(404);
    });
  });

  describe("Garmin actions", () => {
    const act = (body: object) => call("POST", "/api/garmin/action", { path: "workout-plans/a.json", confirm: true, ...body });

    it("is disabled without a configured profile", async () => {
      const info = await call("GET", "/api/garmin");
      expect(info.json).toEqual(expect.objectContaining({ enabled: false, profiles: [] }));
      expect(info.json.reason).toMatch(/No Garmin profiles/);
      expect((await act({ action: "upload" })).status).toBe(409);
      expect(g.uploadPlan).not.toHaveBeenCalled();
    });

    it("requires confirmation, a known action and a usable profile", async () => {
      addProfile("TEST");
      expect((await call("GET", "/api/garmin")).json).toEqual(expect.objectContaining({ enabled: true, profiles: ["TEST"], defaultProfile: "TEST" }));
      expect((await act({ action: "upload", confirm: undefined })).status).toBe(400);
      expect((await act({ action: "nuke" })).status).toBe(400);
      expect((await act({ action: "upload", path: "workout-plans/missing.json" })).status).toBe(404);
      addProfile("OTHER");
      const ambiguous = await act({ action: "upload" });
      expect(ambiguous.status).toBe(400);
      expect(ambiguous.json.error).toMatch(/Multiple profiles/);
      expect((await act({ action: "upload", profile: "NOPE" })).status).toBe(400);
      expect(g.uploadPlan).not.toHaveBeenCalled();
    });

    it("runs each action against the right profile and path", async () => {
      addProfile("TEST");
      expect((await act({ action: "upload" })).json.result).toEqual(expect.objectContaining({ status: "ok" }));
      expect(g.uploadPlan).toHaveBeenCalledWith("TEST", "workout-plans/a.json");
      await act({ action: "schedule" });
      expect(g.schedulePlan).toHaveBeenCalledWith("TEST", "workout-plans/a.json");
      await act({ action: "upload_schedule" });
      expect(g.uploadAndSchedulePlan).toHaveBeenCalledWith("TEST", "workout-plans/a.json");
      await act({ action: "send", deviceId: 7 });
      expect(g.sendPlanToDevice).toHaveBeenCalledWith("TEST", "workout-plans/a.json", 7);

      addProfile("OTHER");
      seed("data/OTHER/w.json", plan);
      await act({ action: "upload", path: "data/OTHER/w.json", profile: "TEST" }); // the folder decides
      expect(g.uploadPlan).toHaveBeenLastCalledWith("OTHER", "data/OTHER/w.json");

      const devices = await call("GET", "/api/garmin/devices?profile=TEST");
      expect(devices.json.devices).toEqual([expect.objectContaining({ deviceId: 7 })]);
    });

    it("refuses to upload invalid workouts but lets schedule and send through", async () => {
      addProfile("TEST");
      const bad = { workouts: [{ workoutName: "x", workoutType: "strength_training", steps: [{ stepType: "nope", targetType: "no.target" }] }] };
      seed("workout-plans/bad.json", bad);
      const up = await act({ action: "upload_schedule", path: "workout-plans/bad.json" });
      expect(up.status).toBe(422);
      expect(up.json.errors.length).toBeGreaterThan(0);
      expect(g.uploadAndSchedulePlan).not.toHaveBeenCalled();
      expect((await act({ action: "schedule", path: "workout-plans/bad.json" })).status).toBe(200);
    });

    it("reports Garmin failures with the log and the current file version", async () => {
      addProfile("TEST");
      g.uploadPlan.mockRejectedValueOnce(new Error("Failed to authenticate with Garmin"));
      const r = await act({ action: "upload" });
      expect(r.status).toBe(502);
      expect(r.json.error).toMatch(/authenticate/);
      expect(typeof r.json.version).toBe("number");
    });
  });
  describe("Workouts view", () => {
    const easy = { workoutName: "Easy run", workoutType: "running", distanceMeters: 5000 };
    const lift = {
      workoutName: "Bench day",
      workoutType: "strength_training",
      steps: [{ stepType: "interval", targetType: "no.target", endCondition: "reps", endConditionValue: 5, reps: 5, exerciseName: "BARBELL_BENCH_PRESS" }],
    };
    const writePlan = (name: string, workouts: object[], folder = "workout-plans") =>
      seed(`${folder}/${name}`, { weekStart: "2026-10-12", weekEnd: "2026-10-18", workouts });
    const readPlan = (name: string, folder = "workout-plans") => JSON.parse(stored(`${folder}/${name}`)!);
    const ref = (name: string, index: number, folder = "workout-plans") => ({ path: `${folder}/${name}`, index, version: versionOf(`${folder}/${name}`) });

    beforeEach(() => {
      addProfile("TEST");
      writePlan("a.json", [{ ...easy, workoutId: 5 }, { ...lift }, { ...lift, workoutName: "Gone", workoutId: 77 }]);
    });

    it("lists the Garmin library next to the plan workouts", async () => {
      g.listLibraryWorkouts.mockResolvedValueOnce([
        { workoutId: 5, workoutName: "Easy run", workoutType: "running", updatedDate: "1" },
        { workoutId: 6, workoutName: "Only on Garmin", workoutType: "cycling" },
      ]);
      seed("data/TEST/workouts.json", [{ ...easy, workoutId: 6 }]); // a library export, not a plan
      seed("data/TEST/activities.json", { activities: [] });

      const r = await call("GET", "/api/workouts");
      expect(r.status).toBe(200);
      expect(g.listLibraryWorkouts).toHaveBeenCalledWith("TEST", false);
      expect(r.json.truncated).toBe(false);
      expect(r.json.rows).toEqual([
        expect.objectContaining({ key: "g:5", state: "linked", plans: [expect.objectContaining({ path: "workout-plans/a.json", index: 0 })] }),
        expect.objectContaining({ key: "g:6", state: "garmin-only", plans: [] }),
        expect.objectContaining({ key: "p:workout-plans/a.json#1", workoutName: "Bench day", state: "not-uploaded" }),
        expect.objectContaining({ key: "p:workout-plans/a.json#2", workoutName: "Gone", state: "linked", workoutId: 77 }),
      ]);
    });

    it("gives each row the days the plans schedule it on, from every plan that carries it", async () => {
      g.listLibraryWorkouts.mockResolvedValueOnce([{ workoutId: 5, workoutName: "Easy run", workoutType: "running" }, { workoutId: 6, workoutName: "Unscheduled" }]);
      seed("workout-plans/a.json", { workouts: [{ ...easy, workoutId: 5, scheduledDate: ["2026-10-20", "2026-10-13"] }, { workoutName: "Plan only", scheduledDate: "2026-11-01" }] });
      seed("workout-plans/b.json", { workouts: [{ ...easy, workoutId: 5, scheduledDate: "2026-10-13" }, { ...easy, workoutId: 5, scheduledDate: "2026-12-01" }] });
      const rows = (await call("GET", "/api/workouts")).json.rows;
      const dates = (key: string) => rows.find((r: any) => r.key === key).dates;
      expect(dates("g:5")).toEqual(["2026-10-13", "2026-10-20", "2026-12-01"]); // sorted, without repeats
      expect(dates("g:6")).toEqual([]);
      expect(dates("p:workout-plans/a.json#1")).toEqual(["2026-11-01"]);
    });

    it("flags a full library and is unavailable without Garmin", async () => {
      g.listLibraryWorkouts.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ workoutId: i + 1000, workoutName: `w${i}` })));
      expect((await call("GET", "/api/workouts?refresh=1")).json.truncated).toBe(true);
      expect(g.listLibraryWorkouts).toHaveBeenLastCalledWith("TEST", true);

      fs.rmSync(path.join(dir, "config", ".env.TEST"));
      const off = await call("GET", "/api/workouts");
      expect(off.status).toBe(409);
      expect(off.json.error).toMatch(/No Garmin profiles/);
    });

    it("shows one workout from Garmin with the plan entries that carry it", async () => {
      g.getLibraryWorkout.mockResolvedValueOnce({ workoutId: 5, workoutName: "Easy run", workoutType: "running" });
      const r = await call("GET", "/api/garmin/workout?id=5");
      expect(g.getLibraryWorkout).toHaveBeenCalledWith("TEST", "5");
      expect(r.json.workout).toEqual(expect.objectContaining({ workoutName: "Easy run" }));
      expect(r.json.plans).toEqual([expect.objectContaining({ path: "workout-plans/a.json", index: 0, differences: [], workout: expect.objectContaining({ workoutId: 5 }) })]);

      expect((await call("GET", "/api/garmin/workout?id=404")).status).toBe(404);
      expect((await call("GET", "/api/garmin/workout?id=../x")).status).toBe(400);
    });

    it("checks the plan as it is in the editor, unsaved edits included", async () => {
      g.checkWorkoutSync.mockResolvedValueOnce([{ index: 0, state: "synced", differences: [] }]);
      const text = JSON.stringify({ workouts: [{ ...easy, workoutId: 5, workoutName: "Edited, not saved" }] });
      const r = await call("POST", "/api/garmin/status", { path: "workout-plans/a.json", text });
      expect(r.json.statuses).toEqual([{ index: 0, state: "synced", differences: [] }]);
      expect(g.checkWorkoutSync).toHaveBeenCalledWith("TEST", [expect.objectContaining({ workoutName: "Edited, not saved" })], false);

      await call("POST", "/api/garmin/status", { path: "workout-plans/a.json", refresh: true });
      expect(g.checkWorkoutSync).toHaveBeenLastCalledWith("TEST", expect.arrayContaining([expect.objectContaining({ workoutId: 77 })]), true); // read from the store

      const other = await call("POST", "/api/garmin/status", { path: "workout-plans/a.json", text: JSON.stringify({ activities: [] }) });
      expect(other.json.statuses).toEqual([]);
      expect((await call("POST", "/api/garmin/status", { text })).status).toBe(400);
    });

    describe("create", () => {
      it("adds a workout to a plan without touching Garmin", async () => {
        const r = await call("POST", "/api/garmin/workout", { workout: lift, planPath: "workout-plans/a.json" });
        expect(r.status).toBe(201);
        expect(r.json).toEqual(expect.objectContaining({ path: "workout-plans/a.json", index: 3 }));
        expect(readPlan("a.json").workouts[3]).toEqual(lift);
        expect(g.saveWorkout).not.toHaveBeenCalled();
      });

      it("links a copy of a workout that is already on Garmin instead of uploading it again", async () => {
        const body = { workout: { ...lift, workoutId: 1234 }, planPath: "workout-plans/a.json", linkWorkoutId: 1234 };
        const r = await call("POST", "/api/garmin/workout", body);
        expect(r.status).toBe(201);
        expect(r.json.workoutId).toBe(1234);
        expect(readPlan("a.json").workouts[3]).toEqual({ ...lift, workoutId: 1234 });
        expect(g.saveWorkout).not.toHaveBeenCalled();

        await call("POST", "/api/garmin/workout", { ...body, linkWorkoutId: undefined }); // without the link the stale id is dropped
        expect(readPlan("a.json").workouts[4]).toEqual(lift);
      });

      it("uploads it and records the new id in the plan", async () => {
        const body = { workout: { ...lift, workoutId: 1234 }, planPath: "workout-plans/a.json", upload: true, schedule: true };
        expect((await call("POST", "/api/garmin/workout", body)).status).toBe(400); // no confirmation
        const r = await call("POST", "/api/garmin/workout", { ...body, confirm: true });
        expect(r.json.workoutId).toBe(999);
        expect(g.saveWorkout).toHaveBeenCalledWith("TEST", expect.not.objectContaining({ workoutId: expect.anything() }), true); // never replaces another workout
        expect(readPlan("a.json").workouts[3]).toEqual({ ...lift, workoutId: 999 });
      });

      it("can upload to Garmin only, and refuses invalid workouts", async () => {
        const r = await call("POST", "/api/garmin/workout", { workout: lift, upload: true, confirm: true });
        expect(r.status).toBe(201);
        expect(r.json.workoutId).toBe(999);
        expect(readPlan("a.json").workouts).toHaveLength(3);

        const bad = { workoutName: "x", workoutType: "strength_training", steps: [{ stepType: "nope", targetType: "no.target" }] };
        const rejected = await call("POST", "/api/garmin/workout", { workout: bad, upload: true, confirm: true });
        expect(rejected.status).toBe(422);
        expect(rejected.json.errors.length).toBeGreaterThan(0);
        expect(g.saveWorkout).toHaveBeenCalledTimes(1);
        expect((await call("POST", "/api/garmin/workout", { workout: lift })).status).toBe(400); // nowhere to put it
      });
    });

    describe("update", () => {
      it("replaces the plan entry and puts the workout on Garmin under its new id", async () => {
        const edited = { ...easy, workoutName: "Easy run (longer)", distanceMeters: 8000, workoutId: 5, scheduledDate: "2026-10-14" };
        const body = { workoutId: 5, workout: edited, plans: [ref("a.json", 0)], upload: true, confirm: true };
        const r = await call("PUT", "/api/garmin/workout", body);
        expect(r.status).toBe(200);
        expect(g.saveWorkout).toHaveBeenCalledWith("TEST", expect.objectContaining({ workoutId: 5, distanceMeters: 8000 }), false);
        expect(readPlan("a.json").workouts[0]).toEqual({ ...edited, workoutId: 999 });
        expect(r.json.changed).toEqual([expect.objectContaining({ path: "workout-plans/a.json" })]);
      });

      it("repoints the other plans that carried the old workout", async () => {
        writePlan("b.json", [{ ...easy, workoutName: "Copy", workoutId: 5 }]);
        const body = { workoutId: 5, workout: { ...easy, workoutId: 5, distanceMeters: 1 }, plans: [ref("a.json", 0), ref("b.json", 0)], upload: true, confirm: true };
        await call("PUT", "/api/garmin/workout", body);
        expect(readPlan("a.json").workouts[0]).toEqual({ ...easy, distanceMeters: 1, workoutId: 999 });
        expect(readPlan("b.json").workouts[0]).toEqual({ ...easy, workoutName: "Copy", workoutId: 999 });
      });

      it("saves to the plan alone when asked, keeping the workoutId the editor shows", async () => {
        const r = await call("PUT", "/api/garmin/workout", { workoutId: 5, workout: { ...easy, workoutId: 5, description: "x" }, plans: [ref("a.json", 0)] });
        expect(r.status).toBe(200);
        expect(g.saveWorkout).not.toHaveBeenCalled();
        expect(readPlan("a.json").workouts[0]).toEqual({ ...easy, workoutId: 5, description: "x" });
      });

      it("refuses stale or mismatched plan entries before touching Garmin", async () => {
        const body = { workoutId: 5, workout: easy, upload: true, confirm: true };
        const stale = ref("a.json", 0);
        store().update("workout-plans/a.json", (text) => text + "\n"); // saved by someone else since `stale` was read
        expect((await call("PUT", "/api/garmin/workout", { ...body, plans: [stale] })).status).toBe(409);
        expect((await call("PUT", "/api/garmin/workout", { ...body, plans: [ref("a.json", 9)] })).status).toBe(409);
        expect((await call("PUT", "/api/garmin/workout", { ...body, plans: [ref("a.json", 1)], workoutId: 6 })).status).toBe(200); // entry without an id: nothing to contradict
        expect((await call("PUT", "/api/garmin/workout", { ...body, plans: [ref("a.json", 0)], workoutId: 6 })).status).toBe(409); // entry has id 5, not 6
        expect((await call("PUT", "/api/garmin/workout", { ...body, plans: [{ path: "workout-plans/../x.json", index: 0 }] })).status).toBe(400);
        expect((await call("PUT", "/api/garmin/workout", { workout: easy })).status).toBe(400); // nothing to save
        expect(g.saveWorkout).toHaveBeenCalledTimes(1);
      });

      it("reports a Garmin failure with the log and leaves the plan alone", async () => {
        g.saveWorkout.mockRejectedValueOnce(new Error("Garmin did not accept the workout (see log)."));
        const before = stored("workout-plans/a.json");
        const r = await call("PUT", "/api/garmin/workout", { workoutId: 5, workout: { ...easy, workoutId: 5 }, plans: [ref("a.json", 0)], upload: true, confirm: true });
        expect(r.status).toBe(502);
        expect(r.json.error).toMatch(/did not accept/);
        expect(r.json).toHaveProperty("log");
        expect(stored("workout-plans/a.json")).toBe(before);
      });
    });

    describe("delete", () => {
      it("deletes from Garmin and keeps the plan workout as not uploaded", async () => {
        const body = { workoutId: 5, plans: [ref("a.json", 0)], garmin: true };
        expect((await call("DELETE", "/api/garmin/workout", body)).status).toBe(400); // no confirmation
        const r = await call("DELETE", "/api/garmin/workout", { ...body, confirm: true });
        expect(r.status).toBe(200);
        expect(g.deleteLibraryWorkout).toHaveBeenCalledWith("TEST", 5);
        expect(readPlan("a.json").workouts[0]).toEqual(easy);
        expect(readPlan("a.json").workouts).toHaveLength(3);
      });

      it("can also remove the workout from the plans, or only from the plans", async () => {
        // entry 2 carries workout 77, not 5: refused, and nothing is deleted from Garmin
        const refused = await call("DELETE", "/api/garmin/workout", { workoutId: 5, plans: [ref("a.json", 0), ref("a.json", 2)], garmin: true, removeFromPlans: true, confirm: true });
        expect(refused.status).toBe(409);
        expect(g.deleteLibraryWorkout).not.toHaveBeenCalled();
        expect(readPlan("a.json").workouts).toHaveLength(3);

        const r = await call("DELETE", "/api/garmin/workout", { workoutId: 5, plans: [ref("a.json", 0), ref("a.json", 1)], garmin: true, removeFromPlans: true, confirm: true });
        expect(r.status).toBe(200);
        expect(readPlan("a.json").workouts.map((w: any) => w.workoutName)).toEqual(["Gone"]);

        g.deleteLibraryWorkout.mockClear();
        const local = await call("DELETE", "/api/garmin/workout", { plans: [ref("a.json", 0)], removeFromPlans: true }); // no Garmin involved: no confirmation needed
        expect(local.status).toBe(200);
        expect(g.deleteLibraryWorkout).not.toHaveBeenCalled();
        expect(readPlan("a.json").workouts).toEqual([]);
      });

      it("deletes a Garmin-only workout and needs something to delete", async () => {
        expect((await call("DELETE", "/api/garmin/workout", { workoutId: 6, garmin: true, confirm: true })).status).toBe(200);
        expect(g.deleteLibraryWorkout).toHaveBeenCalledWith("TEST", 6);
        expect((await call("DELETE", "/api/garmin/workout", { garmin: true, confirm: true })).status).toBe(400); // no id
        expect((await call("DELETE", "/api/garmin/workout", { workoutId: 6, confirm: true })).status).toBe(400); // nothing chosen
      });
    });

    it("keeps a profile login to its own data folder and Garmin account", async () => {
      addProfile("MED", "med-pw");
      addProfile("SAM", "sam-pw");
      for (const name of ["MED", "SAM"]) {
        writePlan("mine.json", [{ ...easy, workoutName: `${name} run`, workoutId: 1 }], `data/${name}`);
      }
      const login = { Authorization: "Basic " + Buffer.from("MED:med-pw").toString("base64") };
      const med = (method: string, url: string, body?: unknown) => call(method, url, body, { ...H, ...login });

      g.listLibraryWorkouts.mockResolvedValueOnce([{ workoutId: 1, workoutName: "x" }]);
      const rows = (await med("GET", "/api/workouts?profile=SAM")).json.rows;
      expect(g.listLibraryWorkouts).toHaveBeenLastCalledWith("MED", false);
      expect(rows[0].plans.map((p: any) => p.path)).toEqual(["data/MED/mine.json"]);

      const body = { workoutId: 1, workout: easy, plans: [{ path: "data/SAM/mine.json", index: 0 }], upload: true, confirm: true, profile: "SAM" };
      expect((await med("PUT", "/api/garmin/workout", body)).status).toBe(403);
      const own = await med("PUT", "/api/garmin/workout", { ...body, plans: [{ path: "data/MED/mine.json", index: 0 }] });
      expect(own.status).toBe(200);
      expect(g.saveWorkout).toHaveBeenLastCalledWith("MED", expect.anything(), false);
      expect((await med("DELETE", "/api/garmin/workout", { workoutId: 1, garmin: true, confirm: true, profile: "SAM" })).status).toBe(200);
      expect(g.deleteLibraryWorkout).toHaveBeenLastCalledWith("MED", 1);
    });
  });
  describe("per-profile logins", () => {
    const basic = (user: string, pass: string) => ({ Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") });
    const as = (user: string, pass: string) => (method: string, url: string, body?: unknown) =>
      call(method, url, body, { ...H, ...basic(user, pass) });

    beforeEach(() => {
      addProfile("MED", "med-pw");
      addProfile("SAM", "sam-pw");
      for (const name of ["MED", "SAM"]) {
        seed(`data/${name}/w.json`, plan);
      }
    });

    it("requires a login as soon as a profile has a WEB_PASSWORD, and checks it against that profile", async () => {
      expect((await call("GET", "/api/files")).status).toBe(401);
      expect((await as("MED", "sam-pw")("GET", "/api/files")).status).toBe(401);
      expect((await as("NOPE", "med-pw")("GET", "/api/files")).status).toBe(401);
      expect((await as("MED", "med-pw")("GET", "/api/files")).status).toBe(200);
    });

    it("limits a profile login to its own data folder and the shared plans", async () => {
      const med = as("MED", "med-pw");
      const files = (await med("GET", "/api/files")).json.files.map((f: any) => f.path);
      expect(files).toEqual(["data/MED/w.json", "workout-plans/a.json"]);

      expect((await med("GET", q("data/MED/w.json"))).status).toBe(200);
      expect((await med("GET", q("data/SAM/w.json"))).status).toBe(403);
      expect((await med("PUT", q("data/SAM/new.json"), { text: "{}", create: true })).status).toBe(403);
      expect((await med("DELETE", q("data/SAM/w.json"))).status).toBe(403);
      expect((await med("POST", "/api/rename", { from: "workout-plans/a.json", to: "data/SAM/a.json" })).status).toBe(403);
      expect(store().head("data/SAM/w.json")).toBeDefined();
    });

    it("keeps the plans a profile creates to that profile, and shared plans to everyone", async () => {
      const med = as("MED", "med-pw"), sam = as("SAM", "sam-pw");
      const text = JSON.stringify(plan);
      expect((await med("PUT", q("workout-plans/med-only.json"), { text, create: true })).status).toBe(201);
      expect(store().head("workout-plans/med-only.json")?.owner).toBe("MED");

      expect((await med("GET", "/api/files")).json.files.map((f: any) => f.path)).toContain("workout-plans/med-only.json");
      expect((await sam("GET", "/api/files")).json.files.map((f: any) => f.path)).not.toContain("workout-plans/med-only.json");
      expect((await sam("GET", q("workout-plans/med-only.json"))).status).toBe(403);
      expect((await sam("PUT", q("workout-plans/med-only.json"), { text: "[]" })).status).toBe(403);
      expect((await sam("GET", `/api/history?path=${encodeURIComponent("workout-plans/med-only.json")}`)).status).toBe(403);
      expect((await sam("DELETE", q("workout-plans/med-only.json"))).status).toBe(403);
      expect((await sam("POST", "/api/garmin/action", { action: "upload", path: "workout-plans/med-only.json", confirm: true })).status).toBe(403);
      expect((await sam("GET", q("workout-plans/a.json"))).status).toBe(200); // shared

      const admin = await startWebServer({ host: "127.0.0.1", port: 0, token: "admin-token" });
      const all = (await (await fetch(`http://127.0.0.1:${(admin.address() as AddressInfo).port}/api/files`, { headers: basic("x", "admin-token") })).json()) as any;
      expect(all.files.map((f: any) => f.path)).toContain("workout-plans/med-only.json");
      await new Promise((r) => admin.close(r));
    });

    it("runs Garmin actions as the logged-in profile, whatever the request says", async () => {
      const med = as("MED", "med-pw");
      const info = (await med("GET", "/api/garmin")).json;
      expect(info).toEqual(expect.objectContaining({ profiles: ["MED"], defaultProfile: "MED", user: { admin: false, name: "MED" } }));

      const body = { action: "upload", path: "workout-plans/a.json", profile: "SAM", confirm: true };
      expect((await med("POST", "/api/garmin/action", body)).status).toBe(200);
      expect(g.uploadPlan).toHaveBeenLastCalledWith("MED", "workout-plans/a.json");
      expect((await med("POST", "/api/garmin/action", { ...body, path: "data/SAM/w.json" })).status).toBe(403);
    });

    it("keeps the token as an admin login and picks up password edits without a restart", async () => {
      const secured = await startWebServer({ host: "127.0.0.1", port: 0, token: "admin-token" });
      const url = `http://127.0.0.1:${(secured.address() as AddressInfo).port}/api/files`;
      const get = async (user: string, pass: string) => (await fetch(url, { headers: basic(user, pass) })).status;

      expect(await get("anyone", "admin-token")).toBe(200);
      const adminFiles = (await (await fetch(url, { headers: basic("anyone", "admin-token") })).json()) as any;
      expect(adminFiles.files.map((f: any) => f.path)).toEqual(["data/MED/w.json", "data/SAM/w.json", "workout-plans/a.json"]);

      expect(await get("MED", "med-pw")).toBe(200);
      addProfile("MED", "rotated");
      expect(await get("MED", "med-pw")).toBe(401);
      expect(await get("MED", "rotated")).toBe(200);
      await new Promise((r) => secured.close(r));
    });

    describe("sign-in form", () => {
      const signIn = (user: unknown, password: unknown, headers: Record<string, string> = H) =>
        fetch(base + "/api/login", { method: "POST", headers, body: JSON.stringify({ user, password }) });
      const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("plan_editor_session=")) ?? "";
      const withCookie = (cookie: string) => ({ ...H, Cookie: cookie });
      const session = async (cookie?: string) =>
        (await (await fetch(base + "/api/session", { headers: cookie ? { Cookie: cookie } : {} })).json()) as any;

      it("serves the page without a login, but not the API, and reports who is signed in", async () => {
        expect((await fetch(base + "/")).status).toBe(200);
        const model = await fetch(base + "/workoutModel.js"); // the page's own script: the sign-in form needs the page to load
        expect(model.status).toBe(200);
        expect(model.headers.get("content-type")).toMatch(/javascript/);
        expect((await call("GET", "/api/files")).status).toBe(401);
        expect(await session()).toEqual({ authRequired: true, user: null });
      });

      it("signs a profile in with a session cookie that has that profile's reach", async () => {
        const res = await signIn("MED", "med-pw");
        expect(res.status).toBe(200);
        const flags = res.headers.getSetCookie().find((c) => c.startsWith("plan_editor_session=")) ?? "";
        expect(flags).toMatch(/HttpOnly/);
        expect(flags).toMatch(/SameSite=Strict/);
        expect(flags).not.toMatch(/Secure/);
        const cookie = cookieOf(res);
        expect(await session(cookie)).toEqual({ authRequired: true, user: { admin: false, name: "MED" } });
        const files = await call("GET", "/api/files", undefined, withCookie(cookie));
        expect(files.json.files.map((f: any) => f.path)).toEqual(["data/MED/w.json", "workout-plans/a.json"]);
        expect((await call("GET", q("data/SAM/w.json"), undefined, withCookie(cookie))).status).toBe(403);
      });

      it("marks the cookie Secure behind an HTTPS proxy", async () => {
        const res = await signIn("MED", "med-pw", { ...H, "X-Forwarded-Proto": "https" });
        expect(res.headers.getSetCookie().find((c) => c.startsWith("plan_editor_session="))).toMatch(/; Secure/);
      });

      it("matches the profile name in any case and signs in under its real name", async () => {
        const res = await signIn("  med ", "med-pw");
        expect(res.status).toBe(200);
        expect(((await res.json()) as any).user).toEqual({ admin: false, name: "MED" });
        expect((await call("GET", q("data/MED/w.json"), undefined, withCookie(cookieOf(res)))).status).toBe(200);
        // Basic credentials from scripts follow the same rule
        const basicMed = { Authorization: "Basic " + Buffer.from("med:med-pw").toString("base64") };
        expect((await call("GET", q("data/MED/w.json"), undefined, { ...H, ...basicMed })).status).toBe(200);
      });

      it("refuses wrong passwords and unknown users alike", async () => {
        for (const [user, password] of [["MED", "nope"], ["NOPE", "med-pw"], ["MED", ""], [undefined, undefined]]) {
          const res = await signIn(user, password);
          expect(res.status).toBe(401);
          expect(res.headers.get("set-cookie")).toBeNull();
          expect(((await res.json()) as any).error).toBe("Wrong user name or password.");
        }
      });

      it("refuses a sign-in that lacks the X-Requested-With header", async () => {
        expect((await signIn("MED", "med-pw", { "Content-Type": "application/json" })).status).toBe(403);
      });

      it("signs out: the cookie stops working and is cleared", async () => {
        const cookie = cookieOf(await signIn("MED", "med-pw"));
        const out = await fetch(base + "/api/logout", { method: "POST", headers: withCookie(cookie) });
        expect(out.status).toBe(200);
        expect(out.headers.getSetCookie().find((c) => c.startsWith("plan_editor_session="))).toMatch(/Max-Age=0/);
        expect((await call("GET", "/api/files", undefined, withCookie(cookie))).status).toBe(401);
        expect((await session(cookie)).user).toBeNull();
      });

      it("signs out of a browser that still sends cached Basic credentials, until it signs in again", async () => {
        const cached = { Authorization: "Basic " + Buffer.from("MED:med-pw").toString("base64") };
        const out = await fetch(base + "/api/logout", { method: "POST", headers: { ...H, ...cached } });
        const marker = out.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("plan_editor_signed_out="))!;
        expect(marker).toBe("plan_editor_signed_out=1");
        // scripts carry no cookie, so Basic still works for them
        expect((await call("GET", "/api/files", undefined, { ...H, ...cached })).status).toBe(200);
        // the browser that signed out does not get back in with the cached credentials
        const browser = { ...H, ...cached, Cookie: marker };
        expect((await call("GET", "/api/files", undefined, browser)).status).toBe(401);
        expect((await (await fetch(base + "/api/session", { headers: { ...cached, Cookie: marker } })).json() as any).user).toBeNull();
        // signing in again clears the marker
        const again = await signIn("MED", "med-pw", { ...H, Cookie: marker });
        expect(again.headers.getSetCookie().find((c) => c.startsWith("plan_editor_signed_out="))).toMatch(/Max-Age=0/);
      });

      it("ends the session when the profile's password changes or goes away", async () => {
        const cookie = cookieOf(await signIn("MED", "med-pw"));
        expect((await call("GET", "/api/files", undefined, withCookie(cookie))).status).toBe(200);
        addProfile("MED", "rotated");
        expect((await call("GET", "/api/files", undefined, withCookie(cookie))).status).toBe(401);
        expect((await signIn("MED", "med-pw")).status).toBe(401);
        expect((await signIn("MED", "rotated")).status).toBe(200);
      });

      it("keeps the admin login on the token, with any user name", async () => {
        const secured = await startWebServer({ host: "127.0.0.1", port: 0, token: "admin-token" });
        const url = `http://127.0.0.1:${(secured.address() as AddressInfo).port}`;
        const res = await fetch(url + "/api/login", { method: "POST", headers: H, body: JSON.stringify({ user: "boss", password: "admin-token" }) });
        expect(((await res.json()) as any).user).toEqual({ admin: true });
        const files = (await (await fetch(url + "/api/files", { headers: { Cookie: cookieOf(res) } })).json()) as any;
        expect(files.files).toHaveLength(3);
        await new Promise((r) => secured.close(r));
      });
    });

    it("allows a non-loopback bind with only profile passwords", async () => {
      const open = await startWebServer({ host: "0.0.0.0", port: 0 });
      await new Promise((r) => open.close(r));
      fs.rmSync(path.join(dir, "config"), { recursive: true });
      fs.mkdirSync(path.join(dir, "config"));
      expect(() => startWebServer({ host: "0.0.0.0", port: 0 })).toThrow(/WEB_AUTH_TOKEN/);
    });
  });
});
