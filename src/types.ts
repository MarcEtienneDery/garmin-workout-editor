interface GarminActivity {
  id: string;
  activityName: string;
  activityType: string;
  startTime: string;
  duration: number; // in seconds
  distance: number; // in km
  calories: number;
  avgHR?: number;
  maxHR?: number;
  avgPace?: string;
  maxPace?: string;
  elevation?: number;
  avgCadence?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  [key: string]: any; // for additional Garmin-specific fields
}

export interface ExtractedActivities {
  extractedAt: string;
  totalActivities: number;
  activities: GarminActivity[];
}

export default GarminActivity;
