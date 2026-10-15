import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { startWebServer, isLoopback } from "../web/server";
import * as garmin from "../mcp/tools/garmin";

// The Garmin actions are the MCP tool bodies; stub them so no test touches Garmin.
jest.mock("../mcp/tools/garmin", () => ({
  listDevices: jest.fn(async () => ({ devices: [{ deviceId: 7, displayName: "Watch" }] })),
  uploadPlan: jest.fn(async () => ({ status: "ok", successful: 1, failed: 0 })),
  schedulePlan: jest.fn(async () => ({ attempted: [] })),
  uploadAndSchedulePlan: jest.fn(async () => ({ workouts: [] })),
  sendPlanToDevice: jest.fn(async () => ({ requested: ["Easy run"] })),
}));
const g = garmin as jest.Mocked<typeof garmin>;

const H = { "Content-Type": "application/json", "X-Requested-With": "plan-editor" };

describe("web plan editor", () => {
  let dir: string;
  let server: http.Server;
  let base: string;
  const prevPlans = process.env.WORKOUT_PLANS_DIR;
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
    fs.mkdirSync(path.join(dir, "plans"));
    fs.mkdirSync(path.join(dir, "data"));
    process.env.WORKOUT_PLANS_DIR = path.join(dir, "plans");
    process.env.GARMIN_DATA_DIR = path.join(dir, "data");
    process.env.GARMIN_PROFILES_DIR = path.join(dir, "config");
    delete process.env.GARMIN_PROFILE;
    fs.mkdirSync(path.join(dir, "config"));
    jest.clearAllMocks();
    fs.writeFileSync(path.join(dir, "plans", "a.json"), JSON.stringify(plan));
    server = await startWebServer({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevPlans === undefined) delete process.env.WORKOUT_PLANS_DIR; else process.env.WORKOUT_PLANS_DIR = prevPlans;
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
    const put = await call("PUT", q("workout-plans/a.json"), { text, mtimeMs: read.json.mtimeMs });
    expect(put.status).toBe(200);
    expect(put.json.validation.valid).toBe(true);
    expect(fs.readFileSync(path.join(dir, "plans", "a.json"), "utf8")).toBe(text);

    const ren = await call("POST", "/api/rename", { from: "workout-plans/a.json", to: "workout-plans/b.json" });
    expect(ren.status).toBe(200);
    expect(fs.existsSync(path.join(dir, "plans", "b.json"))).toBe(true);

    expect((await call("DELETE", q("workout-plans/b.json"))).status).toBe(200);
    expect(fs.existsSync(path.join(dir, "plans", "b.json"))).toBe(false);
  });

  it("creates new files and refuses to overwrite them", async () => {
    const text = JSON.stringify(plan);
    expect((await call("PUT", q("workout-plans/new.json"), { text, create: true })).status).toBe(201);
    expect((await call("PUT", q("workout-plans/new.json"), { text, create: true })).status).toBe(409);
  });

  it("detects concurrent changes on disk", async () => {
    const read = await call("GET", q("workout-plans/a.json"));
    fs.writeFileSync(path.join(dir, "plans", "a.json"), "[]");
    fs.utimesSync(path.join(dir, "plans", "a.json"), new Date(), new Date(Date.now() + 5000));
    const put = await call("PUT", q("workout-plans/a.json"), { text: "{}", mtimeMs: read.json.mtimeMs });
    expect(put.status).toBe(409);
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
    expect((await fetch(url)).status).toBe(401);
    const auth = "Basic " + Buffer.from("me:s3cret").toString("base64");
    expect((await fetch(url, { headers: { Authorization: auth } })).status).toBe(200);
    await new Promise((r) => secured.close(r));
  });

  it("serves the UI", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("vendor/monaco");
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
      fs.mkdirSync(path.join(dir, "data", "OTHER"));
      fs.writeFileSync(path.join(dir, "data", "OTHER", "w.json"), JSON.stringify(plan));
      await act({ action: "upload", path: "data/OTHER/w.json", profile: "TEST" }); // the folder decides
      expect(g.uploadPlan).toHaveBeenLastCalledWith("OTHER", "data/OTHER/w.json");

      const devices = await call("GET", "/api/garmin/devices?profile=TEST");
      expect(devices.json.devices).toEqual([expect.objectContaining({ deviceId: 7 })]);
    });

    it("refuses to upload invalid workouts but lets schedule and send through", async () => {
      addProfile("TEST");
      const bad = { workouts: [{ workoutName: "x", workoutType: "strength_training", steps: [{ stepType: "nope", targetType: "no.target" }] }] };
      fs.writeFileSync(path.join(dir, "plans", "bad.json"), JSON.stringify(bad));
      const up = await act({ action: "upload_schedule", path: "workout-plans/bad.json" });
      expect(up.status).toBe(422);
      expect(up.json.errors.length).toBeGreaterThan(0);
      expect(g.uploadAndSchedulePlan).not.toHaveBeenCalled();
      expect((await act({ action: "schedule", path: "workout-plans/bad.json" })).status).toBe(200);
    });

    it("reports Garmin failures with the log and the current file mtime", async () => {
      addProfile("TEST");
      g.uploadPlan.mockRejectedValueOnce(new Error("Failed to authenticate with Garmin"));
      const r = await act({ action: "upload" });
      expect(r.status).toBe(502);
      expect(r.json.error).toMatch(/authenticate/);
      expect(typeof r.json.mtimeMs).toBe("number");
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
        fs.mkdirSync(path.join(dir, "data", name));
        fs.writeFileSync(path.join(dir, "data", name, "w.json"), JSON.stringify(plan));
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
      expect(fs.existsSync(path.join(dir, "data", "SAM", "w.json"))).toBe(true);
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

    it("allows a non-loopback bind with only profile passwords", async () => {
      const open = await startWebServer({ host: "0.0.0.0", port: 0 });
      await new Promise((r) => open.close(r));
      fs.rmSync(path.join(dir, "config"), { recursive: true });
      fs.mkdirSync(path.join(dir, "config"));
      expect(() => startWebServer({ host: "0.0.0.0", port: 0 })).toThrow(/WEB_AUTH_TOKEN/);
    });
  });
});
