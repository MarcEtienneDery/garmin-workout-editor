import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROJECT_ROOT } from "../shared/profileLoader";
import { registerGarminTools } from "./tools/garmin";
import { registerNutritionTools } from "./tools/nutrition";
import { registerPlanTools } from "./tools/plans";
import { registerWellnessTools } from "./tools/wellness";

const INSTRUCTIONS = `Tools to review Garmin training data and manage Garmin Connect workouts, for one or more Garmin profiles.

Typical weekly flow:
1. get_activities (period "last-week") to see what was actually done.
2. read_plan on the current plan (workout-plans/*.json) and on data/<profile>/training-plan.json for goals and phase.
3. Make conservative, evidence-based changes with upsert_plan_workout (look exercise names up with list_exercise_names), then validate_plan.
4. Summarize the proposed changes and the validation result to the user.

To adjust a single day's workout to how recovered the person is: get_readiness (a band of go-harder, as-planned or back-off with the signals behind it: HRV, resting heart rate, sleep, Body Battery, stress, recent load), then read the planned workout and propose a small change that fits the band. get_wellness has the daily numbers and the person's own baselines behind it. These are heuristics from watch data, not medical advice.

To log what the person ate: log_meal (a meal of a day, one item per food, with calories and protein, carbs and fat in grams that you estimate from their description and say are estimates). get_nutrition reads the log back with the day totals and the calories Garmin says the day burned; update_meal_entry and delete_meal_entry correct it. The log is kept here, never sent to Garmin, and a day with nothing logged is not a day of zero.

For one workout that belongs to no plan: create_workout makes a new workout in the Garmin library from the workout you give it and returns its workoutId (dryRun=true validates it and sends nothing: show the user that result first), and schedule_workout puts any workout of the library, by workoutId, on a day. Neither reads or writes a plan file, and create_workout never replaces a workout.

Tools that change the Garmin account — upload_workouts, upload_single_workout, schedule_plan, upload_and_schedule_plan, create_workout, schedule_workout, send_to_device — must NEVER be called without the user's explicit confirmation after you have shown them the validation result. Uploading replaces any existing workout that has a workoutId and writes the new workoutIds back into the plan file, which is what keeps later uploads from creating duplicates.`;

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The website's icon files, which this server shares: an SVG, and a PNG for the clients that do not take SVG. */
export type IconFile = "icon.svg" | "apple-touch-icon.png";
export function readIcon(name: IconFile): Buffer | undefined {
  try {
    return fs.readFileSync(path.join(__dirname, "..", "web", "public", name));
  } catch {
    return undefined;
  }
}

/**
 * The icons clients may show beside the server, as data URIs because the endpoint is behind the token and a client could not
 * fetch a URL from it. The PNG comes first: the spec has clients support PNG and JPEG, while SVG is optional. Read once, since a
 * server is built for every HTTP request; a missing file is left out.
 */
let icons: { src: string; mimeType: string; sizes: string[] }[] | undefined;
function serverIcons(): NonNullable<typeof icons> {
  icons ??= (
    [["apple-touch-icon.png", "image/png", "180x180"], ["icon.svg", "image/svg+xml", "any"]] as const
  ).flatMap(([file, mimeType, size]) => {
    const bytes = readIcon(file);
    return bytes ? [{ src: `data:${mimeType};base64,${bytes.toString("base64")}`, mimeType, sizes: [size] }] : [];
  });
  return icons;
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

export function buildDailyAdjustPrompt(date?: string, profile?: string): string {
  const day = date ? `for ${date}` : "for today";
  const profileNote = profile ? ` Use profile "${profile}".` : "";
  return `Adjust the workout ${day} to how recovered I am.${profileNote}

1. Call get_readiness${date ? ` with date ${date}` : ""}. Tell me the band and score, and for each signal what it measured and why it scored as it did. Say what is missing or low-confidence.
2. Find the workout planned ${day} (list_plans, then read_plan on the current plan; use get_activities for last week if it helps to see what I actually did).
3. Propose a small, specific change that fits the band: for go-harder, a bit more at the top of the planned range (a set or two on the main lifts, or the faster end of the pace range); for as-planned, leave it; for back-off, cut about a quarter of the volume or lower the intensity a notch, or swap in easy aerobic work. Do not make large changes from one day's data.
4. If you change the plan, use upsert_plan_workout and run validate_plan, then show me the result.
5. STOP and ask for my explicit confirmation before any Garmin upload or scheduling.`;
}

/** Build a fully-registered MCP server. Cheap to call; HTTP mode creates one per request. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "garmin-workout-editor", title: "Garmin Workout Editor", version: readVersion(), icons: serverIcons() },
    { instructions: INSTRUCTIONS }
  );

  registerGarminTools(server);
  registerPlanTools(server);
  registerWellnessTools(server);
  registerNutritionTools(server);

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

  server.registerPrompt(
    "adjust_todays_workout",
    {
      title: "Adjust a day's workout to recovery",
      description: "Check how recovered the person is (HRV, resting heart rate, sleep, Body Battery, stress, recent load) and propose a small change to the day's planned workout: a bit harder when recovered, easier when not. Asks for confirmation before any upload.",
      argsSchema: {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("The day, YYYY-MM-DD. Default: today."),
        profile: z.string().optional(),
      },
    },
    ({ date, profile }) => ({
      messages: [{ role: "user", content: { type: "text", text: buildDailyAdjustPrompt(date, profile) } }],
    })
  );

  return server;
}
