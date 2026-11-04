// eslint-disable-next-line @typescript-eslint/no-var-requires
const SA = require("../web/public/syncActivityModel.js");

const AT = new Date(2026, 10, 3, 14, 30).getTime();
const idle = { syncing: [], limit: null };
const limit = (over: any = {}) => ({ since: AT - 600_000, lastAt: AT - 180_000, count: 1, ...over });

describe("the header status", () => {
  it("says nothing when nothing syncs and Garmin is not refusing", () => {
    expect(SA.summary(null)).toBeNull();
    expect(SA.summary({ now: AT, profiles: {} })).toBeNull();
    expect(SA.summary({ now: AT, profiles: { MED: idle } })).toBeNull();
    expect(SA.busy({ now: AT, profiles: { MED: idle } })).toBe(false);
  });

  it("names what is syncing, in the order of the views", () => {
    const pill = SA.summary({ now: AT, profiles: { MED: { syncing: ["renpho", "activities"], limit: null } } });
    expect(pill).toEqual(expect.objectContaining({ kind: "syncing", long: "Syncing activities and weight…", short: "Syncing" }));
    expect(pill.title).not.toMatch(/ for MED/); // one profile: no need to name it
    expect(SA.busy({ now: AT, profiles: { MED: { syncing: ["wellness"], limit: null } } })).toBe(true);
  });

  it("names the profiles when a login sees more than one", () => {
    const pill = SA.summary({ now: AT, profiles: { MED: { syncing: ["wellness"], limit: null }, SAM: { syncing: ["activities"], limit: null }, ZOE: idle } });
    expect(pill.long).toBe("Syncing activities and health data…");
    expect(pill.title).toMatch(/for MED and SAM/);
  });

  it("shows a 429 with when it was last refused, and tells you to leave it alone", () => {
    const pill = SA.summary({ now: AT, profiles: { MED: { syncing: [], limit: limit() } } });
    expect(pill).toEqual(expect.objectContaining({ kind: "limit", short: "429" }));
    expect(pill.long).toMatch(/429/);
    expect(pill.title).toMatch(/HTTP 429, Too Many Requests/);
    expect(pill.title).toMatch(/last 3 min ago/);
    expect(pill.title).toMatch(/can make it last longer/);
  });

  it("counts the refusals once there are several", () => {
    const pill = SA.summary({ now: AT, profiles: { MED: { syncing: [], limit: limit({ count: 7 }) } } });
    expect(pill.title).toMatch(/7 requests refused since/);
  });

  it("puts a 429 before a sync that is running", () => {
    const pill = SA.summary({ now: AT, profiles: { MED: { syncing: ["activities"], limit: limit() } } });
    expect(pill.kind).toBe("limit");
  });

  it("names the profiles that are refused when there are several", () => {
    const pill = SA.summary({ now: AT, profiles: { MED: idle, SAM: { syncing: [], limit: limit() } } });
    expect(pill.title).toMatch(/for SAM/);
  });

  it("writes how long ago in minutes, hours and days", () => {
    expect(SA.ago(AT - 20_000, AT)).toBe("just now");
    expect(SA.ago(AT - 5 * 60_000, AT)).toBe("5 min ago");
    expect(SA.ago(AT - 3 * 3_600_000, AT)).toBe("3 h ago");
    expect(SA.ago(AT - 2 * 86_400_000, AT)).toBe("2 d ago");
  });
});
