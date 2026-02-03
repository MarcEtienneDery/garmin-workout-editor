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
}

export interface ExtractedActivities {
  extractedAt: string;
  weekStart: string;          // ISO date of week start
  weekEnd: string;            // ISO date of week end
  totalActivities: number;
  activities: GarminActivity[];
}

export default GarminActivity;
