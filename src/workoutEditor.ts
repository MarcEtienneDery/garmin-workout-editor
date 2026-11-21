import exerciseCategoryMap from "./exercise-category-map.json";
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

export const VALID_STEP_TYPES = [
  "warmup",
  "cooldown",
  "interval",
  "recovery",
  "rest",
  "exercise",
  "repeat",
  "other",
] as const;

export const VALID_END_CONDITIONS = [
  "reps",
  "time",
  "distance",
  "lap.button",
  "iterations",
  "calories",
  "heart.rate",
] as const;

export const VALID_TARGET_TYPES = [
  "no.target",
  "heart.rate.zone",
  "pace.zone",
  "speed.zone",
  "power.zone",
  "cadence.zone",
  "open",
] as const;

const EXERCISE_CATEGORY_MAP = exerciseCategoryMap as Record<string, string>;

export class WorkoutEditor {
  private garminClient: GarminClient;

  constructor(garminClient: GarminClient) {
    this.garminClient = garminClient;
  }

  private isValidStepType(value: any): boolean {
    return typeof value === "string" && ((VALID_STEP_TYPES) as readonly string[]).includes(value);
  }

  private isValidEndCondition(value: any): boolean {
    return typeof value === "string" && ((VALID_END_CONDITIONS) as readonly string[]).includes(value);
  }

  private isValidTargetType(value: any): boolean {
    return typeof value === "string" && ((VALID_TARGET_TYPES) as readonly string[]).includes(value);
  }

  private validateWorkoutStep(step: WorkoutStep, stepIndex: number): void {
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

    if (step.endCondition && step.endCondition !== "lap.button" && step.endConditionValue === undefined) {
      throw new Error(
        `Step ${stepIndex}: Missing required field 'endConditionValue' when endCondition is '${step.endCondition}'`
      );
    }

    if (step.endConditionValue !== undefined && typeof step.endConditionValue !== "number") {
      throw new Error(
        `Step ${stepIndex}: Field 'endConditionValue' must be a number, got ${typeof step.endConditionValue}`
      );
    }

    if (step.endConditionValue !== undefined && step.endCondition !== "lap.button" && step.endConditionValue <= 0) {
      throw new Error(
        `Step ${stepIndex}: Field 'endConditionValue' must be positive, got ${step.endConditionValue}`
      );
    }

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
      if (step.weight > 1000) {
        throw new Error(
          `Step ${stepIndex}: Field 'weight' seems unreasonably high (${step.weight} lbs). Check if value is correct.`
        );
      }
    }

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
      if (!step.benchmarkKey) {
        throw new Error(
          `Step ${stepIndex}: Field 'benchmarkKey' is required when 'weightPercentage' is set`
        );
      }
    }

    if ((step.stepType === "interval" || step.stepType === "exercise") && 
        (step.weight !== undefined || step.reps !== undefined) && 
        !step.exerciseName) {
      console.warn(
        `⚠️  Step ${stepIndex}: Missing 'exerciseName' for exercise step with ${step.weight ? 'weight' : 'reps'}. This may cause issues in Garmin.`
      );
    }

    if (step.exerciseName) {
      const { mapKey, category } = this.resolveExerciseCategory(step.exerciseName);
      if (!category) {
        throw new Error(
          `Step ${stepIndex}: Unknown exerciseName '${step.exerciseName}' (normalized: '${mapKey}'). Add it to exercise-category-map.json before upload.`
        );
      }
    }

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

    if (step.endCondition === "reps" && step.reps !== undefined && step.reps !== step.endConditionValue) {
      throw new Error(
        `Step ${stepIndex}: Mismatch between 'reps' (${step.reps}) and 'endConditionValue' (${step.endConditionValue})`
      );
    }

    if (step.endCondition === "time" && step.durationSeconds !== undefined && step.durationSeconds !== step.endConditionValue) {
      throw new Error(
        `Step ${stepIndex}: Mismatch between 'durationSeconds' (${step.durationSeconds}) and 'endConditionValue' (${step.endConditionValue})`
      );
    }

    if (step.endCondition === "distance" && step.distanceMeters !== undefined && step.distanceMeters !== step.endConditionValue) {
      throw new Error(
        `Step ${stepIndex}: Mismatch between 'distanceMeters' (${step.distanceMeters}) and 'endConditionValue' (${step.endConditionValue})`
      );
    }
  }

  validateWorkout(workout: DetailedWorkout): void {
    if (!workout.workoutName || typeof workout.workoutName !== "string") {
      throw new Error(
        `Invalid workout: Missing or invalid 'workoutName'`
      );
    }

    if (!workout.steps || !Array.isArray(workout.steps)) {
      throw new Error(
        `Invalid workout '${workout.workoutName}': Missing or invalid 'steps' array`
      );
    }

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

  validateWorkoutsForUpload(workouts: DetailedWorkout[]): string[] {
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

  validateWorkoutPlan(plan: WeeklyWorkoutPlan): void {
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

  private formatExerciseName(subcategoryKey: string | undefined): string {
    if (!subcategoryKey) return "Unknown Exercise";
    return subcategoryKey
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
  }

  private convertGarminWeight(weightValue: number, weightUnit?: { unitKey?: string; factor?: number }): number {
    if (weightValue === 0) return 0;
    const hundredth = (lb: number) => Math.round(lb * 100) / 100;

    if (weightUnit?.unitKey === "pound") {
      return hundredth(weightValue);
    }

    return hundredth(weightValue / 453.59237);
  }

  private transformWorkoutSteps(steps: IWorkoutStep[]): WorkoutStep[] {
    if (!steps || !Array.isArray(steps)) {
      return [];
    }

    const flattenedSteps = this.flattenSteps(steps);

    const mergedSteps = this.mergeRestIntoExercises(flattenedSteps);

    mergedSteps.forEach((step, index) => {
      step.stepOrder = index + 1;
    });

    return mergedSteps;
  }

  private flattenSteps(steps: any[], groupCounter: { value: number } = { value: 0 }): WorkoutStep[] {
    const flattened: WorkoutStep[] = [];

    for (const step of steps) {
      if (step.type === "RepeatGroupDTO" && step.workoutSteps && Array.isArray(step.workoutSteps)) {
        const groupIndex = groupCounter.value++;

        const numberOfRepeats = step.numberOfIterations;

        const nestedSteps = this.flattenSteps(step.workoutSteps, groupCounter);

        nestedSteps.forEach((nestedStep) => {
          nestedStep.numberOfRepeats = numberOfRepeats;
          nestedStep.repeatGroupIndex = groupIndex;
        });

        flattened.push(...nestedSteps);
      } else {
        const workoutStep = this.transformSingleStep(step);
        flattened.push(workoutStep);
      }
    }

    return flattened;
  }

  private transformSingleStep(step: any): WorkoutStep {
    const workoutStep: WorkoutStep = {
      stepType: step.stepType?.stepTypeKey || "exercise",
    };

    if (step.exerciseName) {
      workoutStep.exerciseName = step.exerciseName;
    }

    if (step.targetType?.workoutTargetTypeKey) {
      workoutStep.targetType = step.targetType.workoutTargetTypeKey;
    }

    const hasMeaningfulTarget = workoutStep.targetType && workoutStep.targetType !== "no.target";
    
    if (step.targetValueOne !== null && step.targetValueOne !== undefined) {
      if (step.targetValueOne !== 0 || hasMeaningfulTarget) {
        workoutStep.targetValueOne = step.targetValueOne;
      }
    }

    if (step.targetValueTwo !== null && step.targetValueTwo !== undefined) {
      if (step.targetValueTwo !== 0 || hasMeaningfulTarget) {
        workoutStep.targetValueTwo = step.targetValueTwo;
      }
    }

    if (step.endCondition?.conditionTypeKey) {
      workoutStep.endCondition = step.endCondition.conditionTypeKey;
    }

    if (step.endConditionValue !== null && step.endConditionValue !== undefined) {
      workoutStep.endConditionValue = step.endConditionValue;

      if (workoutStep.endCondition === "reps") {
        workoutStep.reps = step.endConditionValue;
      } else if (workoutStep.endCondition === "time") {
        workoutStep.durationSeconds = step.endConditionValue;
      } else if (workoutStep.endCondition === "distance") {
        workoutStep.distanceMeters = step.endConditionValue;
      }
    }

    if (step.weightValue !== null && step.weightValue !== undefined) {
      workoutStep.weight = this.convertGarminWeight(step.weightValue, step.weightUnit);
    }

    if (step.weightDisplayUnit?.unitKey === "percent" && step.weightValue !== null && step.weightValue !== undefined) {
      workoutStep.weightPercentage = step.weightValue;
    } else if (step.benchmarkPercentage !== null && step.benchmarkPercentage !== undefined) {
      workoutStep.weightPercentage = step.benchmarkPercentage;
      if (step.benchmarkKey) {
        workoutStep.benchmarkKey = step.benchmarkKey;
      }
    }

    workoutStep.stepOrder = step.stepOrder;

    return workoutStep;
  }

  private mergeRestIntoExercises(steps: WorkoutStep[]): WorkoutStep[] {
    const merged: WorkoutStep[] = [];
    let i = 0;

    while (i < steps.length) {
      const currentStep = steps[i];

      if (i + 1 < steps.length && steps[i + 1].stepType === "rest") {
        const restStep = steps[i + 1];

        if (restStep.durationSeconds !== undefined) {
          currentStep.restTimeSeconds = restStep.durationSeconds;
        } else if (restStep.endConditionValue !== undefined) {
          currentStep.restTimeSeconds = restStep.endConditionValue;
        }

        merged.push(currentStep);

        i += 2;
      } else {
        merged.push(currentStep);
        i++;
      }
    }

    return merged;
  }

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

  async fetchWorkout(workoutId: number | string): Promise<DetailedWorkout | null> {
    if (this.garminClient.isMockMode()) {
      const workouts = await this.fetchWorkouts(true);
      return (
        workouts.find((w) => String(w.workoutId) === String(workoutId)) ?? null
      );
    }

    const authenticated = await this.garminClient.ensureAuthenticated();
    if (!authenticated) {
      throw this.garminClient.authError();
    }

    const details = await this.fetchWorkoutDetails(workoutId);
    if (!details) return null;

    return this.transformSingleWorkout(details);
  }

  fromGarminDetail(detail: IWorkoutDetail): DetailedWorkout {
    return this.transformSingleWorkout(detail);
  }

  toGarminCanonical(workout: DetailedWorkout): DetailedWorkout {
    return this.transformSingleWorkout(this.buildGarminWorkoutDetail(workout));
  }

  async listWorkoutSummaries(): Promise<
    {
      workoutId: number | string;
      workoutName: string;
      workoutType?: string;
      description?: string;
      updatedDate?: string;
    }[]
  > {
    const raw = await this.fetchRawWorkouts(false);
    return raw.map((w: any) => ({
      workoutId: w.workoutId,
      workoutName: w.workoutName || "Unnamed Workout",
      workoutType: w.sportType?.sportTypeKey,
      description: w.description || undefined,
      updatedDate: w.updatedDate != null ? String(w.updatedDate) : undefined,
    }));
  }

  async fetchWorkoutsWithRaw(includeDetails: boolean = true): Promise<{
    transformed: DetailedWorkout[];
    raw: any[];
  }> {
    try {
      console.log("📥 Fetching workouts from Garmin...");

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
        throw this.garminClient.authError();
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

            rawWorkouts.push({
              ...workout,
              ...(details || {}),
            });

            let steps: WorkoutStep[] = [];
            let totalSets = 0;
            let totalReps = 0;
            let estimatedDurationSeconds = 0;

            if (details && details.workoutSegments) {
              details.workoutSegments.forEach((segment: IWorkoutSegment) => {
                if (segment.workoutSteps && Array.isArray(segment.workoutSteps)) {
                  const segmentSteps = this.transformWorkoutSteps(segment.workoutSteps);
                  steps.push(...segmentSteps);

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

            if (i < workouts.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          } catch (error: any) {
            console.warn(
              `  ⚠️  Could not fetch full details for workout ${workouts[i].workoutId}: ${error.message}`
            );
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
      throw error;
    }
  }

  async fetchRawWorkouts(includeDetails: boolean = true): Promise<any[]> {
    const result = await this.fetchWorkoutsWithRaw(includeDetails);
    return result.raw;
  }

  async fetchWorkouts(includeDetails: boolean = true): Promise<DetailedWorkout[]> {
    const result = await this.fetchWorkoutsWithRaw(includeDetails);
    return result.transformed;
  }

  private transformSingleWorkout(workout: any): DetailedWorkout {
    let steps: WorkoutStep[] = [];
    let totalSets = 0;
    let totalReps = 0;
    let estimatedDurationSeconds = 0;

    if (workout.workoutSegments && Array.isArray(workout.workoutSegments)) {
      workout.workoutSegments.forEach((segment: IWorkoutSegment) => {
        if (segment.workoutSteps && Array.isArray(segment.workoutSteps)) {
          const segmentSteps = this.transformWorkoutSteps(segment.workoutSteps);
          steps.push(...segmentSteps);

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

  private transformWorkouts(rawWorkouts: any[]): DetailedWorkout[] {
    return rawWorkouts.map((workout) => this.transformSingleWorkout(workout));
  }

  parseWorkoutPlan(raw: string): WeeklyWorkoutPlan {
    const plan = JSON.parse(raw) as WeeklyWorkoutPlan;
    this.validateWorkoutPlan(plan);
    return plan;
  }

  async scheduleWorkoutPlan(plan: WeeklyWorkoutPlan): Promise<void> {
    const authenticated = await this.garminClient.ensureAuthenticated();
    if (!authenticated) {
      throw this.garminClient.authError();
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

      const dates = Array.isArray(workout.scheduledDate)
        ? workout.scheduledDate
        : [workout.scheduledDate];

      for (const dateStr of dates) {
        const scheduleDate = new Date(dateStr);
        if (Number.isNaN(scheduleDate.getTime())) {
          console.warn(
            `⚠️  Invalid scheduledDate for workout: ${workout.workoutName} (${dateStr})`
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
            `✅ Scheduled workout: ${workout.workoutName} on ${dateStr}`
          );
        } catch (error: any) {
          const errorMsg = (error.message || "").toLowerCase();
          const errorBody = JSON.stringify(error).toLowerCase();
          
          if (errorMsg.includes("404") || errorBody.includes("not found")) {
            console.log(
              `ℹ️  Skipped workout not found in Garmin (already deleted): ${workout.workoutName}`
            );
            continue;
          }
          
          if (errorMsg.includes("409") || errorMsg.includes("conflict") || 
              errorMsg.includes("already") || errorBody.includes("already")) {
            console.log(
              `✅ Workout already scheduled on this date: ${workout.workoutName} on ${dateStr}`
            );
            continue;
          }
          
          if (process.env.DEBUG_WORKOUTS) {
            console.log(`[DEBUG] Schedule error details: ${JSON.stringify(error)}`);
          }
          
          console.warn(
            `⚠️  Failed to schedule workout: ${workout.workoutName} on ${dateStr} (${error.message})`
          );
        }
      }
    }
  }

  async uploadAndScheduleWorkoutPlan(plan: WeeklyWorkoutPlan): Promise<void> {
    const authenticated = await this.garminClient.ensureAuthenticated();
    if (!authenticated) {
      throw this.garminClient.authError();
    }

    this.validateWorkoutPlan(plan);

    const client = this.garminClient.getClientAny();
    
    console.log("📤 Uploading workouts to Garmin...\n");
    
    for (const workout of plan.workouts) {
      if (workout.steps && workout.steps.length > 0) {
        try {
          this.validateWorkout(workout as DetailedWorkout);
        } catch (error: any) {
          console.error(
            `❌ Skipping invalid structured workout '${workout.workoutName}': ${error.message}`
          );
          continue;
        }
      }

      if (workout.workoutType === "running" && workout.distanceMeters && 
          (!workout.steps || workout.steps.length === 0)) {
        try {
          if (workout.workoutId && client.deleteWorkout) {
            try {
              console.log(`  🗑️  Deleting existing running workout: ${workout.workoutName} (ID: ${workout.workoutId})`);
              await client.deleteWorkout({ workoutId: String(workout.workoutId) });
              console.log(`     ✓ Deleted`);
            } catch (deleteError: any) {
              console.log(`     ℹ️  Could not delete (${deleteError.message ? deleteError.message.split('\n')[0] : 'unknown error'}) - attempting to create anyway`);
            }
          }
          
          const created = await client.addRunningWorkout?.(
            workout.workoutName,
            workout.distanceMeters,
            workout.description || ""
          );
          workout.workoutId = created?.workoutId;
          console.log(`✅ Created/updated running workout: ${workout.workoutName} (ID: ${workout.workoutId})`);
        } catch (error: any) {
          console.warn(
            `⚠️  Failed to create running workout: ${workout.workoutName} (${error.message})`
          );
        }
        continue;
      }

      console.log(`\n📋 Processing ${workout.workoutName}:`);
      console.log(`   Type: ${workout.workoutType}, Steps: ${workout.steps?.length || 0}`);
      
      if (workout.steps && workout.steps.length > 0) {
        try {
          if (workout.workoutId && client.deleteWorkout) {
            try {
              console.log(`  🗑️  Deleting existing workout: ${workout.workoutName} (ID: ${workout.workoutId})`);
              await client.deleteWorkout({ workoutId: String(workout.workoutId) });
              console.log(`     ✓ Deleted`);
            } catch (deleteError: any) {
              console.log(`     ℹ️  Could not delete (${deleteError.message ? deleteError.message.split('\n')[0] : 'unknown error'}) - attempting to create anyway`);
            }
          }
          
          const garminWorkout = this.buildGarminWorkoutDetail(workout as DetailedWorkout);
          console.log(`   📝 Built Garmin format: ${garminWorkout.workoutSegments?.[0]?.workoutSteps?.length || 0} steps`);
          
          if (!client.createWorkout) {
            throw new Error("createWorkout is not available on this Garmin client");
          }
          
          const created = await client.createWorkout(garminWorkout);
          workout.workoutId = created.workoutId;
          console.log(`✅ Created/updated structured workout: ${workout.workoutName} (ID: ${workout.workoutId})`);
        } catch (error: any) {
          console.error(
            `❌ Failed to create structured workout: ${workout.workoutName} (${error.message})`
          );
        }
        continue;
      }

      console.warn(
        `⚠️  Cannot create workout without steps or distance: ${workout.workoutName}`
      );
    }

    console.log("\n📅 Scheduling workouts to calendar...\n");
    
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

      const dates = Array.isArray(workout.scheduledDate)
        ? workout.scheduledDate
        : [workout.scheduledDate];

      for (const dateStr of dates) {
        const scheduleDate = new Date(dateStr);
        if (Number.isNaN(scheduleDate.getTime())) {
          console.warn(
            `⚠️  Invalid scheduledDate for workout: ${workout.workoutName} (${dateStr})`
          );
          continue;
        }

        const workoutId = workout.workoutId;

        if (!workoutId) {
          console.warn(
            `⚠️  Missing workoutId for workout: ${workout.workoutName}`
          );
          continue;
        }

        try {
          await client.scheduleWorkout({ workoutId }, scheduleDate);
          console.log(
            `✅ Scheduled workout: ${workout.workoutName} on ${dateStr}`
          );
        } catch (error: any) {
          const errorMsg = (error.message || "").toLowerCase();
          const errorBody = JSON.stringify(error).toLowerCase();
          
          if (errorMsg.includes("404") || errorBody.includes("not found")) {
            console.log(
              `ℹ️  Skipped workout not found in Garmin (already deleted): ${workout.workoutName}`
            );
            continue;
          }
          
          if (errorMsg.includes("409") || errorMsg.includes("conflict") || 
              errorMsg.includes("already") || errorBody.includes("already")) {
            console.log(
              `✅ Workout already scheduled on this date: ${workout.workoutName} on ${dateStr}`
            );
            continue;
          }
          
          if (process.env.DEBUG_WORKOUTS) {
            console.log(`[DEBUG] Schedule error details: ${JSON.stringify(error)}`);
          }
          
          console.warn(
            `⚠️  Failed to schedule workout: ${workout.workoutName} on ${dateStr} (${error.message})`
          );
        }
      }
    }
  }

  private convertWeightToGrams(weightLbs: number): number {
    return Math.round(weightLbs * 453.59237);
  }

  private buildGarminRestStep(restSeconds: number): any {
    return {
      type: "ExecutableStepDTO",
      stepId: null,
      stepOrder: null,
      childStepId: null,
      description: null,
      stepType: {
        stepTypeId: this.getStepTypeId("rest"),
        stepTypeKey: "rest",
      },
      endCondition: {
        conditionTypeId: this.getEndConditionId("time"),
        conditionTypeKey: "time",
      },
      endConditionValue: restSeconds,
      preferredEndConditionUnit: null,
      targetType: {
        workoutTargetTypeId: this.getTargetTypeId("no.target"),
        workoutTargetTypeKey: "no.target",
      },
      targetValueOne: null,
      targetValueTwo: null,
      targetValueUnit: null,
      zoneNumber: null,
      secondaryTargetType: null,
      secondaryTargetValueOne: null,
      secondaryTargetValueTwo: null,
      secondaryTargetValueUnit: null,
      secondaryZoneNumber: null,
    };
  }

  private assignSequentialStepOrder(steps: any[]): void {
    let order = 1;

    const visit = (items: any[]) => {
      for (const item of items) {
        if (item?.type === "RepeatGroupDTO" && Array.isArray(item.workoutSteps)) {
          item.stepOrder = order++;
          visit(item.workoutSteps);
          continue;
        }

        if (item?.type === "ExecutableStepDTO") {
          item.stepOrder = order++;
        }
      }
    };

    visit(steps);
  }

  private unflattenSteps(steps: WorkoutStep[]): any[] {
    const orderedSteps = [...steps].sort(
      (a, b) => (a.stepOrder ?? Number.MAX_SAFE_INTEGER) - (b.stepOrder ?? Number.MAX_SAFE_INTEGER)
    );
    const unflattened: any[] = [];
    let currentGroupIndex: number | undefined = undefined;
    let currentGroupSteps: WorkoutStep[] = [];

    const flushGroup = () => {
      if (currentGroupSteps.length === 0) return;

      const firstStep = currentGroupSteps[0];
      const numberOfRepeats = firstStep.numberOfRepeats;
      const garminSteps: any[] = [];

      for (const step of currentGroupSteps) {
        garminSteps.push(this.convertStepToGarminFormat(step));

        if (step.restTimeSeconds !== undefined && step.restTimeSeconds > 0) {
          garminSteps.push(this.buildGarminRestStep(step.restTimeSeconds));
        }
      }

      if (numberOfRepeats !== undefined && numberOfRepeats > 1) {
        unflattened.push({
          type: "RepeatGroupDTO",
          stepType: { stepTypeId: this.getStepTypeId("repeat"), stepTypeKey: "repeat" },
          stepOrder: null,
          repeatGroupId: null,
          numberOfIterations: numberOfRepeats,
          smartRepeat: false,
          childStepId: null,
          workoutSteps: garminSteps,
        });
      } else {
        unflattened.push(...garminSteps);
      }

      currentGroupSteps = [];
      currentGroupIndex = undefined;
    };

    for (const step of orderedSteps) {
      const idx = step.repeatGroupIndex;

      if (idx === undefined) {
        flushGroup();
        const garminStep = this.convertStepToGarminFormat(step);
        unflattened.push(garminStep);

        if (step.restTimeSeconds !== undefined && step.restTimeSeconds > 0) {
          unflattened.push(this.buildGarminRestStep(step.restTimeSeconds));
        }
      } else if (idx !== currentGroupIndex) {
        flushGroup();
        currentGroupIndex = idx;
        currentGroupSteps.push(step);
      } else {
        currentGroupSteps.push(step);
      }
    }

    flushGroup();

    this.assignSequentialStepOrder(unflattened);

    return unflattened;
  }

  private convertStepToGarminFormat(step: WorkoutStep): any {
    const targetTypeKey = step.stepType === "cooldown" && step.targetType === "open" ? "no.target" : step.targetType || "no.target";
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
        workoutTargetTypeId: this.getTargetTypeId(targetTypeKey),
        workoutTargetTypeKey: targetTypeKey,
      },
      targetValueOne: step.targetValueOne !== undefined ? step.targetValueOne : null,
      targetValueTwo: step.targetValueTwo !== undefined ? step.targetValueTwo : null,
      targetValueUnit: null,
      zoneNumber: null,
      secondaryTargetType: null,
      secondaryTargetValueOne: null,
      secondaryTargetValueTwo: null,
      secondaryTargetValueUnit: null,
      secondaryZoneNumber: null,
    };

    if (step.endCondition === "distance") {
      garminStep.preferredEndConditionUnit = {
        unitId: 1,
        unitKey: "meter",
        factor: 1,
      };
    }

    if (step.exerciseName) {
      garminStep.exerciseName = step.exerciseName;
      const category = this.getCategoryFromExerciseName(step.exerciseName);
      if (category) {
        garminStep.category = category;
      }
    }

    if (step.weight !== undefined && step.weight > 0) {
      garminStep.weightValue = step.weight;
      garminStep.weightUnit = {
        unitId: 9,
        unitKey: "pound",
        factor: 453.59237,
      };
    }

    if (step.weightPercentage !== undefined && step.benchmarkKey) {
      garminStep.benchmarkPercentage = step.weightPercentage;
      garminStep.benchmarkKey = step.benchmarkKey;
    }

    return garminStep;
  }

  private normalizeExerciseMapKey(exerciseName: string): string {
    let key = exerciseName
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");

    if (key && /^[0-9]/.test(key)) {
      key = `_${key}`;
    }

    return key;
  }

  private resolveExerciseCategory(exerciseName: string): {
    mapKey: string;
    category: string | null;
  } {
    const mapKey = this.normalizeExerciseMapKey(exerciseName);
    return {
      mapKey,
      category: EXERCISE_CATEGORY_MAP[mapKey] ?? null,
    };
  }

  private getCategoryFromExerciseName(exerciseName: string): string | null {
    return this.resolveExerciseCategory(exerciseName).category;
  }

  private getStepTypeId(stepTypeKey: string): number {
    const mapping: { [key: string]: number } = {
      warmup: 1,
      cooldown: 2,
      interval: 3,
      recovery: 4,
      rest: 5,
      exercise: 6,
      repeat: 6,
      other: 7,
    };
    return mapping[stepTypeKey] || 6;
  }

  private getEndConditionId(endConditionKey: string): number {
    const mapping: { [key: string]: number } = {
      "lap.button": 1,
      time: 2,
      distance: 3,
      calories: 4,
      "heart.rate": 5,
      reps: 10,
      iterations: 7,
    };
    return mapping[endConditionKey] || 1;
  }

  private getTargetTypeId(targetTypeKey: string): number {
    const mapping: { [key: string]: number } = {
      "no.target": 1,
      "heart.rate.zone": 4,
      "pace.zone": 6,
      "speed.zone": 3,
      "power.zone": 2,
      "cadence.zone": 7,
      open: 8,
    };
    return mapping[targetTypeKey] || 1;
  }

  private buildGarminWorkoutDetail(workout: DetailedWorkout): IWorkoutDetail {
    const garminSteps = workout.steps ? this.unflattenSteps(workout.steps) : [];

    if (process.env.DEBUG_WORKOUTS) {
      console.log(`\n[DEBUG] Building Garmin format for: ${workout.workoutName}`);
      console.log(`[DEBUG] Input steps: ${workout.steps?.length || 0}`);
      console.log(`[DEBUG] Output Garmin steps: ${garminSteps.length}`);
      if (workout.steps && workout.steps.length <= 12) {
        console.log(`[DEBUG] Step details:`);
        garminSteps.forEach((step: any, i: number) => {
          if (step.type === "RepeatGroupDTO") {
            console.log(`  [${i}] RepeatGroupDTO: ${step.numberOfIterations}x iterations, ${step.workoutSteps?.length || 0} nested steps`);
            step.workoutSteps?.slice(0, 3).forEach((nested: any, ni: number) => {
              const target = nested.targetType?.workoutTargetTypeKey !== 'no.target' ? 
                ` [${nested.targetType?.workoutTargetTypeKey}: ${nested.targetValueOne}${nested.targetValueTwo ? `-${nested.targetValueTwo}` : ''}]` : '';
              console.log(`      [${ni}] ${nested.stepType?.stepTypeKey}: ${nested.exerciseName || nested.endCondition?.conditionTypeKey || 'step'}${target}`);
            });
            if ((step.workoutSteps?.length || 0) > 3) {
              console.log(`      ... and ${(step.workoutSteps?.length || 0) - 3} more`);
            }
          } else {
            const target = step.targetType?.workoutTargetTypeKey !== 'no.target' ? 
              ` [${step.targetType?.workoutTargetTypeKey}: ${step.targetValueOne}${step.targetValueTwo ? `-${step.targetValueTwo}` : ''}]` : '';
            console.log(`  [${i}] ${step.stepType?.stepTypeKey}: ${step.exerciseName || step.endCondition?.conditionTypeKey || 'step'} (val: ${step.endConditionValue})${target}`);
          }
        });
      }
    }

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

  private getSportTypeId(workoutTypeKey: string): number {
    const mapping: { [key: string]: number } = {
      running: 1,
      cycling: 2,
      cardio: 1,
      strength_training: 5,
      swimming: 1,
      other: 0,
    };
    return mapping[workoutTypeKey] || 0;
  }

  async uploadWorkout(workout: DetailedWorkout, dryRun: boolean = false): Promise<number | null> {
    try {
      this.validateWorkout(workout);
    } catch (error: any) {
      console.error(`❌ Validation failed: ${error.message}`);
      return null;
    }

    if (dryRun) {
      console.log(`\n  🔍 Would upload: ${workout.workoutName}`);
      console.log(`     ID: ${workout.workoutId || "NEW (will be created)"}`);
      console.log(`     Type: ${workout.workoutType || "N/A"}`);
      if (workout.steps && workout.steps.length > 0) {
        console.log(`     Steps: ${workout.steps.length} exercises`);
        
        if (process.env.DEBUG_WORKOUTS && dryRun) {
          const garminWorkout = this.buildGarminWorkoutDetail(workout);
          const garminSteps = garminWorkout.workoutSegments?.[0]?.workoutSteps || [];
          console.log(`     [Garmin format: ${garminSteps.length} steps]`);
          if (garminSteps.length <= 15) {
            garminSteps.forEach((step: any, i: number) => {
              if (step.type === "RepeatGroupDTO") {
                console.log(`       [${i}] RepeatGroupDTO: ${step.numberOfIterations}x iterations, ${step.workoutSteps?.length || 0} nested steps`);
              } else {
                console.log(`       [${i}] ${step.stepType?.stepTypeKey}: ${step.exerciseName || step.stepOrder || 'step'}`);
              }
            });
          }
        }
        
        workout.steps.slice(0, 3).forEach((step, i) => {
          console.log(`       ${i + 1}. ${step.exerciseName || step.stepType}`);
        });
        if (workout.steps.length > 3) {
          console.log(`       ... and ${workout.steps.length - 3} more`);
        }
      }
      return -1;
    }

    const authenticated = await this.garminClient.ensureAuthenticated();
    if (!authenticated) {
      throw this.garminClient.authError();
    }

    const client = this.garminClient.getClientAny();

    try {
      if (workout.workoutId) {
        console.log(`  🗑️  Deleting existing workout: ${workout.workoutName} (ID: ${workout.workoutId})`);
        
        if (client.deleteWorkout) {
          await client.deleteWorkout({ workoutId: String(workout.workoutId) });
          console.log(`     ✓ Deleted`);
        } else {
          console.warn(`     ⚠️  deleteWorkout not available, skipping delete`);
        }
      }

      const garminWorkout = this.buildGarminWorkoutDetail(workout);

      console.log(`  📤 Creating workout: ${workout.workoutName}`);
      
      if (!client.createWorkout) {
        throw new Error("createWorkout is not available on this Garmin client");
      }

      const created = await client.createWorkout(garminWorkout);
      
      console.log(`     ✅ Created (New ID: ${created.workoutId})`);
      
      return created.workoutId ?? null;
    } catch (error: any) {
      console.error(`     ❌ Upload failed: ${error.message}`);
      return null;
    }
  }

  async deleteWorkout(workoutId: number | string): Promise<void> {
    const authenticated = await this.garminClient.ensureAuthenticated();
    if (!authenticated) {
      throw this.garminClient.authError();
    }
    const client = this.garminClient.getClientAny();
    if (!client.deleteWorkout) {
      throw new Error("deleteWorkout is not available on this Garmin client");
    }
    await client.deleteWorkout({ workoutId: String(workoutId) });
    console.log(`🗑️  Deleted workout ${workoutId}`);
  }

  async scheduleWorkout(workoutId: number | string, day: string): Promise<{ workoutName: string }> {
    const authenticated = await this.garminClient.ensureAuthenticated();
    if (!authenticated) {
      throw this.garminClient.authError();
    }

    const detail = await this.fetchWorkoutDetails(workoutId);
    if (!detail) {
      throw new Error(
        `Garmin did not return workout ${workoutId}: it may not exist (a workout that was uploaded again has a new id; list_workouts shows the current ones). See the log.`
      );
    }

    const client = this.garminClient.getClientAny();
    if (!client.scheduleWorkout) {
      throw new Error("scheduleWorkout is not available on this Garmin client");
    }
    await client.scheduleWorkout({ workoutId }, new Date(day));
    console.log(`✅ Scheduled workout: ${detail.workoutName} on ${day}`);
    return { workoutName: detail.workoutName };
  }

  async scheduledOn(days: string[]): Promise<{ scheduleId: number; workoutId: number | null; date: string }[]> {
    const authenticated = await this.garminClient.ensureAuthenticated();
    if (!authenticated) {
      throw this.garminClient.authError();
    }
    const client = this.garminClient.getClientAny();
    if (!client.getMonthCalendarEvents) {
      throw new Error("getMonthCalendarEvents is not available on this Garmin client");
    }
    const entries: { scheduleId: number; workoutId: number | null; date: string }[] = [];
    for (const month of new Set(days.map((day) => day.slice(0, 7)))) {
      const [year, m] = month.split("-").map(Number);
      const calendar = await client.getMonthCalendarEvents(year, m - 1);
      for (const item of calendar?.calendarItems ?? []) {
        if (item?.itemType === "workout" && days.includes(item.date)) entries.push({ scheduleId: item.id, workoutId: item.workoutId ?? null, date: item.date });
      }
    }
    return entries;
  }

  async unscheduleWorkout(scheduleId: number | string): Promise<void> {
    const authenticated = await this.garminClient.ensureAuthenticated();
    if (!authenticated) {
      throw this.garminClient.authError();
    }
    const client = this.garminClient.getClientAny();
    if (!client.client?.delete || !client.url?.SCHEDULE_WORKOUT) {
      throw new Error("Removing a calendar entry is not available on this Garmin client");
    }
    await client.client.delete(client.url.SCHEDULE_WORKOUT(scheduleId));
    console.log(`🗑️  Removed calendar entry ${scheduleId}`);
  }

  async uploadWorkoutsFromText(
    raw: string,
    dryRun: boolean,
    save: (updated: string) => void,
    source: string
  ): Promise<{ successful: number; failed: number; failedWorkouts: string[] }> {
    console.log(`📂 Loading workouts from ${source}...`);

    const data = JSON.parse(raw);
    
    let workouts: DetailedWorkout[] = [];
    
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
      
      const errors = this.validateWorkoutsForUpload(workouts);
      
      if (errors.length > 0) {
        console.error("❌ Validation errors:\n");
        errors.forEach((error) => console.error(`   ${error}`));
        throw new Error(`Validation failed with ${errors.length} error(s)`);
      }
      
      console.log("📋 All workouts are valid. Preview:\n");
      
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

    console.log("📤 Uploading workouts to Garmin...\n");
    
    let successful = 0;
    let failed = 0;
    const failedWorkouts: string[] = [];
    let idsUpdated = 0;

    for (let i = 0; i < workouts.length; i++) {
      const workout = workouts[i];
      console.log(`\n[${i + 1}/${workouts.length}] ${workout.workoutName}`);
      
      const newId = await this.uploadWorkout(workout, false);
      
      if (newId !== null) {
        successful++;
        workout.workoutId = newId;
        idsUpdated++;
      } else {
        failed++;
        failedWorkouts.push(workout.workoutName);
      }

      if (i < workouts.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (idsUpdated > 0) {
      save(JSON.stringify(Array.isArray(data) ? workouts : { ...data, workouts }, null, 2));
      console.log(`\n📝 Updated ${idsUpdated} workout ID(s) in ${source}`);
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

  async sendWorkoutsToDevice(
    workouts: { workoutId: number; workoutName: string }[],
    deviceId?: number
  ): Promise<void> {
    const authenticated = await this.garminClient.ensureAuthenticated();
    if (!authenticated) {
      throw this.garminClient.authError();
    }

    let targetDeviceId = deviceId;

    if (!targetDeviceId) {
      console.log("🔍 Looking up registered devices...");
      const devices = await this.garminClient.getDevices();
      if (!devices || devices.length === 0) {
        throw new Error("No registered devices found on your Garmin account");
      }

      const device = devices[0];
      targetDeviceId = device.deviceId;
      console.log(`📱 Using device: ${device.displayName || device.deviceId}`);
    }

    const validWorkouts = workouts.filter((w) => w.workoutId);
    if (validWorkouts.length === 0) {
      throw new Error("No workouts with valid IDs to send");
    }

    console.log(`📡 Sending ${validWorkouts.length} workout(s) to device ${targetDeviceId}...`);
    await this.garminClient.sendToDevice(targetDeviceId!, validWorkouts);
    console.log(`✅ Sent ${validWorkouts.length} workout(s) to device`);
  }
}

export default WorkoutEditor;
