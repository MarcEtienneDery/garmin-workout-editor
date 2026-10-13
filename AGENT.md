# AGENT.md

Guidance for AI coding agents working in this repository. `CLAUDE.md` has the Claude-specific version; this file is the tool-agnostic summary.

## Commands

```bash
npm install
npm run build          # tsc -> dist/
npm test               # Jest, single worker (required)
npx jest src/__tests__/mcpServer.test.ts   # one file
npx jest -t "name"                         # by test name
npm run start          # interactive CLI menu (src/cli.ts)
```

No linter; TypeScript strict mode is the gate. Run `npx tsc --noEmit` and the relevant tests before committing.

## Layout

| Area | Location |
|---|---|
| Activity export | `src/exportActivities.ts`, `src/activityExporter.ts` |
| Workout management | `src/manageWorkouts.ts`, `src/workoutEditor.ts` |
| AI-assisted adjustment | `src/adjustWorkouts.ts`, `src/workoutAdjuster.ts` |
| Garmin client, types, profiles | `src/shared/` (`garminClient.ts`, `types.ts`, `profileLoader.ts`) |
| MCP server | `src/mcp/` (`createServer.ts`, `tools/garmin.ts`, `tools/plans.ts`) |
| Plans (JSON) | `workout-plans/` |
| Per-profile data | `data/<profile>/` |

Data flow is fetch, transform, save. Avoid extending the legacy files `src/types.ts`, `src/garminExtractor.ts` and `src/extractActivities.ts`.

## Garmin rules

- Weeks run Monday to Sunday in UTC; schedule dates are ISO `YYYY-MM-DD`.
- Use `normalizeActivityType()` from `src/mocks.setup.ts` for activity types.
- Weights: activity sets use `maxWeight / 453.6` (grams to lbs); workout steps convert grams to lbs unless the unit is already `pound`.
- Open-ended steps use `endCondition: "lap.button"` with `endConditionValue: 0`.
- Keep the `setTimeout` delays in the detail-fetch loops; they are rate limiting.

## MCP server

- Plan tools: `list_plans`, `read_plan`, `write_plan`, `upsert_plan_workout`, `validate_plan`, `list_exercise_names`. They take a logical `path` (`workout-plans/<name>.json` or `data/<profile>/<name>.json`); prefer `upsert_plan_workout` over `write_plan` for single changes.
- Tools that change the Garmin account (`upload_workouts`, `upload_single_workout`, `schedule_plan`, `upload_and_schedule_plan`, `send_to_device`) need the user's explicit confirmation, after `validate_plan` has been shown.
- Uploads delete and recreate workouts that have a `workoutId` and write the new ids back into the plan.
- When adding or renaming a tool, update `src/__tests__/mcpServer.test.ts`, the server instructions in `src/mcp/createServer.ts` and the README table.

## Testing

- Jest runs with `maxWorkers: 1`.
- Mock `@flow-js/garmin-connect`; use `getMockClient()` / `resetMockClient()` from `src/mocks.setup.ts`.
- `@github/copilot-sdk` maps to `src/__mocks__/copilot-sdk.ts`.

## Deployment

The MCP server runs in Docker on the NAS as `garmin-mcp`, defined in `~/docker/garmin.yml`. It builds from `/home/medery/git/garmin-workout-editor` and mounts its `workout-plans/` as `/plans`. To deploy `main`:

```bash
git -C /home/medery/git/garmin-workout-editor fetch origin && git -C /home/medery/git/garmin-workout-editor merge --ff-only origin/main
cd ~/docker && docker compose -f garmin.yml up -d --build
docker logs --tail 5 garmin-mcp   # expect "listening on http://0.0.0.0:8787/mcp/<token>"
```

Reconnect MCP clients afterwards so they pick up tool changes.

## Git

Work on a feature branch, never commit straight to `main`, and don't push or deploy without the user's go-ahead.
