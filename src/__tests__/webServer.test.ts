import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { startWebServer, isLoopback } from "../web/server";
import * as garmin from "../mcp/tools/garmin";
import { closeStore, getStore } from "../shared/store";

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
const g = garmin as jest.Mocked<typeof garmin>;

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
