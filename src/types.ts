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

export interface GarminWorkoutSummary {
  workoutId: number | string;
  workoutName: string;
  workoutType?: string;
  description?: string;
}

export interface PlannedWorkout {
  workoutId?: number | string;
  workoutName: string;
  workoutType?: string;
  description?: string;
  distanceMeters?: number;
  scheduledDate?: string | string[]; // ISO date (YYYY-MM-DD) or list of ISO dates
}

export interface WeeklyWorkoutPlan {
  generatedAt: string;
  weekStart: string;          // ISO date of week start
  weekEnd: string;            // ISO date of week end
  workouts: PlannedWorkout[];
  source?: string;
}

export default GarminActivity;
