export {}; // a module of its own: the helpers below must not clash with those of the other model tests
/**
 * activityModel.js is the plain script behind the Activities view: weeks, totals, filters, formats and the
 * planned-against-done matching.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const A = require("../web/public/activityModel.js");

const row = (id: string, date: string, type: string, extra: Record<string, unknown> = {}) => ({ id, date, time: "08:00", type, name: `Activity ${id}`, km: null, seconds: 3600, workoutId: null, ...extra });
const plan = (path: string, workouts: { name: string; type?: string; id?: number; dates: string[] }[]) => ({
  path,
  name: path,
  workouts: workouts.map((w, index) => ({ index, workoutName: w.name, workoutType: w.type, workoutId: w.id, dates: w.dates })),
});

describe("weeks", () => {
  it("puts each day in its Monday-first week, across a month and a year end", () => {
    expect(A.weekOf("2026-10-12")).toBe("2026-10-12"); // a Monday
    expect(A.weekOf("2026-10-18")).toBe("2026-10-12"); // the Sunday
    expect(A.weekOf("2026-10-19")).toBe("2026-10-19");
    expect(A.weekOf("2026-01-01")).toBe("2025-12-29");
    expect(A.weekOf("2024-03-01")).toBe("2024-02-26"); // across a leap day
  });

  it("groups rows into weeks, newest first, each week newest first, with its totals", () => {
    const rows = [
      row("1", "2026-10-13", "running", { km: 10, seconds: 3000 }),
      row("2", "2026-10-20", "strength_training", { seconds: 2700 }),
      row("3", "2026-10-13", "running", { km: 5.04, seconds: 1500, time: "18:00" }),
      row("4", "2026-10-18", "cycling", { km: 30, seconds: 3600 }),
    ];
    const weeks = A.groupWeeks(rows);
    expect(weeks.map((w: any) => w.week)).toEqual(["2026-10-19", "2026-10-12"]);
    expect(weeks[1].rows.map((r: any) => r.id)).toEqual(["4", "3", "1"]); // the Sunday, then the evening run, then the morning run
    expect(weeks[1].totals).toEqual({
      count: 3, km: 45, seconds: 8100,
      bySport: { running: { count: 2, km: 15, seconds: 4500 }, cycling: { count: 1, km: 30, seconds: 3600 } },
    });
  });

  it("lists a day in the order it was lived", () => {
    const days = A.byDate([row("a", "2026-10-13", "running", { time: "18:00" }), row("b", "2026-10-13", "strength_training", { time: "07:00" })]);
    expect(days.get("2026-10-13").map((r: any) => r.id)).toEqual(["b", "a"]);
  });
});

describe("filters", () => {
  const rows = [row("1", "2026-10-13", "running", { name: "Morning Run" }), row("2", "2026-09-01", "strength_training", { name: "Full Body A" }), row("3", "2026-10-01", "cycling", { name: "Commute" })];

  it("counts a range back from today", () => {
    expect(A.rangeStart("4w", "2026-10-15")).toBe("2026-09-17");
    expect(A.rangeStart("12w", "2026-10-15")).toBe("2026-07-23");
    expect(A.rangeStart("1y", "2026-10-15")).toBe("2025-10-15");
    expect(A.rangeStart("all", "2026-10-15")).toBeNull();
  });

  it("filters by type, range and name, each optional", () => {
    expect(A.filterRows(rows).map((r: any) => r.id)).toEqual(["1", "2", "3"]);
    expect(A.filterRows(rows, { types: new Set(["running", "cycling"]) }).map((r: any) => r.id)).toEqual(["1", "3"]);
    expect(A.filterRows(rows, { types: new Set() }).map((r: any) => r.id)).toEqual(["1", "2", "3"]);
    expect(A.filterRows(rows, { from: "2026-09-30" }).map((r: any) => r.id)).toEqual(["1", "3"]);
    expect(A.filterRows(rows, { query: "  body " }).map((r: any) => r.id)).toEqual(["2"]);
  });
});

describe("formats", () => {
  it("writes durations, paces and distances", () => {
    expect(A.duration(3125)).toBe("52 min");
    expect(A.duration(3900)).toBe("1 h 05 min");
    expect(A.duration(45)).toBe("45 s");
    expect(A.duration(null)).toBe("");
    expect(A.pace(337)).toBe("5:37 /km");
    expect(A.pace(299.6)).toBe("5:00 /km");
    expect(A.pace(null)).toBe("");
    expect(A.distance(10.44)).toBe("10.4 km");
    expect(A.distance(0.8)).toBe("800 m");
    expect(A.distance(null)).toBe("");
  });
});

describe("planned against done", () => {
  const today = "2026-10-15";

  it("marks a workout done when an activity carries its id, and the rest by whether the day is past", () => {
    const plans = [plan("a", [{ name: "Long Run", type: "running", id: 11, dates: ["2026-10-10", "2026-10-13", "2026-10-15", "2026-10-20"] }])];
    const rows = [row("1", "2026-10-10", "running", { workoutId: "11" })];
    expect(A.planned(plans, rows, today).map((s: any) => [s.date, s.status, s.activityId])).toEqual([
      ["2026-10-10", "done", "1"],
      ["2026-10-13", "missed", null],
      ["2026-10-15", "today", null],
      ["2026-10-20", "upcoming", null],
    ]);
  });

  it("falls back on the same sport on the same day, because an upload makes a new workoutId", () => {
    const plans = [plan("a", [{ name: "Squat", type: "strength_training", id: 99, dates: ["2026-10-12"] }])];
    const rows = [row("1", "2026-10-12", "strength_training", { workoutId: "5" })]; // done before the workout was re-uploaded
    expect(A.planned(plans, rows, today)[0]).toEqual(expect.objectContaining({ status: "done", activityId: "1" }));
  });

  it("does not count another sport, or another day", () => {
    const plans = [plan("a", [{ name: "Easy run", type: "running", dates: ["2026-10-12"] }])];
    expect(A.planned(plans, [row("1", "2026-10-12", "cycling"), row("2", "2026-10-11", "running")], today)[0].status).toBe("missed");
  });

  it("lets an id match win over a loose one, and answers each session with one activity", () => {
    const plans = [plan("a", [{ name: "Run A", type: "running", id: 1, dates: ["2026-10-12"] }, { name: "Run B", type: "running", id: 2, dates: ["2026-10-12"] }])];
    const rows = [row("x", "2026-10-12", "running", { workoutId: "2" })];
    const [a, b] = A.planned(plans, rows, today);
    expect([a.name, a.status]).toEqual(["Run A", "missed"]); // the one activity answers B, which carries its id
    expect([b.name, b.status, b.activityId]).toEqual(["Run B", "done", "x"]);
    const two = A.planned(plans, [...rows, row("y", "2026-10-12", "running")], today);
    expect(two.map((s: any) => s.status)).toEqual(["done", "done"]);
  });

  it("counts two plans that schedule the same session once, so one activity answers both", () => {
    const plans = [
      plan("hm.json", [{ name: "Full Body A 2.0", type: "strength_training", id: 7, dates: ["2026-09-28"] }]),
      plan("july.json", [{ name: "Full Body A 2.0", type: "strength_training", id: 7, dates: ["2026-09-28"] }]),
      plan("c.json", [{ name: "Full Body A 2.0", type: "strength_training", dates: ["2026-09-29"] }]),
      plan("d.json", [{ name: "full body a 2.0 ", type: "strength_training", dates: ["2026-09-29"] }]),
    ];
    const sessions = A.planned(plans, [row("1", "2026-09-28", "strength_training", { workoutId: "7" })], today);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toEqual(expect.objectContaining({ status: "done", activityId: "1" }));
    expect(sessions[0].plans.map((p: any) => p.path)).toEqual(["hm.json", "july.json"]);
    expect(sessions[1].plans).toHaveLength(2); // the same name on the same day, with no id
  });

  it("treats cardio and unnamed types as 'other', and limits the days looked at", () => {
    expect(A.planSport("cardio")).toBe("other");
    expect(A.planSport(undefined)).toBe("other");
    expect(A.planSport("running")).toBe("running");
    const plans = [plan("a", [{ name: "Stretch", type: "cardio", dates: ["2026-10-01", "2026-10-02", "2026-10-03"] }])];
    expect(A.planned(plans, [row("1", "2026-10-02", "other")], today, { from: "2026-10-02", to: "2026-10-02" }).map((s: any) => [s.date, s.status])).toEqual([["2026-10-02", "done"]]);
  });
});
