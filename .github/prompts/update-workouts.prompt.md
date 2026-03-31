---
mode: agent
description: Use when updating this week's strength and running workouts from the latest Garmin activity data. Fetch last week's activities, review performance, adjust the maintenance workout file, validate it, and schedule the workouts in Garmin.
tools:
  ["run_in_terminal", "read_file", "apply_patch"]
---

# Update Weekly Workouts

Use this workflow when updating the current week's training plan in this repository.

Steps:

1. Export the most recent activities first so the latest completed week is available in `data/activities.json`.
2. Review the recent activities for actual performance:
   - strength loads, reps, missed sets, and any time-constrained accessories
   - running duration, distance, heart rate, and perceived effort when available
3. Update `data/workouts-full-body-maintenance.json` for the current week.
4. Keep changes conservative and evidence-based:
   - increase loads only when last week was clearly below target effort and execution was complete
   - reduce or hold volume when execution was incomplete because of fatigue or time
   - keep running at no more than 2 sessions per week unless explicitly asked otherwise
   - keep individual runs at no more than 60 minutes unless explicitly asked otherwise
5. Validate the edited workout file with the repo's dry-run workflow.
6. Summarize the proposed changes and validation result for the user.
7. Stop and ask for explicit user confirmation before any Garmin upload or scheduling.
8. Only after the user approves, run the import-and-schedule command and confirm the resulting workout IDs and scheduled dates.

Repository-specific expectations:

- Primary workout file: `data/workouts-full-body-maintenance.json`
- Activity export command: `npm run export-activities -- 10`
- Validation command: `npm run manage-workouts -- --upload data/workouts-full-body-maintenance.json --dry-run --mock`
- Upload command: `npm run manage-workouts -- --import-and-schedule data/workouts-full-body-maintenance.json`

When responding, keep the summary short and focus on:

- what changed in the workout file
- why the changes were made from last week's data
- whether validation passed
- whether Garmin upload/scheduling was completed

Never upload or schedule workouts without an explicit user confirmation after the validation summary.