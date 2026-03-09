// Slim activity structure focused on weekly planning metrics
export interface GarminActivity {
  // Identity
  id: string;
  workoutId?: number | string;  // Garmin workout template ID (when activity was based on a workout)
  activityName: string;
  activityType: 'running' | 'strength_training' | 'cycling' | 'swimming' | 'other';
  startTime: string;
  
  // Duration & Distance
  duration: number;           // seconds
  distance?: number;          // km (running/cycling)
  
  // Intensity Metrics
  avgHR?: number;
  maxHR?: number;
  avgPace?: number;           // min/km (running)
  
  // Training Load (key for scaling)
  aerobicTrainingEffect?: number;    // 0-5 scale
  anaerobicTrainingEffect?: number;  // 0-5 scale
  trainingEffectLabel?: string;
  
  // Subjective Feedback
  directWorkoutFeel?: number;        // How fresh: 1-100 (100=perfect, 50=avg, 1=very tired)
  directWorkoutRpe?: number;         // How hard: 1-100 (100=super hard, 50=avg/good target, 1=too easy)
  
  // Recovery Cost
  differenceBodyBattery?: number;
  
  // Intensity Distribution
  moderateIntensityMinutes?: number;
  vigorousIntensityMinutes?: number;
  
  // Running-specific
  avgCadence?: number;
  elevationGain?: number;
  
  // Strength-specific
  totalSets?: number;
  totalReps?: number;
  exerciseSets?: ExerciseSet[];
}

// Strength training exercise details
export interface ExerciseSet {
  exerciseName: string;       // e.g., "Barbell Squat", "Bench Press", "Deadlift"
  category: string;           // e.g., "LEGS", "CHEST", "BACK"
  sets: number;
  reps?: number;              // reps per set (absent when repsList is used)
  repsList?: number[];        // per-set reps when they vary; mutually exclusive with reps
  weight?: number;            // weight used (lbs); absent when weightList is used
  weightList?: number[];      // per-set weight when it varies; mutually exclusive with weight
  volume?: number;            // total load (sum of reps × weight per set)
  supersetGroup?: number;     // shared integer ID for exercises performed as a superset
  // Interval stats (running)
  duration?: number;          // seconds
  distance?: number;          // km
  pace?: number;              // min/km
  avgHR?: number;
  maxHR?: number;
  splitType?: string;
}

export interface ExtractedActivities {
  extractedAt: string;
  weekStart: string;          // ISO date of week start
  weekEnd: string;            // ISO date of week end
  totalActivities: number;
  activities: GarminActivity[];
}

// Workout step/exercise details
export interface WorkoutStep {
  stepType: string;           // e.g., "exercise", "rest", "warmup", "interval", "repeat"
  exerciseName?: string;      // e.g., "BARBELL_BENCH_PRESS", "RUN"
  
  // API-specific fields from IWorkoutStep (preserved from Garmin API)
  targetType?: string;        // e.g., "no.target", "heart.rate.zone", "pace.zone"
  targetValueOne?: number;    // Context-dependent: HR zone min (BPM), pace zone slower limit (m/s), etc.
  targetValueTwo?: number;    // Context-dependent: HR zone max (BPM), pace zone faster limit (m/s), etc.
  endCondition?: string;      // e.g., "reps", "time", "distance", "lap.button", "iterations"
  endConditionValue?: number; // End condition threshold
  weight?: number;            // Equipment weight (lbs, converted from Garmin's tenths of grams)
  weightPercentage?: number;  // Weight as percentage (e.g., 75 for 75% of 1RM)
  benchmarkKey?: string;      // Exercise the percentage is based on (e.g., "BARBELL_BENCH_PRESS")
  stepOrder?: number;         // Step order in sequence (renumbered sequentially after flattening)
  
  // Extracted parallel fields based on endCondition
  reps?: number;              // When endCondition="reps", extracted from endConditionValue
  durationSeconds?: number;   // When endCondition="time", extracted from endConditionValue
  distanceMeters?: number;    // When endCondition="distance", extracted from endConditionValue
  
  // Rest merging
  restTimeSeconds?: number;   // Merged from first subsequent rest step
  
  // Repeat group tracking
  numberOfRepeats?: number;   // From RepeatGroupDTO.numberOfIterations
  repeatGroupIndex?: number;  // Unique index assigned per RepeatGroupDTO during flattening (for round-trip reconstruction)
  repeatSteps?: WorkoutStep[];  // Nested steps within a repeat group
}


// Shared base for all workout-shaped objects
interface WorkoutCore {
  workoutId?: number | string;
  workoutName: string;
  workoutType?: string;
  description?: string;
}

// Minimal workout summary (for backward compatibility)
export interface GarminWorkoutSummary extends WorkoutCore {
  workoutId: number | string; // required for fetched workouts
}

// Detailed workout with full exercise information
export interface DetailedWorkout extends GarminWorkoutSummary {
  steps?: WorkoutStep[];      // Full exercise breakdown
  totalSets?: number;
  totalReps?: number;
  estimatedDurationSeconds?: number;
}

export interface PlannedWorkout extends WorkoutCore {
  distanceMeters?: number;
  scheduledDate?: string; // ISO date (YYYY-MM-DD)
  steps?: WorkoutStep[];  // Full exercise breakdown for import
}

export interface WeeklyWorkoutPlan {
  generatedAt: string;
  weekStart: string;          // ISO date of week start
  weekEnd: string;            // ISO date of week end
  workouts: PlannedWorkout[];
  source?: string;
}

// Training plan configuration for periodized programming
export interface TrainingPlan {
  version: string;
  createdAt: string;
  updatedAt?: string;
  athlete: { name: string; experienceLevel: string };
  goals: { primary: string; secondary?: string; notes?: string };
  strengthBenchmarks: Record<string, { oneRepMax: number; lastUpdated: string }>;
  runningBenchmarks: Record<string, any>;
  periodization: {
    currentPhase: string;
    weekInPhase: number;
    totalWeeksInPhase: number;
    phases: Array<{ name: string; totalWeeks: number; notes?: string }>;
  };
  constraints: Record<string, any>;
  programPrinciples?: Record<string, string[]>;
  weeklyStructure?: Record<string, any>;
  weeklyHistory: WeekSummary[];
}

// Weekly training summary appended to training plan history
export interface WeekSummary {
  weekStart: string;
  weekEnd: string;
  summary: string;
  adherence?: string;
  adjustmentsMade?: string;
}

// Context bundle sent to LLM for workout adjustment
export interface AdjustmentContext {
  activities: ExtractedActivities;
  currentPlan: WeeklyWorkoutPlan;
  trainingPlan: TrainingPlan;
}

// Result of Phase 1 weekly summary LLM call
export interface WeeklySummaryResult {
  summaryText: string;
  phase: string;
  weekInPhase: number;
  readinessSignal: "high" | "moderate" | "low";
}

// Result returned from LLM workout adjustment
export interface AdjustmentResult {
  adjustedPlan: WeeklyWorkoutPlan;
  changeSummary: string;
  llmReasoning: string;
}

