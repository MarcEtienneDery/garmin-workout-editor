# Copilot Instructions for Garmin Workout Editor

## Project Architecture

This is a TypeScript CLI tool for extracting Garmin Connect activities and managing workout plans. The codebase is split into two main workflows:

1. **Activity Extraction** ([exportActivities.ts](../src/exportActivities.ts)) - Fetches activities from Garmin Connect API
2. **Workout Management** ([manageWorkouts.ts](../src/manageWorkouts.ts)) - Imports, exports, and schedules workout plans

### Core Components

- **GarminClient** ([shared/garminClient.ts](../src/shared/garminClient.ts)) - Shared authentication and client wrapper around `garmin-connect` library
- **ActivityExporter** ([activityExporter.ts](../src/activityExporter.ts)) - Extracts and transforms activities
- **WorkoutEditor** ([workoutEditor.ts](../src/workoutEditor.ts)) - Workout CRUD operations and scheduling
- **Types** ([types.ts](../src/types.ts), [shared/types.ts](../src/shared/types.ts)) - Central type definitions for activities and workouts

### Authentication Pattern

Garmin authentication is centralized in `GarminClient`. Always use `ensureAuthenticated()` before API calls. The project supports **mock mode** (`MOCK_MODE=true` or `--mock` flag) for testing without credentials.

```typescript
const garminClient = new GarminClient(email, password, mockMode);
await garminClient.ensureAuthenticated();
```

Session cookie authentication is the recommended method (email/password blocked by Garmin 2FA).

## Testing Philosophy

Tests are organized by type:
- **Unit tests**: Mock the Garmin API client (`garminExtractor.test.ts`, `workoutEditor.test.ts`)
- **Integration tests**: Test actual API interactions (`garminExtractor.integration.test.ts`)

Mock data is generated via [mocks.setup.ts](../src/mocks.setup.ts) and seeded from the last 4 activities in `data/activities.json` if available.

Run tests with `npm test`. Jest is configured for single-worker execution (`maxWorkers: 1`) to avoid concurrency issues.

## Key Conventions

### Activity Type Normalization

Activity types from Garmin are normalized to 5 categories in [types.ts](../src/types.ts):
```typescript
'running' | 'strength_training' | 'cycling' | 'swimming' | 'other'
```

Use `normalizeActivityType()` helper when transforming raw Garmin data.

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

Common flags:
- `--mock`: Use test data instead of real API
- `--raw`: Save raw Garmin response for debugging
- `--no-detailed`: Skip detailed activity fetch (faster but less data)
- `--last-week` / `--this-week`: Filter by date range

## Rate Limiting

Detailed activity fetching includes 1-second delays between requests to avoid Garmin rate limits:
```typescript
await new Promise(resolve => setTimeout(resolve, 1000));
```

This pattern appears in both activity and workout detail fetches.

## Garmin API Quirks

- **Weight encoding**: Garmin stores weight in tenths of grams. Convert with `maxWeight / 453.6` for lbs.
- **Exercise names**: Stored as SCREAMING_SNAKE_CASE (e.g., `BARBELL_BENCH_PRESS`). Transform to title case.
- **Workout steps**: Nested structure with `workoutSteps` arrays containing exercise sets. See `transformWorkoutSteps()` in [workoutEditor.ts](../src/workoutEditor.ts).

## Build & Development

- Build: `npm run build` (TypeScript to `dist/`)
- Dev: `npm run dev` (ts-node execution)
- Scripts use `ts-node` directly, no watch mode configured

TypeScript config targets ES2020 with CommonJS modules. Strict mode is enabled.
