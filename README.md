# Garmin Workout Editor

Keep your Garmin activities in a database, edit your workout plans in a web editor or through Claude (MCP), and push them to Garmin.

> **⚠️ Authentication Note:** Direct email/password authentication is currently blocked by Garmin. Use the **session cookie method** instead. See [AUTH_ISSUES.md](AUTH_ISSUES.md) and [GET_SESSION.md](GET_SESSION.md) for solutions.

## Features

- Store your Garmin activities (the whole history, with details) in a database, fetched once
- Export workouts from Garmin to JSON
- Generate a temporary next-week workout plan file for manual edits
- Copy a workout plan to next week (shift dates by 7 days)
- Start a new training plan cycle (reset training progression + clear schedule dates)
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

3. Run the plan editor (`npm run web`) or the MCP server (`npm run mcp`); see below.

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

3. Run the plan editor (`npm run web`) or the MCP server (`npm run mcp`); see below.

**Note:** If this fails with "You have been blocked", use the session cookie method instead.

## Usage

### Activities

Your Garmin activities are stored in the database (see [Storage](#storage)) and read through the MCP tool `get_activities`; there is no file to extract. The first call lists your whole history and a background job fetches every activity's details (about 1 second each, so a long history takes a while; it can be interrupted and resumes). After the details, the same background job fetches each activity's **chart data** once (three read-only calls: the time series and route, the watch's laps, the heart-rate zones), kept in an `activity_charts` table in the shape Garmin sent it, thinned to 300 samples and without nested objects (about 100 KB an activity at most, so 40-50 MB for 500 activities); the charts are read from that on every view, so a change in how they are read never needs Garmin again. An activity with no GPS or no series (strength, indoor, manual) stores an empty answer and is not retried. Later calls ask Garmin only for what is new. In mock mode (`MOCK_MODE=true` or `--mock`) `get_activities` returns generated activities and stores nothing.

## Plan Editor (web UI)

A small website to manage plan files: a Monaco JSON editor (with schema autocompletion) plus CRUD, and buttons to upload, schedule and send plans to your watch.

```bash
npm run web          # http://127.0.0.1:8788
```

- **Files**: create, duplicate, rename and delete plans in `workout-plans/` and `data/<profile>/` (the same [stored documents](#storage) the MCP plan tools reach).
- **File list**: a *Sort* menu orders the files inside each folder by name, plan date (newest or oldest first), last modified or number of workouts; files without a plan date go last, and the choice is remembered in the browser.
- **Outline panel**: add, duplicate and delete individual workouts. Each row carries a small profile of its steps; click its name to open the workout's picture (see below), with *Edit in JSON* underneath to jump to it in the editor. With Garmin available, each workout shows whether it is up to date on Garmin: ✓ up to date, ≠ differs (click it for what differs), ○ not uploaded (no `workoutId`), ✗ missing (the `workoutId` is not on Garmin). It compares the editor's text, unsaved edits included, with the Garmin copy, and updates as you type.
- **Workouts view** (*Workouts* in the header switcher): your Garmin workout library next to the plan workouts, each with the same status chips. Click one to see its picture and the plan files that carry it; when the plan and Garmin differ you see what differs and can push the plan's version to Garmin or pull Garmin's version into the plan. *+ New*, *Edit* (a JSON editor with the same schema and validation) and *Delete* change the plan file and Garmin together: The list can be sorted (recently updated, name, type, needing attention first, next scheduled day) and filtered by status (needs attention, up to date, not on Garmin, only on Garmin), by plan or none, by type and by upcoming (scheduled today or later), on top of the name search; a count and *Clear* show when anything is filtered, and the sort is remembered in the browser.
  - Edit saves into the plan entry and, if ticked, replaces the workout on Garmin (Garmin deletes and recreates it, so the `workoutId` changes; every plan entry that pointed at the old one gets the new id; ticking *Re-schedule upcoming dates* adds its future `scheduledDate`s to the calendar again). Workouts that only exist on Garmin are edited on Garmin alone.
  - New adds the workout to a plan, to Garmin, or both. Delete removes it from Garmin and/or the plan; if you keep it in the plan it stays there as "not uploaded".
  - Each row has four buttons. **Upload** puts the plan's version on Garmin (greyed out when they already match, or when only Garmin has the workout). **Download** brings Garmin's version into the plan, or, for a Garmin-only workout, adds it to a plan you choose, linked to the Garmin workout so a later upload replaces it instead of duplicating it. **Clone** opens the New dialog with a copy (no `workoutId`, no `scheduledDate`) that you can send to a plan and/or Garmin. **Delete** asks what to remove, as above.
  - Garmin changes ask for confirmation first. Garmin lists at most the 100 most recently updated workouts, and exports such as `data/<profile>/workouts.json` are not treated as plans.
- **Activities view** (*Activities* in the header switcher): the activities stored in the database (see [Storage](#storage)), as a **List** and as a **Calendar**, read without calling Garmin. The list groups them by week, newest first, with each week's sessions, distance and time; each row shows the type, name, start, distance, time, pace (runs), sets (strength), average HR and training effect. Filter by type, by name and by how far back (4 weeks to all). The calendar is a month grid with a chip per activity coloured by type and a weekly total; *Show planned* adds the workouts the plans schedule, as dashed chips: grey for upcoming, amber for today, red for not done, and a ✓ on the activity that answers one. An activity answers a planned workout when it carries its `workoutId`, or failing that when it is the same sport on the same day (an upload makes a new `workoutId`, so an activity done before it carries the old one); two plans that schedule the same session on the same day count once. Click an activity for its details: distance, time, pace, HR, elevation, cadence, calories, training effect, body battery, feel and RPE, and more (lowest HR, fastest 1 km and 5 km, stride, steps, descent, VO2max, place, moving time, run/walk/stand time); a bar of the time in each heart-rate zone; **graphs** of heart rate (with the zone bands when Garmin gave their bounds), pace (faster at the top, smoothed), elevation and cadence against distance or time, with a cursor that shows the values at the pointer (a finger drags it on a phone); the watch's **laps** and **kilometer splits** as bars of speed with the fastest and slowest marked; for strength, each exercise with its sets (identical sets merged, `3 × 6 @ 40 lb`) and a **% of 1RM** section: each loaded set as a share of the lift's one-rep max, estimated from your best set of that exercise ever (the stored strength activities, including later ones) by the Epley formula, weight × (1 + reps ÷ 30), counting sets of 1 to 12 counted reps, with the set it came from named. The Stats view shows the same maxes, so the two always agree; no plan file or benchmark is read; for a run with no laps, the intervals; and the plan workout it came from, drawn as its picture and compared with what was done (time and distance). A run, ride or any activity with GPS also gets a **route on a tile map**, coloured by pace or heart rate (red slower or harder, green faster or easier): hovering the route moves the graphs' cursor and the other way round, and on a phone one finger scrolls the pane while two pan and zoom the map. The map library (Leaflet) is served from this server, but the **tiles come from OpenStreetMap**: your browser asks `tile.openstreetmap.org` for the tiles around each route you open, which tells OSM roughly where it is; nothing is prefetched, the OSM attribution stays on the map, and an activity without GPS shows no map. The graphs come from the chart data the background job stores (see Storage); an activity opened before they are stored fetches its own (three Garmin calls). A fresh database is empty: the view offers *Fetch history from Garmin*, which lists the whole history and starts the background fill of every activity's details (it never starts by itself); *Sync* then asks Garmin only for what is new, and the view does that once per page load. While a sync runs (here or in the MCP server) it follows along, and an activity whose details are not stored yet fetches them when opened. It is read-only.

  **Stats** (the third mode beside List and Calendar) shows what the stored activities add up to over a lifetime, from `GET /api/activities/stats`. Overall: activities, time, active days, since, and the count per type, then a **Running** part (runs, distance, time, climb, average pace, VO2max; the fastest time over each distance the watch timed inside a run (1 km, 1 mile, 5 km, 10 km, from the `fastestSplit_*` fields of the list item); the longest run, best pace over 3 km or more, biggest climb, biggest week (Monday to Sunday) and biggest month) and a **Strength** part (sessions, time, sets, reps from the list items, and the volume lifted; then each exercise with its sessions, sets, reps, volume, the est. 1RM (the same as in *% of 1RM*), heaviest weight and last day), and a table by year. A record that belongs to one activity opens it. Nothing is stored twice: the numbers are worked out from the activities table, and the answer is kept only while the table is unchanged (a fingerprint of the row count and the newest `synced_at` and `detail_at`), so a new activity, or the details of one that arrived late, are in the next look; the view looks again by itself when a sync stores something. The exercise figures come from the sessions whose details are stored, and the view says how many that is.
- **Workout picture**, in the Workouts view and in the outline: a profile bar with one block per step (width is time, colour is the kind of step, height is effort: harder targets and heavier sets are taller; a hatched block is a step that ends on the lap button), the estimated time and distance, and one card per step with its distance, time or reps, target (heart rate, or pace in min/km from the plan's m/s), weight and rest. Repeats are drawn as an "N times" box (a "Superset" when it mixes exercises), and an exercise's sets share one card. Hover or tap a bar or a card to light up the other. The estimates are marked `~`. A step's own pace target sets its speed; a step with none is timed from your recent runs (the profile's stored activities): at the pace you ran at that heart rate, or your easy pace when it has no heart-rate target, and at 6:00/km when there are fewer than three recent runs to learn from. A rep counts 3 s, and a lap-button step is not counted. The picture says which of these it used. Where the plan and Garmin differ, the Workouts view switches between the two copies and flags the steps that differ. It is read-only; edit the JSON to change a workout. The Calendar's chips and the Workouts view's "In plans" links open the plan on this picture.
- **Calendar view** (*Calendar* in the header switcher): a month grid of what the plan files schedule, with two modes. *Plans* draws a bar for each plan across its span, so you see which weeks each plan covers and where plans overlap; *Workouts* puts a chip on each day a workout is scheduled, coloured by type. Click a bar or chip to open that plan (a chip opens that workout's picture), click a day to list its plans and workouts in the side panel, and use the legend to jump to a plan's first month. A plan's span is its `weekStart` / `weekEnd` widened by every `scheduledDate` (the week range alone is often stale), drawn dashed when no workout has a `scheduledDate`; plans without any date are listed as "No dates yet". It reads the plan files in `workout-plans/` and `data/<profile>/` (never the Garmin library exports), so it needs no Garmin profile, and it shows what the files say, not what Garmin's own calendar holds. Weeks start on Monday.
- **Validation**: the same pre-upload checks as `validate_plan`, run as you type; saving is never blocked by validation errors. `Ctrl/Cmd+S` saves.
- **Safe writes**: *Save* is enabled, with a ● on it, only while the editor has unsaved changes. A save is refused (409) if someone else saved the file since you opened it (e.g. through the MCP server). Reload to see their version.
- **History**: every save keeps the version it replaces. *History* (in the *File* menu, with *Reload*, *Duplicate*, *Rename* and *Delete*) lists the earlier versions of the open file with who saved them (web, mcp, cli, restore); *Load* puts one in the editor and *Save* makes it the current version again. A deleted file can be brought back from the command line (see [Storage](#storage)).
- **Config**: `WEB_PORT` (8788), `WEB_HOST` (127.0.0.1). Binding to a non-loopback host requires `WEB_AUTH_TOKEN` or at least one profile `WEB_PASSWORD` (below).
- **Logins**: the page opens with a sign-in form. Add `WEB_PASSWORD=<password>` to a profile's `.env.<profile>` and sign in with the profile name as user name (any case: `med` signs in as `MED`). That login sees only `data/<profile>/`, the shared plans in `workout-plans/` and the plans it created itself, and its Garmin buttons always act as that profile. `WEB_AUTH_TOKEN` (any user name, the token as password) stays the admin login with access to everything. The header shows who is signed in (the profile name, or *Admin*) with a *Sign out* entry; a login lasts 7 days (kept in an `HttpOnly` cookie, in memory, so a restart signs everyone out) and ends when its password changes or is removed. Passwords are read on every request, so edits apply without a restart. Generate one with `openssl rand -hex 16`. Scripts can skip the form and send the same credentials as HTTP Basic.
- **Garmin menu** (header): *Upload*, *Schedule*, *Upload + schedule* and *Send to watch* run the same code as the MCP tools `upload_workouts`, `schedule_plan`, `upload_and_schedule_plan` and `send_to_device`. Each one saves the file first, shows what it will do (workouts with a `workoutId` are deleted and recreated) and asks for confirmation; uploads are refused while validation has errors. New `workoutId`s are written back and the editor reloads them, and the Garmin log appears under *Checks → Garmin*.
- The buttons need the Garmin credentials: the `.env.<profile>` files in `GARMIN_PROFILES_DIR` (Docker: mount `./config` at `/config:ro`). Without a profile (or in mock mode) they stay disabled. Plans under `data/<profile>/` use that profile; for `workout-plans/` a profile picker appears when you have several.
- Anyone with `WEB_AUTH_TOKEN` (or a profile's `WEB_PASSWORD`, for that profile) can change that Garmin account from here; use HTTPS (reverse proxy or tunnel) if the editor is reachable beyond your LAN. Behind an HTTPS proxy, forward `X-Forwarded-Proto` so the session cookie is marked `Secure`.
- **Navigation** is the same in every view and at every width: the header always shows the *Plans / Workouts / Calendar / Activities* switcher and your account. The Plans view adds a toolbar under it (Save, the file tools and the Garmin menu); the other views keep their own controls in their panes. A plan opens on its **Outline**; the JSON editor is the Editor tab on phones (the middle pane on desktop), and a file with no workout list, or with broken JSON, opens in the editor.
- Works on phones: below 900px the Plans view shows one pane at a time (Files / Editor / Outline / Checks tabs at the bottom) with the file tools in a ⋯ menu; in the calendars (plans and activities) the bars and chips only colour the days, and a tap lists the day below the grid; the Activities list and its details are one pane at a time.

## MCP Server (claude.ai / Claude Desktop)

An MCP server exposes this repo's functionality to Claude, so the model can review last week's activities, edit your plans, validate them, and (after you confirm) upload and schedule workouts on Garmin.

### Tools

| Group | Tools |
|---|---|
| Garmin reads | `list_profiles`, `get_activities`, `list_workouts`, `get_workout`, `export_workouts`, `list_devices` |
| Plans | `list_plans`, `read_plan`, `write_plan`, `upsert_plan_workout`, `validate_plan`, `list_exercise_names` |
| Garmin writes | `upload_workouts`, `upload_single_workout`, `schedule_plan`, `upload_and_schedule_plan`, `send_to_device` |

There is also an `update_weekly_workouts` prompt that walks through the weekly review. Plans are addressed as `workout-plans/<name>.json` or `data/<profile>/<name>.json`; only `.json` documents under those two roots exist (the token cache and `.env` files are never reachable). Every `write_plan` / `upsert_plan_workout` keeps the previous version in the [history](#storage).

Garmin write tools are marked destructive so the client asks before running them, and the server instructions tell Claude to get your explicit confirmation first. Uploads delete and recreate any workout that already has a `workoutId` and write the new IDs back into the plan file.

### Run it in Docker (e.g. on a NAS)

Run this from a checkout of the repo on the NAS. The plans live in the database (`./data/garmin.db`), so nothing else needs to be mounted.

```bash
mkdir -p config data
cp .env.MED config/                      # one .env.<profile> per Garmin account
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose up -d --build
```

Volumes (see `docker-compose.yml`):

| Mount | Purpose |
|---|---|
| `./config:/config:ro` | `.env.<profile>` files with the Garmin credentials |
| `./data:/data` | the database `garmin.db`: all plans and data, the activities and the Garmin login tokens (see [Storage](#storage)) |

The container runs as `PUID:PGID` (default 1000:1000), so `data/` must be writable by that user. Set `PUID`/`PGID` in `.env` to match your NAS user. The port is published on `127.0.0.1:8787` only; set `MCP_BIND=0.0.0.0` to allow LAN clients. `GET /healthz` is the unauthenticated health check.

The same compose file also starts `garmin-web`, the [plan editor](#plan-editor-web-ui) (shared image; `/data` and `/config` mounts, the last one for the Garmin buttons). It needs `WEB_AUTH_TOKEN` in `.env` (`echo "WEB_AUTH_TOKEN=$(openssl rand -hex 16)" >> .env`) and is published on `127.0.0.1:8788`; set `WEB_BIND=0.0.0.0` for LAN access. Sign in with any user name and the token as password (or with a profile name and its `WEB_PASSWORD`).

### Storage

Plans and per-profile data (`workout-plans/*.json`, `data/<profile>/*.json`: workout exports, `training-plan.json`) and every profile's Garmin activities live in one SQLite database, `garmin.db` in the data directory, shared by the MCP server and the web editor. It needs no extra service and no native module (it uses `node:sqlite`, which comes with Node 22.13+).

- **History**: every save keeps the version it replaces (the last 100 per document), with who saved it. Saving identical text changes nothing. Saves from the web editor carry the version they were based on and are refused if someone else saved in between.
- **Ownership**: a plan a profile login creates in `workout-plans/` belongs to that profile; the admin and MCP tools create shared plans. `data/<profile>/` always belongs to its profile.
- **Command line** (`npm run store -- <command>`, in Docker `docker exec garmin-mcp node dist/storeCli.js <command>`): `list [prefix]`, `history <path>`, `show <path> [id]`, `restore <path> [id]` (the last earlier version by default; also brings back a deleted document), `trash`, `owner <path> <profile|shared>`, `export <dir>`.
- **Backups**: the database is one file. Copy it while the services are idle, or use `sqlite3 garmin.db ".backup copy.db"`; `export <dir>` writes every document back out as a plain `.json` file for git or editing.
- **Activities** are not documents but rows of an `activities` table in the same database, one per Garmin activity and profile: Garmin's list item as it came, the activity's details (RPE and feel, strength sets, run splits) once fetched, and the columns the views sort by. An activity is written once and rarely changes on Garmin, so a stored one is never fetched again, except the details of a young one (under 3 days old), which are fetched again at most every 6 hours until they are 3 days old, because feel and RPE are entered after the workout. The first `get_activities` call on a profile lists the whole history (100 per call to Garmin) and stores it, then a background job fetches every activity's details, one call every half second (`GARMIN_DETAIL_GAP_MS`), newest first; it stops on a rate limit or a login failure and says why in the `sync` part of the next answer. After a rate limit it starts again by itself ten minutes later (up to 12 times in a row); after a login failure it never retries on its own, because repeated logins could lock the account, and the next `get_activities` call after ten minutes resumes it. A listing that gets through clears the error. Later calls ask Garmin only for what is new. A lease in the database keeps the MCP server and the web editor from syncing the same profile at once. Mock mode stores nothing.
- **No plan files**: plans and data are never read from or written to the disk by the services. `export <dir>` writes every document out as a `.json` file when you want one for git or editing.

### Make it reachable from claude.ai

claude.ai connects from the internet, so the server needs a public HTTPS URL. Either put it behind your NAS reverse proxy (Let's Encrypt), or use the bundled Cloudflare Tunnel:

```bash
# Cloudflare dashboard: create a tunnel, add a public hostname -> http://garmin-mcp:8787
echo "TUNNEL_TOKEN=<tunnel token>" >> .env
docker compose --profile tunnel up -d
```

Then in claude.ai (or Claude Desktop): **Settings → Connectors → Add custom connector**, with URL

```
https://<your-hostname>/mcp/<MCP_AUTH_TOKEN>
```

The token is the only credential, so anyone with that URL can change your Garmin account. It is compared in constant time, never logged by the server, and wrong tokens get a plain 404. Reverse proxies and tunnels may log request paths; rotate the token (edit `.env`, `docker compose up -d`) if it leaks. For clients that can send headers, `POST /mcp` with `Authorization: Bearer <token>` also works.

Notes:
- The first call after a restart logs in to Garmin; the OAuth token is cached in the database (the `garmin_tokens` table, shared by the MCP server and the web editor) for 7 days; no file is written. If a fresh login fails (2FA accounts), log in once on a machine where it works and copy its `.garmin-token-cache.json` into `./data/<profile>/`: the next start takes it into the database (when it is newer than what the database has) and deletes the file.
- Bulk uploads are slow (about a second per workout plus Garmin round trips), and the 14–20 workout plans can take a minute or more. If a client or proxy times out, upload per workout with `upload_single_workout`.
- Garmin calls are serialized, one at a time.

### Local development

```bash
npm run mcp -- --mock                    # stdio, for the MCP Inspector
MCP_AUTH_TOKEN=$(openssl rand -hex 32) npm run mcp:http -- --mock --port 8787
npx @modelcontextprotocol/inspector      # then connect to http://127.0.0.1:8787/mcp/<token>
```

`--mock` (or `MOCK_MODE=true`) serves mock data and refuses every Garmin write except `dryRun` validation. Use `--profile <name>` or `GARMIN_PROFILE` to choose the default account. `GARMIN_PROFILES_DIR` and `GARMIN_DATA_DIR` relocate the credentials and the data directory (database and token cache); the Docker image sets them to `/config` and `/data`. `GARMIN_STORE_PATH` moves the database (default `<GARMIN_DATA_DIR>/garmin.db`). `GARMIN_DETAIL_GAP_MS` sets the pause between two activity-detail calls of the sync (default 500).

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
├── activityExporter.ts     # Garmin activity -> slim planning format
├── workoutEditor.ts        # Garmin workouts <-> the plan format, upload and scheduling
├── mocks.setup.ts          # Mock Garmin data for mock mode and tests
├── index.ts                # Main export
├── shared/                 # Garmin client, profiles, the SQLite store, the activity sync
├── mcp/                    # MCP server and its tools
├── web/                    # Plan editor (server and page)
└── __tests__/
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

### Self Evaluation (in the activity's details)
- `directWorkoutFeel`: How fresh you felt (1-100; 100=perfect, 50=avg, 1=very tired)
- `directWorkoutRpe`: How hard the workout was (1-100; 100=super hard, 50=avg/good target, 1=too easy)

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