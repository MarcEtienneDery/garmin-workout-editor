// Slim activity structure focused on weekly planning metrics
interface GarminActivity {
  // Identity
  id: string;
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
  selfEvaluationFeeling?: number;    // 1-5 scale
  directWorkoutFeel?: number;        // Garmin self-evaluation feel
  directWorkoutRpe?: number;         // Garmin self-evaluation RPE
  
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
  reps: number;               // reps per set
  weight?: number;            // weight used (lbs)
  volume?: number;            // total load (sets × reps × weight)
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
}


// Minimal workout summary (for backward compatibility)
export interface GarminWorkoutSummary {
  workoutId: number | string;
  workoutName: string;
  workoutType?: string;
  description?: string;
}

// Detailed workout with full exercise information
export interface DetailedWorkout extends GarminWorkoutSummary {
  steps?: WorkoutStep[];      // Full exercise breakdown
  totalSets?: number;
  totalReps?: number;
  estimatedDurationSeconds?: number;
}

export interface PlannedWorkout {
  workoutId?: number | string;
  workoutName: string;
  workoutType?: string;
  description?: string;
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

export default GarminActivity;
