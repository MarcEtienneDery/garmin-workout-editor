import * as fs from "fs";
import * as path from "path";
import { ExtractedActivities, ExerciseSet } from "./shared/types";
import { GarminClient } from "./shared/garminClient";
import {
  generateMockActivities,
  normalizeActivityType as normalizeMockActivityType,
} from "./mocks.setup";

/**
 * Activity extraction and management for Garmin activities
 */
export class ActivityExporter {
  private garminClient: GarminClient;

  constructor(garminClient: GarminClient) {
    this.garminClient = garminClient;
  }

  /**
   * Convert speed (m/s) to pace (min/km)
   */
  private speedToPace(speedMps: number | undefined): number | undefined {
    if (!speedMps || speedMps <= 0) return undefined;
    return 1000 / speedMps / 60; // min/km
  }

  /**
   * Normalize distance to kilometers
   * Garmin often provides meters for laps/intervals
   */
  private normalizeDistanceKm(distance: number | undefined): number | undefined {
    if (distance === undefined || distance === null) return undefined;
    // Heuristic: values over 20 are likely meters
    return distance > 20 ? distance / 1000 : distance;
  }

  /**
   * Calculate pace (min/km) from duration and distance
   */
  private calculatePaceFromDurationAndDistance(
    durationSeconds: number | undefined,
    distanceKm: number | undefined
  ): number | undefined {
    if (!durationSeconds || !distanceKm || distanceKm <= 0) return undefined;
    return durationSeconds / 60 / distanceKm;
  }

  /**
   * Build interval sets for running activities
   */
  private buildIntervalSets(activity: any): ExerciseSet[] {
    const intervalSources = [
      activity.intervals,
      activity.laps,
      activity.splits,
      activity.splitSummaries,
      activity.intervalSummaries,
      activity.lapSummaries,
    ];

    const intervals = intervalSources.find(
      (source) => Array.isArray(source) && source.length > 0
    ) as any[] | undefined;

    if (!intervals || intervals.length === 0) return [];

    const excludedSplitTypes = new Set(["RWD_WALK", "RWD_RUN", "RWD_STAND"]);

    return intervals
      .filter((interval) => {
        const splitType =
          interval.splitType ??
          interval.type ??
          interval.intervalType ??
          interval.stepType ??
          interval.splitTypeKey ??
          interval.lapType;

        if (!splitType) return true;
        return !excludedSplitTypes.has(splitType);
      })
      .map((interval, index) => {
      const duration =
        interval.duration ??
        interval.elapsedDuration ??
        interval.lapDuration ??
        interval.timerDuration ??
        interval.totalTime;

      const rawDistance =
        interval.distance ??
        interval.lapDistance ??
        interval.totalDistance ??
        interval.meters;
      const distance = this.normalizeDistanceKm(rawDistance);

      const avgSpeed = interval.averageSpeed ?? interval.avgSpeed;
      const pace =
        interval.pace ??
        interval.avgPace ??
        this.speedToPace(avgSpeed) ??
        this.calculatePaceFromDurationAndDistance(duration, distance);

      const avgHR =
        interval.avgHR ?? interval.averageHR ?? interval.averageHeartRate;
      const maxHR = interval.maxHR ?? interval.maxHeartRate;

      const intervalName =
        interval.intervalName ??
        interval.lapName ??
        interval.name ??
        interval.splitName;

      const splitType =
        interval.splitType ??
        interval.type ??
        interval.intervalType ??
        interval.stepType ??
        interval.splitTypeKey ??
        interval.lapType;

      return {
        exerciseName: intervalName || `Interval ${index + 1}`,
        category: "INTERVAL",
        sets: 1,
        reps: 0,
        weight: 0,
        volume: 0,
        duration,
        distance,
        pace,
        avgHR,
        maxHR,
        splitType,
      };
    });
  }

  /**
   * Check if exercise is a main powerlifting lift
   */
  private isMainLift(exerciseName: string): boolean {
    const mainLifts = ["BENCH_PRESS", "SQUAT", "DEADLIFT", "OVERHEAD_PRESS"];
    return mainLifts.some((lift) => exerciseName.includes(lift));
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
   * Or more simply: weight_lbs = maxWeight / 453.6
   */
  private convertGarminWeight(maxWeight: number): number {
    if (maxWeight === 0) return 0;
    // Convert from tenths of grams to lbs (1 lb = 453.6g)
    return Math.round(maxWeight / 453.6);
  }

  /**
   * Split warmup, top set, and backoff sets for main lifts
   * Top set is the heaviest set (max weight), warmup sets are lighter, and backoff sets follow
   */
  private splitWarmupTopBackoffSets(set: any): ExerciseSet[] {
    const weight = this.convertGarminWeight(set.maxWeight || 0);
    const totalSets = set.sets || 0;
    const reps = set.reps || 0;
    const baseName = this.formatExerciseName(set.subCategory || set.category);

    if (!this.isMainLift(set.category || "") || totalSets <= 0 || weight === 0) {
      return [
        {
          exerciseName: baseName,
          category: set.category || "UNKNOWN",
          sets: totalSets,
          reps,
          weight,
          volume: set.volume,
        },
      ];
    }

    if (totalSets === 1) {
      return [
        {
          exerciseName: `${baseName} (Top Set)`,
          category: set.category || "UNKNOWN",
          sets: 1,
          reps: Math.max(reps, 1),
          weight,
          volume: Math.max(reps, 1) * weight,
        },
      ];
    }

    const warmupCount =
      totalSets === 2
        ? 1
        : Math.min(Math.max(1, Math.ceil(totalSets * 0.25)), 2);
    const topSetCount = 1;
    const backoffCount = Math.max(totalSets - warmupCount - topSetCount, 0);

    const repsPerSet = Math.max(Math.round(reps / totalSets), 1);
    const warmupRepsPerSet = Math.max(Math.round(repsPerSet * 0.8), 1);
    const topRepsPerSet = repsPerSet;
    const backoffRepsPerSet = repsPerSet;

    const warmupWeight = Math.round(weight * 0.6);
    const topWeight = weight;
    const backoffWeight = Math.round(weight * 0.85);

    const entries: ExerciseSet[] = [];

    if (warmupCount > 0) {
      entries.push({
        exerciseName: `${baseName} (Warmup)`,
        category: set.category || "UNKNOWN",
        sets: warmupCount,
        reps: warmupRepsPerSet,
        weight: warmupWeight,
        volume: warmupCount * warmupRepsPerSet * warmupWeight,
      });
    }

    entries.push({
      exerciseName: `${baseName} (Top Set)`,
      category: set.category || "UNKNOWN",
      sets: topSetCount,
      reps: topRepsPerSet,
      weight: topWeight,
      volume: topSetCount * topRepsPerSet * topWeight,
    });

    if (backoffCount > 0) {
      entries.push({
        exerciseName: `${baseName} (Backoff Set)`,
        category: set.category || "UNKNOWN",
        sets: backoffCount,
        reps: backoffRepsPerSet,
        weight: backoffWeight,
        volume: backoffCount * backoffRepsPerSet * backoffWeight,
      });
    }

    return entries;
  }

  /**
   * Full consolidation pipeline for per-set data from the exerciseSets endpoint.
   * Phase 1+2: merge consecutive same-exercise/same-weight sets (identical reps → sets++, varying reps → repsList).
   * Phase 3: detect repeating exercise-name cycles (supersets) and collapse each exercise within to one entry.
   */
  private consolidateSets(sets: ExerciseSet[]): ExerciseSet[] {
    return this.detectAndMergeSupersets(this.mergeConsecutive(sets));
  }

  private mergeConsecutive(sets: ExerciseSet[]): ExerciseSet[] {
    const result: ExerciseSet[] = [];
    for (const s of sets) {
      const prev = result[result.length - 1];
      if (prev && prev.exerciseName === s.exerciseName) {
        // reps
        if (prev.repsList !== undefined) {
          prev.repsList.push(s.reps ?? 0);
        } else if (prev.reps !== s.reps) {
          prev.repsList = Array(prev.sets).fill(prev.reps ?? 0);
          prev.repsList.push(s.reps ?? 0);
          prev.reps = undefined;
        }
        // weight
        const prevW = prev.weight ?? 0;
        const sW = s.weight ?? 0;
        if (prev.weightList !== undefined) {
          prev.weightList.push(sW);
        } else if (prevW !== sW) {
          prev.weightList = Array(prev.sets).fill(prevW);
          prev.weightList.push(sW);
          prev.weight = undefined;
        }
        prev.sets += 1;
        prev.volume = (prev.volume ?? 0) + (s.volume ?? 0);
      } else {
        result.push({ ...s });
      }
    }
    return result;
  }

  private detectAndMergeSupersets(sets: ExerciseSet[]): ExerciseSet[] {
    if (sets.length < 4) return sets;

    const names = sets.map((s) => s.exerciseName);
    const groupIds = new Array<number>(names.length).fill(0);
    let nextGroupId = 1;
    let i = 0;

    while (i < names.length) {
      const maxCycleLen = Math.floor((names.length - i) / 2);
      let advanced = false;
      for (let L = 2; L <= maxCycleLen; L++) {
        const cycle = names.slice(i, i + L);
        let j = i + L;
        let count = 1;
        while (
          j + L <= names.length &&
          cycle.every((n, k) => names[j + k] === n)
        ) {
          count++;
          j += L;
        }
        if (count >= 2) {
          // include any partial cycle at the end
          let extra = 0;
          while (
            extra < L &&
            j + extra < names.length &&
            names[j + extra] === cycle[extra]
          ) extra++;
          const end = j + extra;
          const gid = nextGroupId++;
          for (let k = i; k < end; k++) groupIds[k] = gid;
          i = end;
          advanced = true;
          break;
        }
      }
      if (!advanced) i++;
    }

    const result: ExerciseSet[] = [];
    let idx = 0;
    while (idx < sets.length) {
      const gid = groupIds[idx];
      if (gid === 0) {
        result.push(sets[idx++]);
      } else {
        let end = idx;
        while (end < sets.length && groupIds[end] === gid) end++;
        result.push(...this.mergeSupersetGroup(sets.slice(idx, end), gid));
        idx = end;
      }
    }
    return result;
  }

  private mergeSupersetGroup(sets: ExerciseSet[], groupId: number): ExerciseSet[] {
    const byName = new Map<string, { entry: ExerciseSet; allReps: number[]; allWeights: number[] }>();
    const order: string[] = [];

    for (const s of sets) {
      const sReps = s.repsList ?? Array(s.sets).fill(s.reps ?? 0);
      const sWeights = s.weightList ?? Array(s.sets).fill(s.weight ?? 0);
      if (!byName.has(s.exerciseName)) {
        order.push(s.exerciseName);
        byName.set(s.exerciseName, {
          entry: { ...s, supersetGroup: groupId },
          allReps: sReps,
          allWeights: sWeights,
        });
      } else {
        const existing = byName.get(s.exerciseName)!;
        existing.allReps.push(...sReps);
        existing.allWeights.push(...sWeights);
        existing.entry.sets += s.sets;
        existing.entry.volume = (existing.entry.volume ?? 0) + (s.volume ?? 0);
      }
    }

    return order.map((name) => {
      const { entry, allReps, allWeights } = byName.get(name)!;
      const result = { ...entry };
      if (allReps.every((r) => r === allReps[0])) {
        result.reps = allReps[0];
        result.repsList = undefined;
      } else {
        result.reps = undefined;
        result.repsList = allReps;
      }
      if (allWeights.every((w) => w === allWeights[0])) {
        result.weight = allWeights[0];
        result.weightList = undefined;
      } else {
        result.weight = undefined;
        result.weightList = allWeights;
      }
      return result;
    });
  }

  /**
   * Fetch recent activities from Garmin
   */
  async fetchActivities(
    limit: number = 20,
    includeDetails: boolean = false
  ): Promise<any[]> {
    try {
      console.log(`📥 Fetching last ${limit} activities from Garmin...`);

      if (this.garminClient.isMockMode()) {
        return generateMockActivities(limit);
      }

      const client = this.garminClient.getClientAny();

      // Use the garmin-connect library's getActivities method
      const activities = await client.getActivities(0, limit);

      console.log(`✅ Retrieved ${activities.length} activities`);

      // Optionally fetch detailed info for each activity (includes self evaluation)
      if (includeDetails) {
        console.log(
          `📋 Fetching detailed info (including self evaluation) for ${activities.length} activities...`
        );
        const detailedActivities = [];

        for (let i = 0; i < activities.length; i++) {
          try {
            const activity = activities[i];
            const details = await client.getActivity({
              activityId: activity.activityId,
            });

            const isStrength = activity.activityType?.typeKey === "strength_training";
            let fullExerciseSets: any[] | undefined;
            if (isStrength) {
              try {
                await new Promise((resolve) => setTimeout(resolve, 200));
                fullExerciseSets = await this.garminClient.getActivityExerciseSets(activity.activityId);
              } catch {
                // fall back to summarizedExerciseSets
              }
            }

            // Merge basic activity data with detailed data
            detailedActivities.push({
              ...activity,
              ...details,
              ...(fullExerciseSets !== undefined && { fullExerciseSets }),
            });

            console.log(`  ✓ ${i + 1}/${activities.length}: ${activity.activityName}`);

            // Add delay to avoid rate limiting (500ms between requests)
            if (i < activities.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          } catch (error: any) {
            console.warn(
              `  ⚠️  Could not fetch details for activity ${activities[i].activityId}: ${error.message}`
            );
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
   * Transform raw Garmin activities to slim format for weekly planning
   */
  private transformActivities(rawActivities: any[]): any[] {
    return rawActivities.map((activity: any) => {
      // If already in transformed shape (seeded from activities.json), return as-is
      if (
        !activity.activityId &&
        activity.id &&
        activity.activityType &&
        activity.startTime
      ) {
        if (
          activity.activityType === "running" &&
          (!activity.exerciseSets || activity.exerciseSets.length === 0)
        ) {
          const intervalSets = this.buildIntervalSets(activity);
          if (intervalSets.length > 0) {
            const {
              intervals,
              laps,
              splits,
              splitSummaries,
              intervalSummaries,
              lapSummaries,
              ...rest
            } = activity;
            return {
              ...rest,
              exerciseSets: intervalSets,
            };
          }
        }

        return activity;
      }

      const activityType = normalizeMockActivityType(
        activity.activityType?.typeKey || activity.activityType
      );

      // Base fields for all activity types
      const base = {
        id: activity.activityId,
        workoutId: activity.workoutId || undefined,
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
        directWorkoutFeel:
          activity.directWorkoutFeel ?? activity.summaryDTO?.directWorkoutFeel,
        directWorkoutRpe:
          activity.directWorkoutRpe ?? activity.summaryDTO?.directWorkoutRpe,

        // Recovery Cost
        differenceBodyBattery: activity.differenceBodyBattery,

        // Intensity Distribution
        moderateIntensityMinutes: activity.moderateIntensityMinutes,
        vigorousIntensityMinutes: activity.vigorousIntensityMinutes,
      };

      // Add running-specific fields
      if (activityType === "running" || activityType === "cycling") {
        const intervalSets =
          activityType === "running" ? this.buildIntervalSets(activity) : [];

        return {
          ...base,
          distance: activity.distance ? activity.distance / 1000 : undefined,
          avgPace: this.speedToPace(activity.averageSpeed),
          avgCadence: activity.averageRunningCadenceInStepsPerMinute,
          elevationGain: activity.elevationGain,
          exerciseSets: intervalSets.length > 0 ? intervalSets : undefined,
        };
      }

      // Add strength-specific fields
      if (activityType === "strength_training") {
        const exerciseSets: ExerciseSet[] = [];

        if (activity.fullExerciseSets?.length > 0) {
          // Per-set data from the exerciseSets endpoint: each entry is one set
          const expanded: ExerciseSet[] = activity.fullExerciseSets
            .filter((set: any) => set.setType === "ACTIVE")
            .map((set: any) => ({
              exerciseName: this.formatExerciseName(set.exercises?.[0]?.name ?? set.exercises?.[0]?.category ?? set.category),
              category: set.exercises?.[0]?.category ?? set.category ?? "UNKNOWN",
              sets: 1,
              reps: set.repetitionCount ?? 0,
              weight: this.convertGarminWeight(set.weight ?? 0),
              volume: (set.repetitionCount ?? 0) * this.convertGarminWeight(set.weight ?? 0),
            }));

          exerciseSets.push(...this.consolidateSets(expanded));
        } else {
          const rawSets =
            activity.summarizedExerciseSets || activity.exerciseSets || [];
          rawSets.forEach((set: any) => {
            const splitSets = this.splitWarmupTopBackoffSets(set);
            exerciseSets.push(...splitSets);
          });
        }

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
   * Get the start and end of last week (Monday-Sunday) in UTC
   */
  private getLastWeekDates(): { weekStart: Date; weekEnd: Date } {
    // Work in UTC to match activity timestamps
    const now = new Date();
    const utcDay = now.getUTCDay();
    const daysSinceMonday = utcDay === 0 ? 6 : utcDay - 1;

    // Last Monday in UTC (start of last week)
    const lastWeekStart = new Date(now);
    lastWeekStart.setUTCDate(now.getUTCDate() - daysSinceMonday - 7);
    lastWeekStart.setUTCHours(0, 0, 0, 0);

    // Last Sunday in UTC (end of last week)
    const lastWeekEnd = new Date(lastWeekStart);
    lastWeekEnd.setUTCDate(lastWeekStart.getUTCDate() + 6);
    lastWeekEnd.setUTCHours(23, 59, 59, 999);

    return { weekStart: lastWeekStart, weekEnd: lastWeekEnd };
  }

  /**
   * Get the start and end of this week (Monday-Sunday) in UTC
   */
  private getThisWeekDates(): { weekStart: Date; weekEnd: Date } {
    // Work in UTC to match activity timestamps
    const now = new Date();
    const utcDay = now.getUTCDay();
    const daysSinceMonday = utcDay === 0 ? 6 : utcDay - 1;

    // This Monday in UTC (start of this week)
    const thisWeekStart = new Date(now);
    thisWeekStart.setUTCDate(now.getUTCDate() - daysSinceMonday);
    thisWeekStart.setUTCHours(0, 0, 0, 0);

    // This Sunday in UTC (end of this week)
    const thisWeekEnd = new Date(thisWeekStart);
    thisWeekEnd.setUTCDate(thisWeekStart.getUTCDate() + 6);
    thisWeekEnd.setUTCHours(23, 59, 59, 999);

    return { weekStart: thisWeekStart, weekEnd: thisWeekEnd };
  }

  /**
   * Filter activities to a specific week
   */
  private filterActivitiesByWeek(
    activities: any[],
    weekDates: { weekStart: Date; weekEnd: Date }
  ): any[] {
    return activities.filter((activity) => {
      const activityDate = new Date(
        activity.startTimeGMT || activity.startTimeLocal
      );
      return (
        activityDate >= weekDates.weekStart &&
        activityDate <= weekDates.weekEnd
      );
    });
  }

  /**
   * Filter activities to only include those from last week
   */
  private filterLastWeekActivities(activities: any[]): any[] {
    const weekDates = this.getLastWeekDates();
    return this.filterActivitiesByWeek(activities, weekDates);
  }

  /**
   * Filter activities to only include those from this week
   */
  private filterThisWeekActivities(activities: any[]): any[] {
    const weekDates = this.getThisWeekDates();
    return this.filterActivitiesByWeek(activities, weekDates);
  }

  /**
   * Filter activities by a custom date range on raw activities
   */
  private filterActivitiesByDateRange(
    activities: any[],
    fromDate: Date,
    toDate?: Date
  ): any[] {
    return activities.filter((activity) => {
      const activityDate = new Date(
        activity.startTimeGMT || activity.startTimeLocal
      );
      if (activityDate < fromDate) return false;
      if (toDate && activityDate > toDate) return false;
      return true;
    });
  }

  /**
   * Filter transformed activities by normalized activity type
   */
  private filterActivitiesByType(
    activities: ReturnType<ActivityExporter["transformActivities"]>,
    typeFilter: string
  ): ReturnType<ActivityExporter["transformActivities"]> {
    const normalizedFilter = typeFilter.toLowerCase().trim();
    return activities.filter((a) => a.activityType === normalizedFilter);
  }

  /**
   * Save activities to JSON file
   */
  async saveActivitiesToFile(
    activities: any[],
    outputPath: string = "./data/activities.json",
    saveRaw: boolean = false,
    filterToLastWeek: boolean = false,
    filterToThisWeek: boolean = false,
    typeFilter?: string,
    customWeekStart?: string,
    customWeekEnd?: string
  ): Promise<void> {
    try {
      let filteredActivities = activities;
      let weekStart: Date;
      let weekEnd: Date;

      if (customWeekStart) {
        weekStart = new Date(customWeekStart);
        weekStart.setUTCHours(0, 0, 0, 0);
        weekEnd = customWeekEnd
          ? new Date(customWeekEnd)
          : new Date(); // default to now
        if (customWeekEnd) weekEnd.setUTCHours(23, 59, 59, 999);
        filteredActivities = this.filterActivitiesByDateRange(
          activities,
          weekStart,
          customWeekEnd ? weekEnd : undefined
        );
        console.log(
          `📅 Filtering to date range: ${weekStart.toISOString().split("T")[0]} → ${
            customWeekEnd ? weekEnd.toISOString().split("T")[0] : "now"
          }`
        );
      } else if (filterToThisWeek) {
        const thisWeekDates = this.getThisWeekDates();
        weekStart = thisWeekDates.weekStart;
        weekEnd = thisWeekDates.weekEnd;
        filteredActivities = this.filterThisWeekActivities(activities);
      } else if (filterToLastWeek) {
        const lastWeekDates = this.getLastWeekDates();
        weekStart = lastWeekDates.weekStart;
        weekEnd = lastWeekDates.weekEnd;
        filteredActivities = this.filterLastWeekActivities(activities);
      } else {
        const lastWeekDates = this.getLastWeekDates();
        weekStart = lastWeekDates.weekStart;
        weekEnd = lastWeekDates.weekEnd;
      }

      let transformed = this.transformActivities(filteredActivities);

      if (typeFilter) {
        const before = transformed.length;
        transformed = this.filterActivitiesByType(transformed, typeFilter);
        console.log(
          `🏃 Filtered by type "${typeFilter}": ${transformed.length} of ${before} activities`
        );
      }

      const data: ExtractedActivities = {
        extractedAt: new Date().toISOString(),
        weekStart: weekStart.toISOString().split("T")[0],
        weekEnd: weekEnd.toISOString().split("T")[0],
        totalActivities: transformed.length,
        activities: transformed,
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
        const rawPath = outputPath.replace(".json", "-raw.json");
        fs.writeFileSync(rawPath, JSON.stringify(activities, null, 2));
        console.log(`📋 Raw activities saved to ${rawPath}`);
      }
    } catch (error) {
      console.error("❌ Error saving activities:", error);
      throw error;
    }
  }

  /**
   * Load raw activities from a JSON file
   */
  async loadRawActivitiesFromFile(inputPath: string): Promise<any[]> {
    try {
      const raw = fs.readFileSync(inputPath, "utf-8");
      const data = JSON.parse(raw);
      
      // If it's already an ExtractedActivities object, extract the activities array
      if (data.activities && Array.isArray(data.activities)) {
        return data.activities;
      }
      
      // If it's already just an array, return it
      if (Array.isArray(data)) {
        return data;
      }
      
      throw new Error("Invalid raw activities file format");
    } catch (error: any) {
      console.error(`❌ Failed to load raw activities from ${inputPath}:`, error.message);
      throw error;
    }
  }

  /**
   * Transform raw activities and save to file without fetching from Garmin
   * Useful for re-running transformation logic on previously saved raw data
   * @param inputPath - Path to raw activities JSON file
   * @param outputPath - Output file path for transformed activities
   * @param weekStart - Optional: Filter/label from this date (ISO format)
   * @param weekEnd - Optional: Filter/label to this date (ISO format)
   * @param typeFilter - Optional: Filter to a specific activity type (e.g. "running")
   */
  async transformAndSave(
    inputPath: string,
    outputPath?: string,
    weekStart?: string,
    weekEnd?: string,
    typeFilter?: string
  ): Promise<boolean> {
    try {
      console.log("📂 Loading raw activities from file...");
      let rawActivities = await this.loadRawActivitiesFromFile(inputPath);
      
      if (rawActivities.length === 0) {
        console.warn("⚠️  No activities found in file");
        return false;
      }

      // Apply date range filter on raw activities if provided
      if (weekStart) {
        const fromDate = new Date(weekStart);
        fromDate.setUTCHours(0, 0, 0, 0);
        const toDate = weekEnd ? new Date(weekEnd) : undefined;
        if (toDate) toDate.setUTCHours(23, 59, 59, 999);
        rawActivities = this.filterActivitiesByDateRange(rawActivities, fromDate, toDate);
        console.log(
          `📅 Filtered to date range: ${fromDate.toISOString().split("T")[0]} → ${
            toDate ? toDate.toISOString().split("T")[0] : "now"
          } (${rawActivities.length} activities)`
        );
      }

      console.log(`📊 Transforming ${rawActivities.length} activities...`);
      let transformed = this.transformActivities(rawActivities);

      if (typeFilter) {
        const before = transformed.length;
        transformed = this.filterActivitiesByType(transformed, typeFilter);
        console.log(
          `🏃 Filtered by type "${typeFilter}": ${transformed.length} of ${before} activities`
        );
      }

      // Use provided dates or calculate from raw data
      let startDate: Date;
      let endDate: Date;

      if (weekStart && weekEnd) {
        startDate = new Date(weekStart);
        endDate = new Date(weekEnd);
      } else {
        const lastWeekDates = this.getLastWeekDates();
        startDate = lastWeekDates.weekStart;
        endDate = lastWeekDates.weekEnd;
      }

      const data: ExtractedActivities = {
        extractedAt: new Date().toISOString(),
        weekStart: startDate.toISOString().split("T")[0],
        weekEnd: endDate.toISOString().split("T")[0],
        totalActivities: transformed.length,
        activities: transformed,
      };

      const outPath = outputPath || inputPath.replace("-raw.json", ".json");
      
      // Ensure directory exists
      const dir = path.dirname(outPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
      console.log(`✅ Transformed activities saved to ${outPath}`);
      return true;
    } catch (error: any) {
      console.error("❌ Transform failed:", error.message);
      return false;
    }
  }

  /**
   * Extract activities and save to file
   * @param limit - Max activities to fetch
   * @param outputPath - Output file path
   * @param saveRaw - Save raw API response for debugging
   * @param includeDetails - Fetch detailed data (slower, includes self-evaluation)
   * @param lastWeekOnly - Filter to only include last week's activities
   * @param thisWeekOnly - Filter to only include this week's activities
   * @param typeFilter - Filter to a specific activity type (e.g. "running")
   * @param customWeekStart - Filter to activities on or after this date (ISO format)
   * @param customWeekEnd - Filter to activities on or before this date (ISO format)
   */
  async extract(
    limit: number = 20,
    outputPath?: string,
    saveRaw: boolean = false,
    includeDetails: boolean = true,
    lastWeekOnly: boolean = false,
    thisWeekOnly: boolean = false,
    typeFilter?: string,
    customWeekStart?: string,
    customWeekEnd?: string
  ): Promise<boolean> {
    try {
      // Skip authentication in mock mode
      if (!this.garminClient.isMockMode()) {
        // Authenticate
        const authenticated = await this.garminClient.authenticate();
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
        lastWeekOnly,
        thisWeekOnly,
        typeFilter,
        customWeekStart,
        customWeekEnd
      );
      return true;
    } catch (error: any) {
      console.error("❌ Extraction failed:", error.message);
      return false;
    }
  }
}

export default ActivityExporter;
