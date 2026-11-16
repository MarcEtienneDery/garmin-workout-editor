export {}; // a module of its own: the helpers below must not clash with those of the other model tests
/** planModel.js lays a plan out day by day and says which workouts a Garmin action takes and what its button reads. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require("../web/public/planModel.js");

const w = (name: string, type: string, dates: unknown, extra: Record<string, unknown> = {}) => ({ workoutName: name, workoutType: type, scheduledDate: dates, ...extra });
const measure = (x: any) => ({ meters: x.workoutType === "running" ? 10_000 : 0, seconds: 3000, sets: x.workoutType === "strength_training" ? 16 : 0 });

describe("dates", () => {
  it("knows a real day from a text shaped like one", () => {
    expect(["2026-11-09", "2024-02-29"].every(P.isDay)).toBe(true);
    expect(["2026-02-30", "2026-11-9", "", null, 20261109].some(P.isDay)).toBe(false);
  });
  it("finds the Monday of a week, across a month and a year", () => {
    expect(P.mondayOf("2026-11-15")).toBe("2026-11-09"); // a Sunday
    expect(P.mondayOf("2026-11-09")).toBe("2026-11-09");
    expect(P.mondayOf("2026-01-01")).toBe("2025-12-29");
  });
  it("takes a workout's valid days once each in order, and names the values that are not days", () => {
    const x = w("a", "running", ["2026-11-11", "2026-11-09", "2026-11-11", "2026-12-2", 5]);
    expect(P.datesOf(x)).toEqual(["2026-11-09", "2026-11-11"]);
    expect(P.badDatesOf(x)).toEqual(["2026-12-2", 5]);
    expect(P.datesOf(w("b", "running", "2026-11-12"))).toEqual(["2026-11-12"]);
    expect(P.datesOf(w("c", "running", undefined))).toEqual([]);
  });
});

describe("the plan day by day", () => {
  const list = [
    w("Upper", "strength_training", ["2026-11-09", "2026-11-16"]),
    w("Easy", "running", ["2026-11-10", "2026-11-17", "2026-11-26"]),
    w("Tempo", "running", ["2026-11-10"]),
    w("Loose", "running", undefined),
    w("Wrong", "running", ["2026-12-2"]),
  ];
  const grid = P.scheduleGrid(list, { measure, today: "2026-11-17" });

  it("runs one row per week from the first day's week to the last, empty weeks included, each Monday to Sunday", () => {
    expect(grid.weeks.map((x: any) => x.monday)).toEqual(["2026-11-09", "2026-11-16", "2026-11-23"]);
    expect(grid.weeks[0].days.map((d: any) => d.date)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
    expect(grid.weeks.map((x: any) => x.n)).toEqual([1, 2, 3]);
  });
  it("puts what is on each day in its cell, more than one workout on a day, and marks today", () => {
    expect(grid.weeks[0].days[1].items.map((i: any) => [i.index, i.kind])).toEqual([[1, "run"], [2, "run"]]);
    expect(grid.weeks[0].days[0].items).toEqual([{ index: 0, kind: "strength" }]);
    expect(grid.weeks[1].days[1].today).toBe(true);
    expect(grid.weeks[0].days.some((d: any) => d.today)).toBe(false);
  });
  it("adds up each week and the plan: sessions, run distance, time and lifting sets", () => {
    expect(grid.weeks[0]).toMatchObject({ sessions: 3, meters: 20_000, seconds: 9000, sets: 16 });
    expect(grid.totals).toMatchObject({ sessions: 6, meters: 40_000, seconds: 18_000, sets: 32, runs: 4, lifts: 2 });
  });
  it("lists the workouts with no valid day apart, and the values that are not days", () => {
    expect(grid.undated).toEqual([3, 4]);
    expect(grid.bad).toEqual([{ index: 4, value: "2026-12-2" }]);
    expect(grid.first).toBe("2026-11-09");
    expect(grid.last).toBe("2026-11-26");
  });
  it("is empty when nothing is scheduled", () => {
    expect(P.scheduleGrid([w("a", "running", undefined)], { measure }).weeks).toEqual([]);
    expect(P.scheduleGrid([], {}).totals.sessions).toBe(0);
  });
  it("words distances and times", () => {
    expect([P.kmText(850), P.kmText(10_400), P.kmText(186_000)]).toEqual(["850 m", "10.4 km", "186 km"]);
    expect([P.timeText(2400), P.timeText(5100), P.timeText(78_000)]).toEqual(["40 min", "1 h 25", "21 h 40"]);
  });
});

describe("which workouts an action takes", () => {
  const list = [
    w("synced", "running", ["2026-11-10"], { workoutId: 1 }),
    w("differs", "running", ["2026-11-11", "2026-11-18"], { workoutId: 2 }),
    w("missing", "strength_training", ["2026-11-12"], { workoutId: 3, sendToDevice: true }),
    w("new", "running", ["2026-11-13"]),
    w("new undated", "running", undefined),
  ];
  const states = ["synced", "modified", "missing", "not-uploaded", "not-uploaded"];
  const stateOf = (i: number) => states[i];

  it("starts an upload with only what needs it: not on Garmin, differing, gone, or not told", () => {
    expect(P.defaultPick("upload", list, stateOf)).toEqual([1, 2, 3, 4]);
    expect(P.defaultPick("upload_schedule", list, stateOf)).toEqual([1, 2, 3, 4]);
    expect(P.defaultPick("upload", list, () => undefined)).toEqual([0, 1, 2, 3, 4]); // still checking: all, none is ruled out
    expect(P.defaultPick("upload", list.slice(0, 1), () => "synced")).toEqual([]);
    expect(P.needsUpload(list[0], "synced")).toBe(false);
    expect(P.needsUpload(w("x", "running", [], {}), "synced")).toBe(true); // no workoutId: never on Garmin
  });
  it("starts a schedule with the workouts that have an id and a day, and a send with those flagged (else every one on Garmin)", () => {
    expect(P.defaultPick("schedule", list, stateOf)).toEqual([0, 1, 2]);
    expect(P.defaultPick("send", list, stateOf)).toEqual([2]);
    expect(P.defaultPick("send", list.map((x) => ({ ...x, sendToDevice: undefined })), stateOf)).toEqual([0, 1, 2]);
  });
  it("words the confirming button with the action and the count, and counts days for a schedule", () => {
    expect(P.describe("upload", list, [1, 2, 3], stateOf).verb).toBe("Upload 3 workouts");
    expect(P.describe("upload", list, [1], stateOf).verb).toBe("Upload 1 workout");
    expect(P.describe("upload_schedule", list, [1, 3], stateOf).verb).toBe("Upload and schedule 2 workouts");
    expect(P.describe("schedule", list, [0, 1], stateOf).verb).toBe("Schedule 3 days");
    expect(P.describe("send", list, [2], stateOf).verb).toBe("Send 1 workout to the watch");
  });
  it("says what happens to each workout, and warns that those with an id are deleted and recreated", () => {
    const d = P.describe("upload", list, [0, 1, 3], stateOf);
    expect(d.rows[1]).toMatchObject({ on: true, warn: true, note: "Replaces the copy on Garmin (id 2): deleted and recreated" });
    expect(d.rows[0].note).toBe("Up to date on Garmin · will be replaced (id 1)");
    expect(P.describe("upload", list, [1], stateOf).rows[0].note).toBe("Up to date on Garmin · left alone");
    expect(d.rows[3].note).toBe("New on Garmin");
    expect(P.describe("upload", list, [2], stateOf).rows[2].note).toBe("Garmin has no workout 3: created again");
    expect(d.warnings[0]).toMatch(/2 of the 3 chosen have one/);
    expect(P.describe("upload", list, [3], stateOf).warnings).toEqual([]);
  });
  it("disables the button for nothing chosen, and for a schedule or a send with nothing it can use", () => {
    expect(P.describe("upload", list, [], stateOf)).toMatchObject({ disabled: true, count: 0 });
    expect(P.describe("schedule", list, [3, 4], stateOf).disabled).toBe(true); // no ids
    expect(P.describe("send", list, [3], stateOf).disabled).toBe(true);
    expect(P.describe("upload", list, [3], stateOf).disabled).toBe(false);
    expect(P.describe("schedule", list, [0], stateOf).disabled).toBe(false);
  });
  it("warns of a workout a schedule skips (no id) or has nothing to put on the calendar", () => {
    expect(P.rowNote("schedule", list[3], "not-uploaded", true)).toMatchObject({ warn: true });
    expect(P.rowNote("schedule", list[1], "modified", true).note).toBe("2 days: 2026-11-11, 2026-11-18");
    expect(P.rowNote("schedule", w("x", "running", undefined, { workoutId: 9 }), "synced", true).warn).toBe(true);
  });
  it("sends no indexes when every workout is taken, else the places in order, and knows the default choice", () => {
    expect(P.indexesFor([0, 1, 2, 3, 4], 5)).toBeUndefined();
    expect(P.indexesFor([3, 1, 1], 5)).toEqual([1, 3]);
    expect(P.samePick([2, 1], [1, 2, 2])).toBe(true);
    expect(P.samePick([1], [1, 2])).toBe(false);
    expect(P.onlyLabel(3)).toBe("Only what needs it (3)");
  });
});
