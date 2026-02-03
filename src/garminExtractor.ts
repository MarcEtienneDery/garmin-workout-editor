import { GarminConnect } from "garmin-connect";
import * as fs from "fs";
import * as path from "path";
import { ExtractedActivities, ExerciseSet, GarminWorkoutSummary, PlannedWorkout, WeeklyWorkoutPlan } from "./types";
import { generateMockActivities, normalizeActivityType as normalizeMockActivityType, loadLastActivitiesFromDisk } from "./mocks.setup";

class GarminExtractor {
  private email: string;
  private password: string;
  private client: GarminConnect;
  private mockMode: boolean = false;

  private get clientAny(): any {
    return this.client as any;
  }

  constructor(email: string, password: string, mockMode: boolean = false) {
    this.email = email;
    this.password = password;
    this.mockMode = mockMode;

    // Create a new Garmin Connect Client
    this.client = new GarminConnect({
      username: email,
      password: password
    });
  }

  private async ensureAuthenticated(): Promise<boolean> {
    if (this.mockMode) {
      console.log("🔓 Mock mode: Skipping authentication");
      return true;
    }

    return this.authenticate();
  }

  /**
   * Authenticate with Garmin Connect
   */
  async authenticate(): Promise<boolean> {
    try {
      console.log("🔐 Authenticating with Garmin Connect...");
      
      await this.client.login();
      
      // Verify authentication by getting user profile
      const userProfile = await this.client.getUserProfile();
      console.log(`✅ Successfully authenticated as: ${userProfile.userName}`);
      
      return true;
    } catch (error: any) {
      console.error("❌ Authentication error:", error.message);
      return false;
    }
  }

  /**
   * Fetch recent activities from Garmin
   */
  async fetchActivities(limit: number = 20, includeDetails: boolean = false): Promise<any[]> {
    try {
      console.log(`📥 Fetching last ${limit} activities from Garmin...`);

      if (this.mockMode) {
        return generateMockActivities(limit);
      }

      // Use the garmin-connect library's getActivities method
      const activities = await this.client.getActivities(0, limit);
      
      console.log(`✅ Retrieved ${activities.length} activities`);
      
      // Optionally fetch detailed info for each activity (includes self evaluation)
      if (includeDetails) {
        console.log(`📋 Fetching detailed info (including self evaluation) for ${activities.length} activities...`);
        const detailedActivities = [];
        
        for (let i = 0; i < activities.length; i++) {
          try {
            const activity = activities[i];
            const details = await this.client.getActivity({ activityId: activity.activityId });
            
            // Merge basic activity data with detailed data
            detailedActivities.push({
              ...activity,
              ...details
            });
            
            console.log(`  ✓ ${i + 1}/${activities.length}: ${activity.activityName}`);
            
            // Add delay to avoid rate limiting (1 second between requests)
            if (i < activities.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (error: any) {
            console.warn(`  ⚠️  Could not fetch details for activity ${activities[i].activityId}: ${error.message}`);
            detailedActivities.push(activities[i]); // Use basic data if detailed fetch fails
          }
        }
        
        return detailedActivities;
      }
      
      return activities;
    } catch (error: any) {
      console.error("❌ Failed to fetch activities:", error.message);
      return [];
    }
  }

  /**
   * Convert speed (m/s) to pace (min/km)
   */
  private speedToPace(speedMps: number | undefined): number | undefined {
    if (!speedMps || speedMps <= 0) return undefined;
    return 1000 / speedMps / 60; // min/km
  }

  /**
   * Format exercise name from Garmin subcategory (e.g., "BARBELL_BENCH_PRESS" -> "Barbell Bench Press")
   */
  /**
   * Check if exercise is a main powerlifting lift
   */
  private isMainLift(exerciseName: string): boolean {
    const mainLifts = ['BENCH_PRESS', 'SQUAT', 'DEADLIFT', 'OVERHEAD_PRESS'];
    return mainLifts.some(lift => exerciseName.includes(lift));
  }

  /**
   * Split warmup and working sets for main lifts
   * For main lifts, estimate warmup sets (typically first 1-2 sets at ~50-70% of working weight)
   */
  private splitWarmupAndWorkingSets(set: any, exerciseName: string): { warmup: any[]; working: any } {
    const weight = this.convertGarminWeight(set.maxWeight || 0);
    const totalSets = set.sets || 0;
    const reps = set.reps || 0;
    
    if (!this.isMainLift(set.category || '') || totalSets <= 2 || weight === 0) {
      // Not a main lift or too few sets, return as-is
      return {
        warmup: [],
        working: {
          exerciseName: this.formatExerciseName(set.subCategory || set.category),
          category: set.category || 'UNKNOWN',
          sets: totalSets,
          reps,
          weight,
          volume: set.volume,
        }
      };
    }
    
    // For main lifts with 3+ sets, assume first 1-2 are warmups
    const warmupCount = Math.min(Math.max(1, Math.ceil(totalSets * 0.25)), 2); // ~1/4 of sets or max 2
    const workingCount = Math.max(totalSets - warmupCount, 1);

    // Estimate reps per set from total reps
    const repsPerSet = Math.max(Math.round(reps / totalSets), 1);
    const warmupRepsPerSet = Math.max(Math.round(repsPerSet * 0.8), 1);
    const workingRepsPerSet = repsPerSet;
    
    // Estimate warmup weight (typically 50-70% of working weight)
    const warmupWeight = Math.round(weight * 0.6);
    const workingWeight = weight;
    
    return {
      warmup: warmupCount > 0 ? [{
        exerciseName: this.formatExerciseName(set.subCategory || set.category) + ' (Warmup)',
        category: set.category || 'UNKNOWN',
        sets: warmupCount,
        reps: warmupRepsPerSet,
        weight: warmupWeight,
        volume: warmupCount * warmupRepsPerSet * warmupWeight,
      }] : [],
      working: {
        exerciseName: this.formatExerciseName(set.subCategory || set.category),
        category: set.category || 'UNKNOWN',
        sets: workingCount,
        reps: workingRepsPerSet,
        weight: workingWeight,
        volume: set.volume,
      }
    };
  }

  /**
   * Format exercise name from Garmin subcategory (e.g., "BARBELL_BENCH_PRESS" -> "Barbell Bench Press")
   */
  private formatExerciseName(subcategoryKey: string | undefined): string {
    if (!subcategoryKey) return 'Unknown Exercise';
    return subcategoryKey
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Convert Garmin weight to lbs
   * Garmin stores weight in tenths of grams, so: weight_lbs = maxWeight / 4536 (453.6 grams per lb)
   * Or more simply: weight_lbs = maxWeight / 453.6
   */
  private convertGarminWeight(maxWeight: number): number {
    if (maxWeight === 0) return 0;
    // Convert from tenths of grams to lbs (1 lb = 453.6g)
    return Math.round(maxWeight / 453.6);
  }

  /**
   * Transform raw Garmin activities to slim format for weekly planning
   */
  private transformActivities(rawActivities: any[]): any[] {
    return rawActivities.map((activity: any) => {
      // If already in transformed shape (seeded from activities.json), return as-is
      if (!activity.activityId && activity.id && activity.activityType && activity.startTime) {
        return activity;
      }

      const activityType = normalizeMockActivityType(activity.activityType?.typeKey || activity.activityType);
      
      // Base fields for all activity types
      const base = {
        id: activity.activityId,
        activityName: activity.activityName || "Unknown Activity",
        activityType,
        startTime: activity.startTimeGMT || activity.startTimeLocal,
        duration: activity.duration || activity.elapsedDuration || 0,
        
        // Heart Rate
        avgHR: activity.averageHR,
        maxHR: activity.maxHR,
        
        // Training Load (key for scaling)
        aerobicTrainingEffect: activity.aerobicTrainingEffect,
        anaerobicTrainingEffect: activity.anaerobicTrainingEffect,
        trainingEffectLabel: activity.trainingEffectLabel,
        
        // Subjective Feedback
        selfEvaluationFeeling: activity.selfEvaluationFeeling,
        directWorkoutFeel: activity.directWorkoutFeel ?? activity.summaryDTO?.directWorkoutFeel,
        directWorkoutRpe: activity.directWorkoutRpe ?? activity.summaryDTO?.directWorkoutRpe,
        
        // Recovery Cost
        differenceBodyBattery: activity.differenceBodyBattery,
        
        // Intensity Distribution
        moderateIntensityMinutes: activity.moderateIntensityMinutes,
        vigorousIntensityMinutes: activity.vigorousIntensityMinutes,
      };

      // Add running-specific fields
      if (activityType === 'running' || activityType === 'cycling') {
        return {
          ...base,
          distance: activity.distance ? activity.distance / 1000 : undefined,
          avgPace: this.speedToPace(activity.averageSpeed),
          avgCadence: activity.averageRunningCadenceInStepsPerMinute,
          elevationGain: activity.elevationGain,
        };
      }

      // Add strength-specific fields
      if (activityType === 'strength_training') {
        const exerciseSets: ExerciseSet[] = [];
        
        activity.summarizedExerciseSets?.forEach((set: any) => {
          const split = this.splitWarmupAndWorkingSets(set, set.subCategory || set.category);
          
          // Add warmup sets if they exist
          if (split.warmup.length > 0) {
            exerciseSets.push(...split.warmup);
          }
          
          // Add working sets
          exerciseSets.push(split.working);
        });

        return {
          ...base,
          totalSets: activity.totalSets,
          totalReps: activity.totalReps,
          exerciseSets,
        };
      }

      return base;
    });
  }

  /**
   * Get the start and end of last week (Monday-Sunday)
   */
  private getLastWeekDates(): { weekStart: Date; weekEnd: Date } {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    
    // Last Monday (start of current week) minus 7 days = start of last week
    const lastWeekStart = new Date(now);
    lastWeekStart.setDate(now.getDate() - daysSinceMonday - 7);
    lastWeekStart.setHours(0, 0, 0, 0);
    
    // Last Sunday (end of last week)
    const lastWeekEnd = new Date(lastWeekStart);
    lastWeekEnd.setDate(lastWeekStart.getDate() + 6);
    lastWeekEnd.setHours(23, 59, 59, 999);
    
    return { weekStart: lastWeekStart, weekEnd: lastWeekEnd };
  }

  /**
   * Get the start and end of next week (Monday-Sunday)
   */
  private getNextWeekDates(): { weekStart: Date; weekEnd: Date } {
    const { weekStart } = this.getLastWeekDates();
    const nextWeekStart = new Date(weekStart);
    nextWeekStart.setDate(weekStart.getDate() + 7);
    nextWeekStart.setHours(0, 0, 0, 0);

    const nextWeekEnd = new Date(nextWeekStart);
    nextWeekEnd.setDate(nextWeekStart.getDate() + 6);
    nextWeekEnd.setHours(23, 59, 59, 999);

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
    if (!plan || !plan.weekStart || !plan.weekEnd || !Array.isArray(plan.workouts)) {
      throw new Error("Invalid workout plan: missing weekStart, weekEnd, or workouts");
    }

    plan.workouts.forEach((workout, index) => {
      if (!workout.workoutName) {
        throw new Error(`Invalid workout plan: workout name missing at index ${index}`);
      }
    });
  }

  /**
   * Fetch workouts from Garmin
   */
  async fetchWorkouts(): Promise<GarminWorkoutSummary[]> {
    try {
      console.log("📥 Fetching workouts from Garmin...");

      const authenticated = await this.ensureAuthenticated();
      if (!authenticated) {
        throw new Error("Failed to authenticate with Garmin");
      }

      const workouts = await this.clientAny.getWorkouts?.();
      if (!workouts) {
        throw new Error("getWorkouts is not available on this Garmin client");
      }
      console.log(`✅ Retrieved ${workouts.length} workouts`);

      return workouts.map((workout: any) => ({
        workoutId: workout.workoutId,
        workoutName: workout.workoutName || workout.workoutName?.name || "Unnamed Workout",
        workoutType: workout.workoutType,
        description: workout.description,
      }));
    } catch (error: any) {
      console.error("❌ Failed to fetch workouts:", error.message);
      return [];
    }
  }

  /**
   * Export workouts from Garmin to JSON file
   */
  async exportWorkoutsToFile(outputPath: string = "./data/workouts.json"): Promise<void> {
    const workouts = await this.fetchWorkouts();

    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(workouts, null, 2));
    console.log(`✅ Workouts saved to ${outputPath}`);
  }

  /**
   * Export next week's workout plan template to a temp file
   */
  async exportNextWeekPlanTemp(outputPath: string = "./data/next-week.workouts.tmp.json"): Promise<void> {
    const workouts = await this.fetchWorkouts();
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
  async importWorkoutPlanFromFile(inputPath: string): Promise<WeeklyWorkoutPlan> {
    const raw = fs.readFileSync(inputPath, "utf-8");
    const plan = JSON.parse(raw) as WeeklyWorkoutPlan;
    this.validateWorkoutPlan(plan);
    return plan;
  }

  /**
   * Copy a workout plan to next week (shift dates by 7 days)
   */
  async copyWorkoutPlanToNextWeek(inputPath: string, outputPath: string = "./data/next-week.workouts.tmp.json"): Promise<void> {
    const plan = await this.importWorkoutPlanFromFile(inputPath);
    const shifted: WeeklyWorkoutPlan = {
      ...plan,
      generatedAt: new Date().toISOString(),
      weekStart: this.shiftDate(plan.weekStart, 7),
      weekEnd: this.shiftDate(plan.weekEnd, 7),
      source: "copy-last-week",
      workouts: plan.workouts.map((workout) => ({
        ...workout,
        scheduledDate: workout.scheduledDate ? this.shiftDate(workout.scheduledDate, 7) : undefined,
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
   * Schedule workouts from a plan on Garmin
   */
  async scheduleWorkoutPlan(plan: WeeklyWorkoutPlan): Promise<void> {
    const authenticated = await this.ensureAuthenticated();
    if (!authenticated) {
      throw new Error("Failed to authenticate with Garmin");
    }

    this.validateWorkoutPlan(plan);

    if (!this.clientAny.scheduleWorkout) {
      throw new Error("scheduleWorkout is not available on this Garmin client");
    }

    for (const workout of plan.workouts) {
      if (!workout.scheduledDate) {
        console.warn(`⚠️  Skipping workout without scheduledDate: ${workout.workoutName}`);
        continue;
      }

      const scheduleDate = new Date(workout.scheduledDate);
      if (Number.isNaN(scheduleDate.getTime())) {
        console.warn(`⚠️  Invalid scheduledDate for workout: ${workout.workoutName}`);
        continue;
      }

      let workoutId = workout.workoutId;

      if (!workoutId && workout.workoutType === "running" && workout.distanceMeters) {
        try {
          const created = await this.clientAny.addRunningWorkout?.(
            workout.workoutName,
            workout.distanceMeters,
            workout.description || ""
          );
          workoutId = created?.workoutId;
        } catch (error: any) {
          console.warn(`⚠️  Failed to create running workout: ${workout.workoutName} (${error.message})`);
          continue;
        }
      }

      if (!workoutId) {
        console.warn(`⚠️  Missing workoutId for workout: ${workout.workoutName}`);
        continue;
      }

      try {
        await this.clientAny.scheduleWorkout({ workoutId }, scheduleDate);
        console.log(`✅ Scheduled workout: ${workout.workoutName} on ${workout.scheduledDate}`);
      } catch (error: any) {
        console.warn(`⚠️  Failed to schedule workout: ${workout.workoutName} (${error.message})`);
      }
    }
  }

  /**
   * Filter activities to only include those from last week
   */
  private filterLastWeekActivities(activities: any[]): any[] {
    const { weekStart, weekEnd } = this.getLastWeekDates();
    
    return activities.filter(activity => {
      const activityDate = new Date(activity.startTimeGMT || activity.startTimeLocal);
      return activityDate >= weekStart && activityDate <= weekEnd;
    });
  }

  /**
   * Save activities to JSON file
   */
  async saveActivitiesToFile(
    activities: any[],
    outputPath: string = "./data/activities.json",
    saveRaw: boolean = false,
    filterToLastWeek: boolean = false
  ): Promise<void> {
    try {
      const { weekStart, weekEnd } = this.getLastWeekDates();
      
      // Optionally filter to last week only
      const filteredActivities = filterToLastWeek 
        ? this.filterLastWeekActivities(activities) 
        : activities;

      const data: ExtractedActivities = {
        extractedAt: new Date().toISOString(),
        weekStart: weekStart.toISOString().split('T')[0],
        weekEnd: weekEnd.toISOString().split('T')[0],
        totalActivities: filteredActivities.length,
        activities: this.transformActivities(filteredActivities),
      };

      // Ensure directory exists
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
      console.log(`✅ Activities saved to ${outputPath}`);
      
      // Optionally save raw data for debugging
      if (saveRaw && activities.length > 0) {
        const rawPath = outputPath.replace('.json', '-raw.json');
        fs.writeFileSync(rawPath, JSON.stringify(activities, null, 2));
        console.log(`📋 Raw activities saved to ${rawPath}`);
      }
    } catch (error) {
      console.error("❌ Error saving activities:", error);
      throw error;
    }
  }

  /**
   * Extract activities and save to file
   * @param limit - Max activities to fetch
   * @param outputPath - Output file path
   * @param saveRaw - Save raw API response for debugging
   * @param includeDetails - Fetch detailed data (slower, includes self-evaluation)
   * @param lastWeekOnly - Filter to only include last week's activities
   */
  async extract(
    limit: number = 20, 
    outputPath?: string, 
    saveRaw: boolean = false, 
    includeDetails: boolean = true,
    lastWeekOnly: boolean = false
  ): Promise<boolean> {
    try {
      // Skip authentication in mock mode
      if (!this.mockMode) {
        // Authenticate
        const authenticated = await this.authenticate();
        if (!authenticated) {
          throw new Error("Failed to authenticate with Garmin");
        }
      } else {
        console.log("🔓 Mock mode: Skipping authentication");
      }

      // Fetch activities
      const activities = await this.fetchActivities(limit, includeDetails);
      if (activities.length === 0) {
        console.warn("⚠️  No activities found");
        return false;
      }

      // Save to file
      await this.saveActivitiesToFile(
        activities,
        outputPath || "./data/activities.json",
        saveRaw,
        lastWeekOnly
      );
      return true;
    } catch (error: any) {
      console.error("❌ Extraction failed:", error.message);
      return false;
    }
  }
}

export default GarminExtractor;
