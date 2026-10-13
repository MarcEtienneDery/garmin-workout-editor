import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROJECT_ROOT } from "../shared/profileLoader";
import { registerGarminTools } from "./tools/garmin";
import { registerPlanTools } from "./tools/plans";

const INSTRUCTIONS = `Tools to review Garmin training data and manage Garmin Connect workouts, for one or more Garmin profiles.

Concepts (they are different things; do not mix them up):
- Activity: something the athlete DID — a completed run or strength session recorded by the watch (get_activities). Read-only history with actual duration, heart rate, training effect, RPE/feel, running intervals and the real sets/reps/weights performed. Cached in data/<profile>/activities.json.
- Workout: something the athlete is TO DO — one planned session (name, type, flat list of steps, optional scheduledDate). Workouts live in the Garmin Connect workout library (list_workouts, get_workout; each has a workoutId) and inside plan files. Editing a workout in a plan file changes nothing on Garmin until it is uploaded.
- Plan: a JSON file holding a set of workouts (usually one week: generatedAt, weekStart, weekEnd, notes, workouts[]) in workout-plans/*.json. This is the editable draft: you change it with upsert_plan_workout/write_plan, check it with validate_plan, then push it to Garmin with the upload/schedule tools. Do not confuse it with data/<profile>/training-plan.json, which is the long-term training plan: goals, phase/periodization, constraints. Read it for context; it is not uploaded.
- Profile: one Garmin account. Its stored data lives in data/<profile>/ (activities.json, workouts.json, training-plan.json). Tools take an optional profile; list_profiles shows what exists.
- Flow of data: activity (what happened) -> informs edits to the plan (what to do next) -> upload creates Garmin workouts (workoutId written back to the plan) -> schedule puts them on the calendar by scheduledDate -> send_to_device pushes them to the watch. Completed workouts then show up as new activities.

Typical weekly flow:
1. get_activities (period "last-week") to see what was actually done.
2. read_plan on the current plan (workout-plans/*.json) and on data/<profile>/training-plan.json for goals and phase.
3. Make conservative, evidence-based changes with upsert_plan_workout (look exercise names up with list_exercise_names), then validate_plan.
4. Summarize the proposed changes and the validation result to the user.

Tools that change the Garmin account — upload_workouts, upload_single_workout, schedule_plan, upload_and_schedule_plan, send_to_device — must NEVER be called without the user's explicit confirmation after you have shown them the validation result. Uploading replaces any existing workout that has a workoutId and writes the new workoutIds back into the plan file, which is what keeps later uploads from creating duplicates.`;

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function buildWeeklyUpdatePrompt(planFile?: string, profile?: string): string {
  const plan = planFile ?? "the current workout plan (list_plans shows what exists)";
  const profileNote = profile ? ` Use profile "${profile}".` : "";
  return `Update this week's strength and running workouts from the latest Garmin activity data.${profileNote}

1. Call get_activities for last week and review actual performance: strength loads, reps, missed sets and time-constrained accessories; running duration, distance, heart rate and perceived effort when available.
2. Read ${plan} and the profile's training-plan.json (read_plan) for the plan, goals and periodization phase.
3. Update the plan for the current week with upsert_plan_workout. Keep changes conservative and evidence-based:
   - increase loads only when last week was clearly below target effort and execution was complete
   - reduce or hold volume when execution was incomplete because of fatigue or time
   - keep running to at most 2 sessions per week unless asked otherwise, and each run to at most 60 minutes unless asked otherwise
4. Run validate_plan on the edited file.
5. Summarize the changes, why they were made from last week's data, and whether validation passed.
6. STOP and ask the user for explicit confirmation before any Garmin upload or scheduling.
7. Only after they approve, call upload_and_schedule_plan and confirm the resulting workout IDs and scheduled dates.`;
}

/** Build a fully-registered MCP server. Cheap to call; HTTP mode creates one per request. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "garmin-workout-editor", version: readVersion() },
    { instructions: INSTRUCTIONS }
  );

  registerGarminTools(server);
  registerPlanTools(server);

  server.registerPrompt(
    "update_weekly_workouts",
    {
      title: "Update weekly workouts",
      description:
        "Review last week's Garmin activities, adjust the workout plan conservatively, validate it, and (after confirmation) upload and schedule it.",
      argsSchema: {
        planFile: z.string().optional().describe('e.g. "workout-plans/workouts-full-body-maintenance.json"'),
        profile: z.string().optional(),
      },
    },
    ({ planFile, profile }) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: buildWeeklyUpdatePrompt(planFile, profile) },
        },
      ],
    })
  );

  return server;
}
