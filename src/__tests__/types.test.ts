import GarminActivity, { ExtractedActivities } from "../types";

describe("Types", () => {
  describe("GarminActivity", () => {
    it("should allow creating a valid activity object", () => {
      const activity: GarminActivity = {
        id: "activity-1",
        activityName: "Morning Run",
        activityType: "running",
        startTime: "2026-01-01T08:00:00Z",
        duration: 3600,
        distance: 5.5,
        calories: 600,
      };

      expect(activity.id).toBe("activity-1");
      expect(activity.activityName).toBe("Morning Run");
      expect(activity.activityType).toBe("running");
    });

    it("should allow optional fields", () => {
      const activity: GarminActivity = {
        id: "activity-1",
        activityName: "Run",
        activityType: "running",
        startTime: "2026-01-01T08:00:00Z",
        duration: 3600,
        distance: 5.5,
        calories: 600,
        avgHR: 150,
        maxHR: 180,
        elevation: 100,
      };

      expect(activity.avgHR).toBe(150);
      expect(activity.elevation).toBe(100);
    });

    it("should allow additional fields", () => {
      const activity: GarminActivity = {
        id: "activity-1",
        activityName: "Run",
        activityType: "running",
        startTime: "2026-01-01T08:00:00Z",
        duration: 3600,
        distance: 5.5,
        calories: 600,
        customField: "custom-value",
      };

      expect((activity as any).customField).toBe("custom-value");
    });
  });

  describe("ExtractedActivities", () => {
    it("should have correct structure", () => {
      const extracted: ExtractedActivities = {
        extractedAt: "2026-01-01T12:00:00Z",
        totalActivities: 5,
        activities: [
          {
            id: "activity-1",
            activityName: "Run",
            activityType: "running",
            startTime: "2026-01-01T08:00:00Z",
            duration: 3600,
            distance: 5.5,
            calories: 600,
          },
        ],
      };

      expect(extracted.extractedAt).toBe("2026-01-01T12:00:00Z");
      expect(extracted.totalActivities).toBe(5);
      expect(extracted.activities.length).toBe(1);
    });

    it("should support multiple activities", () => {
      const extracted: ExtractedActivities = {
        extractedAt: "2026-01-01T12:00:00Z",
        totalActivities: 3,
        activities: [
          {
            id: "activity-1",
            activityName: "Run",
            activityType: "running",
            startTime: "2026-01-01T08:00:00Z",
            duration: 3600,
            distance: 5.5,
            calories: 600,
          },
          {
            id: "activity-2",
            activityName: "Cycle",
            activityType: "cycling",
            startTime: "2026-01-02T09:00:00Z",
            duration: 5400,
            distance: 20,
            calories: 800,
          },
          {
            id: "activity-3",
            activityName: "Swim",
            activityType: "swimming",
            startTime: "2026-01-03T07:00:00Z",
            duration: 2400,
            distance: 1.5,
            calories: 400,
          },
        ],
      };

      expect(extracted.activities.length).toBe(3);
      expect(extracted.totalActivities).toBe(3);
    });
  });
});
