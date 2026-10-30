/**
 * The database the suite runs against, built once before the server starts. Nothing here is anyone's data.
 *
 *   alice  signs in with a password, has no Garmin login, and has what a profile that once synced would hold: activities,
 *          health data, weigh-ins, a plan, food. Specs that only read use her.
 *   bob    signs in with a password and has nothing: the views that need data are hidden for him, and he must not see alice's.
 *
 * A spec that changes things makes a profile of its own (see fixtures.ts), so specs can run in parallel.
 */
import { getStore, type Meal } from "../../src/shared/store";
import { toNewActivity } from "../../src/shared/activitySync";
import { hrvResponse, sleepResponse, summaryResponse, weightResponse } from "../../src/__tests__/fixtures/wellness";
import { daysAgo, daysAhead, mondayOf, today } from "./dates";

export const ADMIN_TOKEN = "e2e-admin-token";
export const PASSWORD = "correct horse battery";

/** A run plan whose workouts fall on days around today: one done (an activity carries its id), one today, two coming. */
export const alicePlan = () => ({
  weekStart: mondayOf(today()),
  weekEnd: daysAhead(6 - ((new Date().getUTCDay() + 6) % 7)),
  generatedAt: new Date().toISOString(),
  workouts: [
    {
      workoutId: 7001,
      workoutName: "Easy run",
      workoutType: "running",
      description: "Conversational pace",
      scheduledDate: daysAgo(2),
      distanceMeters: 8000,
      steps: [{ stepType: "interval", targetType: "no.target", endCondition: "distance", endConditionValue: 8000 }],
    },
    {
      workoutName: "Tempo intervals",
      workoutType: "running",
      scheduledDate: today(),
      steps: [
        { stepType: "warmup", targetType: "no.target", endCondition: "time", endConditionValue: 600 },
        {
          stepType: "repeat",
          numberOfRepeats: 4,
          endCondition: "iterations",
          endConditionValue: 4,
          repeatSteps: [
            { stepType: "interval", targetType: "pace.zone", targetValueOne: 3.6, targetValueTwo: 3.9, endCondition: "distance", endConditionValue: 1000 },
            { stepType: "recovery", targetType: "no.target", endCondition: "time", endConditionValue: 120 },
          ],
        },
        { stepType: "cooldown", targetType: "no.target", endCondition: "time", endConditionValue: 600 },
      ],
    },
    { workoutName: "Long run", workoutType: "running", scheduledDate: daysAhead(3), distanceMeters: 16000, steps: [{ stepType: "interval", targetType: "no.target", endCondition: "distance", endConditionValue: 16000 }] },
    {
      workoutName: "Full body strength",
      workoutType: "strength_training",
      scheduledDate: [daysAhead(1), daysAhead(5)],
      steps: [
        { stepType: "exercise", exerciseName: "BARBELL_BACK_SQUAT", targetType: "no.target", endCondition: "reps", endConditionValue: 5 },
        { stepType: "rest", targetType: "no.target", endCondition: "time", endConditionValue: 90 },
        { stepType: "exercise", exerciseName: "BARBELL_BENCH_PRESS", targetType: "no.target", endCondition: "reps", endConditionValue: 8 },
      ],
    },
  ],
});

/** An older plan with no dates at all, to see the calendar's "No dates yet". */
export const undatedPlan = () => ({ weekStart: "2026-01-05", weekEnd: "2026-01-11", workouts: [{ workoutName: "Someday run", workoutType: "running", distanceMeters: 5000 }] });

const listItem = (id: number, day: string, hour: number, type: string, over: Record<string, unknown> = {}) => ({
  activityId: id,
  activityName: `${type === "running" ? "Morning run" : type === "strength_training" ? "Gym session" : "Ride"} ${id}`,
  activityType: { typeKey: type },
  startTimeGMT: `${day} ${String(hour).padStart(2, "0")}:00:00`,
  startTimeLocal: `${day} ${String(hour).padStart(2, "0")}:00:00`,
  duration: type === "strength_training" ? 3000 : 2400,
  distance: type === "running" ? 8000 : type === "cycling" ? 25000 : 0,
  averageHR: 148,
  maxHR: 171,
  averageSpeed: type === "running" ? 3.3 : 6,
  calories: 520,
  elevationGain: 80,
  ...over,
});

export function seed(): void {
  const store = getStore();

  for (const name of ["alice", "bob"]) store.profiles.add(name);
  store.profiles.setWebPassword("alice", PASSWORD);
  store.profiles.setWebPassword("bob", PASSWORD);

  // plans (owned by the profile, so bob never sees them)
  store.put("workout-plans/alice-run-block.json", JSON.stringify(alicePlan(), null, 2), { create: true, owner: "alice", source: "e2e" });
  store.put("workout-plans/alice-someday.json", JSON.stringify(undatedPlan(), null, 2), { create: true, owner: "alice", source: "e2e" });
  store.put("workout-plans/shared-base.json", JSON.stringify({ weekStart: mondayOf(today()), weekEnd: mondayOf(today()), workouts: [{ workoutName: "Shared walk", workoutType: "walking", distanceMeters: 3000, scheduledDate: daysAhead(2), steps: [{ stepType: "interval", targetType: "no.target", endCondition: "distance", endConditionValue: 3000 }] }] }, null, 2), { create: true, source: "e2e" });

  // activities: a run every other day for five weeks, a gym session a week, two rides; the "Easy run" one carries the plan workout's id
  const acts: any[] = [];
  let id = 9000;
  for (let d = 1; d <= 35; d += 2) acts.push(listItem(id++, daysAgo(d), 7, "running", { distance: 6000 + (d % 5) * 1000 }));
  acts.push(listItem(id++, daysAgo(2), 7, "running", { workoutId: 7001, activityName: "Easy run", hrTimeInZone_1: 300, hrTimeInZone_2: 900, hrTimeInZone_3: 800, hrTimeInZone_4: 300, hrTimeInZone_5: 100 }));
  for (let d = 3; d <= 35; d += 7) acts.push(listItem(id++, daysAgo(d), 18, "strength_training", { distance: 0 }));
  acts.push(listItem(id++, daysAgo(6), 9, "cycling"), listItem(id++, daysAgo(20), 9, "cycling"));
  acts.push(listItem(id++, today(), 6, "running", { activityName: "Today's shakeout", distance: 4000, duration: 1500 }));
  store.activities.insertNew("alice", acts.map((a) => toNewActivity(a)!));
  // one run has its details and its chart data, so the detail pane draws graphs, laps and zones
  const detailed = String(acts.find((a) => a.activityName === "Easy run").activityId);
  store.activities.setDetail("alice", detailed, { activityId: Number(detailed), metadataDTO: { associatedWorkoutId: 7001 }, summaryDTO: { maxHR: 171, averageSpeed: 3.3, calories: 520, trainingEffectLabel: "AEROBIC_BASE", aerobicTrainingEffect: 3.1, minHR: 98, directWorkoutRpe: 50 } });
  store.activities.setChart("alice", detailed, {
    details: {
      metricDescriptors: [{ metricsIndex: 0, key: "directHeartRate" }, { metricsIndex: 1, key: "sumDistance" }, { metricsIndex: 2, key: "sumDuration" }, { metricsIndex: 3, key: "directSpeed" }, { metricsIndex: 4, key: "directElevation" }],
      activityDetailMetrics: Array.from({ length: 40 }, (_, i) => ({ metrics: [120 + (i % 20), i * 200, i * 60, 3.2 + (i % 5) / 10, 50 + (i % 9)] })),
      geoPolylineDTO: { polyline: Array.from({ length: 40 }, (_, i) => ({ lat: 45.5 + i * 0.0004, lon: -73.6 + Math.sin(i / 6) * 0.002 })) },
    },
    splits: { lapDTOs: [1, 2, 3, 4].map((n) => ({ lapIndex: n, distance: 2000, duration: 600 + n * 5, averageHR: 140 + n, maxHR: 160 + n, averageSpeed: 3.3 })) },
    zones: [1, 2, 3, 4, 5].map((n) => ({ zoneNumber: n, secsInZone: 300 * (6 - n), zoneLowBoundary: 90 + n * 15 })),
  });

  // two gym sessions have their sets, so the detail pane draws the exercises and the "% of 1RM" section (weights in grams, as Garmin gives them)
  const gym = acts.filter((a) => a.activityType.typeKey === "strength_training");
  const rawSet = (name: string, category: string, reps: number, kg: number, n: number) => ({ setType: "ACTIVE", exercises: [{ category, name }], duration: 40, repetitionCount: reps, weight: kg * 1000, startTime: "2026-01-01T07:00:00.0", wktStepIndex: n, messageIndex: n });
  const sessions: [any, number][] = [[gym[0], 100], [gym[2], 90]];
  for (const [activity, squat] of sessions) {
    const sets = [...[0, 1, 2].map((n) => rawSet("BARBELL_BACK_SQUAT", "SQUAT", 5, squat, n)), ...[3, 4, 5].map((n) => rawSet("BARBELL_BENCH_PRESS", "BENCH_PRESS", 8, 70, n))];
    store.activities.setDetail("alice", String(activity.activityId), { activityId: activity.activityId, summaryDTO: { directWorkoutRpe: 60, calories: 380 }, fullExerciseSets: sets });
  }

  // health data: the last 45 days, with a weigh-in every third day
  for (let d = 0; d < 45; d++) {
    const day = daysAgo(d);
    store.wellness.put("alice", day, "summary", { ...summaryResponse({ steps: 6000 + ((d * 719) % 5000), rhr: 49 + (d % 4), wake: 70 + (d % 15) }), calendarDate: day });
    store.wellness.put("alice", day, "sleep", { ...sleepResponse({ score: 70 + (d % 20), hrv: 50 + (d % 12), rhr: 49 + (d % 4), seconds: 25_000 + (d % 6) * 1200 }), dailySleepDTO: { ...sleepResponse().dailySleepDTO, calendarDate: day, sleepTimeSeconds: 25_000 + (d % 6) * 1200 } });
    store.wellness.put("alice", day, "hrv", { ...hrvResponse({ last: 50 + (d % 12) }), hrvSummary: { ...hrvResponse().hrvSummary, calendarDate: day, lastNightAvg: 50 + (d % 12) } });
    if (d % 3 === 0) store.wellness.put("alice", day, "weight", { ...weightResponse({ grams: 82_000 - d * 40, fat: 18.5 - d * 0.02 }), startDate: day, endDate: day, dateWeightList: [{ ...weightResponse().dateWeightList[0], calendarDate: day, weight: 82_000 - d * 40, bodyFat: 18.5 - d * 0.02 }] });
  }

  // food: five logged days before today, with goals
  const meals: Record<string, [string, number, number, number, number][]> = {
    breakfast: [["Oatmeal", 300, 10, 54, 5], ["Banana", 105, 1, 27, 0]],
    lunch: [["Chicken wrap", 520, 34, 48, 20]],
    dinner: [["Salmon and rice", 640, 41, 62, 24]],
    snack: [["Greek yogurt", 130, 17, 8, 3]],
  };
  for (let d = 1; d <= 5; d++) {
    store.nutrition.add(
      "alice",
      Object.entries(meals).flatMap(([meal, items]) => items.map(([name, kcal, proteinG, carbsG, fatG]) => ({ day: daysAgo(d), meal: meal as Meal, name, kcal, proteinG, carbsG, fatG }))),
      "web",
    );
  }
  store.goals.set("alice", { kcal: 2200, proteinG: 130, carbsG: 250, fatG: 70 });
}
