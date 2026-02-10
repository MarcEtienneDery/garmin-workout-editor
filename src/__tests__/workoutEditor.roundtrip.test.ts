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

    // Load the actual workouts-raw.json file
    const rawPath = path.join(__dirname, "../../data/workouts-raw.json");
    if (fs.existsSync(rawPath)) {
      const rawContent = fs.readFileSync(rawPath, "utf-8");
      rawWorkouts = JSON.parse(rawContent);
    } else {
      // Skip test if file doesn't exist
      rawWorkouts = [];
    }
  });

  it("should round-trip transform: raw → DetailedWorkout → Garmin format", () => {
    if (rawWorkouts.length === 0) {
      console.log("⚠️  Skipping: workouts-raw.json not found or empty");
      return;
    }

    // Take first raw workout
    const originalRaw = rawWorkouts[0];

    // Step 1: Export transformation (raw → DetailedWorkout)
    const transformed = (editor as any).transformSingleWorkout(originalRaw);
    expect(transformed).toBeDefined();
    expect(transformed.workoutName).toBe(originalRaw.workoutName);
    expect(transformed.workoutId).toBe(originalRaw.workoutId);

    // Step 2: Upload transformation (DetailedWorkout → Garmin format)
    const garminWorkout = (editor as any).buildGarminWorkoutDetail(transformed);
    expect(garminWorkout).toBeDefined();
    expect(garminWorkout.workoutName).toBe(originalRaw.workoutName);
    expect(garminWorkout.workoutId).toBe(originalRaw.workoutId);

    // Step 3: Exact match
    expect(garminWorkout).toEqual(originalRaw);
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

        // Export transformation
        const transformed = (editor as any).transformSingleWorkout(raw);
        expect(transformed).toBeDefined();

        // Upload transformation
        const garminWorkout = (editor as any).buildGarminWorkoutDetail(
          transformed
        );
        expect(garminWorkout).toBeDefined();

        // Exact match for each sampled workout
        expect(garminWorkout).toEqual(raw);

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

    // Find a workout with steps
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

    // Transform
    const transformed = (editor as any).transformSingleWorkout(workoutWithSteps);
    const garminWorkout = (editor as any).buildGarminWorkoutDetail(transformed);

    const roundtripSteps = garminWorkout.workoutSegments[0].workoutSteps;

    // Verify step types match exactly
    const originalStepTypes = originalSteps.map((s: any) => s.stepType?.stepTypeKey);
    const roundtripStepTypes = roundtripSteps.map((s: any) => s.stepType?.stepTypeKey);

    expect(roundtripStepTypes).toEqual(originalStepTypes);
  });
});
