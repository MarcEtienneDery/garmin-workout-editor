jest.mock("../mcp/context", () => ({ ...jest.requireActual("../mcp/context"), getSession: jest.fn() }));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { configureMcp, getSession, getSettings } from "../mcp/context";
import { type GetReadinessArgs, type GetWellnessArgs, getReadiness, getWellness, refreshWellness, startBackgroundWellness } from "../mcp/tools/wellness";
import { WELLNESS_KINDS, closeStore, getStore } from "../shared/store";
import { addDays, isWellnessBackfilling } from "../shared/wellnessSync";
import { hrvResponse, sleepResponse, summaryResponse } from "./fixtures/wellness";
import { seedProfile } from "./fixtures/profiles";

const PROFILE = "MED";
const TODAY = new Date().toISOString().slice(0, 10); // GARMIN_TZ is UTC below

/** Garmin: answers by the path it is asked for, and records the paths. */
function fakeGarmin(fail?: (url: string) => Error | null) {
  const calls: string[] = [];
  const client = {
    get: async (url: string) => {
      calls.push(url.replace("https://connectapi.garmin.com", ""));
      const error = fail?.(url);
      if (error) throw error;
      if (url.includes("dailySleepData")) return sleepResponse();
      if (url.includes("/hrv-service/")) return hrvResponse();
      if (url.includes("usersummary")) return summaryResponse();
      return url.includes("bodyBattery") ? [] : {};
    },
  };
  const garminClient = {
    ensureAuthenticated: async () => true,
    getClientAny: () => ({ client }),
    getClient: () => ({ getUserProfile: async () => ({ displayName: "abc-123" }) }),
    isMockMode: () => false,
  };
  (getSession as jest.Mock).mockReturnValue({ profile: { name: PROFILE }, mock: false, garminClient });
  return { calls };
}

const readiness = (args: GetReadinessArgs = {}): Promise<any> => getReadiness(args);
const wellness = (args: Partial<GetWellnessArgs> = {}): Promise<any> => getWellness({ days: 14, ...args });

const settled = async () => {
  for (let i = 0; i < 1000 && isWellnessBackfilling(getStore(), PROFILE); i++) await new Promise((r) => setTimeout(r, 10));
};

let dir: string;
const saved = { path: process.env.GARMIN_STORE_PATH, gap: process.env.GARMIN_DETAIL_GAP_MS, tz: process.env.GARMIN_TZ, days: process.env.WELLNESS_DAYS };
const KEPT = 30; // a month: enough for the baselines, quick to fill
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-"));
  process.env.GARMIN_STORE_PATH = path.join(dir, "garmin.db");
  process.env.GARMIN_DETAIL_GAP_MS = "0";
  process.env.GARMIN_TZ = "UTC";
  process.env.WELLNESS_DAYS = String(KEPT);
  seedProfile(PROFILE, { garmin: true });
});
afterEach(async () => {
  await settled();
  closeStore();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [["GARMIN_STORE_PATH", saved.path], ["GARMIN_DETAIL_GAP_MS", saved.gap], ["GARMIN_TZ", saved.tz], ["WELLNESS_DAYS", saved.days]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  (getSession as jest.Mock).mockReset();
});

describe("get_readiness", () => {
  it("fetches the last days' sleep, HRV and summary at once, answers from them, and fills the rest in the background", async () => {
    const { calls } = fakeGarmin();
    const out = await readiness({});
    expect(out.date).toBe(TODAY);
    expect(out.band).toMatch(/go-harder|as-planned|back-off/);
    expect(out.signals.map((s: any) => s.name)).toEqual(expect.arrayContaining(["hrv", "sleep", "restingHr"]));
    expect(out.daysStored).toBeGreaterThanOrEqual(3);
    expect(calls.slice(0, 9).every((c) => /dailySleepData|hrv-service|usersummary/.test(c))).toBe(true); // the 3 kinds, 3 days
    expect(calls.some((c) => c.includes("abc-123"))).toBe(true); // the user's display name, where Garmin files by it

    await settled();
    expect(getStore().wellness.counts(PROFILE).days).toBe(KEPT);
    expect(getStore().wellness.get(PROFILE, TODAY, "hrv")!.data).toEqual(hrvResponse());
  });

  it("does not ask Garmin again for what is stored and fresh", async () => {
    const { calls } = fakeGarmin();
    await readiness({});
    await settled();
    const before = calls.length;
    const again = await readiness({});
    await settled();
    expect(calls.length).toBe(before);
    expect(again.sync.pending).toBe(0);
  });

  it("answers for an older day from what is stored, without asking Garmin for the last days", async () => {
    fakeGarmin();
    const out = await readiness({ date: addDays(TODAY, -20) });
    expect(out.date).toBe(addDays(TODAY, -20));
    expect(out.daysStored).toBe(0); // nothing was fetched for it first: only the background sync, which has stored nothing yet
    await settled();
    expect((await readiness({ date: addDays(TODAY, -20) })).daysStored).toBeGreaterThan(0);
  });

  it("still answers when Garmin refuses, and says why", async () => {
    fakeGarmin(() => new Error("Request failed (429) too many requests"));
    const out = await readiness({});
    expect(out.band).toBe("unknown");
    expect(out.sync.error).toMatch(/429/);
    expect(out.missing.length).toBeGreaterThan(0);
  });

  it("waits while the activity sync is waiting on a rate limit, as the limit is the account's", async () => {
    const { calls } = fakeGarmin();
    getStore().activities.saveProgress(PROFILE, { error: "too many requests (429)", retryAfter: Date.now() + 60_000 });
    const out = await readiness({});
    expect(calls).toHaveLength(0);
    expect(out.sync.error).toMatch(/429/);
  });

  it("says so in mock mode and keeps nothing", async () => {
    const before = getSettings().mock;
    configureMcp({ mock: true });
    try {
      expect(await readiness({})).toEqual(expect.objectContaining({ mock: true }));
    } finally {
      configureMcp({ mock: before });
    }
  });
});

describe("get_wellness", () => {
  it("returns the stored days newest first, with the person's baselines", async () => {
    fakeGarmin();
    await readiness({});
    await settled();
    const out = await wellness();
    expect(out.to).toBe(TODAY);
    expect(out.from).toBe(addDays(TODAY, -13));
    expect(out.days).toHaveLength(14);
    expect(out.days[0].day).toBe(TODAY);
    expect(out.days[13].day).toBe(addDays(TODAY, -13));
    expect(out.days[0]).toEqual(expect.objectContaining({ sleepSeconds: 27_000, hrvLastNight: 57, restingHr: 50, bodyBatteryWake: 75 }));
    expect(out.baselines).toEqual(expect.objectContaining({ hrv: 57, restingHr: 50 }));
  });

  it("returns Garmin's full stored responses for a single day when asked", async () => {
    fakeGarmin();
    await readiness({});
    await settled();
    const out = await wellness({ from: TODAY, to: TODAY, rawKinds: ["sleep", "hrv"] });
    expect(out.raw!.sleep.data).toEqual(sleepResponse());
    expect(out.raw!.hrv.data).toEqual(hrvResponse());
  });

  it("refuses a range that is backwards or too long, and raw responses for a range", async () => {
    fakeGarmin();
    await expect(getWellness({ days: 14, from: "2026-02-02", to: "2026-02-01" })).rejects.toThrow("after");
    await expect(getWellness({ days: 14, from: "2025-01-01", to: "2026-02-01" })).rejects.toThrow("at most");
    await expect(getWellness({ days: 14, rawKinds: ["sleep"] })).rejects.toThrow("one day");
    await settled();
  });
});

describe("refreshWellness for a page's Sync button", () => {
  const nine = (day: string) => [
    `/usersummary-service/usersummary/daily/abc-123?calendarDate=${day}`,
    `/sleep-service/sleep/dailySleepData?date=${day}&nonSleepBufferMinutes=60`,
    `/hrv-service/hrv/${day}`,
    `/wellness-service/wellness/dailyHeartRate/abc-123?date=${day}`,
    `/wellness-service/wellness/dailyStress/${day}`,
    `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${day}&endDate=${day}`,
    `/wellness-service/wellness/daily/respiration/${day}`,
    `/wellness-service/wellness/daily/spo2/${day}`,
    `/weight-service/weight/dayview/${day}`,
  ];
  const agoToday = (ms: number) => {
    for (const kind of WELLNESS_KINDS) getStore().wellness.put(PROFILE, TODAY, kind, kind === "summary" ? summaryResponse() : null, Date.now() - ms);
  };

  it("fetches every kind for the last days, where a view opening or a tool call fetches the four a readiness is made of", async () => {
    const { calls } = fakeGarmin();
    await refreshWellness(PROFILE);
    expect(calls).toHaveLength(3 * 4);
    expect(calls.some((c) => c.includes("dailyStress"))).toBe(false);

    const before = calls.length;
    const out = await refreshWellness(PROFILE, { manual: true });
    expect(out).toEqual({ fetched: 3 * 5, busy: false, error: null }); // the five kinds not fetched yet, for each of the three days
    const day = (d: string) => calls.slice(before).filter((c) => c.includes(d));
    expect(day(TODAY).sort()).toEqual(nine(TODAY).filter((c) => !/usersummary|dailySleepData|hrv-service|weight-service/.test(c)).sort());
  });

  it("asks again for today's data after a minute when a Sync button asks, and after five when the view only opened", async () => {
    const { calls } = fakeGarmin();
    await refreshWellness(PROFILE, { manual: true });
    const before = calls.length;

    await refreshWellness(PROFILE, { manual: true }); // a moment later: all of it is kept
    expect(calls.length).toBe(before);

    agoToday(2 * 60_000); // two minutes ago: old for a Sync button, not for a view opening
    await refreshWellness(PROFILE);
    expect(calls.length).toBe(before);
    const out = await refreshWellness(PROFILE, { manual: true });
    expect(out).toEqual({ fetched: 9, busy: false, error: null });
    expect(calls.slice(before).sort()).toEqual(nine(TODAY).sort()); // today's nine, and nothing of the days before (fetched a moment ago)

    agoToday(6 * 60_000); // six minutes ago: a view opening asks again, for the kinds it fetches
    const opened = await refreshWellness(PROFILE);
    expect(opened.fetched).toBe(4);
  });

  it("keeps the days before for half an hour, a Sync button or not", async () => {
    const { calls } = fakeGarmin();
    await refreshWellness(PROFILE, { manual: true });
    const yesterday = addDays(TODAY, -1);
    const before = calls.length;
    for (const kind of WELLNESS_KINDS) getStore().wellness.put(PROFILE, yesterday, kind, null, Date.now() - 20 * 60_000);
    await refreshWellness(PROFILE, { manual: true });
    expect(calls.slice(before).some((c) => c.includes(yesterday))).toBe(false);
    for (const kind of WELLNESS_KINDS) getStore().wellness.put(PROFILE, yesterday, kind, null, Date.now() - 31 * 60_000);
    await refreshWellness(PROFILE, { manual: true });
    expect(calls.slice(before).filter((c) => c.includes(yesterday)).sort()).toEqual(nine(yesterday).sort());
  });

  it("fills in more days in the background when the page shows more than are kept", async () => {
    fakeGarmin();
    startBackgroundWellness(PROFILE, KEPT + 15);
    await settled();
    expect(getStore().wellness.counts(PROFILE).days).toBe(KEPT + 15);
  });
});
