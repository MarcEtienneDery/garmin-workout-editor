# Browser suite (Playwright)

`npm run e2e` runs the whole suite against two servers it starts itself, each on a database made for the run
(`e2e/support/server.ts`): nothing touches your data, Garmin, Renpho, Open Food Facts or Claude.

| Project | Server | What it is |
|---|---|---|
| `desktop` | `127.0.0.1:8792` | the app as a person **without a Garmin login** meets it, with `e2e/support/seed.ts` stored. 1280×860. |
| `phone` | the same | `*.phone.spec.ts` only, on a Pixel 7. |
| `mock` | `127.0.0.1:8793` | mock mode (`MOCK_MODE=true`): Garmin looks connected, answers with generated workouts/activities and refuses every write. Specs live in `e2e/specs/mock/`. No seeded profiles: sign in as `admin` with `ADMIN_TOKEN`. |

```bash
npm run e2e                                          # everything
npx playwright test e2e/specs/food --project=desktop # one area
npx playwright test -g "adds a food" --headed        # one test, watched
npx playwright show-report e2e/report                # the HTML report of the last run
```

Servers already running on those ports are reused (`reuseExistingServer`), which makes reruns quick. Time zone is UTC for the
server and the browsers, so `today()` from `support/dates.ts` is the page's "today".

* A run that starts the servers itself stops them when it ends. To run several `playwright` commands at once (or to keep the servers
  for a day of work) start them once, detached: `setsid nohup npx tsx e2e/support/server.ts &` and
  `E2E_PORT=8793 setsid nohup npx tsx e2e/support/server.ts mock &`; kill them by their ports (`lsof -ti:8792 | xargs kill`).
* Every test that changes data makes a profile of its own, so a long-lived server accumulates profiles (thousands slow the pages that
  list them). Restart the servers for a clean database before a full run.
* Two runs at once share `e2e/results`; give the second one `--output=<dir>`.
* The seed is built at server start: change `e2e/support/seed.ts`, restart the servers.

## What is seeded

Import `test`/`expect` from `../support/fixtures` (or `../../support/fixtures` in `specs/mock/`).

* **alice** (password `PASSWORD`): no Garmin login, so Workouts is hidden; Today, Plans, Calendar, Activities, Recovery, Weight and
  Food are shown. She has
  * plans `workout-plans/alice-run-block.json` (4 workouts: "Easy run" `workoutId` 7001 scheduled 2 days ago and done by an
    activity, "Tempo intervals" today with a warmup/4×(1 km + recovery)/cooldown, "Long run" in 3 days, "Full body strength"
    in 1 and 5 days), `workout-plans/alice-someday.json` (no dates), and the shared `workout-plans/shared-base.json` (a walk in 2 days; anyone sees it);
  * about 30 activities (a run every other day for 5 weeks, a gym session a week, 2 rides, "Today's shakeout" today, the
    "Easy run" of 2 days ago with details, laps, zones, a heart-rate/pace/elevation series and a GPS route);
  * 45 days of sleep, HRV and daily summaries, and a weigh-in every third day (82 kg now, 40 g lighter for each day back, so the trend is gaining);
  * food on each of the 5 days before today (breakfast Oatmeal 300 kcal and Banana 105, lunch Chicken wrap 520, dinner Salmon and
    rice 640, snack Greek yogurt 130 = 1695 kcal a day) and goals of 2200 kcal, 130 g protein, 250 g carbs, 70 g fat. Nothing today.
* **bob**: signs in, has nothing. He must never see alice's data.
* **`profile`/`me`**: a fresh empty profile per test, with `profile.api` to seed it through the API; use these for anything that changes data.
* **`admin`**: an API client signed in with the access token.

**alice's data is read-only.** Specs run in parallel on one database; a test that changes anything makes its own profile.

## Writing specs

* One file per area under `e2e/specs/`; name it `<area>.spec.ts`. Group with `test.describe`, keep each test about one behaviour.
* Prefer ids and roles the page has (`#vFood`, `getByRole("button", { name: "Recent" })`). Never `waitForTimeout`; wait for what the
  page will show with web-first assertions (`await expect(locator).toHaveText(...)`).
* The page needs no network: foods (`/api/foods/search`, `/api/foods/barcode`, `/api/foods/ai`), OpenStreetMap tiles and the camera are
  answered with `page.route` / launch options by the spec that needs them. Block `**/tile.openstreetmap.org/**` in any spec that opens a map.
* The API wants `X-Requested-With: plan-editor` on every non-GET request (`CSRF` from fixtures); `profile.api` and `admin` send it.
* A test that fails because the app is wrong is not weakened to pass: mark it `test.fixme(...)` with a comment saying what the app does,
  and say so in your report.

## What the suite records about the app (`test.fixme`)

A `test.fixme` is a behaviour the suite expects and the app does not have yet; its comment says what the app does. They run (and fail)
when the `fixme` is removed, so fixing the app means deleting the word.

| Spec | The app today |
|---|---|
| `settings` | A calorie goal typed as `2,000` is saved as 2 kcal and the page says "Goals saved." (the comma is read as a decimal point). |
| `food.phone` | The picker's quantity field is 13 px on a phone (the base `.fpq input { font: inherit }` comes after the mobile 16 px rule), so iOS zooms in when it is focused. |
| `food-log` | Deleting a food has no Undo. A reload shows today again: the day shown is kept in memory, not in the address. |
| `food-ai` | Words typed while a photo is being prepared are lost: the box is redrawn when the photo is ready. |
| `recovery` | Two quick presses of ◀ step back one day, not two (the step is taken from the day last drawn). |
| `plans-files` | Rename with unsaved edits that conflict with a change elsewhere ignores the 409 and goes ahead (the next Save overwrites the other change). "+ New" and Duplicate create the file before asking whether to discard unsaved edits, so Cancel leaves a new file behind. After the open file is deleted, Checks keeps the last file's result. The Archived group stays open once it was auto-opened for an archived open file. |
| `mock/*` | In mock mode the web editor treats Garmin as off: the Workouts list is empty (no request is made), Activities lists nothing, the empty states of Recovery and Weight say Garmin is not connected, no Sync button is shown. |
