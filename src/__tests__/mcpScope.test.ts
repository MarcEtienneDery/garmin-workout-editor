jest.mock("@flow-js/garmin-connect", () => ({
  GarminConnect: jest.fn().mockImplementation(function () {
    return {};
  }),
}));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type * as http from "http";
import { configureMcp } from "../mcp/context";
import { startHttpServer } from "../mcp/http";
import { installConsoleRedirect } from "../mcp/logCapture";
import { MCP_TOKEN_PREFIX, closeStore, getStore, looksLikeMcpToken } from "../shared/store";
import { createMcpToken, publicMcpUrl } from "../shared/accounts";
import { seedProfile } from "./fixtures/profiles";

const ADMIN = "a".repeat(40);
const saved: Record<string, string | undefined> = {};
let dir: string;
let server: http.Server;
let base: string;

const PLAN = JSON.stringify({ weekStart: "2026-11-02", weekEnd: "2026-11-08", workouts: [{ workoutName: "Easy run", workoutType: "running", distanceMeters: 5000 }] });
const put = (logical: string, owner: string | null = null) => getStore().put(logical, PLAN, { source: "test", owner });

beforeAll(() => {
  jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  installConsoleRedirect();
  for (const key of ["GARMIN_DATA_DIR", "GARMIN_STORE_PATH", "GARMIN_TZ"]) saved[key] = process.env[key];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-scope-"));
  process.env.GARMIN_DATA_DIR = path.join(dir, "data");
  delete process.env.GARMIN_STORE_PATH;
  process.env.GARMIN_TZ = "UTC";
  configureMcp({ mock: false, defaultProfile: undefined });
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeStore();
  fs.rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

let tokenA: string, tokenB: string;

beforeEach(async () => {
  closeStore();
  fs.rmSync(path.join(dir, "data"), { recursive: true, force: true });
  seedProfile("ALICE");
  seedProfile("BOB");
  put("workout-plans/shared.json");
  put("workout-plans/alice-own.json", "ALICE");
  put("workout-plans/bob-own.json", "BOB");
  put("data/ALICE/training-plan.json");
  put("data/BOB/training-plan.json");
  tokenA = createMcpToken(getStore(), "ALICE");
  tokenB = createMcpToken(getStore(), "BOB");
  server = await startHttpServer({ host: "127.0.0.1", port: 0, token: ADMIN });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

let rpcId = 0;
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

async function tool(token: string, name: string, args: Record<string, unknown> = {}, via: "path" | "bearer" = "path") {
  const body = { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } };
  const res = via === "path" ? await post(`${base}/mcp/${token}`, body) : await post(`${base}/mcp`, body, { Authorization: `Bearer ${token}` });
  expect(res.status).toBe(200);
  const result = ((await res.json()) as any).result;
  const text: string = result.content[0].text;
  let value: any = text;
  if (!result.isError) { try { value = JSON.parse(text); } catch { } }
  return { isError: result.isError === true, value, text };
}

describe("a profile's MCP token", () => {
  it("has the shape of a token, is shown once and is kept as a hash", () => {
    const store = getStore();
    const token = store.mcpTokens.create("ALICE");
    expect(token).toMatch(new RegExp(`^${MCP_TOKEN_PREFIX}[0-9a-f]{64}$`));
    expect(looksLikeMcpToken(token)).toBe(true);
    expect(looksLikeMcpToken("gwm_short")).toBe(false);
    expect(looksLikeMcpToken(ADMIN)).toBe(false);
    expect(store.mcpTokens.profileOf(token)).toBe("ALICE");
    closeStore();
    const raw = fs.readdirSync(path.join(dir, "data")).filter((f) => f.endsWith(".db")).map((f) => fs.readFileSync(path.join(dir, "data", f)).toString("latin1")).join("");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(token.slice(MCP_TOKEN_PREFIX.length));
  });

  it("is replaced by the next one, and goes when removed", () => {
    const store = getStore();
    const first = store.mcpTokens.create("ALICE", 1000);
    const second = store.mcpTokens.create("ALICE", 2000);
    expect(second).not.toBe(first);
    expect(store.mcpTokens.profileOf(first)).toBeNull();
    expect(store.mcpTokens.profileOf(second)).toBe("ALICE");
    expect(store.mcpTokens.info("ALICE")).toEqual({ createdAt: 2000, lastUsedAt: expect.any(Number) });
    expect(store.mcpTokens.remove("ALICE")).toBe(true);
    expect(store.mcpTokens.profileOf(second)).toBeNull();
    expect(store.mcpTokens.info("ALICE")).toBeNull();
    expect(store.mcpTokens.remove("ALICE")).toBe(false);
  });

  it("marks when it was last used, at most every few minutes", () => {
    const store = getStore();
    const token = store.mcpTokens.create("BOB", 0);
    expect(store.mcpTokens.info("BOB")?.lastUsedAt).toBeNull();
    store.mcpTokens.profileOf(token, 10_000);
    expect(store.mcpTokens.info("BOB")?.lastUsedAt).toBe(10_000);
    store.mcpTokens.profileOf(token, 60_000);
    expect(store.mcpTokens.info("BOB")?.lastUsedAt).toBe(10_000);
    store.mcpTokens.profileOf(token, 10_000 + 5 * 60_000);
    expect(store.mcpTokens.info("BOB")?.lastUsedAt).toBe(10_000 + 5 * 60_000);
  });

  it("reads the public address of the MCP server from MCP_PUBLIC_URL", () => {
    const of = (value?: string) => publicMcpUrl({ MCP_PUBLIC_URL: value });
    expect(of(undefined)).toBeNull();
    expect(of("")).toBeNull();
    expect(of("not an address")).toBeNull();
    expect(of("ftp://mcp.example.com")).toBeNull();
    expect(of("https://mcp.example.com")).toBe("https://mcp.example.com");
    expect(of(" https://mcp.example.com/ ")).toBe("https://mcp.example.com");
    expect(of("https://mcp.example.com/mcp")).toBe("https://mcp.example.com");
    expect(of("https://example.com/garmin/mcp/")).toBe("https://example.com/garmin");
    expect(of("http://10.0.0.2:8787?x=1#y")).toBe("http://10.0.0.2:8787");
  });
});

describe("a connection made with a profile's token", () => {
  it("is let in by the token in the path or as a Bearer header, and by nothing else", async () => {
    expect((await tool(tokenA, "list_profiles")).value.profiles).toEqual(["ALICE"]);
    expect((await tool(tokenA, "list_profiles", {}, "bearer")).value.profiles).toEqual(["ALICE"]);
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await post(`${base}/mcp/${tokenA.slice(0, -1)}0`, body)).status).toBe(404);
    expect((await post(`${base}/mcp/gwm_${"0".repeat(64)}`, body)).status).toBe(404);
    expect((await post(`${base}/mcp`, body, { Authorization: "Bearer nope" })).status).toBe(404);
    expect((await post(`${base}/mcp`, body)).status).toBe(404);
  });

  it("stops working when it is replaced or removed, at once", async () => {
    const fresh = createMcpToken(getStore(), "ALICE");
    expect((await post(`${base}/mcp/${tokenA}`, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);
    expect((await tool(fresh, "list_profiles")).value.profiles).toEqual(["ALICE"]);
    getStore().mcpTokens.remove("ALICE");
    expect((await post(`${base}/mcp/${fresh}`, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);
  });

  it("sees one profile, and the server's own token still sees them all", async () => {
    const own = (await tool(tokenA, "list_profiles")).value;
    expect(own).toMatchObject({ profiles: ["ALICE"], defaultProfile: "ALICE", garminProfiles: [] });
    expect((await tool(ADMIN, "list_profiles")).value.profiles).toEqual(["ALICE", "BOB"]);
  });

  it("acts as its profile without being told which, though two profiles exist", async () => {
    const admin = await tool(ADMIN, "get_nutrition", {});
    expect(admin.isError).toBe(true);
    expect(admin.text).toMatch(/Multiple profiles/);
    const out = await tool(tokenA, "log_meal", { meal: "lunch", items: [{ name: "Soup", kcal: 200, proteinG: 10, carbsG: 20, fatG: 5 }] });
    expect(out.isError).toBe(false);
    const day = (await tool(tokenA, "get_nutrition", {})).value;
    expect(JSON.stringify(day)).toContain("Soup");
    expect(JSON.stringify((await tool(tokenB, "get_nutrition", {})).value)).not.toContain("Soup");
  });

  it("may name its own profile, in any case, and is refused any other", async () => {
    expect((await tool(tokenA, "get_nutrition", { profile: "alice" })).isError).toBe(false);
    const refused = await tool(tokenA, "log_meal", { profile: "BOB", meal: "lunch", items: [{ name: "Cake", kcal: 400, proteinG: 4, carbsG: 50, fatG: 20 }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe('Error: Profile "BOB" is not available: this connection can only use the profile "ALICE".');
    expect((await tool(tokenA, "get_nutrition", { profile: "BOB" })).isError).toBe(true);
    expect((await tool(tokenA, "get_activities", { profile: "BOB" })).isError).toBe(true);
    expect((await tool(tokenA, "get_wellness", { profile: "NOBODY" })).isError).toBe(true);
    expect(JSON.stringify((await tool(tokenB, "get_nutrition", {})).value)).not.toContain("Cake");
    expect(JSON.stringify((await tool(ADMIN, "get_nutrition", { profile: "BOB" })).value)).not.toContain("Cake");
  });

  it("lists the plans its profile can reach: the shared ones, its own and its data folder", async () => {
    const plans = (await tool(tokenA, "list_plans")).value;
    expect(plans["workout-plans"].map((f: any) => f.path).sort()).toEqual(["workout-plans/alice-own.json", "workout-plans/shared.json"]);
    expect(plans.data.map((f: any) => f.path)).toEqual(["data/ALICE/training-plan.json"]);
    const all = (await tool(ADMIN, "list_plans")).value;
    expect(all["workout-plans"]).toHaveLength(3);
    expect(all.data).toHaveLength(2);
  });

  it("reads and writes what it may reach and nothing of another profile's", async () => {
    for (const mine of ["workout-plans/shared.json", "workout-plans/alice-own.json", "data/ALICE/training-plan.json"]) {
      expect([mine, (await tool(tokenA, "read_plan", { path: mine })).isError]).toEqual([mine, false]);
    }
    for (const theirs of ["workout-plans/bob-own.json", "data/BOB/training-plan.json"]) {
      const out = await tool(tokenA, "read_plan", { path: theirs });
      expect([theirs, out.isError, out.text]).toEqual([theirs, true, `Error: ${theirs} belongs to another profile.`]);
      expect((await tool(tokenA, "write_plan", { path: theirs, content: { workouts: [] } })).isError).toBe(true);
      expect((await tool(tokenA, "validate_plan", { path: theirs })).isError).toBe(true);
      expect((await tool(tokenA, "archive_plan", { path: theirs })).isError).toBe(true);
      expect((await tool(tokenA, "unarchive_plan", { path: theirs })).isError).toBe(true);
      expect((await tool(tokenA, "upsert_plan_workout", { path: theirs, workout: { workoutName: "X", workoutType: "running", distanceMeters: 1000 } })).isError).toBe(true);
      expect((await tool(tokenA, "upload_workouts", { path: theirs, dryRun: true })).isError).toBe(true);
    }
    expect(getStore().get("workout-plans/bob-own.json")?.text).toBe(PLAN);
    expect(getStore().head("workout-plans/bob-own.json")?.archivedAt).toBeNull();
    expect((await tool(ADMIN, "read_plan", { path: "workout-plans/bob-own.json" })).isError).toBe(false);
  });

  it("owns the plans it creates under workout-plans/, which no other profile reaches", async () => {
    const made = await tool(tokenA, "write_plan", { path: "workout-plans/alice-new.json", content: JSON.parse(PLAN) });
    expect(made.isError).toBe(false);
    expect(getStore().head("workout-plans/alice-new.json")?.owner).toBe("ALICE");
    expect((await tool(tokenB, "read_plan", { path: "workout-plans/alice-new.json" })).isError).toBe(true);
    expect((await tool(tokenB, "write_plan", { path: "workout-plans/alice-new.json", content: { workouts: [] } })).isError).toBe(true);
    expect((await tool(tokenA, "write_plan", { path: "workout-plans/bob-own.json", content: JSON.parse(PLAN) })).isError).toBe(true);
    expect(getStore().head("workout-plans/bob-own.json")?.owner).toBe("BOB");
  });

  it("keeps two connections that run at once apart", async () => {
    const meal = (name: string) => ({ meal: "snack", items: [{ name, kcal: 100, proteinG: 1, carbsG: 10, fatG: 1 }] });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? tool(tokenA, "log_meal", meal(`alice-${i}`)) : tool(tokenB, "log_meal", meal(`bob-${i}`))))
    );
    const alice = JSON.stringify((await tool(tokenA, "get_nutrition", {})).value);
    const bob = JSON.stringify((await tool(tokenB, "get_nutrition", {})).value);
    expect(alice).toContain("alice-1");
    expect(alice).not.toContain("bob-");
    expect(bob).toContain("bob-0");
    expect(bob).not.toContain("alice-");
  });
});
