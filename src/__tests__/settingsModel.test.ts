// eslint-disable-next-line @typescript-eslint/no-var-requires
const SM = require("../web/public/settingsModel.js");

const NOW = Date.parse("2026-10-18T15:00:00");
const view = (over: any = {}) => ({
  account: { email: "a@b.c", hasPassword: true },
  settings: { fetchEnabled: true, intervalHours: 3 },
  state: { running: false, error: null, errorKind: null, lastOkAt: NOW - 600_000 },
  ...over,
});

describe("times", () => {
  it("says how long ago or from now", () => {
    expect(SM.ago(null, NOW)).toBe("never");
    expect(SM.ago(NOW - 10_000, NOW)).toBe("just now");
    expect(SM.ago(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(SM.ago(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(SM.ago(NOW - 2 * 86_400_000, NOW)).toBe("2 d ago");
    expect(SM.until(null, NOW)).toBe("–");
    expect(SM.until(NOW - 1, NOW)).toBe("due now");
    expect(SM.until(NOW + 90 * 60_000, NOW)).toBe("in 2 h");
    expect(SM.until(NOW + 20 * 60_000, NOW)).toBe("in 20 min");
  });

  it("says a time as a date and minutes", () => {
    expect(SM.stamp(new Date(2026, 9, 18, 7, 5).getTime())).toBe("2026-10-18 07:05");
  });
});

describe("the state of the sync", () => {
  it("is told in a few words, most urgent first", () => {
    expect(SM.renphoStatus(view({ account: null }), NOW)).toEqual({ label: "No login", cls: "" });
    expect(SM.renphoStatus(view({ state: { running: true } }), NOW).label).toBe("Running");
    expect(SM.renphoStatus(view({ state: { errorKind: "login", error: "x", running: false } }), NOW)).toEqual({ label: "Login refused", cls: "err" });
    expect(SM.renphoStatus(view({ state: { errorKind: "other", error: "x", running: false } }), NOW)).toEqual({ label: "Last run failed", cls: "warn" });
    expect(SM.renphoStatus(view({ settings: { fetchEnabled: false } }), NOW)).toEqual({ label: "Off", cls: "" });
    expect(SM.renphoStatus(view(), NOW)).toEqual({ label: "On, every 3 h", cls: "ok" });
    expect(SM.renphoStatus(view({ state: { lastOkAt: null, running: false } }), NOW).label).toBe("On, waiting for the first run");
  });
});

describe("a weigh-in", () => {
  const m = { fields: { weight: 81.7, bodyfat: 17.8456, water: null, muscle: "44.5", bone: undefined, weightUnit: 1 }, pushedAt: null, pushError: null };

  it("reads each number as Renpho sent it, an en dash for what it did not send", () => {
    const by = (key: string) => SM.FIELDS.find((f: any) => f.key === key);
    expect(SM.cell(m, by("weight"))).toBe("81.7");
    expect(SM.cell(m, by("bodyfat"))).toBe("17.85");
    expect(SM.cell(m, by("water"))).toBe("–");
    expect(SM.cell(m, by("muscle"))).toBe("44.5");
    expect(SM.cell(m, by("bone"))).toBe("–");
  });

  it("says where it stands with Garmin", () => {
    expect(SM.uploadState(m)).toEqual({ label: "not uploaded", cls: "" });
    expect(SM.uploadState({ ...m, pushError: "no" })).toEqual({ label: "failed", cls: "err" });
    expect(SM.uploadState({ ...m, pushedAt: 5, pushError: "old" })).toEqual({ label: "on Garmin", cls: "ok" });
  });
});
