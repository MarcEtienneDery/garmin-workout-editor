# AGENT.md

Guidance for AI coding agents working in this repository. `CLAUDE.md` has the Claude-specific version; this file is the tool-agnostic summary.

## Commands

```bash
npm install
npm run build          # tsc -> dist/
npm test               # Jest, single worker (required)
npx jest src/__tests__/mcpServer.test.ts   # one file
npx jest -t "name"                         # by test name
```

No linter; TypeScript strict mode is the gate. Run `npx tsc --noEmit` and the relevant tests before committing.

## Layout

| Area | Location |
|---|---|
| Activity transform (Garmin activity to the slim planning format) | `src/activityExporter.ts` |
| Workout transforms, upload and scheduling | `src/workoutEditor.ts` |
| Garmin client, types, profiles | `src/shared/` (`garminClient.ts`, `types.ts`, `profileLoader.ts`) |
| MCP server | `src/mcp/` (`createServer.ts`, `tools/garmin.ts`, `tools/plans.ts`) |
| Garmin activities | stored in the `activities` table of `garmin.db` (`src/shared/store/activities.ts`), filled by `src/shared/activitySync.ts` (list paging, details, charts, lease, background backfill; the chart data is pruned and read by `src/shared/activityChart.ts`) through `src/mcp/tools/activities.ts`, which also answers `get_activities` from the table. Never write `data/<profile>/activities*.json` documents again |
| Daily health data and readiness | stored in the `wellness` table of `garmin.db` (`src/shared/store/wellness.ts`: Garmin's responses as they came, fields read out with SQL), filled by `src/shared/wellnessSync.ts` (one call per day and kind, recent days fetched again, lease, background backfill); the band for a day's workout is `src/shared/readiness.ts` (pure; thresholds are constants at its top); the tools `get_readiness` and `get_wellness` and the Garmin URLs are `src/mcp/tools/wellness.ts`. The MCP tools and the web view answer from the same functions in `src/shared/wellnessReport.ts`. The Recovery view of the web editor (`GET /api/wellness`, `GET /api/wellness/raw`, `POST /api/wellness/sync`) is `public/recoveryModel.js` (labels, scales, the table's fields; tested by `src/__tests__/recoveryModel.test.ts`) and `public/trendCharts.js` (SVG, shared with the Weight view), glued in `index.html`. The Weight view (calories burned, weight and body composition; `GET /api/weight`, `bodyRange` in `wellnessReport.ts`, the trend in `src/shared/bodyTrend.ts`) is `public/weightModel.js` (tested by `src/__tests__/weightModel.test.ts`); it shares the sync and the `wellness` table with Recovery but is a view of its own Read the fields with `WellnessTable.metrics` (SQL), never by parsing the responses |
| Logins and the Renpho sync | the Settings view of the web editor (account menu): `GET /api/settings`, `POST /api/settings/garmin`, `POST /api/settings/renpho`, `GET /api/settings/renpho/fit`. Logins are in the `credentials` table (`src/shared/store/credentials.ts`; passwords encrypted when `CREDENTIALS_KEY` is set, `src/shared/store/seal.ts`; never sent to a browser). `loadProfile` and `getAvailableProfiles` in `src/shared/profileLoader.ts` read a Garmin login saved there before the `.env.<profile>` file, and `getSession` (`src/mcp/context.ts`) makes a new client when the login changed. The what-the-view-does logic is `src/shared/accounts.ts`. The Renpho sync: `src/shared/renphoClient.ts` (unofficial, encrypted protocol; read-only), `src/shared/renphoFit.ts` (weigh-ins as a FIT file; the number mapping is `toWeighIn`), `src/shared/renphoSync.ts` (one run: lease, fetch into the `renpho_measurements` ledger, upload once, log; tables in `src/shared/store/renpho.ts`), `src/mcp/tools/renpho.ts` (the Garmin upload and the timer the web editor starts). Uploading to Garmin is opt-in per profile and changes the account. The page is `public/settingsModel.js` (tested by `src/__tests__/settingsModel.test.ts`) glued in `index.html` |
| Plan editor web UI | `src/web/` (`server.ts`, `public/index.html`; Monaco served from node_modules). The workout picture (step tree, profile segments, card text, time/distance estimates) is `public/workoutModel.js`, a plain script the page loads and `src/__tests__/workoutModel.test.ts` requires; `index.html` only draws it. Steps that name no pace are timed from `GET /api/runs` (`recentRuns` in `server.ts`: the profile's runs from the `activities` table) through `pacerFrom` in the model. Its Garmin buttons and its Workouts view (library listing, plan-vs-Garmin check, save, delete) call the shared action functions in `src/mcp/tools/garmin.ts`; the comparison itself is `src/shared/workoutSync.ts` + `diffPlanWorkout` in `src/mcp/tools/plans.ts`. Its Activities view (`GET /api/activities`, `GET /api/activity`, `POST /api/activities/sync|detail`; the logic is `public/activityModel.js`, tested by `src/__tests__/activityModel.test.ts`) reads the `activities` table and calls Garmin only on those two POSTs. Its Calendar view (`GET /api/calendar`, `calendarPlans` in `server.ts`) reads the stored plans only (plan span = `weekStart`/`weekEnd` widened by every `scheduledDate`), so it needs no Garmin profile |
| Plans and per-profile data (JSON documents) | the store in `src/shared/store/` (SQLite `garmin.db`). Logical paths `workout-plans/<name>.json` and `data/<profile>/<name>.json`; every save keeps the previous version. CLI: `npm run store -- ...` (`src/storeCli.ts`). The Garmin login tokens are in the same database (`garmin_tokens`, `src/shared/store/tokens.ts`, used by `src/shared/tokenCache.ts`); only `.env.<profile>` stays a plain file |

Data flow for activities: Garmin to the `activities` table (sync), table to the slim format (`buildExtractedActivities`) on read. Nothing is written to local files.

## Garmin rules

- Weeks run Monday to Sunday in UTC; schedule dates are ISO `YYYY-MM-DD`.
- Use `normalizeActivityType()` from `src/mocks.setup.ts` for activity types.
- Weights: activity sets use `maxWeight / 453.6` (grams to lbs); workout steps convert grams to lbs unless the unit is already `pound`.
- Open-ended steps use `endCondition: "lap.button"` with `endConditionValue: 0`.
- Keep the pause between detail calls (`GARMIN_DETAIL_GAP_MS`, 500 ms by default) in the activity sync and the `setTimeout` delays in the workout detail loops; they are rate limiting.

## MCP server

- Plan tools: `list_plans`, `read_plan`, `write_plan`, `upsert_plan_workout`, `validate_plan`, `list_exercise_names`. They take a logical `path` (`workout-plans/<name>.json` or `data/<profile>/<name>.json`); prefer `upsert_plan_workout` over `write_plan` for single changes.
- Tools that change the Garmin account (`upload_workouts`, `upload_single_workout`, `schedule_plan`, `upload_and_schedule_plan`, `send_to_device`) need the user's explicit confirmation, after `validate_plan` has been shown.
- Uploads delete and recreate workouts that have a `workoutId` and write the new ids back into the plan.
- When adding or renaming a tool, update `src/__tests__/mcpServer.test.ts`, the server instructions in `src/mcp/createServer.ts` and the README table.

## Testing

- Web UI changes are not covered by Jest (the page is plain script in `src/web/public/index.html`): run `npm run web` and click through it, ideally also at phone width.
- Jest runs with `maxWorkers: 1`.
- Mock `@flow-js/garmin-connect`; use `getMockClient()` / `resetMockClient()` from `src/mocks.setup.ts`.

## Deployment

The MCP server runs in Docker on the NAS as `garmin-mcp`, defined in `~/docker/garmin.yml`; the plan editor runs beside it as `garmin-web` (same image, `node dist/web/server.js`, needs `WEB_AUTH_TOKEN` for the admin login (profiles can add `WEB_PASSWORD` to `.env.<profile>` for their own login; the page has a sign-in form and sessions live in memory), and `/config` mounted for its Garmin buttons). It builds from `/home/medery/git/garmin-workout-editor`; the database lives in `~/docker/garmin-mcp/data/garmin.db` (`sqlite_backup` it in `~/docker/backup.sh`). To deploy `main`:

```bash
git -C /home/medery/git/garmin-workout-editor fetch origin && git -C /home/medery/git/garmin-workout-editor merge --ff-only origin/main
cd ~/docker && docker compose -f garmin.yml up -d --build
docker logs --tail 5 garmin-mcp   # expect "listening on http://0.0.0.0:8787/mcp/<token>"
```

Reconnect MCP clients afterwards so they pick up tool changes.

## Git

Work on a feature branch, never commit straight to `main`, and don't push or deploy without the user's go-ahead.
