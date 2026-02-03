import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import GarminExtractor from "../garminExtractor";

/**
 * Integration tests for end-to-end workflows
 */
describe("GarminExtractor Integration Tests", () => {
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
      const extractor = new GarminExtractor(
        "test@example.com",
        "password",
        true
      );
      const outputPath = path.join(tempDir, "e2e-test-1.json");

      // Execute extraction
      const result = await extractor.extract(10, outputPath);
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
        const extractor = new GarminExtractor(
          "test@example.com",
          "password",
          true
        );
        const outputPath = path.join(tempDir, `e2e-test-${limit}.json`);

        await extractor.extract(limit, outputPath);

        const fileContent = fs.readFileSync(outputPath, "utf-8");
        const data = JSON.parse(fileContent);

        expect(data.totalActivities).toBe(limit);
        expect(data.activities.length).toBe(limit);
      }
    });

    it("should handle multiple consecutive extractions", async () => {
      const extractor = new GarminExtractor(
        "test@example.com",
        "password",
        true
      );

      const results = [];

      for (let i = 0; i < 3; i++) {
        const outputPath = path.join(tempDir, `consecutive-${i}.json`);
        const result = await extractor.extract(5, outputPath);
        results.push(result);

        expect(fs.existsSync(outputPath)).toBe(true);
      }

      expect(results).toEqual([true, true, true]);
    });

    it("should generate different mock data on each call", async () => {
      const extractor = new GarminExtractor(
        "test@example.com",
        "password",
        true
      );

      const path1 = path.join(tempDir, "diff-1.json");
      const path2 = path.join(tempDir, "diff-2.json");

      await extractor.extract(5, path1);
      
      // Wait to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      await extractor.extract(5, path2);

      const data1 = JSON.parse(fs.readFileSync(path1, "utf-8"));
      const data2 = JSON.parse(fs.readFileSync(path2, "utf-8"));

      // At least some activities should have different data (distance, duration, etc.)
      let hasChanged = false;
      for (let i = 0; i < 5; i++) {
        if (
          data1.activities[i].distance !== data2.activities[i].distance ||
          data1.activities[i].duration !== data2.activities[i].duration ||
          data1.activities[i].calories !== data2.activities[i].calories
        ) {
          hasChanged = true;
          break;
        }
      }
      expect(hasChanged).toBe(true);
    });

    it("should produce parseable JSON that can be loaded multiple times", async () => {
      const extractor = new GarminExtractor(
        "test@example.com",
        "password",
        true
      );
      const outputPath = path.join(tempDir, "parse-test.json");

      await extractor.extract(10, outputPath);

      // Load multiple times to ensure consistency
      const loads = [];
      for (let i = 0; i < 3; i++) {
        const fileContent = fs.readFileSync(outputPath, "utf-8");
        loads.push(JSON.parse(fileContent));
      }

      // All loads should be identical
      expect(loads[0]).toEqual(loads[1]);
      expect(loads[1]).toEqual(loads[2]);
    });
  });

  describe("E2E Workflow: File system operations", () => {
    it("should create nested directories automatically", async () => {
      const extractor = new GarminExtractor(
        "test@example.com",
        "password",
        true
      );
      const nestedPath = path.join(tempDir, "a", "b", "c", "d", "activities.json");

      expect(fs.existsSync(path.dirname(nestedPath))).toBe(false);

      await extractor.extract(5, nestedPath);

      expect(fs.existsSync(nestedPath)).toBe(true);
      expect(fs.existsSync(path.dirname(nestedPath))).toBe(true);
    });

    it("should overwrite existing files", async () => {
      const extractor = new GarminExtractor(
        "test@example.com",
        "password",
        true
      );
      const outputPath = path.join(tempDir, "overwrite-test.json");

      // First extraction
      await extractor.extract(5, outputPath);
      const data1 = JSON.parse(fs.readFileSync(outputPath, "utf-8"));

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second extraction with different data
      const extractor2 = new GarminExtractor(
        "test@example.com",
        "password",
        true
      );
      await extractor2.extract(10, outputPath);
      const data2 = JSON.parse(fs.readFileSync(outputPath, "utf-8"));

      // Should have different counts
      expect(data1.totalActivities).toBe(5);
      expect(data2.totalActivities).toBe(10);
      // Timestamps should be different (or at least the file was overwritten)
      expect(data2.extractedAt).toBeDefined();
    });

    it("should handle special characters in file paths", async () => {
      const extractor = new GarminExtractor(
        "test@example.com",
        "password",
        true
      );
      const outputPath = path.join(tempDir, "test-2026-02-03", "activities.json");

      await extractor.extract(5, outputPath);

      expect(fs.existsSync(outputPath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
      expect(data.totalActivities).toBe(5);
    });
  });

  describe("E2E Workflow: Data integrity", () => {
    it("should maintain data integrity across extraction and parsing", async () => {
      const extractor = new GarminExtractor(
        "test@example.com",
        "password",
        true
      );
      const outputPath = path.join(tempDir, "integrity-test.json");

      const limit = 15;
      await extractor.extract(limit, outputPath);

      const fileContent = fs.readFileSync(outputPath, "utf-8");
      const data = JSON.parse(fileContent);

      // Verify data consistency
      expect(data.activities.length).toBe(data.totalActivities);
      expect(data.activities.length).toBe(limit);

      // Verify all activities have proper ID format
      data.activities.forEach((activity: any, index: number) => {
        expect(activity.id).toMatch(/^activity-\d+$/);
      });

      // Verify all required fields exist and have proper types
      data.activities.forEach((activity: any) => {
        expect(typeof activity.id).toBe("string");
        expect(typeof activity.activityName).toBe("string");
        expect(typeof activity.activityType).toBe("string");
        expect(typeof activity.startTime).toBe("string");
        expect(typeof activity.duration).toBe("number");
      });
    });

    it("should preserve data format across multiple saves", async () => {
      const outputPath1 = path.join(tempDir, "save1.json");
      const outputPath2 = path.join(tempDir, "save2.json");

      const extractor1 = new GarminExtractor(
        "test@example.com",
        "password",
        true
      );
      await extractor1.extract(8, outputPath1);

      const extractor2 = new GarminExtractor(
        "test@example.com",
        "password",
        true
      );
      await extractor2.extract(8, outputPath2);

      const data1 = JSON.parse(fs.readFileSync(outputPath1, "utf-8"));
      const data2 = JSON.parse(fs.readFileSync(outputPath2, "utf-8"));

      // Both should have the same structure
      expect(Object.keys(data1).sort()).toEqual(Object.keys(data2).sort());
      expect(data1.activities[0]).toHaveProperty("id");
      expect(data2.activities[0]).toHaveProperty("id");

      // Both should have same fields on activities
      const fields1 = Object.keys(data1.activities[0]).sort();
      const fields2 = Object.keys(data2.activities[0]).sort();
      expect(fields1).toEqual(fields2);
    });
  });
});
