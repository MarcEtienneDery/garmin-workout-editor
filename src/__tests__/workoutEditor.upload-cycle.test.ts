
const USE_REAL_API = process.env.USE_REAL_GARMIN_API === "true";

if (!USE_REAL_API) {
  jest.mock("@flow-js/garmin-connect", () => ({
    GarminConnect: jest.fn().mockImplementation(function() {
      return {
        login: jest.fn().mockResolvedValue(true),
        getUserProfile: jest.fn().mockResolvedValue({ userName: "tester" }),
        getWorkouts: jest.fn().mockResolvedValue([]),
        getWorkoutDetail: jest.fn().mockResolvedValue(null),
        createWorkout: jest.fn().mockImplementation(async (workout: any) => {
          return {
            ...workout,
            workoutId: Math.floor(Math.random() * 1000000) + 10000,
          };
        }),
        deleteWorkout: jest.fn().mockResolvedValue({}),
      };
    }),
  }));
}

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import WorkoutEditor from "../workoutEditor";
import { GarminClient } from "../shared/garminClient";
import { DetailedWorkout, WorkoutStep } from "../shared/types";
import { getMockClient, resetMockClient } from "../mocks.setup";

describe("Workout Upload Cycle Integration Tests", () => {
  let tempDir: string;
  let editor: WorkoutEditor;
  let garminClient: GarminClient;
  const createdWorkoutIds: number[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "garmin-upload-cycle-"));
    
    if (USE_REAL_API) {
      const email = process.env.GARMIN_EMAIL;
      const password = process.env.GARMIN_PASSWORD;
      
      if (!email || !password) {
        throw new Error(
          "Real API mode requires GARMIN_EMAIL and GARMIN_PASSWORD environment variables"
        );
      }
      
      console.log(`\n🌐 Running tests with REAL Garmin API (${email})`);
      garminClient = new GarminClient(email, password, false);
    } else {
      resetMockClient();
      garminClient = new GarminClient("test@example.com", "password123", true);
    }
    
    editor = new WorkoutEditor(garminClient);
  });

  afterEach(async () => {
    if (USE_REAL_API && createdWorkoutIds.length > 0) {
      console.log(`\n🧹 Cleaning up ${createdWorkoutIds.length} created workout(s)...`);
      const client = (garminClient as any).client;
      
      for (const workoutId of createdWorkoutIds) {
        try {
          await client.deleteWorkout(workoutId);
          console.log(`   ✓ Deleted workout ${workoutId}`);
        } catch (error: any) {
          console.warn(`   ⚠ Failed to delete workout ${workoutId}: ${error.message}`);
        }
      }
      
      createdWorkoutIds.length = 0;
    }
    
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  const getSampleRawWorkout = (): any => {
    return {
      workoutId: 1491352606,
      ownerId: 131933574,
      workoutName: "Copy of Squat day",
      description: null,
      updatedDate: "2026-03-02T13:20:31.0",
      createdDate: "2026-03-02T13:20:13.0",
      sportType: { sportTypeId: 5, sportTypeKey: "strength_training", displayOrder: 5 },
      subSportType: "GENERIC",
      trainingPlanId: null,
      author: {
        userProfilePk: 131933574,
        displayName: "7d70a6c1-1770-4392-a199-c82b5332f542",
        fullName: "Marc-Etienne Dery",
        profileImgNameLarge: null,
        profileImgNameMedium: "6f3cd91f-8832-462c-92bb-c5fb0b7c3129-prfr.png",
        profileImgNameSmall: "6f3cd91f-8832-462c-92bb-c5fb0b7c3129-prth.png",
        userPro: false,
        vivokidUser: false,
      },
      sharedWithUsers: null,
      estimatedDurationInSecs: 0,
      estimatedDistanceInMeters: 0.0,
      workoutSegments: [
        {
          segmentOrder: 1,
          sportType: { sportTypeId: 5, sportTypeKey: "strength_training", displayOrder: 5 },
          poolLengthUnit: null,
          poolLength: null,
          avgTrainingSpeed: null,
          estimatedDurationInSecs: null,
          estimatedDistanceInMeters: null,
          estimatedDistanceUnit: null,
          estimateType: null,
          description: null,
          workoutSteps: [
            {
              type: "ExecutableStepDTO",
              stepId: 12610146152,
              stepOrder: 1,
              stepType: { stepTypeId: 1, stepTypeKey: "warmup", displayOrder: 1 },
              childStepId: null,
              description: null,
              endCondition: { conditionTypeId: 1, conditionTypeKey: "lap.button", displayOrder: 1, displayable: true },
              endConditionValue: 300.0,
              preferredEndConditionUnit: null,
              endConditionCompare: null,
              targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
              targetValueOne: null,
              targetValueTwo: null,
              targetValueUnit: null,
              zoneNumber: null,
              secondaryTargetType: null,
              secondaryTargetValueOne: null,
              secondaryTargetValueTwo: null,
              secondaryTargetValueUnit: null,
              secondaryZoneNumber: null,
              endConditionZone: null,
              strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
              equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
              category: "CARDIO",
              exerciseName: "",
              workoutProvider: null,
              providerExerciseSourceId: null,
              weightValue: 0.0,
              weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
            },
            {
              type: "ExecutableStepDTO",
              stepId: 12610146153,
              stepOrder: 2,
              stepType: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
              childStepId: null,
              description: null,
              endCondition: { conditionTypeId: 10, conditionTypeKey: "reps", displayOrder: 10, displayable: true },
              endConditionValue: 10.0,
              preferredEndConditionUnit: null,
              endConditionCompare: null,
              targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
              targetValueOne: null,
              targetValueTwo: null,
              targetValueUnit: null,
              zoneNumber: null,
              secondaryTargetType: null,
              secondaryTargetValueOne: null,
              secondaryTargetValueTwo: null,
              secondaryTargetValueUnit: null,
              secondaryZoneNumber: null,
              endConditionZone: null,
              strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
              equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
              category: "SQUAT",
              exerciseName: "BARBELL_BACK_SQUAT",
              workoutProvider: null,
              providerExerciseSourceId: null,
              weightValue: null,
              weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
              benchmarkPercentage: 50,
              benchmarkKey: "BARBELL_BACK_SQUAT",
            },
            {
              type: "ExecutableStepDTO",
              stepId: 12610146154,
              stepOrder: 3,
              stepType: { stepTypeId: 5, stepTypeKey: "rest", displayOrder: 5 },
              childStepId: null,
              description: null,
              endCondition: { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true },
              endConditionValue: 60.0,
              preferredEndConditionUnit: null,
              endConditionCompare: null,
              targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
              targetValueOne: null,
              targetValueTwo: null,
              targetValueUnit: null,
              zoneNumber: null,
              secondaryTargetType: null,
              secondaryTargetValueOne: null,
              secondaryTargetValueTwo: null,
              secondaryTargetValueUnit: null,
              secondaryZoneNumber: null,
              endConditionZone: null,
              strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
              equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
              category: null,
              exerciseName: null,
              workoutProvider: null,
              providerExerciseSourceId: null,
              weightValue: null,
              weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
            },
            {
              type: "RepeatGroupDTO",
              stepId: 12610146155,
              stepOrder: 4,
              stepType: { stepTypeId: 6, stepTypeKey: "repeat", displayOrder: 6 },
              childStepId: 1,
              numberOfIterations: 4,
              workoutSteps: [
                {
                  type: "ExecutableStepDTO",
                  stepId: 12610146156,
                  stepOrder: 5,
                  stepType: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
                  childStepId: 1,
                  description: null,
                  endCondition: { conditionTypeId: 10, conditionTypeKey: "reps", displayOrder: 10, displayable: true },
                  endConditionValue: 5.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
                  targetValueOne: null,
                  targetValueTwo: null,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: "SQUAT",
                  exerciseName: "BARBELL_BACK_SQUAT",
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: null,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                  benchmarkPercentage: 80,
                  benchmarkKey: "BARBELL_BACK_SQUAT",
                },
                {
                  type: "ExecutableStepDTO",
                  stepId: 12610146157,
                  stepOrder: 6,
                  stepType: { stepTypeId: 5, stepTypeKey: "rest", displayOrder: 5 },
                  childStepId: 1,
                  description: null,
                  endCondition: { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true },
                  endConditionValue: 180.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
                  targetValueOne: null,
                  targetValueTwo: null,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: null,
                  exerciseName: null,
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: null,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
              ],
              endConditionValue: 4.0,
              preferredEndConditionUnit: null,
              endConditionCompare: null,
              endCondition: { conditionTypeId: 7, conditionTypeKey: "iterations", displayOrder: 7, displayable: false },
              skipLastRestStep: false,
              smartRepeat: false,
            },
            {
              type: "RepeatGroupDTO",
              stepId: 12610146158,
              stepOrder: 7,
              stepType: { stepTypeId: 6, stepTypeKey: "repeat", displayOrder: 6 },
              childStepId: 2,
              numberOfIterations: 3,
              workoutSteps: [
                {
                  type: "ExecutableStepDTO",
                  stepId: 12610146159,
                  stepOrder: 8,
                  stepType: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
                  childStepId: 2,
                  description: "",
                  endCondition: { conditionTypeId: 10, conditionTypeKey: "reps", displayOrder: 10, displayable: true },
                  endConditionValue: 10.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
                  targetValueOne: null,
                  targetValueTwo: null,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: "PULL_UP",
                  exerciseName: "WEIGHTED_PULL_UP",
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: 14.99804769643722,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
                {
                  type: "ExecutableStepDTO",
                  stepId: 12610146160,
                  stepOrder: 9,
                  stepType: { stepTypeId: 5, stepTypeKey: "rest", displayOrder: 5 },
                  childStepId: 2,
                  description: null,
                  endCondition: { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true },
                  endConditionValue: 60.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
                  targetValueOne: null,
                  targetValueTwo: null,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: null,
                  exerciseName: null,
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: null,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
              ],
              endConditionValue: 3.0,
              preferredEndConditionUnit: null,
              endConditionCompare: null,
              endCondition: { conditionTypeId: 7, conditionTypeKey: "iterations", displayOrder: 7, displayable: false },
              skipLastRestStep: false,
              smartRepeat: false,
            },
            {
              type: "RepeatGroupDTO",
              stepId: 12610146161,
              stepOrder: 10,
              stepType: { stepTypeId: 6, stepTypeKey: "repeat", displayOrder: 6 },
              childStepId: 3,
              numberOfIterations: 3,
              workoutSteps: [
                {
                  type: "ExecutableStepDTO",
                  stepId: 12610146162,
                  stepOrder: 11,
                  stepType: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
                  childStepId: 3,
                  description: null,
                  endCondition: { conditionTypeId: 10, conditionTypeKey: "reps", displayOrder: 10, displayable: true },
                  endConditionValue: 10.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
                  targetValueOne: null,
                  targetValueTwo: null,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: "BENCH_PRESS",
                  exerciseName: "INCLINE_DUMBBELL_BENCH_PRESS",
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: 149.998113945347,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
                {
                  type: "ExecutableStepDTO",
                  stepId: 12610146163,
                  stepOrder: 12,
                  stepType: { stepTypeId: 5, stepTypeKey: "rest", displayOrder: 5 },
                  childStepId: 3,
                  description: null,
                  endCondition: { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true },
                  endConditionValue: 60.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
                  targetValueOne: null,
                  targetValueTwo: null,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: null,
                  exerciseName: null,
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: null,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
              ],
              endConditionValue: 3.0,
              preferredEndConditionUnit: null,
              endConditionCompare: null,
              endCondition: { conditionTypeId: 7, conditionTypeKey: "iterations", displayOrder: 7, displayable: false },
              skipLastRestStep: false,
              smartRepeat: false,
            },
            {
              type: "RepeatGroupDTO",
              stepId: 12610146164,
              stepOrder: 13,
              stepType: { stepTypeId: 6, stepTypeKey: "repeat", displayOrder: 6 },
              childStepId: 4,
              numberOfIterations: 3,
              workoutSteps: [
                {
                  type: "ExecutableStepDTO",
                  stepId: 12610146165,
                  stepOrder: 14,
                  stepType: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
                  childStepId: 4,
                  description: null,
                  endCondition: { conditionTypeId: 10, conditionTypeKey: "reps", displayOrder: 10, displayable: true },
                  endConditionValue: 10.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
                  targetValueOne: null,
                  targetValueTwo: null,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: "ROW",
                  exerciseName: "SINGLE_ARM_NEUTRAL_GRIP_DUMBBELL_ROW",
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: 79.99914107902653,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
                {
                  type: "ExecutableStepDTO",
                  stepId: 12610146166,
                  stepOrder: 15,
                  stepType: { stepTypeId: 5, stepTypeKey: "rest", displayOrder: 5 },
                  childStepId: 4,
                  description: null,
                  endCondition: { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true },
                  endConditionValue: 60.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
                  targetValueOne: null,
                  targetValueTwo: null,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: null,
                  exerciseName: null,
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: null,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
              ],
              endConditionValue: 3.0,
              preferredEndConditionUnit: null,
              endConditionCompare: null,
              endCondition: { conditionTypeId: 7, conditionTypeKey: "iterations", displayOrder: 7, displayable: false },
              skipLastRestStep: false,
              smartRepeat: false,
            },
            {
              type: "RepeatGroupDTO",
              stepId: 12610146167,
              stepOrder: 16,
              stepType: { stepTypeId: 6, stepTypeKey: "repeat", displayOrder: 6 },
              childStepId: 5,
              numberOfIterations: 3,
              workoutSteps: [
                {
                  type: "ExecutableStepDTO",
                  stepId: 12610146168,
                  stepOrder: 17,
                  stepType: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
                  childStepId: 5,
                  description: null,
                  endCondition: { conditionTypeId: 10, conditionTypeKey: "reps", displayOrder: 10, displayable: true },
                  endConditionValue: 12.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
                  targetValueOne: null,
                  targetValueTwo: null,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: "CALF_RAISE",
                  exerciseName: "STANDING_BARBELL_CALF_RAISE",
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: 274.99801198155075,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
                {
                  type: "ExecutableStepDTO",
                  stepId: 12610146169,
                  stepOrder: 18,
                  stepType: { stepTypeId: 5, stepTypeKey: "rest", displayOrder: 5 },
                  childStepId: 5,
                  description: null,
                  endCondition: { conditionTypeId: 1, conditionTypeKey: "lap.button", displayOrder: 1, displayable: true },
                  endConditionValue: 10.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
                  targetValueOne: null,
                  targetValueTwo: null,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: null,
                  exerciseName: null,
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: null,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
                {
                  type: "ExecutableStepDTO",
                  stepId: 12610146170,
                  stepOrder: 19,
                  stepType: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
                  childStepId: 5,
                  description: null,
                  endCondition: { conditionTypeId: 10, conditionTypeKey: "reps", displayOrder: 10, displayable: true },
                  endConditionValue: 10.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
                  targetValueOne: null,
                  targetValueTwo: null,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: "CURL",
                  exerciseName: "ONE_ARM_PREACHER_CURL",
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: 34.996179499227466,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
                {
                  type: "ExecutableStepDTO",
                  stepId: 12610146171,
                  stepOrder: 20,
                  stepType: { stepTypeId: 5, stepTypeKey: "rest", displayOrder: 5 },
                  childStepId: 5,
                  description: null,
                  endCondition: { conditionTypeId: 1, conditionTypeKey: "lap.button", displayOrder: 1, displayable: true },
                  endConditionValue: 10.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
                  targetValueOne: null,
                  targetValueTwo: null,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: null,
                  exerciseName: null,
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: null,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
                {
                  type: "ExecutableStepDTO",
                  stepId: 12610146172,
                  stepOrder: 21,
                  stepType: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
                  childStepId: 5,
                  description: null,
                  endCondition: { conditionTypeId: 10, conditionTypeKey: "reps", displayOrder: 10, displayable: true },
                  endConditionValue: 12.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
                  targetValueOne: null,
                  targetValueTwo: null,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: "TRICEPS_EXTENSION",
                  exerciseName: "CABLE_OVERHEAD_TRICEPS_EXTENSION",
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: 89.99930929173257,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
                {
                  type: "ExecutableStepDTO",
                  stepId: 12610146173,
                  stepOrder: 22,
                  stepType: { stepTypeId: 5, stepTypeKey: "rest", displayOrder: 5 },
                  childStepId: 5,
                  description: null,
                  endCondition: { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true },
                  endConditionValue: 60.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
                  targetValueOne: null,
                  targetValueTwo: null,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: null,
                  exerciseName: null,
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: null,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
              ],
              endConditionValue: 3.0,
              preferredEndConditionUnit: null,
              endConditionCompare: null,
              endCondition: { conditionTypeId: 7, conditionTypeKey: "iterations", displayOrder: 7, displayable: false },
              skipLastRestStep: false,
              smartRepeat: false,
            },
          ],
        },
      ],
      poolLength: null,
      poolLengthUnit: null,
      locale: null,
      workoutProvider: "null",
      workoutSourceId: "null",
      uploadTimestamp: null,
      atpPlanId: null,
      consumer: null,
      consumerName: null,
      consumerImageURL: null,
      consumerWebsiteURL: null,
      workoutNameI18nKey: null,
      descriptionI18nKey: null,
      avgTrainingSpeed: 0.0,
      estimateType: null,
      estimatedDistanceUnit: { unitId: null, unitKey: null, factor: null },
      workoutThumbnailUrl: null,
      isSessionTransitionEnabled: null,
      shared: false,
    };
  };

  const getSampleRunningWorkout = (): any => {
    return {
      workoutId: 1393595227,
      ownerId: 131933574,
      workoutName: "Run interval Tuesday ",
      description: null,
      updatedDate: "2026-02-24T02:39:25.0",
      createdDate: "2025-11-24T23:58:37.0",
      sportType: { sportTypeId: 1, sportTypeKey: "running", displayOrder: 1 },
      subSportType: "GENERIC",
      trainingPlanId: null,
      author: {
        userProfilePk: 131933574,
        displayName: "7d70a6c1-1770-4392-a199-c82b5332f542",
        fullName: "Marc-Etienne Dery",
        profileImgNameLarge: null,
        profileImgNameMedium: "6f3cd91f-8832-462c-92bb-c5fb0b7c3129-prfr.png",
        profileImgNameSmall: "6f3cd91f-8832-462c-92bb-c5fb0b7c3129-prth.png",
        userPro: false,
        vivokidUser: false,
      },
      sharedWithUsers: null,
      estimatedDurationInSecs: 2640,
      estimatedDistanceInMeters: 7081.1136,
      workoutSegments: [
        {
          segmentOrder: 1,
          sportType: { sportTypeId: 1, sportTypeKey: "running", displayOrder: 1 },
          poolLengthUnit: null,
          poolLength: null,
          avgTrainingSpeed: null,
          estimatedDurationInSecs: null,
          estimatedDistanceInMeters: null,
          estimatedDistanceUnit: null,
          estimateType: null,
          description: null,
          workoutSteps: [
            {
              type: "ExecutableStepDTO",
              stepId: 12543665241,
              stepOrder: 1,
              stepType: { stepTypeId: 1, stepTypeKey: "warmup", displayOrder: 1 },
              childStepId: null,
              description: null,
              endCondition: { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true },
              endConditionValue: 600.0,
              preferredEndConditionUnit: null,
              endConditionCompare: null,
              targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
              targetValueOne: null,
              targetValueTwo: 0.0,
              targetValueUnit: null,
              zoneNumber: null,
              secondaryTargetType: null,
              secondaryTargetValueOne: null,
              secondaryTargetValueTwo: null,
              secondaryTargetValueUnit: null,
              secondaryZoneNumber: null,
              endConditionZone: null,
              strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
              equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
              category: null,
              exerciseName: null,
              workoutProvider: null,
              providerExerciseSourceId: null,
              weightValue: null,
              weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
            },
            {
              type: "RepeatGroupDTO",
              stepId: 12543665243,
              stepOrder: 2,
              stepType: { stepTypeId: 6, stepTypeKey: "repeat", displayOrder: 6 },
              childStepId: 1,
              numberOfIterations: 2,
              workoutSteps: [
                {
                  type: "ExecutableStepDTO",
                  stepId: 12543665245,
                  stepOrder: 3,
                  stepType: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
                  childStepId: 1,
                  description: null,
                  endCondition: { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true },
                  endConditionValue: 120.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone", displayOrder: 4 },
                  targetValueOne: 165.0,
                  targetValueTwo: 170.0,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: null,
                  exerciseName: null,
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: null,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
                {
                  type: "ExecutableStepDTO",
                  stepId: 12543665246,
                  stepOrder: 4,
                  stepType: { stepTypeId: 4, stepTypeKey: "recovery", displayOrder: 4 },
                  childStepId: 1,
                  description: "",
                  endCondition: { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true },
                  endConditionValue: 120.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone", displayOrder: 4 },
                  targetValueOne: 120.0,
                  targetValueTwo: 145.0,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: null,
                  exerciseName: null,
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: null,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
              ],
              endConditionValue: 2.0,
              preferredEndConditionUnit: null,
              endConditionCompare: null,
              endCondition: { conditionTypeId: 7, conditionTypeKey: "iterations", displayOrder: 7, displayable: false },
              skipLastRestStep: null,
              smartRepeat: false,
            },
            {
              type: "RepeatGroupDTO",
              stepId: 12543665247,
              stepOrder: 5,
              stepType: { stepTypeId: 6, stepTypeKey: "repeat", displayOrder: 6 },
              childStepId: 2,
              numberOfIterations: 4,
              workoutSteps: [
                {
                  type: "ExecutableStepDTO",
                  stepId: 12543665248,
                  stepOrder: 6,
                  stepType: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
                  childStepId: 2,
                  description: "",
                  endCondition: { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true },
                  endConditionValue: 120.0,
                  preferredEndConditionUnit: { unitId: 4, unitKey: "mile", factor: 160934.4 },
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone", displayOrder: 4 },
                  targetValueOne: 168.0,
                  targetValueTwo: 174.0,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: null,
                  exerciseName: null,
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: null,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
                {
                  type: "ExecutableStepDTO",
                  stepId: 12543665249,
                  stepOrder: 7,
                  stepType: { stepTypeId: 4, stepTypeKey: "recovery", displayOrder: 4 },
                  childStepId: 2,
                  description: "",
                  endCondition: { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true },
                  endConditionValue: 120.0,
                  preferredEndConditionUnit: null,
                  endConditionCompare: null,
                  targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone", displayOrder: 4 },
                  targetValueOne: 120.0,
                  targetValueTwo: 145.0,
                  targetValueUnit: null,
                  zoneNumber: null,
                  secondaryTargetType: null,
                  secondaryTargetValueOne: null,
                  secondaryTargetValueTwo: null,
                  secondaryTargetValueUnit: null,
                  secondaryZoneNumber: null,
                  endConditionZone: null,
                  strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
                  equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
                  category: null,
                  exerciseName: null,
                  workoutProvider: null,
                  providerExerciseSourceId: null,
                  weightValue: null,
                  weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
                },
              ],
              endConditionValue: 4.0,
              preferredEndConditionUnit: null,
              endConditionCompare: null,
              endCondition: { conditionTypeId: 7, conditionTypeKey: "iterations", displayOrder: 7, displayable: false },
              skipLastRestStep: null,
              smartRepeat: false,
            },
            {
              type: "ExecutableStepDTO",
              stepId: 12543665250,
              stepOrder: 8,
              stepType: { stepTypeId: 2, stepTypeKey: "cooldown", displayOrder: 2 },
              childStepId: null,
              description: null,
              endCondition: { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true },
              endConditionValue: 600.0,
              preferredEndConditionUnit: null,
              endConditionCompare: null,
              targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
              targetValueOne: null,
              targetValueTwo: 0.0,
              targetValueUnit: null,
              zoneNumber: null,
              secondaryTargetType: null,
              secondaryTargetValueOne: null,
              secondaryTargetValueTwo: null,
              secondaryTargetValueUnit: null,
              secondaryZoneNumber: null,
              endConditionZone: null,
              strokeType: { strokeTypeId: 0, strokeTypeKey: null, displayOrder: 0 },
              equipmentType: { equipmentTypeId: 0, equipmentTypeKey: null, displayOrder: 0 },
              category: null,
              exerciseName: null,
              workoutProvider: null,
              providerExerciseSourceId: null,
              weightValue: null,
              weightUnit: { unitId: 9, unitKey: "pound", factor: 453.59237 },
            },
          ],
        },
      ],
      poolLength: null,
      poolLengthUnit: null,
      locale: null,
      workoutProvider: null,
      workoutSourceId: null,
      uploadTimestamp: null,
      atpPlanId: null,
      consumer: null,
      consumerName: null,
      consumerImageURL: null,
      consumerWebsiteURL: null,
      workoutNameI18nKey: null,
      descriptionI18nKey: null,
      avgTrainingSpeed: 2.613868338331834,
      estimateType: "DISTANCE_ESTIMATED",
      estimatedDistanceUnit: { unitId: null, unitKey: null, factor: null },
      workoutThumbnailUrl: null,
      isSessionTransitionEnabled: null,
      shared: false,
    };
  };

  const compareRawWorkouts = (initial: any, final: any): { identical: boolean; differences: string[] } => {
    const differences: string[] = [];

    const normalizeWeightToLbs = (step: any): number | undefined => {
      if (step?.weightValue === undefined || step?.weightValue === null) {
        return undefined;
      }

      const unitKey = step?.weightUnit?.unitKey;
      if (unitKey === "pound") {
        return Number(step.weightValue);
      }

      if (unitKey === "gram") {
        return Number(step.weightValue) / 453.59237;
      }

      return Number(step.weightValue);
    };

    if (initial.workoutName !== final.workoutName) {
      differences.push(`workoutName: "${initial.workoutName}" vs "${final.workoutName}"`);
    }
    if (initial.description !== final.description) {
      differences.push(`description: "${initial.description}" vs "${final.description}"`);
    }
    if (initial.sportType?.sportTypeKey !== final.sportType?.sportTypeKey) {
      differences.push(
        `sportType: "${initial.sportType?.sportTypeKey}" vs "${final.sportType?.sportTypeKey}"`
      );
    }

    const initialSegments = initial.workoutSegments || [];
    const finalSegments = final.workoutSegments || [];

    if (initialSegments.length !== finalSegments.length) {
      differences.push(`workoutSegments count: ${initialSegments.length} vs ${finalSegments.length}`);
      return { identical: false, differences };
    }

    for (let segIdx = 0; segIdx < initialSegments.length; segIdx++) {
      const initialSteps = initialSegments[segIdx].workoutSteps || [];
      const finalSteps = finalSegments[segIdx].workoutSteps || [];

      if (initialSteps.length !== finalSteps.length) {
        differences.push(
          `Segment ${segIdx} steps count: ${initialSteps.length} vs ${finalSteps.length}`
        );
        continue;
      }

      for (let stepIdx = 0; stepIdx < initialSteps.length; stepIdx++) {
        const initialStep = initialSteps[stepIdx];
        const finalStep = finalSteps[stepIdx];

        if (initialStep.type !== finalStep.type) {
          differences.push(
            `Step ${stepIdx} type: "${initialStep.type}" vs "${finalStep.type}"`
          );
        }

        if (
          initialStep.stepType?.stepTypeKey !== finalStep.stepType?.stepTypeKey
        ) {
          differences.push(
            `Step ${stepIdx} stepTypeKey: "${initialStep.stepType?.stepTypeKey}" vs "${finalStep.stepType?.stepTypeKey}"`
          );
        }

        if (initialStep.exerciseName !== finalStep.exerciseName) {
          differences.push(
            `Step ${stepIdx} exerciseName: "${initialStep.exerciseName}" vs "${finalStep.exerciseName}"`
          );
        }

        if (
          initialStep.endCondition?.conditionTypeKey !==
          finalStep.endCondition?.conditionTypeKey
        ) {
          differences.push(
            `Step ${stepIdx} endCondition: "${initialStep.endCondition?.conditionTypeKey}" vs "${finalStep.endCondition?.conditionTypeKey}"`
          );
        }

        if (initialStep.endConditionValue !== finalStep.endConditionValue) {
          differences.push(
            `Step ${stepIdx} endConditionValue: ${initialStep.endConditionValue} vs ${finalStep.endConditionValue}`
          );
        }

        const initialWeightLbs = normalizeWeightToLbs(initialStep);
        const finalWeightLbs = normalizeWeightToLbs(finalStep);

        if (initialWeightLbs !== undefined && finalWeightLbs !== undefined) {
          const tolerance = Math.max(initialWeightLbs * 0.01, 0.5);
          if (Math.abs(initialWeightLbs - finalWeightLbs) > tolerance) {
            differences.push(
              `Step ${stepIdx} weightValue: ${initialStep.weightValue} vs ${finalStep.weightValue}`
            );
          }
        } else if (initialWeightLbs !== finalWeightLbs) {
          differences.push(
            `Step ${stepIdx} weightValue: ${initialStep.weightValue} vs ${finalStep.weightValue}`
          );
        }
      }
    }

    return { identical: differences.length === 0, differences };
  };

  describe("E2E: Full upload cycle - data integrity", () => {
    it("should maintain structural parity through transform -> retransform -> upload -> redownload cycle", async () => {
      const initialRaw = getSampleRawWorkout();
      const initialRawPath = path.join(tempDir, "initial-raw.json");
      fs.writeFileSync(initialRawPath, JSON.stringify([initialRaw], null, 2));

      const transformed = (editor as any).transformWorkouts([initialRaw]);
      const transformedPath = path.join(tempDir, "transformed.json");
      fs.writeFileSync(transformedPath, JSON.stringify(transformed, null, 2));

      expect(transformed).toHaveLength(1);
      const transformedWorkout = transformed[0];
      expect(transformedWorkout.workoutName).toBe("Copy of Squat day");
      expect(transformedWorkout.steps).toBeDefined();
      expect(transformedWorkout.steps?.length).toBeGreaterThan(0);

      const retransformed = (editor as any).buildGarminWorkoutDetail(transformedWorkout);

      const finalRaw = {
        workoutId: initialRaw.workoutId,
        workoutName: retransformed.workoutName,
        sportType: retransformed.sportType,
        workoutSegments: retransformed.workoutSegments,
      };

      expect(finalRaw.workoutName).toBe(initialRaw.workoutName);
      expect(finalRaw.sportType.sportTypeKey).toBe(initialRaw.sportType.sportTypeKey);
      expect(finalRaw.workoutSegments.length).toBeGreaterThan(0);
      expect(finalRaw.workoutSegments[0].workoutSteps.length).toBeGreaterThan(0);

      const findExercises = (steps: any[]): string[] => {
        const exercises: string[] = [];
        for (const step of steps) {
          if (step.exerciseName && step.stepType?.stepTypeKey && 
              ["exercise", "interval"].includes(step.stepType.stepTypeKey)) {
            exercises.push(step.exerciseName);
          }
          if (step.workoutSteps && Array.isArray(step.workoutSteps)) {
            exercises.push(...findExercises(step.workoutSteps));
          }
        }
        return exercises;
      };

      const initialExercises = findExercises(initialRaw.workoutSegments[0].workoutSteps);
      const finalExercises = findExercises(finalRaw.workoutSegments[0].workoutSteps);

      expect(initialExercises.length).toBeGreaterThan(0);
      expect(finalExercises.length).toBeGreaterThan(0);

      const commonExercises = initialExercises.filter((e: string) => finalExercises.includes(e));
      expect(commonExercises.length).toBeGreaterThan(0);
    });

    it("should preserve workout with repeat groups through full cycle", async () => {
      const workoutWithRepeat: any = {
        workoutId: 789012,
        workoutName: "Repeat Group Workout",
        sportType: { sportTypeId: 5, sportTypeKey: "strength_training" },
        workoutSegments: [
          {
            segmentOrder: 1,
            sportType: { sportTypeId: 5, sportTypeKey: "strength_training" },
            workoutSteps: [
              {
                type: "RepeatGroupDTO",
                stepType: { stepTypeId: 7, stepTypeKey: "repeat" },
                numberOfIterations: 3,
                smartRepeat: false,
                workoutSteps: [
                  {
                    type: "ExecutableStepDTO",
                    stepOrder: 1,
                    stepType: { stepTypeId: 6, stepTypeKey: "exercise" },
                    exerciseName: "BARBELL_SQUAT",
                    endCondition: { conditionTypeId: 10, conditionTypeKey: "reps" },
                    endConditionValue: 5,
                    weightValue: 100000,
                    weightUnit: { unitId: 11, unitKey: "gram" },
                  },
                  {
                    type: "ExecutableStepDTO",
                    stepOrder: 2,
                    stepType: { stepTypeId: 5, stepTypeKey: "rest" },
                    endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
                    endConditionValue: 90,
                  },
                ],
              },
            ],
          },
        ],
      };

      const transformed = (editor as any).transformWorkouts([workoutWithRepeat]);
      expect(transformed[0].steps).toBeDefined();

      const flatSteps = transformed[0].steps;
      const repeatStep = flatSteps?.find((s: WorkoutStep) => s.numberOfRepeats === 3);
      expect(repeatStep).toBeDefined();
      expect(repeatStep?.numberOfRepeats).toBe(3);

      const retransformed = (editor as any).buildGarminWorkoutDetail(transformed[0]);
      const finalRaw = {
        workoutId: workoutWithRepeat.workoutId,
        workoutName: retransformed.workoutName,
        sportType: retransformed.sportType,
        workoutSegments: retransformed.workoutSegments,
      };

      const { identical, differences } = compareRawWorkouts(workoutWithRepeat, finalRaw);

      if (!identical) {
        console.log("\n🔍 Repeat group test differences:");
        differences.forEach((diff) => console.log(`   - ${diff}`));
      }

      expect(identical).toBe(true);
    });
  });

  describe("E2E: Upload cycle with small modifications", () => {
    it("should handle weight modification through full cycle", async () => {
      const initialRaw = getSampleRawWorkout();

      const transformed = (editor as any).transformWorkouts([initialRaw]);
      const workout = transformed[0];

      const exerciseSteps = workout.steps?.filter((s: WorkoutStep) => s.weight !== undefined && s.weight > 0);
      expect(exerciseSteps?.length).toBeGreaterThan(0);

      const originalWeight = exerciseSteps![0].weight;
      exerciseSteps![0].weight = (originalWeight || 15) * 1.1;

      const retransformed = (editor as any).buildGarminWorkoutDetail(workout);
      const finalRaw = {
        workoutId: initialRaw.workoutId,
        workoutName: retransformed.workoutName,
        sportType: retransformed.sportType,
        workoutSegments: retransformed.workoutSegments,
      };

      const stepToModify = exerciseSteps![0];
      const finalExercises = finalRaw.workoutSegments[0].workoutSteps
        .filter((s: any) => s.exerciseName === stepToModify.exerciseName);
      
      const initialStep = initialRaw.workoutSegments[0].workoutSteps
        .find((s: any) => s.exerciseName === stepToModify.exerciseName);
      const initialWeight = initialStep?.weightValue || 0;
      const finalWeight = finalExercises[0]?.weightValue || 0;

      if (initialWeight > 0 && finalWeight > 0) {
        const ratio = finalWeight / initialWeight;
        expect(ratio).toBeCloseTo(1.1, 1);
      }
    });

    it("should handle reps modification through full cycle", async () => {
      const initialRaw = getSampleRawWorkout();

      const transformed = (editor as any).transformWorkouts([initialRaw]);
      const workout = transformed[0];

      const exerciseStep = workout.steps?.find((s: WorkoutStep) => s.reps && s.exerciseName);
      expect(exerciseStep).toBeDefined();

      const originalReps = exerciseStep!.reps || 0;
      exerciseStep!.reps = 12;
      exerciseStep!.endConditionValue = 12;

      const retransformed = (editor as any).buildGarminWorkoutDetail(workout);
      const finalRaw = {
        workoutId: initialRaw.workoutId,
        workoutName: retransformed.workoutName,
        workoutSegments: retransformed.workoutSegments,
      };

      const finalExerciseStep = finalRaw.workoutSegments[0].workoutSteps
        .find((s: any) => s.exerciseName === exerciseStep!.exerciseName);

      expect(finalExerciseStep.endConditionValue).toBe(12);
    });

    it("should handle exercise name modification through full cycle", async () => {
      const initialRaw = getSampleRawWorkout();

      const transformed = (editor as any).transformWorkouts([initialRaw]);
      const workout = transformed[0];

      const exerciseToModify = workout.steps?.find((s: WorkoutStep) => s.exerciseName);
      expect(exerciseToModify).toBeDefined();

      const originalName = exerciseToModify!.exerciseName!;
      exerciseToModify!.exerciseName = "MODIFIED_" + originalName;

      const retransformed = (editor as any).buildGarminWorkoutDetail(workout);
      const finalRaw = {
        workoutId: initialRaw.workoutId,
        workoutName: retransformed.workoutName,
        workoutSegments: retransformed.workoutSegments,
      };

      const finalStep = finalRaw.workoutSegments[0].workoutSteps
        .find((s: any) => s.exerciseName === "MODIFIED_" + originalName);
      
      expect(finalStep).toBeDefined();
      expect(finalStep.exerciseName).toBe("MODIFIED_" + originalName);

      const oldStep = finalRaw.workoutSegments[0].workoutSteps
        .find((s: any) => s.exerciseName === originalName);
      expect(finalStep).toBeDefined();
    });

    it("should handle multiple modifications simultaneously", async () => {
      const initialRaw = getSampleRawWorkout();

      const transformed = (editor as any).transformWorkouts([initialRaw]);
      const workout = transformed[0];

      const exercises = workout.steps?.filter((s: WorkoutStep) => s.exerciseName && s.weight) || [];
      expect(exercises.length).toBeGreaterThanOrEqual(2);

      const bench = exercises[0];
      const squat = exercises[1];

      bench.weight = (bench.weight || 100) * 1.25;
      bench.reps = (bench.reps || 10) - 2;
      bench.endConditionValue = bench.reps;

      squat.weight = (squat.weight || 100) * 0.9;
      squat.reps = (squat.reps || 10) + 2;
      squat.endConditionValue = squat.reps;

      const retransformed = (editor as any).buildGarminWorkoutDetail(workout);
      const finalRaw = {
        workoutId: initialRaw.workoutId,
        workoutName: retransformed.workoutName,
        workoutSegments: retransformed.workoutSegments,
      };

      const findExercise = (exerciseName: string, steps: any[]): any => {
        for (const step of steps) {
          if (step.exerciseName === exerciseName) return step;
          if (step.workoutSteps) {
            const found = findExercise(exerciseName, step.workoutSteps);
            if (found) return found;
          }
        }
        return null;
      };

      const finalBench = findExercise(bench.exerciseName, finalRaw.workoutSegments[0].workoutSteps);
      const finalSquat = findExercise(squat.exerciseName, finalRaw.workoutSegments[0].workoutSteps);

      expect(finalBench).toBeDefined();
      expect(finalSquat).toBeDefined();
      expect(finalBench.endConditionValue).toBe(bench.reps);
      expect(finalSquat.endConditionValue).toBe(squat.reps);
    });
  });

  describe("E2E: Mock API integration", () => {
    it("should successfully create workout via mocked Garmin API", async () => {
      const initialRaw = getSampleRawWorkout();
      const transformed = (editor as any).transformWorkouts([initialRaw]);
      const workout = transformed[0];

      const mockClient = getMockClient();
      const createWorkoutMock = mockClient.createWorkout;

      const garminFormatWorkout = (editor as any).buildGarminWorkoutDetail(workout);
      
      expect(garminFormatWorkout.workoutName).toBe("Copy of Squat day");
      expect(garminFormatWorkout.workoutSegments).toBeDefined();
      expect(garminFormatWorkout.workoutSegments[0].workoutSteps).toBeDefined();
    });

    it("should validate workout before upload attempt", async () => {
      const invalidWorkout: DetailedWorkout = {
        workoutId: 1,
        workoutName: "Invalid",
      };

      expect(() => (editor as any).validateWorkout(invalidWorkout)).toThrow();
    });
  });

  (USE_REAL_API ? describe : describe.skip)("E2E: Real Garmin API Upload/Download Cycle", () => {
    it("should upload workout to real Garmin API and download it back", async () => {
      const initialRaw = getSampleRawWorkout();
      
      const testWorkoutName = `Test Workout ${Date.now()}`;
      initialRaw.workoutName = testWorkoutName;

      const transformed = (editor as any).transformWorkouts([initialRaw]);
      const workout = transformed[0];
      workout.workoutName = testWorkoutName;

      console.log(`\n📤 Uploading workout: ${testWorkoutName}`);

      const garminFormatWorkout = (editor as any).buildGarminWorkoutDetail(workout);
      const client = (garminClient as any).client;
      
      let uploadedWorkout: any;
      try {
        uploadedWorkout = await client.createWorkout(garminFormatWorkout);
        expect(uploadedWorkout).toBeDefined();
        expect(uploadedWorkout.workoutId).toBeDefined();
        
        createdWorkoutIds.push(uploadedWorkout.workoutId);
        console.log(`   ✓ Uploaded successfully (ID: ${uploadedWorkout.workoutId})`);
      } catch (error: any) {
        console.error(`   ✗ Upload failed: ${error.message}`);
        throw error;
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log(`📥 Downloading workout: ${uploadedWorkout.workoutId}`);
      let downloadedWorkout: any;
      try {
        downloadedWorkout = await client.getWorkoutDetail(uploadedWorkout.workoutId);
        expect(downloadedWorkout).toBeDefined();
        console.log(`   ✓ Downloaded successfully`);
      } catch (error: any) {
        console.error(`   ✗ Download failed: ${error.message}`);
        throw error;
      }

      console.log(`🔍 Comparing initial vs downloaded workout...`);
      expect(downloadedWorkout.workoutName).toBe(testWorkoutName);
      expect(downloadedWorkout.sportType?.sportTypeKey).toBe(initialRaw.sportType.sportTypeKey);
      expect(downloadedWorkout.workoutSegments).toBeDefined();
      expect(downloadedWorkout.workoutSegments.length).toBeGreaterThan(0);

      const { identical, differences } = compareRawWorkouts(initialRaw, downloadedWorkout);
      
      if (!identical) {
        console.log(`   ℹ Found ${differences.length} differences (some expected):`);
        differences.slice(0, 5).forEach(diff => console.log(`     - ${diff}`));
      }

      expect(downloadedWorkout.workoutId).toBe(uploadedWorkout.workoutId);
      console.log(`   ✓ Upload/download cycle successful!`);
    });

    it("should modify workout, upload, and verify changes persist", async () => {
      const initialRaw = getSampleRawWorkout();
      const testWorkoutName = `Modified Test ${Date.now()}`;
      initialRaw.workoutName = testWorkoutName;

      const transformed = (editor as any).transformWorkouts([initialRaw]);
      const workout = transformed[0];
      workout.workoutName = testWorkoutName;

      const exercise = workout.steps?.find((s: WorkoutStep) => s.weight && s.weight > 0);
      if (exercise) {
        const originalWeight = exercise.weight!;
        exercise.weight = originalWeight * 1.5;
        console.log(`\n✏️  Modified weight: ${originalWeight} → ${exercise.weight} lbs`);
      }

      console.log(`📤 Uploading modified workout: ${testWorkoutName}`);
      const garminFormatWorkout = (editor as any).buildGarminWorkoutDetail(workout);
      const client = (garminClient as any).client;
      
      const uploadedWorkout = await client.createWorkout(garminFormatWorkout);
      createdWorkoutIds.push(uploadedWorkout.workoutId);
      console.log(`   ✓ Uploaded (ID: ${uploadedWorkout.workoutId})`);

      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log(`📥 Downloading to verify modifications...`);
      const downloadedWorkout = await client.getWorkoutDetail(uploadedWorkout.workoutId);
      
      const downloadedTransformed = (editor as any).transformWorkouts([downloadedWorkout]);
      const downloadedExercise = downloadedTransformed[0].steps?.find(
        (s: WorkoutStep) => s.exerciseName === exercise?.exerciseName
      );

      if (exercise && downloadedExercise) {
        const tolerance = Math.max(exercise.weight!, downloadedExercise.weight || 0) * 0.02;
        expect(Math.abs((downloadedExercise.weight || 0) - exercise.weight!)).toBeLessThan(tolerance);
        console.log(`   ✓ Modification verified: weight ${downloadedExercise.weight} lbs`);
      }
    });
  });

  describe("Data structure preservation", () => {
    it("should preserve all step types through transform cycle", async () => {
      const stepsWorkout: any = {
        workoutId: 111111,
        workoutName: "All Steps Workout",
        sportType: { sportTypeId: 5, sportTypeKey: "strength_training" },
        workoutSegments: [
          {
            segmentOrder: 1,
            sportType: { sportTypeId: 5, sportTypeKey: "strength_training" },
            workoutSteps: [
              {
                type: "ExecutableStepDTO",
                stepType: { stepTypeId: 1, stepTypeKey: "warmup" },
                endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
                endConditionValue: 300,
              },
              {
                type: "ExecutableStepDTO",
                stepType: { stepTypeId: 6, stepTypeKey: "exercise" },
                exerciseName: "BARBELL_BENCH_PRESS",
                endCondition: { conditionTypeId: 10, conditionTypeKey: "reps" },
                endConditionValue: 8,
                weightValue: 100000,
              },
              {
                type: "ExecutableStepDTO",
                stepType: { stepTypeId: 5, stepTypeKey: "rest" },
                endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
                endConditionValue: 120,
              },
              {
                type: "ExecutableStepDTO",
                stepType: { stepTypeId: 4, stepTypeKey: "recovery" },
                endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
                endConditionValue: 600,
              },
              {
                type: "ExecutableStepDTO",
                stepType: { stepTypeId: 2, stepTypeKey: "cooldown" },
                endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
                endConditionValue: 300,
              },
            ],
          },
        ],
      };

      const transformed = (editor as any).transformWorkouts([stepsWorkout]);
      expect(transformed[0].steps).toBeDefined();

      const stepTypes = transformed[0].steps?.map((s: WorkoutStep) => s.stepType);
      expect(stepTypes).toContain("warmup");
      expect(stepTypes).toContain("exercise");
      expect(stepTypes).toContain("recovery");
      expect(stepTypes).toContain("cooldown");

      const retransformed = (editor as any).buildGarminWorkoutDetail(transformed[0]);
      const finalSteps = retransformed.workoutSegments[0].workoutSteps;

      const finalStepTypes = finalSteps.map((s: any) => s.stepType?.stepTypeKey);
      expect(finalStepTypes).toContain("warmup");
      expect(finalStepTypes).toContain("exercise");
      expect(finalStepTypes).toContain("rest");
      expect(finalStepTypes).toContain("recovery");
      expect(finalStepTypes).toContain("cooldown");
    });

    it("should preserve heart rate zone targets through cycle", async () => {
      const zonesWorkout: any = {
        workoutId: 222222,
        workoutName: "HR Zone Workout",
        sportType: { sportTypeId: 1, sportTypeKey: "running" },
        workoutSegments: [
          {
            segmentOrder: 1,
            sportType: { sportTypeId: 1, sportTypeKey: "running" },
            workoutSteps: [
              {
                type: "ExecutableStepDTO",
                stepType: { stepTypeId: 1, stepTypeKey: "warmup" },
                endCondition: { conditionTypeId: 3, conditionTypeKey: "distance" },
                endConditionValue: 1000,
                targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone" },
                targetValueOne: 110,
                targetValueTwo: 130,
              },
              {
                type: "ExecutableStepDTO",
                stepType: { stepTypeId: 3, stepTypeKey: "interval" },
                endCondition: { conditionTypeId: 3, conditionTypeKey: "distance" },
                endConditionValue: 1600,
                targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone" },
                targetValueOne: 150,
                targetValueTwo: 170,
              },
            ],
          },
        ],
      };

      const transformed = (editor as any).transformWorkouts([zonesWorkout]);
      expect(transformed[0].steps).toBeDefined();

      const steps = transformed[0].steps;
      expect(steps?.some((s: WorkoutStep) => s.targetType === "heart.rate.zone")).toBe(true);

      const retransformed = (editor as any).buildGarminWorkoutDetail(transformed[0]);
      const finalSteps = retransformed.workoutSegments[0].workoutSteps;

      const zoneStep = finalSteps.find((s: any) => s.targetType?.workoutTargetTypeKey === "heart.rate.zone");
      expect(zoneStep).toBeDefined();
      expect(zoneStep.targetValueOne).toBeDefined();
      expect(zoneStep.targetValueTwo).toBeDefined();
    });

    it("should normalize cooldown open targetType to no.target on upload payload", async () => {
      const workout: DetailedWorkout = {
        workoutId: 999001,
        workoutName: "Cooldown target normalization",
        workoutType: "running",
        steps: [
          {
            stepType: "cooldown",
            targetType: "open",
            endCondition: "time",
            endConditionValue: 300,
            durationSeconds: 300,
            stepOrder: 1,
          },
        ],
      };

      const garminWorkout = (editor as any).buildGarminWorkoutDetail(workout);
      const cooldownStep = garminWorkout.workoutSegments[0].workoutSteps[0];

      expect(cooldownStep.stepType.stepTypeKey).toBe("cooldown");
      expect(cooldownStep.targetType.workoutTargetTypeKey).toBe("no.target");
      expect(cooldownStep.targetType.workoutTargetTypeId).toBe(1);
    });
  });

  describe("Running Workout Upload Cycle - Run interval Tuesday", () => {
    it("should maintain structural parity through running workout transform → retransform → upload → redownload cycle", async () => {
      const initialRaw = getSampleRunningWorkout();

      const transformed = (editor as any).transformWorkouts([initialRaw]);
      expect(transformed).toHaveLength(1);
      const workout = transformed[0];

      expect(workout.workoutName).toBe("Run interval Tuesday ");
      expect(workout.steps).toBeDefined();
      expect(workout.steps?.length).toBeGreaterThan(0);

      const retransformed = (editor as any).buildGarminWorkoutDetail(workout);
      expect(retransformed.workoutName).toBe("Run interval Tuesday ");
      expect(retransformed.workoutSegments).toBeDefined();
      expect(retransformed.workoutSegments.length).toBeGreaterThan(0);

      const finalRaw = {
        workoutId: initialRaw.workoutId,
        workoutName: retransformed.workoutName,
        sportType: retransformed.sportType,
        workoutSegments: retransformed.workoutSegments,
      };

      expect(finalRaw.workoutId).toBe(initialRaw.workoutId);
      expect(finalRaw.workoutName).toBe(initialRaw.workoutName);
      expect(finalRaw.sportType.sportTypeKey).toBe(initialRaw.sportType.sportTypeKey);
      expect(finalRaw.workoutSegments.length).toBe(initialRaw.workoutSegments.length);

      const hasIntervals = finalRaw.workoutSegments[0].workoutSteps.some(
        (s: any) => s.stepType?.stepTypeKey === "interval" || (s.workoutSteps && s.workoutSteps.some((ws: any) => ws.stepType?.stepTypeKey === "interval"))
      );
      expect(hasIntervals).toBe(true);
    });

    it("should preserve heart rate zones through running workout cycle", async () => {
      const initialRaw = getSampleRunningWorkout();

      const transformed = (editor as any).transformWorkouts([initialRaw]);
      const workout = transformed[0];

      const intervalSteps = workout.steps?.filter((s: WorkoutStep) => s.stepType === "interval") || [];
      expect(intervalSteps.length).toBeGreaterThan(0);

      intervalSteps.forEach((step: WorkoutStep) => {
        if (step.targetType === "heart.rate.zone") {
          expect(step.targetValueOne).toBeDefined();
          expect(step.targetValueTwo).toBeDefined();
        }
      });

      const retransformed = (editor as any).buildGarminWorkoutDetail(workout);
      const finalRaw = {
        workoutId: initialRaw.workoutId,
        workoutName: retransformed.workoutName,
        workoutSegments: retransformed.workoutSegments,
      };

      const findIntervals = (steps: any[]): any[] => {
        let intervals: any[] = [];
        for (const step of steps) {
          if (step.stepType?.stepTypeKey === "interval") {
            intervals.push(step);
          }
          if (step.workoutSteps) {
            intervals = intervals.concat(findIntervals(step.workoutSteps));
          }
        }
        return intervals;
      };

      const finalIntervals = findIntervals(finalRaw.workoutSegments[0].workoutSteps);
      expect(finalIntervals.length).toBeGreaterThan(0);

      finalIntervals.forEach((interval: any) => {
        if (interval.targetType?.workoutTargetTypeKey === "heart.rate.zone") {
          expect(interval.targetValueOne).toBeDefined();
          expect(interval.targetValueTwo).toBeDefined();
        }
      });
    });

    it("should handle heart rate zone modification through running workout cycle", async () => {
      const initialRaw = getSampleRunningWorkout();

      const transformed = (editor as any).transformWorkouts([initialRaw]);
      const workout = transformed[0];

      const intervalStep = workout.steps?.find((s: WorkoutStep) => s.stepType === "interval");
      expect(intervalStep).toBeDefined();

      const originalZone = {
        min: intervalStep!.targetValueOne,
        max: intervalStep!.targetValueTwo,
      };

      intervalStep!.targetValueOne = (intervalStep!.targetValueOne || 150) + 10;
      intervalStep!.targetValueTwo = (intervalStep!.targetValueTwo || 170) + 10;

      const retransformed = (editor as any).buildGarminWorkoutDetail(workout);
      const finalRaw = {
        workoutId: initialRaw.workoutId,
        workoutName: retransformed.workoutName,
        workoutSegments: retransformed.workoutSegments,
      };

      const findInterval = (steps: any[]): any => {
        for (const step of steps) {
          if (step.stepType?.stepTypeKey === "interval") return step;
          if (step.workoutSteps) {
            const found = findInterval(step.workoutSteps);
            if (found) return found;
          }
        }
        return null;
      };

      const finalInterval = findInterval(finalRaw.workoutSegments[0].workoutSteps);
      expect(finalInterval).toBeDefined();
      expect(finalInterval.targetValueOne).toBe(intervalStep!.targetValueOne);
      expect(finalInterval.targetValueTwo).toBe(intervalStep!.targetValueTwo);
    });

    it("should handle interval duration modification through running workout cycle", async () => {
      const initialRaw = getSampleRunningWorkout();

      const transformed = (editor as any).transformWorkouts([initialRaw]);
      const workout = transformed[0];

      const intervalStep = workout.steps?.find((s: WorkoutStep) => s.stepType === "interval");
      expect(intervalStep).toBeDefined();

      const originalDuration = intervalStep!.endConditionValue;
      intervalStep!.endConditionValue = 180;

      const retransformed = (editor as any).buildGarminWorkoutDetail(workout);
      const finalRaw = {
        workoutId: initialRaw.workoutId,
        workoutName: retransformed.workoutName,
        workoutSegments: retransformed.workoutSegments,
      };

      const findInterval = (steps: any[]): any => {
        for (const step of steps) {
          if (step.stepType?.stepTypeKey === "interval") return step;
          if (step.workoutSteps) {
            const found = findInterval(step.workoutSteps);
            if (found) return found;
          }
        }
        return null;
      };

      const finalInterval = findInterval(finalRaw.workoutSegments[0].workoutSteps);
      expect(finalInterval).toBeDefined();
      expect(finalInterval.endConditionValue).toBe(180);
    });

    it("should preserve running workout repeat groups through cycle", async () => {
      const initialRaw = getSampleRunningWorkout();

      const transformed = (editor as any).transformWorkouts([initialRaw]);
      const workout = transformed[0];

      const initialRepeatGroups = initialRaw.workoutSegments[0].workoutSteps.filter(
        (s: any) => s.type === "RepeatGroupDTO"
      );
      expect(initialRepeatGroups.length).toBe(2);

      const retransformed = (editor as any).buildGarminWorkoutDetail(workout);
      const finalRaw = {
        workoutId: initialRaw.workoutId,
        workoutName: retransformed.workoutName,
        workoutSegments: retransformed.workoutSegments,
      };

      const finalRepeatGroups = finalRaw.workoutSegments[0].workoutSteps.filter(
        (s: any) => s.type === "RepeatGroupDTO"
      );
      expect(finalRepeatGroups.length).toBeGreaterThan(0);

      initialRepeatGroups.forEach((initial: any, idx: number) => {
        if (finalRepeatGroups[idx]) {
          expect(finalRepeatGroups[idx].numberOfIterations).toBe(initial.numberOfIterations);
        }
      });
    });
  });
});
