jest.mock("@flow-js/garmin-connect", () => ({
  GarminConnect: jest.fn().mockImplementation(() => ({
    login: jest.fn().mockResolvedValue(true),
    getUserProfile: jest.fn().mockResolvedValue({ userName: "tester" }),
    getWorkouts: jest.fn().mockResolvedValue([]),
    getWorkoutDetail: jest.fn().mockResolvedValue({ workoutSegments: [] }),
    scheduleWorkout: jest.fn().mockResolvedValue({}),
  })),
}));

import WorkoutEditor from "../workoutEditor";
import { GarminClient } from "../shared/garminClient";
import * as fs from "fs";
import * as path from "path";

describe("WorkoutEditor - Round-trip Transformation", () => {
  let editor: WorkoutEditor;
  let garminClient: GarminClient;
  let rawWorkouts: any[];

  beforeEach(() => {
    garminClient = new GarminClient("test@example.com", "password123", true);
    editor = new WorkoutEditor(garminClient);

    const rawPath = path.join(__dirname, "../../data/workouts-raw.json");
    if (fs.existsSync(rawPath)) {
      const rawContent = fs.readFileSync(rawPath, "utf-8");
      rawWorkouts = JSON.parse(rawContent);
    } else {
      rawWorkouts = [];
    }
  });

  it("should round-trip transform: raw → DetailedWorkout → Garmin format", () => {
    if (rawWorkouts.length === 0) {
      console.log("⚠️  Skipping: workouts-raw.json not found or empty");
      return;
    }

    const originalRaw = rawWorkouts[0];

    const transformed = (editor as any).transformSingleWorkout(originalRaw);
    expect(transformed).toBeDefined();
    expect(transformed.workoutName).toBe(originalRaw.workoutName);
    expect(transformed.workoutId).toBe(originalRaw.workoutId);

    const garminWorkout = (editor as any).buildGarminWorkoutDetail(transformed);
    expect(garminWorkout).toBeDefined();
    expect(garminWorkout.workoutName).toBe(originalRaw.workoutName);
    expect(garminWorkout.workoutId).toBe(originalRaw.workoutId);

    expect(garminWorkout.workoutName).toBe(originalRaw.workoutName);
    expect(garminWorkout.workoutId).toBe(originalRaw.workoutId);

    const originalTopSteps = originalRaw.workoutSegments?.[0]?.workoutSteps ?? [];
    const roundtripTopSteps = garminWorkout.workoutSegments?.[0]?.workoutSteps ?? [];
    expect(roundtripTopSteps.length).toBe(originalTopSteps.length);

    const originalStepTypes = originalTopSteps.map((s: any) => s.stepType?.stepTypeKey);
    const roundtripStepTypes = roundtripTopSteps.map((s: any) => s.stepType?.stepTypeKey);
    expect(roundtripStepTypes).toEqual(originalStepTypes);
  });

  it("should handle all workouts in raw file without errors", () => {
    if (rawWorkouts.length === 0) {
      console.log("⚠️  Skipping: workouts-raw.json not found or empty");
      return;
    }

    let successCount = 0;
    const errors: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < Math.min(rawWorkouts.length, 5); i++) {
      try {
        const raw = rawWorkouts[i];

        const transformed = (editor as any).transformSingleWorkout(raw);
        expect(transformed).toBeDefined();

        const garminWorkout = (editor as any).buildGarminWorkoutDetail(
          transformed
        );
        expect(garminWorkout).toBeDefined();

        expect(garminWorkout.workoutName).toBe(raw.workoutName);
        expect(garminWorkout.workoutId).toBe(raw.workoutId);

        const originalTopSteps = raw.workoutSegments?.[0]?.workoutSteps ?? [];
        const roundtripTopSteps = garminWorkout.workoutSegments?.[0]?.workoutSteps ?? [];
        expect(roundtripTopSteps.length).toBe(originalTopSteps.length);
        const originalStepTypes = originalTopSteps.map((s: any) => s.stepType?.stepTypeKey);
        const roundtripStepTypes = roundtripTopSteps.map((s: any) => s.stepType?.stepTypeKey);
        expect(roundtripStepTypes).toEqual(originalStepTypes);

        successCount++;
      } catch (error: any) {
        errors.push({ index: i, error: error.message });
      }
    }

    console.log(
      `✅ Successfully round-tripped ${successCount}/${Math.min(rawWorkouts.length, 5)} workouts`
    );

    if (errors.length > 0) {
      console.log("❌ Errors:");
      errors.forEach(({ index, error }) => {
        console.log(`  Workout ${index}: ${error}`);
      });
    }

    expect(errors).toHaveLength(0);
  });

  it("should preserve step types through round trip", () => {
    if (rawWorkouts.length === 0) {
      console.log("⚠️  Skipping: workouts-raw.json not found or empty");
      return;
    }

    const workoutWithSteps = rawWorkouts.find(
      (w) =>
        w.workoutSegments &&
        w.workoutSegments[0]?.workoutSteps &&
        w.workoutSegments[0].workoutSteps.length > 0
    );

    if (!workoutWithSteps) {
      console.log("⚠️  Skipping: No workouts with steps found");
      return;
    }

    const originalSteps = workoutWithSteps.workoutSegments[0].workoutSteps;

    const transformed = (editor as any).transformSingleWorkout(workoutWithSteps);
    const garminWorkout = (editor as any).buildGarminWorkoutDetail(transformed);

    const roundtripSteps = garminWorkout.workoutSegments[0].workoutSteps;

    const originalStepTypes = originalSteps.map((s: any) => s.stepType?.stepTypeKey);
    const roundtripStepTypes = roundtripSteps.map((s: any) => s.stepType?.stepTypeKey);

    expect(roundtripStepTypes).toEqual(originalStepTypes);
  });
});
