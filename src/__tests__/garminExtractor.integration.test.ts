import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import ActivityExporter from "../activityExporter";
import WorkoutEditor from "../workoutEditor";
import { GarminClient } from "../shared/garminClient";

/**
 * Integration tests for end-to-end workflows
 */
describe("Activity & Workout Integration Tests", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "garmin-integration-"));
  });

  afterAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe("E2E Workflow: Extract and validate activities", () => {
    it("should successfully extract 10 activities and validate all fields", async () => {
      const garminClient = new GarminClient(
        "test@example.com",
        "password",
        true
      );
      const exporter = new ActivityExporter(garminClient);
      const outputPath = path.join(tempDir, "e2e-test-1.json");

      // Execute extraction
      const result = await exporter.extract(10, outputPath);
      expect(result).toBe(true);

      // Validate file was created
      expect(fs.existsSync(outputPath)).toBe(true);

      // Parse and validate structure
      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);

      // Validate root structure
      expect(data.extractedAt).toBeDefined();
      expect(data.totalActivities).toBe(10);
      expect(Array.isArray(data.activities)).toBe(true);

      // Validate each activity
      data.activities.forEach((activity: any, index: number) => {
        expect(activity.id).toBeDefined();
        expect(activity.activityName).toBeDefined();
        expect(activity.activityType).toMatch(/running|cycling|swimming|strength_training|other/);
        expect(activity.startTime).toBeDefined();
        expect(new Date(activity.startTime).getTime()).not.toBeNaN();
        expect(activity.duration).toBeGreaterThan(0);
        expect(activity.avgHR).toBeGreaterThan(0);
        expect(activity.maxHR).toBeGreaterThan(0);
      });
    });

    it("should extract activities at different limits and verify counts", async () => {
      const limits = [5, 15, 25];

      for (const limit of limits) {
        const garminClient = new GarminClient(
          "test@example.com",
          "password",
          true
        );
        const exporter = new ActivityExporter(garminClient);
        const outputPath = path.join(tempDir, `e2e-test-${limit}.json`);

        await exporter.extract(limit, outputPath);

        const fileContent = fs.readFileSync(outputPath, "utf-8");
        const data = JSON.parse(fileContent);

        expect(data.totalActivities).toBe(limit);
        expect(data.activities.length).toBe(limit);
      }
    });

    it("should handle multiple consecutive extractions", async () => {
      const garminClient = new GarminClient(
        "test@example.com",
        "password",
        true
      );
      const exporter = new ActivityExporter(garminClient);

      const results = [];

      for (let i = 0; i < 3; i++) {
        const outputPath = path.join(tempDir, `consecutive-${i}.json`);
        const result = await exporter.extract(5, outputPath);
        results.push(result);

        expect(fs.existsSync(outputPath)).toBe(true);
      }

      expect(results).toEqual([true, true, true]);
    });
  });

  describe("E2E Workflow: File system operations", () => {
    it("should create nested directories automatically", async () => {
      const garminClient = new GarminClient(
        "test@example.com",
        "password",
        true
      );
      const exporter = new ActivityExporter(garminClient);
      const nestedPath = path.join(tempDir, "a", "b", "c", "d", "activities.json");

      expect(fs.existsSync(path.dirname(nestedPath))).toBe(false);

      await exporter.extract(5, nestedPath);

      expect(fs.existsSync(nestedPath)).toBe(true);
      expect(fs.existsSync(path.dirname(nestedPath))).toBe(true);
    });
  });

  describe("E2E Workflow: Data integrity", () => {
    it("should maintain data integrity across extraction and parsing", async () => {
      const garminClient = new GarminClient(
        "test@example.com",
        "password",
        true
      );
      const exporter = new ActivityExporter(garminClient);
      const outputPath = path.join(tempDir, "integrity-test.json");

      const limit = 15;
      await exporter.extract(limit, outputPath);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);

      // Verify data consistency
      expect(data.activities.length).toBe(data.totalActivities);
      expect(data.activities.length).toBe(limit);

      // Verify all required fields exist and have proper types
      data.activities.forEach((activity: any) => {
        expect(typeof activity.id).toBe("string");
        expect(typeof activity.activityName).toBe("string");
        expect(typeof activity.activityType).toBe("string");
        expect(typeof activity.startTime).toBe("string");
        expect(typeof activity.duration).toBe("number");
      });
    });
  });
});
