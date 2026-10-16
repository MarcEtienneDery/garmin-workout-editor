jest.mock("../mcp/context", () => ({ ...jest.requireActual("../mcp/context"), getSession: jest.fn() }));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ActivityExporter from "../activityExporter";
import { getSession } from "../mcp/context";
import { getActivities, type GetActivitiesArgs } from "../mcp/tools/activities";
import { isBackfilling } from "../shared/activitySync";
import { closeStore, getStore } from "../shared/store";

const PROFILE = "MED";
const DAY = 86_400_000;
const when = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 19).replace("T", " ");

const item = (n: number, daysAgo: number, typeKey = n % 2 ? "running" : "strength_training") => ({
  activityId: 5000 + n,
  activityName: `Activity ${n}`,
  activityType: { typeKey },
  startTimeGMT: when(daysAgo),
  startTimeLocal: when(daysAgo),
  duration: 3000 + n,
  distance: typeKey === "running" ? 10000 : undefined,
  averageSpeed: typeKey === "running" ? 3 : undefined,
  averageHR: 140 + n,
});

/** Garmin: a list of activities, newest first, with details that carry the RPE. */
function fakeGarmin(items: any[]) {
  const calls = { list: [] as number[], detail: [] as string[], chart: [] as string[] };
  let listError: Error | null = null;
  const client = {
    getActivities: async (start: number, limit: number) => {
      calls.list.push(start);
      if (listError) throw listError;
      return items.slice(start, start + limit);
    },
    getActivity: async ({ activityId }: { activityId: string }) => {
      calls.detail.push(String(activityId));
      return { activityId: Number(activityId), summaryDTO: { directWorkoutFeel: 70, directWorkoutRpe: 40 } };
    },
  };
  const garminClient = {
    ensureAuthenticated: async () => true, getClientAny: () => client, getActivityExerciseSets: async () => [], isMockMode: () => false,
    getActivityDetails: async (id: string) => { calls.chart.push(String(id)); return { metricDescriptors: [], activityDetailMetrics: [] }; },
    getActivitySplits: async () => ({ lapDTOs: [] }),
    getActivityHrZones: async () => [],
  };
  (getSession as jest.Mock).mockReturnValue({ profile: { name: PROFILE }, mock: false, garminClient, exporter: new ActivityExporter(garminClient as any) });
  return { calls, failList: (error: Error | null) => void (listError = error) };
}

const ask = (over: Partial<GetActivitiesArgs> = {}): Promise<any> => getActivities({ limit: 30, period: "all", includeDetails: true, ...over } as GetActivitiesArgs);
const settled = async () => {
  for (let i = 0; i < 200 && isBackfilling(getStore(), PROFILE); i++) await new Promise((r) => setTimeout(r, 10));
};

let dir: string;
const saved = { path: process.env.GARMIN_STORE_PATH, gap: process.env.GARMIN_DETAIL_GAP_MS };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "get-activities-"));
  process.env.GARMIN_STORE_PATH = path.join(dir, "garmin.db");
  process.env.GARMIN_DETAIL_GAP_MS = "0";
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  await settled();
  closeStore();
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [["GARMIN_STORE_PATH", saved.path], ["GARMIN_DETAIL_GAP_MS", saved.gap]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("get_activities", () => {
  const five = () => [item(5, 1), item(4, 2), item(3, 3), item(2, 4), item(1, 5)]; // newest first

  it("stores the history on the first call and answers from it in the slim format, with the details of what it returns", async () => {
    const garmin = fakeGarmin(five());
    const out = await ask();
    expect(garmin.calls.list).toEqual([0, 5]); // the newest end, then the rest, up to the end of the history
    expect(garmin.calls.detail.sort()).toEqual(["5001", "5002", "5003", "5004", "5005"]);
    expect(out.activities.map((a: any) => a.id)).toEqual([5005, 5004, 5003, 5002, 5001]); // newest first
    expect(out.activities[0]).toEqual(expect.objectContaining({ activityType: "running", directWorkoutFeel: 70, directWorkoutRpe: 40, distance: 10 }));
    expect(out).toEqual(expect.objectContaining({ totalActivities: 5, total: 5, truncated: false }));
    expect(out.sync).toEqual(expect.objectContaining({ activities: 5, withDetails: 5, historyComplete: true, pendingDetails: 0, added: 5 }));
    expect(getStore().activities.counts(PROFILE).total).toBe(5);
    expect(getStore().head(`data/${PROFILE}/activities.json`)).toBeUndefined(); // no document is written any more
  });

  it("asks Garmin only for what is new on the next call, and for no details it has", async () => {
    const items = five();
    const garmin = fakeGarmin(items);
    await ask();
    await settled(); // the background job fetches the charts too
    expect(garmin.calls.chart).toHaveLength(5); // every activity's charts came with the history
    garmin.calls.list.length = 0;
    garmin.calls.detail.length = 0;
    garmin.calls.chart.length = 0;

    expect((await ask()).sync.added).toBe(0);
    expect(garmin.calls).toEqual({ list: [0], detail: [], chart: [] });

    items.unshift(item(6, 0.1));
    const out = await ask();
    expect(garmin.calls.list).toEqual([0, 0]);
    expect(out.sync.added).toBe(1);
    expect(out.activities[0].id).toBe(5006);
    expect(garmin.calls.detail).toEqual(["5006"]);
    await settled();
    expect(garmin.calls.chart).toEqual(["5006"]); // the background job takes the new activity's charts
  });

  it("returns what is stored at once and fills the details in the background when asked for none", async () => {
    const garmin = fakeGarmin(five());
    const first = await ask({ includeDetails: false });
    expect(first.activities).toHaveLength(5);
    expect(first.activities[0].directWorkoutRpe).toBeUndefined();
    expect(first.sync.note).toMatch(/background/);
    await settled();
    expect(garmin.calls.detail).toHaveLength(5);
    const later = await ask({ includeDetails: false });
    expect(later.activities[0].directWorkoutRpe).toBe(40);
    expect(later.sync).toEqual(expect.objectContaining({ pendingDetails: 0, syncing: false }));
  });

  it("caps what it returns, newest first, and says when more matched", async () => {
    fakeGarmin(five());
    const out = await ask({ limit: 2 });
    expect(out.activities.map((a: any) => a.id)).toEqual([5005, 5004]);
    expect(out).toEqual(expect.objectContaining({ totalActivities: 2, total: 5, truncated: true }));
  });

  it("filters by type and by date range", async () => {
    fakeGarmin(five());
    expect((await ask({ type: "running" })).activities.map((a: any) => a.activityType)).toEqual(["running", "running", "running"]);
    const day = (n: number) => when(n).slice(0, 10);
    const out = await ask({ weekStart: day(4), weekEnd: day(2) });
    expect(out.activities.map((a: any) => a.id)).toEqual([5004, 5003, 5002]); // 2, 3 and 4 days ago: the end day counts
  });

  it("answers from what is stored when Garmin refuses, and says so", async () => {
    const garmin = fakeGarmin(five());
    await ask();
    await settled();
    garmin.failList(new Error("ERROR: (429), Too Many Requests"));
    const out = await ask();
    expect(out.activities).toHaveLength(5);
    expect(out.sync.error).toMatch(/429/);

    garmin.failList(null); // Garmin answers again: the stale error must not stay on every later answer
    const later = await ask();
    expect(later.sync.error).toBeNull();
    expect(later.sync.note).toBeUndefined();
  });

  it("copes with two calls at once: they do not release each other's lease", async () => {
    fakeGarmin(five());
    const [a, b] = await Promise.all([ask({ includeDetails: false }), ask({ includeDetails: false })]);
    expect(a.activities.length + b.activities.length).toBeGreaterThanOrEqual(5); // one may answer while the other is still listing
    await settled();
    const status = (await ask({ includeDetails: false })).sync;
    expect(status).toEqual(expect.objectContaining({ activities: 5, withDetails: 5, historyComplete: true, error: null, syncing: false }));
  });

  it("answers an empty profile with an empty list, not an error", async () => {
    fakeGarmin([]);
    const out = await ask();
    expect(out.activities).toEqual([]);
    expect(out.sync).toEqual(expect.objectContaining({ activities: 0, historyComplete: true }));
  });

  it("keeps mock mode out of the database", async () => {
    const exporter = new ActivityExporter({ isMockMode: () => true } as any);
    jest.spyOn(exporter, "fetchActivities").mockResolvedValue([{ activityId: 1, activityName: "Mock", activityType: { typeKey: "running" }, startTimeGMT: when(1), startTimeLocal: when(1) }]);
    (getSession as jest.Mock).mockReturnValue({ profile: { name: "mock" }, mock: true, garminClient: {}, exporter });
    const out = await ask();
    expect(out.mock).toBe(true);
    expect(out.activities).toHaveLength(1);
    expect(getStore().activities.counts("mock").total).toBe(0);
  });
});
