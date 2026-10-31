/**
 * The demo database: one profile, Sam, who looks like a runner halfway through a half-marathon block. Nothing here is anyone's
 * data: the numbers come from a seeded random generator, so every run of `npm run demo` (and every recording of the README's
 * GIFs) shows the same picture, dated around the day it runs. The route is a real foot route along Montréal's Lachine Canal
 * (route.json, from OpenStreetMap through OSRM), so the map has streets under it.
 *
 * Sam has no Garmin login: the views that need one (Workouts, the Garmin menu) stay off, the others read what is stored here.
 */
import { getStore, type FoodFields, type Meal } from "../../src/shared/store";
import { toNewActivity } from "../../src/shared/activitySync";
import route from "./route.json";

export const DEMO_USER = "Sam";
export const DEMO_PASSWORD = "demo-password";
export const DEMO_ADMIN_TOKEN = "demo-admin-token";

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (offset: number) => iso(new Date(Date.now() + offset * DAY));
const weekday = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday 0
const mondayOffset = -weekday(day(0));

/** mulberry32: the same numbers on every run. */
function prng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(20261031);
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const round = (n: number, step = 1) => Math.round(n / step) * step;

// ─── the plans ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** m/s from a pace in min:sec per km. */
const mps = (min: number, sec: number) => Math.round((1000 / (min * 60 + sec)) * 1000) / 1000;
const hrZone = (lo: number, hi: number) => ({ targetType: "heart.rate.zone", targetValueOne: lo, targetValueTwo: hi });
const set = (exerciseName: string, reps: number, weight: number | undefined, rest: number, sets: number) => ({
  stepType: "repeat",
  targetType: "no.target",
  numberOfRepeats: sets,
  endCondition: "iterations",
  endConditionValue: sets,
  repeatSteps: [
    { stepType: "exercise", exerciseName, targetType: "no.target", endCondition: "reps", endConditionValue: reps, ...(weight ? { weight } : {}) },
    { stepType: "rest", targetType: "no.target", endCondition: "time", endConditionValue: rest },
  ],
});

/** The workouts of the build, with the weekday each falls on, counted from today's (so today always has the tempo). */
const BUILD = [
  {
    at: 0,
    workout: {
      workoutId: 81_001,
      workoutName: "Tempo 3 x 2 km",
      workoutType: "running",
      description: "Comfortably hard: the pace you could hold for an hour.",
      steps: [
        { stepType: "warmup", ...hrZone(120, 145), endCondition: "time", endConditionValue: 900 },
        {
          stepType: "repeat",
          targetType: "no.target",
          numberOfRepeats: 3,
          endCondition: "iterations",
          endConditionValue: 3,
          repeatSteps: [
            { stepType: "interval", targetType: "pace.zone", targetValueOne: mps(4, 40), targetValueTwo: mps(4, 30), endCondition: "distance", endConditionValue: 2000 },
            { stepType: "recovery", targetType: "no.target", endCondition: "time", endConditionValue: 120 },
          ],
        },
        { stepType: "cooldown", ...hrZone(110, 140), endCondition: "time", endConditionValue: 600 },
      ],
    },
  },
  {
    at: 1,
    workout: {
      workoutId: 81_002,
      workoutName: "Long run",
      workoutType: "running",
      description: "Easy and steady. Last 3 km at half-marathon pace if it feels good.",
      steps: [
        { stepType: "interval", ...hrZone(130, 148), endCondition: "distance", endConditionValue: 15000 },
        { stepType: "interval", targetType: "pace.zone", targetValueOne: mps(4, 55), targetValueTwo: mps(4, 45), endCondition: "distance", endConditionValue: 3000 },
      ],
    },
  },
  {
    at: 2,
    workout: {
      workoutId: 81_003,
      workoutName: "Strength A",
      workoutType: "strength_training",
      description: "Heavy and short. Stop each set with two reps in the tank.",
      steps: [
        set("BARBELL_BACK_SQUAT", 5, 185, 120, 3),
        set("BARBELL_BENCH_PRESS", 6, 145, 120, 3),
        set("BENT_OVER_ROW_WITH_BARBELL", 8, 115, 90, 3),
        set("PULL_UP", 8, undefined, 90, 3),
        set("ROMANIAN_DEADLIFT", 8, 155, 90, 2),
        { stepType: "exercise", exerciseName: "PLANK", targetType: "no.target", endCondition: "time", endConditionValue: 60 },
      ],
    },
  },
  {
    at: 3,
    workout: {
      workoutId: 81_004,
      workoutName: "Easy run",
      workoutType: "running",
      description: "Conversational pace, nose breathing.",
      steps: [{ stepType: "interval", ...hrZone(128, 145), endCondition: "distance", endConditionValue: 8000 }],
    },
  },
  {
    at: 4,
    workout: {
      workoutId: 81_005,
      workoutName: "Intervals 6 x 800 m",
      workoutType: "running",
      description: "5K pace on the reps, jog the recoveries.",
      steps: [
        { stepType: "warmup", ...hrZone(120, 145), endCondition: "time", endConditionValue: 900 },
        {
          stepType: "repeat",
          targetType: "no.target",
          numberOfRepeats: 6,
          endCondition: "iterations",
          endConditionValue: 6,
          repeatSteps: [
            { stepType: "interval", targetType: "pace.zone", targetValueOne: mps(4, 15), targetValueTwo: mps(4, 5), endCondition: "distance", endConditionValue: 800 },
            { stepType: "recovery", targetType: "no.target", endCondition: "distance", endConditionValue: 400 },
          ],
        },
        { stepType: "cooldown", targetType: "no.target", endCondition: "lap.button" },
      ],
    },
  },
];

const BUILD_WEEKS = [-3, -2, -1, 0, 1, 2, 3];
/** The day of a build workout in a week (0 is this week), or null when that falls outside it. */
const buildDay = (week: number, at: number) => day(mondayOffset + week * 7 + ((weekday(day(0)) + at) % 7));

function buildPlan() {
  return {
    weekStart: day(mondayOffset + BUILD_WEEKS[0] * 7),
    weekEnd: day(mondayOffset + BUILD_WEEKS[BUILD_WEEKS.length - 1] * 7 + 6),
    generatedAt: new Date().toISOString(),
    goal: "Half marathon under 1:45",
    workouts: BUILD.map(({ at, workout }) => ({ ...workout, scheduledDate: BUILD_WEEKS.map((w) => buildDay(w, at)) })),
  };
}

function mobilityPlan() {
  const taken = new Set(buildPlan().workouts.flatMap((w) => w.scheduledDate));
  const days = [-12, -9, -5, -2, 2, 5, 9, 12].map((d) => day(d)).filter((d) => !taken.has(d));
  return {
    weekStart: day(mondayOffset - 14),
    weekEnd: day(mondayOffset + 13),
    workouts: [
      {
        workoutName: "Mobility & core",
        workoutType: "strength_training",
        description: "20 minutes, any time of day.",
        scheduledDate: days,
        steps: [
          set("GLUTE_BRIDGE", 12, undefined, 30, 3),
          set("WALKING_LUNGE", 10, undefined, 30, 2),
          set("HANGING_KNEE_RAISE", 10, undefined, 45, 3),
          { stepType: "exercise", exerciseName: "PLANK", targetType: "no.target", endCondition: "time", endConditionValue: 45 },
        ],
      },
    ],
  };
}

function taperPlan() {
  const start = mondayOffset + 4 * 7;
  return {
    weekStart: day(start),
    weekEnd: day(start + 6),
    workouts: [
      { workoutName: "Shakeout", workoutType: "running", scheduledDate: [day(start + 1), day(start + 4)], steps: [{ stepType: "interval", ...hrZone(125, 140), endCondition: "time", endConditionValue: 1800 }] },
      {
        workoutName: "Race-pace tune-up",
        workoutType: "running",
        scheduledDate: day(start + 2),
        steps: [
          { stepType: "warmup", targetType: "no.target", endCondition: "time", endConditionValue: 600 },
          { stepType: "interval", targetType: "pace.zone", targetValueOne: mps(4, 58), targetValueTwo: mps(4, 52), endCondition: "distance", endConditionValue: 5000 },
          { stepType: "cooldown", targetType: "no.target", endCondition: "time", endConditionValue: 600 },
        ],
      },
      { workoutName: "Half marathon", workoutType: "running", description: "Race day.", scheduledDate: day(start + 6), steps: [{ stepType: "interval", targetType: "pace.zone", targetValueOne: mps(5, 0), targetValueTwo: mps(4, 52), endCondition: "distance", endConditionValue: 21100 }] },
    ],
  };
}

const ideasPlan = () => ({
  weekStart: "2026-01-05",
  weekEnd: "2026-01-11",
  workouts: [
    {
      workoutName: "Hill repeats",
      workoutType: "running",
      steps: [
        { stepType: "warmup", targetType: "no.target", endCondition: "time", endConditionValue: 900 },
        { stepType: "repeat",
  targetType: "no.target", numberOfRepeats: 8, endCondition: "iterations", endConditionValue: 8, repeatSteps: [{ stepType: "interval", targetType: "no.target", endCondition: "time", endConditionValue: 60 }, { stepType: "recovery", targetType: "no.target", endCondition: "time", endConditionValue: 90 }] },
        { stepType: "cooldown", targetType: "no.target", endCondition: "time", endConditionValue: 600 },
      ],
    },
  ],
});

// ─── the activities ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface Run {
  name: string;
  km: number;
  pace: number; // seconds a km
  hr: number;
  label: string;
  aerobic: number;
  workoutId?: number;
}

let nextId = 17_400_000_000;
const acts: any[] = [];
const runAt = (offset: number, hour: number, r: Run, over: Record<string, unknown> = {}) => {
  const d = day(offset);
  const meters = round(r.km * 1000, 10);
  const duration = Math.round((meters / 1000) * r.pace);
  const zone = (share: number) => Math.round(duration * share);
  const hard = (r.hr - 130) / 40;
  const item = {
    activityId: nextId++,
    activityName: r.name,
    activityType: { typeKey: "running" },
    startTimeGMT: `${d} ${String(hour).padStart(2, "0")}:${String(round(between(0, 50))).padStart(2, "0")}:00`,
    startTimeLocal: `${d} ${String(hour).padStart(2, "0")}:${String(round(between(0, 50))).padStart(2, "0")}:00`,
    distance: meters,
    duration,
    movingDuration: duration - round(between(5, 40)),
    averageSpeed: Math.round((meters / duration) * 1000) / 1000,
    maxSpeed: Math.round((1000 / (r.pace - 50)) * 1000) / 1000,
    averageHR: r.hr,
    maxHR: r.hr + round(between(10, 22)),
    minHR: 92 + round(between(0, 10)),
    calories: Math.round(r.km * 68),
    elevationGain: round(r.km * between(4, 9)),
    elevationLoss: round(r.km * between(4, 9)),
    averageRunningCadenceInStepsPerMinute: round(between(166, 176)),
    avgStrideLength: round(between(105, 118)),
    steps: round(r.km * 1300),
    aerobicTrainingEffect: r.aerobic,
    anaerobicTrainingEffect: Math.round(hard * 25) / 10,
    trainingEffectLabel: r.label,
    vO2MaxValue: 52,
    locationName: "Montréal",
    hrTimeInZone_1: zone(0.08),
    hrTimeInZone_2: zone(0.5 - hard * 0.3),
    hrTimeInZone_3: zone(0.3),
    hrTimeInZone_4: zone(0.1 + hard * 0.25),
    hrTimeInZone_5: zone(0.02 + hard * 0.05),
    ...(r.km >= 1 ? { fastestSplit_1000: Math.round(r.pace - 15 - hard * 25) } : {}),
    ...(r.km >= 1.61 ? { fastestSplit_1609: Math.round((r.pace - 12 - hard * 20) * 1.609) } : {}),
    ...(r.km >= 5 ? { fastestSplit_5000: Math.round((r.pace - 6 - hard * 15) * 5) } : {}),
    ...(r.km >= 10 ? { fastestSplit_10000: Math.round((r.pace - 2 - hard * 10) * 10) } : {}),
    ...(r.workoutId ? { workoutId: r.workoutId } : {}),
    ...over,
  };
  acts.push(item);
  return item;
};

const other = (offset: number, hour: number, type: string, name: string, minutes: number, km: number, hr: number, over: Record<string, unknown> = {}) => {
  const d = day(offset);
  const item = {
    activityId: nextId++,
    activityName: name,
    activityType: { typeKey: type },
    startTimeGMT: `${d} ${String(hour).padStart(2, "0")}:15:00`,
    startTimeLocal: `${d} ${String(hour).padStart(2, "0")}:15:00`,
    distance: Math.round(km * 1000),
    duration: minutes * 60,
    averageHR: hr,
    maxHR: hr + 25,
    averageSpeed: km ? Math.round(((km * 1000) / (minutes * 60)) * 1000) / 1000 : undefined,
    calories: Math.round(minutes * (hr - 60) * 0.11),
    elevationGain: km ? round(km * 9) : undefined,
    aerobicTrainingEffect: Math.round((hr - 90) / 2) / 10,
    ...(type === "strength_training" ? {} : { trainingEffectLabel: type === "cycling" ? "AEROBIC_BASE" : "RECOVERY" }),
    ...over,
  };
  acts.push(item);
  return item;
};

/** Garmin's sets of a strength session, weights in grams; the bar grows a little each week. */
function strengthSets(progress: number) {
  const lb = (n: number) => Math.round(n * 453.592);
  const lifts: [string, string, number, number, number][] = [
    ["BARBELL_BACK_SQUAT", "SQUAT", 5, 165 + progress * 5, 3],
    ["BARBELL_BENCH_PRESS", "BENCH_PRESS", 6, 130 + progress * 2.5, 3],
    ["BENT_OVER_ROW_WITH_BARBELL", "ROW", 8, 105 + progress * 2.5, 3],
    ["PULL_UP", "PULL_UP", 8, 0, 3],
    ["ROMANIAN_DEADLIFT", "DEADLIFT", 8, 145 + progress * 5, 2],
  ];
  const sets: any[] = [];
  let n = 0;
  for (const [name, category, reps, weight, count] of lifts)
    for (let i = 0; i < count; i++) {
      sets.push({ setType: "ACTIVE", exercises: [{ category, name, probability: 98 }], duration: 35, repetitionCount: reps - (i === count - 1 && rand() < 0.3 ? 1 : 0), weight: weight ? lb(weight) : 0, startTime: "2026-01-01T18:00:00.0", wktStepIndex: n, messageIndex: n++ });
      sets.push({ setType: "REST", exercises: [], duration: 110, repetitionCount: null, weight: null, wktStepIndex: n, messageIndex: n++ });
    }
  return sets;
}

function activities(store: ReturnType<typeof getStore>) {
  const strength: [any, number][] = [];
  // Ten weeks: three weeks of base before the build, then the build up to yesterday.
  for (let week = -10; week <= 0; week++) {
    const inBuild = week >= BUILD_WEEKS[0];
    const k = week + 10; // 0 … 10, how far along
    for (const { at, workout } of BUILD) {
      const d = buildDay(week, at);
      const offset = Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${day(0)}T00:00:00Z`)) / DAY);
      if (offset >= 0) continue; // today's tempo is still to do
      if (inBuild && week === -1 && at === 3) continue; // one easy run skipped: the calendar shows it missed
      const id = inBuild ? workout.workoutId : undefined;
      const pace = (base: number) => Math.round(base - k * 1.5 + between(-6, 6));
      if (at === 0) runAt(offset, 8, { name: inBuild ? workout.workoutName : "Tempo run", km: 9.5 + between(-0.3, 0.6), pace: pace(292), hr: 158, label: "TEMPO", aerobic: 3.8, workoutId: id });
      if (at === 1) runAt(offset, 9, { name: "Long run", km: 13 + k * 0.5 + between(-0.4, 0.4), pace: pace(345), hr: 143, label: "AEROBIC_BASE", aerobic: 3.4, workoutId: id });
      if (at === 3) runAt(offset, 7, { name: "Easy run", km: 8 + between(-0.6, 0.8), pace: pace(338), hr: 138, label: "AEROBIC_BASE", aerobic: 2.6, workoutId: id });
      if (at === 4) runAt(offset, 7, { name: inBuild ? workout.workoutName : "Fartlek", km: 9 + between(-0.2, 0.4), pace: pace(300), hr: 152, label: "VO2MAX", aerobic: 3.6, workoutId: id });
      if (at === 2) strength.push([other(offset, 18, "strength_training", inBuild ? "Strength A" : "Gym", 52, 0, 112, { workoutId: id, totalSets: 14, totalReps: 92 }), k]);
    }
  }
  for (const [offset, km] of [[-61, 42], [-40, 36], [-26, 48], [-12, 38]] as const) other(offset, 10, "cycling", "Lachine Canal ride", Math.round(km * 2.3), km, 128);
  other(-33, 11, "hiking", "Mont-Royal hike", 95, 7.2, 108);
  other(-19, 11, "hiking", "Mont-Royal hike", 88, 6.9, 106);
  other(0, 7, "walking", "Morning walk", 32, 2.6, 96);

  store.activities.insertNew(DEMO_USER, acts.map((a) => toNewActivity(a)!));

  // The strength sessions carry their sets, so the gym's muscles and % of 1RM are drawn.
  for (const [a, k] of strength) store.activities.setDetail(DEMO_USER, String(a.activityId), { activityId: a.activityId, summaryDTO: { directWorkoutRpe: 70, calories: a.calories }, fullExerciseSets: strengthSets(k), ...(a.workoutId ? { metadataDTO: { associatedWorkoutId: a.workoutId } } : {}) });

  // The last two runs of each kind have their charts: the route along the canal, the series, the laps.
  const runs = acts.filter((a) => a.activityType.typeKey === "running").sort((a, b) => b.startTimeGMT.localeCompare(a.startTimeGMT));
  for (const name of ["Intervals 6 x 800 m", "Easy run", "Long run", "Tempo 3 x 2 km"]) for (const a of runs.filter((r) => r.activityName === name).slice(0, 2)) charted(store, a);
}

/** The laps of a run as the watch splits it: the structured workout's steps, or a lap a km. */
function lapsOf(a: any): { meters: number; pace: number; hr: number; kind: string; step?: number }[] {
  const pace = a.duration / (a.distance / 1000);
  if (a.activityName.startsWith("Intervals")) {
    const laps = [{ meters: 2600, pace: 352, hr: 136, kind: "WARMUP", step: 0 }];
    for (let i = 0; i < 6; i++) laps.push({ meters: 800, pace: 250 + between(-4, 5) - (i === 5 ? 6 : 0), hr: 166 + i * 2, kind: "INTERVAL", step: 1 }, { meters: 400, pace: 400 + between(-15, 15), hr: 142 + i, kind: "RECOVERY", step: 2 });
    laps.push({ meters: a.distance - 2600 - 6 * 1200, pace: 360, hr: 140, kind: "COOLDOWN", step: 3 });
    return laps;
  }
  if (a.activityName.startsWith("Tempo")) {
    const laps = [{ meters: 2700, pace: 340, hr: 138, kind: "WARMUP", step: 0 }];
    for (let i = 0; i < 3; i++) laps.push({ meters: 2000, pace: 276 + between(-3, 3), hr: 160 + i * 3, kind: "INTERVAL", step: 1 }, ...(i < 2 ? [{ meters: 300, pace: 420, hr: 148, kind: "RECOVERY", step: 2 }] : []));
    laps.push({ meters: Math.max(800, a.distance - 2700 - 6600), pace: 350, hr: 142, kind: "COOLDOWN", step: 3 });
    return laps;
  }
  const out = [];
  for (let done = 0; done < a.distance - 1; done += 1000) out.push({ meters: Math.min(1000, a.distance - done), pace: pace + between(-8, 8) - (a.activityName === "Long run" && done > a.distance - 3500 ? 30 : 0), hr: a.averageHR + between(-4, 5) + (done / a.distance) * 6, kind: "ACTIVE" });
  return out;
}

/** The route, run as many times round as the distance needs, with the distance along it at each point. */
function routeFor(meters: number) {
  const pts = route as [number, number][];
  const leg = (a: [number, number], b: [number, number]) => {
    const x = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * (Math.PI / 180)) * 111_320, y = (b[0] - a[0]) * 110_540;
    return Math.hypot(x, y);
  };
  const out: { lat: number; lon: number; distanceInMeters: number }[] = [];
  let along = 0;
  for (let i = 0; along < meters; i = (i + 1) % pts.length) {
    if (out.length) along += leg(pts[(i - 1 + pts.length) % pts.length], pts[i]);
    out.push({ lat: pts[i][0], lon: pts[i][1], distanceInMeters: Math.min(along, meters) });
  }
  return out;
}

function charted(store: ReturnType<typeof getStore>, a: any) {
  const laps = lapsOf(a);
  const rows: { metrics: number[] }[] = [];
  let meters = 0, seconds = 0, hr = 105;
  const step = 15; // a sample every 15 s
  for (const lap of laps) {
    const end = meters + lap.meters;
    while (meters < end) {
      const speed = 1000 / (lap.pace + between(-6, 6));
      meters = Math.min(end, meters + speed * step);
      seconds += step;
      hr += (lap.hr - hr) * 0.25 + between(-1.5, 1.5);
      const elevation = 22 + 9 * Math.sin(meters / 900) + 4 * Math.sin(meters / 260);
      rows.push({ metrics: [Math.round(hr), Math.round(meters), seconds, Math.round(speed * 100) / 100, Math.round(elevation * 10) / 10, Math.round(between(168, 178) - (lap.kind === "RECOVERY" ? 8 : 0))] });
    }
  }
  const lapDTOs = laps.map((l, i) => {
    const duration = Math.round((l.meters / 1000) * l.pace);
    return { lapIndex: i + 1, startTimeGMT: a.startTimeGMT, distance: Math.round(l.meters), duration, movingDuration: duration, averageSpeed: Math.round((1000 / l.pace) * 1000) / 1000, averageHR: Math.round(l.hr), maxHR: Math.round(l.hr + between(4, 9)), intensityType: l.kind, ...(l.step !== undefined ? { wktStepIndex: l.step } : {}), elevationGain: round(between(2, 12)) };
  });
  store.activities.setDetail(DEMO_USER, String(a.activityId), {
    activityId: a.activityId,
    ...(a.workoutId ? { metadataDTO: { associatedWorkoutId: a.workoutId } } : {}),
    summaryDTO: { maxHR: a.maxHR, minHR: a.minHR, averageSpeed: a.averageSpeed, calories: a.calories, trainingEffectLabel: a.trainingEffectLabel, aerobicTrainingEffect: a.aerobicTrainingEffect, directWorkoutRpe: a.averageHR > 150 ? 70 : 30, directWorkoutFeel: 75 },
  });
  store.activities.setChart(DEMO_USER, String(a.activityId), {
    details: {
      metricDescriptors: ["directHeartRate", "sumDistance", "sumDuration", "directSpeed", "directElevation", "directRunCadence"].map((key, metricsIndex) => ({ metricsIndex, key })),
      activityDetailMetrics: rows,
      geoPolylineDTO: { polyline: routeFor(a.distance) },
    },
    splits: { lapDTOs },
    zones: [1, 2, 3, 4, 5].map((zoneNumber) => ({ zoneNumber, secsInZone: a[`hrTimeInZone_${zoneNumber}`], zoneLowBoundary: [98, 118, 137, 156, 173][zoneNumber - 1] })),
  });
}

// ─── health ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

function health(store: ReturnType<typeof getStore>) {
  const runDays = new Set(acts.filter((a) => a.activityType.typeKey !== "walking").map((a) => a.startTimeGMT.slice(0, 10)));
  let hrvWeek: number[] = [];
  for (let d = -69; d <= 0; d++) {
    const date = day(d);
    const trained = runDays.has(date);
    // A rough patch two weeks ago (a cold): lower HRV, higher resting HR, poorer sleep.
    const dip = d >= -16 && d <= -13 ? 1 : 0;
    const hrv = Math.round(60 + 3 * Math.sin(d / 5) + between(-4, 4) - dip * 12);
    hrvWeek = [...hrvWeek.slice(-6), hrv];
    const rhr = Math.round(47 + between(-1.5, 1.5) + dip * 5 + (trained ? 0.5 : 0));
    const sleepSeconds = round((d === 0 ? 7.6 : between(6.4, 8.3) - dip * 0.8) * 3600, 60);
    const score = Math.max(55, Math.min(94, Math.round(55 + (sleepSeconds / 3600 - 6) * 13 + between(-5, 5) - dip * 10)));
    const deep = round(sleepSeconds * between(0.16, 0.22), 60), rem = round(sleepSeconds * between(0.2, 0.26), 60);
    store.wellness.put(DEMO_USER, date, "sleep", {
      dailySleepDTO: { calendarDate: date, sleepTimeSeconds: sleepSeconds, deepSleepSeconds: deep, remSleepSeconds: rem, lightSleepSeconds: sleepSeconds - deep - rem, awakeSleepSeconds: round(between(600, 1800), 60), awakeCount: round(between(1, 4)), avgSleepStress: round(between(12, 22)), averageRespirationValue: Math.round((14 + between(-0.6, 0.6) + dip) * 10) / 10, sleepScores: { overall: { value: score, qualifierKey: score >= 80 ? "GOOD" : "FAIR" } }, sleepNeed: { baseline: 470, actual: 470 + (trained ? 15 : 0) + dip * 30 } },
      avgOvernightHrv: hrv,
      hrvStatus: "BALANCED",
      restingHeartRate: rhr,
    });
    store.wellness.put(DEMO_USER, date, "hrv", {
      hrvSummary: { calendarDate: date, weeklyAvg: Math.round(hrvWeek.reduce((s, v) => s + v, 0) / hrvWeek.length), lastNightAvg: hrv, lastNight5MinHigh: hrv + 22, baseline: { lowUpper: 48, balancedLow: 53, balancedUpper: 68, markerValue: 0.5 }, status: hrv < 53 ? "UNBALANCED" : "BALANCED" },
      hrvReadings: [],
    });
    const active = trained ? round(between(750, 1100)) : round(between(380, 600));
    const wake = Math.max(30, Math.min(98, Math.round(score - 5 + between(-6, 8) - dip * 15)));
    const partOfDay = d === 0 ? 0.45 : 1; // today: as far as the watch has synced
    store.wellness.put(DEMO_USER, date, "summary", {
      calendarDate: date,
      totalSteps: round((trained ? between(12_000, 17_000) : between(6_500, 10_500)) * partOfDay),
      dailyStepGoal: 9_000,
      totalDistanceMeters: round((trained ? between(10_000, 15_000) : between(5_000, 8_000)) * partOfDay),
      restingHeartRate: rhr,
      lastSevenDaysAvgRestingHeartRate: 47 + dip * 2,
      averageStressLevel: round(between(22, 34) + dip * 8),
      maxStressLevel: round(between(70, 92)),
      bodyBatteryAtWakeTime: wake,
      bodyBatteryHighestValue: wake,
      bodyBatteryLowestValue: d === 0 ? 61 : round(between(12, 30)),
      bodyBatteryChargedValue: round(between(45, 70)),
      bodyBatteryDrainedValue: round(between(50, 75)),
      bodyBatteryMostRecentValue: d === 0 ? 64 : round(between(15, 30)),
      moderateIntensityMinutes: round((trained ? between(10, 25) : between(5, 25)) * partOfDay),
      vigorousIntensityMinutes: d === 0 ? 0 : trained ? round(between(12, 30)) : 0,
      intensityMinutesGoal: 150,
      totalKilocalories: round((1_780 + active) * partOfDay),
      activeKilocalories: round(active * partOfDay),
      bmrKilocalories: round(1_780 * partOfDay),
      avgWakingRespirationValue: 16,
      highestRespirationValue: 22,
      lowestRespirationValue: 11,
      lastSyncTimestampGMT: d === 0 ? new Date(Date.now() - 22 * 60_000).toISOString().slice(0, 23) : `${date}T23:30:00.000`,
    });
    store.wellness.put(DEMO_USER, date, "spo2", { avgSleepSpO2: round(between(94, 97)), lowestSpO2: round(between(88, 92)) });
    if (d % 2 === 0 || d === -69) {
      const kg = 79.6 - ((d + 69) / 69) * 2.4 + between(-0.35, 0.35);
      const fat = 17.4 - ((d + 69) / 69) * 1.5 + between(-0.25, 0.25);
      const entry = { samplePk: 1, calendarDate: date, weight: round(kg * 1000, 100), bmi: Math.round((kg / 1.78 ** 2) * 10) / 10, bodyFat: Math.round(fat * 10) / 10, bodyWater: 58.2, boneMass: 3_600, muscleMass: round((36.3 + between(-0.2, 0.2)) * 1000, 100), sourceType: "INDEX_SCALE", weightDelta: 0 };
      store.wellness.put(DEMO_USER, date, "weight", { startDate: date, endDate: date, dateWeightList: [entry], totalAverage: { from: 0, until: 0, weight: entry.weight, bmi: entry.bmi, bodyFat: entry.bodyFat, muscleMass: entry.muscleMass } });
    }
  }
}

// ─── food ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Food = [name: string, kcal: number, p: number, c: number, f: number, nutrients?: Record<string, number>];
const MENU: Record<Meal, Food[][]> = {
  breakfast: [
    [["Oatmeal with blueberries", 340, 11, 58, 7, { fiberG: 8, sugarsG: 12, sodiumMg: 10, potassiumMg: 380, ironMg: 3 }], ["Coffee with milk", 35, 2, 3, 2, { calciumMg: 70 }]],
    [["Greek yogurt, 2%", 150, 20, 8, 4, { sugarsG: 7, calciumMg: 220, sodiumMg: 70 }], ["Granola", 210, 5, 30, 8, { fiberG: 3, sugarsG: 10 }], ["Banana", 105, 1, 27, 0, { fiberG: 3, potassiumMg: 420 }]],
    [["2 scrambled eggs", 180, 12, 2, 14, { cholesterolMg: 370, sodiumMg: 180 }], ["Whole wheat toast with butter", 170, 5, 22, 7, { fiberG: 3, sodiumMg: 230 }], ["Orange juice", 110, 2, 26, 0, { potassiumMg: 450 }]],
  ],
  lunch: [
    [["Chicken burrito bowl", 640, 42, 72, 18, { fiberG: 12, sodiumMg: 1150, ironMg: 4 }]],
    [["Tuna sandwich", 420, 28, 40, 15, { fiberG: 5, sodiumMg: 780 }], ["Apple", 95, 0, 25, 0, { fiberG: 4 }]],
    [["Lentil soup", 280, 16, 40, 6, { fiberG: 14, sodiumMg: 820, ironMg: 5 }], ["Sourdough bread", 180, 6, 34, 1, { sodiumMg: 360 }], ["Cheddar, 30 g", 120, 7, 0, 10, { calciumMg: 200, satFatG: 6 }]],
  ],
  dinner: [
    [["Salmon with rice and broccoli", 690, 44, 70, 24, { fiberG: 5, sodiumMg: 420, potassiumMg: 950 }]],
    [["Spaghetti bolognese", 720, 38, 88, 22, { fiberG: 8, sodiumMg: 900, ironMg: 5 }], ["Green salad", 90, 2, 6, 7, { fiberG: 3 }]],
    [["Chicken stir-fry with noodles", 650, 40, 74, 18, { fiberG: 6, sodiumMg: 1300 }]],
  ],
  snack: [
    [["Protein shake", 160, 30, 5, 2, { calciumMg: 250 }]],
    [["Almonds, 30 g", 170, 6, 6, 15, { fiberG: 4, calciumMg: 80 }], ["Apple", 95, 0, 25, 0, { fiberG: 4 }]],
    [["Chocolate milk", 190, 8, 30, 5, { sugarsG: 26, calciumMg: 280 }]],
  ],
};

function food(store: ReturnType<typeof getStore>) {
  const items: FoodFields[] = [];
  const add = (date: string, meal: Meal, foods: Food[]) => foods.forEach(([name, kcal, proteinG, carbsG, fatG, nutrients]) => items.push({ day: date, meal, name, kcal, proteinG, carbsG, fatG, nutrients }));
  for (let d = -21; d <= -1; d++)
    for (const meal of Object.keys(MENU) as Meal[]) if (meal !== "snack" || rand() < 0.75) add(day(d), meal, MENU[meal][Math.floor(rand() * MENU[meal].length)]);
  // Today, so far: breakfast and lunch.
  add(day(0), "breakfast", MENU.breakfast[0]);
  add(day(0), "lunch", MENU.lunch[0]);
  store.nutrition.add(DEMO_USER, items, "web");
  store.goals.set(DEMO_USER, { kcal: 2400, proteinG: 150, carbsG: 290, fatG: 75, fiberG: 30, sodiumMg: 2300 });
}

export function seedDemo(): void {
  const store = getStore();
  store.profiles.add(DEMO_USER);
  store.profiles.setWebPassword(DEMO_USER, DEMO_PASSWORD);
  const put = (path: string, doc: unknown) => store.put(path, JSON.stringify(doc, null, 2), { create: true, owner: DEMO_USER, source: "demo" });
  put("workout-plans/half-marathon-build.json", buildPlan());
  put("workout-plans/mobility-and-core.json", mobilityPlan());
  put("workout-plans/race-week.json", taperPlan());
  put("workout-plans/ideas.json", ideasPlan());
  activities(store);
  health(store);
  food(store);
}
