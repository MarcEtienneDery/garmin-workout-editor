jest.mock("@flow-js/garmin-connect", () => ({
  GarminConnect: jest.fn().mockImplementation(() => ({
    login: jest.fn().mockResolvedValue(true),
    getUserProfile: jest.fn().mockResolvedValue({ userName: "tester" }),
    getActivities: jest.fn().mockResolvedValue([]),
    getActivity: jest.fn().mockResolvedValue({}),
  })),
}));

import ActivityExporter from "../activityExporter";
import { GarminClient } from "../shared/garminClient";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getMockClient, normalizeActivityType } from "../mocks.setup";

describe("ActivityExporter", () => {
  let tempDir: string;
  let exporter: ActivityExporter;
  let garminClient: GarminClient;

  beforeEach(() => {
    // Create a temporary directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "garmin-test-"));
    garminClient = new GarminClient("test@example.com", "password123", true); // mock mode
    exporter = new ActivityExporter(garminClient);
  });

  afterEach(() => {
    // Clean up temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("Mock Mode", () => {
    it("should generate mock activities successfully", async () => {
      const limit = 10;
      const outputPath = path.join(tempDir, "activities.json");

      const result = await exporter.extract(limit, outputPath);

      expect(result).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
    });

    it("should create activities.json with correct structure", async () => {
      const limit = 5;
      const outputPath = path.join(tempDir, "activities.json");

      await exporter.extract(limit, outputPath);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);

      expect(data).toHaveProperty("extractedAt");
      expect(data).toHaveProperty("totalActivities");
      expect(data).toHaveProperty("activities");
      expect(Array.isArray(data.activities)).toBe(true);
      expect(data.totalActivities).toBe(limit);
      expect(data.activities.length).toBe(limit);
    });

    it("should create activities with required fields", async () => {
      const outputPath = path.join(tempDir, "activities.json");

      await exporter.extract(1, outputPath);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);
      const activity = data.activities[0];

      // Core required fields
      expect(activity).toHaveProperty("id");
      expect(activity).toHaveProperty("activityName");
      expect(activity).toHaveProperty("activityType");
      expect(activity).toHaveProperty("startTime");
      expect(activity).toHaveProperty("duration");

      // Week metadata
      expect(data).toHaveProperty("weekStart");
      expect(data).toHaveProperty("weekEnd");
    });

    it("should include optional HR metrics", async () => {
      const outputPath = path.join(tempDir, "activities.json");

      await exporter.extract(1, outputPath);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);
      const activity = data.activities[0];

      expect(activity).toHaveProperty("avgHR");
      expect(activity).toHaveProperty("maxHR");
    });

    it("should generate valid ISO date strings", async () => {
      const outputPath = path.join(tempDir, "activities.json");

      await exporter.extract(5, outputPath);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);

      data.activities.forEach((activity: any) => {
        expect(() => new Date(activity.startTime)).not.toThrow();
        expect(new Date(activity.startTime).toISOString()).toBe(
          activity.startTime
        );
      });
    });

    it("should support different limits", async () => {
      const testCases = [1, 5, 10, 20, 50];

      for (const limit of testCases) {
        const outputPath = path.join(tempDir, `activities-${limit}.json`);
        await exporter.extract(limit, outputPath);

        const fileContent = fs.readFileSync(outputPath, "utf-8");
        const data = JSON.parse(fileContent);

        expect(data.totalActivities).toBe(limit);
        expect(data.activities.length).toBe(limit);
      }
    });

    it("should save to custom path", async () => {
      const customPath = path.join(
        tempDir,
        "custom",
        "nested",
        "activities.json"
      );

      await exporter.extract(5, customPath);

      expect(fs.existsSync(customPath)).toBe(true);
    });

    it("should create directory if it does not exist", async () => {
      const nestedPath = path.join(tempDir, "new", "nested", "dir");
      const outputPath = path.join(nestedPath, "activities.json");

      expect(fs.existsSync(nestedPath)).toBe(false);

      await exporter.extract(1, outputPath);

      expect(fs.existsSync(outputPath)).toBe(true);
    });

    it("should write valid JSON", async () => {
      const outputPath = path.join(tempDir, "activities.json");

      await exporter.extract(5, outputPath);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      expect(() => JSON.parse(fileContent)).not.toThrow();
    });

    it("should format JSON with proper indentation", async () => {
      const outputPath = path.join(tempDir, "activities.json");

      await exporter.extract(1, outputPath);

      const fileContent = fs.readFileSync(outputPath, "utf-8");

      // Check that JSON is pretty-printed (has newlines and indentation)
      expect(fileContent).toContain("\n");
      expect(fileContent).toContain("  ");
    });

    it("should save full raw activities when enabled", async () => {
      const outputPath = path.join(tempDir, "activities.json");

      await exporter.extract(5, outputPath, true, false, false);

      const rawPath = outputPath.replace(".json", "-raw.json");
      expect(fs.existsSync(rawPath)).toBe(true);
    });
  });

  describe("Helper Methods", () => {
    it("should convert speed to pace", () => {
      const speedToPace = (exporter as any).speedToPace.bind(exporter);
      expect(speedToPace(undefined)).toBeUndefined();
      expect(speedToPace(0)).toBeUndefined();
      const pace = speedToPace(3); // 3 m/s
      expect(pace).toBeCloseTo(1000 / 3 / 60, 6);
    });

    it("should format exercise names", () => {
      const format = (exporter as any).formatExerciseName.bind(exporter);
      expect(format("BARBELL_BENCH_PRESS")).toBe("Barbell Bench Press");
      expect(format(undefined)).toBe("Unknown Exercise");
    });

    it("should convert Garmin weight to lbs", () => {
      const convert = (exporter as any).convertGarminWeight.bind(exporter);
      expect(convert(0)).toBe(0);
      expect(convert(453.6)).toBe(1);
      expect(convert(9072)).toBe(20);
    });
  });

  describe("Interval Extraction", () => {
    it("should include interval stats for running activities", () => {
      const transformActivities = (exporter as any).transformActivities.bind(exporter);
      const rawActivities = [
        {
          activityId: "1",
          activityName: "Interval Run",
          activityType: { typeKey: "running" },
          startTimeGMT: new Date().toISOString(),
          duration: 1200,
          averageHR: 150,
          maxHR: 180,
          intervals: [
            {
              intervalName: "Interval 1",
              duration: 90,
              distance: 400,
              averageSpeed: 4,
              splitType: "WORK",
              avgHR: 160,
              maxHR: 175,
            },
            {
              intervalName: "Interval 2",
              duration: 120,
              distance: 500,
              averageSpeed: 3.5,
              splitType: "RWD_WALK",
              avgHR: 158,
              maxHR: 170,
            },
          ],
        },
      ];

      const result = transformActivities(rawActivities)[0];

      expect(Array.isArray(result.exerciseSets)).toBe(true);
      expect(result.exerciseSets.length).toBe(1);
      expect(result.exerciseSets[0].exerciseName).toBe("Interval 1");
      expect(result.exerciseSets[0].duration).toBe(90);
      expect(result.exerciseSets[0].distance).toBeCloseTo(0.4, 3);
      expect(result.exerciseSets[0].pace).toBeCloseTo(1000 / 4 / 60, 6);
      expect(result.exerciseSets[0].avgHR).toBe(160);
      expect(result.exerciseSets[0].maxHR).toBe(175);
      expect(result.exerciseSets[0].splitType).toBe("WORK");
    });
  });

  describe("Strength Set Consolidation (fullExerciseSets)", () => {
    let transformActivities: (activities: any[]) => any[];

    beforeEach(() => {
      transformActivities = (exporter as any).transformActivities.bind(exporter);
    });

    const makeStrengthActivity = (fullExerciseSets: any[]) => ({
      activityId: "1",
      activityName: "Strength",
      activityType: { typeKey: "strength_training" },
      startTimeGMT: new Date().toISOString(),
      duration: 3600,
      averageHR: 110,
      maxHR: 140,
      totalSets: fullExerciseSets.length,
      totalReps: 0,
      fullExerciseSets,
    });

    const activeSet = (category: string, reps: number, weightTenthsGrams: number, name?: string) => ({
      setType: "ACTIVE",
      exercises: [{ category, name: name ?? null }],
      repetitionCount: reps,
      weight: weightTenthsGrams,
    });

    it("should combine consecutive same-exercise sets with uniform reps and weight into sets++", () => {
      const activity = makeStrengthActivity([
        activeSet("DEADLIFT", 5, 129276),  // ~285 lbs
        activeSet("DEADLIFT", 5, 129276),
        activeSet("DEADLIFT", 5, 129276),
        activeSet("DEADLIFT", 5, 129276),
      ]);

      const result = transformActivities([activity])[0];

      expect(result.exerciseSets).toHaveLength(1);
      expect(result.exerciseSets[0]).toMatchObject({ sets: 4, reps: 5 });
      expect(result.exerciseSets[0].repsList).toBeUndefined();
      expect(result.exerciseSets[0].weightList).toBeUndefined();
    });

    it("should combine consecutive sets with changing weight into weightList", () => {
      const activity = makeStrengthActivity([
        activeSet("DEADLIFT", 10, 83916),  // ~185 lbs warmup
        activeSet("DEADLIFT", 5, 129276),  // ~285 lbs
        activeSet("DEADLIFT", 5, 129276),
        activeSet("DEADLIFT", 5, 129276),
        activeSet("DEADLIFT", 5, 129276),
      ]);

      const result = transformActivities([activity])[0];

      expect(result.exerciseSets).toHaveLength(1);
      const s = result.exerciseSets[0];
      expect(s.sets).toBe(5);
      expect(s.repsList).toEqual([10, 5, 5, 5, 5]);
      expect(s.weightList).toEqual([185, 285, 285, 285, 285]);
      expect(s.reps).toBeUndefined();
      expect(s.weight).toBeUndefined();
    });

    it("should accumulate volume correctly when consolidating", () => {
      const activity = makeStrengthActivity([
        activeSet("BENCH_PRESS", 5, 129276),  // ~285 lbs
        activeSet("BENCH_PRESS", 5, 129276),
        activeSet("BENCH_PRESS", 5, 129276),
      ]);

      const result = transformActivities([activity])[0];
      const set = result.exerciseSets[0];

      expect(set.sets).toBe(3);
      expect(set.volume).toBe(set.sets * set.reps * set.weight);
    });

    it("should not combine non-consecutive sets even if identical", () => {
      const activity = makeStrengthActivity([
        activeSet("DEADLIFT", 5, 129276),
        activeSet("SQUAT", 5, 129276),
        activeSet("DEADLIFT", 5, 129276),  // same as first but not consecutive
      ]);

      const result = transformActivities([activity])[0];

      expect(result.exerciseSets).toHaveLength(3);
    });

    it("should combine consecutive same-exercise/same-weight sets with varying reps into repsList", () => {
      const activity = makeStrengthActivity([
        activeSet("SHOULDER_PRESS", 14, 49896),  // ~110 lbs
        activeSet("SHOULDER_PRESS", 11, 49896),
        activeSet("SHOULDER_PRESS", 10, 49896),
      ]);

      const result = transformActivities([activity])[0];

      expect(result.exerciseSets).toHaveLength(1);
      const s = result.exerciseSets[0];
      expect(s.sets).toBe(3);
      expect(s.reps).toBeUndefined();
      expect(s.repsList).toEqual([14, 11, 10]);
      expect(s.volume).toBe(14 * s.weight + 11 * s.weight + 10 * s.weight);
    });

    it("should combine consecutive sets with same exercise but different weights into weightList", () => {
      const activity = makeStrengthActivity([
        activeSet("DEADLIFT", 5, 83916),   // ~185 lbs
        activeSet("DEADLIFT", 5, 129276),  // ~285 lbs
      ]);

      const result = transformActivities([activity])[0];

      expect(result.exerciseSets).toHaveLength(1);
      const s = result.exerciseSets[0];
      expect(s.sets).toBe(2);
      expect(s.reps).toBe(5);           // uniform reps → no repsList
      expect(s.repsList).toBeUndefined();
      expect(s.weight).toBeUndefined();
      expect(s.weightList).toEqual([185, 285]);
    });

    it("should filter out non-ACTIVE set types", () => {
      const activity = makeStrengthActivity([
        { setType: "REST", exercises: [{ category: "DEADLIFT" }], repetitionCount: 0, weight: 0 },
        activeSet("DEADLIFT", 5, 129276),
        { setType: "WARMUP", exercises: [{ category: "DEADLIFT" }], repetitionCount: 5, weight: 83916 },
        activeSet("DEADLIFT", 5, 129276),
      ]);

      const result = transformActivities([activity])[0];

      expect(result.exerciseSets).toHaveLength(1);
      expect(result.exerciseSets[0].sets).toBe(2);
    });

    it("should detect a 2-exercise superset and collapse into 2 tagged entries", () => {
      // BENCH, CURL alternating 3 rounds
      const activity = makeStrengthActivity([
        activeSet("BENCH_PRESS", 12, 74844),
        activeSet("CURL", 10, 31752),
        activeSet("BENCH_PRESS", 11, 74844),
        activeSet("CURL", 8, 31752),
        activeSet("BENCH_PRESS", 11, 74844),
        activeSet("CURL", 8, 31752),
      ]);

      const result = transformActivities([activity])[0];

      expect(result.exerciseSets).toHaveLength(2);
      const bench = result.exerciseSets[0];
      const curl = result.exerciseSets[1];
      expect(bench.sets).toBe(3);
      expect(bench.repsList).toEqual([12, 11, 11]);
      expect(bench.supersetGroup).toBe(curl.supersetGroup);
      expect(curl.sets).toBe(3);
      expect(curl.repsList).toEqual([10, 8, 8]);
    });

    it("should include partial last round in the superset", () => {
      // BENCH, CURL, PLANK × 2 rounds, then partial 3rd round (BENCH, CURL only)
      const activity = makeStrengthActivity([
        activeSet("BENCH_PRESS", 12, 74844),
        activeSet("CURL", 10, 31752),
        activeSet("PLANK", 0, 0),
        activeSet("BENCH_PRESS", 11, 74844),
        activeSet("CURL", 8, 31752),
        activeSet("PLANK", 0, 0),
        activeSet("BENCH_PRESS", 11, 74844),
        activeSet("CURL", 8, 31752),
      ]);

      const result = transformActivities([activity])[0];

      expect(result.exerciseSets).toHaveLength(3);
      const [bench, curl, plank] = result.exerciseSets;
      expect(bench.sets).toBe(3);
      expect(bench.repsList).toEqual([12, 11, 11]);
      expect(curl.sets).toBe(3);
      expect(plank.sets).toBe(2);  // only appeared in 2 of 3 rounds
      expect(bench.supersetGroup).toBe(curl.supersetGroup);
      expect(bench.supersetGroup).toBe(plank.supersetGroup);
    });

    it("should accumulate volume across superset rounds", () => {
      const activity = makeStrengthActivity([
        activeSet("BENCH_PRESS", 5, 74844),
        activeSet("CURL", 10, 31752),
        activeSet("BENCH_PRESS", 5, 74844),
        activeSet("CURL", 10, 31752),
      ]);

      const result = transformActivities([activity])[0];
      const bench = result.exerciseSets[0];
      const curl = result.exerciseSets[1];

      // uniform reps → no repsList
      expect(bench.repsList).toBeUndefined();
      expect(bench.sets).toBe(2);
      expect(bench.volume).toBe(2 * 5 * bench.weight);
      expect(curl.sets).toBe(2);
      expect(curl.volume).toBe(2 * 10 * curl.weight);
    });

    it("should not detect a superset in fewer than 4 entries", () => {
      const activity = makeStrengthActivity([
        activeSet("BENCH_PRESS", 5, 74844),
        activeSet("CURL", 10, 31752),
        activeSet("BENCH_PRESS", 5, 74844),
      ]);

      const result = transformActivities([activity])[0];

      // 3 entries, too short for superset detection
      expect(result.exerciseSets).toHaveLength(3);
      result.exerciseSets.forEach((s: any) => expect(s.supersetGroup).toBeUndefined());
    });

    it("should use exercise name (subcategory) over category for exerciseName", () => {
      const activity = makeStrengthActivity([
        activeSet("DEADLIFT", 5, 129276, "BARBELL_DEADLIFT"),
      ]);

      const result = transformActivities([activity])[0];

      expect(result.exerciseSets[0].exerciseName).toBe("Barbell Deadlift");
      expect(result.exerciseSets[0].category).toBe("DEADLIFT");
    });

    it("should fall back to category for exerciseName when name is null", () => {
      const activity = makeStrengthActivity([
        activeSet("DEADLIFT", 5, 129276, undefined),
      ]);

      const result = transformActivities([activity])[0];

      expect(result.exerciseSets[0].exerciseName).toBe("Deadlift");
    });

    it("should fall back to summarizedExerciseSets when fullExerciseSets is absent", () => {
      const activity = {
        activityId: "2",
        activityName: "Strength",
        activityType: { typeKey: "strength_training" },
        startTimeGMT: new Date().toISOString(),
        duration: 3600,
        averageHR: 110,
        maxHR: 140,
        totalSets: 4,
        totalReps: 20,
        summarizedExerciseSets: [
          { category: "SQUAT", subCategory: "BARBELL_SQUAT", sets: 4, reps: 20, maxWeight: 90720, volume: 8000 },
        ],
      };

      const result = transformActivities([activity])[0];

      expect(result.exerciseSets.length).toBeGreaterThan(0);
      // Fallback uses splitWarmupTopBackoffSets so names include suffixes
      expect(result.exerciseSets.some((s: any) => s.exerciseName.includes("Barbell Squat"))).toBe(true);
    });
  });

  describe("Strength Set Splitting", () => {
    it("should split main lifts into warmup, top set, and backoff in order", () => {
      const split = (exporter as any).splitWarmupTopBackoffSets.bind(exporter);
      const result = split({
        category: "BENCH_PRESS",
        subCategory: "BARBELL_BENCH_PRESS",
        sets: 4,
        reps: 20,
        maxWeight: 90720,
        volume: 2000,
      });

      expect(result.length).toBe(3);
      expect(result[0].exerciseName).toBe("Barbell Bench Press (Warmup)");
      expect(result[1].exerciseName).toBe("Barbell Bench Press (Top Set)");
      expect(result[2].exerciseName).toBe("Barbell Bench Press (Backoff Set)");
      expect(result[1].weight).toBeGreaterThan(result[0].weight);
    });
  });

  describe("Last Week Filtering", () => {
    it("should correctly identify last week dates in UTC", () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-02-08T12:00:00Z")); // Sunday
      const getLastWeekDates = (exporter as any).getLastWeekDates.bind(exporter);
      
      const { weekStart, weekEnd } = getLastWeekDates();

      // Feb 8, 2026 is Sunday, so:
      // Current week: Mon Feb 2 - Sun Feb 8
      // Last week: Mon Jan 26 - Sun Feb 1
      expect(weekStart.toISOString().split("T")[0]).toBe("2026-01-26");
      expect(weekEnd.toISOString().split("T")[0]).toBe("2026-02-01");
      
      jest.useRealTimers();
    });

    it("should filter activities to only those from last week", () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-02-08T12:00:00Z")); // Sunday, Feb 8
      const filterLastWeekActivities = (exporter as any).filterLastWeekActivities.bind(exporter);

      const activities = [
        // Last week activities (Jan 26 - Feb 1)
        { startTimeGMT: "2026-01-26T10:00:00Z" },
        { startTimeGMT: "2026-01-28T15:00:00Z" },
        { startTimeGMT: "2026-02-01T23:00:00Z" },
        // This week activities (Feb 2-8)
        { startTimeGMT: "2026-02-02T08:00:00Z" },
        { startTimeGMT: "2026-02-08T10:00:00Z" },
        // Previous-previous week
        { startTimeGMT: "2026-01-25T10:00:00Z" },
        { startTimeGMT: "2026-01-20T15:00:00Z" },
      ];

      const result = filterLastWeekActivities(activities);

      // Should only include Jan 26 - Feb 1
      expect(result.length).toBe(3);
      expect(result[0].startTimeGMT).toBe("2026-01-26T10:00:00Z");
      expect(result[1].startTimeGMT).toBe("2026-01-28T15:00:00Z");
      expect(result[2].startTimeGMT).toBe("2026-02-01T23:00:00Z");

      jest.useRealTimers();
    });

    it("should handle startTimeLocal as fallback", () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-02-08T12:00:00Z")); // Sunday, Feb 8
      const filterLastWeekActivities = (exporter as any).filterLastWeekActivities.bind(exporter);

      const activities = [
        // Using startTimeLocal instead of startTimeGMT
        { startTimeLocal: "2026-01-28T10:00:00Z" }, // Within last week
        { startTimeLocal: "2026-02-10T10:00:00Z" }, // Outside last week
      ];

      const result = filterLastWeekActivities(activities);

      // Should only include Jan 28 (within last week Jan 26 - Feb 1)
      expect(result.length).toBe(1);
      expect(result[0].startTimeLocal).toBe("2026-01-28T10:00:00Z");

      jest.useRealTimers();
    });

    it("should handle edge case at week boundaries", () => {
      // Test on Monday of current week (Feb 2)
      jest.useFakeTimers().setSystemTime(new Date("2026-02-02T00:00:01Z")); // Monday, Feb 2
      const filterLastWeekActivities = (exporter as any).filterLastWeekActivities.bind(exporter);

      const activities = [
        { startTimeGMT: "2026-02-01T23:59:59Z" }, // Last moment of last week
        { startTimeGMT: "2026-02-02T00:00:00Z" }, // First moment of this week
        { startTimeGMT: "2026-01-26T00:00:00Z" }, // Start of last week
      ];

      const result = filterLastWeekActivities(activities);

      // Should include Jan 26 & Feb 1, but not Feb 2
      expect(result.length).toBe(2);

      jest.useRealTimers();
    });

    it("should not filter when filterToLastWeek is false", async () => {
      const outputPath = path.join(tempDir, "unfiltered.json");

      // Extract without last week filter
      await exporter.extract(5, outputPath, false, false, false);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);

      // Should include all 5 activities regardless of date
      expect(data.totalActivities).toBe(5);
      expect(data.activities.length).toBe(5);
    });

    it("should filter when filterToThisWeek is true", async () => {
      const outputPath = path.join(tempDir, "this-week-filtered.json");

      // Mock the getThisWeekDates to control the week range
      jest.useFakeTimers().setSystemTime(new Date("2026-02-08T12:00:00Z")); // Sunday in current week

      // Extract WITH this week filter
      await exporter.extract(10, outputPath, false, false, false, true);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);

      // Total activities should be <= 10 (filtered to only this week)
      expect(data.activities.length).toBeLessThanOrEqual(10);
      expect(data.weekStart).toBeDefined();
      expect(data.weekEnd).toBeDefined();

      // All activities should be within the week range
      const weekStart = new Date(data.weekStart);
      const weekEnd = new Date(data.weekEnd);

      data.activities.forEach((activity: any) => {
        const activityDate = new Date(activity.startTime);
        expect(activityDate.getTime()).toBeGreaterThanOrEqual(weekStart.getTime());
        expect(activityDate.getTime()).toBeLessThanOrEqual(weekEnd.getTime() + 86400000); // +1 day to account for end-of-day
      });

      jest.useRealTimers();
    });
  });

  describe("This Week Filtering", () => {
    it("should correctly identify this week dates in UTC", () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-02-08T12:00:00Z")); // Sunday
      const getThisWeekDates = (exporter as any).getThisWeekDates.bind(exporter);

      const { weekStart, weekEnd } = getThisWeekDates();

      // Feb 8, 2026 is Sunday, so:
      // This week: Mon Feb 2 - Sun Feb 8
      expect(weekStart.toISOString().split("T")[0]).toBe("2026-02-02");
      expect(weekEnd.toISOString().split("T")[0]).toBe("2026-02-08");

      jest.useRealTimers();
    });

    it("should filter activities to only those from this week", () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-02-08T12:00:00Z")); // Sunday, Feb 8
      const filterThisWeekActivities = (exporter as any).filterThisWeekActivities.bind(exporter);

      const activities = [
        // This week activities (Feb 2-8)
        { startTimeGMT: "2026-02-02T10:00:00Z" },
        { startTimeGMT: "2026-02-05T15:00:00Z" },
        { startTimeGMT: "2026-02-08T23:00:00Z" },
        // Last week activities (Jan 26 - Feb 1)
        { startTimeGMT: "2026-01-26T08:00:00Z" },
        { startTimeGMT: "2026-02-01T10:00:00Z" },
        // Next week activities
        { startTimeGMT: "2026-02-09T15:00:00Z" },
      ];

      const result = filterThisWeekActivities(activities);

      // Should only include Feb 2-8 (this week)
      expect(result.length).toBe(3);
      expect(result[0].startTimeGMT).toBe("2026-02-02T10:00:00Z");
      expect(result[1].startTimeGMT).toBe("2026-02-05T15:00:00Z");
      expect(result[2].startTimeGMT).toBe("2026-02-08T23:00:00Z");

      jest.useRealTimers();
    });

    it("should handle this week filtering on different days", () => {
      // Test on Wednesday
      jest.useFakeTimers().setSystemTime(new Date("2026-02-04T12:00:00Z")); // Wednesday
      const getThisWeekDates = (exporter as any).getThisWeekDates.bind(exporter);

      const { weekStart, weekEnd } = getThisWeekDates();

      // Should still be Mon Feb 2 - Sun Feb 8
      expect(weekStart.toISOString().split("T")[0]).toBe("2026-02-02");
      expect(weekEnd.toISOString().split("T")[0]).toBe("2026-02-08");

      jest.useRealTimers();
    });

    it("should handle Monday of the week", () => {
      // Test on Monday (start of week)
      jest.useFakeTimers().setSystemTime(new Date("2026-02-02T00:00:00Z")); // Monday
      const getThisWeekDates = (exporter as any).getThisWeekDates.bind(exporter);

      const { weekStart, weekEnd } = getThisWeekDates();

      // Should be Mon Feb 2 - Sun Feb 8
      expect(weekStart.toISOString().split("T")[0]).toBe("2026-02-02");
      expect(weekEnd.toISOString().split("T")[0]).toBe("2026-02-08");

      jest.useRealTimers();
    });

    it("should not conflict when both lastWeekOnly and thisWeekOnly are false", async () => {
      const outputPath = path.join(tempDir, "no-filter.json");

      await exporter.extract(5, outputPath, false, false, false, false);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);

      // Should include all 5 activities regardless of week
      expect(data.totalActivities).toBe(5);
      expect(data.activities.length).toBe(5);
    });
  });

  describe("Non-mock flows (mocked client)", () => {
    it("should authenticate successfully", async () => {
      const realClient = new GarminClient("real@example.com", "pass", false);
      const realExporter = new ActivityExporter(realClient);
      const result = await realClient.authenticate();
      const client = getMockClient();

      expect(result).toBe(true);
      expect(client.login).toHaveBeenCalledTimes(1);
      expect(client.getUserProfile).toHaveBeenCalledTimes(1);
    });

    it("should return false on authentication error", async () => {
      const realClient = new GarminClient("real@example.com", "pass", false);
      const client = getMockClient();
      client.login.mockRejectedValueOnce(new Error("fail"));

      const result = await realClient.authenticate();
      expect(result).toBe(false);
    });
  });
});
