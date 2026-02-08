# Copilot Instructions for Garmin Workout Editor

## Project Architecture

A TypeScript CLI tool with two independent workflows: activity extraction from Garmin Connect API and workout plan management. Both workflows support mock mode and follow a **fetch → transform → save** pattern, with a special **transform-only** mode that decouples API fetching from data transformation.

**Entry Points:**
- `exportActivities.ts` - Activity extraction and transformation pipeline
- `manageWorkouts.ts` - Workout management (export, import, schedule)

**Core Services:**
- `GarminClient` - Centralized Garmin API authentication via email/password or session cookie (mock mode always available)
- `ActivityExporter` - Fetches activities, transforms to slim format, handles interval/exercise parsing
- `WorkoutEditor` - Manages workouts, flattens nested Garmin structures, converts units (weight to lbs)
- `Types` - Unified type system ([shared/types.ts](../src/shared/types.ts)) with `GarminActivity`, `DetailedWorkout`, `WorkoutStep`

### Authentication

Use `ensureAuthenticated()` before any API call - it's mock-safe:
```typescript
const garminClient = new GarminClient(email, password, mockMode);
await garminClient.ensureAuthenticated();
```

⚠️ **Session cookie method recommended** - direct email/password blocked by Garmin 2FA (see README.md)

## Testing Philosophy

Tests are organized in `src/__tests__/` with Jest configured for **single-worker execution** (`maxWorkers: 1` in jest.config.js) to prevent concurrency issues.

**Test Types:**
- **Unit tests** - Mock `@flow-js/garmin-connect` using Jest (see `activityExporter.test.ts` for pattern)
- **Integration tests** - Hit real Garmin API with credentials (marked with `.integration.test.ts`)

**Running Tests:**
```bash
npm test                  # All tests, single worker
npm run test:watch       # Watch mode
npm run test:coverage    # Coverage report
```

**Mock Data Strategy:**
- `mocks.setup.ts` provides `generateMockActivities()` and `generateMockWorkouts()`
- Seeded from last 4 items in `data/activities.json` or `data/workouts-raw.json` if available
- Fallback: generates synthetic data matching Garmin API shape
- Use `GarminClient(..., mockMode=true)` to enable mock without real credentials

## Transform-Only Workflow

Both `ActivityExporter` and `WorkoutEditor` support **transform-only mode** - re-run transformation logic on saved raw data without hitting the API. This avoids rate limits and enables faster iteration.

**Activities:**
```bash
# First: Fetch raw data (once)
npm run export-activities -- 20 --raw

# Then: Re-transform without API calls
npm run export-activities -- --transform-only data/activities-raw.json
npm run export-activities -- --transform-only data/activities-raw.json \
  --week-start 2026-02-02 --week-end 2026-02-08
```

**Workouts:**
```bash
# First: Fetch raw data (once)
npm run manage-workouts -- --export --raw

# Then: Re-transform without API calls
npm run manage-workouts -- --transform-only data/workouts-raw.json
```

**Implementation:** `ActivityExporter.transformAndSave()` and `WorkoutEditor.transformAndSaveWorkouts()` handle the transform-only path. Fetch and transform are completely decoupled.

### Activity Type Normalization

Activity types from Garmin are normalized to 5 categories in [types.ts](../src/types.ts):
```typescript
'running' | 'strength_training' | 'cycling' | 'swimming' | 'other'
```

Use `normalizeActivityType()` helper when transforming raw Garmin data.

### Exercise & Interval Processing

**Running activities** use `buildIntervalSets()` to extract lap/interval data from `activity.intervals`, `activity.laps`, `activity.splits` (tries multiple sources):
- Filters out walk/stand intervals (`RWD_WALK`, `RWD_RUN`, `RWD_STAND`)
- Normalizes distance: values >20m assumed to be meters, converted to km
- Calculates pace from speed (m/s → min/km) or duration/distance
- Returns `ExerciseSet[]` with pace, distance, avgHR, maxHR, duration, splitType

**Strength activities** use `splitWarmupTopBackoffSets()` for main lifts (bench/squat/deadlift/overhead):
- Warmup phase: ~60% of weight, 80% of reps
- Top set: max weight, full reps
- Backoff phase: ~85% of weight, full reps
- Non-main lifts return as single entry
- Weight stored in tenths of grams in Garmin; convert with `weight / 453.6` for lbs

### Date Handling

- **Week boundaries**: Monday-Sunday in UTC
- **Workout scheduling**: Uses ISO date strings (`YYYY-MM-DD`)
- **Activity timestamps**: ISO 8601 format from Garmin API

Week calculation logic is in `getWeekDates()` methods (activity exporter) and `getNextWeekDates()` (workout editor).

### Data Structures

All extracted activities follow the `ExtractedActivities` interface with metadata:
```typescript
{
  extractedAt: string;    // ISO timestamp
  weekStart: string;      // ISO date (Monday)
  weekEnd: string;        // ISO date (Sunday)
  totalActivities: number;
  activities: GarminActivity[];
}
```

Workouts use `WeeklyWorkoutPlan` with similar structure plus `source` field for tracking plan origin.

## CLI Command Patterns

Entry points are [exportActivities.ts](../src/exportActivities.ts) and [manageWorkouts.ts](../src/manageWorkouts.ts). They follow this pattern:
1. Load `.env` with `dotenv`
2. Parse CLI args (limit, paths, flags)
3. Initialize `GarminClient` with mock mode support
4. Execute operation via exporter/editor class

**Activity Export:**
```bash
npm run export-activities                  # Last 20 activities
npm run export-activities -- 50            # Last 50 activities
npm run export-activities -- 20 --raw      # Save raw API response too
npm run export-activities -- --transform-only data/activities-raw.json  # Re-transform saved raw
```

**Workout Management:**
```bash
npm run manage-workouts -- --export                    # Export all workouts
npm run manage-workouts -- --export --raw             # Export with raw API data
npm run manage-workouts -- --generate-template        # Generate next-week template
npm run manage-workouts -- --schedule <file>          # Schedule workouts from file
npm run manage-workouts -- --transform-only <file>    # Re-transform saved raw
```

Common flags work on both:
- `--mock`: Use test data instead of real API
- `--raw`: Save raw Garmin response for debugging
- `--output <path>`: Override output file path

## Rate Limiting

Detailed activity fetching includes 1-second delays between requests to avoid Garmin rate limits:
```typescript
await new Promise(resolve => setTimeout(resolve, 1000));
```

This pattern appears in both activity and workout detail fetches.

## Garmin API Quirks

- **Weight encoding**: Garmin stores weight in tenths of grams. Convert to lbs: `weight_lbs = maxWeight / 453.6`
- **Exercise names**: Stored as SCREAMING_SNAKE_CASE (e.g., `BARBELL_BENCH_PRESS`). Transform to title case with `formatExerciseName()`
- **Workout steps**: Nested structure with `workoutSteps` arrays + `RepeatGroupDTO` wrappers. Flatten recursively using `flattenSteps()`, then merge first rest step into preceding exercise as `restTimeSeconds`
- **Interval sources**: Check multiple fields (`intervals`, `laps`, `splits`, `splitSummaries`, `intervalSummaries`, `lapSummaries`) - use first non-empty array

## Build & Development

- Build: `npm run build` (TypeScript to `dist/`)
- Dev: `npm run dev` (ts-node execution)
- Scripts use `ts-node` directly, no watch mode configured

TypeScript config targets ES2020 with CommonJS modules. Strict mode is enabled.
