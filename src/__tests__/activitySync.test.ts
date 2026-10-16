import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { type ActivitySource, COOL_OFF_MS, LEASE_MS, LeaseLost, MAX_RATE_LIMIT_RETRIES, PAGE_SIZE, SETTLE_MS, isBackfilling, startBackfill, syncDetails, syncList, syncStatus, toNewActivity, withLease } from "../shared/activitySync";
import { MAX_DETAIL_FAILURES, REFRESH_YOUNG_MS, SqliteStore } from "../shared/store";

const DAY = 86_400_000;
const PROFILE = "MED";

/** Garmin's list item for the n-th activity: an hour apart, a larger n being newer. */
const listItem = (n: number, extra: Record<string, unknown> = {}) => {
  const start = new Date(Date.UTC(2026, 0, 1) + n * 3_600_000); // later n = newer
  const gmt = start.toISOString().slice(0, 19).replace("T", " ");
  return {
    activityId: 1000 + n,
    activityName: `Activity ${n}`,
    activityType: { typeKey: n % 2 ? "running" : "strength_training" },
    startTimeGMT: gmt,
    startTimeLocal: gmt,
    duration: 1800 + n,
    distance: 5000 + n,
    averageHR: 140,
    ...extra,
  };
};

/** Garmin as a list of activities, newest first, that counts what it is asked. */
function fakeGarmin(total: number, options: { failDetail?: (id: string) => Error | null } = {}) {
  const items: any[] = Array.from({ length: total }, (_, i) => listItem(total - i)); // newest first
  const calls = { list: [] as number[], detail: [] as string[] };
  const source: ActivitySource = {
    async listPage(offset, limit) {
      calls.list.push(offset);
      return items.slice(offset, offset + limit);
    },
    async fetchDetail({ id, type }) {
      calls.detail.push(id);
      const error = options.failDetail?.(id);
      if (error) throw error;
      return { activityId: Number(id), summaryDTO: { directWorkoutRpe: 40 }, ...(type === "strength_training" ? { fullExerciseSets: [{ setType: "ACTIVE" }] } : {}) };
    },
  };
  /** A new activity appears on Garmin: the newest one. */
  const addNewest = (extra: Record<string, unknown> = {}) => {
    const n = items.length + 1;
    items.unshift(listItem(n, extra));
    return n;
  };
  return { source, calls, items, addNewest };
}

const noSleep = async () => undefined;

let dir: string;
let store: SqliteStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-sync-"));
  store = SqliteStore.open(path.join(dir, "garmin.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("activities table", () => {
  it("keeps what Garmin listed, and never overwrites it with a later listing", () => {
    const item = listItem(1);
    expect(store.activities.insertNew(PROFILE, [toNewActivity(item)!])).toBe(1);
    expect(store.activities.insertNew(PROFILE, [toNewActivity({ ...item, activityName: "Renamed on Garmin" })!])).toBe(0);
    const stored = store.activities.get(PROFILE, "1001")!;
    expect(stored).toEqual(expect.objectContaining({ id: "1001", name: "Activity 1", type: "running", distance: 5001, avgHr: 140, detail: null }));
    expect(stored.raw).toEqual(item);
  });

  it("fills what a list item lacks from the details: the workout it came from, and the summary fields", () => {
    const bare = listItem(1, { workoutId: undefined, maxHR: undefined, averageSpeed: undefined, calories: undefined, trainingEffectLabel: undefined });
    store.activities.insertNew(PROFILE, [toNewActivity(bare)!]);
    expect(store.activities.get(PROFILE, "1001")!.workoutId).toBeNull();
    expect(store.activities.summaries(PROFILE)[0]).toEqual(expect.objectContaining({ workoutId: null, maxHr: null, speed: null, calories: null, trainingEffectLabel: null, detailed: false }));

    store.activities.setDetail(PROFILE, "1001", { metadataDTO: { associatedWorkoutId: 1572415008 }, summaryDTO: { maxHR: 171, averageSpeed: 3.2, calories: 640, trainingEffectLabel: "TEMPO" } });
    expect(store.activities.get(PROFILE, "1001")!.workoutId).toBe("1572415008");
    expect(store.activities.summaries(PROFILE)[0]).toEqual(expect.objectContaining({ workoutId: "1572415008", maxHr: 171, speed: 3.2, calories: 640, trainingEffectLabel: "TEMPO", detailed: true }));
  });

  it("keeps the workout the list item named, whatever the details say", () => {
    store.activities.insertNew(PROFILE, [toNewActivity(listItem(2, { workoutId: 55 }))!]);
    store.activities.setDetail(PROFILE, "1002", { metadataDTO: { associatedWorkoutId: 99 } });
    expect(store.activities.get(PROFILE, "1002")!.workoutId).toBe("55");
  });

  it("builds a row from a list item and refuses one with no id or no start", () => {
    expect(toNewActivity(listItem(2))).toEqual(expect.objectContaining({ id: "1002", type: "strength_training", startLocal: expect.any(String) }));
    expect(toNewActivity({ ...listItem(3), workoutId: 77 })!.workoutId).toBe("77");
    expect(toNewActivity({ ...listItem(3), startTimeGMT: undefined })!.startGmt).toBe(listItem(3).startTimeLocal);
    expect(toNewActivity({ activityName: "x" })).toBeNull();
    expect(toNewActivity({ activityId: 5 })).toBeNull();
    expect(toNewActivity(null)).toBeNull();
  });

  it("keeps each profile's activities apart", () => {
    store.activities.insertNew("MED", [toNewActivity(listItem(1))!]);
    store.activities.insertNew("SAM", [toNewActivity(listItem(1))!, toNewActivity(listItem(2))!]);
    expect(store.activities.counts("MED").total).toBe(1);
    expect(store.activities.counts("SAM").total).toBe(2);
    expect(store.activities.between("MED").map((a) => a.id)).toEqual(["1001"]);
  });

  it("answers a range newest first, by type, and the newest few", () => {
    store.activities.insertNew(PROFILE, [1, 2, 3, 4, 5, 6].map((n) => toNewActivity(listItem(n))!));
    const all = store.activities.between(PROFILE);
    expect(all.map((a) => a.id)).toEqual(["1006", "1005", "1004", "1003", "1002", "1001"]);
    expect(store.activities.between(PROFILE, { type: "running" }).map((a) => a.id)).toEqual(["1005", "1003", "1001"]);
    expect(store.activities.between(PROFILE, { from: all[3].startGmt, to: all[1].startGmt }).map((a) => a.id)).toEqual(["1005", "1004", "1003"]);
    expect(store.activities.between(PROFILE, { limit: 2 }).map((a) => a.id)).toEqual(["1006", "1005"]);
  });

  it("keeps the details apart from the list item, and merges nothing on its own", () => {
    store.activities.insertNew(PROFILE, [toNewActivity(listItem(1))!]);
    store.activities.setDetail(PROFILE, "1001", { summaryDTO: { directWorkoutRpe: 30 } }, 123);
    const stored = store.activities.get(PROFILE, "1001")!;
    expect(stored.detail).toEqual({ summaryDTO: { directWorkoutRpe: 30 } });
    expect(stored.detailAt).toBe(123);
    expect(stored.raw.summaryDTO).toBeUndefined();
    expect(store.activities.counts(PROFILE)).toEqual(expect.objectContaining({ total: 1, withDetail: 1 }));
  });

  describe("details still wanted", () => {
    // activity n started on the n-th of January 2026 at 10:00 GMT
    const old = (n: number) => toNewActivity(listItem(n, { startTimeGMT: `2026-01-0${n} 10:00:00`, startTimeLocal: `2026-01-0${n} 05:00:00`, activityId: n }))!;
    const startOfOld = (n: number) => Date.parse(`2026-01-0${n}T10:00:00Z`);

    it("lists activities without details newest first, and honours a limit and a set of ids", () => {
      store.activities.insertNew(PROFILE, [1, 2, 3].map((n) => toNewActivity(listItem(n))!));
      expect(store.activities.needingDetail(PROFILE, { settleMs: SETTLE_MS }).map((a) => a.id)).toEqual(["1003", "1002", "1001"]);
      expect(store.activities.needingDetail(PROFILE, { settleMs: SETTLE_MS, limit: 2 }).map((a) => a.id)).toEqual(["1003", "1002"]);
      expect(store.activities.needingDetail(PROFILE, { settleMs: SETTLE_MS, ids: ["1001"] }).map((a) => a.id)).toEqual(["1001"]);
    });

    it("wants details again only while they were fetched soon after the activity, when feel and RPE may still be missing", () => {
      store.activities.insertNew(PROFILE, [old(1), old(2), old(3)]);
      store.activities.setDetail(PROFILE, "1", {}, startOfOld(1) + DAY); // fetched a day after: may change
      store.activities.setDetail(PROFILE, "2", {}, startOfOld(2) + SETTLE_MS + 1); // fetched after the settling time: final
      expect(store.activities.needingDetail(PROFILE, { settleMs: SETTLE_MS }).map((a) => a.id)).toEqual(["3", "1"]);
      store.activities.setDetail(PROFILE, "1", {}, startOfOld(1) + SETTLE_MS + DAY);
      expect(store.activities.needingDetail(PROFILE, { settleMs: SETTLE_MS }).map((a) => a.id)).toEqual(["3"]);
    });

    it("leaves a young activity alone for a few hours after its details were fetched, so a busy day is not fetched again and again", () => {
      const now = Date.now();
      const young = toNewActivity(listItem(1, { startTimeGMT: new Date(now - 2 * 3_600_000).toISOString().slice(0, 19).replace("T", " ") }))!;
      store.activities.insertNew(PROFILE, [young]);
      store.activities.setDetail(PROFILE, "1001", {}, now - 60_000);
      expect(store.activities.needingDetail(PROFILE, { settleMs: SETTLE_MS, now })).toEqual([]);
      expect(store.activities.needingDetail(PROFILE, { settleMs: SETTLE_MS, now: now + REFRESH_YOUNG_MS + 60_000 }).map((a) => a.id)).toEqual(["1001"]);
    });

    it("gives up on an activity whose details keep failing", () => {
      store.activities.insertNew(PROFILE, [old(1)]);
      for (let i = 0; i < MAX_DETAIL_FAILURES; i++) {
        expect(store.activities.needingDetail(PROFILE, { settleMs: SETTLE_MS })).toHaveLength(1);
        store.activities.noteDetailFailure(PROFILE, "1");
      }
      expect(store.activities.needingDetail(PROFILE, { settleMs: SETTLE_MS })).toHaveLength(0);
    });
  });
});

describe("the lease", () => {
  it("lets one holder sync a profile at a time, across two connections to the same file", () => {
    const other = SqliteStore.open(path.join(dir, "garmin.db"));
    try {
      expect(store.activities.claim(PROFILE, "mcp:1", LEASE_MS, 1000)).toBe(true);
      expect(other.activities.claim(PROFILE, "web:2", LEASE_MS, 2000)).toBe(false); // held by the other process
      expect(store.activities.claim(PROFILE, "mcp:1", LEASE_MS, 2000)).toBe(true); // the holder may claim again
      expect(other.activities.claim("SAM", "web:2", LEASE_MS, 2000)).toBe(true); // another profile is free
      expect(other.activities.state(PROFILE)).toEqual(expect.objectContaining({ holder: "mcp:1", leaseUntil: 2000 + LEASE_MS }));
      store.activities.release(PROFILE, "mcp:1", 3000);
      expect(other.activities.claim(PROFILE, "web:2", LEASE_MS, 3000)).toBe(true);
    } finally {
      other.close();
    }
  });

  it("is taken over once it has run out, and a holder that lost it cannot renew or release it", () => {
    expect(store.activities.claim(PROFILE, "mcp:1", 1000, 0)).toBe(true);
    expect(store.activities.claim(PROFILE, "web:2", 1000, 999)).toBe(false);
    expect(store.activities.claim(PROFILE, "web:2", 1000, 1001)).toBe(true);
    expect(store.activities.renew(PROFILE, "mcp:1", 1000, 1100)).toBe(false);
    store.activities.release(PROFILE, "mcp:1", 1200);
    expect(store.activities.state(PROFILE).holder).toBe("web:2");
    expect(store.activities.renew(PROFILE, "web:2", 1000, 1300)).toBe(true);
  });

  it("withLease runs the work under the lease and always lets go", async () => {
    const result = await withLease(store, PROFILE, "mcp:1", async (renew) => {
      expect(store.activities.state(PROFILE).holder).toBe("mcp:1");
      expect(renew()).toBe(true);
      return 7;
    });
    expect(result).toEqual({ ok: true, value: 7 });
    expect(store.activities.state(PROFILE).holder).toBeNull();

    store.activities.claim(PROFILE, "web:2", LEASE_MS);
    expect(await withLease(store, PROFILE, "mcp:1", async () => 1)).toEqual({ ok: false });
    store.activities.release(PROFILE, "web:2");
    await expect(withLease(store, PROFILE, "mcp:1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(store.activities.state(PROFILE).holder).toBeNull();
  });
});

describe("listing the history", () => {
  it("pages back to the end of the history and marks it complete", async () => {
    const garmin = fakeGarmin(250);
    const result = await syncList(store, PROFILE, garmin.source);
    expect(result).toEqual({ added: 250, pages: 4, complete: true }); // 100 + 100 + 50, then an empty page
    expect(garmin.calls.list).toEqual([0, 100, 200, 250]);
    expect(store.activities.counts(PROFILE).total).toBe(250);
    expect(store.activities.state(PROFILE)).toEqual(expect.objectContaining({ complete: true, nextOffset: 250 }));
  });

  it("asks for only what is new once the history is complete, stopping at the first activity it has", async () => {
    const garmin = fakeGarmin(250);
    await syncList(store, PROFILE, garmin.source);
    garmin.calls.list.length = 0;

    expect(await syncList(store, PROFILE, garmin.source)).toEqual({ added: 0, pages: 1, complete: true });
    expect(garmin.calls.list).toEqual([0]);

    garmin.addNewest();
    garmin.addNewest();
    garmin.calls.list.length = 0;
    expect(await syncList(store, PROFILE, garmin.source)).toEqual({ added: 2, pages: 1, complete: true });
    expect(garmin.calls.list).toEqual([0]);
    expect(store.activities.counts(PROFILE).total).toBe(252);
  });

  it("keeps paging while a whole page is new, such as after a long absence", async () => {
    const garmin = fakeGarmin(30);
    await syncList(store, PROFILE, garmin.source);
    for (let i = 0; i < PAGE_SIZE + 20; i++) garmin.addNewest();
    garmin.calls.list.length = 0;
    expect(await syncList(store, PROFILE, garmin.source)).toEqual(expect.objectContaining({ added: PAGE_SIZE + 20 }));
    expect(garmin.calls.list).toEqual([0, 100]);
  });

  it("resumes an interrupted backfill and leaves no gap, even with a new activity in between", async () => {
    const garmin = fakeGarmin(350);
    let dies = true;
    const flaky: ActivitySource = {
      ...garmin.source,
      async listPage(offset, limit) {
        if (dies && offset >= 200) throw new Error("network down");
        return garmin.source.listPage(offset, limit);
      },
    };
    await expect(syncList(store, PROFILE, flaky)).rejects.toThrow("network down");
    expect(store.activities.counts(PROFILE).total).toBe(200);
    expect(store.activities.state(PROFILE)).toEqual(expect.objectContaining({ complete: false, nextOffset: 200 }));

    // The history is not complete, so the next run must neither stop at the newest page it has nor miss what is new.
    garmin.addNewest(); // shifts everything older by one
    dies = false;
    garmin.calls.list.length = 0;
    const result = await syncList(store, PROFILE, garmin.source);
    expect(result.complete).toBe(true);
    expect(garmin.calls.list.slice(0, 2)).toEqual([0, 181]); // the newest end first (one new activity), then back up a little from where it stopped, moved along by that one
    expect(store.activities.counts(PROFILE).total).toBe(351);
    const ids = new Set(store.activities.between(PROFILE).map((a) => a.id));
    for (let n = 1; n <= 351; n++) expect(ids.has(String(1000 + n))).toBe(true);
  });

  it("stops when the lease is lost", async () => {
    const garmin = fakeGarmin(250);
    let pages = 0;
    await expect(syncList(store, PROFILE, garmin.source, { renew: () => ++pages < 2 })).rejects.toBeInstanceOf(LeaseLost);
    expect(store.activities.counts(PROFILE).total).toBe(100);
  });
});

describe("the old activity documents", () => {
  const putDocs = () => {
    for (const logical of ["data/MED/activities.json", "data/MED/activities-raw.json", "data/MED/activities-50.tmp.json", "data/SAM/activities.json", "data/MED/training-plan.json", "data/MED/workouts.json", "workout-plans/activities.json"]) {
      store.put(logical, "{}", { source: "test" });
    }
  };
  const left = () => store.list("").map((m) => m.path).sort();

  it("are deleted, and only that profile's, once the whole history is stored", async () => {
    putDocs();
    await syncList(store, PROFILE, fakeGarmin(30).source);
    expect(left()).toEqual(["data/MED/training-plan.json", "data/MED/workouts.json", "data/SAM/activities.json", "workout-plans/activities.json"]);
  });

  it("stay while the history is only partly stored, and can be restored from the trash", async () => {
    putDocs();
    const garmin = fakeGarmin(250);
    const flaky: ActivitySource = { ...garmin.source, listPage: async (offset, limit) => { if (offset >= 100) throw new Error("network down"); return garmin.source.listPage(offset, limit); } };
    await expect(syncList(store, PROFILE, flaky)).rejects.toThrow();
    expect(left()).toContain("data/MED/activities.json");

    await syncList(store, PROFILE, garmin.source);
    expect(left()).not.toContain("data/MED/activities.json");
    expect(store.deleted().map((d) => d.path).sort()).toEqual(["data/MED/activities-50.tmp.json", "data/MED/activities-raw.json", "data/MED/activities.json"]);
    store.put("data/MED/activities.json", "{}", { create: true, source: "restore" });
    await syncList(store, PROFILE, garmin.source);
    expect(store.head("data/MED/activities.json")).toBeDefined(); // deleted once, not on every sync
  });
});

describe("fetching details", () => {
  const filled = async (garmin: ReturnType<typeof fakeGarmin>) => {
    await syncList(store, PROFILE, garmin.source);
    garmin.calls.list.length = 0;
  };

  it("fetches the details of every activity that lacks them, newest first, once", async () => {
    const garmin = fakeGarmin(5);
    await filled(garmin);
    const result = await syncDetails(store, PROFILE, garmin.source, { sleep: noSleep });
    expect(result).toEqual({ fetched: 5, failed: 0, stopped: null });
    expect(garmin.calls.detail).toEqual(["1005", "1004", "1003", "1002", "1001"]);
    expect(store.activities.get(PROFILE, "1002")!.detail).toEqual(expect.objectContaining({ fullExerciseSets: [{ setType: "ACTIVE" }] })); // a strength workout
    expect(store.activities.get(PROFILE, "1003")!.detail.fullExerciseSets).toBeUndefined(); // a run

    garmin.calls.detail.length = 0;
    await syncDetails(store, PROFILE, garmin.source, { sleep: noSleep }); // fetched long after they started: final, not asked again
    expect(garmin.calls.detail).toEqual([]);
  });

  it("fetches a young activity's details again later, and not an old one's", async () => {
    const garmin = fakeGarmin(2);
    await filled(garmin);
    await syncDetails(store, PROFILE, garmin.source, { sleep: noSleep });
    // pretend both were fetched a minute after they started, then a few days passed
    for (const id of ["1001", "1002"]) store.activities.setDetail(PROFILE, id, { early: true }, Date.parse(store.activities.get(PROFILE, id)!.startGmt.replace(" ", "T") + "Z") + 60_000);
    garmin.calls.detail.length = 0;
    await syncDetails(store, PROFILE, garmin.source, { sleep: noSleep });
    expect(garmin.calls.detail.sort()).toEqual(["1001", "1002"]);
    garmin.calls.detail.length = 0;
    await syncDetails(store, PROFILE, garmin.source, { sleep: noSleep });
    expect(garmin.calls.detail).toEqual([]); // fetched after the settling time: final
  });

  it("leaves a failing activity for later and goes on, giving up after a few tries", async () => {
    const garmin = fakeGarmin(3, { failDetail: (id) => (id === "1002" ? new Error("ERROR: (404), Not Found") : null) });
    await filled(garmin);
    expect(await syncDetails(store, PROFILE, garmin.source, { sleep: noSleep })).toEqual({ fetched: 2, failed: 1, stopped: null });
    for (let i = 1; i < MAX_DETAIL_FAILURES; i++) await syncDetails(store, PROFILE, garmin.source, { sleep: noSleep });
    garmin.calls.detail.length = 0;
    await syncDetails(store, PROFILE, garmin.source, { sleep: noSleep });
    expect(garmin.calls.detail).toEqual([]);
    expect(store.activities.get(PROFILE, "1002")!.detail).toBeNull();
  });

  it("stops at a rate limit or a login failure, and says so", async () => {
    const messages = ["ERROR: (429), Too Many Requests, {}", "ERROR: (401), Unauthorized", "Failed to authenticate with Garmin (check the profile credentials)"];
    for (const [i, text] of messages.entries()) {
      const profile = `P${i}`;
      const garmin = fakeGarmin(4, { failDetail: (id) => (id === "1003" ? new Error(text) : null) });
      await syncList(store, profile, garmin.source);
      const result = await syncDetails(store, profile, garmin.source, { sleep: noSleep });
      expect(result).toEqual({ fetched: 1, failed: 0, stopped: text });
      expect(garmin.calls.detail).toEqual(["1004", "1003"]); // nothing after the refusal
      expect(store.activities.state(profile).error).toBe(text);
      expect(store.activities.get(profile, "1003")!.detail).toBeNull(); // and it was not counted as a failure of that activity
      expect(store.activities.needingDetail(profile, { settleMs: SETTLE_MS }).map((a) => a.id)).toEqual(["1003", "1002", "1001"]);
    }
  });

  it("spaces the calls, fetches only some when asked, and never counts empty details as fetched", async () => {
    const garmin = fakeGarmin(4);
    await filled(garmin);
    const gaps: number[] = [];
    await syncDetails(store, PROFILE, garmin.source, { limit: 2, gapMs: 500, sleep: async (ms) => void gaps.push(ms) });
    expect(garmin.calls.detail).toEqual(["1004", "1003"]);
    expect(gaps).toEqual([500]);

    const empty: ActivitySource = { ...garmin.source, fetchDetail: async () => undefined as any };
    expect(await syncDetails(store, PROFILE, empty, { ids: ["1001"], sleep: noSleep })).toEqual({ fetched: 0, failed: 1, stopped: null });
    expect(store.activities.get(PROFILE, "1001")!.detail).toBeNull();
  });
});

describe("the background sync", () => {
  it("stores the history and every activity's details, then reports it complete", async () => {
    const garmin = fakeGarmin(120);
    const job = startBackfill(store, PROFILE, garmin.source, { holder: "mcp:1", sleep: noSleep });
    expect(job.started).toBe(true);
    expect(isBackfilling(store, PROFILE)).toBe(true);
    expect(startBackfill(store, PROFILE, garmin.source, { holder: "mcp:1" })).toEqual(expect.objectContaining({ started: false, reason: expect.stringMatching(/already running/) }));
    await job.done;
    expect(isBackfilling(store, PROFILE)).toBe(false);
    expect(syncStatus(store, PROFILE)).toEqual(expect.objectContaining({ activities: 120, withDetails: 120, historyComplete: true, syncing: false, error: null }));
    expect(store.activities.state(PROFILE).holder).toBeNull();
    expect(startBackfill(store, PROFILE, garmin.source, { holder: "mcp:1" })).toEqual(expect.objectContaining({ started: false, reason: "Everything is stored." }));
  });

  it("does not start while another process holds the lease", async () => {
    const garmin = fakeGarmin(5);
    store.activities.claim(PROFILE, "web:2", LEASE_MS);
    expect(startBackfill(store, PROFILE, garmin.source, { holder: "mcp:1" })).toEqual(expect.objectContaining({ started: false, reason: "Another process is syncing." }));
    expect(garmin.calls.list).toEqual([]);
  });

  it("stops on a rate limit, waits before trying again, and picks up where it stopped", async () => {
    const garmin = fakeGarmin(6, { failDetail: (id) => (id === "1003" ? new Error("ERROR: (429), Too Many Requests") : null) });
    const first = startBackfill(store, PROFILE, garmin.source, { holder: "mcp:1", sleep: noSleep, schedule: () => undefined });
    await first.done;
    expect(syncStatus(store, PROFILE)).toEqual(expect.objectContaining({ activities: 6, withDetails: 3, error: expect.stringContaining("429") }));

    const retryAfter = store.activities.state(PROFILE).retryAfter!;
    expect(retryAfter).toBeGreaterThan(Date.now() + COOL_OFF_MS - 5000);
    expect(startBackfill(store, PROFILE, garmin.source, { holder: "mcp:2", now: retryAfter - 1000 })).toEqual(expect.objectContaining({ started: false, reason: expect.stringMatching(/^Waiting after/) }));

    // Garmin allows calls again: one look at the newest page (nothing new), and the details resume.
    const again = fakeGarmin(6);
    const second = startBackfill(store, PROFILE, again.source, { holder: "mcp:3", sleep: noSleep, now: retryAfter + 1 });
    expect(second.started).toBe(true);
    await second.done;
    expect(again.calls.list).toEqual([0]);
    expect(again.calls.detail).toEqual(["1003", "1002", "1001"]);
    expect(syncStatus(store, PROFILE)).toEqual(expect.objectContaining({ withDetails: 6, error: null, pendingDetails: 0 }));
    expect(store.activities.state(PROFILE).retryAfter).toBeNull();
  });

  describe("starting again by itself", () => {
    const waitUntilIdle = async () => {
      for (let i = 0; i < 200 && isBackfilling(store, PROFILE); i++) await new Promise((r) => setTimeout(r, 5));
    };

    it("starts again after a rate limit, once the cool-off is over", async () => {
      let limited = true;
      const garmin = fakeGarmin(4, { failDetail: (id) => (limited && id === "1003" ? new Error("ERROR: (429), Too Many Requests") : null) });
      const scheduled: { fn: () => void; ms: number }[] = [];
      await startBackfill(store, PROFILE, garmin.source, { holder: "mcp:1", sleep: noSleep, gapMs: 0, schedule: (fn, ms) => void scheduled.push({ fn, ms }) }).done;
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0].ms).toBeGreaterThan(COOL_OFF_MS);

      limited = false;
      store.activities.saveProgress(PROFILE, { retryAfter: Date.now() - 1 }); // the cool-off has passed
      scheduled[0].fn();
      await waitUntilIdle();
      expect(syncStatus(store, PROFILE)).toEqual(expect.objectContaining({ withDetails: 4, error: null }));
      expect(scheduled).toHaveLength(1); // it finished, so nothing more is scheduled
    });

    it("does not start again by itself after a login failure, which could lock the account", async () => {
      const garmin = fakeGarmin(3, { failDetail: () => new Error("ERROR: (401), Unauthorized") });
      const scheduled: unknown[] = [];
      await startBackfill(store, PROFILE, garmin.source, { holder: "mcp:1", sleep: noSleep, schedule: (fn) => void scheduled.push(fn) }).done;
      expect(store.activities.state(PROFILE).error).toMatch(/401/);
      expect(scheduled).toEqual([]);
    });

    it("gives up after a number of rate limits in a row", async () => {
      const garmin = fakeGarmin(3, { failDetail: () => new Error("ERROR: (429), Too Many Requests") });
      const scheduled: unknown[] = [];
      await startBackfill(store, PROFILE, garmin.source, { holder: "mcp:1", sleep: noSleep, attempt: MAX_RATE_LIMIT_RETRIES, schedule: (fn) => void scheduled.push(fn) }).done;
      expect(scheduled).toEqual([]);
    });

    it("starts again after a rate limit while listing, too", async () => {
      const source: ActivitySource = { listPage: async () => { throw new Error("ERROR: (429), Too Many Requests"); }, fetchDetail: async () => ({}) };
      const scheduled: unknown[] = [];
      await startBackfill(store, PROFILE, source, { holder: "mcp:1", schedule: (fn) => void scheduled.push(fn) }).done;
      expect(scheduled).toHaveLength(1);
    });
  });

  it("excludes two operations that overlap, even when they run in one process", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = withLease(store, PROFILE, "proc:1", async () => {
      await gate;
      return 1;
    });
    expect(await withLease(store, PROFILE, "proc:2", async () => 2)).toEqual({ ok: false });
    expect(startBackfill(store, PROFILE, fakeGarmin(3).source, { holder: "proc:3" })).toEqual(expect.objectContaining({ started: false, reason: "Another process is syncing." }));
    release();
    expect(await first).toEqual({ ok: true, value: 1 });
    expect(store.activities.state(PROFILE).holder).toBeNull();
  });

  it("clears an old error as soon as a listing gets through, but keeps the background sync waiting out its cool-off", async () => {
    const garmin = fakeGarmin(4);
    await syncList(store, PROFILE, garmin.source);
    store.activities.saveProgress(PROFILE, { error: "ERROR: (429), Too Many Requests", retryAfter: Date.now() + COOL_OFF_MS });
    await syncList(store, PROFILE, garmin.source);
    expect(store.activities.state(PROFILE).error).toBeNull();
    expect(startBackfill(store, PROFILE, garmin.source, { holder: "mcp:1" })).toEqual(expect.objectContaining({ started: false, reason: expect.stringMatching(/^Waiting after/) }));
  });

  it("records a failure of the listing and lets go of the lease", async () => {
    const source: ActivitySource = { listPage: async () => { throw new Error("network down"); }, fetchDetail: async () => ({}) };
    const job = startBackfill(store, PROFILE, source, { holder: "mcp:1" });
    await job.done;
    expect(store.activities.state(PROFILE)).toEqual(expect.objectContaining({ error: "network down", holder: null, complete: false, retryAfter: expect.any(Number) }));
  });
});
