/**
 * workoutFormModel.js is the logic of the workout form: the flat steps of a plan read as blocks (exercises and their sets,
 * supersets, steps and repeats), the edits the form makes on them, the units of its fields and its checks.
 */
import exerciseCategoryMap from "../exercise-category-map.json";
import { WorkoutEditor } from "../workoutEditor";
import { compareWorkouts } from "../shared/workoutSync";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const M = require("../web/public/workoutFormModel.js");

const EXERCISES = exerciseCategoryMap as Record<string, string>;
const known = (name: string) => Object.prototype.hasOwnProperty.call(EXERCISES, name);
// the validation and the Garmin conversion use no client
const editor = new WorkoutEditor(null as never);

type Step = Record<string, any>;
const ordered = (steps: Step[]) => steps.map((s, i) => ({ ...s, stepOrder: i + 1 }));
const lift = (exerciseName: string, reps: number, sets: number, gi: number, over: Step = {}) => ({
  stepType: "interval", targetType: "no.target", endCondition: "reps", endConditionValue: reps, exerciseName, reps, numberOfRepeats: sets, repeatGroupIndex: gi, ...over,
});
const warmup = { stepType: "warmup", targetType: "no.target", endCondition: "lap.button", endConditionValue: 0 };
const cooldown = { stepType: "cooldown", targetType: "no.target", endCondition: "lap.button", endConditionValue: 0 };
const hr = (lo: number, hi: number) => ({ targetType: "heart.rate.zone", targetValueOne: lo, targetValueTwo: hi });
const km = (meters: number) => ({ endCondition: "distance", endConditionValue: meters, distanceMeters: meters });
const secs = (seconds: number) => ({ endCondition: "time", endConditionValue: seconds, durationSeconds: seconds });

// The shapes the plans hold: one exercise per repeat, supersets with the rest after the round, strides, repeats of a rep and its recovery.
const UPPER = {
  workoutName: "Upper", workoutType: "strength_training",
  steps: ordered([
    warmup,
    lift("BARBELL_BENCH_PRESS", 8, 3, 0, { weight: 195, restTimeSeconds: 120 }),
    lift("BARBELL_ROW", 10, 3, 1, { weight: 135, restTimeSeconds: 90 }),
    lift("WEIGHTED_CHIN_UP", 8, 3, 2, { weight: 25, restTimeSeconds: 90 }),
    lift("STANDING_EZ_BAR_BICEPS_CURL", 12, 2, 3, { weight: 60 }),
    lift("LYING_EZ_BAR_TRICEPS_EXTENSION", 12, 2, 3, { weight: 50, restTimeSeconds: 60 }),
  ]),
};
const SUPERSETS = {
  workoutName: "Supersets", workoutType: "strength_training",
  steps: ordered([
    warmup,
    lift("INCLINE_DUMBBELL_BENCH_PRESS", 10, 3, 0, { weight: 130 }),
    lift("WEIGHTED_CHIN_UP", 8, 3, 0, { weight: 30, restTimeSeconds: 75 }),
    lift("OVERHEAD_BARBELL_PRESS", 8, 3, 1, { weight: 105 }),
    lift("DUMBBELL_LATERAL_RAISE", 15, 3, 1, { weight: 60, restTimeSeconds: 60 }),
    lift("STANDING_EZ_BAR_BICEPS_CURL", 12, 2, 2, { weight: 55 }),
    lift("LYING_EZ_BAR_TRICEPS_EXTENSION", 12, 2, 2, { weight: 55 }),
    lift("PULL_APART", 15, 2, 2, { restTimeSeconds: 45 }),
  ]),
};
const STRIDES = {
  workoutName: "Easy 6 km + strides", workoutType: "running",
  steps: ordered([
    { stepType: "interval", ...hr(133, 146), ...km(6000) },
    { stepType: "interval", targetType: "no.target", ...secs(20), numberOfRepeats: 4, repeatGroupIndex: 1, restTimeSeconds: 40 },
    cooldown,
  ]),
};
const REHEARSAL = {
  workoutName: "Rehearsal", workoutType: "running",
  steps: ordered([
    { stepType: "warmup", ...hr(133, 146), ...km(2000) },
    { stepType: "interval", targetType: "pace.zone", targetValueOne: 3.32, targetValueTwo: 3.39, ...km(3000) },
    { stepType: "recovery", ...hr(120, 146), ...km(1000) },
    { stepType: "interval", targetType: "pace.zone", targetValueOne: 3.32, targetValueTwo: 3.39, ...km(3000) },
    { stepType: "cooldown", targetType: "no.target", ...km(2000) },
  ]),
};
const SHARPENER = {
  workoutName: "Sharpener", workoutType: "running",
  steps: ordered([
    { stepType: "warmup", ...hr(133, 146), ...km(1500) },
    { stepType: "interval", targetType: "pace.zone", targetValueOne: 3.36, targetValueTwo: 3.45, ...km(1000), numberOfRepeats: 2, repeatGroupIndex: 1 },
    { stepType: "recovery", targetType: "no.target", ...secs(120), numberOfRepeats: 2, repeatGroupIndex: 1 },
    { stepType: "cooldown", targetType: "no.target", ...km(1500) },
  ]),
};
const RIDE = {
  workoutName: "Sweet spot", workoutType: "cycling",
  steps: ordered([
    { stepType: "warmup", targetType: "power.zone", targetValueOne: 120, targetValueTwo: 150, ...secs(600) },
    { stepType: "interval", targetType: "power.zone", targetValueOne: 230, targetValueTwo: 250, ...secs(480), numberOfRepeats: 3, repeatGroupIndex: 0 },
    { stepType: "recovery", targetType: "cadence.zone", targetValueOne: 85, targetValueTwo: 95, ...secs(240), numberOfRepeats: 3, repeatGroupIndex: 0 },
    { stepType: "cooldown", targetType: "speed.zone", targetValueOne: 6.944, targetValueTwo: 8.333, ...secs(600) },
  ]),
};
const SHAPES = [UPPER, SUPERSETS, STRIDES, REHEARSAL, SHARPENER, RIDE];

/** What Garmin keeps of a workout the plan holds, compared with the plan itself: nothing may differ for what the form writes. */
const garminDiff = (w: Step) => compareWorkouts(w as never, editor.toGarminCanonical(w as never));
const write = (w: Step, edit: (blocks: any[]) => any[]) => ({ ...w, steps: M.fromBlocks(edit(M.toBlocks(w.steps))) });

describe("reading the steps as blocks", () => {
  it("reads one exercise's sets, a superset, strides and a repeat of a rep and its recovery as the upload does", () => {
    const shape = (w: Step) => M.toBlocks(w.steps).map((b: any) => [b.steps.length, b.times]);
    expect(shape(UPPER)).toEqual([[1, 1], [1, 3], [1, 3], [1, 3], [2, 2]]);
    expect(shape(SUPERSETS)).toEqual([[1, 1], [2, 3], [2, 3], [3, 2]]);
    expect(shape(STRIDES)).toEqual([[1, 1], [1, 4], [1, 1]]);
    expect(shape(SHARPENER)).toEqual([[1, 1], [2, 2], [1, 1]]);
  });

  it("writes every shape the plans hold back as the very same steps", () => {
    for (const w of SHAPES) {
      const back = M.fromBlocks(M.toBlocks(w.steps));
      expect(back).toHaveLength(w.steps.length);
      back.forEach((st: Step, i: number) => expect(st).toBe(w.steps[i]));
    }
  });

  it("keeps fields it does not know", () => {
    const steps = ordered([{ ...warmup, note: "mobility", secondaryTargetType: "x" }, lift("PLANK", 1, 3, 0, { custom: { a: 1 } })]);
    const out = M.fromBlocks(M.setTimes(M.toBlocks(steps), 1, 4));
    expect(out[0]).toBe(steps[0]);
    expect(out[1]).toEqual({ ...steps[1], numberOfRepeats: 4 });
  });

  it("reads a group that repeats once as its steps, and a numberOfRepeats without a group as one step", () => {
    const once = [lift("PLANK", 1, 1, 0), lift("PUSH_UP", 1, 1, 0), { ...lift("SIT_UP", 1, 3, 0), repeatGroupIndex: undefined }];
    expect(M.toBlocks(once).map((b: any) => [b.steps.length, b.times])).toEqual([[1, 1], [1, 1], [1, 1]]);
  });

  it("shows a strength workout as exercises with their lines of sets, and supersets", () => {
    const blocks = M.toBlocks(UPPER.steps);
    expect(M.strengthCards(blocks).map((c: any) => [c.kind, c.k, c.count])).toEqual([["step", 0, 1], ["exercise", 1, 1], ["exercise", 2, 1], ["exercise", 3, 1], ["superset", 4, 1]]);
    // a top set after the work sets is a second line of the same exercise
    const pyramid = M.toBlocks(ordered([lift("BARBELL_BACK_SQUAT", 5, 3, 0, { weight: 225 }), { ...lift("BARBELL_BACK_SQUAT", 3, 1, 1, { weight: 245 }) }, lift("BARBELL_BENCH_PRESS", 8, 3, 2)]));
    const cards = M.strengthCards(pyramid);
    expect(cards.map((c: any) => [c.kind, c.name, c.count])).toEqual([["exercise", "BARBELL_BACK_SQUAT", 2], ["exercise", "BARBELL_BENCH_PRESS", 1]]);
    expect(pyramid.slice(0, 2).reduce((t: number, b: any) => t + b.times, 0)).toBe(4); // its sets
  });
});

describe("edits", () => {
  it("changes the number of sets of one line and nothing else", () => {
    const out = write(UPPER, (b) => M.setTimes(b, 1, 4));
    expect(out.steps[1]).toEqual({ ...UPPER.steps[1], numberOfRepeats: 4 });
    out.steps.forEach((st: Step, i: number) => i !== 1 && expect(st).toBe(UPPER.steps[i]));
  });

  it("makes a line of one set a plain step, and gives a step made a repeat an index no other repeat has", () => {
    const one = write(UPPER, (b) => M.setTimes(b, 2, 1));
    expect(one.steps[2].numberOfRepeats).toBeUndefined();
    expect(one.steps[2].repeatGroupIndex).toBeUndefined();
    const again = write(one, (b) => M.setTimes(b, 2, 5));
    expect(again.steps[2].numberOfRepeats).toBe(5);
    expect(new Set(again.steps.filter((s: Step) => s.numberOfRepeats > 1).map((s: Step) => `${s.repeatGroupIndex}`)).size).toBe(4);
    expect(garminDiff(again)).toEqual([]);
  });

  it("splits a line into one line per set, and joins sets that are alike back into one line", () => {
    const each = write(UPPER, (b) => M.eachSet(b, 1));
    expect(each.steps).toHaveLength(UPPER.steps.length + 2);
    expect(each.steps.slice(1, 4).map((s: Step) => [s.exerciseName, s.numberOfRepeats, s.reps])).toEqual([["BARBELL_BENCH_PRESS", undefined, 8], ["BARBELL_BENCH_PRESS", undefined, 8], ["BARBELL_BENCH_PRESS", undefined, 8]]);
    expect(each.steps.map((s: Step) => s.stepOrder)).toEqual(each.steps.map((_: Step, i: number) => i + 1));
    const card = M.strengthCards(M.toBlocks(each.steps))[1];
    expect([card.kind, card.count]).toEqual(["exercise", 3]);
    const joined = M.sameSets(M.toBlocks(each.steps), 1, 3);
    expect(joined.map((b: any) => b.times)).toEqual([1, 3, 3, 3, 2]);
    // sets that differ stay apart
    const varied = M.updateStep(M.toBlocks(each.steps), 2, 0, (st: Step) => M.withEnd(st, "reps", 6));
    expect(M.sameSets(varied, 1, 3)).toBeNull();
  });

  it("makes two exercises a superset: done as often as the more sets of the two, with the rest after the round only", () => {
    const out = write(UPPER, (b) => M.joinBlocks(b, 1, 2, { superset: true }));
    const blocks = M.toBlocks(out.steps);
    expect(blocks.map((b: any) => [b.steps.length, b.times])).toEqual([[1, 1], [2, 3], [1, 3], [2, 2]]);
    expect(blocks[1].steps.map((s: Step) => s.restTimeSeconds)).toEqual([undefined, 90]);
    expect(garminDiff(out)).toEqual([]);
  });

  it("splits a superset back into its exercises, each with the superset's sets, never joined to a neighbour", () => {
    const out = write(SUPERSETS, (b) => M.splitBlock(b, 1));
    const blocks = M.toBlocks(out.steps);
    expect(blocks.map((b: any) => [b.steps.length, b.times])).toEqual([[1, 1], [1, 3], [1, 3], [2, 3], [3, 2]]);
    expect(M.strengthCards(blocks).map((c: any) => c.kind)).toEqual(["step", "exercise", "exercise", "superset", "superset"]);
    expect(garminDiff(out)).toEqual([]);
  });

  it("gives a copied repeat an index of its own, so it does not join the original", () => {
    const out = write(SHARPENER, (b) => M.duplicateBlocks(b, 1));
    expect(M.toBlocks(out.steps).map((b: any) => [b.steps.length, b.times])).toEqual([[1, 1], [2, 2], [2, 2], [1, 1]]);
    expect(out.steps[3]).not.toBe(out.steps[1]);
    expect(garminDiff(out)).toEqual([]);
  });

  it("moves blocks and numbers the steps in their new order, which is the order the upload follows", () => {
    const out = write(UPPER, (b) => M.moveBlocks(b, 4, 1, 1));
    expect(out.steps.map((s: Step) => s.exerciseName ?? s.stepType)).toEqual(["warmup", "STANDING_EZ_BAR_BICEPS_CURL", "LYING_EZ_BAR_TRICEPS_EXTENSION", "BARBELL_BENCH_PRESS", "BARBELL_ROW", "WEIGHTED_CHIN_UP"]);
    expect(out.steps.map((s: Step) => s.stepOrder)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(M.moveBlocks(M.toBlocks(UPPER.steps), 1, 1, 1)).toEqual(M.toBlocks(UPPER.steps));
    expect(garminDiff(out)).toEqual([]);
  });

  it("adds steps into a repeat, moves them inside it, and out of it past its ends", () => {
    const blocks = M.toBlocks(SHARPENER.steps);
    const added = M.insertInto(blocks, 1, undefined, [M.newStep(SHARPENER, "rest")]);
    expect(added[1].steps.map((s: Step) => s.stepType)).toEqual(["interval", "recovery", "rest"]);
    const up = M.moveInside(added, 1, 2, -1);
    expect(up[1].steps.map((s: Step) => s.stepType)).toEqual(["interval", "rest", "recovery"]);
    const out = M.moveInside(up, 1, 0, -1);
    expect(out.map((b: any) => b.steps.map((s: Step) => s.stepType))).toEqual([["warmup"], ["interval"], ["rest", "recovery"], ["cooldown"]]);
    expect(out[2].times).toBe(2);
    const taken = M.takeOut(blocks, 1, 1, { keep: true });
    expect(taken.map((b: any) => [b.steps.map((s: Step) => s.stepType), b.times])).toEqual([[["warmup"], 1], [["interval"], 2], [["recovery"], 1], [["cooldown"], 1]]);
    // an exercise taken out of a superset keeps the superset's sets
    const lifts = M.takeOut(M.toBlocks(SUPERSETS.steps), 1, 0, { keep: true, times: 3 });
    expect(lifts.slice(1, 3).map((b: any) => [b.steps.map((s: Step) => s.exerciseName), b.times])).toEqual([[["INCLINE_DUMBBELL_BENCH_PRESS"], 3], [["WEIGHTED_CHIN_UP"], 3]]);
  });

  it("joins steps into a repeat and undoes a repeat", () => {
    const steps = ordered([{ stepType: "interval", targetType: "no.target", ...km(400) }, { stepType: "recovery", targetType: "no.target", ...secs(90) }]);
    const joined = M.joinBlocks(M.toBlocks(steps), 0, 2);
    expect(joined.map((b: any) => [b.steps.length, b.times])).toEqual([[2, 2]]);
    const out = M.fromBlocks(M.setTimes(joined, 0, 6));
    expect(out.map((s: Step) => [s.numberOfRepeats, s.repeatGroupIndex])).toEqual([[6, 0], [6, 0]]);
    expect(M.fromBlocks(M.setTimes(M.toBlocks(out), 0, 1))).toEqual(steps);
  });

  it("drops the index of a step done once when it would join it to the repeat beside it", () => {
    const steps = ordered([lift("PLANK", 1, 1, 0), lift("PUSH_UP", 10, 3, 1)]);
    const out = M.fromBlocks(M.setTimes(M.toBlocks(steps), 1, 3).map((b: any, i: number) => (i === 1 ? { ...b, gi: 0 } : b)));
    expect(out[0].repeatGroupIndex).toBeUndefined();
    expect(out[1].repeatGroupIndex).toBe(0);
  });
});

describe("a step's end, target and rest", () => {
  it("ends by reps, time, distance or the lap button, with the mirrored field following", () => {
    const st = { stepType: "interval", targetType: "no.target", ...km(1000) };
    expect(M.withEnd(st, "time", 300)).toEqual({ stepType: "interval", targetType: "no.target", endCondition: "time", endConditionValue: 300, durationSeconds: 300 });
    expect(M.withEnd(st, "reps", 12)).toEqual({ stepType: "interval", targetType: "no.target", endCondition: "reps", endConditionValue: 12, reps: 12 });
    expect(M.withEnd(st, "lap", 0)).toEqual({ stepType: "interval", targetType: "no.target", endCondition: "lap.button", endConditionValue: 0 });
    expect(M.withEnd(st, "distance", 1000)).toBe(st);
    expect(M.endOf({ stepType: "rest", durationSeconds: 90 })).toEqual({ by: "time", value: 90 });
    expect(M.endOf({ endCondition: "calories", endConditionValue: 200 })).toEqual({ by: "calories", value: 200 });
  });

  it("keeps a range lower number first (the slower speed of a pace), and leaves a target it would not change alone", () => {
    const st = { stepType: "interval", targetType: "pace.zone", targetValueOne: 3.39, targetValueTwo: 3.32 };
    expect(M.withTarget(st, "pace.zone", 3.32, 3.39)).toBe(st);
    expect(M.targetOf(st)).toEqual({ type: "pace.zone", lo: 3.32, hi: 3.39 });
    expect(M.withTarget(st, "heart.rate.zone", 150, 140)).toEqual({ stepType: "interval", targetType: "heart.rate.zone", targetValueOne: 140, targetValueTwo: 150 });
    expect(M.withTarget(st, "no.target")).toEqual({ stepType: "interval", targetType: "no.target" });
    expect(M.withTarget(st, "power.zone", 250, null)).toEqual({ stepType: "interval", targetType: "power.zone", targetValueOne: 250 });
  });

  it("adds and takes away a rest", () => {
    const st = { stepType: "interval" };
    expect(M.withRest(st, 90)).toEqual({ stepType: "interval", restTimeSeconds: 90 });
    expect(M.withRest({ ...st, restTimeSeconds: 90 }, 0)).toEqual(st);
    expect(M.withRest(st, 0)).toBe(st);
  });

  it("offers each sport its targets, and a step's own target even when the sport does not", () => {
    expect(M.targetsFor({ workoutType: "cycling" })).toEqual(["no.target", "power.zone", "heart.rate.zone", "cadence.zone", "speed.zone"]);
    expect(M.targetsFor({ workoutType: "running" }, { targetType: "speed.zone" })).toContain("speed.zone");
    expect(M.targetUnit("cadence.zone", { workoutType: "cycling" })).toBe("rpm");
    expect(M.targetUnit("cadence.zone", { workoutType: "running" })).toBe("spm");
    expect(M.kindLabel("interval", { workoutType: "cycling" })).toBe("Ride");
    expect(M.kindLabel("interval", { workoutType: "running" })).toBe("Run");
  });
});

describe("nested repeats", () => {
  const nested: Step = {
    workoutName: "Demo", workoutType: "running",
    steps: [
      { stepType: "warmup", targetType: "no.target", endCondition: "time", endConditionValue: 600 },
      { stepType: "repeat", targetType: "no.target", numberOfRepeats: 4, endCondition: "iterations", endConditionValue: 4, repeatSteps: [
        { stepType: "interval", targetType: "pace.zone", targetValueOne: 3.6, targetValueTwo: 3.9, endCondition: "distance", endConditionValue: 1000 },
        { stepType: "recovery", targetType: "no.target", endCondition: "time", endConditionValue: 120 },
      ] },
      { stepType: "cooldown", targetType: "no.target", endCondition: "time", endConditionValue: 600 },
    ],
  };
  const sets = {
    workoutName: "Demo lift", workoutType: "strength_training",
    steps: [{ stepType: "repeat", targetType: "no.target", endCondition: "iterations", endConditionValue: 3, repeatSteps: [
      { stepType: "exercise", exerciseName: "BARBELL_BACK_SQUAT", targetType: "no.target", endCondition: "reps", endConditionValue: 5, weight: 225 },
      { stepType: "rest", targetType: "no.target", endCondition: "time", endConditionValue: 120 },
    ] }],
  };

  it("reads them as the flat list the upload understands", () => {
    const flat = M.flatten(nested.steps);
    expect(M.toBlocks(flat).map((b: any) => [b.steps.map((s: Step) => s.stepType), b.times])).toEqual([[["warmup"], 1], [["interval", "recovery"], 4], [["cooldown"], 1]]);
    expect(flat[1]).toEqual({ ...nested.steps[1].repeatSteps[0], numberOfRepeats: 4, repeatGroupIndex: 0 });
    expect(M.fromBlocks(M.toBlocks(flat)).map((st: Step) => st.stepOrder)).toEqual([1, 2, 3, 4]); // written in order, as the upload reads it
    // the demo's steps leave out the fields that mirror endConditionValue, which Garmin's copy has: an edit adds them (withEnd)
    const mirrored = flat.map((st: Step) => M.withEnd(st, M.endOf(st).by, M.endOf(st).value));
    expect(garminDiff({ ...nested, steps: M.fromBlocks(M.toBlocks(mirrored)) })).toEqual([]);
  });

  it("makes a timed rest inside a repeat the rest after the step before it, as Garmin's own steps read", () => {
    const flat = M.flatten(sets.steps);
    expect(flat).toEqual([{ stepType: "exercise", exerciseName: "BARBELL_BACK_SQUAT", targetType: "no.target", endCondition: "reps", endConditionValue: 5, weight: 225, restTimeSeconds: 120, numberOfRepeats: 3, repeatGroupIndex: 0 }]);
    expect(M.strengthCards(M.toBlocks(flat))[0].kind).toBe("exercise");
  });

  it("leaves a flat list as it is, and cannot read a repeat inside a repeat", () => {
    expect(M.flatten(UPPER.steps)).toBe(UPPER.steps);
    expect(M.flatten([{ stepType: "repeat", repeatSteps: [{ stepType: "repeat", repeatSteps: [] }] }])).toBeNull();
    expect(M.formProblem({ workoutName: "x", workoutType: "running", steps: [{ stepType: "repeat", repeatSteps: [{ stepType: "repeat", repeatSteps: [] }] }] })).toMatch(/repeat holds another/);
  });
});

describe("units", () => {
  it("reads and writes clocks", () => {
    expect(M.clock(45)).toBe("0:45");
    expect(M.clock(3725)).toBe("1:02:05");
    expect(M.parseClock("1:02:05")).toBe(3725);
    expect(M.parseClock("4:30")).toBe(270);
    expect(M.parseClock("90")).toBe(90);
    expect(M.parseClock("30", "min")).toBe(1800);
    expect(M.parseClock("90s", "min")).toBe(90);
    expect(M.parseClock("2 min")).toBe(120);
    expect(M.parseClock("1.5h")).toBe(5400);
    expect(M.distanceIn(1200, "km")).toBe("1.2");
    expect(M.distanceIn(1200, "m")).toBe("1200");
    expect(M.parseClock("4:75")).toBeNull();
    expect(M.parseClock("abc")).toBeNull();
    expect(M.parseClock("")).toBeNull();
  });

  it("gives back every pace typed, to the second, through the speed the plan keeps", () => {
    for (let s = 150; s < 600; s++) {
      const text = M.clock(s);
      expect(M.paceText(M.parsePace(text))).toBe(text);
    }
    expect(M.parsePace("458")).toBe(M.parsePace("4:58"));
    expect(M.parsePace("4.58")).toBe(M.parsePace("4:58"));
    expect(M.parsePace("5")).toBe(M.parsePace("5:00"));
    expect(M.parsePace("4:58 /km")).toBeCloseTo(3.356, 3);
    expect(M.parsePace("0:30")).toBeNull();
    expect(M.paceText(3.32)).toBe("5:01");
  });

  it("reads speeds in km/h, distances in km or m, and weights in lb or kg", () => {
    expect(M.kmhText(8.333)).toBe("30");
    expect(M.parseKmh("30")).toBe(8.333);
    expect(M.parseKmh("0")).toBeNull();
    expect([M.distanceUnit(400), M.distanceUnit(2500), M.distanceUnit(400.5), M.distanceUnit(0)]).toEqual(["m", "km", "km", "km"]);
    expect([M.distanceIn(400, "m"), M.distanceIn(2500, "km"), M.distanceIn(21100, "km")]).toEqual(["400", "2.5", "21.1"]);
    expect(M.parseDistance("2,5")).toBe(2500);
    expect(M.parseDistance("400", "m")).toBe(400);
    expect(M.parseDistance("400m", "km")).toBe(400);
    expect(M.parseDistance("-1")).toBeNull();
    expect(M.weightText(195)).toBe("195");
    expect(M.weightText(195, "kg")).toBe("88.5");
    expect(M.parseWeight("100", "kg")).toBe(220.46);
    expect(M.parseWeight("135.5")).toBe(135.5);
    expect(M.parseWeight("x")).toBeNull();
    // every half kilo typed is shown back as typed
    for (let kg = 0.5; kg <= 300; kg += 0.5) expect(M.weightText(M.parseWeight(String(kg), "kg"), "kg")).toBe(String(kg));
  });
});

describe("checks", () => {
  it("flags what the upload would refuse, by step and field", () => {
    const w = { workoutType: "strength_training", steps: [
      { stepType: "interval", targetType: "no.target" },
      { stepType: "interval", targetType: "no.target", endCondition: "reps", endConditionValue: 0, exerciseName: "BENCH_THING" },
      { stepType: "interval", targetType: "no.target", endCondition: "reps", endConditionValue: 8, reps: 10, exerciseName: "BARBELL_BENCH_PRESS", weightPercentage: 75 },
      { stepType: "jump", targetType: "nope", endCondition: "time", endConditionValue: 5 },
    ] };
    expect(M.check(w, known).map((p: any) => [p.i, p.field, p.level])).toEqual([
      [0, "end", "err"],
      [1, "end", "err"], [1, "exercise", "err"],
      [2, "end", "err"], [2, "weight", "err"],
      [3, "kind", "err"], [3, "target", "err"],
    ]);
  });

  it("finds nothing wrong in the shapes the plans hold", () => {
    for (const w of SHAPES) expect(M.check(w, known)).toEqual([]);
  });

  it("says why the form cannot show a workout", () => {
    expect(M.formProblem(UPPER)).toBe("");
    expect(M.formProblem({ workoutName: "Laps", workoutType: "swimming", steps: [] })).toMatch(/swim/);
    expect(M.formProblem({ workoutName: "x", steps: [null] })).toBe("Step 1 is not a step.");
    expect(M.formProblem({ workoutName: "x", steps: {} })).toMatch(/not a list/);
    expect(M.modeOf({ workoutType: "walking" })).toBe("endurance");
    expect(M.modeOf({})).toBe("strength");
  });
});

describe("new workouts and blocks", () => {
  it("starts each type with steps the upload accepts and Garmin keeps as they are", () => {
    for (const type of M.TYPES.filter((t: string) => t !== "swimming")) {
      const w = M.newWorkout(type, "New");
      expect(() => editor.validateWorkout(w)).not.toThrow();
      expect(M.check(w, known)).toEqual([]);
      expect(garminDiff(w)).toEqual([]);
    }
    expect(M.newWorkout("strength_training", "Lift").steps.map((s: Step) => s.exerciseName ?? s.stepType)).toEqual(["warmup", "BARBELL_BACK_SQUAT", "BARBELL_BENCH_PRESS"]);
  });

  it("adds presets the upload accepts", () => {
    for (const type of ["running", "cycling"]) {
      for (const preset of M.PRESETS[type]) {
        const w = { workoutName: preset.label, workoutType: type, steps: M.fromBlocks(preset.blocks({ workoutType: type })) };
        expect(() => editor.validateWorkout(w as never)).not.toThrow();
        expect(garminDiff(w)).toEqual([]);
      }
    }
  });

  it("makes a set of an exercise with its reps, weight and rest", () => {
    expect(M.newSet("BARBELL_ROW", { reps: 10, weight: 135, rest: 90 })).toEqual({
      stepType: "interval", targetType: "no.target", exerciseName: "BARBELL_ROW", endCondition: "reps", endConditionValue: 10, reps: 10, weight: 135, restTimeSeconds: 90,
    });
  });
});

describe("the shapes Garmin keeps as the form wrote them", () => {
  it("validates and round-trips every shape and every edit", () => {
    const edits: [Step, (b: any[]) => any[]][] = [
      [UPPER, (b) => M.joinBlocks(b, 2, 2, { superset: true })],
      [UPPER, (b) => M.eachSet(b, 3)],
      [SUPERSETS, (b) => M.splitBlock(b, 3)],
      [STRIDES, (b) => M.setTimes(b, 1, 6)],
      [REHEARSAL, (b) => M.joinBlocks(b, 1, 2)],
      [RIDE, (b) => M.duplicateBlocks(b, 1)],
      [RIDE, (b) => M.moveBlocks(b, 3, 1, 0)],
    ];
    for (const w of [...SHAPES, ...edits.map(([w, edit]) => write(w, edit))]) {
      expect(() => editor.validateWorkout(w as never)).not.toThrow();
      expect(garminDiff(w)).toEqual([]);
    }
  });
});

describe("finding an exercise", () => {
  const all = Object.entries(EXERCISES).map(([name, category]) => ({ name, category }));

  it("finds by words, shorthand and names written together", () => {
    expect(M.searchExercises(all, "rdl")[0].name).toBe("ROMANIAN_DEADLIFT");
    expect(M.searchExercises(all, "db bench").map((e: any) => e.name)).toContain("DUMBBELL_BENCH_PRESS");
    expect(M.searchExercises(all, "pullup").map((e: any) => e.name)).toContain("PULL_UP");
    expect(M.searchExercises(all, "bench press", { category: "BENCH_PRESS" }).every((e: any) => e.category === "BENCH_PRESS")).toBe(true);
  });

  it("lists the exercises already used first", () => {
    const hits = M.searchExercises(all, "press", { recent: ["OVERHEAD_BARBELL_PRESS", "BARBELL_BENCH_PRESS"] });
    expect(hits.slice(0, 2).map((e: any) => e.name)).toEqual(["OVERHEAD_BARBELL_PRESS", "BARBELL_BENCH_PRESS"]);
  });

  it("names only Garmin exercises in what it makes", () => {
    for (const w of M.TYPES.map((t: string) => M.newWorkout(t, "x"))) for (const st of w.steps) if (st.exerciseName) expect(known(st.exerciseName)).toBe(true);
    for (const w of SHAPES) for (const st of w.steps as Step[]) if (st.exerciseName) expect(known(st.exerciseName)).toBe(true);
  });
});
