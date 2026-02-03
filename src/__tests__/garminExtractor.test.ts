import GarminExtractor from "../garminExtractor";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

      expect(activity).toHaveProperty("id");
      expect(activity).toHaveProperty("activityName");
      expect(activity).toHaveProperty("activityType");
      expect(activity).toHaveProperty("startTime");
      expect(activity).toHaveProperty("duration");
      expect(activity).toHaveProperty("distance");
      expect(activity).toHaveProperty("calories");
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
        expect(typeof activity.distance).toBe("number");
        expect(typeof activity.calories).toBe("number");
        expect(activity.duration).toBeGreaterThan(0);
        expect(activity.distance).toBeGreaterThanOrEqual(0);
        expect(activity.calories).toBeGreaterThan(0);
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
});
