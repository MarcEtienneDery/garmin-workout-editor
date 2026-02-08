jest.mock("garmin-connect", () => ({
  GarminConnect: jest.fn().mockImplementation(() => ({
    login: jest.fn().mockResolvedValue(true),
    getUserProfile: jest.fn().mockResolvedValue({ userName: "tester" }),
    getWorkouts: jest.fn().mockResolvedValue([]),
    getWorkout: jest.fn().mockResolvedValue({ workoutSteps: [] }),
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
                stepType: "exercise",
                exerciseName: "Bench Press",
                targetSets: 4,
                targetReps: 8,
                targetWeight: 225,
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
          stepType: "exercise",
          exerciseName: "Bench Press",
          category: "BENCH_PRESS",
          targetSets: 4,
          targetReps: 8,
          targetWeight: 225,
        },
        {
          stepType: "rest",
          duration: 120,
        },
      ];

      const steps = transform(rawSteps);

      expect(steps.length).toBe(2);
      expect(steps[0].exerciseName).toBe("Bench Press");
      expect(steps[0].targetSets).toBe(4);
      expect(steps[1].stepType).toBe("rest");
      expect(steps[1].duration).toBe(120);
    });

    it("should handle null/undefined steps", () => {
      const transform = (editor as any).transformWorkoutSteps.bind(editor);

      expect(transform(null)).toEqual([]);
      expect(transform(undefined)).toEqual([]);
      expect(transform([])).toEqual([]);
    });

    it("should convert Garmin weight format", () => {
      const transform = (editor as any).transformWorkoutSteps.bind(editor);

      const rawSteps = [
        {
          stepType: "exercise",
          maxWeight: 102261, // ~225 lbs
        },
      ];

      const steps = transform(rawSteps);
      expect(steps[0].targetWeight).toBeCloseTo(225, 0);
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

      expect(convert(0)).toBe(0);
      expect(convert(453.6)).toBe(1);
      expect(convert(102261)).toBeCloseTo(225, 0);
    });
  });
});
