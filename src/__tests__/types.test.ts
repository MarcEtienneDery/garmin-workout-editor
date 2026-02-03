import GarminActivity, { ExtractedActivities } from "../types";

describe("Types", () => {
  describe("GarminActivity", () => {
    it("should allow creating a valid running activity object", () => {
      const activity: GarminActivity = {
        id: "activity-1",
        activityName: "Morning Run",
        activityType: "running",
        startTime: "2026-01-01T08:00:00Z",
        duration: 3600,
        distance: 5.5,
      };

      expect(activity.id).toBe("activity-1");
      expect(activity.activityName).toBe("Morning Run");
      expect(activity.activityType).toBe("running");
    });

    it("should allow optional fields for running", () => {
      const activity: GarminActivity = {
        id: "activity-1",
        activityName: "Run",
        activityType: "running",
        startTime: "2026-01-01T08:00:00Z",
        duration: 3600,
        distance: 5.5,
        avgHR: 150,
        maxHR: 180,
        elevationGain: 100,
        aerobicTrainingEffect: 3.5,
        selfEvaluationFeeling: 4,
      };

      expect(activity.avgHR).toBe(150);
      expect(activity.elevationGain).toBe(100);
      expect(activity.aerobicTrainingEffect).toBe(3.5);
    });

    it("should allow creating a valid strength training activity", () => {
      const activity: GarminActivity = {
        id: "activity-2",
        activityName: "Strength Session",
        activityType: "strength_training",
        startTime: "2026-01-01T08:00:00Z",
        duration: 2700,
        totalSets: 15,
        totalReps: 120,
        exerciseSets: [
          { exerciseName: "Bench Press", category: "CHEST", reps: 10, sets: 3, weight: 185, volume: 5550 },
          { exerciseName: "Barbell Squat", category: "LEGS", reps: 8, sets: 4, weight: 225, volume: 7200 },
        ],
      };

      expect(activity.totalSets).toBe(15);
      expect(activity.exerciseSets?.length).toBe(2);
      expect(activity.exerciseSets?.[0].exerciseName).toBe("Bench Press");
    });
  });

  describe("ExtractedActivities", () => {
    it("should have correct structure with week dates", () => {
      const extracted: ExtractedActivities = {
        extractedAt: "2026-01-01T12:00:00Z",
        weekStart: "2025-12-23",
        weekEnd: "2025-12-29",
        totalActivities: 5,
        activities: [
          {
            id: "activity-1",
            activityName: "Run",
            activityType: "running",
            startTime: "2026-01-01T08:00:00Z",
            duration: 3600,
            distance: 5.5,
          },
        ],
      };

      expect(extracted.extractedAt).toBe("2026-01-01T12:00:00Z");
      expect(extracted.weekStart).toBe("2025-12-23");
      expect(extracted.weekEnd).toBe("2025-12-29");
      expect(extracted.totalActivities).toBe(5);
      expect(extracted.activities.length).toBe(1);
    });

    it("should support multiple activity types", () => {
      const extracted: ExtractedActivities = {
        extractedAt: "2026-01-01T12:00:00Z",
        weekStart: "2025-12-23",
        weekEnd: "2025-12-29",
        totalActivities: 3,
        activities: [
          {
            id: "activity-1",
            activityName: "Run",
            activityType: "running",
            startTime: "2026-01-01T08:00:00Z",
            duration: 3600,
            distance: 5.5,
            aerobicTrainingEffect: 3.2,
          },
          {
            id: "activity-2",
            activityName: "Cycle",
            activityType: "cycling",
            startTime: "2026-01-02T09:00:00Z",
            duration: 5400,
            distance: 20,
          },
          {
            id: "activity-3",
            activityName: "Strength",
            activityType: "strength_training",
            startTime: "2026-01-03T07:00:00Z",
            duration: 2400,
            totalSets: 12,
            totalReps: 100,
          },
        ],
      };

      expect(extracted.activities.length).toBe(3);
      expect(extracted.totalActivities).toBe(3);
    });
  });
});
