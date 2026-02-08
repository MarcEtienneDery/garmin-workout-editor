# Transform-Only Workflow Guide

This document describes the new **transform-only** functionality that allows you to re-run transformation logic on saved raw data without hitting the Garmin API.

## Why This Is Useful

- **Avoid Rate Limiting**: Once you've fetched and saved raw data, you can re-transform it as many times as you want locally without triggering Garmin's rate limits
- **Iterate Faster**: Modify transformation logic and test it immediately without waiting for API calls
- **Flexible Date Ranges**: Override week boundaries when transforming activities

## Activities: Transform-Only Workflow

### 1. Fetch Raw Activities (First Time Only)
```bash
npm run export-activities -- 20 --raw
```

This creates:
- `data/activities.json` - Transformed activities
- `data/activities-raw.json` - Raw API response (for re-transforming)

### 2. Re-transform Raw Activities (No API Call)
```bash
npm run export-activities -- --transform-only data/activities-raw.json
```

This:
- Reads the raw JSON file
- Applies transformation logic
- Outputs to `data/activities.json` (or specify `--output <path>`)
- No authentication or API calls needed

### 3. Re-transform with Custom Week Dates
```bash
npm run export-activities -- --transform-only data/activities-raw.json \
  --week-start 2026-02-02 \
  --week-end 2026-02-08 \
  --output data/activities-custom-week.json
```

**Options:**
- `--output <path>` - Output file (default: replace `-raw.json` with `.json`)
- `--week-start <YYYY-MM-DD>` - Override week start date
- `--week-end <YYYY-MM-DD>` - Override week end date

## Workouts: Transform-Only Workflow

### 1. Fetch Raw Workouts (First Time Only)
```bash
npm run manage-workouts -- --export --raw
```

This creates:
- `data/workouts.json` - Transformed workouts
- `data/workouts-raw.json` - Raw API response (for re-transforming)

### 2. Re-transform Raw Workouts (No API Call)
```bash
npm run manage-workouts -- --transform-only data/workouts-raw.json
```

This:
- Reads the raw JSON file
- Applies transformation logic (flattens nested steps, extracts exercise data, etc.)
- Outputs to `data/workouts.json` (or specify `--output <path>`)
- No authentication or API calls needed

**Options:**
- `--output <path>` - Output file (default: replace `-raw.json` with `.json`)

## Workflow Example

Here's a typical workflow to avoid being throttled:

```bash
# Step 1: Fetch everything once (takes time, may hit rate limits)
npm run export-activities -- 50 --raw
npm run manage-workouts -- --export --raw

# Step 2: Now you can iterate locally without API calls
# Re-run transformation with modifications as many times as needed
npm run export-activities -- --transform-only data/activities-raw.json
npm run manage-workouts -- --transform-only data/workouts-raw.json

# Step 3: Try different date ranges
npm run export-activities -- --transform-only data/activities-raw.json \
  --week-start 2026-02-09 --week-end 2026-02-15
```

## Implementation Details

### ActivityExporter Changes
- **New Method**: `transformAndSave()` - Loads raw activities from file and applies transformation
- **New Method**: `loadRawActivitiesFromFile()` - Reads raw activity JSON
- **Separation**: Fetch logic (`fetchActivities`) and transformation logic (`transformActivities`) are now completely independent

### WorkoutEditor Changes
- **New Method**: `transformAndSaveWorkouts()` - Loads raw workouts from file and applies transformation
- **New Method**: `loadRawWorkoutsFromFile()` - Reads raw workout JSON
- **Private Helper**: `transformSingleWorkout()` - Transforms one workout
- **Private Helper**: `transformWorkouts()` - Transforms array of workouts
- **Separation**: Fetch logic (`fetchWorkoutsWithRaw`) and transformation logic are now independent

### CLI Updates
- `exportActivities.ts` - Added `--transform-only` flag support
- `manageWorkouts.ts` - Added `--transform-only` flag support

## File Format Notes

### Activities Raw Format
The raw file can be:
1. An array of activities (from Garmin API)
2. An `ExtractedActivities` object with `.activities` array

### Workouts Raw Format
The raw file must be:
1. An array of raw workout objects (from Garmin API)
2. Or an object with `.workouts` array

## Example: Modifying Transformation Logic

If you want to modify the transformation logic:

1. Edit `src/activityExporter.ts` or `src/workoutEditor.ts`
2. Build: `npm run build`
3. Re-transform: `npm run export-activities -- --transform-only data/activities-raw.json`
4. No need to fetch from Garmin again!

This makes iterating on transformation logic extremely fast.
