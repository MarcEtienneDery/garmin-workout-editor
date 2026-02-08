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

/**
 * Workout management, import, export, and scheduling
 */
export class WorkoutEditor {
  private garminClient: GarminClient;

  constructor(garminClient: GarminClient) {
    this.garminClient = garminClient;
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
   * Garmin stores weight in tenths of grams, so: weight_lbs = maxWeight / 4536 (453.6 grams per lb)
   */
  private convertGarminWeight(maxWeight: number): number {
    if (maxWeight === 0) return 0;
    return Math.round(maxWeight / 453.6);
  }

  /**
   * Transform raw Garmin workout steps to structured format
   */
  private transformWorkoutSteps(rawSteps: any[]): WorkoutStep[] {
    if (!rawSteps || !Array.isArray(rawSteps)) {
      return [];
    }

    return rawSteps.map((step: any) => {
      const workoutStep: WorkoutStep = {
        stepType: step.stepType || "exercise",
      };

      // Exercise fields
      if (step.exerciseName) {
        workoutStep.exerciseName = step.exerciseName;
      }

      // Handle both direct properties and nested exercise details
      if (step.category) {
        workoutStep.category = step.category;
      } else if (step.exerciseCategory) {
        workoutStep.category = step.exerciseCategory;
      }

      // Sets and reps
      if (step.targetSets !== undefined) {
        workoutStep.targetSets = step.targetSets;
      }

      if (step.targetReps !== undefined) {
        workoutStep.targetReps = step.targetReps;
      }

      // Weight
      if (step.targetWeight !== undefined) {
        workoutStep.targetWeight = step.targetWeight;
      } else if (step.maxWeight !== undefined) {
        workoutStep.targetWeight = this.convertGarminWeight(step.maxWeight);
      }

      // Duration for rest/cardio steps
      if (step.duration !== undefined) {
        workoutStep.duration = step.duration;
      }

      // Rest between sets
      if (step.restSeconds !== undefined) {
        workoutStep.restSeconds = step.restSeconds;
      }

      return workoutStep;
    });
  }

  /**
   * Fetch detailed workout information from Garmin
   */
  async fetchWorkoutDetails(workoutId: number | string): Promise<any> {
    try {
      const client = this.garminClient.getClientAny();

      if (!client.getWorkout) {
        console.warn(
          `⚠️  getWorkout is not available on this Garmin client`
        );
        return null;
      }

      const details = await client.getWorkout(workoutId);
      return details;
    } catch (error: any) {
      console.warn(
        `⚠️  Failed to fetch workout details for ${workoutId}: ${error.message}`
      );
      return null;
    }
  }

  /**
   * Fetch workouts from Garmin with full exercise details
   */
  async fetchWorkouts(includeDetails: boolean = true): Promise<DetailedWorkout[]> {
    try {
      console.log("📥 Fetching workouts from Garmin...");

      const authenticated = await this.garminClient.ensureAuthenticated();
      if (!authenticated) {
        throw new Error("Failed to authenticate with Garmin");
      }

      const client = this.garminClient.getClientAny();
      const workouts = await client.getWorkouts?.();
      if (!workouts) {
        throw new Error("getWorkouts is not available on this Garmin client");
      }

      console.log(`✅ Retrieved ${workouts.length} workouts`);

      const detailedWorkouts: DetailedWorkout[] = [];

      if (includeDetails) {
        console.log(
          `📋 Fetching detailed info for ${workouts.length} workouts...`
        );

        for (let i = 0; i < workouts.length; i++) {
          try {
            const workout = workouts[i];
            const details = await this.fetchWorkoutDetails(workout.workoutId);

            let steps: WorkoutStep[] = [];
            let totalSets = 0;
            let totalReps = 0;
            let estimatedDurationSeconds = 0;

            if (details && details.workoutSteps) {
              steps = this.transformWorkoutSteps(details.workoutSteps);

              // Calculate totals
              steps.forEach((step) => {
                if (step.targetSets) totalSets += step.targetSets;
                if (step.targetReps) totalReps += step.targetReps;
                if (step.duration) estimatedDurationSeconds += step.duration;
              });
            }

            detailedWorkouts.push({
              workoutId: workout.workoutId,
              workoutName:
                workout.workoutName ||
                workout.workoutName?.name ||
                "Unnamed Workout",
              workoutType: workout.workoutType,
              description: workout.description,
              steps,
              totalSets: totalSets || undefined,
              totalReps: totalReps || undefined,
              estimatedDurationSeconds:
                estimatedDurationSeconds || undefined,
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
            detailedWorkouts.push({
              workoutId: workouts[i].workoutId,
              workoutName:
                workouts[i].workoutName ||
                workouts[i].workoutName?.name ||
                "Unnamed Workout",
              workoutType: workouts[i].workoutType,
              description: workouts[i].description,
            });
          }
        }
      } else {
        // No detailed fetch, just return basic info
        detailedWorkouts.push(
          ...workouts.map((workout: any) => ({
            workoutId: workout.workoutId,
            workoutName:
              workout.workoutName ||
              workout.workoutName?.name ||
              "Unnamed Workout",
            workoutType: workout.workoutType,
            description: workout.description,
          }))
        );
      }

      return detailedWorkouts;
    } catch (error: any) {
      console.error("❌ Failed to fetch workouts:", error.message);
      return [];
    }
  }

  /**
   * Export workouts with full details to JSON file
   */
  async exportWorkouts(
    outputPath: string = "./data/workouts.json",
    includeDetails: boolean = true
  ): Promise<void> {
    const workouts = await this.fetchWorkouts(includeDetails);

    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(workouts, null, 2));
    console.log(`✅ Workouts saved to ${outputPath}`);
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
}

export default WorkoutEditor;
