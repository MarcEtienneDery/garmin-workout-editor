import { MAX_REPS, bestLifts, epley, expandSets, liftKey, liftMax } from "../shared/oneRepMax";

const set = (exerciseName: string, over: Record<string, unknown>) => ({ exerciseName, category: "X", sets: 1, ...over }) as any;

describe("the Epley estimate", () => {
  it("is weight × (1 + reps ÷ 30), and a single is itself", () => {
    expect(epley(200, 1)).toBe(200);
    expect(epley(200, 6)).toBeCloseTo(240, 5);
    expect(epley(100, 12)).toBeCloseTo(140, 5);
    expect(epley(40, 6)).toBeCloseTo(48, 5);
  });

  it("cannot say from a set with no weight, no counted reps, or more than the limit", () => {
    expect(epley(0, 5)).toBeNull();
    expect(epley(200, 0)).toBeNull(); // reps Garmin did not count
    expect(epley(200, MAX_REPS)).not.toBeNull();
    expect(epley(200, MAX_REPS + 1)).toBeNull();
    expect(epley(NaN, 5)).toBeNull();
  });
});

describe("expanding an exercise's sets", () => {
  it("gives one entry per set, from a single value or from the per-set lists", () => {
    expect(expandSets({ sets: 3, reps: 6, weight: 40 })).toEqual([{ weight: 40, reps: 6 }, { weight: 40, reps: 6 }, { weight: 40, reps: 6 }]);
    expect(expandSets({ sets: 3, repsList: [5, 4, 3], weightList: [100, 105, 110] })).toEqual([{ weight: 100, reps: 5 }, { weight: 105, reps: 4 }, { weight: 110, reps: 3 }]);
    expect(expandSets({ sets: 2, repsList: [12, 11], weight: 60 })).toEqual([{ weight: 60, reps: 12 }, { weight: 60, reps: 11 }]);
    expect(expandSets({ sets: 0 })).toEqual([{ weight: 0, reps: 0 }]);
  });
});

describe("the best lifts over some activities", () => {
  it("keeps the best estimate of each exercise, with the set and the day it came from", () => {
    const out = bestLifts([
      { date: "2026-09-01", sets: [set("Bench", { sets: 1, reps: 5, weight: 200 }), set("Row", { sets: 2, reps: 10, weight: 100 })] },
      { date: "2026-10-01", sets: [set("Bench", { sets: 3, repsList: [0, 3, 6], weightList: [135, 225, 200] })] },
    ]);
    // 200 x 5 = 233.3, 225 x 3 = 247.5, 200 x 6 = 240; the 0-rep set is no use
    expect(out.Bench).toEqual({ oneRm: 247.5, weight: 225, reps: 3, date: "2026-10-01" });
    expect(out.Row.oneRm).toBeCloseTo(133.33, 1);
    expect(out.Row.date).toBe("2026-09-01");
  });

  it("names the most recent time on a tie", () => {
    const out = bestLifts([
      { date: "2026-08-01", sets: [set("Squat", { reps: 5, weight: 100 })] },
      { date: "2026-09-01", sets: [set("Squat", { reps: 5, weight: 100 })] },
    ]);
    expect(out.Squat.date).toBe("2026-09-01");
  });

  it("leaves out intervals, nameless sets, bodyweight, high reps and activities without sets", () => {
    const out = bestLifts([
      { date: "2026-09-01", sets: undefined },
      { date: "2026-09-02", sets: [set("Interval 1", { category: "INTERVAL", reps: 1, weight: 50 }), set("", { reps: 5, weight: 50 }), set("Pull Up", { reps: 8, weight: 0 }), set("Curl", { reps: 20, weight: 30 })] },
    ]);
    expect(out).toEqual({});
  });
});

describe("the one-rep max in use for a lift", () => {
  const best = { oneRm: 247.5, weight: 225, reps: 3, date: "2026-09-08" };

  it("files a lift under the same key however it is written", () => {
    expect(liftKey("Barbell Bench Press")).toBe("BENCH_PRESS");
    expect(liftKey("BARBELL_BENCH_PRESS")).toBe("BENCH_PRESS");
    expect(liftKey("Dumbbell Bench Press")).toBe("DUMBBELL_BENCH_PRESS");
    expect(liftKey(undefined as any)).toBe("");
  });

  it("is the benchmark when the lift has one, whatever the best set says", () => {
    expect(liftMax("Barbell Bench Press", { BARBELL_BENCH_PRESS: 266 }, best)).toEqual({ oneRm: 266, source: "benchmark", weight: null, reps: null, date: null });
    expect(liftMax("Barbell Bench Press", { BARBELL_BENCH_PRESS: 266 }, null)!.oneRm).toBe(266); // even with no stored set
  });

  it("is the best estimate otherwise, with the set it came from", () => {
    expect(liftMax("Barbell Bench Press", { BARBELL_BACK_SQUAT: 306 }, best)).toEqual({ oneRm: 247.5, source: "history", weight: 225, reps: 3, date: "2026-09-08" });
    expect(liftMax("Barbell Bench Press", undefined, best)!.source).toBe("history");
  });

  it("is nothing without a benchmark or a usable set, and ignores a benchmark that is not a number", () => {
    expect(liftMax("Face Pull", { BARBELL_BENCH_PRESS: 266 }, undefined)).toBeNull();
    expect(liftMax("Face Pull", {}, null)).toBeNull();
    expect(liftMax("Barbell Bench Press", { BARBELL_BENCH_PRESS: "heavy" as any, BAD: 0 }, best)!.source).toBe("history");
  });
});
