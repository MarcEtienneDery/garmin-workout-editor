/**
 * workoutModel.js is the plain script the plan editor loads to draw a workout: the step tree, the
 * profile bar's segments, the text on each card and the estimated totals.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const M = require("../web/public/workoutModel.js");

const step = (over: Record<string, unknown>) => ({ stepType: "interval", targetType: "no.target", ...over });

const THRESHOLD = {
  workoutName: "8km Threshold Intervals",
  workoutType: "running",
  steps: [
    step({ stepType: "warmup", targetType: "heart.rate.zone", targetValueOne: 130, targetValueTwo: 145, endCondition: "distance", endConditionValue: 1500 }),
    step({ targetType: "pace.zone", targetValueOne: 3.333, targetValueTwo: 3.508, endCondition: "distance", endConditionValue: 1000, numberOfRepeats: 5, repeatGroupIndex: 0 }),
    step({ stepType: "recovery", endCondition: "distance", endConditionValue: 300, numberOfRepeats: 5, repeatGroupIndex: 0 }),
    step({ stepType: "cooldown", endCondition: "lap.button", endConditionValue: 0 }),
  ],
};

describe("formatting", () => {
  it("writes clocks, durations, distances and paces", () => {
    expect(M.clock(45)).toBe("0:45");
    expect(M.clock(3725)).toBe("1:02:05");
    expect(M.duration(45)).toBe("45 s");
    expect(M.duration(1500)).toBe("25 min");
    expect(M.duration(3900)).toBe("1 h 05 min");
    expect(M.distance(800)).toBe("800 m");
    expect(M.distance(11800)).toBe("11.8 km");
    expect(M.pace(3.333)).toBe("5:00");
  });

  it("shows a pace target faster end first, from the speeds in m/s", () => {
    expect(M.targetOf({ targetType: "pace.zone", targetValueOne: 3.333, targetValueTwo: 3.508 }).value).toBe("4:45–5:00 /km");
    expect(M.targetOf({ targetType: "pace.zone", targetValueOne: 3.508, targetValueTwo: 3.333 }).value).toBe("4:45–5:00 /km");
    expect(M.targetOf({ targetType: "heart.rate.zone", targetValueOne: 146, targetValueTwo: 133 }).value).toBe("133–146 bpm");
    expect(M.targetOf({ targetType: "heart.rate.zone", targetValueOne: 3 }).value).toBe("Zone 3");
    expect(M.targetOf({ targetType: "no.target" })).toBeNull();
  });
});

describe("the step tree", () => {
  it("boxes a repeat of several steps, and nothing that repeats once", () => {
    const tree = M.buildTree(THRESHOLD.steps);
    expect(tree.map((n: any) => n.kind)).toEqual(["step", "group", "step"]);
    expect(tree[1].times).toBe(5);
    expect(tree[1].children.map((c: any) => c.st.stepType)).toEqual(["interval", "recovery"]);

    const once = M.buildTree([step({ numberOfRepeats: 1, repeatGroupIndex: 0, endCondition: "distance", endConditionValue: 400 }), step({ stepType: "recovery", numberOfRepeats: 1, repeatGroupIndex: 0, endCondition: "distance", endConditionValue: 200 })]);
    expect(once.map((n: any) => n.kind)).toEqual(["step", "step"]);
  });

  it("lists one exercise's sets on a single card, however the plan grouped them", () => {
    const squat = { exerciseName: "BARBELL_BACK_SQUAT", endCondition: "reps", reps: 6, endConditionValue: 6, weight: 235, restTimeSeconds: 180 };
    const tree = M.buildTree([
      step({ ...squat, endConditionValue: 8, reps: 8, weight: 95, numberOfRepeats: 1, repeatGroupIndex: 0 }),
      step({ ...squat, numberOfRepeats: 4, repeatGroupIndex: 1 }),
      step({ ...squat, exerciseName: "BARBELL_BENCH_PRESS", numberOfRepeats: 3, repeatGroupIndex: 2 }),
    ]);
    expect(tree.map((n: any) => [n.kind, n.name])).toEqual([["sets", "BARBELL_BACK_SQUAT"], ["sets", "BARBELL_BENCH_PRESS"]]);
    expect(tree[0].lines.map((l: any) => [l.times, l.st.reps])).toEqual([[1, 8], [4, 6]]);
    expect(M.describeSet(tree[0].lines[1].st, 4)).toEqual({ times: 4, reps: "6", load: "235 lb", rest: "3:00" });
  });

  it("calls a repeat of two exercises a superset", () => {
    const a = { endCondition: "reps", endConditionValue: 10, numberOfRepeats: 3, repeatGroupIndex: 0 };
    const tree = M.buildTree([step({ ...a, exerciseName: "PULL_UP" }), step({ ...a, exerciseName: "PUSH_UP" })]);
    expect(tree).toHaveLength(1);
    expect(tree[0].kind).toBe("group");
    expect(M.isSuperset(tree[0])).toBe(true);
    expect(M.isSuperset(M.buildTree(THRESHOLD.steps)[1])).toBe(false);
  });

  it("understands nested repeatSteps, and survives junk in the list", () => {
    const nested = M.buildTree([{ stepType: "repeat", numberOfRepeats: 4, repeatSteps: [step({ endCondition: "time", endConditionValue: 20 }), step({ stepType: "recovery", endCondition: "time", endConditionValue: 40 })] }]);
    expect(nested[0].kind).toBe("group");
    expect(nested[0].times).toBe(4);
    expect(nested[0].children).toHaveLength(2);
    expect(() => M.analyze({ workoutName: "x", steps: [null, "text", 3, step({ endCondition: "time", endConditionValue: 60 })] })).not.toThrow();
    expect(M.analyze({ workoutName: "x", steps: "nope" }).hasSteps).toBe(false);
    expect(M.analyze(null).hasSteps).toBe(false);
  });
});

describe("estimates", () => {
  it("totals a running workout, counting an unpaced distance at the assumed pace", () => {
    const a = M.analyze(THRESHOLD);
    // warm-up 1.5 km at 6:00/km = 540 s; five of 1 km at the middle of 4:45-5:00 (3.42 m/s) and 300 m recovery at 6:00/km (108 s)
    expect(a.seconds).toBeCloseTo(540 + 5 * (1000 / 3.4205) + 5 * 108, 0);
    expect(a.meters).toBe(1500 + 5 * 1000 + 5 * 300);
    expect(a.assumed).toBe(true);
    expect(a.open).toBe(1); // the cool-down ends on the lap button and is not counted
    expect(a.steps).toBe(4);
  });

  it("is not assumed when every step names its own time", () => {
    const a = M.analyze({ workoutType: "cycling", steps: [step({ endCondition: "time", endConditionValue: 600 })] });
    expect(a.seconds).toBe(600);
    expect(a.assumed).toBe(false);
    expect(a.meters).toBe(0);
  });

  it("prefers a duration written beside the lap button over the button", () => {
    const a = M.analyze({ workoutType: "strength_training", steps: [step({ stepType: "warmup", exerciseName: "CARDIO", endCondition: "lap.button", endConditionValue: 300, durationSeconds: 300 })] });
    expect(a.seconds).toBe(300);
    expect(a.open).toBe(0);
    expect(M.describeStep(a.tree[0].st, { workoutType: "strength_training" }).metrics[0]).toEqual({ value: "5:00", label: "Time (lap button)" });
  });

  it("counts reps and rests for a strength workout, and its sets", () => {
    const a = M.analyze({
      workoutType: "strength_training",
      steps: [step({ exerciseName: "BARBELL_BACK_SQUAT", endCondition: "reps", endConditionValue: 5, numberOfRepeats: 3, repeatGroupIndex: 0, restTimeSeconds: 60 })],
    });
    expect(a.sets).toBe(3);
    expect(a.exercises).toBe(1);
    expect(a.seconds).toBe(3 * (5 * M.SECONDS_PER_REP + 60));
    expect(a.meters).toBe(0);
    expect(a.segments.map((s: any) => s.kind)).toEqual(["work", "rest", "work", "rest", "work", "rest"]);
  });

  it("falls back on the workout's own distance and duration when it has no steps", () => {
    const a = M.analyze({ workoutName: "Easy 5k", workoutType: "running", distanceMeters: 5000, estimatedDurationSeconds: 1800 });
    expect(a.hasSteps).toBe(false);
    expect(a.meters).toBe(5000);
    expect(a.seconds).toBe(1800);
  });

  it("draws a dense repeat once, wide, and keeps the totals", () => {
    const a = M.analyze({ workoutType: "running", steps: [step({ endCondition: "time", endConditionValue: 30, numberOfRepeats: 200, repeatGroupIndex: 0 })] });
    expect(a.segments).toHaveLength(1);
    expect(a.seconds).toBe(6000);
  });
});

describe("the profile", () => {
  it("keeps every segment visible and lets effort set the height", () => {
    const a = M.analyze(THRESHOLD);
    for (const s of a.segments) {
      expect(s.weight).toBeGreaterThan(0);
      expect(s.height).toBeGreaterThanOrEqual(0.15);
      expect(s.height).toBeLessThanOrEqual(1);
    }
    const work = a.segments.find((s: any) => s.kind === "work"), recovery = a.segments.find((s: any) => s.kind === "recovery");
    expect(work.height).toBeGreaterThan(recovery.height);
    const lap = a.segments.find((s: any) => s.open);
    expect(lap.kind).toBe("cooldown");
    expect(lap.weight).toBeGreaterThan(0);
  });

  it("makes heavier sets taller", () => {
    const set = (weight: number) => step({ exerciseName: "BARBELL_BACK_SQUAT", endCondition: "reps", endConditionValue: 5, weight, numberOfRepeats: 1, repeatGroupIndex: weight });
    const a = M.analyze({ workoutType: "strength_training", steps: [set(100), set(200)] });
    const [light, heavy] = a.segments.filter((s: any) => s.kind === "work");
    expect(heavy.height).toBeGreaterThan(light.height);
  });

  it("ties every segment to its step's card and to the step's position", () => {
    const a = M.analyze(THRESHOLD);
    const keys = new Set<number>();
    (function walk(list: any[]) { for (const n of list) { keys.add(n.key); if (n.children) walk(n.children); } })(a.tree);
    for (const s of a.segments) expect(keys.has(s.key)).toBe(true);
    expect(a.segments.filter((s: any) => s.index === 1)).toHaveLength(5);
  });
});

describe("changed steps", () => {
  it("reads step positions out of the differences against Garmin", () => {
    expect([...M.changedSteps(["Step 2 (interval): endConditionValue is 1000 in the plan, 800 on Garmin", 'Name: "A" in the plan, "B" on Garmin', "Step 5 (cooldown): stepType is \"x\" in the plan, none on Garmin"])]).toEqual([1, 4]);
    expect([...M.changedSteps(["Steps: 3 in the plan, 5 on Garmin"])]).toEqual([3, 4]);
    expect(M.changedSteps(undefined).size).toBe(0);
  });
});
