# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm test             # Run all tests (single-worker)
npm run test:watch   # Watch mode
npm run test:coverage

# Run a single test file or by name:
npx jest src/__tests__/workoutEditor.test.ts
npx jest -t "test name pattern"

# CLI workflows:
npm run export-activities -- [args]
npm run manage-workouts -- [args]
npm run adjust-workouts -- [args]
npm run start   # Interactive menu (src/cli.ts)
```

No linter is configured; TypeScript strict mode is enforced.

## Architecture

Three main CLI workflows, each with a corresponding entry point and class:

| Workflow | Entry Point | Class |
|---|---|---|
| Activity export | `src/exportActivities.ts` | `ActivityExporter` in `src/activityExporter.ts` |
| Workout management | `src/manageWorkouts.ts` | `WorkoutEditor` in `src/workoutEditor.ts` |
| AI-assisted adjustment | `src/adjustWorkouts.ts` | `WorkoutAdjuster` in `src/workoutAdjuster.ts` |

Data flow: **fetch → transform → save**. Garmin API calls go through `GarminClient` (`src/shared/garminClient.ts`), which handles auth, mock mode, and token caching. Use `ensureAuthenticated()` for mock-safe flows.

Domain types live in `src/shared/types.ts` (`ExtractedActivities`, `DetailedWorkout`, `WorkoutStep`, `WeeklyWorkoutPlan`, etc.). Legacy type files exist (`src/types.ts`, `src/garminExtractor.ts`, `src/extractActivities.ts`) — avoid extending them.

The AI adjustment workflow loads activities and workouts from file or fetches fresh from Garmin, builds a prompt for the GitHub Copilot SDK (`@github/copilot-sdk`), runs an interactive per-workout review loop, then uploads/schedules approved changes.

## Garmin-Specific Transform Rules

- **Activity types:** use `normalizeActivityType()` from `src/mocks.setup.ts`, not legacy `src/types.ts`.
- **Date handling:** Monday–Sunday weeks in UTC; ISO `YYYY-MM-DD` for schedules (`getLastWeekDates/getThisWeekDates/getNextWeekDates`).
- **Running intervals:** `buildIntervalSets()` in `src/activityExporter.ts` checks multiple Garmin fields and filters `RWD_WALK/RWD_RUN/RWD_STAND`. Distances >20 are treated as meters and converted to km.
- **Weight conversion is inconsistent by source:**
  - Activity exercise sets: `maxWeight / 453.6` (grams → lbs)
  - Workout steps: convert grams → lbs unless unit is already `pound`
- **Workout step flattening:** `WorkoutEditor.flattenSteps()` expands nested `RepeatGroupDTO`; `mergeRestIntoExercises()` folds first rest into prior step.
- **Rate limiting:** `setTimeout` delays are intentional in activity/workout detail fetch loops; preserve them.

## Testing Patterns

- Jest runs `maxWorkers: 1` — required to avoid concurrency issues.
- Mock `@flow-js/garmin-connect` in unit tests. Use `getMockClient()` and `resetMockClient()` from `src/mocks.setup.ts` for per-test mock behavior.
- `@github/copilot-sdk` is mapped to `src/__mocks__/copilot-sdk.ts` in Jest config.

## Known Gaps

- `WorkoutEditor.transformAndSaveWorkouts()` exists but `src/manageWorkouts.ts` does not expose a `--transform-only` flag despite usage text suggesting it does.
- Auth via email/password can fail with Garmin 2FA; session-cookie auth is documented in the README.
