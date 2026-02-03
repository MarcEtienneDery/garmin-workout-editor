# Garmin Workout Editor

Extract your recent activities from Garmin and update your next week's workout using AI.

> **⚠️ Authentication Note:** Direct email/password authentication is currently blocked by Garmin. Use the **session cookie method** instead. See [AUTH_ISSUES.md](AUTH_ISSUES.md) and [GET_SESSION.md](GET_SESSION.md) for solutions.

## Features

- Extract recent activities from Garmin account
- Save activities to JSON file
- Update next week's workout using AI
- Comprehensive test suite with unit and integration tests
- Mock mode for testing without real Garmin credentials
- **Session cookie authentication** (works even with 2FA enabled)

## Setup

### Quick Start (Session Cookie - Recommended)

1. Install dependencies:
```bash
npm install
```

2. Get your session cookie (see [GET_SESSION.md](GET_SESSION.md)):
```bash
# Add to .env file:
GARMIN_SESSION_COOKIE="your_cookie_from_browser"
```

3. Run:
```bash
npm run extract-activities
```

### Alternative: Email & Password (If no 2FA)

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your Garmin credentials:
```
GARMIN_EMAIL=your_email@example.com
GARMIN_PASSWORD="your_password"
```

3. Run:
```bash
npm run extract-activities
```

**Note:** If this fails with "You have been blocked", use the session cookie method instead.

## Usage

### Extract Activities (with Real Garmin Account)

Extract your recent Garmin activities and save to JSON:

```bash
npm run extract-activities
```

This will create an `activities.json` file with your recent 20 activities from your real Garmin Connect account.

You can specify a custom limit and output path:
```bash
npm run extract-activities 30 ./custom/path/activities.json
```

To save raw activity data for debugging (saves first activity as `-raw.json`):
```bash
npm run extract-activities -- --raw
```

To extract **Self Evaluation** (workout ratings) and other detailed data:
```bash
npm run extract-activities 10 -- --detailed
```

**⚠️ Note**: The `--detailed` flag fetches complete activity details including self evaluation. This is slower (~1 second per activity) to avoid rate limiting.

**Requirements**:
- `.env` file with `GARMIN_EMAIL` and `GARMIN_PASSWORD`
- Valid Garmin Connect account credentials
- No 2-factor authentication enabled (support coming soon)

### Extract Activities (Mock Mode - Testing)

Run extraction with mock data without real credentials:

```bash
MOCK_MODE=true npm run extract-activities
```

Or with command-line flag:
```bash
npm run extract-activities -- --mock
```

This generates realistic test data for development and testing purposes.

## Testing

### Run all tests
```bash
npm test
```

### Run tests in watch mode
```bash
npm test:watch
```

### Generate coverage report
```bash
npm run test:coverage
```

### Test Coverage

The project includes:
- **Unit Tests**: Core functionality and edge cases
- **Integration Tests**: End-to-end workflows and data integrity

Current coverage:
- Statements: ~52%
- Functions: ~70%
- Branches: ~37%

## Project Structure

```
src/
├── garminExtractor.ts      # Main Garmin API client with real endpoints
├── types.ts                # TypeScript interfaces
├── extractActivities.ts    # CLI entry point
├── index.ts                # Main export
└── __tests__/
    ├── garminExtractor.test.ts          # Unit tests
    ├── garminExtractor.integration.test.ts  # Integration tests
    └── types.test.ts                    # Type tests
data/
└── activities.json         # Extracted activities (generated)
docs/
└── GARMIN_API.md          # Detailed API documentation
```

## Real Garmin API Endpoints

The application uses the official Garmin Connect API endpoints:

- **Primary**: `https://connect.garmin.com/modern/proxy/activitylist-service/activities/search/activities`
- **Authentication**: `https://sso.garmin.com/sso/signin`

For detailed endpoint information and troubleshooting, see [GARMIN_API.md](GARMIN_API.md).

## Activity Data Structure

Each extracted activity includes comprehensive data organized into categories:

### Basic Information
- `id`: Unique activity identifier
- `activityName`: Name of the activity
- `activityType`: Type (running, cycling, swimming, strength_training, yoga, etc.)
- `eventType`: Event category
- `manufacturer`: Device manufacturer
- `deviceId`: Device identifier
- `workoutId`: Associated workout ID

### Time & Duration
- `startTime`: Activity start time (GMT)
- `startTimeLocal`: Activity start time (local timezone)
- `endTimeGMT`: Activity end time (GMT)
- `duration`: Total duration in seconds
- `elapsedDuration`: Elapsed duration including pauses
- `movingDuration`: Active moving time

### Distance & Speed (Running/Cycling)
- `distance`: Distance in kilometers
- `avgSpeed`: Average speed in m/s
- `maxSpeed`: Maximum speed in m/s
- `avgPace`: Average pace
- `maxPace`: Maximum pace

### Heart Rate
- `calories`: Total calories burned
- `bmrCalories`: BMR calories
- `avgHR`: Average heart rate (bpm)
- `maxHR`: Maximum heart rate (bpm)
- `minHR`: Minimum heart rate (bpm)

### Self Evaluation (requires --detailed flag)
- `selfEvaluation`: Your workout rating/feeling (e.g., 1-5 scale)
- `selfEvaluationFeeling`: Same as selfEvaluation - how you felt after the workout

### Heart Rate Zones (Time in seconds)
- `hrZone1Time`: Time in Zone 1 (recovery)
- `hrZone2Time`: Time in Zone 2 (easy)
- `hrZone3Time`: Time in Zone 3 (aerobic)
- `hrZone4Time`: Time in Zone 4 (threshold)
- `hrZone5Time`: Time in Zone 5 (maximum)

### Intensity
- `moderateIntensityMinutes`: Moderate intensity minutes
- `vigorousIntensityMinutes`: Vigorous intensity minutes

### Running Metrics
- `avgCadence`: Average running cadence (steps/min)
- `maxRunningCadence`: Maximum running cadence
- `strideLength`: Average stride length (cm)
- `steps`: Total step count
- `avgVerticalOscillation`: Average vertical oscillation
- `avgGroundContactTime`: Average ground contact time
- `avgGroundContactBalance`: Average ground contact balance

### Elevation
- `elevationGain`: Total elevation gain (m)
- `elevationLoss`: Total elevation loss (m)
- `minElevation`: Minimum elevation (m)
- `maxElevation`: Maximum elevation (m)
- `elevationCorrected`: Whether elevation was corrected

### Temperature
- `avgTemperature`: Average temperature (°C)
- `maxTemperature`: Maximum temperature (°C)
- `minTemperature`: Minimum temperature (°C)

### Training Effect
- `aerobicTrainingEffect`: Aerobic training effect score
- `aerobicTrainingEffectMessage`: Aerobic benefit description
- `anaerobicTrainingEffect`: Anaerobic training effect score
- `anaerobicTrainingEffectMessage`: Anaerobic benefit description
- `trainingEffectLabel`: Overall training effect label
- `vO2MaxValue`: Estimated VO2 Max

### Power Metrics (Cycling)
- `avgPower`: Average power (watts)
- `maxPower`: Maximum power (watts)
- `normPower`: Normalized power (watts)
- `trainingStressScore`: Training Stress Score (TSS)
- `intensityFactor`: Intensity Factor (IF)

### Strength Training
- `totalSets`: Total number of sets performed
- `totalReps`: Total number of repetitions
- `exerciseSets`: Array of exercise details including:
  - `category`: Exercise category (e.g., BENCH_PRESS, DEADLIFT)
  - `subCategory`: Specific exercise variation
  - `reps`: Number of repetitions
  - `sets`: Number of sets
  - `volume`: Total volume (weight × reps)
  - `maxWeight`: Maximum weight used
  - `duration`: Time spent on exercise

### Activity Metadata
- `lapCount`: Number of laps
- `hasPolyline`: GPS track available
- `hasImages`: Photos attached
- `hasVideo`: Video attached
- `hasSplits`: Lap splits available
- `hasHeatMap`: Heat map data available
- `pr`: Personal records achieved
- `favorite`: Marked as favorite
- `manualActivity`: Manually entered activity

### Body Metrics
- `differenceBodyBattery`: Change in Body Battery

### Location
- `locationName`: Location name (e.g., city)
- `startLatitude`: Starting latitude
- `startLongitude`: Starting longitude

Example strength training activity excerpt:
```json
{
  "id": 21740207949,
  "activityName": "09-25 - Monday",
  "activityType": "strength_training",
  "totalSets": 25,
  "totalReps": 282,
  "exerciseSets": [
    {
      "category": "BENCH_PRESS",
      "subCategory": "BARBELL_BENCH_PRESS",
      "reps": 30,
      "sets": 6,
      "volume": 2498368,
      "maxWeight": 102062
    }
  ]
}
```

Example running activity excerpt:
```json
{
  "id": 21723558307,
  "activityName": "Montreal - Zone 2 Saturday",
  "activityType": "running",
  "distance": 8.56,
  "avgSpeed": 2.82,
  "avgHR": 151,
  "avgCadence": 177.5,
  "hrZone1Time": 26.8,
  "hrZone2Time": 42.7,
  "hrZone3Time": 1888.4,
  "hrZone4Time": 1070.0,
  "vO2MaxValue": 50
}
```