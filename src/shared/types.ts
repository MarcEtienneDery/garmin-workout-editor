export interface GarminActivity {
  id: string;
  workoutId?: number | string;
  activityName: string;
  activityType: 'running' | 'strength_training' | 'cycling' | 'swimming' | 'other';
  startTime: string;
  
  duration: number;
  distance?: number;
  
  avgHR?: number;
  maxHR?: number;
  avgPace?: number;
  
  aerobicTrainingEffect?: number;
  anaerobicTrainingEffect?: number;
  trainingEffectLabel?: string;
  
  directWorkoutFeel?: number;
  directWorkoutRpe?: number;
  
  differenceBodyBattery?: number;
  
  moderateIntensityMinutes?: number;
  vigorousIntensityMinutes?: number;
  
  avgCadence?: number;
  elevationGain?: number;
  
  totalSets?: number;
  totalReps?: number;
  exerciseSets?: ExerciseSet[];
}

export interface ExerciseSet {
  exerciseName: string;
  category: string;
  sets: number;
  reps?: number;
  repsList?: number[];
  weight?: number;
  weightList?: number[];
  volume?: number;
  supersetGroup?: number;
  duration?: number;
  distance?: number;
  pace?: number;
  avgHR?: number;
  maxHR?: number;
  splitType?: string;
  step?: number;
}

export interface ExtractedActivities {
  extractedAt: string;
  weekStart: string;
  weekEnd: string;
  totalActivities: number;
  activities: GarminActivity[];
}

export interface WorkoutStep {
  stepType: string;
  exerciseName?: string;
  
  targetType?: string;
  targetValueOne?: number;
  targetValueTwo?: number;
  endCondition?: string;
  endConditionValue?: number;
  weight?: number;
  weightPercentage?: number;
  benchmarkKey?: string;
  stepOrder?: number;
  
  reps?: number;
  durationSeconds?: number;
  distanceMeters?: number;
  
  restTimeSeconds?: number;
  
  numberOfRepeats?: number;
  repeatGroupIndex?: number;
  repeatSteps?: WorkoutStep[];
}


interface WorkoutCore {
  workoutId?: number | string;
  workoutName: string;
  workoutType?: string;
  description?: string;
}

export interface GarminWorkoutSummary extends WorkoutCore {
  workoutId: number | string;
}

export interface DetailedWorkout extends GarminWorkoutSummary {
  steps?: WorkoutStep[];
  totalSets?: number;
  totalReps?: number;
  estimatedDurationSeconds?: number;
  scheduledDate?: string | string[];
}

export interface PlannedWorkout extends WorkoutCore {
  distanceMeters?: number;
  scheduledDate?: string | string[];
  steps?: WorkoutStep[];
}

export interface WeeklyWorkoutPlan {
  generatedAt: string;
  weekStart: string;
  weekEnd: string;
  workouts: PlannedWorkout[];
  source?: string;
}
