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
npm run mcp -- --mock                 # MCP server over stdio (dev / MCP Inspector)
npm run mcp:http -- --mock            # MCP server over HTTP (needs MCP_AUTH_TOKEN)
docker compose up -d --build          # MCP server in Docker (see README "MCP Server")
```

No linter is configured; TypeScript strict mode is enforced.

## Architecture

Three main CLI workflows, plus an MCP server that exposes them (see below), each with a corresponding entry point and class:

| Workflow | Entry Point | Class |
|---|---|---|
| Activity export | `src/exportActivities.ts` | `ActivityExporter` in `src/activityExporter.ts` |
| Workout management | `src/manageWorkouts.ts` | `WorkoutEditor` in `src/workoutEditor.ts` |
| AI-assisted adjustment | `src/adjustWorkouts.ts` | `WorkoutAdjuster` in `src/workoutAdjuster.ts` |
| MCP server | `src/mcp/server.ts` | `createServer()` in `src/mcp/createServer.ts` (reuses `WorkoutEditor` / `ActivityExporter`) |

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
- **`lap.button` endCondition:** Use `endConditionValue: 0` in workout JSON. The validator exempts `lap.button` from the positive-value requirement. This is the idiomatic way to create open-ended steps the user ends manually on their watch.
- **Rate limiting:** `setTimeout` delays are intentional in activity/workout detail fetch loops; preserve them.

## MCP Server (`src/mcp/`)

Runs in Docker on the user's NAS over Streamable HTTP for claude.ai / Claude Desktop; stdio is for local dev. The client's model does the analysis, so the MCP must **not import `workoutAdjuster.ts`** (Copilot SDK).

- **stdout is the protocol channel.** `server.ts` imports `./consoleRedirect` first, which sends all `console.*` to stderr and into the per-call log that `runTool()` returns with each result. Never write to stdout directly in `src/mcp/`.
- **Tools** are registered in `tools/garmin.ts` (Garmin API) and `tools/planFiles.ts` (local files). Wrap every handler in `runTool()` (`context.ts`); pass `{ serialize: true }` for anything that touches Garmin.
- **Mock mode** (`--mock` / `MOCK_MODE=true`) serves mock data and `assertLive()` refuses every Garmin write except `dryRun`. Keep that guard on any new write tool.
- **Path guard:** tools take logical paths (`workout-plans/x.json`, `data/<profile>/x.json`); `resolveDataPath()` maps them to `WORKOUT_PLANS_DIR` / `GARMIN_DATA_DIR` and rejects non-`.json`, dotfiles (token cache, `.env*`), `..` and symlink escapes. Resolve every user-supplied path through it.
- **Directory overrides** `GARMIN_PROFILES_DIR` / `GARMIN_DATA_DIR` / `WORKOUT_PLANS_DIR` default to the CLI layout; the Docker image sets them to `/config`, `/data`, `/plans`.
- **Auth (HTTP):** `MCP_AUTH_TOKEN` (>= 32 chars) as `/mcp/<token>` or a bearer header; anything else is a 404. Never log the URL path.
- Step/workout input schemas derive their enums from the `VALID_*` constants exported by `workoutEditor.ts`; change them there, not in `planFiles.ts`.
- Not yet exposed as tools: `--generate-template`, `--copy-next-week`, `--start-new-plan`.

## Testing Patterns

- Jest runs `maxWorkers: 1` — required to avoid concurrency issues.
- Mock `@flow-js/garmin-connect` in unit tests. Use `getMockClient()` and `resetMockClient()` from `src/mocks.setup.ts` for per-test mock behavior.
- `@github/copilot-sdk` is mapped to `src/__mocks__/copilot-sdk.ts` in Jest config.

## Known Gaps

- `WorkoutEditor.transformAndSaveWorkouts()` exists but `src/manageWorkouts.ts` does not expose a `--transform-only` flag despite usage text suggesting it does.
- Auth via email/password can fail with Garmin 2FA; session-cookie auth is documented in the README.
- Two tests fail on a clean checkout: `workoutEditor.test.ts` "Start New Training Plan" reads `data/training-plan.json`, which is gitignored (ENOENT in a fresh worktree); `workoutEditor.upload-cycle.test.ts` expects a cooldown `open` target to upload as `no.target` but gets `open`.

## Workout Upload vs Schedule

- `--upload <file>` uploads (creates/replaces) workouts **without scheduling** them. Use `--dry-run` to validate first.
- `--import-and-schedule <file>` uploads **and** schedules workouts based on `scheduledDate` fields.
- `--schedule <file>` schedules already-uploaded workouts from a plan file.
- After upload, the JSON file is automatically updated with new Garmin `workoutId` values.
