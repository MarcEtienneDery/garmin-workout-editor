export {};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WM = require("../web/public/welcomeModel.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SM = require("../web/public/settingsModel.js");

const NOW = Date.parse("2026-11-04T12:00:00Z");
const DAY = 86_400_000;

describe("an invite code in the page", () => {
  it("is shown as XXXX-XXXX-XXXX as it is typed, whatever was pasted", () => {
    expect(WM.formatCode("abcd")).toBe("ABCD");
    expect(WM.formatCode("abcde")).toBe("ABCD-E");
    expect(WM.formatCode(" abcd efgh-2345 ")).toBe("ABCD-EFGH-2345");
    expect(WM.formatCode("ABCDEFGH2345EXTRA")).toBe("ABCD-EFGH-2345"); // no more than a code has
    expect(WM.formatCode(null)).toBe("");
    expect(WM.normalizeCode("abcd-efgh-2345")).toBe("ABCDEFGH2345");
  });

  it("is read from the address of a link, and put into one", () => {
    expect(WM.inviteFromSearch("?invite=abcd-efgh-2345")).toBe("ABCD-EFGH-2345");
    expect(WM.inviteFromSearch("?x=1&invite=ABCDEFGH2345")).toBe("ABCD-EFGH-2345");
    expect(WM.inviteFromSearch("?invite=")).toBe("");
    expect(WM.inviteFromSearch("")).toBe("");
    expect(WM.inviteFromSearch(undefined)).toBe("");
    expect(WM.inviteLink("https://plans.example.com", "abcdefgh2345")).toBe("https://plans.example.com/?invite=ABCD-EFGH-2345");
    expect(WM.inviteLink("http://localhost:8788/", "ABCD-EFGH-2345")).toBe("http://localhost:8788/?invite=ABCD-EFGH-2345");
    expect(WM.inviteFromSearch(new URL(WM.inviteLink("https://x.y", "abcdefgh2345")).search)).toBe("ABCD-EFGH-2345");
  });

  it("is refused before it is sent when it is empty or short", () => {
    expect(WM.codeProblem("")).toBe("Enter the invite code.");
    expect(WM.codeProblem("--- ")).toBe("Enter the invite code.");
    expect(WM.codeProblem("ABCD-EF")).toBe("The invite code is 12 letters and digits.");
    expect(WM.codeProblem("ABCD-EFGH-2345")).toBe("");
  });
});

describe("the admin's list of invites", () => {
  const invite = (over: object = {}) => ({ code: "ABCDEFGH2345", note: "", maxUses: 3, uses: 1, expiresAt: NOW + 6 * DAY, status: "active", joined: ["sam"], ...over });

  it("says how an invite stands in a label and a line", () => {
    expect(WM.inviteState(invite(), NOW)).toEqual({ label: "Active", cls: "ok", line: "1 of 3 used · 6 days left · sam" });
    expect(WM.inviteState(invite({ expiresAt: null, joined: [], uses: 0 }), NOW)).toEqual({ label: "Active", cls: "ok", line: "0 of 3 used · never expires" });
    expect(WM.inviteState(invite({ status: "used", uses: 3, joined: ["a", "b", "c"] }), NOW)).toEqual({ label: "Used up", cls: "", line: "3 of 3 used · a, b, c" });
    expect(WM.inviteState(invite({ status: "expired" }), NOW).label).toBe("Expired");
    expect(WM.inviteState(invite({ status: "revoked" }), NOW)).toEqual({ label: "Cancelled", cls: "err", line: "1 of 3 used · sam" });
  });

  it("counts what is left in the unit that reads best", () => {
    expect(WM.left(NOW + DAY, NOW)).toBe("1 day");
    expect(WM.left(NOW + 5 * 3_600_000, NOW)).toBe("5 hours");
    expect(WM.left(NOW + 3_600_000, NOW)).toBe("1 hour");
    expect(WM.left(NOW + 20 * 60_000, NOW)).toBe("20 minutes");
    expect(WM.left(NOW + 1000, NOW)).toBe("1 minute");
    expect(WM.left(NOW, NOW)).toBe("");
  });

  it("offers a week by default and a way to never expire", () => {
    expect(WM.EXPIRY_CHOICES.map((c: any) => c.days)).toEqual([1, 7, 30, null]);
    expect(WM.isActive(invite())).toBe(true);
    expect(WM.isActive(invite({ status: "expired" }))).toBe(false);
  });
});

describe("the welcome flow", () => {
  it("takes a profile through welcome, goals, Garmin and the start", () => {
    expect(WM.welcomeSteps()).toEqual(["welcome", "goals", "garmin", "start"]);
    expect(WM.welcomeSteps({ garmin: true })).toEqual(["welcome", "goals", "garmin", "start"]);
  });

  it("leaves Garmin out when it cannot be connected", () => {
    expect(WM.welcomeSteps({ garmin: false })).toEqual(["welcome", "goals", "start"]);
  });

  it("sets the goals through the same check as Settings: nothing typed sets nothing", () => {
    expect(SM.goalsPatch({}, WM.GOAL_FIELDS, {})).toEqual({ goals: {} });
    expect(SM.goalsPatch({ kcal: "2,200", proteinG: "120" }, WM.GOAL_FIELDS, {})).toEqual({ goals: { kcal: 2200, proteinG: 120 } });
    expect(SM.goalsPatch({ kcal: "lots" }, WM.GOAL_FIELDS, {}).error).toMatch(/Calories must be a number/);
  });

  it("lets the profile start on food, plans or today", () => {
    expect(WM.STARTS.map((s: any) => s.view)).toEqual(["food", "plans", "today"]);
  });
});
