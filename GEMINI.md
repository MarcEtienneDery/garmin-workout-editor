# Garmin Workout Editor — AGY Project Context

> Mirrors `.github/copilot-instructions.md` so both Copilot and AGY share the same project memory.

## Big Picture
- This is a TypeScript CLI tool with 3 active workflows: activity export, workout management, and AI-assisted workout adjustment.
- Main entrypoints: `src/exportActivities.ts`, `src/manageWorkouts.ts`, `src/adjustWorkouts.ts`.
- Architecture pattern is mostly **fetch → transform → save**.
  - Activities: `ActivityExporter` in `src/activityExporter.ts`
  - Workouts: `WorkoutEditor` in `src/workoutEditor.ts`
  - AI adjustment orchestration: `src/adjustWorkouts.ts` + `WorkoutAdjuster` in `src/workoutAdjuster.ts`
- Shared API/auth boundary is `GarminClient` (`src/shared/garminClient.ts`). Use `ensureAuthenticated()` for mock-safe flows.

## Code Boundaries & Conventions
- Prefer `src/shared/types.ts` for domain types (`ExtractedActivities`, `DetailedWorkout`, `WorkoutStep`, `WeeklyWorkoutPlan`).
- Legacy files exist (`src/garminExtractor.ts`, `src/extractActivities.ts`, `src/types.ts`); avoid extending them for new work.
- Normalize activity types via `normalizeActivityType()` from `src/mocks.setup.ts` (not legacy `types.ts`).
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
- CLI scripts from `package.json`:
  - `npm run export-activities -- ...`
  - `npm run manage-workouts -- ...`
  - `npm run adjust-workouts -- ...`
  - `npm run start` (interactive menu in `src/cli.ts`)
- Prefer package scripts over README examples when they disagree.

## Testing Patterns
- Jest runs single-worker (`maxWorkers: 1` in `jest.config.js`) to avoid concurrency issues.
- Mock `@flow-js/garmin-connect` in unit tests (see `src/__tests__/activityExporter.test.ts`).
- Use helpers from `src/mocks.setup.ts`: `getMockClient()` and `resetMockClient()` for per-test mock behavior.
- `@github/copilot-sdk` is mapped to `src/__mocks__/copilot-sdk.ts` in Jest config.

## Important Integration Notes
- Auth: direct email/password can fail with Garmin 2FA; session-cookie docs are referenced in README.
- Rate limiting is explicit in fetch loops (`setTimeout` delays in activity/workout detail fetches); preserve this behavior.
- `WorkoutEditor` supports `transformAndSaveWorkouts()`, but `src/manageWorkouts.ts` currently does not expose a `--transform-only` execution path despite usage text mentioning it.
- `adjustWorkouts.ts` can operate file-only (`--activities`, `--workouts`) or fetch fresh from Garmin.
- `--upload <file>` uploads workouts **without scheduling**; `--import-and-schedule <file>` uploads **and** schedules. Use `--dry-run` with either to validate first. After upload, the JSON file is updated with new Garmin `workoutId` values.
