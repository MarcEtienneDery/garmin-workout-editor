// eslint-disable-next-line @typescript-eslint/no-require-imports
const MM = require("../web/public/muscleMap.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WM = require("../web/public/workoutModel.js");
import categories from "../exercise-category-map.json";

describe("the muscles of an exercise", () => {
  it("names the primary muscles and the secondary ones", () => {
    expect(MM.musclesOf("BARBELL_BENCH_PRESS")).toEqual({ primary: ["chest"], secondary: ["triceps", "frontDelts"] });
    expect(MM.musclesOf("DUMBBELL_LATERAL_RAISE").primary).toEqual(["sideDelts"]);
    expect(MM.musclesOf("STANDING_EZ_BAR_BICEPS_CURL").primary).toEqual(["biceps"]);
    expect(MM.musclesOf("BARBELL_BACK_SQUAT").primary).toEqual(["quads", "glutes"]);
  });

  it("reads a name as a plan writes it and as a done set lists it", () => {
    expect(MM.musclesOf("Weighted Chin Up")).toEqual(MM.musclesOf("WEIGHTED_CHIN_UP"));
    expect(MM.musclesOf("Weighted Chin Up").primary).toEqual(["lats", "biceps"]);
    expect(MM.musclesOf("Single Leg Romanian Deadlift With Dumbbell").primary).toEqual(["hamstrings", "glutes"]);
    expect(MM.musclesOf("3 Way Calf Raise").primary).toEqual(["calves"]);
    expect(MM.musclesOf("_45_DEGREE_PLANK").primary).toEqual(["abs"]);
  });

  it("gives each exercise its own muscles, not those of another that shares a word with it", () => {
    expect(MM.musclesOf("CLOSE_GRIP_BARBELL_BENCH_PRESS").primary).toEqual(["triceps"]);
    expect(MM.musclesOf("LEG_CURL").primary).toEqual(["hamstrings"]);
    expect(MM.musclesOf("DUMBBELL_WRIST_CURL").primary).toEqual(["forearms"]);
    expect(MM.musclesOf("UPRIGHT_ROW").primary).toEqual(["sideDelts", "traps"]);
    expect(MM.musclesOf("CROSSOVER_CHIN_UP").primary).toEqual(["lats", "biceps"]);
    expect(MM.musclesOf("FRONT_RAISE").primary).toEqual(["frontDelts"]);
    expect(MM.musclesOf("SWISS_BALL_PIKE").primary).toEqual(["abs"]);
    expect(MM.musclesOf("FARMERS_CARRY_WALK_LUNGE").primary).toEqual(["forearms", "quads", "glutes"]);
    expect(MM.musclesOf("INCLINE_REVERSE_FLYE").primary).toEqual(["rearDelts"]);
    expect(MM.musclesOf("Side Plank").primary).toEqual(["obliques"]);
    expect(MM.musclesOf("HANGING_HURDLE").primary).toEqual(["abs"]);
    expect(MM.musclesOf("REVERSE_CURL_UP").primary).toEqual(["abs"]);
    expect(MM.musclesOf("FLUTTER_KICKS").primary).toEqual(["abs"]);
    expect(MM.musclesOf("HIP_CROSSOVER").primary).toEqual(["obliques"]);
    expect(MM.musclesOf("STRAIGHT_LEG_CRUNCH_WITH_BALL").primary).toEqual(["abs"]);
    expect(MM.musclesOf("LYING_STRAIGHT_LEG_RAISE").primary).toEqual(["abs"]);
    expect(MM.musclesOf("STRAIGHT_ARM_PLANK").primary).toEqual(["abs"]);
    expect(MM.musclesOf("SHOULDER_ABDUCTION").primary).toEqual(["sideDelts"]);
    expect(MM.musclesOf("DONKEY_CALF_RAISE").primary).toEqual(["calves"]);
    expect(MM.musclesOf("SINGLE_LEG_RDL_CIRCUIT").primary).toEqual(["hamstrings", "glutes"]);
  });

  it("knows no muscles for cardio, warm-ups and stretches, or for a name that is not Garmin's", () => {
    for (const name of ["Cardio", "CALORIE_ROW", "INDOOR_ROW", "RUN", "Arm Circles", "JUMP_ROPE_CROSSOVER", "STRETCH_PECTORAL", "GROINERS", "Unknown", "DUMBBELL_RAISE", "", null, undefined]) expect(MM.musclesOf(name)).toBeNull();
  });

  it("answers for a set Garmin gives only a category for: the generic names of the categories that train something", () => {
    expect(MM.musclesOf("BENCH_PRESS").primary).toEqual(["chest"]);
    expect(MM.musclesOf("SQUAT").primary).toEqual(["quads", "glutes"]);
    expect(MM.musclesOf("BATTLE_ROPE").primary).toEqual(["frontDelts", "sideDelts"]);
    expect(MM.musclesOf("OLYMPIC_LIFT")).not.toBeNull();
    for (const name of ["CARDIO", "WARM_UP", "RUN", "INDOOR_BIKE", "BANDED_EXERCISES", "TOTAL_BODY"]) expect(MM.musclesOf(name)).toBeNull();
  });
});

describe("the table of exercises", () => {
  const MUSCLE_IDS = new Set(MM.MUSCLES.map((m: { id: string }) => m.id));
  const map = categories as Record<string, string>;

  it("has a line for every exercise Garmin lists, and none for a name Garmin does not", () => {
    const listed = Object.keys(map), written = Object.keys(MM.EXERCISES);
    expect({ missing: listed.filter((n) => !(n in MM.EXERCISES)) }).toEqual({ missing: [] });
    expect({ extra: written.filter((n) => !(n in map)) }).toEqual({ extra: [] });
  });

  it("names only muscles that are drawn, each once, a muscle in one list only", () => {
    const wrong: string[] = [];
    for (const [name, entry] of Object.entries(MM.EXERCISES as Record<string, [string[], string[]]>)) {
      const [primary, secondary] = entry;
      if (![...primary, ...secondary].every((id) => MUSCLE_IDS.has(id))) wrong.push(`${name}: a muscle that is not drawn`);
      if (new Set([...primary, ...secondary]).size !== primary.length + secondary.length) wrong.push(`${name}: a muscle twice`);
      if (!primary.length && secondary.length) wrong.push(`${name}: secondary muscles but no primary`);
    }
    expect(wrong).toEqual([]);
  });

  it("gives a weighted exercise the muscles of the one without weight", () => {
    const wrong: string[] = [];
    for (const name of Object.keys(map)) {
      const twin = [name.replace(/^WEIGHTED_/, ""), `_${name.replace(/^WEIGHTED_/, "")}`, name.replace(/_WEIGHTED$/, "")].find((t) => t !== name && t in map);
      if (twin && JSON.stringify(MM.EXERCISES[name]) !== JSON.stringify(MM.EXERCISES[twin])) wrong.push(`${name} differs from ${twin}`);
    }
    expect(wrong).toEqual([]);
  });

  it("trains no muscle in the categories that are a sport or a machine, nor with a warm-up, a stretch or an ankle drill", () => {
    const NOT_LIFTING = new Set(["WARM_UP", "RUN", "RUN_INDOOR", "INDOOR_BIKE", "BIKE_OUTDOOR", "ELLIPTICAL", "STAIR_STEPPER", "FLOOR_CLIMB", "LADDER"]);
    const wrong = Object.entries(map).filter(([n, c]) => (NOT_LIFTING.has(c) || /STRETCH|^ANKLE_/.test(n)) && MM.musclesOf(n)).map(([n]) => n);
    expect(wrong).toEqual([]);
  });

  it("works out something for every lifting exercise: what is left with no muscle is a machine or a stretch", () => {
    const MACHINES = new Set(["INDOOR_ROW", "CALORIE_ROW"]);
    const left: Record<string, string[]> = {};
    for (const [name, category] of Object.entries(map)) if (!MM.musclesOf(name) && !MACHINES.has(name) && !/STRETCH/.test(name)) (left[category] = left[category] || []).push(name);
    const LIFTING = ["BENCH_PRESS", "ROW", "PULL_UP", "SHOULDER_PRESS", "CURL", "TRICEPS_EXTENSION", "FLYE", "SHRUG", "DEADLIFT", "SQUAT", "LUNGE", "LEG_CURL", "CALF_RAISE", "HIP_RAISE", "HYPEREXTENSION", "OLYMPIC_LIFT", "CORE", "CHOP", "SHOULDER_STABILITY", "PUSH_UP", "PLANK", "CRUNCH", "SIT_UP", "LEG_RAISE", "HIP_SWING", "HIP_STABILITY", "SLED", "SLEDGE_HAMMER", "TIRE", "BATTLE_ROPE"];
    for (const category of LIFTING) expect({ category, left: left[category] || [] }).toEqual({ category, left: [] });
  });
});

describe("every muscle can be trained by a Garmin exercise", () => {
  const names = Object.keys(categories as Record<string, string>);

  it("has exercises that work each muscle first, enough that none is a fluke of one name", () => {
    const first: Record<string, string[]> = Object.fromEntries(MM.MUSCLES.map((m: { id: string }) => [m.id, []]));
    for (const name of names) for (const id of MM.musclesOf(name)?.primary ?? []) first[id].push(name);
    for (const m of MM.MUSCLES) expect({ muscle: m.id, enough: first[m.id].length >= 5 }).toEqual({ muscle: m.id, enough: true });
  });

  it("trains no muscle with a stretch or an ankle drill", () => {
    const wrong = names.filter((n) => /STRETCH|^ANKLE_/.test(n) && MM.musclesOf(n));
    expect(wrong).toEqual([]);
  });

  const EXEMPLAR: Record<string, string> = {
    chest: "BARBELL_BENCH_PRESS", frontDelts: "BARBELL_SHOULDER_PRESS", sideDelts: "DUMBBELL_LATERAL_RAISE", rearDelts: "FACE_PULL", traps: "BARBELL_SHRUG",
    lats: "LAT_PULLDOWN", upperBack: "BARBELL_ROW", lowerBack: "HYPEREXTENSION", biceps: "BARBELL_BICEPS_CURL", triceps: "TRICEPS_PRESSDOWN", forearms: "BARBELL_WRIST_CURL",
    abs: "CRUNCH", obliques: "RUSSIAN_TWIST", glutes: "BARBELL_HIP_THRUST_WITH_BENCH", quads: "LEG_EXTENSION", adductors: "LEG_ADDUCTION", hamstrings: "LEG_CURL", calves: "STANDING_CALF_RAISE",
  };

  const TABLE = MM.MUSCLES.map((m: { id: string; label: string }) => [m.id, m.label]) as [string, string][];
  it.each(TABLE)("%s (%s): a plan workout of its exercise trains it and draws it shaded", (id: string) => {
    const exercise = EXEMPLAR[id];
    expect({ muscle: id, exercise, listed: exercise in (categories as Record<string, string>) }).toEqual({ muscle: id, exercise, listed: true });
    const plan = WM.analyze({ workoutType: "strength_training", steps: [{ stepType: "interval", targetType: "no.target", exerciseName: exercise, endCondition: "reps", endConditionValue: 8, numberOfRepeats: 3, repeatGroupIndex: 0 }] });
    const t = MM.tally(plan.setCounts), trained = t.muscles.find((m: { id: string }) => m.id === id);
    expect(trained).toMatchObject({ id, direct: 3, score: expect.any(Number) });
    expect(trained.score).toBeGreaterThanOrEqual(6);
    const done = MM.tally([{ name: exercise.split("_").map((w: string) => w[0] + w.slice(1).toLowerCase()).join(" "), sets: 3 }]);
    expect(done.muscles.find((m: { id: string }) => m.id === id)).toMatchObject({ id, direct: 3 });
    const paint = (muscle: string) => { const m = t.muscles.find((x: { id: string }) => x.id === muscle); return m ? { fill: MM.fillOf(m.score, t.max), title: `${m.label}` } : null; };
    const fills = [...MM.figure("front", paint).matchAll(new RegExp(`data-muscle="${id}" fill="(#\\w+)"`, "g")), ...MM.figure("back", paint).matchAll(new RegExp(`data-muscle="${id}" fill="(#\\w+)"`, "g"))].map((m: RegExpMatchArray) => m[1]);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((f: string) => f !== MM.fillOf(0, 1))).toBe(true);
  });
});

describe("what a workout trains", () => {
  const WORKOUT = [
    { name: "BARBELL_BENCH_PRESS", sets: 3 },
    { name: "WEIGHTED_CHIN_UP", sets: 3 },
    { name: "LYING_EZ_BAR_TRICEPS_EXTENSION", sets: 2 },
  ];

  it("scores 2 for a set of a primary muscle and 1 for a set of a secondary one", () => {
    const t = MM.tally(WORKOUT), by = Object.fromEntries(t.muscles.map((m: any) => [m.id, m]));
    expect(by.chest).toMatchObject({ direct: 3, indirect: 2, score: 8 });
    expect(by.triceps).toMatchObject({ direct: 2, indirect: 3, score: 7 });
    expect(by.lats).toMatchObject({ direct: 3, indirect: 0, score: 6 });
    expect(by.biceps).toMatchObject({ direct: 3, score: 6 });
    expect(by.upperBack).toMatchObject({ direct: 0, indirect: 3, score: 3 });
    expect(by.quads).toBeUndefined();
    expect(t.max).toBe(8);
    expect(t.muscles[0].id).toBe("chest");
  });

  it("says a muscle's score in sets: a primary set is one, a secondary set is half", () => {
    expect([MM.setsOf(8), MM.setsOf(7), MM.setsOf(3), MM.setsOf(1)]).toEqual(["4", "3.5", "1.5", "0.5"]);
  });

  it("lists what it could not count, and counts nothing for it", () => {
    const t = MM.tally([...WORKOUT, { name: "Cardio", sets: 1 }, { name: "Arm Circles", sets: 2 }]);
    expect(t.unknown).toEqual([{ name: "Cardio", sets: 1 }, { name: "Arm Circles", sets: 2 }]);
    expect(t.max).toBe(8);
    expect(MM.tally([{ name: "Cardio", sets: 1 }]).muscles).toEqual([]);
    expect(MM.tally(undefined)).toEqual({ muscles: [], max: 0, unknown: [] });
  });

  it("takes the sets of a plan workout as WorkoutModel counts them, a superset and a repeat included", () => {
    const step = (over: object) => ({ stepType: "interval", targetType: "no.target", endCondition: "reps", endConditionValue: 8, ...over });
    const a = WM.analyze({
      workoutType: "strength_training",
      steps: [
        step({ exerciseName: "BARBELL_BENCH_PRESS", numberOfRepeats: 3, repeatGroupIndex: 0 }),
        step({ exerciseName: "BARBELL_ROW", numberOfRepeats: 2, repeatGroupIndex: 1 }),
        step({ exerciseName: "STANDING_EZ_BAR_BICEPS_CURL", numberOfRepeats: 2, repeatGroupIndex: 1 }),
        step({ exerciseName: "BARBELL_BENCH_PRESS", numberOfRepeats: 1, repeatGroupIndex: 2 }),
      ],
    });
    expect(a.setCounts).toEqual([{ name: "BARBELL_BENCH_PRESS", sets: 4 }, { name: "BARBELL_ROW", sets: 2 }, { name: "STANDING_EZ_BAR_BICEPS_CURL", sets: 2 }]);
    expect(a.sets).toBe(8);
    expect(WM.analyze({ workoutType: "running", steps: [step({ stepType: "warmup", endCondition: "distance", endConditionValue: 1000 })] }).setCounts).toEqual([]);
  });
});

describe("the colour", () => {
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  it("is one colour, more of it the more sets, and grey for a muscle not trained", () => {
    const grey = MM.fillOf(0, 8), faint = MM.fillOf(1, 8), mid = MM.fillOf(4, 8), full = MM.fillOf(8, 8);
    expect(grey).toBe(MM.fillOf(5, 0));
    expect(channels(full)[0]).toBeGreaterThan(channels(mid)[0]);
    expect(channels(mid)[0]).toBeGreaterThan(channels(faint)[0]);
    expect(channels(faint)[0]).toBeGreaterThan(channels(grey)[0]);
    const [r, g, b] = channels(full);
    expect(r).toBeGreaterThan(200);
    expect(Math.max(g, b)).toBeLessThan(90);
    expect(MM.fillOf(100, 8)).toBe(full);
  });
});

describe("the figures", () => {
  const paint = (id: string) => (id === "chest" ? { fill: "#e8453c", title: "Chest: 4 sets" } : null);

  it("draws the front and the back, each muscle once for each side, with its shade and its title", () => {
    const front = MM.figure("front", paint), back = MM.figure("back", paint);
    expect(front).toMatch(/^<svg /);
    expect(front).toContain('aria-label="Front of the body"');
    expect(back).toContain('aria-label="Back of the body"');
    expect(front).toContain('data-muscle="chest" fill="#e8453c"><title>Chest: 4 sets</title>');
    expect((front.match(/data-muscle="chest"[^>]*>(<title>.*?<\/title>)?(<path[^>]*\/>){2}<\/g>/g) || []).length).toBe(1);
    expect(front).toContain('data-muscle="abs"');
    expect(front).not.toContain('data-muscle="lats"');
    expect(back).toContain('data-muscle="lats"');
    expect(back).not.toContain('data-muscle="abs"');
    expect(back).not.toContain("Chest: 4 sets");
  });

  it("draws every muscle of the list on a figure, so none can be trained and unseen", () => {
    const shown = new Set([...MM.figure("front").matchAll(/data-muscle="(\w+)"/g), ...MM.figure("back").matchAll(/data-muscle="(\w+)"/g)].map((m: RegExpMatchArray) => m[1]));
    for (const m of MM.MUSCLES) expect(shown.has(m.id)).toBe(true);
  });

  it("makes no path of NaN, whatever the points", () => {
    expect(MM.figure("front", paint)).not.toMatch(/NaN|undefined/);
    expect(MM.figure("back")).not.toMatch(/NaN|undefined/);
  });
});

describe("what made a muscle's score", () => {
  const bench = { name: "BARBELL_BENCH_PRESS", sets: 4 }, extension = { name: "CABLE_OVERHEAD_TRICEPS_EXTENSION", sets: 3 };

  it("lists, for each muscle, the exercises that worked it and the ones that only helped", () => {
    const { muscles } = MM.detail([bench, extension]);
    const chest = muscles.find((m: any) => m.id === "chest");
    expect(chest.from).toEqual([{ name: "BARBELL_BENCH_PRESS", sets: 4, kind: "direct" }, { name: "CABLE_OVERHEAD_TRICEPS_EXTENSION", sets: 3, kind: "helps" }]);
    const triceps = muscles.find((m: any) => m.id === "triceps");
    expect(triceps.from.map((f: any) => `${f.name}:${f.kind}`)).toEqual(["BARBELL_BENCH_PRESS:helps", "CABLE_OVERHEAD_TRICEPS_EXTENSION:direct"]);
  });

  it("agrees with tally on the muscles, their order and their scores", () => {
    const t = MM.tally([bench, extension]), d = MM.detail([bench, extension]);
    expect(d.muscles.map((m: any) => [m.id, m.score])).toEqual(t.muscles.map((m: any) => [m.id, m.score]));
    expect(d.max).toBe(t.max);
  });

  it("leaves out an exercise with no known muscles, as tally does, and keeps it as unknown", () => {
    const d = MM.detail([bench, { name: "JUMPING_JACK", sets: 2 }]);
    expect(d.unknown).toEqual([{ name: "JUMPING_JACK", sets: 2 }]);
    expect(d.muscles.every((m: any) => m.from.every((f: any) => f.name !== "JUMPING_JACK"))).toBe(true);
  });

  it("is empty, not an error, for nothing", () => {
    expect(MM.detail([]).muscles).toEqual([]);
    expect(MM.detail(undefined).muscles).toEqual([]);
  });
});

describe("the groups", () => {
  it("cover every muscle of the list once", () => {
    const ids = MM.GROUPS.flatMap((g: any) => g.muscles).sort();
    expect(ids).toEqual(MM.MUSCLES.map((m: any) => m.id).sort());
  });

  it("share the muscle work between push, pull, legs and core in whole percents", () => {
    const shares = MM.groupShares(MM.tally([{ name: "BARBELL_BENCH_PRESS", sets: 4 }, { name: "LAT_PULLDOWN", sets: 4 }]).muscles);
    expect(shares.map((s: any) => s.id)).toEqual(["push", "pull", "legs", "core"]);
    expect(shares.find((s: any) => s.id === "legs").pct).toBe(0);
    expect(shares.reduce((a: number, s: any) => a + s.pct, 0)).toBeGreaterThanOrEqual(99);
    expect(shares.find((s: any) => s.id === "push").score + shares.find((s: any) => s.id === "pull").score).toBe(MM.tally([{ name: "BARBELL_BENCH_PRESS", sets: 4 }, { name: "LAT_PULLDOWN", sets: 4 }]).muscles.reduce((a: number, m: any) => a + m.score, 0));
  });

  it("are all zero, not NaN, when nothing was worked", () => {
    expect(MM.groupShares([]).map((s: any) => s.pct)).toEqual([0, 0, 0, 0]);
  });
});

describe("the muscles that got too little", () => {
  it("lists every muscle under the sets given, the untrained ones too, fewest first", () => {
    const { muscles } = MM.tally([{ name: "BARBELL_BENCH_PRESS", sets: 8 }]);
    const few = MM.fewerThan(muscles, 5);
    expect(few.some((m: any) => m.id === "chest")).toBe(false);
    expect(few.find((m: any) => m.id === "triceps")).toEqual({ id: "triceps", label: "Triceps", sets: 4 });
    expect(few.find((m: any) => m.id === "calves")).toEqual({ id: "calves", label: "Calves", sets: 0 });
    expect(few[0].sets).toBe(0);
    expect(few.map((m: any) => m.sets)).toEqual([...few.map((m: any) => m.sets)].sort((a: number, b: number) => a - b));
  });

  it("is every muscle when nothing was trained", () => {
    expect(MM.fewerThan([], 4)).toHaveLength(MM.MUSCLES.length);
  });
});

describe("the sessions of a period", () => {
  const sessions = [
    { date: "2026-11-01", exercises: [{ name: "A", sets: 2 }] },
    { date: "2026-11-10", exercises: [{ name: "A", sets: 3 }, { name: "B", sets: 1 }] },
    { date: "2026-11-14", exercises: [{ name: "B", sets: 4 }] },
  ];

  it("adds up the sets per exercise of the sessions on the days from one to another, both ends in", () => {
    const sum = MM.sumSessions(sessions, "2026-11-10", "2026-11-14");
    expect(sum.sessions).toBe(2);
    expect(sum.exercises).toEqual([{ name: "A", sets: 3 }, { name: "B", sets: 5 }]);
  });

  it("is empty for a period with no session", () => {
    expect(MM.sumSessions(sessions, "2026-12-01", "2026-12-31")).toEqual({ exercises: [], sessions: 0 });
    expect(MM.sumSessions(undefined, "2026-01-01", "2026-12-31")).toEqual({ exercises: [], sessions: 0 });
  });
});
