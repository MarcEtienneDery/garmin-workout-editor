import { GarminConnect } from "garmin-connect";
import * as fs from "fs";
import * as path from "path";

/**
 * Get the most recent mock client instance
 * Useful for configuring mock behavior in individual tests
 */
export const getMockClient = (): any => {
  const mock = GarminConnect as unknown as jest.Mock;
  const instance = mock.mock.results[mock.mock.results.length - 1]?.value;
  return instance;
};

/**
 * Reset all mock calls and implementations
 */
export const resetMockClient = () => {
  const mock = GarminConnect as unknown as jest.Mock;
  mock.mockClear();
};

/**
 * Normalize activity type to our categories
 */
export const normalizeActivityType = (rawType: string | undefined): 'running' | 'strength_training' | 'cycling' | 'swimming' | 'other' => {
  const type = (rawType || '').toLowerCase();
  if (type.includes('run') || type.includes('trail')) return 'running';
  if (type.includes('strength') || type.includes('weight')) return 'strength_training';
  if (type.includes('cycl') || type.includes('bik')) return 'cycling';
  if (type.includes('swim') || type.includes('pool')) return 'swimming';
  return 'other';
};

/**
 * Load the last 4 activities from disk to seed mock data
 */
export const loadLastActivitiesFromDisk = (): any[] | null => {
  try {
    const activitiesPath = path.join(__dirname, "../data/activities.json");
    if (fs.existsSync(activitiesPath)) {
      const raw = fs.readFileSync(activitiesPath, "utf-8");
      const parsed = JSON.parse(raw);
      const activities = parsed?.activities || [];
      return activities.slice(-4);
    }
  } catch (error) {
    console.warn("⚠️  Could not load activities.json for mock seeding");
  }

  try {
    const rawPath = path.join(__dirname, "../data/activities-raw.json");
    if (fs.existsSync(rawPath)) {
      const raw = fs.readFileSync(rawPath, "utf-8");
      const parsed = JSON.parse(raw);
      return parsed ? [parsed] : null;
    }
  } catch (error) {
    console.warn("⚠️  Could not load activities-raw.json for mock seeding");
  }

  return null;
};

/**
 * Strength exercises modeled after activities.json (weights in lbs)
 */
const STRENGTH_EXERCISES: { category: string; subCategory?: string; typicalWeight: number }[] = [
  { category: "BENCH_PRESS", subCategory: "BARBELL_BENCH_PRESS", typicalWeight: 185 },
  { category: "DEADLIFT", subCategory: "BARBELL_DEADLIFT", typicalWeight: 250 },
  { category: "SQUAT", subCategory: "BARBELL_SQUAT", typicalWeight: 225 },
  { category: "ROW", subCategory: "BARBELL_ROW", typicalWeight: 155 },
  { category: "CURL", subCategory: "DUMBBELL_CURL", typicalWeight: 60 },
  { category: "TRICEPS_EXTENSION", subCategory: "CABLE_OVERHEAD_TRICEPS_EXTENSION", typicalWeight: 80 },
  { category: "HIP_RAISE", subCategory: "BARBELL_HIP_THRUST", typicalWeight: 185 },
  { category: "LUNGE", subCategory: "DUMBBELL_SPLIT_SQUAT", typicalWeight: 60 },
  { category: "SHOULDER_PRESS", subCategory: "DUMBBELL_SHOULDER_PRESS", typicalWeight: 55 },
  { category: "PULL_UP", subCategory: "WEIGHTED_PULL_UP", typicalWeight: 10 },
  { category: "PLANK", subCategory: "SIDE_PLANK", typicalWeight: 0 },
  { category: "CARDIO", subCategory: "CARDIO", typicalWeight: 0 },
];

/**
 * Generate mock activities for testing
 */
export const generateMockActivities = (limit: number): any[] => {
  const seededActivities = loadLastActivitiesFromDisk();
  if (seededActivities && seededActivities.length > 0) {
    const activities: any[] = [];
    for (let i = 0; i < limit; i++) {
      const seed = seededActivities[i % seededActivities.length];
      const daysAgo = Math.floor(Math.random() * 30);
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      const timestamp = date.toISOString();
      const typeKey = seed.activityType?.typeKey || seed.activityType;
      const normalizedType = normalizeActivityType(typeKey);
      const variance = 0.9 + Math.random() * 0.2; // 0.9-1.1

      const durationSeed = seed.duration || seed.elapsedDuration || 1800;
      const base: any = {
        id: `activity-${i + 1}`,
        activityName: seed.activityName || "Mock Activity",
        activityType: normalizedType,
        startTime: timestamp,
        duration: Math.max(600, Math.round(durationSeed * variance)),
        avgHR: seed.avgHR ?? seed.averageHR ?? Math.floor(Math.random() * 40) + 110,
        maxHR: seed.maxHR ?? seed.maxHR ?? Math.floor(Math.random() * 30) + 140,
        trainingEffectLabel: seed.trainingEffectLabel || (normalizedType === "other" ? "UNKNOWN" : "AEROBIC_BASE"),
        differenceBodyBattery: seed.differenceBodyBattery ?? -Math.floor(Math.random() * 12) - 3,
        moderateIntensityMinutes: seed.moderateIntensityMinutes ?? Math.floor(Math.random() * 40),
        vigorousIntensityMinutes: seed.vigorousIntensityMinutes ?? Math.floor(Math.random() * 20),
        selfEvaluationFeeling: seed.selfEvaluationFeeling,
        directWorkoutFeel: seed.directWorkoutFeel ?? seed.summaryDTO?.directWorkoutFeel,
        directWorkoutRpe: seed.directWorkoutRpe ?? seed.summaryDTO?.directWorkoutRpe,
      };

      if (normalizedType === "running") {
        const distanceSeed = seed.distance ?? 8;
        base.distance = Math.round(distanceSeed * variance * 1000) / 1000;
        base.avgPace = seed.avgPace ?? Math.round((5 + Math.random()) * 1000) / 1000;
        base.avgCadence = seed.avgCadence ?? Math.floor(Math.random() * 15) + 170;
        base.elevationGain = seed.elevationGain ?? Math.floor(Math.random() * 60) + 10;
      } else if (normalizedType === "strength_training") {
        const exerciseSets = seed.exerciseSets || [];
        base.totalSets = seed.totalSets ?? exerciseSets.reduce((sum: number, ex: any) => sum + (ex.sets || 0), 0);
        base.totalReps = seed.totalReps ?? exerciseSets.reduce((sum: number, ex: any) => sum + (ex.reps || 0), 0);
        base.exerciseSets = exerciseSets;
      }

      activities.push(base);
    }

    return activities;
  }

  const activityTypes = ["strength_training", "running", "other"];
  const activities: any[] = [];

  for (let i = 0; i < limit; i++) {
    const daysAgo = Math.floor(Math.random() * 30);
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const activityType = activityTypes[i % activityTypes.length];

    const baseActivity: any = {
      activityId: `activity-${i + 1}`,
      activityName:
        activityType === "strength_training"
          ? `Strength Session ${i + 1}`
          : activityType === "running"
          ? `Zone 2 Run ${i + 1}`
          : `Yoga ${i + 1}`,
      activityType: { typeKey: activityType },
      startTimeGMT: date.toISOString(),
      startTimeLocal: date.toISOString(),
      duration:
        activityType === "strength_training"
          ? Math.floor(Math.random() * 1800) + 2400 // 40-70 min
          : activityType === "running"
          ? Math.floor(Math.random() * 1800) + 1500 // 25-55 min
          : Math.floor(Math.random() * 900) + 1200, // 20-35 min
      averageHR:
        activityType === "other"
          ? Math.floor(Math.random() * 20) + 70
          : Math.floor(Math.random() * 40) + 110,
      maxHR:
        activityType === "other"
          ? Math.floor(Math.random() * 15) + 95
          : Math.floor(Math.random() * 30) + 140,
      aerobicTrainingEffect:
        activityType === "other"
          ? 0.0
          : Math.round((Math.random() * 3 + 2) * 10) / 10, // 2.0 - 5.0
      anaerobicTrainingEffect:
        activityType === "strength_training"
          ? Math.round((Math.random() * 2 + 1) * 10) / 10 // 1.0 - 3.0
          : 0.0,
      trainingEffectLabel:
        activityType === "strength_training"
          ? "ANAEROBIC_CAPACITY"
          : activityType === "running"
          ? "AEROBIC_BASE"
          : "UNKNOWN",
      selfEvaluationFeeling: Math.floor(Math.random() * 5) + 1, // 1-5
      directWorkoutFeel: Math.floor(Math.random() * 100),
      directWorkoutRpe: Math.floor(Math.random() * 20) + 1,
      differenceBodyBattery:
        activityType === "other"
          ? -Math.floor(Math.random() * 4) - 1
          : -Math.floor(Math.random() * 12) - 3,
      moderateIntensityMinutes:
        activityType === "other" ? 0 : Math.floor(Math.random() * 40),
      vigorousIntensityMinutes:
        activityType === "running"
          ? Math.floor(Math.random() * 60)
          : activityType === "strength_training"
          ? Math.floor(Math.random() * 15)
          : 0,
    };

    // Add type-specific fields
    if (activityType === "strength_training") {
      const numExercises = Math.floor(Math.random() * 3) + 4; // 4-6 exercises
      const usedIndices = new Set<number>();
      const exerciseSets = [];

      while (exerciseSets.length < numExercises && usedIndices.size < STRENGTH_EXERCISES.length) {
        const idx = Math.floor(Math.random() * STRENGTH_EXERCISES.length);
        if (usedIndices.has(idx)) continue;
        usedIndices.add(idx);

        const exercise = STRENGTH_EXERCISES[idx];
        const sets = Math.floor(Math.random() * 2) + 2; // 2-3 sets
        const repsPerSet = Math.floor(Math.random() * 8) + 5; // 5-12 reps
        const totalReps = sets * repsPerSet;
        const weightLbs = exercise.typicalWeight > 0
          ? Math.round(exercise.typicalWeight * (0.8 + Math.random() * 0.4))
          : 0;
        const maxWeight = weightLbs > 0 ? Math.round(weightLbs * 453.6) : 0; // tenths of grams
        const volume = maxWeight > 0 ? sets * repsPerSet * maxWeight : 0;

        exerciseSets.push({
          category: exercise.category,
          subCategory: exercise.subCategory,
          sets,
          reps: totalReps,
          maxWeight,
          volume,
        });
      }

      baseActivity.totalSets = exerciseSets.reduce((sum, ex) => sum + ex.sets, 0);
      baseActivity.totalReps = exerciseSets.reduce((sum, ex) => sum + ex.reps, 0);
      baseActivity.summarizedExerciseSets = exerciseSets;
    } else if (activityType === "running") {
      baseActivity.distance = Math.floor(Math.random() * 6000) + 5000; // 5-11 km in meters
      baseActivity.averageSpeed = Math.random() * 1.5 + 2.6; // 2.6-4.1 m/s
      baseActivity.averageRunningCadenceInStepsPerMinute = Math.floor(Math.random() * 15) + 170;
      baseActivity.elevationGain = Math.floor(Math.random() * 60) + 10;
    }

    activities.push(baseActivity);
  }

  return activities;
};
