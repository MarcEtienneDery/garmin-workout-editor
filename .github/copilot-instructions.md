# Copilot Instructions for Garmin Workout Editor

## Big Picture
- This is a TypeScript tool with a web plan editor and an MCP server. Plans and data are documents in the SQLite database, never files.
- Activities live in the `activities` table of the SQLite database (`src/shared/store/activities.ts`), filled by `src/shared/activitySync.ts`; `ActivityExporter` in `src/activityExporter.ts` turns them into the slim planning format. Workouts: `WorkoutEditor` in `src/workoutEditor.ts`.
- Shared API/auth boundary is `GarminClient` (`src/shared/garminClient.ts`). Use `ensureAuthenticated()` for mock-safe flows.

## Code Boundaries & Conventions
- Prefer `src/shared/types.ts` for domain types (`ExtractedActivities`, `DetailedWorkout`, `WorkoutStep`, `WeeklyWorkoutPlan`).
- Normalize activity types via `normalizeActivityType()` from `src/mocks.setup.ts` .
- Date handling is Monday–Sunday in UTC (see `getLastWeekDates/getThisWeekDates/getNextWeekDates`). Keep ISO `YYYY-MM-DD` for schedules.

## Garmin-Specific Transform Rules
- Running intervals: `buildIntervalSets()` in `src/activityExporter.ts` checks multiple Garmin fields (`intervals/laps/splits/...`) and filters `RWD_WALK`, `RWD_RUN`, `RWD_STAND`.
- Distance heuristic: interval distances >20 are treated as meters and converted to km.
- Strength lifting split: `splitWarmupTopBackoffSets()` separates warmup/top/backoff for main lifts.
- Weight conversion is Garmin-specific and inconsistent by source:
  - Activity sets: `maxWeight / 453.6` to lbs.
  - Workout steps: convert grams to lbs unless unit already `pound`.
- Workout step flattening: `WorkoutEditor.flattenSteps()` expands nested `RepeatGroupDTO`; `mergeRestIntoExercises()` folds first rest into prior step.
- `lap.button` endCondition: Use `endConditionValue: 0` in workout JSON. The validator exempts `lap.button` from the positive-value requirement. This creates open-ended steps the user ends manually on their watch.

## Developer Workflows (Canonical Commands)
- Install/build: `npm install`, `npm run build`
- Tests: `npm test`, `npm run test:watch`, `npm run test:coverage`
- Scripts from `package.json`: `npm run web` (plan editor), `npm run mcp` / `npm run mcp:http` (MCP server), `npm run store -- ...` (the document store's command line)
- Prefer package scripts over README examples when they disagree.

## Testing Patterns
- Jest runs single-worker (`maxWorkers: 1` in `jest.config.js`) to avoid concurrency issues.
- Mock `@flow-js/garmin-connect` in unit tests (see `src/__tests__/activityExporter.test.ts`).
- Use helpers from `src/mocks.setup.ts`: `getMockClient()` and `resetMockClient()` for per-test mock behavior.

## Important Integration Notes
- Auth: direct email/password can fail with Garmin 2FA; session-cookie docs are referenced in README.
- Rate limiting is explicit in fetch loops (`setTimeout` delays in activity/workout detail fetches); preserve this behavior.
