import * as fs from "fs";
import * as path from "path";
import {
  DetailedWorkout,
  GarminWorkoutSummary,
  PlannedWorkout,
  WeeklyWorkoutPlan,
  WorkoutStep,
} from "./shared/types";
import { GarminClient } from "./shared/garminClient";
import type {
  IWorkoutDetail,
  IWorkoutStep,
  IWorkoutSegment,
} from "@flow-js/garmin-connect";
import {
  StepType,
  Step,
  Target,
  Duration,
  WorkoutBuilder,
} from "@flow-js/garmin-connect";

// Valid stepType values (from Garmin API)
const VALID_STEP_TYPES = [
  "warmup",
  "cooldown",
  "interval",
  "recovery",
  "rest",
  "exercise",
  "repeat",
  "other",
];

// Valid endCondition values (from Garmin API)
const VALID_END_CONDITIONS = [
  "reps",
  "time",
  "distance",
  "lap.button",
  "iterations",
  "calories",
  "heart.rate",
];

// Valid targetType values (from Garmin API)
const VALID_TARGET_TYPES = [
  "no.target",
  "heart.rate.zone",
  "pace.zone",
  "speed.zone",
  "power.zone",
  "cadence.zone",
  "open",
];

/**
 * Workout management, import, export, and scheduling
 */
export class WorkoutEditor {
  private garminClient: GarminClient;

  constructor(garminClient: GarminClient) {
    this.garminClient = garminClient;
  }

  /**
   * Type guard for valid stepType
   */
  private isValidStepType(value: any): boolean {
    return typeof value === "string" && VALID_STEP_TYPES.includes(value);
  }

  /**
   * Type guard for valid endCondition
   */
  private isValidEndCondition(value: any): boolean {
    return typeof value === "string" && VALID_END_CONDITIONS.includes(value);
  }

  /**
   * Type guard for valid targetType
   */
  private isValidTargetType(value: any): boolean {
    return typeof value === "string" && VALID_TARGET_TYPES.includes(value);
  }

  /**
   * Strict validation for a single workout step
   * Throws immediately on validation errors
   */
  private validateWorkoutStep(step: WorkoutStep, stepIndex: number): void {
    // Required: stepType
    if (!step.stepType) {
      throw new Error(
        `Step ${stepIndex}: Missing required field 'stepType'`
      );
    }
    if (!this.isValidStepType(step.stepType)) {
      throw new Error(
        `Step ${stepIndex}: Invalid stepType '${step.stepType}'. Must be one of: ${VALID_STEP_TYPES.join(", ")}`
      );
    }

    // Required: endCondition (for most step types)
    if (!step.endCondition && step.stepType !== "rest") {
      throw new Error(
        `Step ${stepIndex}: Missing required field 'endCondition' for ${step.stepType}`
      );
    }
    if (step.endCondition && !this.isValidEndCondition(step.endCondition)) {
      throw new Error(
        `Step ${stepIndex}: Invalid endCondition '${step.endCondition}'. Must be one of: ${VALID_END_CONDITIONS.join(", ")}`
      );
    }

    // Required: endConditionValue (if endCondition is set)
    if (step.endCondition && step.endConditionValue === undefined) {
      throw new Error(
        `Step ${stepIndex}: Missing required field 'endConditionValue' when endCondition is '${step.endCondition}'`
      );
    }

    // Type validation: endConditionValue must be a number
    if (step.endConditionValue !== undefined && typeof step.endConditionValue !== "number") {
      throw new Error(
        `Step ${stepIndex}: Field 'endConditionValue' must be a number, got ${typeof step.endConditionValue}`
      );
    }

    // Range validation: endConditionValue must be positive
    if (step.endConditionValue !== undefined && step.endConditionValue <= 0) {
      throw new Error(
        `Step ${stepIndex}: Field 'endConditionValue' must be positive, got ${step.endConditionValue}`
      );
    }

    // Required: targetType
    if (!step.targetType) {
      throw new Error(
        `Step ${stepIndex}: Missing required field 'targetType'`
      );
    }
    if (!this.isValidTargetType(step.targetType)) {
      throw new Error(
        `Step ${stepIndex}: Invalid targetType '${step.targetType}'. Must be one of: ${VALID_TARGET_TYPES.join(", ")}`
      );
    }

    // Type validation: targetValueOne and targetValueTwo must be numbers if present
    if (step.targetValueOne !== undefined && typeof step.targetValueOne !== "number") {
      throw new Error(
        `Step ${stepIndex}: Field 'targetValueOne' must be a number, got ${typeof step.targetValueOne}`
      );
    }
    if (step.targetValueTwo !== undefined && typeof step.targetValueTwo !== "number") {
      throw new Error(
        `Step ${stepIndex}: Field 'targetValueTwo' must be a number, got ${typeof step.targetValueTwo}`
      );
    }

    // Weight validation
    if (step.weight !== undefined) {
      if (typeof step.weight !== "number") {
        throw new Error(
          `Step ${stepIndex}: Field 'weight' must be a number, got ${typeof step.weight}`
        );
      }
      if (step.weight < 0) {
        throw new Error(
          `Step ${stepIndex}: Field 'weight' cannot be negative, got ${step.weight}`
        );
      }
      // Reasonable range check (0-1000 lbs)
      if (step.weight > 1000) {
        throw new Error(
          `Step ${stepIndex}: Field 'weight' seems unreasonably high (${step.weight} lbs). Check if value is correct.`
        );
      }
    }

    // Weight percentage validation
    if (step.weightPercentage !== undefined) {
      if (typeof step.weightPercentage !== "number") {
        throw new Error(
          `Step ${stepIndex}: Field 'weightPercentage' must be a number, got ${typeof step.weightPercentage}`
        );
      }
      if (step.weightPercentage <= 0 || step.weightPercentage > 200) {
        throw new Error(
          `Step ${stepIndex}: Field 'weightPercentage' must be between 0 and 200, got ${step.weightPercentage}`
        );
      }
      // Must have benchmarkKey if using percentage
      if (!step.benchmarkKey) {
        throw new Error(
          `Step ${stepIndex}: Field 'benchmarkKey' is required when 'weightPercentage' is set`
        );
      }
    }

    // Reps validation
    if (step.reps !== undefined) {
      if (typeof step.reps !== "number") {
        throw new Error(
          `Step ${stepIndex}: Field 'reps' must be a number, got ${typeof step.reps}`
        );
      }
      if (step.reps <= 0) {
        throw new Error(
          `Step ${stepIndex}: Field 'reps' must be positive, got ${step.reps}`
        );
      }
    }

    // Duration validation
    if (step.durationSeconds !== undefined) {
      if (typeof step.durationSeconds !== "number") {
        throw new Error(
          `Step ${stepIndex}: Field 'durationSeconds' must be a number, got ${typeof step.durationSeconds}`
        );
      }
      if (step.durationSeconds <= 0) {
        throw new Error(
          `Step ${stepIndex}: Field 'durationSeconds' must be positive, got ${step.durationSeconds}`
        );
      }
    }

    // Distance validation
    if (step.distanceMeters !== undefined) {
      if (typeof step.distanceMeters !== "number") {
        throw new Error(
          `Step ${stepIndex}: Field 'distanceMeters' must be a number, got ${typeof step.distanceMeters}`
        );
      }
      if (step.distanceMeters <= 0) {
        throw new Error(
          `Step ${stepIndex}: Field 'distanceMeters' must be positive, got ${step.distanceMeters}`
        );
      }
    }

    // Rest time validation
    if (step.restTimeSeconds !== undefined) {
      if (typeof step.restTimeSeconds !== "number") {
        throw new Error(
          `Step ${stepIndex}: Field 'restTimeSeconds' must be a number, got ${typeof step.restTimeSeconds}`
        );
      }
      if (step.restTimeSeconds < 0) {
        throw new Error(
          `Step ${stepIndex}: Field 'restTimeSeconds' cannot be negative, got ${step.restTimeSeconds}`
        );
      }
    }

    // Number of repeats validation
    if (step.numberOfRepeats !== undefined) {
      if (typeof step.numberOfRepeats !== "number") {
        throw new Error(
          `Step ${stepIndex}: Field 'numberOfRepeats' must be a number, got ${typeof step.numberOfRepeats}`
        );
      }
      if (step.numberOfRepeats <= 0) {
        throw new Error(
          `Step ${stepIndex}: Field 'numberOfRepeats' must be positive, got ${step.numberOfRepeats}`
        );
      }
    }

    // Field interdependency: if endCondition is 'reps', reps field should match
    if (step.endCondition === "reps" && step.reps !== undefined && step.reps !== step.endConditionValue) {
      throw new Error(
        `Step ${stepIndex}: Mismatch between 'reps' (${step.reps}) and 'endConditionValue' (${step.endConditionValue})`
      );
    }

    // Field interdependency: if endCondition is 'time', durationSeconds should match
    if (step.endCondition === "time" && step.durationSeconds !== undefined && step.durationSeconds !== step.endConditionValue) {
      throw new Error(
        `Step ${stepIndex}: Mismatch between 'durationSeconds' (${step.durationSeconds}) and 'endConditionValue' (${step.endConditionValue})`
      );
    }

    // Field interdependency: if endCondition is 'distance', distanceMeters should match
    if (step.endCondition === "distance" && step.distanceMeters !== undefined && step.distanceMeters !== step.endConditionValue) {
      throw new Error(
        `Step ${stepIndex}: Mismatch between 'distanceMeters' (${step.distanceMeters}) and 'endConditionValue' (${step.endConditionValue})`
      );
    }
  }

  /**
   * Strict validation for a single workout
   * Throws immediately on validation errors
   */
  private validateWorkout(workout: DetailedWorkout): void {
    // Required: workoutName
    if (!workout.workoutName || typeof workout.workoutName !== "string") {
      throw new Error(
        `Invalid workout: Missing or invalid 'workoutName'`
      );
    }

    // Required: steps array (can be empty, but must exist)
    if (!workout.steps || !Array.isArray(workout.steps)) {
      throw new Error(
        `Invalid workout '${workout.workoutName}': Missing or invalid 'steps' array`
      );
    }

    // Validate each step
    workout.steps.forEach((step, index) => {
      try {
        this.validateWorkoutStep(step, index + 1);
      } catch (error: any) {
        throw new Error(
          `Workout '${workout.workoutName}': ${error.message}`
        );
      }
    });
  }

  /**
   * Validate multiple workouts for upload and collect all errors
   * Returns array of error messages (empty if all valid)
   */
  private validateWorkoutsForUpload(workouts: DetailedWorkout[]): string[] {
    const errors: string[] = [];

    workouts.forEach((workout, index) => {
      try {
        this.validateWorkout(workout);
      } catch (error: any) {
        errors.push(`Workout ${index + 1}: ${error.message}`);
      }
    });

    return errors;
  }

  /**
   * Get the start and end of next week (Monday-Sunday) in UTC
   */
  private getNextWeekDates(): { weekStart: Date; weekEnd: Date } {
    // Work in UTC for consistency
    const now = new Date();
    const utcDay = now.getUTCDay();
    const daysSinceMonday = utcDay === 0 ? 6 : utcDay - 1;

    // Start of current week in UTC
    const weekStart = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() - daysSinceMonday);
    weekStart.setUTCHours(0, 0, 0, 0);

    // Next week start
    const nextWeekStart = new Date(weekStart);
    nextWeekStart.setUTCDate(weekStart.getUTCDate() + 7);

    // Next week end
    const nextWeekEnd = new Date(nextWeekStart);
    nextWeekEnd.setUTCDate(nextWeekStart.getUTCDate() + 6);
    nextWeekEnd.setUTCHours(23, 59, 59, 999);

    return { weekStart: nextWeekStart, weekEnd: nextWeekEnd };
  }

  private shiftDate(dateString: string, days: number): string {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) {
      return dateString;
    }

    date.setDate(date.getDate() + days);
    return date.toISOString().split("T")[0];
  }

  private validateWorkoutPlan(plan: WeeklyWorkoutPlan): void {
    if (
      !plan ||
      !plan.weekStart ||
      !plan.weekEnd ||
      !Array.isArray(plan.workouts)
    ) {
      throw new Error(
        "Invalid workout plan: missing weekStart, weekEnd, or workouts"
      );
    }

    plan.workouts.forEach((workout, index) => {
      if (!workout.workoutName) {
        throw new Error(
          `Invalid workout plan: workout name missing at index ${index}`
        );
      }
    });
  }

  /**
   * Format exercise name from Garmin subcategory (e.g., "BARBELL_BENCH_PRESS" -> "Barbell Bench Press")
   */
  private formatExerciseName(subcategoryKey: string | undefined): string {
    if (!subcategoryKey) return "Unknown Exercise";
    return subcategoryKey
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
  }

  /**
   * Convert Garmin weight to lbs
   * If weightUnit is already in pounds, return as-is (rounded)
   * Otherwise, assume weight is in grams and convert: weight_lbs = weight / 453.59237
   */
  private convertGarminWeight(weightValue: number, weightUnit?: { unitKey?: string; factor?: number }): number {
    if (weightValue === 0) return 0;
    
    // If already in pounds, just round
    if (weightUnit?.unitKey === "pound") {
      return Math.round(weightValue);
    }
    
    // Otherwise assume grams and convert to lbs
    return Math.round(weightValue / 453.59237);
  }

  /**
   * Transform raw Garmin workout steps to structured format
   * Recursively flattens RepeatGroupDTO steps, merges rest into exercises,
   * converts weights to lbs, and extracts parallel fields
   */
  private transformWorkoutSteps(steps: IWorkoutStep[]): WorkoutStep[] {
    if (!steps || !Array.isArray(steps)) {
      return [];
    }

    // First pass: recursively flatten all steps (including nested RepeatGroupDTO)
    const flattenedSteps = this.flattenSteps(steps);

    // Second pass: merge first rest step into preceding exercise
    const mergedSteps = this.mergeRestIntoExercises(flattenedSteps);

    // Third pass: renumber stepOrder sequentially
    mergedSteps.forEach((step, index) => {
      step.stepOrder = index + 1;
    });

    return mergedSteps;
  }

  /**
   * Recursively flatten workout steps, expanding RepeatGroupDTO nested structures
   */
  private flattenSteps(steps: any[]): WorkoutStep[] {
    const flattened: WorkoutStep[] = [];

    for (const step of steps) {
      // Check if this is a RepeatGroupDTO
      if (step.type === "RepeatGroupDTO" && step.workoutSteps && Array.isArray(step.workoutSteps)) {
        // Extract numberOfIterations
        const numberOfRepeats = step.numberOfIterations;

        // Recursively flatten nested steps
        const nestedSteps = this.flattenSteps(step.workoutSteps);

        // Add numberOfRepeats to each nested step
        nestedSteps.forEach((nestedStep) => {
          nestedStep.numberOfRepeats = numberOfRepeats;
        });

        flattened.push(...nestedSteps);
      } else {
        // Regular ExecutableStepDTO - transform to WorkoutStep
        const workoutStep = this.transformSingleStep(step);
        flattened.push(workoutStep);
      }
    }

    return flattened;
  }

  /**
   * Transform a single workout step (ExecutableStepDTO)
   */
  private transformSingleStep(step: any): WorkoutStep {
    const workoutStep: WorkoutStep = {
      stepType: step.stepType?.stepTypeKey || "exercise",
    };

    // Exercise fields
    if (step.exerciseName) {
      workoutStep.exerciseName = step.exerciseName;
    }

    // Target information
    if (step.targetType?.workoutTargetTypeKey) {
      workoutStep.targetType = step.targetType.workoutTargetTypeKey;
    }

    // Target values (for pace, HR, power, etc.)
    // Only include if non-zero or if there's a meaningful targetType
    const hasMeaningfulTarget = workoutStep.targetType && workoutStep.targetType !== "no.target";
    
    if (step.targetValueOne !== null && step.targetValueOne !== undefined) {
      // Include if non-zero OR if there's a meaningful target type
      if (step.targetValueOne !== 0 || hasMeaningfulTarget) {
        workoutStep.targetValueOne = step.targetValueOne;
      }
    }

    if (step.targetValueTwo !== null && step.targetValueTwo !== undefined) {
      // Include if non-zero OR if there's a meaningful target type
      if (step.targetValueTwo !== 0 || hasMeaningfulTarget) {
        workoutStep.targetValueTwo = step.targetValueTwo;
      }
    }

    // End condition (how the step ends)
    if (step.endCondition?.conditionTypeKey) {
      workoutStep.endCondition = step.endCondition.conditionTypeKey;
    }

    if (step.endConditionValue !== null && step.endConditionValue !== undefined) {
      workoutStep.endConditionValue = step.endConditionValue;

      // Extract parallel fields based on endCondition type
      if (workoutStep.endCondition === "reps") {
        workoutStep.reps = step.endConditionValue;
      } else if (workoutStep.endCondition === "time") {
        workoutStep.durationSeconds = step.endConditionValue;
      } else if (workoutStep.endCondition === "distance") {
        workoutStep.distanceMeters = step.endConditionValue;
      }
    }

    // Weight/Equipment - convert to lbs
    if (step.weightValue !== null && step.weightValue !== undefined) {
      workoutStep.weight = this.convertGarminWeight(step.weightValue, step.weightUnit);
    }

    // Weight percentage (for percentage-based programming like "75% of 1RM")
    // Check both weightDisplayUnit (old format) and benchmarkPercentage (Garmin's 1RM tracking)
    if (step.weightDisplayUnit?.unitKey === "percent" && step.weightValue !== null && step.weightValue !== undefined) {
      workoutStep.weightPercentage = step.weightValue;
    } else if (step.benchmarkPercentage !== null && step.benchmarkPercentage !== undefined) {
      workoutStep.weightPercentage = step.benchmarkPercentage;
      if (step.benchmarkKey) {
        workoutStep.benchmarkKey = step.benchmarkKey;
      }
    }

    // Step ordering (will be renumbered later)
    workoutStep.stepOrder = step.stepOrder;

    return workoutStep;
  }

  /**
   * Merge first rest step into preceding exercise as restTimeSeconds
   */
  private mergeRestIntoExercises(steps: WorkoutStep[]): WorkoutStep[] {
    const merged: WorkoutStep[] = [];
    let i = 0;

    while (i < steps.length) {
      const currentStep = steps[i];

      // Check if next step is a rest step
      if (i + 1 < steps.length && steps[i + 1].stepType === "rest") {
        const restStep = steps[i + 1];

        // Merge rest time into current step
        if (restStep.durationSeconds !== undefined) {
          currentStep.restTimeSeconds = restStep.durationSeconds;
        } else if (restStep.endConditionValue !== undefined) {
          currentStep.restTimeSeconds = restStep.endConditionValue;
        }

        // Add current step with merged rest
        merged.push(currentStep);

        // Skip the rest step (it's been merged)
        i += 2;
      } else {
        // No rest to merge, add step as-is
        merged.push(currentStep);
        i++;
      }
    }

    return merged;
  }

  /**
   * Fetch detailed workout information from Garmin
   */
  async fetchWorkoutDetails(workoutId: number | string): Promise<IWorkoutDetail | null> {
    try {
      const client = this.garminClient.getClientAny();

      const details = await client.getWorkoutDetail?.({
        workoutId: String(workoutId),
      });

      if (!details) {
        console.warn(
          `⚠️  No workout details found for ${workoutId}`
        );
        return null;
      }

      return details;
    } catch (error: any) {
      console.warn(
        `⚠️  Failed to fetch workout details for ${workoutId}: ${error.message}`
      );
      return null;
    }
  }

  /**
   * Fetch and transform workouts in a single session
   * Returns both raw and transformed data
   */
  async fetchWorkoutsWithRaw(includeDetails: boolean = true): Promise<{
    transformed: DetailedWorkout[];
    raw: any[];
  }> {
    try {
      console.log("📥 Fetching workouts from Garmin...");

      // Use mock data if in mock mode
      if (this.garminClient.isMockMode()) {
        const { generateMockWorkouts } = await import("./mocks.setup");
        const mockWorkouts = generateMockWorkouts(10);
        
        console.log(`✅ Retrieved ${mockWorkouts.length} mock workouts`);
        
        const detailedWorkouts: DetailedWorkout[] = [];
        const rawWorkouts: any[] = mockWorkouts;

        for (const workout of mockWorkouts) {
          let steps: WorkoutStep[] = [];

          if (workout.workoutSegments && Array.isArray(workout.workoutSegments)) {
            workout.workoutSegments.forEach((segment: any) => {
              if (segment.workoutSteps && Array.isArray(segment.workoutSteps)) {
                const segmentSteps = this.transformWorkoutSteps(segment.workoutSteps);
                steps.push(...segmentSteps);
              }
            });
          }

          detailedWorkouts.push({
            workoutId: workout.workoutId,
            workoutName: workout.workoutName || "Unnamed Workout",
            workoutType: workout.sportType?.sportTypeKey,
            description: workout.description,
            steps: steps.length > 0 ? steps : undefined,
          });
        }

        return {
          transformed: detailedWorkouts,
          raw: rawWorkouts,
        };
      }

      const authenticated = await this.garminClient.ensureAuthenticated();
      if (!authenticated) {
        throw new Error("Failed to authenticate with Garmin");
      }

      const client = this.garminClient.getClientAny();
      const workouts = await client.getWorkouts?.(0, 100);
      if (!workouts) {
        throw new Error("getWorkouts is not available on this Garmin client");
      }

      console.log(`✅ Retrieved ${workouts.length} workouts`);

      const detailedWorkouts: DetailedWorkout[] = [];
      const rawWorkouts: any[] = [];

      if (includeDetails) {
        console.log(
          `📋 Fetching detailed info for ${workouts.length} workouts...`
        );

        for (let i = 0; i < workouts.length; i++) {
          try {
            const workout = workouts[i];
            const details = await this.fetchWorkoutDetails(workout.workoutId);

            // Store raw details
            rawWorkouts.push({
              ...workout,
              ...(details || {}),
            });

            // Transform and store
            let steps: WorkoutStep[] = [];
            let totalSets = 0;
            let totalReps = 0;
            let estimatedDurationSeconds = 0;

            if (details && details.workoutSegments) {
              // Process all steps from all segments
              details.workoutSegments.forEach((segment: IWorkoutSegment) => {
                if (segment.workoutSteps && Array.isArray(segment.workoutSteps)) {
                  const segmentSteps = this.transformWorkoutSteps(segment.workoutSteps);
                  steps.push(...segmentSteps);

                  // Calculate totals from steps
                  segmentSteps.forEach((step) => {
                    if (step.targetValueOne) {
                      if (step.endCondition === 'rep') totalReps += step.targetValueOne;
                      if (step.endCondition === 'time') estimatedDurationSeconds += step.targetValueOne;
                    }
                  });
                }
              });
            }

            detailedWorkouts.push({
              workoutId: workout.workoutId,
              workoutName: workout.workoutName || "Unnamed Workout",
              workoutType: workout.sportType?.sportTypeKey,
              description: workout.description,
              steps: steps.length > 0 ? steps : undefined,
              totalSets: totalSets || undefined,
              totalReps: totalReps || undefined,
              estimatedDurationSeconds: details?.estimatedDurationInSecs || undefined,
            });

            console.log(
              `  ✓ ${i + 1}/${workouts.length}: ${workout.workoutName}`
            );

            // Add delay to avoid rate limiting
            if (i < workouts.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          } catch (error: any) {
            console.warn(
              `  ⚠️  Could not fetch full details for workout ${workouts[i].workoutId}: ${error.message}`
            );
            // Add basic info even if details failed
            rawWorkouts.push(workouts[i]);
            detailedWorkouts.push({
              workoutId: workouts[i].workoutId,
              workoutName: workouts[i].workoutName || "Unnamed Workout",
              workoutType: workouts[i].sportType?.sportTypeKey,
              description: workouts[i].description,
            });
          }
        }
      } else {
        // No detailed fetch, just return basic info
        detailedWorkouts.push(
          ...workouts.map((workout: any) => ({
            workoutId: workout.workoutId,
            workoutName: workout.workoutName || "Unnamed Workout",
            workoutType: workout.sportType?.sportTypeKey,
            description: workout.description,
          }))
        );
        rawWorkouts.push(...workouts);
      }

      return {
        transformed: detailedWorkouts,
        raw: rawWorkouts,
      };
    } catch (error: any) {
      console.error("❌ Failed to fetch workouts:", error.message);
      return {
        transformed: [],
        raw: [],
      };
    }
  }

  /**
   * Fetch raw workouts from Garmin (before transformation)
   */
  async fetchRawWorkouts(includeDetails: boolean = true): Promise<any[]> {
    const result = await this.fetchWorkoutsWithRaw(includeDetails);
    return result.raw;
  }

  /**
   * Fetch workouts from Garmin with full exercise details
   */
  async fetchWorkouts(includeDetails: boolean = true): Promise<DetailedWorkout[]> {
    const result = await this.fetchWorkoutsWithRaw(includeDetails);
    return result.transformed;
  }

  /**
   * Export workouts with full details to JSON file
   */
  async exportWorkouts(
    outputPath: string = "./data/workouts.json",
    includeDetails: boolean = true,
    saveRaw: boolean = false
  ): Promise<void> {
    // Fetch both raw and transformed in a single session
    const result = await this.fetchWorkoutsWithRaw(includeDetails);
    const transformedWorkouts = result.transformed;
    const rawWorkouts = result.raw;

    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Save transformed data
    fs.writeFileSync(outputPath, JSON.stringify(transformedWorkouts, null, 2));
    console.log(`✅ Workouts saved to ${outputPath}`);

    // Optionally save raw data for debugging
    if (saveRaw) {
      const rawPath = outputPath.replace(".json", "-raw.json");
      fs.writeFileSync(rawPath, JSON.stringify(rawWorkouts, null, 2));
      console.log(`📋 Raw workouts saved to ${rawPath}`);
    }
  }

  /**
   * Transform a single raw workout into DetailedWorkout format
   * @param workout - Raw workout from Garmin API
   */
  private transformSingleWorkout(workout: any): DetailedWorkout {
    let steps: WorkoutStep[] = [];
    let totalSets = 0;
    let totalReps = 0;
    let estimatedDurationSeconds = 0;

    if (workout.workoutSegments && Array.isArray(workout.workoutSegments)) {
      // Process all steps from all segments
      workout.workoutSegments.forEach((segment: IWorkoutSegment) => {
        if (segment.workoutSteps && Array.isArray(segment.workoutSteps)) {
          const segmentSteps = this.transformWorkoutSteps(segment.workoutSteps);
          steps.push(...segmentSteps);

          // Calculate totals from steps
          segmentSteps.forEach((step) => {
            if (step.targetValueOne) {
              if (step.endCondition === 'rep') totalReps += step.targetValueOne;
              if (step.endCondition === 'time') estimatedDurationSeconds += step.targetValueOne;
            }
          });
        }
      });
    }

    return {
      workoutId: workout.workoutId,
      workoutName: workout.workoutName || "Unnamed Workout",
      workoutType: workout.sportType?.sportTypeKey,
      description: workout.description,
      steps: steps.length > 0 ? steps : undefined,
      totalSets: totalSets || undefined,
      totalReps: totalReps || undefined,
      estimatedDurationSeconds: workout.estimatedDurationInSecs || undefined,
    };
  }

  /**
   * Transform raw workouts array to DetailedWorkout format
   * @param rawWorkouts - Array of raw workouts from Garmin API
   */
  private transformWorkouts(rawWorkouts: any[]): DetailedWorkout[] {
    return rawWorkouts.map((workout) => this.transformSingleWorkout(workout));
  }

  /**
   * Load raw workouts from a JSON file
   */
  async loadRawWorkoutsFromFile(inputPath: string): Promise<any[]> {
    try {
      const raw = fs.readFileSync(inputPath, "utf-8");
      const data = JSON.parse(raw);

      // If it's an array, return it
      if (Array.isArray(data)) {
        return data;
      }

      // If it's an object with workouts array, extract it
      if (data.workouts && Array.isArray(data.workouts)) {
        return data.workouts;
      }

      throw new Error("Invalid raw workouts file format");
    } catch (error: any) {
      console.error(`❌ Failed to load raw workouts from ${inputPath}:`, error.message);
      throw error;
    }
  }

  /**
   * Transform raw workouts and save to file without fetching from Garmin
   * Useful for re-running transformation logic on previously saved raw data
   * @param inputPath - Path to raw workouts JSON file
   * @param outputPath - Output file path for transformed workouts
   */
  async transformAndSaveWorkouts(
    inputPath: string,
    outputPath?: string
  ): Promise<boolean> {
    try {
      console.log("📂 Loading raw workouts from file...");
      const rawWorkouts = await this.loadRawWorkoutsFromFile(inputPath);

      if (rawWorkouts.length === 0) {
        console.warn("⚠️  No workouts found in file");
        return false;
      }

      console.log(`📊 Transforming ${rawWorkouts.length} workouts...`);
      const transformed = this.transformWorkouts(rawWorkouts);

      const outPath = outputPath || inputPath.replace("-raw.json", ".json");

      // Ensure directory exists
      const dir = path.dirname(outPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(outPath, JSON.stringify(transformed, null, 2));
      console.log(`✅ Transformed workouts saved to ${outPath}`);
      return true;
    } catch (error: any) {
      console.error("❌ Transform failed:", error.message);
      return false;
    }
  }

  /**
   * Generate next week's workout plan template with all workout details
   */
  async generateNextWeekPlanTemplate(
    outputPath: string = "./data/next-week.workouts.tmp.json"
  ): Promise<void> {
    const workouts = await this.fetchWorkouts(true);
    const { weekStart, weekEnd } = this.getNextWeekDates();

    const plan: WeeklyWorkoutPlan = {
      generatedAt: new Date().toISOString(),
      weekStart: weekStart.toISOString().split("T")[0],
      weekEnd: weekEnd.toISOString().split("T")[0],
      source: "garmin-workouts-template",
      workouts: workouts.map((workout) => ({
        workoutId: workout.workoutId,
        workoutName: workout.workoutName,
        workoutType: workout.workoutType,
        description: workout.description,
        steps: workout.steps,
        scheduledDate: undefined,
      })),
    };

    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(plan, null, 2));
    console.log(`✅ Next-week workout template saved to ${outputPath}`);
  }

  /**
   * Import workout plan from JSON file
   */
  async importWorkoutPlan(inputPath: string): Promise<WeeklyWorkoutPlan> {
    const raw = fs.readFileSync(inputPath, "utf-8");
    const plan = JSON.parse(raw) as WeeklyWorkoutPlan;
    this.validateWorkoutPlan(plan);
    return plan;
  }

  /**
   * Copy a workout plan to next week (shift dates by 7 days)
   */
  async copyWorkoutPlanToNextWeek(
    inputPath: string,
    outputPath: string = "./data/next-week.workouts.tmp.json"
  ): Promise<void> {
    const plan = await this.importWorkoutPlan(inputPath);
    const shifted: WeeklyWorkoutPlan = {
      ...plan,
      generatedAt: new Date().toISOString(),
      weekStart: this.shiftDate(plan.weekStart, 7),
      weekEnd: this.shiftDate(plan.weekEnd, 7),
      source: "copy-last-week",
      workouts: plan.workouts.map((workout) => ({
        ...workout,
        scheduledDate: workout.scheduledDate
          ? this.shiftDate(workout.scheduledDate, 7)
          : undefined,
      })),
    };

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(shifted, null, 2));
    console.log(`✅ Next-week workout plan saved to ${outputPath}`);
  }

  /**
   * Schedule workouts from a plan on Garmin calendar
   */
  async scheduleWorkoutPlan(plan: WeeklyWorkoutPlan): Promise<void> {
    const authenticated = await this.garminClient.ensureAuthenticated();
    if (!authenticated) {
      throw new Error("Failed to authenticate with Garmin");
    }

    this.validateWorkoutPlan(plan);

    const client = this.garminClient.getClientAny();
    if (!client.scheduleWorkout) {
      throw new Error("scheduleWorkout is not available on this Garmin client");
    }

    for (const workout of plan.workouts) {
      if (!workout.scheduledDate) {
        console.warn(
          `⚠️  Skipping workout without scheduledDate: ${workout.workoutName}`
        );
        continue;
      }

      const scheduleDate = new Date(workout.scheduledDate);
      if (Number.isNaN(scheduleDate.getTime())) {
        console.warn(
          `⚠️  Invalid scheduledDate for workout: ${workout.workoutName}`
        );
        continue;
      }

      let workoutId = workout.workoutId;

      if (
        !workoutId &&
        workout.workoutType === "running" &&
        workout.distanceMeters
      ) {
        try {
          const created = await client.addRunningWorkout?.(
            workout.workoutName,
            workout.distanceMeters,
            workout.description || ""
          );
          workoutId = created?.workoutId;
        } catch (error: any) {
          console.warn(
            `⚠️  Failed to create running workout: ${workout.workoutName} (${error.message})`
          );
          continue;
        }
      }

      if (!workoutId) {
        console.warn(
          `⚠️  Missing workoutId for workout: ${workout.workoutName}`
        );
        continue;
      }

      try {
        await client.scheduleWorkout({ workoutId }, scheduleDate);
        console.log(
          `✅ Scheduled workout: ${workout.workoutName} on ${workout.scheduledDate}`
        );
      } catch (error: any) {
        console.warn(
          `⚠️  Failed to schedule workout: ${workout.workoutName} (${error.message})`
        );
      }
    }
  }

  /**
   * Add workouts to Garmin calendar from imported plan
   * This is an alias for scheduleWorkoutPlan for clarity
   */
  async addToCalendar(plan: WeeklyWorkoutPlan): Promise<void> {
    return this.scheduleWorkoutPlan(plan);
  }

  /**
   * Convert weight from lbs back to grams (reverse of convertGarminWeight)
   */
  private convertWeightToGrams(weightLbs: number): number {
    return Math.round(weightLbs * 453.59237);
  }

  /**
   * Unflatten workout steps: reverse the merge and flatten operations
   * 1. Split merged restTimeSeconds back into separate rest steps
   * 2. Rebuild RepeatGroupDTO structures using numberOfRepeats
   */
  private unflattenSteps(steps: WorkoutStep[]): any[] {
    const unflattened: any[] = [];
    
    // Group steps by numberOfRepeats to rebuild RepeatGroupDTO
    const groupedSteps: WorkoutStep[][] = [];
    let currentGroup: WorkoutStep[] = [];
    let currentRepeats: number | undefined = undefined;

    for (const step of steps) {
      // If this step has a different numberOfRepeats, start a new group
      if (step.numberOfRepeats !== currentRepeats) {
        if (currentGroup.length > 0) {
          groupedSteps.push(currentGroup);
        }
        currentGroup = [step];
        currentRepeats = step.numberOfRepeats;
      } else {
        currentGroup.push(step);
      }
    }
    
    // Add final group
    if (currentGroup.length > 0) {
      groupedSteps.push(currentGroup);
    }

    // Process each group
    for (const group of groupedSteps) {
      const firstStep = group[0];
      const numberOfRepeats = firstStep.numberOfRepeats;

      // Convert steps in group to Garmin format
      const garminSteps: any[] = [];
      
      for (const step of group) {
        // Convert the main step
        const garminStep = this.convertStepToGarminFormat(step);
        garminSteps.push(garminStep);

        // If step has merged rest time, add it as a separate rest step
        if (step.restTimeSeconds !== undefined && step.restTimeSeconds > 0) {
          const restStep = {
            type: "ExecutableStepDTO",
            stepId: null,
            stepOrder: null,
            childStepId: null,
            description: null,
            stepType: {
              stepTypeId: 3, // rest
              stepTypeKey: "rest",
            },
            endCondition: {
              conditionTypeId: 2, // time
              conditionTypeKey: "time",
            },
            endConditionValue: step.restTimeSeconds,
            preferredEndConditionUnit: null,
            targetType: {
              workoutTargetTypeId: 1, // no target
              workoutTargetTypeKey: "no.target",
            },
            targetValueOne: null,
            targetValueTwo: null,
            zoneNumber: null,
            secondaryTargetType: null,
            secondaryTargetValueOne: null,
            secondaryTargetValueTwo: null,
            secondaryZoneNumber: null,
          };
          garminSteps.push(restStep);
        }
      }

      // If group has numberOfRepeats, wrap in RepeatGroupDTO
      if (numberOfRepeats !== undefined && numberOfRepeats > 1) {
        unflattened.push({
          type: "RepeatGroupDTO",
          repeatGroupId: null,
          numberOfIterations: numberOfRepeats,
          smartRepeat: false,
          childStepId: null,
          workoutSteps: garminSteps,
        });
      } else {
        // No repeats, add steps directly
        unflattened.push(...garminSteps);
      }
    }

    return unflattened;
  }

  /**
   * Convert a WorkoutStep back to Garmin ExecutableStepDTO format
   */
  private convertStepToGarminFormat(step: WorkoutStep): any {
    const garminStep: any = {
      type: "ExecutableStepDTO",
      stepId: null,
      stepOrder: step.stepOrder || null,
      childStepId: null,
      description: null,
      stepType: {
        stepTypeId: this.getStepTypeId(step.stepType),
        stepTypeKey: step.stepType,
      },
      endCondition: step.endCondition ? {
        conditionTypeId: this.getEndConditionId(step.endCondition),
        conditionTypeKey: step.endCondition,
      } : null,
      endConditionValue: step.endConditionValue !== undefined ? step.endConditionValue : null,
      preferredEndConditionUnit: null,
      targetType: {
        workoutTargetTypeId: this.getTargetTypeId(step.targetType || "no.target"),
        workoutTargetTypeKey: step.targetType || "no.target",
      },
      targetValueOne: step.targetValueOne !== undefined ? step.targetValueOne : null,
      targetValueTwo: step.targetValueTwo !== undefined ? step.targetValueTwo : null,
      zoneNumber: null,
      secondaryTargetType: null,
      secondaryTargetValueOne: null,
      secondaryTargetValueTwo: null,
      secondaryZoneNumber: null,
    };

    // Add exercise name if present
    if (step.exerciseName) {
      garminStep.exerciseName = step.exerciseName;
    }

    // Add weight if present (convert back to grams)
    if (step.weight !== undefined && step.weight > 0) {
      garminStep.weightValue = this.convertWeightToGrams(step.weight);
      garminStep.weightUnit = {
        unitId: 11, // grams
        unitKey: "gram",
        factor: 1,
      };
    }

    // Add weight percentage if present
    if (step.weightPercentage !== undefined) {
      garminStep.benchmarkPercentage = step.weightPercentage;
      if (step.benchmarkKey) {
        garminStep.benchmarkKey = step.benchmarkKey;
      }
    }

    return garminStep;
  }

  /**
   * Get Garmin stepTypeId from stepType key
   */
  private getStepTypeId(stepTypeKey: string): number {
    const mapping: { [key: string]: number } = {
      warmup: 1,
      cooldown: 2,
      interval: 3,
      recovery: 4,
      rest: 3,
      exercise: 6,
      repeat: 7,
      other: 8,
    };
    return mapping[stepTypeKey] || 6; // default to exercise
  }

  /**
   * Get Garmin endConditionId from endCondition key
   */
  private getEndConditionId(endConditionKey: string): number {
    const mapping: { [key: string]: number } = {
      "lap.button": 1,
      time: 2,
      distance: 3,
      calories: 4,
      "heart.rate": 5,
      reps: 6,
      iterations: 7,
    };
    return mapping[endConditionKey] || 1;
  }

  /**
   * Get Garmin targetTypeId from targetType key
   */
  private getTargetTypeId(targetTypeKey: string): number {
    const mapping: { [key: string]: number } = {
      "no.target": 1,
      "heart.rate.zone": 2,
      "pace.zone": 3,
      "speed.zone": 4,
      "power.zone": 6,
      "cadence.zone": 7,
      open: 8,
    };
    return mapping[targetTypeKey] || 1; // default to no.target
  }

  /**
   * Build Garmin IWorkoutDetail from DetailedWorkout
   */
  private buildGarminWorkoutDetail(workout: DetailedWorkout): IWorkoutDetail {
    const garminSteps = workout.steps ? this.unflattenSteps(workout.steps) : [];

    const workoutDetail: IWorkoutDetail = {
      workoutId: workout.workoutId ? Number(workout.workoutId) : undefined,
      workoutName: workout.workoutName,
      description: workout.description || undefined,
      updateDate: new Date(),
      createdDate: new Date(),
      sportType: workout.workoutType ? {
        sportTypeId: this.getSportTypeId(workout.workoutType),
        sportTypeKey: workout.workoutType,
      } : {
        sportTypeId: 1,
        sportTypeKey: "running",
      },
      trainingPlanId: null,
      author: {
        userProfilePk: null,
        displayName: null,
        fullName: null,
        profileImgNameLarge: null,
        profileImgNameMedium: null,
        profileImgNameSmall: null,
        userPro: false,
        vivokidUser: false,
      },
      estimatedDurationInSecs: workout.estimatedDurationSeconds || 0,
      estimatedDistanceInMeters: null,
      estimateType: null,
      estimatedDistanceUnit: {
        unitId: null,
        unitKey: null,
        factor: null,
      },
      poolLength: 0,
      poolLengthUnit: {
        unitId: null,
        unitKey: null,
        factor: null,
      },
      workoutProvider: "",
      workoutSourceId: "",
      consumer: null,
      atpPlanId: null,
      workoutNameI18nKey: null,
      descriptionI18nKey: null,
      shared: false,
      estimated: false,
      workoutSegments: [
        {
          segmentOrder: 1,
          sportType: workout.workoutType ? {
            sportTypeId: this.getSportTypeId(workout.workoutType),
            sportTypeKey: workout.workoutType,
          } : {
            sportTypeId: 1,
            sportTypeKey: "running",
          },
          workoutSteps: garminSteps,
        },
      ],
    };

    return workoutDetail;
  }

  /**
   * Get Garmin sportTypeId from workout type key
   */
  private getSportTypeId(workoutTypeKey: string): number {
    const mapping: { [key: string]: number } = {
      running: 1,
      cycling: 2,
      cardio: 3,
      strength_training: 13,
      swimming: 5,
      other: 0,
    };
    return mapping[workoutTypeKey] || 0;
  }

  /**
   * Upload a single workout to Garmin (delete existing if present, then create new)
   */
  async uploadWorkout(workout: DetailedWorkout, dryRun: boolean = false): Promise<boolean> {
    // Validate workout first
    try {
      this.validateWorkout(workout);
    } catch (error: any) {
      console.error(`❌ Validation failed: ${error.message}`);
      return false;
    }

    if (dryRun) {
      console.log(`\n  🔍 Would upload: ${workout.workoutName}`);
      console.log(`     ID: ${workout.workoutId || "NEW (will be created)"}`);
      console.log(`     Type: ${workout.workoutType || "N/A"}`);
      if (workout.steps && workout.steps.length > 0) {
        console.log(`     Steps: ${workout.steps.length} exercises`);
        workout.steps.slice(0, 3).forEach((step, i) => {
          console.log(`       ${i + 1}. ${step.exerciseName || step.stepType}`);
        });
        if (workout.steps.length > 3) {
          console.log(`       ... and ${workout.steps.length - 3} more`);
        }
      }
      return true;
    }

    // Authenticate
    const authenticated = await this.garminClient.ensureAuthenticated();
    if (!authenticated) {
      throw new Error("Failed to authenticate with Garmin");
    }

    const client = this.garminClient.getClientAny();

    try {
      // Delete existing workout if it has an ID
      if (workout.workoutId) {
        console.log(`  🗑️  Deleting existing workout: ${workout.workoutName} (ID: ${workout.workoutId})`);
        
        if (client.deleteWorkout) {
          await client.deleteWorkout({ workoutId: String(workout.workoutId) });
          console.log(`     ✓ Deleted`);
        } else {
          console.warn(`     ⚠️  deleteWorkout not available, skipping delete`);
        }
      }

      // Transform to Garmin format
      const garminWorkout = this.buildGarminWorkoutDetail(workout);

      // Create new workout
      console.log(`  📤 Creating workout: ${workout.workoutName}`);
      
      if (!client.createWorkout) {
        throw new Error("createWorkout is not available on this Garmin client");
      }

      const created = await client.createWorkout(garminWorkout);
      
      console.log(`     ✅ Created (New ID: ${created.workoutId})`);
      console.log(`     💡 Run --export to sync new IDs back to your local file`);
      
      return true;
    } catch (error: any) {
      console.error(`     ❌ Upload failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Upload multiple workouts from file with batch processing
   * Continues on failures and returns summary
   */
  async uploadWorkoutsFromFile(
    inputPath: string,
    dryRun: boolean = false
  ): Promise<{ successful: number; failed: number; failedWorkouts: string[] }> {
    console.log(`📂 Loading workouts from ${inputPath}...`);

    // Load workouts
    const fileContent = fs.readFileSync(inputPath, "utf-8");
    const data = JSON.parse(fileContent);
    
    let workouts: DetailedWorkout[] = [];
    
    // Handle both direct array and WeeklyWorkoutPlan wrapper
    if (Array.isArray(data)) {
      workouts = data;
    } else if (data.workouts && Array.isArray(data.workouts)) {
      workouts = data.workouts;
    } else {
      throw new Error("Invalid file format: expected array of workouts or WeeklyWorkoutPlan");
    }

    console.log(`📊 Found ${workouts.length} workouts\n`);

    if (dryRun) {
      console.log("🔍 DRY-RUN MODE: Validating workouts without uploading\n");
      
      // Validate all workouts and collect errors
      const errors = this.validateWorkoutsForUpload(workouts);
      
      if (errors.length > 0) {
        console.error("❌ Validation errors:\n");
        errors.forEach((error) => console.error(`   ${error}`));
        throw new Error(`Validation failed with ${errors.length} error(s)`);
      }
      
      console.log("📋 All workouts are valid. Preview:\n");
      
      // Show preview of each workout
      for (let i = 0; i < workouts.length; i++) {
        await this.uploadWorkout(workouts[i], true);
      }
      
      console.log("\n✅ Validation passed - all workouts ready to upload");
      console.log("💡 Remove --dry-run flag to actually upload to Garmin\n");
      
      return {
        successful: workouts.length,
        failed: 0,
        failedWorkouts: [],
      };
    }

    // Actual upload
    console.log("📤 Uploading workouts to Garmin...\n");
    
    let successful = 0;
    let failed = 0;
    const failedWorkouts: string[] = [];

    for (let i = 0; i < workouts.length; i++) {
      const workout = workouts[i];
      console.log(`\n[${i + 1}/${workouts.length}] ${workout.workoutName}`);
      
      const success = await this.uploadWorkout(workout, false);
      
      if (success) {
        successful++;
      } else {
        failed++;
        failedWorkouts.push(workout.workoutName);
      }

      // Rate limiting: wait 1 second between uploads (except for last one)
      if (i < workouts.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log("\n" + "=".repeat(50));
    console.log(`📊 Upload Summary:`);
    console.log(`   ✅ Successful: ${successful}/${workouts.length}`);
    console.log(`   ❌ Failed: ${failed}/${workouts.length}`);
    
    if (failedWorkouts.length > 0) {
      console.log(`\n   Failed workouts:`);
      failedWorkouts.forEach((name) => console.log(`      - ${name}`));
    }
    
    console.log("=".repeat(50) + "\n");

    return { successful, failed, failedWorkouts };
  }
}

export default WorkoutEditor;
