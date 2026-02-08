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
import * as os from "os";
import { WeeklyWorkoutPlan } from "../shared/types";

describe("WorkoutEditor", () => {
  let tempDir: string;
  let editor: WorkoutEditor;
  let garminClient: GarminClient;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "garmin-test-"));
    garminClient = new GarminClient("test@example.com", "password123", true);
    editor = new WorkoutEditor(garminClient);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("Workout Plan Validation", () => {
    it("should validate valid workout plan", () => {
      const plan: WeeklyWorkoutPlan = {
        generatedAt: new Date().toISOString(),
        weekStart: "2026-02-01",
        weekEnd: "2026-02-07",
        workouts: [
          {
            workoutId: 1,
            workoutName: "Monday Workout",
            scheduledDate: "2026-02-02",
          },
        ],
      };

      expect(() =>
        (editor as any).validateWorkoutPlan(plan)
      ).not.toThrow();
    });

    it("should reject plan with missing weekStart", () => {
      const plan: any = {
        generatedAt: new Date().toISOString(),
        weekEnd: "2026-02-07",
        workouts: [],
      };

      expect(() =>
        (editor as any).validateWorkoutPlan(plan)
      ).toThrow("Invalid workout plan");
    });

    it("should reject plan with missing workoutName", () => {
      const plan: any = {
        generatedAt: new Date().toISOString(),
        weekStart: "2026-02-01",
        weekEnd: "2026-02-07",
        workouts: [{ workoutId: 1 }],
      };

      expect(() =>
        (editor as any).validateWorkoutPlan(plan)
      ).toThrow("workout name missing");
    });
  });

  describe("Workout Import/Export", () => {
    it("should import workout plan from file", async () => {
      const plan: WeeklyWorkoutPlan = {
        generatedAt: new Date().toISOString(),
        weekStart: "2026-02-01",
        weekEnd: "2026-02-07",
        workouts: [
          {
            workoutId: 1,
            workoutName: "Chest Day",
            scheduledDate: "2026-02-02",
            steps: [
              {
                stepType: "interval",
                exerciseName: "BARBELL_BENCH_PRESS",
                endCondition: "reps",
                endConditionValue: 8,
                reps: 8,
                weight: 225,
              },
            ],
          },
        ],
      };

      const filePath = path.join(tempDir, "plan.json");
      fs.writeFileSync(filePath, JSON.stringify(plan, null, 2));

      const imported = await editor.importWorkoutPlan(filePath);

      expect(imported.weekStart).toBe("2026-02-01");
      expect(imported.workouts[0].workoutName).toBe("Chest Day");
      expect(imported.workouts[0].steps).toBeDefined();
    });

    it("should handle invalid JSON file", async () => {
      const filePath = path.join(tempDir, "invalid.json");
      fs.writeFileSync(filePath, "not valid json");

      await expect(editor.importWorkoutPlan(filePath)).rejects.toThrow();
    });
  });

  describe("Date Manipulation", () => {
    it("should shift dates correctly", () => {
      const shiftDate = (editor as any).shiftDate.bind(editor);

      expect(shiftDate("2026-02-01", 7)).toBe("2026-02-08");
      expect(shiftDate("2026-02-01", -7)).toBe("2026-01-25");
      expect(shiftDate("2026-02-01", 0)).toBe("2026-02-01");
    });

    it("should handle invalid dates", () => {
      const shiftDate = (editor as any).shiftDate.bind(editor);

      expect(shiftDate("invalid-date", 7)).toBe("invalid-date");
    });
  });

  describe("Copy Workout Plan", () => {
    it("should copy plan to next week with shifted dates", async () => {
      const originalPlan: WeeklyWorkoutPlan = {
        generatedAt: new Date().toISOString(),
        weekStart: "2026-02-01",
        weekEnd: "2026-02-07",
        workouts: [
          {
            workoutId: 1,
            workoutName: "Monday Workout",
            scheduledDate: "2026-02-02",
          },
        ],
      };

      const inputPath = path.join(tempDir, "original.json");
      const outputPath = path.join(tempDir, "copied.json");
      fs.writeFileSync(inputPath, JSON.stringify(originalPlan, null, 2));

      await editor.copyWorkoutPlanToNextWeek(inputPath, outputPath);

      expect(fs.existsSync(outputPath)).toBe(true);

      const copied = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
      expect(copied.weekStart).toBe("2026-02-08");
      expect(copied.weekEnd).toBe("2026-02-14");
      expect(copied.workouts[0].scheduledDate).toBe("2026-02-09");
      expect(copied.source).toBe("copy-last-week");
    });
  });

  describe("Workout Steps Transformation", () => {
    it("should transform workout steps correctly", () => {
      const transform = (editor as any).transformWorkoutSteps.bind(editor);

      const rawSteps = [
        {
          type: "ExecutableStepDTO",
          stepType: { stepTypeKey: "interval" },
          exerciseName: "Bench Press",
          targetType: { workoutTargetTypeKey: "zone" },
          targetValueOne: 4,
          targetValueTwo: 8,
          weightValue: 225,
          stepOrder: 0,
          endCondition: { conditionTypeKey: "reps" },
          endConditionValue: 8,
        },
        {
          type: "ExecutableStepDTO",
          stepType: { stepTypeKey: "rest" },
          endCondition: { conditionTypeKey: "time" },
          endConditionValue: 120,
          stepOrder: 1,
        },
      ];

      const steps = transform(rawSteps);

      // Should merge rest into previous step
      expect(steps.length).toBe(1);
      expect(steps[0].exerciseName).toBe("Bench Press");
      expect(steps[0].targetValueOne).toBe(4);
      expect(steps[0].restTimeSeconds).toBe(120);
      expect(steps[0].reps).toBe(8);
    });

    it("should handle null/undefined steps", () => {
      const transform = (editor as any).transformWorkoutSteps.bind(editor);

      expect(transform(null)).toEqual([]);
      expect(transform(undefined)).toEqual([]);
      expect(transform([])).toEqual([]);
    });

    it("should convert Garmin weight format", () => {
      const transform = (editor as any).transformWorkoutSteps.bind(editor);

      // Test 1: Weight already in pounds
      const stepsInPounds = [
        {
          type: "ExecutableStepDTO",
          stepType: { stepTypeKey: "interval" },
          weightValue: 99.99947750443862, // Already in pounds
          weightUnit: { unitKey: "pound", factor: 453.59237 },
          stepOrder: 0,
          endCondition: { conditionTypeKey: "reps" },
          endConditionValue: 5,
        },
      ];

      let steps = transform(stepsInPounds);
      // Weight already in pounds, should round to 100
      expect(steps[0].weight).toBe(100);

      // Test 2: Weight in grams (needs conversion)
      const stepsInGrams = [
        {
          type: "ExecutableStepDTO",
          stepType: { stepTypeKey: "interval" },
          weightValue: 102261, // Garmin weight value in grams
          stepOrder: 0,
          endCondition: { conditionTypeKey: "reps" },
          endConditionValue: 5,
        },
      ];

      steps = transform(stepsInGrams);
      // Weight should be converted from grams to lbs (~225)
      expect(steps[0].weight).toBeCloseTo(225, 0);
    });
  });

  describe("File Operations", () => {
    it("should export workouts to file", async () => {
      const outputPath = path.join(tempDir, "workouts.json");

      // Since we're in mock mode, this will create an empty file
      await editor.exportWorkouts(outputPath, false);

      expect(fs.existsSync(outputPath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
      expect(Array.isArray(content)).toBe(true);
    });

    it("should create nested directories for export", async () => {
      const outputPath = path.join(
        tempDir,
        "nested",
        "deep",
        "workouts.json"
      );

      await editor.exportWorkouts(outputPath, false);

      expect(fs.existsSync(outputPath)).toBe(true);
    });

    it("should format JSON with proper indentation", async () => {
      const outputPath = path.join(tempDir, "workouts.json");

      // Create a plan with workouts to ensure non-empty JSON
      const plan: WeeklyWorkoutPlan = {
        generatedAt: new Date().toISOString(),
        weekStart: "2026-02-01",
        weekEnd: "2026-02-07",
        workouts: [
          {
            workoutId: 1,
            workoutName: "Test Workout",
          },
        ],
      };

      const filePath = path.join(tempDir, "plan-format.json");
      fs.writeFileSync(filePath, JSON.stringify(plan, null, 2));
      const content = fs.readFileSync(filePath, "utf-8");

      // Check that JSON is pretty-printed (has newlines and indentation)
      expect(content).toContain("\n");
      expect(content).toContain("  ");
    });
  });

  describe("Helper Methods", () => {
    it("should format exercise names", () => {
      const format = (editor as any).formatExerciseName.bind(editor);

      expect(format("BARBELL_BENCH_PRESS")).toBe("Barbell Bench Press");
      expect(format("DUMBBELL_SQUAT")).toBe("Dumbbell Squat");
      expect(format(undefined)).toBe("Unknown Exercise");
    });

    it("should convert Garmin weight to lbs", () => {
      const convert = (editor as any).convertGarminWeight.bind(editor);

      // Test zero weight
      expect(convert(0)).toBe(0);
      
      // Test weight already in pounds
      expect(convert(100, { unitKey: "pound", factor: 453.59237 })).toBe(100);
      expect(convert(99.99947750443862, { unitKey: "pound" })).toBe(100);
      
      // Test weight in grams (needs conversion)
      expect(convert(453.59237)).toBe(1);
      expect(convert(102261)).toBeCloseTo(225, 0);
    });
  });

  describe("Workout Step Transformation", () => {
    it("should flatten nested RepeatGroupDTO structures", () => {
      const mockSteps = [
        {
          type: "ExecutableStepDTO",
          stepOrder: 1,
          stepType: { stepTypeKey: "warmup" },
          endCondition: { conditionTypeKey: "time" },
          endConditionValue: 300,
        },
        {
          type: "RepeatGroupDTO",
          stepOrder: 2,
          numberOfIterations: 3,
          workoutSteps: [
            {
              type: "ExecutableStepDTO",
              stepOrder: 3,
              stepType: { stepTypeKey: "interval" },
              exerciseName: "BARBELL_SQUAT",
              endCondition: { conditionTypeKey: "reps" },
              endConditionValue: 10,
            },
            {
              type: "ExecutableStepDTO",
              stepOrder: 4,
              stepType: { stepTypeKey: "rest" },
              endCondition: { conditionTypeKey: "time" },
              endConditionValue: 60,
            },
          ],
        },
      ];

      const transformed = (editor as any).transformWorkoutSteps(mockSteps);

      // Should have 2 steps: warmup + interval (rest merged)
      expect(transformed).toHaveLength(2);
      expect(transformed[0].stepType).toBe("warmup");
      expect(transformed[0].stepOrder).toBe(1);
      expect(transformed[1].stepType).toBe("interval");
      expect(transformed[1].numberOfRepeats).toBe(3);
      expect(transformed[1].restTimeSeconds).toBe(60);
      expect(transformed[1].stepOrder).toBe(2);
    });

    it("should merge only first rest step into preceding exercise", () => {
      const mockSteps = [
        {
          type: "ExecutableStepDTO",
          stepOrder: 1,
          stepType: { stepTypeKey: "interval" },
          exerciseName: "BARBELL_BENCH_PRESS",
          endCondition: { conditionTypeKey: "reps" },
          endConditionValue: 10,
        },
        {
          type: "ExecutableStepDTO",
          stepOrder: 2,
          stepType: { stepTypeKey: "rest" },
          endCondition: { conditionTypeKey: "time" },
          endConditionValue: 90,
        },
        {
          type: "ExecutableStepDTO",
          stepOrder: 3,
          stepType: { stepTypeKey: "rest" },
          endCondition: { conditionTypeKey: "time" },
          endConditionValue: 60,
        },
      ];

      const transformed = (editor as any).transformWorkoutSteps(mockSteps);

      // Should have 2 steps: interval with merged rest + separate rest
      expect(transformed).toHaveLength(2);
      expect(transformed[0].restTimeSeconds).toBe(90);
      expect(transformed[1].stepType).toBe("rest");
      expect(transformed[1].durationSeconds).toBe(60);
    });

    it("should convert weight from Garmin format to lbs", () => {
      const mockSteps = [
        {
          type: "ExecutableStepDTO",
          stepOrder: 1,
          stepType: { stepTypeKey: "interval" },
          exerciseName: "BARBELL_DEADLIFT",
          weightValue: 102261, // ~225 lbs in tenths of grams
          endCondition: { conditionTypeKey: "reps" },
          endConditionValue: 5,
        },
      ];

      const transformed = (editor as any).transformWorkoutSteps(mockSteps);

      expect(transformed[0].weight).toBeCloseTo(225, 0);
    });

    it("should extract parallel fields based on endCondition", () => {
      const mockSteps = [
        {
          type: "ExecutableStepDTO",
          stepOrder: 1,
          stepType: { stepTypeKey: "interval" },
          endCondition: { conditionTypeKey: "reps" },
          endConditionValue: 12,
        },
        {
          type: "ExecutableStepDTO",
          stepOrder: 2,
          stepType: { stepTypeKey: "interval" },
          endCondition: { conditionTypeKey: "time" },
          endConditionValue: 600,
        },
        {
          type: "ExecutableStepDTO",
          stepOrder: 3,
          stepType: { stepTypeKey: "interval" },
          endCondition: { conditionTypeKey: "distance" },
          endConditionValue: 1000,
        },
      ];

      const transformed = (editor as any).transformWorkoutSteps(mockSteps);

      expect(transformed[0].reps).toBe(12);
      expect(transformed[1].durationSeconds).toBe(600);
      expect(transformed[2].distanceMeters).toBe(1000);
    });

    it("should preserve targetValueOne and targetValueTwo", () => {
      const mockSteps = [
        {
          type: "ExecutableStepDTO",
          stepOrder: 1,
          stepType: { stepTypeKey: "interval" },
          targetType: { workoutTargetTypeKey: "heart.rate.zone" },
          targetValueOne: 155,
          targetValueTwo: 165,
          endCondition: { conditionTypeKey: "time" },
          endConditionValue: 720,
        },
      ];

      const transformed = (editor as any).transformWorkoutSteps(mockSteps);

      expect(transformed[0].targetType).toBe("heart.rate.zone");
      expect(transformed[0].targetValueOne).toBe(155);
      expect(transformed[0].targetValueTwo).toBe(165);
    });

    it("should renumber stepOrder sequentially after flattening", () => {
      const mockSteps = [
        {
          type: "ExecutableStepDTO",
          stepOrder: 1,
          stepType: { stepTypeKey: "warmup" },
          endCondition: { conditionTypeKey: "time" },
          endConditionValue: 300,
        },
        {
          type: "RepeatGroupDTO",
          stepOrder: 6,
          numberOfIterations: 2,
          workoutSteps: [
            {
              type: "ExecutableStepDTO",
              stepOrder: 7,
              stepType: { stepTypeKey: "interval" },
              endCondition: { conditionTypeKey: "reps" },
              endConditionValue: 10,
            },
            {
              type: "ExecutableStepDTO",
              stepOrder: 8,
              stepType: { stepTypeKey: "rest" },
              endCondition: { conditionTypeKey: "time" },
              endConditionValue: 60,
            },
          ],
        },
      ];

      const transformed = (editor as any).transformWorkoutSteps(mockSteps);

      // Should be renumbered 1, 2 (rest merged into interval)
      expect(transformed[0].stepOrder).toBe(1);
      expect(transformed[1].stepOrder).toBe(2);
    });

    it("should expand running workout repeat groups", () => {
      const mockSteps = [
        {
          type: "ExecutableStepDTO",
          stepOrder: 1,
          stepType: { stepTypeKey: "warmup" },
          endCondition: { conditionTypeKey: "time" },
          endConditionValue: 600,
        },
        {
          type: "RepeatGroupDTO",
          stepOrder: 2,
          numberOfIterations: 4,
          workoutSteps: [
            {
              type: "ExecutableStepDTO",
              stepOrder: 3,
              stepType: { stepTypeKey: "interval" },
              targetType: { workoutTargetTypeKey: "pace.zone" },
              targetValueOne: 3.5,
              targetValueTwo: 3.8,
              endCondition: { conditionTypeKey: "distance" },
              endConditionValue: 1000,
            },
            {
              type: "ExecutableStepDTO",
              stepOrder: 4,
              stepType: { stepTypeKey: "recovery" },
              endCondition: { conditionTypeKey: "time" },
              endConditionValue: 120,
            },
          ],
        },
      ];

      const transformed = (editor as any).transformWorkoutSteps(mockSteps);

      // Should have 3 steps: warmup + interval + recovery (both with numberOfRepeats=4)
      expect(transformed).toHaveLength(3);
      expect(transformed[1].numberOfRepeats).toBe(4);
      expect(transformed[1].distanceMeters).toBe(1000);
      expect(transformed[2].numberOfRepeats).toBe(4);
      expect(transformed[2].durationSeconds).toBe(120);
    });
  });
});
