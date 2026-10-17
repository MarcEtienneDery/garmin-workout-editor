import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { type LifetimeInput, computeLifetime, lifetimeStats, mondayOf } from "../shared/lifetimeStats";
import { toNewActivity } from "../shared/activitySync";
import { SqliteStore } from "../shared/store";

const row = (id: string, startLocal: string, type: string, extra: Record<string, unknown> = {}) => ({
  id, startLocal, type, name: `Activity ${id}`, distance: null, duration: 3600, gain: null, calories: null, vo2: null, sets: null, reps: null, ...extra,
}) as any;
const input = (over: Partial<LifetimeInput> = {}): LifetimeInput => ({ profile: "MED", rows: [], splits: [], lifts: [], ...over });

describe("weeks", () => {
  it("start on Monday", () => {
    expect(mondayOf("2026-10-12")).toBe("2026-10-12"); // a Monday
    expect(mondayOf("2026-10-18")).toBe("2026-10-12"); // the Sunday after
    expect(mondayOf("2026-10-19")).toBe("2026-10-19");
    expect(mondayOf("2026-01-01")).toBe("2025-12-29"); // across a year
  });
});

describe("the overall numbers", () => {
  it("add up every activity, by type and by year, newest year first", () => {
    const s = computeLifetime(input({
      rows: [
        row("1", "2025-12-31 08:00:00", "running", { distance: 10000, duration: 3000, calories: 600 }),
        row("2", "2026-01-02 08:00:00", "strength_training", { duration: 2400, calories: 300, sets: 12, reps: 100 }),
        row("3", "2026-01-02 18:00:00", "running", { distance: 5000, duration: 1500, calories: 300 }), // the same day: one active day
        row("4", "2026-03-01 08:00:00", "cycling", { distance: 20000, duration: 3600 }),
      ],
    }));
    expect(s).toEqual(expect.objectContaining({ profile: "MED", activities: 4, seconds: 10500, calories: 1200, activeDays: 3, since: "2025-12-31", until: "2026-03-01" }));
    expect(s.byType).toEqual([{ type: "running", count: 2, seconds: 4500, meters: 15000 }, { type: "strength_training", count: 1, seconds: 2400, meters: 0 }, { type: "cycling", count: 1, seconds: 3600, meters: 20000 }]);
    expect(s.years).toEqual([
      { year: "2026", activities: 3, seconds: 7500, runs: 1, runMeters: 5000, lifts: 1, liftSets: 12 },
      { year: "2025", activities: 1, seconds: 3000, runs: 1, runMeters: 10000, lifts: 0, liftSets: 0 },
    ]);
    expect(s.running).not.toBeNull();
    expect(s.strength).not.toBeNull();
  });

  it("are empty for a profile with nothing stored, with no running or strength part", () => {
    expect(computeLifetime(input())).toEqual({ profile: "MED", activities: 0, seconds: 0, calories: 0, activeDays: 0, since: null, until: null, byType: [], running: null, strength: null, years: [] });
    const cycling = computeLifetime(input({ rows: [row("1", "2026-01-01 08:00:00", "cycling")] }));
    expect(cycling.running).toBeNull();
    expect(cycling.strength).toBeNull();
  });

  it("does not depend on the order the rows come in", () => {
    const rows = [row("1", "2026-01-01 08:00:00", "running", { distance: 5000 }), row("2", "2026-02-01 08:00:00", "running", { distance: 6000 })];
    expect(computeLifetime(input({ rows: [...rows].reverse() }))).toEqual(computeLifetime(input({ rows })));
  });
});

describe("running", () => {
  const rows = [
    row("1", "2026-09-07 08:00:00", "running", { distance: 5000, duration: 1500, gain: 20, vo2: 50 }), // Monday of a week
    row("2", "2026-09-09 08:00:00", "running", { distance: 12000, duration: 3720, gain: 150, vo2: 52 }),
    row("3", "2026-09-14 08:00:00", "running", { distance: 8000, duration: 2160, gain: 40, vo2: null }), // 4:30/km, the best pace
    row("4", "2026-09-15 08:00:00", "running", { distance: 1000, duration: 200, gain: 0 }), // too short for a best pace
    row("5", "2026-09-16 08:00:00", "cycling", { distance: 40000, duration: 4000, gain: 500 }), // not a run
  ];
  const splits = [
    { id: "1", meters: 1000, seconds: 290 }, { id: "2", meters: 1000, seconds: 301.25 }, { id: "3", meters: 1000, seconds: 268 },
    { id: "2", meters: 5000, seconds: 1480 }, { id: "3", meters: 5000, seconds: 1400 }, { id: "5", meters: 1000, seconds: 100 }, // a ride is left out
    { id: "9", meters: 1000, seconds: 50 }, // an activity that is not stored
    { id: "1", meters: 1609, seconds: 0 }, // no time
  ];
  const run = () => computeLifetime(input({ rows, splits })).running!;

  it("totals the distance, time and climb of the runs only", () => {
    expect(run()).toEqual(expect.objectContaining({ runs: 4, meters: 26000, seconds: 7580, gain: 210, avgPaceSec: 292 }));
  });

  it("finds the longest run, the best pace over 3 km or more, and the biggest climb", () => {
    expect(run().longest).toEqual({ id: "2", date: "2026-09-09", name: "Activity 2", meters: 12000, seconds: 3720 });
    expect(run().bestPace).toEqual({ id: "3", date: "2026-09-14", name: "Activity 3", meters: 8000, paceSec: 270 });
    expect(run().biggestClimb).toEqual({ id: "2", date: "2026-09-09", name: "Activity 2", gain: 150 });
  });

  it("finds the week and the month with the most distance", () => {
    expect(run().biggestWeek).toEqual({ start: "2026-09-07", meters: 17000, runs: 2 });
    expect(run().biggestMonth).toEqual({ month: "2026-09", meters: 26000, runs: 4 });
  });

  it("keeps the fastest time over each distance, shortest first, from runs only", () => {
    expect(run().efforts).toEqual([
      { id: "3", date: "2026-09-14", name: "Activity 3", meters: 1000, seconds: 268 },
      { id: "3", date: "2026-09-14", name: "Activity 3", meters: 5000, seconds: 1400 },
    ]);
  });

  it("reports the latest and the best VO2max", () => {
    expect(run().vo2max).toEqual({ latest: { value: 52, date: "2026-09-09" }, best: { value: 52, date: "2026-09-09" } });
    const lower = computeLifetime(input({ rows: [row("1", "2026-01-01 08:00:00", "running", { vo2: 54 }), row("2", "2026-02-01 08:00:00", "running", { vo2: 51 })] })).running!;
    expect(lower.vo2max).toEqual({ latest: { value: 51, date: "2026-02-01" }, best: { value: 54, date: "2026-01-01" } });
  });

  it("copes with a run that has no distance, time, or anything else", () => {
    const bare = computeLifetime(input({ rows: [row("1", "2026-01-01 08:00:00", "running", { distance: null, duration: null })] })).running!;
    expect(bare).toEqual(expect.objectContaining({ runs: 1, meters: 0, seconds: 0, avgPaceSec: null, longest: null, bestPace: null, biggestClimb: null, efforts: [] }));
    expect(bare.vo2max).toEqual({ latest: null, best: null });
  });
});

describe("strength", () => {
  const rows = [
    row("1", "2026-09-01 08:00:00", "strength_training", { duration: 3000, sets: 6, reps: 40 }),
    row("2", "2026-09-08 08:00:00", "strength_training", { duration: 3600, sets: 8, reps: 50 }),
    row("3", "2026-09-15 08:00:00", "strength_training", { duration: 1800, sets: 3, reps: 10 }), // details not stored
  ];
  const lifts: LifetimeInput["lifts"] = [
    { id: "1", date: "2026-09-01", sets: [
      { exerciseName: "Barbell Bench Press", category: "BENCH_PRESS", sets: 3, reps: 5, weight: 200, volume: 3000 },
      { exerciseName: "Plank", category: "CORE", sets: 2, repsList: [30, 30] },
      { exerciseName: "Interval 1", category: "INTERVAL", sets: 1, reps: 0 },
    ] },
    { id: "2", date: "2026-09-08", sets: [
      { exerciseName: "Barbell Bench Press", category: "BENCH_PRESS", sets: 4, repsList: [0, 3, 6, 5], weightList: [135, 225, 200, 205] },
      { exerciseName: "Chin Up", category: "PULL_UP", sets: 1, reps: 8, weight: 0 },
    ] },
    { id: "3", date: "2026-09-15", sets: undefined },
  ];
  const lift = () => computeLifetime(input({ rows, lifts })).strength!;

  it("totals the sessions, the time, and the sets and reps of the list items", () => {
    expect(lift()).toEqual(expect.objectContaining({ sessions: 3, seconds: 8400, sets: 17, reps: 100, detailed: 2 }));
  });

  it("totals each exercise over the sessions it was in, busiest first", () => {
    const e = lift().exercises;
    expect(e.map((x) => x.name)).toEqual(["Barbell Bench Press", "Chin Up", "Plank"]); // sessions, then volume
    const bench = e[0];
    expect(bench).toEqual(expect.objectContaining({ sessions: 2, sets: 7, reps: 29, firstDate: "2026-09-01", lastDate: "2026-09-08" }));
    // 3 x 5 x 200 + (0 x 135 + 3 x 225 + 6 x 200 + 5 x 205)
    expect(bench.volume).toBe(3000 + 675 + 1200 + 1025);
    expect(lift().volume).toBe(bench.volume + 0 + 0); // chin up (no weight) and plank add no load
  });

  it("names the best estimated 1RM and the heaviest set of each exercise", () => {
    const bench = lift().exercises[0];
    // 200 x 5 = 233.3, 225 x 3 = 247.5, 200 x 6 = 240, 205 x 5 = 239.2
    expect(bench.best).toEqual({ oneRm: 247.5, weight: 225, reps: 3, date: "2026-09-08" });
    expect(bench.heaviest).toEqual({ weight: 225, reps: 3, date: "2026-09-08" });
    const chin = lift().exercises.find((x) => x.name === "Chin Up")!;
    expect(chin.best).toBeNull(); // bodyweight
    expect(chin.heaviest).toBeNull();
    expect(lift().exercises.find((x) => x.name === "Plank")!.reps).toBe(60);
  });

  it("counts the sessions of a lift once even when it comes up twice in one", () => {
    const twice = computeLifetime(input({ rows: [rows[0]], lifts: [{ id: "1", date: "2026-09-01", sets: [
      { exerciseName: "Squat", category: "SQUAT", sets: 1, reps: 5, weight: 100 }, { exerciseName: "Squat", category: "SQUAT", sets: 1, reps: 5, weight: 110 },
    ] }] })).strength!;
    expect(twice.exercises[0]).toEqual(expect.objectContaining({ name: "Squat", sessions: 1, sets: 2 }));
  });

  it("is still there, without exercises, when no session has its details yet", () => {
    const bare = computeLifetime(input({ rows })).strength!;
    expect(bare).toEqual(expect.objectContaining({ sessions: 3, detailed: 0, volume: 0, exercises: [] }));
  });
});

describe("from the database", () => {
  let dir: string;
  let store: SqliteStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifetime-"));
    store = SqliteStore.open(path.join(dir, "garmin.db"));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const item = (id: number, day: string, typeKey: string, extra: Record<string, unknown> = {}) => ({
    activityId: id, activityName: `Activity ${id}`, activityType: { typeKey }, startTimeGMT: `${day} 12:00:00`, startTimeLocal: `${day} 08:00:00`,
    duration: 3000, distance: typeKey === "running" ? 10000 : undefined, averageHR: 150, ...extra,
  });
  const keep = (...items: any[]) => store.activities.insertNew("MED", items.map((i) => toNewActivity(i)!));

  it("reads the totals, the efforts hidden in the list items, and the lifts of the stored details", () => {
    keep(
      item(1, "2026-09-01", "running", { elevationGain: 30, calories: 500, vO2MaxValue: 51, fastestSplit_1000: 280.5, fastestSplit_5000: 1500, fastestSplit_junk: 5, fastestSplit_1609: null }),
      item(2, "2026-09-02", "strength_training", { totalSets: 9, totalReps: 70 }),
    );
    store.activities.setDetail("MED", "2", { fullExerciseSets: [{ setType: "ACTIVE", exercises: [{ category: "X", name: "BARBELL_BENCH_PRESS" }], repetitionCount: 5, weight: 200 * 453.6 }] });
    const s = lifetimeStats(store.activities, "MED");
    expect(s).toEqual(expect.objectContaining({ activities: 2, calories: 500, since: "2026-09-01", until: "2026-09-02" }));
    expect(s.running).toEqual(expect.objectContaining({ runs: 1, meters: 10000, gain: 30 }));
    expect(s.running!.efforts).toEqual([expect.objectContaining({ meters: 1000, seconds: 280.5 }), expect.objectContaining({ meters: 5000, seconds: 1500 })]);
    expect(s.running!.vo2max.best).toEqual({ value: 51, date: "2026-09-01" });
    expect(s.strength).toEqual(expect.objectContaining({ sessions: 1, sets: 9, reps: 70, detailed: 1 }));
    expect(s.strength!.exercises[0]).toEqual(expect.objectContaining({ name: "Barbell Bench Press", sessions: 1, sets: 1, reps: 5, volume: 1000 }));
    expect(s.strength!.exercises[0].best).toEqual({ oneRm: 233.3, weight: 200, reps: 5, date: "2026-09-02" });
  });

  it("keeps its answer while the table is the same, and works it out again when an activity is added or gets its details", () => {
    keep(item(1, "2026-09-01", "running"));
    const first = lifetimeStats(store.activities, "MED");
    expect(lifetimeStats(store.activities, "MED")).toBe(first); // the very same answer, not worked out again

    keep(item(2, "2026-09-02", "running"));
    const second = lifetimeStats(store.activities, "MED");
    expect(second).not.toBe(first);
    expect(second.running!.runs).toBe(2);

    keep(item(3, "2026-09-03", "strength_training", { totalSets: 3 }));
    const third = lifetimeStats(store.activities, "MED");
    expect(third.strength!.detailed).toBe(0);
    store.activities.setDetail("MED", "3", { fullExerciseSets: [{ setType: "ACTIVE", exercises: [{ name: "BARBELL_SQUAT" }], repetitionCount: 5, weight: 100 * 453.6 }] });
    const fourth = lifetimeStats(store.activities, "MED");
    expect(fourth).not.toBe(third);
    expect(fourth.strength!.detailed).toBe(1);
    expect(lifetimeStats(store.activities, "MED")).toBe(fourth);
  });

  it("keeps each profile to itself, and is empty for one with nothing", () => {
    keep(item(1, "2026-09-01", "running"));
    expect(lifetimeStats(store.activities, "SAM")).toEqual(expect.objectContaining({ profile: "SAM", activities: 0, running: null }));
    expect(lifetimeStats(store.activities, "MED").activities).toBe(1);
  });
});
