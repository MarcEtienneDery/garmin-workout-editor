import { type SqliteStore, SqliteStore as Store, WELLNESS_KINDS, type WellnessKind } from "../shared/store";
import { FINAL_AFTER_MS, REFRESH_MS, type WellnessSource, localToday, startWellnessBackfill, syncWellness, wanted, wellnessStatus } from "../shared/wellnessSync";

const TODAY = "2026-10-18";
const HOUR = 3_600_000;
const at = (day: string, hour = 0) => Date.parse(`${day}T00:00:00Z`) + hour * HOUR;
const noSleep = async () => {};

let store: SqliteStore;
beforeEach(() => {
  store = Store.open(":memory:");
});
afterEach(() => store.close());

/** Garmin: answers every call with its kind and day, and records the calls. */
function fakeSource(answer: (kind: WellnessKind, day: string) => unknown = (kind, day) => ({ kind, day })) {
  const calls: string[] = [];
  const source: WellnessSource = {
    fetch: async (kind, day) => {
      calls.push(`${kind}|${day}`);
      return answer(kind, day);
    },
  };
  return { source, calls };
}

describe("what is wanted", () => {
  it("is every kind of every day when nothing is stored: the kinds a daily check reads first, the newest day first", () => {
    const list = wanted(store, "MED", TODAY, 3, undefined, at(TODAY, 9));
    expect(list).toHaveLength(3 * WELLNESS_KINDS.length);
    expect(list.slice(0, 4)).toEqual([
      { day: TODAY, kind: "summary" }, { day: "2026-10-17", kind: "summary" }, { day: "2026-10-16", kind: "summary" }, { day: TODAY, kind: "sleep" },
    ]);
    expect(wanted(store, "MED", TODAY, 3, ["hrv"], at(TODAY, 9)).map((w) => w.kind)).toEqual(["hrv", "hrv", "hrv"]);
  });

  it("leaves out what is stored, and an old answer is final even when it is empty", () => {
    store.wellness.put("MED", "2026-10-10", "sleep", null, at(TODAY, 9)); // fetched 8 days after its day
    store.wellness.put("MED", "2026-10-10", "hrv", { hrvSummary: {} }, at(TODAY, 9));
    const list = wanted(store, "MED", TODAY, 10, ["sleep", "hrv"], at(TODAY, 20));
    expect(list.find((w) => w.day === "2026-10-10")).toBeUndefined();
    expect(list).toHaveLength(2 * 10 - 2);
  });

  it("asks again for a response fetched while its day could still change, but not within the refresh time", () => {
    store.wellness.put("MED", TODAY, "sleep", { early: true }, at(TODAY, 6)); // fetched on its own day
    store.wellness.put("MED", "2026-10-17", "sleep", { early: true }, at("2026-10-17", 20)); // 20 h after its day began: not final yet
    const soon = wanted(store, "MED", TODAY, 2, ["sleep"], at(TODAY, 6) + REFRESH_MS - 1);
    expect(soon.map((w) => w.day)).toEqual(["2026-10-17"]); // today's was fetched just now
    const later = wanted(store, "MED", TODAY, 2, ["sleep"], at(TODAY, 6) + REFRESH_MS + 1);
    expect(later.map((w) => w.day)).toEqual([TODAY, "2026-10-17"]);
  });

  it("treats a response fetched a couple of days after its day as final, however long ago the sync last ran", () => {
    store.wellness.put("MED", "2026-10-14", "sleep", { whole: true }, at("2026-10-14") + FINAL_AFTER_MS + 1);
    expect(wanted(store, "MED", TODAY, 7, ["sleep"], at(TODAY, 12)).some((w) => w.day === "2026-10-14")).toBe(false);
    store.wellness.put("MED", "2026-10-13", "sleep", { partial: true }, at("2026-10-13", 23)); // fetched before the day was over and settled
    expect(wanted(store, "MED", TODAY, 7, ["sleep"], at(TODAY, 12)).some((w) => w.day === "2026-10-13")).toBe(true);
  });

  it("fetches a response that may still change again after the stale time it is given, not only after the usual half hour", () => {
    store.wellness.put("MED", TODAY, "summary", {}, at(TODAY, 9));
    const now = at(TODAY, 9) + 5 * 60_000;
    expect(wanted(store, "MED", TODAY, 1, ["summary"], now)).toEqual([]);
    expect(wanted(store, "MED", TODAY, 1, ["summary"], now, 60_000)).toEqual([{ day: TODAY, kind: "summary" }]);
    expect(wanted(store, "MED", TODAY, 1, ["summary"], at(TODAY, 9) + 30_000, 60_000)).toEqual([]); // fetched a moment ago
  });
});

describe("syncing", () => {
  it("stores every response as Garmin sent it", async () => {
    const { source, calls } = fakeSource();
    const result = await syncWellness(store, "MED", source, { today: TODAY, days: 2, kinds: ["sleep", "hrv"], sleep: noSleep, now: at(TODAY, 9) });
    expect(result).toEqual({ fetched: 4, failed: 0, stopped: null });
    expect(calls).toEqual([`sleep|${TODAY}`, "sleep|2026-10-17", `hrv|${TODAY}`, "hrv|2026-10-17"]);
    expect(store.wellness.get("MED", TODAY, "hrv")!.data).toEqual({ kind: "hrv", day: TODAY });
  });

  it("stores an empty answer, and a 404 or a 400 as nothing for the day", async () => {
    const { source } = fakeSource((kind) => {
      if (kind === "spo2") throw new Error("Request failed with status code (404)");
      if (kind === "respiration") throw new Error("Bad Request (400)");
      return kind === "stress" ? "" : [];
    });
    const result = await syncWellness(store, "MED", source, { today: TODAY, days: 1, kinds: ["stress", "body_battery", "spo2", "respiration"], sleep: noSleep });
    expect(result).toEqual({ fetched: 4, failed: 0, stopped: null });
    expect(store.wellness.get("MED", TODAY, "stress")!.data).toBe("");
    expect(store.wellness.get("MED", TODAY, "body_battery")!.data).toEqual([]);
    expect(store.wellness.get("MED", TODAY, "spo2")!.data).toBeNull();
    expect(store.wellness.get("MED", TODAY, "respiration")!.data).toBeNull();
  });

  it("does not store a response that failed in another way, and asks again next time", async () => {
    let fail = true;
    const { source } = fakeSource(() => {
      if (fail) throw new Error("socket hang up");
      return {};
    });
    expect(await syncWellness(store, "MED", source, { today: TODAY, days: 1, kinds: ["sleep"], sleep: noSleep })).toEqual({ fetched: 0, failed: 1, stopped: null });
    expect(store.wellness.get("MED", TODAY, "sleep")).toBeNull();
    fail = false;
    expect((await syncWellness(store, "MED", source, { today: TODAY, days: 1, kinds: ["sleep"], sleep: noSleep })).fetched).toBe(1);
  });

  it("stops on a rate limit, keeps what it has, and records when to try again", async () => {
    let n = 0;
    const { source } = fakeSource(() => {
      if (++n === 3) throw new Error("Request failed (429) too many requests");
      return {};
    });
    const result = await syncWellness(store, "MED", source, { today: TODAY, days: 5, kinds: ["sleep"], sleep: noSleep });
    expect(result.stopped).toMatch(/429/);
    expect(result.fetched).toBe(2);
    expect(store.wellness.counts("MED").rows).toBe(2);
    const state = store.wellness.state("MED");
    expect(state.error).toMatch(/429/);
    expect(state.retryAfter).toBeGreaterThan(Date.now());
  });

  it("stops on a login failure too", async () => {
    const { source, calls } = fakeSource(() => {
      throw new Error("Authentication failed (401)");
    });
    const result = await syncWellness(store, "MED", source, { today: TODAY, days: 5, kinds: ["sleep"], sleep: noSleep });
    expect(result.stopped).toMatch(/401/);
    expect(calls).toHaveLength(1);
  });

  it("clears an earlier error once Garmin answers again", async () => {
    store.wellness.saveProgress("MED", { error: "too many requests (429)", retryAfter: 1 });
    await syncWellness(store, "MED", fakeSource().source, { today: TODAY, days: 1, kinds: ["sleep"], sleep: noSleep });
    expect(store.wellness.state("MED")).toEqual(expect.objectContaining({ error: null, retryAfter: null }));
  });

  it("honours a limit, and gives up when the lease is lost", async () => {
    const { source, calls } = fakeSource();
    await syncWellness(store, "MED", source, { today: TODAY, days: 5, limit: 2, sleep: noSleep });
    expect(calls).toHaveLength(2);
    await expect(syncWellness(store, "MED", source, { today: TODAY, days: 5, renew: () => false, sleep: noSleep })).rejects.toThrow("took over");
  });

  it("fetches the last days again, and only those, on the next sync", async () => {
    const { source, calls } = fakeSource();
    const first = at(TODAY, 8);
    await syncWellness(store, "MED", source, { today: TODAY, days: 5, kinds: ["sleep"], sleep: noSleep, now: first });
    calls.length = 0;
    await syncWellness(store, "MED", source, { today: TODAY, days: 5, kinds: ["sleep"], sleep: noSleep, now: first + 5 * 60_000 });
    expect(calls).toHaveLength(0); // too soon
    await syncWellness(store, "MED", source, { today: TODAY, days: 5, kinds: ["sleep"], sleep: noSleep, now: first + HOUR });
    expect(calls.sort()).toEqual([`sleep|${TODAY}`, "sleep|2026-10-17"].sort()); // not the days past FINAL_AFTER_MS (the 16th was fetched 56 h after it began)
  });
});

describe("the day it is", () => {
  const saved = { tz: process.env.TZ, garmin: process.env.GARMIN_TZ };
  afterEach(() => {
    if (saved.tz === undefined) delete process.env.TZ; else process.env.TZ = saved.tz;
    if (saved.garmin === undefined) delete process.env.GARMIN_TZ; else process.env.GARMIN_TZ = saved.garmin;
  });

  it("follows the zone when one is set", () => {
    process.env.GARMIN_TZ = "America/Toronto";
    expect(localToday(store, "MED", Date.parse("2026-10-18T02:00:00Z"))).toBe("2026-10-17"); // 22:00 the evening before
    expect(localToday(store, "MED", Date.parse("2026-10-18T12:00:00Z"))).toBe("2026-10-18");
  });

  it("else takes the offset the newest activity shows, else UTC", () => {
    delete process.env.GARMIN_TZ;
    delete process.env.TZ;
    const now = Date.parse("2026-10-18T02:00:00Z");
    expect(localToday(store, "MED", now)).toBe("2026-10-18");
    store.activities.insertNew("MED", [{ id: "1", startGmt: "2026-10-16 13:00:00", startLocal: "2026-10-16 09:00:00", type: "running", name: "Run", duration: 1, distance: 1, avgHr: 1, workoutId: null, raw: {} }]);
    expect(localToday(store, "MED", now)).toBe("2026-10-17");
  });
});

describe("the background sync", () => {
  const options = (extra: object = {}) => ({ holder: "h1", today: TODAY, days: 2, sleep: noSleep, now: at(TODAY, 9), schedule: () => undefined, ...extra });

  it("fills the table in and says what it did", async () => {
    const { source, calls } = fakeSource();
    const run = startWellnessBackfill(store, "MED", source, options());
    expect(run.started).toBe(true);
    expect(startWellnessBackfill(store, "MED", source, options({ holder: "h2" })).reason).toBe("A sync is already running.");
    await run.done;
    expect(calls).toHaveLength(2 * WELLNESS_KINDS.length);
    expect(store.wellness.state("MED").holder).toBeNull(); // the lease is given back
    expect(wellnessStatus(store, "MED", TODAY, at(TODAY, 9) + 60_000)).toEqual(expect.objectContaining({ days: 2, rows: 2 * WELLNESS_KINDS.length, pending: 60 * WELLNESS_KINDS.length - 2 * WELLNESS_KINDS.length, syncing: false }));
    expect(startWellnessBackfill(store, "MED", source, options({ now: at(TODAY, 9) + 60_000 })).reason).toBe("Everything is stored."); // of the 2 days it was asked for
  });

  it("does not start while another process holds the lease, or while Garmin said to wait", () => {
    const { source } = fakeSource();
    store.wellness.claim("MED", "other", 60_000, at(TODAY, 9));
    expect(startWellnessBackfill(store, "MED", source, options()).reason).toBe("Another process is syncing.");
    store.wellness.release("MED", "other");
    store.activities.saveProgress("MED", { error: "too many requests (429)", retryAfter: at(TODAY, 9) + 60_000 }); // the limit is the account's
    expect(startWellnessBackfill(store, "MED", source, options()).reason).toMatch(/Waiting after/);
  });

  it("starts again by itself after a rate limit, never after a login failure", async () => {
    const scheduled: (() => void)[] = [];
    const limited = fakeSource(() => {
      throw new Error("too many requests (429)");
    });
    await startWellnessBackfill(store, "MED", limited.source, options({ schedule: (fn: () => void) => scheduled.push(fn) })).done;
    expect(scheduled).toHaveLength(1);

    const store2 = Store.open(":memory:");
    const denied: (() => void)[] = [];
    await startWellnessBackfill(store2, "MED", fakeSource(() => { throw new Error("Authentication failed (401)"); }).source, options({ schedule: (fn: () => void) => denied.push(fn) })).done;
    expect(denied).toHaveLength(0);
    store2.close();
  });
});
