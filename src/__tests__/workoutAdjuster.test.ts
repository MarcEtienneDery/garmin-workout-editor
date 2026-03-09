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
import {
  WorkoutAdjuster,
  extractJson,
  formatChangeSummary,
  formatSingleWorkoutDiff,
} from "../workoutAdjuster";
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
      workoutId: 123,  // Added to match MINIMAL_PLAN workout
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

  it("aligns inserted steps without cascading false replacements", () => {
    const oldPlan: WeeklyWorkoutPlan = {
      ...MINIMAL_PLAN,
      workouts: [
        {
          ...MINIMAL_PLAN.workouts[0],
          steps: [
            {
              stepType: "interval",
              exerciseName: "BARBELL_BACK_SQUAT",
              endCondition: "reps",
              endConditionValue: 5,
              weightPercentage: 80,
            },
            {
              stepType: "interval",
              exerciseName: "BOX_JUMP",
              endCondition: "reps",
              endConditionValue: 10,
            },
          ],
        },
      ],
    };

    const newPlan: WeeklyWorkoutPlan = {
      ...oldPlan,
      workouts: [
        {
          ...oldPlan.workouts[0],
          steps: [
            {
              stepType: "interval",
              exerciseName: "BARBELL_BACK_SQUAT",
              endCondition: "reps",
              endConditionValue: 5,
              weightPercentage: 80,
            },
            {
              stepType: "interval",
              exerciseName: "BARBELL_BENCH_PRESS",
              endCondition: "reps",
              endConditionValue: 2,
              weightPercentage: 93,
            },
            {
              stepType: "interval",
              exerciseName: "BOX_JUMP",
              endCondition: "reps",
              endConditionValue: 10,
            },
          ],
        },
      ],
    };

    const summary = formatChangeSummary(oldPlan, newPlan);
    expect(summary).toContain("Step 2: (added)");
    expect(summary).toContain("BARBELL_BENCH_PRESS 2 reps @93%");
    expect(summary).not.toContain("Step 3:");
  });

  it("does not collapse unrelated remove/add into replacement", () => {
    const oldPlan: WeeklyWorkoutPlan = {
      ...MINIMAL_PLAN,
      workouts: [
        {
          ...MINIMAL_PLAN.workouts[0],
          steps: [
            {
              stepType: "interval",
              exerciseName: "DUMBBELL_BICEPS_CURL",
              endCondition: "reps",
              endConditionValue: 12,
              weight: 60,
            },
          ],
        },
      ],
    };

    const newPlan: WeeklyWorkoutPlan = {
      ...oldPlan,
      workouts: [
        {
          ...oldPlan.workouts[0],
          steps: [
            {
              stepType: "interval",
              exerciseName: "SINGLE_LEG_ROMANIAN_DEADLIFT_WITH_DUMBBELL",
              endCondition: "reps",
              endConditionValue: 10,
              weight: 40,
            },
          ],
        },
      ],
    };

    const summary = formatChangeSummary(oldPlan, newPlan);
    expect(summary).toContain("DUMBBELL_BICEPS_CURL 12 reps @60lbs  →  (removed)");
    expect(summary).toContain("(added)  →  interval SINGLE_LEG_ROMANIAN_DEADLIFT_WITH_DUMBBELL 10 reps @40lbs");
    expect(summary).not.toContain("DUMBBELL_BICEPS_CURL 12 reps @60lbs  →  interval SINGLE_LEG_ROMANIAN_DEADLIFT_WITH_DUMBBELL");
  });

  it("treats legacy repeated interval format as equivalent to repeat-group format", () => {
    const oldPlan: WeeklyWorkoutPlan = {
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
              weightPercentage: 75,
              numberOfRepeats: 2,
              repeatGroupIndex: 0,
            },
          ],
        },
      ],
    };

    const newPlan: WeeklyWorkoutPlan = {
      ...oldPlan,
      workouts: [
        {
          ...oldPlan.workouts[0],
          steps: [
            {
              stepType: "repeat",
              endCondition: "iterations",
              endConditionValue: 2,
              numberOfRepeats: 2,
              repeatSteps: [
                {
                  stepType: "interval",
                  exerciseName: "BARBELL_BENCH_PRESS",
                  endCondition: "reps",
                  endConditionValue: 5,
                  weightPercentage: 75,
                },
              ],
            },
          ],
        },
      ],
    };

    const summary = formatChangeSummary(oldPlan, newPlan);
    expect(summary).toContain("No structural changes detected");
  });

  it("matches workouts by id when names are duplicated", () => {
    const oldPlan: WeeklyWorkoutPlan = {
      ...MINIMAL_PLAN,
      workouts: [
        {
          workoutId: 1,
          workoutName: "Strength Day",
          scheduledDate: "2026-02-23",
          steps: [
            {
              stepType: "interval",
              exerciseName: "BARBELL_BENCH_PRESS",
              endCondition: "reps",
              endConditionValue: 5,
              weightPercentage: 80,
            },
          ],
        },
        {
          workoutId: 2,
          workoutName: "Strength Day",
          scheduledDate: "2026-02-25",
          steps: [
            {
              stepType: "interval",
              exerciseName: "BARBELL_SQUAT",
              endCondition: "reps",
              endConditionValue: 5,
              weightPercentage: 82.5,
            },
          ],
        },
      ],
    };

    const newPlan: WeeklyWorkoutPlan = {
      ...oldPlan,
      workouts: [
        oldPlan.workouts[0],
        {
          ...oldPlan.workouts[1],
          steps: [
            {
              stepType: "interval",
              exerciseName: "BARBELL_SQUAT",
              endCondition: "reps",
              endConditionValue: 5,
              weightPercentage: 87.5,
            },
          ],
        },
      ],
    };

    const summary = formatChangeSummary(oldPlan, newPlan);
    expect(summary).toContain("BARBELL_SQUAT");
    expect(summary).toContain("@82.5%");
    expect(summary).toContain("@87.5%");
    expect(summary).not.toContain("REMOVED");
  });
});

describe("formatSingleWorkoutDiff", () => {
  it("renders unscheduled date instead of undefined", () => {
    const oldWorkout = {
      ...MINIMAL_PLAN.workouts[0],
      scheduledDate: undefined,
    };

    const newWorkout = {
      ...MINIMAL_PLAN.workouts[0],
      scheduledDate: "2026-03-02",
    };

    const diff = formatSingleWorkoutDiff(oldWorkout, newWorkout);
    expect(diff).toContain("Date: unscheduled -> 2026-03-02");
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

      (adjuster as any).sendPrompt = jest
        .fn()
        .mockResolvedValue(`${JSON.stringify(MODIFIED_PLAN, null, 2)}\nSUMMARY:\n- Increased bench intensity by 5%.`);
      const result = await adjuster.analyzeAndAdjust(context);

      expect(result.adjustedPlan).toBeDefined();
      expect(Array.isArray(result.adjustedPlan.workouts)).toBe(true);
      expect(typeof result.changeSummary).toBe("string");
    });

    it("auto-selects workouts from unscheduled libraries using weeklyStructure hints", async () => {
      const unscheduledLibraryPlan: WeeklyWorkoutPlan = {
        generatedAt: "2026-03-01T00:00:00.000Z",
        weekStart: "2026-03-02",
        weekEnd: "2026-03-08",
        workouts: [
          { workoutId: 201, workoutName: "Run easy", workoutType: "running", steps: [] },
          { workoutId: 202, workoutName: "4x4", workoutType: "running", steps: [] },
          { workoutId: 203, workoutName: "Zone 2 Thursday", workoutType: "running", steps: [] },
          { workoutId: 204, workoutName: "Bike 120-135 Saturday", workoutType: "cycling", steps: [] },
          { workoutId: 205, workoutName: "Goal Pace Repeats", workoutType: "running", steps: [] },
          { workoutId: 206, workoutName: "Threshold Bike Workout", workoutType: "cycling", steps: [] },
          { workoutId: 207, workoutName: "Random Strength A", workoutType: "strength_training", steps: [] },
          { workoutId: 208, workoutName: "Random Strength B", workoutType: "strength_training", steps: [] },
          { workoutId: 123, workoutName: "09-25 - Monday", workoutType: "strength_training", steps: [] },  // Matches activity
          { workoutId: 210, workoutName: "Run Threshold Tuesday", workoutType: "running", steps: [] },
          { workoutId: 211, workoutName: "09-25 - Friday", workoutType: "strength_training", steps: [] },
          { workoutId: 212, workoutName: "Zone 2 Sunday", workoutType: "running", steps: [] },
        ],
      };

      const selectorTrainingPlan: TrainingPlan = {
        ...MINIMAL_TRAINING_PLAN,
        weeklyStructure: {
          Monday: { workoutName: "09-25 - Monday" },
          Tuesday: "Run Threshold Tuesday",
          Friday: { workoutName: "09-25 - Friday" },
          Sunday: "Off / Mobility",
        },
      };

      let capturedPrompt = "";
      (adjuster as any).sendPrompt = jest.fn().mockImplementation(async (prompt: string) => {
        capturedPrompt = prompt;
        return `${JSON.stringify({
          ...unscheduledLibraryPlan,
          workouts: [
            unscheduledLibraryPlan.workouts[8],
            unscheduledLibraryPlan.workouts[9],
            unscheduledLibraryPlan.workouts[10],
          ],
        }, null, 2)}\nSUMMARY:\n- Selected week-specific workouts.`;
      });

      await adjuster.analyzeAndAdjust({
        activities: MINIMAL_ACTIVITIES,
        currentPlan: unscheduledLibraryPlan,
        trainingPlan: selectorTrainingPlan,
      });

      expect(capturedPrompt).toContain('"09-25 - Monday"');
      expect(capturedPrompt).toContain('"Run Threshold Tuesday"');
      expect(capturedPrompt).toContain('"09-25 - Friday"');
      expect(capturedPrompt).not.toContain('"Run easy"');
      expect((adjuster as any).sendPrompt).toHaveBeenCalledTimes(1);
    });

    it("fails fast when weeklyStructure matching confidence is too low", async () => {
      const unscheduledLibraryPlan: WeeklyWorkoutPlan = {
        generatedAt: "2026-03-01T00:00:00.000Z",
        weekStart: "2026-03-02",
        weekEnd: "2026-03-08",
        workouts: [
          { workoutId: 301, workoutName: "Run easy", workoutType: "running", steps: [] },
          { workoutId: 302, workoutName: "4x4", workoutType: "running", steps: [] },
          { workoutId: 303, workoutName: "Zone 2 Thursday", workoutType: "running", steps: [] },
          { workoutId: 304, workoutName: "Threshold Bike Workout", workoutType: "cycling", steps: [] },
          { workoutId: 305, workoutName: "09-25 - Wednesday", workoutType: "strength_training", steps: [] },
          { workoutId: 123, workoutName: "09-25 - Monday", workoutType: "strength_training", steps: [] },  // Matches activity
          { workoutId: 307, workoutName: "09-25 - Friday", workoutType: "strength_training", steps: [] },
          { workoutId: 308, workoutName: "130-140 HR", workoutType: "running", steps: [] },
          { workoutId: 309, workoutName: "Tempo Run", workoutType: "running", steps: [] },
          { workoutId: 310, workoutName: "Bike Endurance", workoutType: "cycling", steps: [] },
        ],
      };

      const lowConfidenceTrainingPlan: TrainingPlan = {
        ...MINIMAL_TRAINING_PLAN,
        weeklyStructure: {
          Monday: {
            workoutName: "UNMATCHABLE_STRENGTH_DAY",
            workoutType: "strength_training",
          },
          Tuesday: {
            workoutName: "UNMATCHABLE_RUNNING_DAY",
            workoutType: "running",
          },
          Friday: {
            workoutName: "UNMATCHABLE_CYCLING_DAY",
            workoutType: "cycling",
          },
        },
      };

      (adjuster as any).sendPrompt = jest.fn().mockResolvedValue("{}\nSUMMARY:\n- should not be called");

      await expect(
        adjuster.analyzeAndAdjust({
          activities: MINIMAL_ACTIVITIES,
          currentPlan: unscheduledLibraryPlan,
          trainingPlan: lowConfidenceTrainingPlan,
        })
      ).rejects.toThrow("Unable to confidently auto-select");

      expect((adjuster as any).sendPrompt).not.toHaveBeenCalled();
    });

    it("keeps primary lift sets at baseline in early phase", async () => {
      const basePlan: WeeklyWorkoutPlan = {
        generatedAt: "2026-02-22T00:00:00.000Z",
        weekStart: "2026-02-23",
        weekEnd: "2026-03-01",
        workouts: [
          {
            workoutId: 123,  // Changed from 99 to match MINIMAL_ACTIVITIES
            workoutName: "09-25 - Monday",
            workoutType: "strength_training",
            scheduledDate: "2026-02-24",
            steps: [
              {
                stepType: "interval",
                exerciseName: "BARBELL_BENCH_PRESS",
                endCondition: "reps",
                endConditionValue: 5,
              },
              {
                stepType: "interval",
                exerciseName: "BARBELL_BENCH_PRESS",
                endCondition: "reps",
                endConditionValue: 5,
              },
              {
                stepType: "interval",
                exerciseName: "BARBELL_BENCH_PRESS",
                endCondition: "reps",
                endConditionValue: 5,
              },
              {
                stepType: "interval",
                exerciseName: "BARBELL_BENCH_PRESS",
                endCondition: "reps",
                endConditionValue: 5,
              },
            ],
          },
        ],
      };

      const reducedPlan: WeeklyWorkoutPlan = {
        ...basePlan,
        workouts: [
          {
            ...basePlan.workouts[0],
            steps: [
              {
                stepType: "interval",
                exerciseName: "BARBELL_BENCH_PRESS",
                endCondition: "reps",
                endConditionValue: 5,
              },
              {
                stepType: "interval",
                exerciseName: "BARBELL_BENCH_PRESS",
                endCondition: "reps",
                endConditionValue: 5,
              },
            ],
          },
        ],
      };

      const earlyPhaseTrainingPlan: TrainingPlan = {
        ...MINIMAL_TRAINING_PLAN,
        periodization: {
          ...MINIMAL_TRAINING_PLAN.periodization,
          weekInPhase: 1,
        },
        weeklyStructure: {
          Wednesday: {
            workoutName: "09-25 - Monday",
            exercises: [
              {
                exercise: "Barbell Bench Press",
                sets: [
                  { phase: "Warmup", sets: 1, reps: 10 },
                  { phase: "Work", sets: 4, reps: 5 },
                ],
              },
            ],
          },
        },
      };

      const context = {
        activities: MINIMAL_ACTIVITIES,
        currentPlan: basePlan,
        trainingPlan: earlyPhaseTrainingPlan,
      };

      (adjuster as any).sendPrompt = jest
        .fn()
        .mockResolvedValue(`${JSON.stringify(reducedPlan, null, 2)}\nSUMMARY:\n- Reduced bench volume.`);

      const result = await adjuster.analyzeAndAdjust(context);
      const benchSets = (result.adjustedPlan.workouts[0].steps ?? []).filter(
        (step) => step.exerciseName === "BARBELL_BENCH_PRESS"
      ).length;

      expect(benchSets).toBeGreaterThanOrEqual(4);
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

      (adjuster as any).sendPrompt = jest
        .fn()
        .mockResolvedValue(
          JSON.stringify({
            weekStart: "2026-02-16",
            weekEnd: "2026-02-22",
            summary: "Good adherence with one missed accessory block.",
            adherence: "partial",
            adjustmentsMade: "Reduced lower-body volume by one set.",
          })
        );
      await adjuster.appendWeekSummary(context, planPath);

      const updated = JSON.parse(fs.readFileSync(planPath, "utf-8")) as TrainingPlan;
      expect(updated.weeklyHistory.length).toBeGreaterThanOrEqual(1);
      expect(updated.weeklyHistory[0].weekStart).toBe("2026-02-16");
      expect(updated.updatedAt).not.toBe("2026-02-22T00:00:00.000Z");
    });
  });

  describe("revisitTrainingPlan", () => {
    it("returns a revised training plan and summary from LLM response", async () => {
      const revised: TrainingPlan = {
        ...MINIMAL_TRAINING_PLAN,
        updatedAt: "2026-03-01T00:00:00.000Z",
        periodization: {
          ...MINIMAL_TRAINING_PLAN.periodization,
          weekInPhase: 1,
          currentPhase: "Strength",
          phases: [
            { name: "Strength", totalWeeks: 4 },
            { name: "Deload", totalWeeks: 1 },
          ],
        },
      };

      (adjuster as any).sendPrompt = jest
        .fn()
        .mockResolvedValue(`${JSON.stringify(revised, null, 2)}\nSUMMARY:\n- Updated periodization for current block.`);

      const result = await adjuster.revisitTrainingPlan(MINIMAL_TRAINING_PLAN, {
        reviewNotes: "Bias toward strength this block.",
      });

      expect(result.updatedPlan.periodization.currentPhase).toBe("Strength");
      expect(result.updatedPlan.periodization.weekInPhase).toBe(1);
      expect(result.summary).toContain("Updated periodization");
    });

    it("retries once when first response is invalid", async () => {
      const revised: TrainingPlan = {
        ...MINIMAL_TRAINING_PLAN,
        updatedAt: "2026-03-01T00:00:00.000Z",
      };

      (adjuster as any).sendPrompt = jest
        .fn()
        .mockResolvedValueOnce("not valid json")
        .mockResolvedValueOnce(`${JSON.stringify(revised, null, 2)}\nSUMMARY:\n- Kept core goals, refreshed metadata.`);

      const result = await adjuster.revisitTrainingPlan(MINIMAL_TRAINING_PLAN);

      expect(result.updatedPlan.goals.primary).toBe(MINIMAL_TRAINING_PLAN.goals.primary);
      expect(((adjuster as any).sendPrompt as jest.Mock).mock.calls.length).toBe(2);
    });
  });

  describe("cleanup (mock mode)", () => {
    it("completes without throwing", async () => {
      await expect(adjuster.cleanup()).resolves.not.toThrow();
    });
  });
});

// ─── sendPromptCopilotSdk timing ─────────────────────────────────────────────

describe("sendPromptCopilotSdk timing", () => {
  let adjuster: WorkoutAdjuster;
  let stdoutChunks: string[];

  beforeEach(() => {
    adjuster = new WorkoutAdjuster({ mockMode: false });
    stdoutChunks = [];
    jest.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Build a mock session that emits events synchronously when send() is called. */
  function makeMockSession(opts: { withDelta?: boolean } = {}) {
    const handlers: Record<string, Array<(event: any) => void>> = {};

    return {
      on: jest.fn().mockImplementation((event: string, handler: (e: any) => void) => {
        (handlers[event] ??= []).push(handler);
        return () => { handlers[event] = handlers[event].filter(h => h !== handler); };
      }),
      send: jest.fn().mockImplementation(() => {
        if (opts.withDelta) {
          (handlers["assistant.message_delta"] ?? []).forEach(h =>
            h({ data: { deltaContent: "tok" } })
          );
        }
        (handlers["assistant.message"] ?? []).forEach(h =>
          h({ data: { content: '{"workouts":[]}' } })
        );
        return Promise.resolve();
      }),
      destroy: jest.fn().mockResolvedValue(undefined),
    };
  }

  it("logs callLabel, prompt chars, TTFT and total after streaming response", async () => {
    (adjuster as any).session = makeMockSession({ withDelta: true });

    await (adjuster as any).sendPromptCopilotSdk("hello world", "analyzeAndAdjust");

    const output = stdoutChunks.join("");
    expect(output).toContain("[analyzeAndAdjust]");
    expect(output).toContain("TTFT:");
    expect(output).toContain("total:");
    expect(output).toContain("chars");
    // Prompt is "hello world" (11 chars)
    expect(output).toContain("11");
  });

  it("reports TTFT: n/a when no delta events fired (non-streaming)", async () => {
    (adjuster as any).session = makeMockSession({ withDelta: false });

    await (adjuster as any).sendPromptCopilotSdk("some prompt", "appendWeekSummary");

    const output = stdoutChunks.join("");
    expect(output).toContain("TTFT: n/a");
    expect(output).toContain("[appendWeekSummary]");
  });

  it("includes correct prompt char count for a longer prompt", async () => {
    (adjuster as any).session = makeMockSession({ withDelta: true });

    const prompt = "x".repeat(500);
    await (adjuster as any).sendPromptCopilotSdk(prompt, "iterateSingleWorkout");

    const output = stdoutChunks.join("");
    expect(output).toContain("500");
    expect(output).toContain("[iterateSingleWorkout]");
  });

  it("timing line includes different labels for different call sites", async () => {
    for (const label of ["revisitTrainingPlan", "retry", "iterate"]) {
      stdoutChunks = [];
      (adjuster as any).session = makeMockSession({ withDelta: false });
      await (adjuster as any).sendPromptCopilotSdk("p", label);
      expect(stdoutChunks.join("")).toContain(`[${label}]`);
    }
  });
});

// ─── Two-phase LLM methods ────────────────────────────────────────────────────

describe("matchActivityToWorkout", () => {
  let adjuster: WorkoutAdjuster;

  beforeEach(() => {
    adjuster = new WorkoutAdjuster({ mockMode: true });
  });

  const workout = MINIMAL_PLAN.workouts[0]; // workoutId 123, scheduledDate 2026-02-23, strength_training

  it("matches by workoutId", () => {
    const result = (adjuster as any).matchActivityToWorkout(
      workout,
      MINIMAL_ACTIVITIES,
      new Set()
    );
    expect(result?.id).toBe("123");
  });

  it("matches by same date and compatible type when workoutId differs", () => {
    const activities: ExtractedActivities = {
      ...MINIMAL_ACTIVITIES,
      activities: [
        {
          id: "abc",
          activityName: "Bench day",
          activityType: "strength_training",
          startTime: "2026-02-23 09:00:00",
          duration: 3600,
        },
      ],
    };
    const w = { ...workout, workoutId: undefined };
    const result = (adjuster as any).matchActivityToWorkout(w, activities, new Set());
    expect(result?.id).toBe("abc");
  });

  it("matches by day-of-week when no exact date match", () => {
    // activity is on a Monday (2026-02-16), workout is on a Monday (2026-02-23)
    const w = { ...workout, workoutId: undefined };
    const result = (adjuster as any).matchActivityToWorkout(
      w,
      MINIMAL_ACTIVITIES,
      new Set()
    );
    expect(result?.id).toBe("123");
  });

  it("returns undefined when no activity is compatible", () => {
    const activities: ExtractedActivities = {
      ...MINIMAL_ACTIVITIES,
      activities: [
        {
          id: "run1",
          activityName: "Easy Run",
          activityType: "running",
          startTime: "2026-02-17 07:00:00",
          duration: 1800,
        },
      ],
    };
    const result = (adjuster as any).matchActivityToWorkout(
      workout,
      activities,
      new Set()
    );
    expect(result).toBeUndefined();
  });

  it("skips activities already in usedIds", () => {
    const usedIds = new Set(["123"]);
    const result = (adjuster as any).matchActivityToWorkout(
      workout,
      MINIMAL_ACTIVITIES,
      usedIds
    );
    expect(result).toBeUndefined();
  });
});

describe("getWeeklySummary (mock mode)", () => {
  let adjuster: WorkoutAdjuster;

  beforeEach(() => {
    adjuster = new WorkoutAdjuster({ mockMode: true });
  });

  it("returns a WeeklySummaryResult without calling LLM in mock mode", async () => {
    const result = await adjuster.getWeeklySummary(
      MINIMAL_ACTIVITIES,
      MINIMAL_TRAINING_PLAN
    );
    expect(result.summaryText).toContain("1 session");
    expect(result.phase).toBe("Hypertrophy");
    expect(result.weekInPhase).toBe(2);
    expect(result.readinessSignal).toBe("moderate");
  });

  it("parses HIGH readiness signal from sendPrompt response", async () => {
    const adjusterReal = new WorkoutAdjuster({ mockMode: false });
    (adjusterReal as any).sendPrompt = jest
      .fn()
      .mockResolvedValue("- Completed all sessions.\n- Performance excellent.\n- HIGH");
    const result = await adjusterReal.getWeeklySummary(
      MINIMAL_ACTIVITIES,
      MINIMAL_TRAINING_PLAN
    );
    expect(result.readinessSignal).toBe("high");
    expect(result.summaryText).toContain("Completed all sessions");
  });

  it("defaults readinessSignal to moderate when not found", async () => {
    const adjusterReal = new WorkoutAdjuster({ mockMode: false });
    (adjusterReal as any).sendPrompt = jest
      .fn()
      .mockResolvedValue("- Some summary without a signal word.");
    const result = await adjusterReal.getWeeklySummary(
      MINIMAL_ACTIVITIES,
      MINIMAL_TRAINING_PLAN
    );
    expect(result.readinessSignal).toBe("moderate");
  });
});

describe("generateSingleWorkout (mock mode)", () => {
  let adjuster: WorkoutAdjuster;

  beforeEach(() => {
    adjuster = new WorkoutAdjuster({ mockMode: true });
  });

  it("returns original workout unchanged in mock mode", async () => {
    const result = await adjuster.generateSingleWorkout(
      MINIMAL_PLAN.workouts[0],
      { summaryText: "mock", phase: "Hypertrophy", weekInPhase: 2, readinessSignal: "moderate" },
      undefined,
      MINIMAL_TRAINING_PLAN
    );
    expect(result).toEqual(MINIMAL_PLAN.workouts[0]);
  });

  it("parses the PlannedWorkout JSON from LLM response", async () => {
    const adjusterReal = new WorkoutAdjuster({ mockMode: false });
    const modifiedWorkout = { ...MINIMAL_PLAN.workouts[0], workoutName: "Modified Bench" };
    (adjusterReal as any).sendPrompt = jest
      .fn()
      .mockResolvedValue(`${JSON.stringify(modifiedWorkout, null, 2)}\nSUMMARY:\n- Bumped intensity.`);
    const result = await adjusterReal.generateSingleWorkout(
      MINIMAL_PLAN.workouts[0],
      { summaryText: "good week", phase: "Hypertrophy", weekInPhase: 2, readinessSignal: "high" },
      undefined,
      MINIMAL_TRAINING_PLAN
    );
    expect(result.workoutName).toBe("Modified Bench");
  });

  it("falls back to original workout when JSON parse fails", async () => {
    const adjusterReal = new WorkoutAdjuster({ mockMode: false });
    (adjusterReal as any).sendPrompt = jest
      .fn()
      .mockResolvedValue("This is not JSON at all.\nSUMMARY:\n- Something.");
    const original = MINIMAL_PLAN.workouts[0];
    const result = await adjusterReal.generateSingleWorkout(
      original,
      { summaryText: "week", phase: "Hypertrophy", weekInPhase: 2, readinessSignal: "moderate" },
      undefined,
      MINIMAL_TRAINING_PLAN
    );
    expect(result).toEqual(original);
  });
});

describe("analyzeAndAdjustTwoPhase (mock mode)", () => {
  let adjuster: WorkoutAdjuster;

  beforeEach(() => {
    adjuster = new WorkoutAdjuster({ mockMode: true });
  });

  it("returns an AdjustmentResult with the workout plan", async () => {
    const context = {
      activities: MINIMAL_ACTIVITIES,
      currentPlan: MINIMAL_PLAN,
      trainingPlan: MINIMAL_TRAINING_PLAN,
    };
    const result = await adjuster.analyzeAndAdjustTwoPhase(context);
    expect(result.adjustedPlan).toBeDefined();
    expect(Array.isArray(result.adjustedPlan.workouts)).toBe(true);
    expect(typeof result.changeSummary).toBe("string");
    expect(typeof result.llmReasoning).toBe("string");
  });

  it("fires onProgress callback for phase 1 and each workout", async () => {
    const progress: string[] = [];
    const context = {
      activities: MINIMAL_ACTIVITIES,
      currentPlan: MINIMAL_PLAN,
      trainingPlan: MINIMAL_TRAINING_PLAN,
    };
    await adjuster.analyzeAndAdjustTwoPhase(context, (step) => progress.push(step));
    expect(progress.some((s) => s.includes("Step 7a"))).toBe(true);
    expect(progress.some((s) => s.includes("Step 7b"))).toBe(true);
    expect(progress.some((s) => s.includes("Monday Bench"))).toBe(true);
  });

  it("calls getWeeklySummary once then generateSingleWorkout per workout", async () => {
    const summarySpy = jest.spyOn(adjuster as any, "getWeeklySummary");
    const genSpy = jest.spyOn(adjuster as any, "generateSingleWorkout");
    const context = {
      activities: MINIMAL_ACTIVITIES,
      currentPlan: MINIMAL_PLAN,
      trainingPlan: MINIMAL_TRAINING_PLAN,
    };
    await adjuster.analyzeAndAdjustTwoPhase(context);
    expect(summarySpy).toHaveBeenCalledTimes(1);
    expect(genSpy).toHaveBeenCalledTimes(MINIMAL_PLAN.workouts.length);
  });

  it("falls back to original template when generateSingleWorkout throws", async () => {
    jest
      .spyOn(adjuster as any, "generateSingleWorkout")
      .mockRejectedValue(new Error("LLM timeout"));
    const context = {
      activities: MINIMAL_ACTIVITIES,
      currentPlan: MINIMAL_PLAN,
      trainingPlan: MINIMAL_TRAINING_PLAN,
    };
    const result = await adjuster.analyzeAndAdjustTwoPhase(context);
    // Should still return a plan with the original workout, not throw
    expect(result.adjustedPlan.workouts).toHaveLength(MINIMAL_PLAN.workouts.length);
    expect(result.adjustedPlan.workouts[0].workoutName).toBe("Monday Bench");
  });
});
