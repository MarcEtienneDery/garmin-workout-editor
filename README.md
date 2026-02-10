# Garmin Workout Editor

Extract your recent activities from Garmin and update your next week's workout using AI.

> **⚠️ Authentication Note:** Direct email/password authentication is currently blocked by Garmin. Use the **session cookie method** instead. See [AUTH_ISSUES.md](AUTH_ISSUES.md) and [GET_SESSION.md](GET_SESSION.md) for solutions.

## Features

- Extract recent activities from Garmin account
- Save activities to JSON file
- Update next week's workout using AI
- Export workouts from Garmin to JSON
- Generate a temporary next-week workout plan file for manual edits
- Copy a workout plan to next week (shift dates by 7 days)
- Schedule a workout plan to Garmin calendar
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

Detailed mode is enabled by default and fetches complete activity details including self evaluation. This is slower (~1 second per activity) to avoid rate limiting.

To disable detailed mode:
```bash
npm run extract-activities 10 -- --no-detailed
```

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

## Manage Workouts (Import/Export & Planning)

All workout commands use the `manage-workouts` script:

```bash
npm run manage-workouts -- <flags>
```

### Export Workouts from Garmin

Export all your Garmin workouts with full exercise details to JSON:

```bash
npm run manage-workouts -- --export
```

Custom output path:

```bash
npm run manage-workouts -- --export --output ./data/workouts.json
```

To save raw workout data for debugging:

```bash
npm run manage-workouts -- --export --raw
```

### Transform Workouts (No API Fetch)

Re-transform saved raw workout data without hitting the API:

```bash
npm run manage-workouts -- --transform-only data/workouts-raw.json
```

With custom week dates:

```bash
npm run manage-workouts -- --transform-only data/workouts-raw.json \
  --week-start 2026-02-02 --week-end 2026-02-08
```

### Generate a Next-Week Workout Plan Template

Create a workout plan template file for next week that you can edit manually:

```bash
npm run manage-workouts -- --generate-template
```

Custom output path:

```bash
npm run manage-workouts -- --generate-template --template-output ./data/next-week.workouts.tmp.json
```

### Copy Workout Plan to Next Week (Shift +7 Days)

Copy an existing workout plan and shift all dates to next week:

```bash
npm run manage-workouts -- --copy-next-week ./data/last-week.plan.json
```

Custom output path:

```bash
npm run manage-workouts -- --copy-next-week ./data/last-week.plan.json \
  --template-output ./data/next-week.plan.json
```

### Schedule Workouts to Garmin Calendar

Schedule workouts from a plan file (requires existing workout IDs in Garmin):

```bash
npm run manage-workouts -- --schedule ./data/next-week.workouts.tmp.json
```

### Upload and Schedule Workouts (Plan File)

Upload workout definitions from a plan file and add them to your Garmin calendar (creates new workouts as needed):

```bash
npm run manage-workouts -- --upload-and-schedule ./data/next-week.workouts.tmp.json
```

### Upload Workouts to Garmin (Workout Library)

Upload workouts from a workouts file to your Garmin library (creates or replaces workouts only, no calendar scheduling):

```bash
npm run manage-workouts -- --upload ./data/workouts.json
```

Validate workouts without uploading (dry-run):

```bash
npm run manage-workouts -- --upload ./data/workouts.json --dry-run
```

Upload a single workout by ID:

```bash
npm run manage-workouts -- --upload-single 12345678
```

Specify a custom workouts file:

```bash
npm run manage-workouts -- --upload-single 12345678 --file ./data/workouts.json
```

**Note:** After uploading, run `--export` to sync the new workout IDs to your local file.

### Mock Mode for Testing

All workout commands support mock mode for testing without real credentials:

```bash
npm run manage-workouts -- --export --mock
npm run manage-workouts -- --generate-template --mock
```

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