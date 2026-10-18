import { DEFAULT_SETTINGS, KEEP_LOG, SqliteStore } from "../shared/store";

let store: SqliteStore;
beforeEach(() => {
  store = SqliteStore.open(":memory:");
});
afterEach(() => store.close());

const m = (id: string, at: number, extra: Record<string, unknown> = {}) => ({ id, measuredAt: at, day: new Date(at).toISOString().slice(0, 10), data: { id, weight: 80, timeStamp: at / 1000, ...extra } });

describe("the Renpho settings", () => {
  it("start switched off, and change one field at a time", () => {
    expect(store.renpho.settings("MED")).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ areaCode: "US", fetchEnabled: false, pushEnabled: false, pushSince: null, intervalHours: 3 });
    store.renpho.saveSettings("MED", { fetchEnabled: true, areaCode: "CA" });
    store.renpho.saveSettings("MED", { intervalHours: 6 });
    expect(store.renpho.settings("MED")).toEqual({ areaCode: "CA", fetchEnabled: true, pushEnabled: false, pushSince: null, intervalHours: 6 });
    expect(store.renpho.settings("SAM")).toEqual(DEFAULT_SETTINGS);
    store.renpho.saveSettings("SAM", { fetchEnabled: true });
    expect(store.renpho.enabledProfiles()).toEqual(["MED", "SAM"]);
  });
});

describe("the weigh-in ledger", () => {
  it("keeps a weigh-in once, as Renpho sent it, and counts what is uploaded", () => {
    expect(store.renpho.addMeasurement("MED", m("1", 1_000_000))).toBe(true);
    expect(store.renpho.addMeasurement("MED", m("1", 1_000_000, { weight: 99 }))).toBe(false); // what is there is left as it is
    store.renpho.addMeasurement("MED", m("2", 2_000_000));
    store.renpho.addMeasurement("MED", m("3", 3_000_000));
    store.renpho.addMeasurement("SAM", m("1", 1_000_000));
    expect(store.renpho.measurements("MED").map((x) => x.id)).toEqual(["3", "2", "1"]);
    expect(store.renpho.measurements("MED", { limit: 1 })[0].data.weight).toBe(80);
    expect(store.renpho.counts("MED")).toEqual({ total: 3, pending: 3, pushed: 0, failed: 0, oldest: 1_000_000, newest: 3_000_000 });
    store.renpho.markPushed("MED", ["1"], 9);
    store.renpho.markFailed("MED", ["2", "1"], "no");
    expect(store.renpho.counts("MED")).toEqual(expect.objectContaining({ pending: 2, pushed: 1, failed: 1 }));
    expect(store.renpho.measurements("MED", { pending: true }).map((x) => x.id)).toEqual(["2", "3"]); // oldest first
    expect(store.renpho.measurements("MED").find((x) => x.id === "1")).toEqual(expect.objectContaining({ pushedAt: 9, pushError: null }));
    expect(store.renpho.measurements("MED").find((x) => x.id === "2")!.pushError).toBe("no");
  });

  it("lists the weigh-ins from a day on, and finds the days uploaded long enough ago to be read back", () => {
    const day = (n: number) => Date.UTC(2026, 0, n) + 3_600_000;
    for (const n of [1, 2, 3]) store.renpho.addMeasurement("MED", m(String(n), day(n)));
    expect(store.renpho.measurements("MED", { pending: true, sinceDay: "2026-01-02" }).map((x) => x.id)).toEqual(["2", "3"]);
    store.renpho.markPushed("MED", ["1", "2"], 1000);
    store.renpho.markPushed("MED", ["3"], 5000);
    expect(store.renpho.daysToReread("MED", 999)).toEqual({ days: [], ids: [] });
    expect(store.renpho.daysToReread("MED", 2000)).toEqual({ days: ["2026-01-01", "2026-01-02"], ids: ["1", "2"] });
    store.renpho.markReread("MED", ["1", "2"]);
    expect(store.renpho.daysToReread("MED", 9999)).toEqual({ days: ["2026-01-03"], ids: ["3"] });
  });

  it("forgets the ledger of a profile only", () => {
    store.renpho.addMeasurement("MED", m("1", 1));
    store.renpho.addMeasurement("SAM", m("1", 1));
    store.renpho.clearMeasurements("MED");
    expect(store.renpho.counts("MED").total).toBe(0);
    expect(store.renpho.counts("SAM").total).toBe(1);
  });
});

describe("the sync's state and lease", () => {
  it("lets one holder at a time sync a profile, and a lease that ran out be taken over", () => {
    expect(store.renpho.claim("MED", "a", 1000, 0)).toBe(true);
    expect(store.renpho.claim("MED", "b", 1000, 500)).toBe(false);
    expect(store.renpho.claim("MED", "a", 1000, 500)).toBe(true);
    expect(store.renpho.claim("MED", "b", 1000, 5000)).toBe(true);
    store.renpho.release("MED", "a"); // not the holder any more: nothing changes
    expect(store.renpho.state("MED").holder).toBe("b");
    store.renpho.release("MED", "b");
    expect(store.renpho.state("MED").holder).toBeNull();
  });

  it("keeps how the last run went, changing only the fields given", () => {
    expect(store.renpho.state("MED")).toEqual({ holder: null, leaseUntil: null, lastRunAt: null, lastOkAt: null, nextRunAt: null, error: null, errorKind: null });
    store.renpho.saveState("MED", { lastRunAt: 5, lastOkAt: 5, nextRunAt: 50 });
    store.renpho.saveState("MED", { error: "bad", errorKind: "login", nextRunAt: null });
    expect(store.renpho.state("MED")).toEqual(expect.objectContaining({ lastRunAt: 5, lastOkAt: 5, nextRunAt: null, error: "bad", errorKind: "login" }));
  });
});

describe("the log", () => {
  it("lists the newest line first and keeps the last 200 of each profile", () => {
    for (let i = 1; i <= KEEP_LOG + 25; i++) store.renpho.log("MED", i % 50 === 0 ? "error" : "info", `line ${i}`, i);
    store.renpho.log("SAM", "warn", "other", 1);
    const lines = store.renpho.logLines("MED", 1000);
    expect(lines).toHaveLength(KEEP_LOG);
    expect(lines[0]).toEqual(expect.objectContaining({ message: `line ${KEEP_LOG + 25}`, level: "info" }));
    expect(lines[lines.length - 1].message).toBe("line 26");
    expect(store.renpho.logLines("SAM")).toHaveLength(1);
    expect(store.renpho.logLines("MED", 3)).toHaveLength(3);
    store.renpho.log("MED", "info", "x".repeat(900));
    expect(store.renpho.logLines("MED", 1)[0].message).toHaveLength(500);
    store.renpho.clearLog("MED");
    expect(store.renpho.logLines("MED")).toEqual([]);
  });
});
