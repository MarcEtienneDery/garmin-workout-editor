import { GarminConnect } from "garmin-connect";
import * as fs from "fs";
import * as path from "path";
import { ExtractedActivities, ExerciseSet } from "./types";

class GarminExtractor {
  private email: string;
  private password: string;
  private client: GarminConnect;
  private mockMode: boolean = false;

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
   * Generate mock activities for testing
   */
  private generateMockActivities(limit: number): any[] {
    const seededActivities = this.loadLastActivitiesFromDisk();
    if (seededActivities && seededActivities.length > 0) {
      const activities: any[] = [];
      for (let i = 0; i < limit; i++) {
        const seed = seededActivities[i % seededActivities.length];
        const daysAgo = Math.floor(Math.random() * 30);
        const date = new Date();
        date.setDate(date.getDate() - daysAgo);
        const timestamp = date.toISOString();
        const typeKey = seed.activityType?.typeKey || seed.activityType;
        const normalizedType = this.normalizeActivityType(typeKey);
        const variance = 0.9 + Math.random() * 0.2; // 0.9-1.1

        const durationSeed = seed.duration || seed.elapsedDuration || 1800;
        const base: any = {
          id: `activity-${i + 1}`,
          activityName: seed.activityName || "Mock Activity",
          activityType: normalizedType,
          startTime: timestamp,
          duration: Math.max(600, Math.round(durationSeed * variance)),
          avgHR: seed.avgHR ?? seed.averageHR ?? Math.floor(Math.random() * 40) + 110,
          maxHR: seed.maxHR ?? seed.maxHR ?? Math.floor(Math.random() * 30) + 140,
          trainingEffectLabel: seed.trainingEffectLabel || (normalizedType === "other" ? "UNKNOWN" : "AEROBIC_BASE"),
          differenceBodyBattery: seed.differenceBodyBattery ?? -Math.floor(Math.random() * 12) - 3,
          moderateIntensityMinutes: seed.moderateIntensityMinutes ?? Math.floor(Math.random() * 40),
          vigorousIntensityMinutes: seed.vigorousIntensityMinutes ?? Math.floor(Math.random() * 20),
          selfEvaluationFeeling: seed.selfEvaluationFeeling,
          directWorkoutFeel: seed.directWorkoutFeel ?? seed.summaryDTO?.directWorkoutFeel,
          directWorkoutRpe: seed.directWorkoutRpe ?? seed.summaryDTO?.directWorkoutRpe,
        };

        if (normalizedType === "running") {
          const distanceSeed = seed.distance ?? 8;
          base.distance = Math.round(distanceSeed * variance * 1000) / 1000;
          base.avgPace = seed.avgPace ?? Math.round((5 + Math.random()) * 1000) / 1000;
          base.avgCadence = seed.avgCadence ?? Math.floor(Math.random() * 15) + 170;
          base.elevationGain = seed.elevationGain ?? Math.floor(Math.random() * 60) + 10;
        } else if (normalizedType === "strength_training") {
          const exerciseSets = seed.exerciseSets || [];
          base.totalSets = seed.totalSets ?? exerciseSets.reduce((sum: number, ex: any) => sum + (ex.sets || 0), 0);
          base.totalReps = seed.totalReps ?? exerciseSets.reduce((sum: number, ex: any) => sum + (ex.reps || 0), 0);
          base.exerciseSets = exerciseSets;
        }

        activities.push(base);
      }

      return activities;
    }

    const activityTypes = ["strength_training", "running", "other"];
    
    // Strength exercises modeled after activities.json (weights in lbs)
    const strengthExercises: { category: string; subCategory?: string; typicalWeight: number }[] = [
      { category: "BENCH_PRESS", subCategory: "BARBELL_BENCH_PRESS", typicalWeight: 185 },
      { category: "DEADLIFT", subCategory: "BARBELL_DEADLIFT", typicalWeight: 250 },
      { category: "SQUAT", subCategory: "BARBELL_SQUAT", typicalWeight: 225 },
      { category: "ROW", subCategory: "BARBELL_ROW", typicalWeight: 155 },
      { category: "CURL", subCategory: "DUMBBELL_CURL", typicalWeight: 60 },
      { category: "TRICEPS_EXTENSION", subCategory: "CABLE_OVERHEAD_TRICEPS_EXTENSION", typicalWeight: 80 },
      { category: "HIP_RAISE", subCategory: "BARBELL_HIP_THRUST", typicalWeight: 185 },
      { category: "LUNGE", subCategory: "DUMBBELL_SPLIT_SQUAT", typicalWeight: 60 },
      { category: "SHOULDER_PRESS", subCategory: "DUMBBELL_SHOULDER_PRESS", typicalWeight: 55 },
      { category: "PULL_UP", subCategory: "WEIGHTED_PULL_UP", typicalWeight: 10 },
      { category: "PLANK", subCategory: "SIDE_PLANK", typicalWeight: 0 },
      { category: "CARDIO", subCategory: "CARDIO", typicalWeight: 0 },
    ];
    
    const activities: any[] = [];

    for (let i = 0; i < limit; i++) {
      const daysAgo = Math.floor(Math.random() * 30);
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      const activityType = activityTypes[i % activityTypes.length];

      const baseActivity: any = {
        activityId: `activity-${i + 1}`,
        activityName:
          activityType === "strength_training"
            ? `Strength Session ${i + 1}`
            : activityType === "running"
            ? `Zone 2 Run ${i + 1}`
            : `Yoga ${i + 1}`,
        activityType: { typeKey: activityType },
        startTimeGMT: date.toISOString(),
        startTimeLocal: date.toISOString(),
        duration:
          activityType === "strength_training"
            ? Math.floor(Math.random() * 1800) + 2400 // 40-70 min
            : activityType === "running"
            ? Math.floor(Math.random() * 1800) + 1500 // 25-55 min
            : Math.floor(Math.random() * 900) + 1200, // 20-35 min
        averageHR:
          activityType === "other"
            ? Math.floor(Math.random() * 20) + 70
            : Math.floor(Math.random() * 40) + 110,
        maxHR:
          activityType === "other"
            ? Math.floor(Math.random() * 15) + 95
            : Math.floor(Math.random() * 30) + 140,
        aerobicTrainingEffect:
          activityType === "other"
            ? 0.0
            : Math.round((Math.random() * 3 + 2) * 10) / 10, // 2.0 - 5.0
        anaerobicTrainingEffect:
          activityType === "strength_training"
            ? Math.round((Math.random() * 2 + 1) * 10) / 10 // 1.0 - 3.0
            : 0.0,
        trainingEffectLabel:
          activityType === "strength_training"
            ? "ANAEROBIC_CAPACITY"
            : activityType === "running"
            ? "AEROBIC_BASE"
            : "UNKNOWN",
        selfEvaluationFeeling: Math.floor(Math.random() * 5) + 1, // 1-5
        directWorkoutFeel: Math.floor(Math.random() * 100),
        directWorkoutRpe: Math.floor(Math.random() * 20) + 1,
        differenceBodyBattery:
          activityType === "other"
            ? -Math.floor(Math.random() * 4) - 1
            : -Math.floor(Math.random() * 12) - 3,
        moderateIntensityMinutes:
          activityType === "other" ? 0 : Math.floor(Math.random() * 40),
        vigorousIntensityMinutes:
          activityType === "running"
            ? Math.floor(Math.random() * 60)
            : activityType === "strength_training"
            ? Math.floor(Math.random() * 15)
            : 0,
      };

      // Add type-specific fields
      if (activityType === "strength_training") {
        const numExercises = Math.floor(Math.random() * 3) + 4; // 4-6 exercises
        const usedIndices = new Set<number>();
        const exerciseSets = [];

        while (exerciseSets.length < numExercises && usedIndices.size < strengthExercises.length) {
          const idx = Math.floor(Math.random() * strengthExercises.length);
          if (usedIndices.has(idx)) continue;
          usedIndices.add(idx);

          const exercise = strengthExercises[idx];
          const sets = Math.floor(Math.random() * 2) + 2; // 2-3 sets
          const repsPerSet = Math.floor(Math.random() * 8) + 5; // 5-12 reps
          const totalReps = sets * repsPerSet;
          const weightLbs = exercise.typicalWeight > 0
            ? Math.round(exercise.typicalWeight * (0.8 + Math.random() * 0.4))
            : 0;
          const maxWeight = weightLbs > 0 ? Math.round(weightLbs * 453.6) : 0; // tenths of grams
          const volume = maxWeight > 0 ? sets * repsPerSet * maxWeight : 0;

          exerciseSets.push({
            category: exercise.category,
            subCategory: exercise.subCategory,
            sets,
            reps: totalReps,
            maxWeight,
            volume,
          });
        }

        baseActivity.totalSets = exerciseSets.reduce((sum, ex) => sum + ex.sets, 0);
        baseActivity.totalReps = exerciseSets.reduce((sum, ex) => sum + ex.reps, 0);
        baseActivity.summarizedExerciseSets = exerciseSets;
      } else if (activityType === "running") {
        baseActivity.distance = Math.floor(Math.random() * 6000) + 5000; // 5-11 km in meters
        baseActivity.averageSpeed = Math.random() * 1.5 + 2.6; // 2.6-4.1 m/s
        baseActivity.averageRunningCadenceInStepsPerMinute = Math.floor(Math.random() * 15) + 170;
        baseActivity.elevationGain = Math.floor(Math.random() * 60) + 10;
      }

      activities.push(baseActivity);
    }

    return activities;
  }

  /**
   * Load the last 4 activities from disk to seed mock data
   */
  private loadLastActivitiesFromDisk(): any[] | null {
    try {
      const activitiesPath = path.join(__dirname, "../data/activities.json");
      if (fs.existsSync(activitiesPath)) {
        const raw = fs.readFileSync(activitiesPath, "utf-8");
        const parsed = JSON.parse(raw);
        const activities = parsed?.activities || [];
        return activities.slice(-4);
      }
    } catch (error) {
      console.warn("⚠️  Could not load activities.json for mock seeding");
    }

    try {
      const rawPath = path.join(__dirname, "../data/activities-raw.json");
      if (fs.existsSync(rawPath)) {
        const raw = fs.readFileSync(rawPath, "utf-8");
        const parsed = JSON.parse(raw);
        return parsed ? [parsed] : null;
      }
    } catch (error) {
      console.warn("⚠️  Could not load activities-raw.json for mock seeding");
    }

    return null;
  }

  /**
   * Fetch recent activities from Garmin
   */
  async fetchActivities(limit: number = 20, includeDetails: boolean = false): Promise<any[]> {
    try {
      console.log(`📥 Fetching last ${limit} activities from Garmin...`);

      if (this.mockMode) {
        return this.generateMockActivities(limit);
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
   * Normalize activity type to our categories
   */
  private normalizeActivityType(rawType: string | undefined): 'running' | 'strength_training' | 'cycling' | 'swimming' | 'other' {
    const type = (rawType || '').toLowerCase();
    if (type.includes('run') || type.includes('trail')) return 'running';
    if (type.includes('strength') || type.includes('weight')) return 'strength_training';
    if (type.includes('cycl') || type.includes('bik')) return 'cycling';
    if (type.includes('swim') || type.includes('pool')) return 'swimming';
    return 'other';
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

      const activityType = this.normalizeActivityType(activity.activityType?.typeKey || activity.activityType);
      
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
