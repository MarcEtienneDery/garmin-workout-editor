jest.mock("@flow-js/garmin-connect", () => ({
  GarminConnect: jest.fn().mockImplementation(() => ({
    login: jest.fn().mockResolvedValue(true),
    getUserProfile: jest.fn().mockResolvedValue({ userName: "tester" }),
    getActivities: jest.fn().mockResolvedValue([]),
    getActivity: jest.fn().mockResolvedValue({}),
  })),
}));

import GarminExtractor from "../garminExtractor";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getMockClient, normalizeActivityType } from "../mocks.setup";

describe("GarminExtractor", () => {
  let tempDir: string;
  let extractor: GarminExtractor;

  beforeEach(() => {
    // Create a temporary directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "garmin-test-"));
    extractor = new GarminExtractor("test@example.com", "password123", true); // mock mode
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

      const result = await extractor.extract(limit, outputPath);

      expect(result).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
    });

    it("should create activities.json with correct structure", async () => {
      const limit = 5;
      const outputPath = path.join(tempDir, "activities.json");

      await extractor.extract(limit, outputPath);

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

      await extractor.extract(1, outputPath);

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

      await extractor.extract(1, outputPath);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);
      const activity = data.activities[0];

      expect(activity).toHaveProperty("avgHR");
      expect(activity).toHaveProperty("maxHR");
    });

    it("should generate valid ISO date strings", async () => {
      const outputPath = path.join(tempDir, "activities.json");

      await extractor.extract(5, outputPath);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);

      data.activities.forEach((activity: any) => {
        expect(() => new Date(activity.startTime)).not.toThrow();
        expect(new Date(activity.startTime).toISOString()).toBe(
          activity.startTime
        );
      });
    });

    it("should extract activities with valid numeric values", async () => {
      const outputPath = path.join(tempDir, "activities.json");

      await extractor.extract(5, outputPath);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);

      data.activities.forEach((activity: any) => {
        expect(typeof activity.duration).toBe("number");
        expect(activity.duration).toBeGreaterThan(0);
        
        // Running/cycling activities should have distance and pace
        if (activity.activityType === 'running' || activity.activityType === 'cycling') {
          expect(typeof activity.distance).toBe("number");
          expect(activity.distance).toBeGreaterThanOrEqual(0);
        }
      });
    });

    it("should support different limits", async () => {
      const testCases = [1, 5, 10, 20, 50];

      for (const limit of testCases) {
        const outputPath = path.join(tempDir, `activities-${limit}.json`);
        await extractor.extract(limit, outputPath);

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

      await extractor.extract(5, customPath);

      expect(fs.existsSync(customPath)).toBe(true);
    });

    it("should include extractedAt timestamp", async () => {
      const outputPath = path.join(tempDir, "activities.json");

      const beforeTime = new Date();
      await extractor.extract(1, outputPath);
      const afterTime = new Date();

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);
      const extractedAt = new Date(data.extractedAt);

      expect(extractedAt.getTime()).toBeGreaterThanOrEqual(
        beforeTime.getTime()
      );
      expect(extractedAt.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });

    it("should generate diverse activity types", async () => {
      const outputPath = path.join(tempDir, "activities.json");

      await extractor.extract(20, outputPath);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);

      const activityTypes = new Set(
        data.activities.map((a: any) => a.activityType)
      );

      // With 20 activities and 4 types (running, cycling, swimming, strength),
      // we should have multiple types
      expect(activityTypes.size).toBeGreaterThan(1);
    });
  });

  describe("File Operations", () => {
    it("should create directory if it does not exist", async () => {
      const nestedPath = path.join(tempDir, "new", "nested", "dir");
      const outputPath = path.join(nestedPath, "activities.json");

      expect(fs.existsSync(nestedPath)).toBe(false);

      await extractor.extract(1, outputPath);

      expect(fs.existsSync(outputPath)).toBe(true);
    });

    it("should write valid JSON", async () => {
      const outputPath = path.join(tempDir, "activities.json");

      await extractor.extract(5, outputPath);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      expect(() => JSON.parse(fileContent)).not.toThrow();
    });

    it("should format JSON with proper indentation", async () => {
      const outputPath = path.join(tempDir, "activities.json");

      await extractor.extract(1, outputPath);

      const fileContent = fs.readFileSync(outputPath, "utf-8");

      // Check that JSON is pretty-printed (has newlines and indentation)
      expect(fileContent).toContain("\n");
      expect(fileContent).toContain("  ");
    });
  });

  describe("Helper Methods", () => {
    it("should normalize activity types", () => {
      expect(normalizeActivityType("trail running")).toBe("running");
      expect(normalizeActivityType("strength_training")).toBe("strength_training");
      expect(normalizeActivityType("cycling")).toBe("cycling");
      expect(normalizeActivityType("swim")).toBe("swimming");
      expect(normalizeActivityType("unknown"))
        .toBe("other");
    });

    it("should convert speed to pace", () => {
      const speedToPace = (extractor as any).speedToPace.bind(extractor);
      expect(speedToPace(undefined)).toBeUndefined();
      expect(speedToPace(0)).toBeUndefined();
      const pace = speedToPace(3); // 3 m/s
      expect(pace).toBeCloseTo(1000 / 3 / 60, 6);
    });

    it("should format exercise names", () => {
      const format = (extractor as any).formatExerciseName.bind(extractor);
      expect(format("BARBELL_BENCH_PRESS")).toBe("Barbell Bench Press");
      expect(format(undefined)).toBe("Unknown Exercise");
    });

    it("should convert Garmin weight to lbs", () => {
      const convert = (extractor as any).convertGarminWeight.bind(extractor);
      expect(convert(0)).toBe(0);
      expect(convert(453.6)).toBe(1);
      expect(convert(9072)).toBe(20);
    });

    it("should split warmup and working sets for main lifts", () => {
      const split = (extractor as any).splitWarmupAndWorkingSets.bind(extractor);
      const result = split(
        {
          category: "BENCH_PRESS",
          subCategory: "BARBELL_BENCH_PRESS",
          sets: 4,
          reps: 20,
          maxWeight: 90720,
          volume: 2000,
        },
        "BARBELL_BENCH_PRESS"
      );

      expect(result.warmup.length).toBe(1);
      expect(result.working.sets).toBe(3);
      expect(result.working.reps).toBe(5);
      expect(result.warmup[0].reps).toBe(4);
      expect(result.warmup[0].weight).toBeGreaterThan(0);
    });

    it("should not split for non-main lifts or low set counts", () => {
      const split = (extractor as any).splitWarmupAndWorkingSets.bind(extractor);
      const result = split(
        {
          category: "LUNGE",
          subCategory: "DUMBBELL_LUNGE",
          sets: 2,
          reps: 20,
          maxWeight: 45360,
          volume: 1000,
        },
        "DUMBBELL_LUNGE"
      );

      expect(result.warmup.length).toBe(0);
      expect(result.working.sets).toBe(2);
      expect(result.working.reps).toBe(20);
    });

    it("should filter last week activities", () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-02-03T12:00:00Z"));
      const getLastWeekDates = (extractor as any).getLastWeekDates.bind(extractor);
      const filterLastWeekActivities = (extractor as any).filterLastWeekActivities.bind(extractor);
      const { weekStart, weekEnd } = getLastWeekDates();

      const inside = { startTimeGMT: new Date(weekStart).toISOString() };
      const inside2 = { startTimeGMT: new Date(weekEnd).toISOString() };
      const outside = { startTimeGMT: new Date(weekStart.getTime() - 86400000).toISOString() };

      const result = filterLastWeekActivities([inside, outside, inside2]);
      expect(result.length).toBe(2);
      jest.useRealTimers();
    });

    it("should save full raw activities when enabled", async () => {
      const outputPath = path.join(tempDir, "activities.json");
      const activities = [
        {
          activityId: 1,
          activityName: "Run",
          activityType: { typeKey: "running" },
          startTimeGMT: new Date().toISOString(),
          duration: 1200,
          averageHR: 140,
          maxHR: 170,
          distance: 5000,
          averageSpeed: 3,
        },
        {
          activityId: 2,
          activityName: "Yoga",
          activityType: { typeKey: "yoga" },
          startTimeGMT: new Date().toISOString(),
          duration: 1800,
          averageHR: 90,
          maxHR: 110,
        },
      ];

      await extractor.saveActivitiesToFile(activities, outputPath, true, false);
      const rawPath = outputPath.replace(".json", "-raw.json");

      expect(fs.existsSync(rawPath)).toBe(true);
      const raw = JSON.parse(fs.readFileSync(rawPath, "utf-8"));
      expect(Array.isArray(raw)).toBe(true);
      expect(raw.length).toBe(2);
    });
  });

  describe("Non-mock flows (mocked client)", () => {
    it("should authenticate successfully", async () => {
      const realExtractor = new GarminExtractor("real@example.com", "pass", false);
      const result = await realExtractor.authenticate();
      const client = getMockClient();

      expect(result).toBe(true);
      expect(client.login).toHaveBeenCalledTimes(1);
      expect(client.getUserProfile).toHaveBeenCalledTimes(1);
    });

    it("should return false on authentication error", async () => {
      const realExtractor = new GarminExtractor("real@example.com", "pass", false);
      const client = getMockClient();
      client.login.mockRejectedValueOnce(new Error("fail"));

      const result = await realExtractor.authenticate();
      expect(result).toBe(false);
    });

    it("should fetch activities without details", async () => {
      const realExtractor = new GarminExtractor("real@example.com", "pass", false);
      const client = getMockClient();
      client.getActivities.mockResolvedValueOnce([
        { activityId: 1, activityName: "Run", activityType: { typeKey: "running" } },
      ]);

      const activities = await realExtractor.fetchActivities(1, false);
      expect(activities.length).toBe(1);
      expect(client.getActivities).toHaveBeenCalledWith(0, 1);
      expect(client.getActivity).not.toHaveBeenCalled();
    });

    it("should fetch activities with details and merge", async () => {
      const realExtractor = new GarminExtractor("real@example.com", "pass", false);
      const client = getMockClient();
      client.getActivities.mockResolvedValueOnce([
        { activityId: 1, activityName: "Run", activityType: { typeKey: "running" } },
        { activityId: 2, activityName: "Strength", activityType: { typeKey: "strength_training" } },
      ]);
      client.getActivity.mockResolvedValueOnce({ averageHR: 150 }).mockResolvedValueOnce({ averageHR: 120 });

      const activities = await realExtractor.fetchActivities(2, true);

      expect(activities[0].averageHR).toBe(150);
      expect(activities[1].averageHR).toBe(120);
      expect(client.getActivity).toHaveBeenCalledTimes(2);
    });

    it("should keep basic data when detail fetch fails", async () => {
      const realExtractor = new GarminExtractor("real@example.com", "pass", false);
      const client = getMockClient();
      client.getActivities.mockResolvedValueOnce([
        { activityId: 1, activityName: "Run", activityType: { typeKey: "running" } },
      ]);
      client.getActivity.mockRejectedValueOnce(new Error("detail fail"));

      const activities = await realExtractor.fetchActivities(1, true);
      expect(activities[0].activityName).toBe("Run");
    });

    it("should transform running and strength activities", () => {
      const realExtractor = new GarminExtractor("real@example.com", "pass", false);
      const transform = (realExtractor as any).transformActivities.bind(realExtractor);

      const result = transform([
        {
          activityId: 10,
          activityName: "Run",
          activityType: { typeKey: "running" },
          startTimeGMT: "2026-02-01T10:00:00Z",
          duration: 1800,
          averageHR: 140,
          maxHR: 170,
          distance: 5000,
          averageSpeed: 2.5,
          averageRunningCadenceInStepsPerMinute: 175,
          elevationGain: 20,
        },
        {
          activityId: 11,
          activityName: "Strength",
          activityType: { typeKey: "strength_training" },
          startTimeGMT: "2026-02-01T12:00:00Z",
          duration: 2400,
          averageHR: 120,
          maxHR: 150,
          totalSets: 4,
          totalReps: 20,
          summarizedExerciseSets: [
            {
              category: "BENCH_PRESS",
              subCategory: "BARBELL_BENCH_PRESS",
              sets: 4,
              reps: 20,
              maxWeight: 90720,
              volume: 2000,
            },
          ],
        },
      ]);

      expect(result[0].distance).toBeCloseTo(5);
      expect(result[0].avgPace).toBeDefined();
      expect(result[1].exerciseSets.length).toBeGreaterThan(1);
    });

    it("should extract in real mode and write output", async () => {
      const realExtractor = new GarminExtractor("real@example.com", "pass", false);
      const client = getMockClient();
      client.getActivities.mockResolvedValueOnce([
        { activityId: 1, activityName: "Run", activityType: { typeKey: "running" }, startTimeGMT: new Date().toISOString(), duration: 1200, averageHR: 140, maxHR: 170, distance: 5000, averageSpeed: 3 },
      ]);

      const outputPath = path.join(tempDir, "real-activities.json");
      const result = await realExtractor.extract(1, outputPath, false, false, false);

      expect(result).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(true);
    });
  });
});
