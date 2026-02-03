import * as dotenv from "dotenv";
import * as path from "path";
import GarminExtractor from "./garminExtractor";

// Load environment variables
dotenv.config();

async function main() {
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  const mockMode = process.env.MOCK_MODE === "true" || process.argv.includes("--mock");
  const saveRaw = process.argv.includes("--raw");
  const includeDetails = !process.argv.includes("--no-detailed");
  const lastWeekOnly = process.argv.includes("--last-week");
  const exportWorkouts = process.argv.includes("--export-workouts");
  const exportNextWeekTemp = process.argv.includes("--export-next-week-temp");
  const scheduleFromPlan = process.argv.includes("--schedule-from-plan");
  const copyPlanNextWeek = process.argv.includes("--copy-plan-next-week");

  const getArgValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    if (index === -1) return undefined;
    return process.argv[index + 1];
  };

  if (!email || !password) {
    console.error("❌ Error: Credentials are required");
    console.error("Please provide GARMIN_EMAIL and GARMIN_PASSWORD in .env");
    process.exit(1);
  }

  const extractor = new GarminExtractor(email, password, mockMode);
  
  // Get limit from arguments, excluding flags
  const args = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
  const limit = parseInt(args[0] || "20");
  const outputPath = args[1] || path.join(__dirname, "../data/activities.json");

  const workoutsOutputPath = getArgValue("--workouts-output") || path.join(__dirname, "../data/workouts.json");
  const planOutputPath = getArgValue("--plan-output") || path.join(__dirname, "../data/next-week.workouts.tmp.json");
  const planInputPath = getArgValue("--schedule-from-plan") || getArgValue("--copy-plan-next-week");

  console.log("🚀 Garmin Activity Extractor (Weekly Planning Mode)");
  console.log("===================================================\n");
  if (mockMode) {
    console.log("🔄 Running in MOCK mode (test data)\n");
  }
  if (saveRaw) {
    console.log("📋 Raw data will be saved for inspection\n");
  }
  if (includeDetails) {
    console.log("🔍 Detailed mode enabled - fetching self evaluation and extra data\n");
    console.log("⏱️  This will take ~1 second per activity to avoid rate limiting\n");
  }
  if (lastWeekOnly) {
    console.log("📅 Filtering to last week's activities only\n");
  }

  if (exportWorkouts) {
    await extractor.exportWorkoutsToFile(workoutsOutputPath);
    console.log("\n✅ Workout export completed successfully!");
    return;
  }

  if (exportNextWeekTemp) {
    await extractor.exportNextWeekPlanTemp(planOutputPath);
    console.log("\n✅ Next-week workout template export completed successfully!");
    return;
  }

  if (copyPlanNextWeek) {
    if (!planInputPath) {
      console.error("❌ Error: Missing plan input path for --copy-plan-next-week");
      process.exit(1);
    }

    await extractor.copyWorkoutPlanToNextWeek(planInputPath, planOutputPath);
    console.log("\n✅ Next-week workout plan copied successfully!");
    return;
  }

  if (scheduleFromPlan) {
    if (!planInputPath) {
      console.error("❌ Error: Missing plan input path for --schedule-from-plan");
      process.exit(1);
    }

    const plan = await extractor.importWorkoutPlanFromFile(planInputPath);
    await extractor.scheduleWorkoutPlan(plan);
    console.log("\n✅ Workout plan scheduled successfully!");
    return;
  }

  const success = await extractor.extract(limit, outputPath, saveRaw, includeDetails, lastWeekOnly);

  if (success) {
    console.log("\n✅ Extraction completed successfully!");
  } else {
    console.log("\n❌ Extraction failed");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
