import * as dotenv from "dotenv";
import * as path from "path";
import { GarminClient } from "./shared/garminClient";
import WorkoutEditor from "./workoutEditor";

// Load environment variables
dotenv.config();

async function main() {
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  const mockMode =
    process.env.MOCK_MODE === "true" || process.argv.includes("--mock");

  const getArgValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    if (index === -1) return undefined;
    return process.argv[index + 1];
  };

  if (!email || !password) {
    console.error("❌ Error: Credentials are required");
    console.error(
      "Please provide GARMIN_EMAIL and GARMIN_PASSWORD in .env"
    );
    process.exit(1);
  }

  const exportWorkouts = process.argv.includes("--export");
  const generateTemplate = process.argv.includes("--generate-template");
  const scheduleFromPlan = process.argv.includes("--schedule");
  const copyPlanNextWeek = process.argv.includes("--copy-next-week");
  const importAndSchedule = process.argv.includes("--import-and-schedule");

  const workoutsOutputPath =
    getArgValue("--output") ||
    path.join(__dirname, "../data/workouts.json");
  const templateOutputPath =
    getArgValue("--template-output") ||
    path.join(__dirname, "../data/next-week.workouts.tmp.json");
  const planInputPath =
    getArgValue("--schedule") ||
    getArgValue("--copy-next-week") ||
    getArgValue("--import-and-schedule");

  console.log("🏋️  Garmin Workout Manager");
  console.log("===========================\n");
  if (mockMode) {
    console.log("🔄 Running in MOCK mode (test data)\n");
  }

  const garminClient = new GarminClient(email, password, mockMode);
  const editor = new WorkoutEditor(garminClient);

  try {
    if (exportWorkouts) {
      console.log("📤 Exporting workouts with full details...\n");
      await editor.exportWorkouts(workoutsOutputPath, true);
      console.log("\n✅ Workout export completed successfully!");
      return;
    }

    if (generateTemplate) {
      console.log(
        "📝 Generating next week workout plan template...\n"
      );
      await editor.generateNextWeekPlanTemplate(templateOutputPath);
      console.log(
        "\n✅ Next-week workout template generated successfully!"
      );
      return;
    }

    if (copyPlanNextWeek) {
      if (!planInputPath) {
        console.error(
          "❌ Error: Missing plan input path for --copy-next-week"
        );
        console.error("Usage: npm run manage-workouts -- --copy-next-week <path>");
        process.exit(1);
      }

      console.log("📋 Copying workout plan to next week...\n");
      await editor.copyWorkoutPlanToNextWeek(
        planInputPath,
        templateOutputPath
      );
      console.log(
        "\n✅ Next-week workout plan copied successfully!"
      );
      return;
    }

    if (scheduleFromPlan) {
      if (!planInputPath) {
        console.error("❌ Error: Missing plan input path for --schedule");
        console.error("Usage: npm run manage-workouts -- --schedule <path>");
        process.exit(1);
      }

      console.log("📅 Scheduling workouts from plan...\n");
      const plan = await editor.importWorkoutPlan(planInputPath);
      await editor.scheduleWorkoutPlan(plan);
      console.log("\n✅ Workout plan scheduled successfully!");
      return;
    }

    if (importAndSchedule) {
      if (!planInputPath) {
        console.error(
          "❌ Error: Missing plan input path for --import-and-schedule"
        );
        console.error(
          "Usage: npm run manage-workouts -- --import-and-schedule <path>"
        );
        process.exit(1);
      }

      console.log("📥 Importing and scheduling workouts...\n");
      const plan = await editor.importWorkoutPlan(planInputPath);
      await editor.addToCalendar(plan);
      console.log("\n✅ Workouts imported and scheduled successfully!");
      return;
    }

    // Default: show usage
    console.log("Usage:");
    console.log(
      "  npm run manage-workouts -- --export                     Export all workouts with details"
    );
    console.log(
      "  npm run manage-workouts -- --generate-template          Generate next week template"
    );
    console.log(
      "  npm run manage-workouts -- --copy-next-week <path>      Copy plan to next week"
    );
    console.log(
      "  npm run manage-workouts -- --schedule <path>            Schedule workouts from plan"
    );
    console.log(
      "  npm run manage-workouts -- --import-and-schedule <path> Import and add to calendar"
    );
    console.log("\nOptions:");
    console.log("  --output <path>              Set workout export output path");
    console.log(
      "  --template-output <path>     Set template/plan output path"
    );
    console.log("  --mock                       Use mock data for testing");
  } catch (error: any) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
