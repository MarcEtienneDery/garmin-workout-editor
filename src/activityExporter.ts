import { ExtractedActivities, ExerciseSet } from "./shared/types";
import { GarminClient, GarminRawSet } from "./shared/garminClient";
import {
  generateMockActivities,
  normalizeActivityType as normalizeMockActivityType,
} from "./mocks.setup";

export function getLastNWeeksStart(n: number): string {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const daysSinceMonday = utcDay === 0 ? 6 : utcDay - 1;
  const start = new Date(now);
  start.setUTCDate(now.getUTCDate() - daysSinceMonday - (n - 1) * 7);
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString().split("T")[0];
}

export interface BuildActivitiesOptions {
  filterToLastWeek?: boolean;
  filterToThisWeek?: boolean;
  typeFilter?: string;
  customWeekStart?: string;
  customWeekEnd?: string;
}

export class ActivityExporter {
  private garminClient: GarminClient;

  constructor(garminClient: GarminClient) {
    this.garminClient = garminClient;
  }

  private speedToPace(speedMps: number | undefined): number | undefined {
    if (!speedMps || speedMps <= 0) return undefined;
    return 1000 / speedMps / 60;
  }

  private normalizeDistanceKm(distance: number | undefined): number | undefined {
    if (distance === undefined || distance === null) return undefined;
    return distance > 20 ? distance / 1000 : distance;
  }

  private calculatePaceFromDurationAndDistance(
    durationSeconds: number | undefined,
    distanceKm: number | undefined
  ): number | undefined {
    if (!durationSeconds || !distanceKm || distanceKm <= 0) return undefined;
    return durationSeconds / 60 / distanceKm;
  }

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

  private isMainLift(exerciseName: string): boolean {
    const mainLifts = ["BENCH_PRESS", "SQUAT", "DEADLIFT", "OVERHEAD_PRESS"];
    return mainLifts.some((lift) => exerciseName.includes(lift));
  }

  private formatExerciseName(subcategoryKey: string | undefined): string {
    if (!subcategoryKey) return "Unknown Exercise";
    return subcategoryKey
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
  }

  private convertGarminWeight(maxWeight: number): number {
    if (maxWeight === 0) return 0;
    return Math.round(maxWeight / 453.6);
  }

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

  private consolidateSets(sets: ExerciseSet[]): ExerciseSet[] {
    return this.detectAndMergeSupersets(this.mergeConsecutive(sets));
  }

  private mergeConsecutive(sets: ExerciseSet[]): ExerciseSet[] {
    const result: ExerciseSet[] = [];
    for (const s of sets) {
      const prev = result[result.length - 1];
      if (prev && prev.exerciseName === s.exerciseName) {
        if (prev.repsList !== undefined) {
          prev.repsList.push(s.reps ?? 0);
        } else if (prev.reps !== s.reps) {
          prev.repsList = Array(prev.sets).fill(prev.reps ?? 0);
          prev.repsList.push(s.reps ?? 0);
          prev.reps = undefined;
        }
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

      const activities = await client.getActivities(0, limit);

      console.log(`✅ Retrieved ${activities.length} activities`);

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
            let fullExerciseSets: GarminRawSet[] | undefined;
            if (isStrength) {
              try {
                await new Promise((resolve) => setTimeout(resolve, 200));
                fullExerciseSets = await this.garminClient.getActivityExerciseSets(activity.activityId);
              } catch {
              }
            }

            detailedActivities.push({
              ...activity,
              ...details,
              ...(fullExerciseSets !== undefined && { fullExerciseSets }),
            });

            console.log(`  ✓ ${i + 1}/${activities.length}: ${activity.activityName}`);

            if (i < activities.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          } catch (error: any) {
            console.warn(
              `  ⚠️  Could not fetch details for activity ${activities[i].activityId}: ${error.message}`
            );
            detailedActivities.push(activities[i]);
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

  slim(rawActivities: any[]): any[] {
    return this.transformActivities(rawActivities);
  }

  private transformActivities(rawActivities: any[]): any[] {
    return rawActivities.map((activity: any) => {
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

      const base = {
        id: activity.activityId,
        workoutId: activity.workoutId || undefined,
        activityName: activity.activityName || "Unknown Activity",
        activityType,
        startTime: activity.startTimeGMT || activity.startTimeLocal,
        duration: activity.duration || activity.elapsedDuration || 0,

        avgHR: activity.averageHR,
        maxHR: activity.maxHR,

        aerobicTrainingEffect: activity.aerobicTrainingEffect,
        anaerobicTrainingEffect: activity.anaerobicTrainingEffect,
        trainingEffectLabel: activity.trainingEffectLabel,

        directWorkoutFeel:
          activity.directWorkoutFeel ?? activity.summaryDTO?.directWorkoutFeel,
        directWorkoutRpe:
          activity.directWorkoutRpe ?? activity.summaryDTO?.directWorkoutRpe,

        differenceBodyBattery: activity.differenceBodyBattery,

        moderateIntensityMinutes: activity.moderateIntensityMinutes,
        vigorousIntensityMinutes: activity.vigorousIntensityMinutes,
      };

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

      if (activityType === "strength_training") {
        const exerciseSets: ExerciseSet[] = [];

        if (activity.fullExerciseSets?.length > 0) {
          const expanded: ExerciseSet[] = (activity.fullExerciseSets as GarminRawSet[])
            .filter((set) => set.setType === "ACTIVE")
            .map((set) => ({
              exerciseName: this.formatExerciseName(set.exercises[0]?.name ?? set.exercises[0]?.category ?? "UNKNOWN"),
              category: set.exercises[0]?.category ?? "UNKNOWN",
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

  private getLastWeekDates(): { weekStart: Date; weekEnd: Date } {
    const now = new Date();
    const utcDay = now.getUTCDay();
    const daysSinceMonday = utcDay === 0 ? 6 : utcDay - 1;

    const lastWeekStart = new Date(now);
    lastWeekStart.setUTCDate(now.getUTCDate() - daysSinceMonday - 7);
    lastWeekStart.setUTCHours(0, 0, 0, 0);

    const lastWeekEnd = new Date(lastWeekStart);
    lastWeekEnd.setUTCDate(lastWeekStart.getUTCDate() + 6);
    lastWeekEnd.setUTCHours(23, 59, 59, 999);

    return { weekStart: lastWeekStart, weekEnd: lastWeekEnd };
  }

  private getThisWeekDates(): { weekStart: Date; weekEnd: Date } {
    const now = new Date();
    const utcDay = now.getUTCDay();
    const daysSinceMonday = utcDay === 0 ? 6 : utcDay - 1;

    const thisWeekStart = new Date(now);
    thisWeekStart.setUTCDate(now.getUTCDate() - daysSinceMonday);
    thisWeekStart.setUTCHours(0, 0, 0, 0);

    const thisWeekEnd = new Date(thisWeekStart);
    thisWeekEnd.setUTCDate(thisWeekStart.getUTCDate() + 6);
    thisWeekEnd.setUTCHours(23, 59, 59, 999);

    return { weekStart: thisWeekStart, weekEnd: thisWeekEnd };
  }

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

  private filterLastWeekActivities(activities: any[]): any[] {
    const weekDates = this.getLastWeekDates();
    return this.filterActivitiesByWeek(activities, weekDates);
  }

  private filterThisWeekActivities(activities: any[]): any[] {
    const weekDates = this.getThisWeekDates();
    return this.filterActivitiesByWeek(activities, weekDates);
  }

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

  private filterActivitiesByType(
    activities: ReturnType<ActivityExporter["transformActivities"]>,
    typeFilter: string
  ): ReturnType<ActivityExporter["transformActivities"]> {
    const normalizedFilter = typeFilter.toLowerCase().trim();
    return activities.filter((a) => a.activityType === normalizedFilter);
  }

  buildExtractedActivities(
    activities: any[],
    options: BuildActivitiesOptions = {}
  ): ExtractedActivities {
    const {
      filterToLastWeek = false,
      filterToThisWeek = false,
      typeFilter,
      customWeekStart,
      customWeekEnd,
    } = options;

    let filteredActivities = activities;
    let weekStart: Date;
    let weekEnd: Date;

    if (customWeekStart) {
      weekStart = new Date(customWeekStart);
      weekStart.setUTCHours(0, 0, 0, 0);
      weekEnd = customWeekEnd
        ? new Date(customWeekEnd)
        : new Date();
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

    return {
      extractedAt: new Date().toISOString(),
      weekStart: weekStart.toISOString().split("T")[0],
      weekEnd: weekEnd.toISOString().split("T")[0],
      totalActivities: transformed.length,
      activities: transformed,
    };
  }
}

let stored: ActivityExporter | undefined;

export function slimStored(raw: any, detail: any): any | null {
  stored ??= new ActivityExporter(null as never);
  return stored.slim([{ ...(raw ?? {}), ...(detail ?? {}) }])[0] ?? null;
}

export default ActivityExporter;
