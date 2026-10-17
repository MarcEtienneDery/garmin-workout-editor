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

describe("chart helpers", () => {
  it("rounds an axis to bounds and ticks a person would write", () => {
    expect(A.niceRange(0, 10, 2)).toEqual({ lo: 0, hi: 10, ticks: [0, 5, 10] });
    expect(A.niceRange(128, 187, 3)).toEqual({ lo: 120, hi: 200, ticks: [120, 140, 160, 180, 200] });
    expect(A.niceRange(3, 3).ticks.length).toBeGreaterThan(1); // a flat series still gets an axis
    expect(A.niceRange(0.12, 0.31, 3).ticks).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("smooths over a window and keeps the gaps as gaps", () => {
    expect(A.smooth([1, 2, 3, 4, 5], 3)).toEqual([1.5, 2, 3, 4, 4.5]);
    expect(A.smooth([1, null, 3], 3)).toEqual([1, null, 3]);
    expect(A.smooth([], 5)).toEqual([]);
  });

  it("finds the range of a series without its spikes", () => {
    const xs = Array.from({ length: 100 }, (_, i) => 300 + i);
    xs[50] = 9999; xs[10] = 1;
    const [lo, hi] = A.trimRange(xs, 5, 95);
    expect(lo).toBeGreaterThan(300);
    expect(hi).toBeLessThan(500);
    expect(A.trimRange([null, null])).toBeNull();
    expect(A.trimRange([5])).toEqual([5, 5]);
  });

  it("finds the sample nearest to a distance, skipping gaps", () => {
    expect(A.nearestIndex([0, 100, 200, 300], 120)).toBe(1);
    expect(A.nearestIndex([0, null, 200, 300], 90)).toBe(0);
    expect(A.nearestIndex([0, null, 200, 300], 1000)).toBe(3);
    expect(A.nearestIndex([], 5)).toBe(-1);
  });

  it("gives each heart-rate zone its share of the time", () => {
    expect(A.zoneShares([50, 850, 900, 0, 0])).toEqual([
      { zone: 1, seconds: 50, pct: 3 }, { zone: 2, seconds: 850, pct: 47 }, { zone: 3, seconds: 900, pct: 50 }, { zone: 4, seconds: 0, pct: 0 }, { zone: 5, seconds: 0, pct: 0 },
    ]);
    expect(A.zoneShares([0, 0, 0, 0, 0]).every((z: any) => z.pct === 0)).toBe(true);
    expect(A.zoneShares(null)).toEqual([]);
  });

  it("writes an exercise's sets as runs of identical sets, and a run as short text", () => {
    const text = (x: any) => A.setRuns(x).map(A.runText);
    expect(text({ sets: 3, reps: 6, weight: 40 })).toEqual(["3 × 6 @ 40 lb"]);
    expect(text({ sets: 1, reps: 12, weight: 135 })).toEqual(["12 @ 135 lb"]);
    // reps Garmin did not count are 0: the set still shows, by its weight
    expect(text({ sets: 4, repsList: [0, 0, 6, 0], weightList: [135, 175, 200, 200] })).toEqual(["135 lb", "175 lb", "6 @ 200 lb", "200 lb"]);
    expect(text({ sets: 3, repsList: [12, 12, 11], weight: 60 })).toEqual(["2 × 12 @ 60 lb", "11 @ 60 lb"]);
    expect(text({ sets: 3, repsList: [30, 30, 30] })).toEqual(["3 × 30"]);
    expect(text({ sets: 1 })).toEqual([""]); // cardio: nothing counted
    expect(text({ sets: 2, reps: 8, weight: 22.5 })).toEqual(["2 × 8 @ 22.5 lb"]);
    expect(A.setRuns(undefined)).toEqual([{ count: 1, reps: 0, weight: 0 }]);
    expect(A.setRuns({ sets: 4, repsList: [0, 0, 6, 0], weightList: [135, 175, 200, 200] }).reduce((a: number, r: any) => a + r.count, 0)).toBe(4);
  });

  it("gives each exercise's sets as % of the 1RM the server gives it, and leaves out what has none", () => {
    const lifts = [
      { exerciseName: "Barbell Bench Press", category: "BENCH_PRESS", sets: 4, repsList: [0, 0, 6, 0], weightList: [135, 175, 200, 200] },
      { exerciseName: "Weighted Chin Up", category: "PULL_UP", sets: 3, reps: 6, weight: 40 },
      { exerciseName: "Plank", category: "CORE", sets: 3, repsList: [30, 30, 30] }, // no weight
      { exerciseName: "Cardio", category: "CARDIO", sets: 1 },
      { exerciseName: "Interval 1", category: "INTERVAL", sets: 1, reps: 0, weight: 50 },
      { exerciseName: "Face Pull", category: "ROW", sets: 2, repsList: [0, 0], weight: 50 }, // loaded, but the server has no max for it
    ];
    const maxes = {
      "Barbell Bench Press": { oneRm: 266, source: "benchmark", weight: null, reps: null, date: null },
      "Weighted Chin Up": { oneRm: 48, source: "history", weight: 40, reps: 6, date: "2026-10-12" },
      Plank: { oneRm: 100, source: "history", weight: 1, reps: 1, date: "2026-10-12" }, // a max, but no loaded set
    };
    const out = A.intensity(lifts, maxes);
    expect(out.map((e: any) => e.name)).toEqual(["Barbell Bench Press", "Weighted Chin Up"]);
    expect(out[0]).toEqual({
      name: "Barbell Bench Press", oneRm: 266, source: "benchmark", from: null,
      runs: [{ count: 1, weight: 135, pct: 51, band: 0 }, { count: 1, weight: 175, pct: 66, band: 1 }, { count: 2, weight: 200, pct: 75, band: 1 }],
    });
    expect(out[1]).toEqual({ name: "Weighted Chin Up", oneRm: 48, source: "history", from: { weight: 40, reps: 6, date: "2026-10-12" }, runs: [{ count: 3, weight: 40, pct: 83, band: 2 }] });
    expect(A.intensity(undefined, undefined)).toEqual([]);
    expect(A.intensity(lifts, {})).toEqual([]); // nothing to go by
  });

  it("combines an exercise that appears twice, and shows a set above its max as over 100%", () => {
    const out = A.intensity([
      { exerciseName: "Barbell Back Squat", category: "SQUAT", sets: 1, reps: 5, weight: 300 },
      { exerciseName: "Row", category: "ROW", sets: 1, reps: 10, weight: 100 },
      { exerciseName: "Barbell Back Squat", category: "SQUAT", sets: 1, reps: 3, weight: 320 },
    ], { "Barbell Back Squat": { oneRm: 306, source: "benchmark" }, Row: { oneRm: 133, source: "history", weight: 100, reps: 10, date: "2026-10-01" } });
    expect(out.map((e: any) => e.name)).toEqual(["Barbell Back Squat", "Row"]);
    expect(out[0].runs).toEqual([{ count: 1, weight: 300, pct: 98, band: 3 }, { count: 1, weight: 320, pct: 105, band: 3 }]);
    expect(A.intensityBand(64)).toBe(0);
    expect(A.intensityBand(65)).toBe(1);
    expect(A.intensityBand(80)).toBe(2);
    expect(A.intensityBand(90)).toBe(3);
  });

  it("compares what was planned with what was done, and skips what the plan did not say", () => {
    expect(A.compare({ seconds: 2700, km: 8 }, { seconds: 2940, km: 8.4 })).toEqual([
      { label: "Time", planned: "45 min", actual: "49 min", delta: 240, pct: 9 },
      { label: "Distance", planned: "8 km", actual: "8.4 km", delta: 0.4, pct: 5 },
    ]);
    expect(A.compare({ seconds: 0, km: 0 }, { seconds: 100, km: 1 })).toEqual([]);
  });

  it("writes seconds for an axis", () => {
    expect(A.axisClock(75)).toBe("1:15");
    expect(A.axisClock(3725)).toBe("1:02:05");
  });
});

describe("route and series", () => {
  const chart = {
    time: [0, 10, 20, 30, 40], distance: [0, 100, 200, 300, 400],
    route: { lat: [1, 2, 3, 4], lon: [1, 2, 3, 4], distance: [0, 130, 270, 400] as (number | null)[] },
  };

  it("finds the point of the route for a sample by distance, and the sample for a point", () => {
    expect(A.routeIndexFor(chart, 0)).toBe(0);
    expect(A.routeIndexFor(chart, 1)).toBe(1); // 100 m is nearest the 130 m point
    expect(A.routeIndexFor(chart, 4)).toBe(3);
    expect(A.chartIndexFor(chart, 2)).toBe(3); // 270 m is nearest the 300 m sample
    expect(A.chartIndexFor(chart, 0)).toBe(0);
  });

  it("goes by proportion when either side has no distances, and says -1 when there is no route or no series", () => {
    const noDist = { ...chart, route: { ...chart.route, distance: [null, null, null, null] } };
    expect(A.routeIndexFor(noDist, 2)).toBe(2); // half way along
    expect(A.chartIndexFor(noDist, 3)).toBe(4);
    expect(A.routeIndexFor({ ...chart, route: null }, 1)).toBe(-1);
    expect(A.chartIndexFor({ ...chart, time: [] }, 1)).toBe(-1);
    expect(A.routeIndexFor(null, 0)).toBe(-1);
  });
});
