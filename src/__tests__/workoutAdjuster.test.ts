/**
 * Tests for WorkoutAdjuster — covers non-LLM logic:
 *  - extractJson() handles markdown fences, mixed text, raw JSON
 *  - formatChangeSummary() diffs two plans correctly
 *  - WorkoutAdjuster.buildSystemPrompt() contains required schema info
 *  - WorkoutAdjuster mock mode returns a plan without calling copilot-sdk
 *  - WorkoutAdjuster.loadActivities / loadWorkoutPlan / loadTrainingPlan
 *  - appendWeekSummary() appends to weeklyHistory
 *
 * @github/copilot-sdk is mapped to src/__mocks__/copilot-sdk.ts via
 * moduleNameMapper in jest.config.js — no Copilot CLI needed.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WorkoutAdjuster, extractJson, formatChangeSummary } from "../workoutAdjuster";
import { WeeklyWorkoutPlan, TrainingPlan, ExtractedActivities } from "../shared/types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MINIMAL_PLAN: WeeklyWorkoutPlan = {
  generatedAt: "2026-02-22T00:00:00.000Z",
  weekStart: "2026-02-23",
  weekEnd: "2026-03-01",
  workouts: [
    {
      workoutId: 123,
      workoutName: "Monday Bench",
      workoutType: "strength_training",
      scheduledDate: "2026-02-23",
      steps: [
        {
          stepType: "interval",
          exerciseName: "BARBELL_BENCH_PRESS",
          endCondition: "reps",
          endConditionValue: 5,
          weightPercentage: 80,
          benchmarkKey: "BARBELL_BENCH_PRESS",
        },
      ],
    },
  ],
};

const MODIFIED_PLAN: WeeklyWorkoutPlan = {
  ...MINIMAL_PLAN,
  workouts: [
    {
      ...MINIMAL_PLAN.workouts[0],
      steps: [
        {
          stepType: "interval",
          exerciseName: "BARBELL_BENCH_PRESS",
          endCondition: "reps",
          endConditionValue: 5,
          weightPercentage: 85, // bumped from 80 → 85
          benchmarkKey: "BARBELL_BENCH_PRESS",
        },
      ],
    },
  ],
};

const MINIMAL_ACTIVITIES: ExtractedActivities = {
  extractedAt: "2026-02-22T00:00:00.000Z",
  weekStart: "2026-02-16",
  weekEnd: "2026-02-22",
  totalActivities: 1,
  activities: [
    {
      id: "123",
      activityName: "Monday Bench",
      activityType: "strength_training",
      startTime: "2026-02-16 10:00:00",
      duration: 3600,
      totalSets: 5,
      totalReps: 25,
    },
  ],
};

const MINIMAL_TRAINING_PLAN: TrainingPlan = {
  version: "1.0",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-22T00:00:00.000Z",
  athlete: { name: "Test Athlete", experienceLevel: "intermediate" },
  goals: { primary: "Get stronger" },
  strengthBenchmarks: {
    BARBELL_BENCH_PRESS: { oneRepMax: 185, lastUpdated: "2026-02-01" },
  },
  runningBenchmarks: { easyPace: 6.5 },
  periodization: {
    currentPhase: "Hypertrophy",
    weekInPhase: 2,
    totalWeeksInPhase: 4,
    phases: [{ name: "Hypertrophy", totalWeeks: 4 }],
  },
  constraints: {},
  weeklyHistory: [],
};

// ─── extractJson ─────────────────────────────────────────────────────────────

describe("extractJson", () => {
  it("parses a plain JSON object", () => {
    const result = extractJson('{"weekStart":"2026-02-23","workouts":[]}');
    expect(result).toEqual({ weekStart: "2026-02-23", workouts: [] });
  });

  it("strips markdown json fences", () => {
    const text = "```json\n{\"weekStart\":\"2026-02-23\",\"workouts\":[]}\n```";
    const result = extractJson(text);
    expect(result).toEqual({ weekStart: "2026-02-23", workouts: [] });
  });

  it("strips plain markdown fences (no language tag)", () => {
    const text = "```\n{\"foo\":\"bar\"}\n```";
    const result = extractJson(text);
    expect(result).toEqual({ foo: "bar" });
  });

  it("extracts JSON embedded in prose text", () => {
    const text = 'Sure, here is the adjusted plan:\n{"weekStart":"2026-02-23","workouts":[]}';
    const result = extractJson(text);
    expect(result).toEqual({ weekStart: "2026-02-23", workouts: [] });
  });

  it("parses a JSON array", () => {
    const result = extractJson('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it("throws on garbage input", () => {
    expect(() => extractJson("no json here at all!")).toThrow("No valid JSON found");
  });
});

// ─── formatChangeSummary ─────────────────────────────────────────────────────

describe("formatChangeSummary", () => {
  it("reports no changes when plans are identical", () => {
    const summary = formatChangeSummary(MINIMAL_PLAN, MINIMAL_PLAN);
    expect(summary).toContain("No structural changes detected");
  });

  it("reports changed weightPercentage", () => {
    const summary = formatChangeSummary(MINIMAL_PLAN, MODIFIED_PLAN);
    expect(summary).toContain("Monday Bench");
    // The step descriptions should differ
    expect(summary).toContain("@80%");
    expect(summary).toContain("@85%");
  });

  it("reports a new workout", () => {
    const newWorkout: WeeklyWorkoutPlan = {
      ...MINIMAL_PLAN,
      workouts: [
        ...MINIMAL_PLAN.workouts,
        {
          workoutName: "Wednesday Run",
          workoutType: "running",
          scheduledDate: "2026-02-25",
          steps: [],
        },
      ],
    };
    const summary = formatChangeSummary(MINIMAL_PLAN, newWorkout);
    expect(summary).toContain("NEW: Wednesday Run");
  });

  it("reports a removed workout", () => {
    const emptyPlan: WeeklyWorkoutPlan = { ...MINIMAL_PLAN, workouts: [] };
    const summary = formatChangeSummary(MINIMAL_PLAN, emptyPlan);
    expect(summary).toContain("REMOVED: Monday Bench");
  });
});

// ─── WorkoutAdjuster — non-LLM methods ───────────────────────────────────────

describe("WorkoutAdjuster", () => {
  let tempDir: string;
  let adjuster: WorkoutAdjuster;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adjuster-test-"));
    adjuster = new WorkoutAdjuster({ mockMode: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("buildSystemPrompt", () => {
    it("contains the required schema keywords", () => {
      const prompt = adjuster.buildSystemPrompt();
      expect(prompt).toContain("WeeklyWorkoutPlan");
      expect(prompt).toContain("SCREAMING_SNAKE_CASE");
      expect(prompt).toContain("weightPercentage");
      expect(prompt).toContain("endCondition");
      expect(prompt).toContain("scheduledDate");
      expect(prompt).toContain("repeat");
    });

    it("lists all valid stepTypes", () => {
      const prompt = adjuster.buildSystemPrompt();
      for (const t of ["warmup", "cooldown", "interval", "recovery", "rest", "exercise", "repeat", "other"]) {
        expect(prompt).toContain(t);
      }
    });
  });

  describe("loadActivities", () => {
    it("reads and parses an ExtractedActivities JSON file", () => {
      const filePath = path.join(tempDir, "activities.json");
      fs.writeFileSync(filePath, JSON.stringify(MINIMAL_ACTIVITIES), "utf-8");
      const result = adjuster.loadActivities(filePath);
      expect(result.totalActivities).toBe(1);
      expect(result.activities[0].activityName).toBe("Monday Bench");
    });
  });

  describe("loadWorkoutPlan", () => {
    it("reads a WeeklyWorkoutPlan wrapper format", () => {
      const filePath = path.join(tempDir, "plan.json");
      fs.writeFileSync(filePath, JSON.stringify(MINIMAL_PLAN), "utf-8");
      const result = adjuster.loadWorkoutPlan(filePath);
      expect(result.workouts).toHaveLength(1);
      expect(result.weekStart).toBe("2026-02-23");
    });

    it("reads a flat array and wraps it in a WeeklyWorkoutPlan", () => {
      const filePath = path.join(tempDir, "workouts.json");
      fs.writeFileSync(filePath, JSON.stringify(MINIMAL_PLAN.workouts), "utf-8");
      const result = adjuster.loadWorkoutPlan(filePath);
      expect(result.workouts).toHaveLength(1);
      expect(result.weekStart).toBe("");
    });
  });

  describe("loadTrainingPlan", () => {
    it("reads and parses a TrainingPlan JSON file", () => {
      const filePath = path.join(tempDir, "training-plan.json");
      fs.writeFileSync(filePath, JSON.stringify(MINIMAL_TRAINING_PLAN), "utf-8");
      const result = adjuster.loadTrainingPlan(filePath);
      expect(result.athlete.name).toBe("Test Athlete");
      expect(result.periodization.currentPhase).toBe("Hypertrophy");
    });
  });

  describe("analyzeAndAdjust (mock mode)", () => {
    it("returns a plan and summary without calling copilot-sdk", async () => {
      const context = {
        activities: MINIMAL_ACTIVITIES,
        currentPlan: MINIMAL_PLAN,
        trainingPlan: MINIMAL_TRAINING_PLAN,
      };

      await adjuster.createSession(); // no-op in mock mode
      const result = await adjuster.analyzeAndAdjust(context);

      expect(result.adjustedPlan).toBeDefined();
      expect(Array.isArray(result.adjustedPlan.workouts)).toBe(true);
      expect(typeof result.changeSummary).toBe("string");
    });
  });

  describe("appendWeekSummary (mock mode)", () => {
    it("appends a WeekSummary entry to the training plan file", async () => {
      const planPath = path.join(tempDir, "training-plan.json");
      const planWithHistory: TrainingPlan = {
        ...MINIMAL_TRAINING_PLAN,
        weeklyHistory: [],
      };
      fs.writeFileSync(planPath, JSON.stringify(planWithHistory), "utf-8");

      const context = {
        activities: MINIMAL_ACTIVITIES,
        currentPlan: MINIMAL_PLAN,
        trainingPlan: { ...planWithHistory },
      };

      // In mock mode, appendWeekSummary calls getMockResponse which may fall
      // back to writing a minimal entry — stub the internal send
      await adjuster.createSession();
      await adjuster.appendWeekSummary(context, planPath);

      const updated = JSON.parse(fs.readFileSync(planPath, "utf-8")) as TrainingPlan;
      expect(updated.weeklyHistory.length).toBeGreaterThanOrEqual(1);
      expect(updated.weeklyHistory[0].weekStart).toBe("2026-02-16");
      expect(updated.updatedAt).not.toBe("2026-02-22T00:00:00.000Z");
    });
  });

  describe("cleanup (mock mode)", () => {
    it("completes without throwing", async () => {
      await expect(adjuster.cleanup()).resolves.not.toThrow();
    });
  });
});
