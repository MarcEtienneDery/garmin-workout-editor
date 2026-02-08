import * as dotenv from "dotenv";
import * as path from "path";
import { GarminClient } from "./shared/garminClient";
import ActivityExporter from "./activityExporter";

// Load environment variables
dotenv.config();

async function main() {
  const mockMode =
    process.env.MOCK_MODE === "true" || process.argv.includes("--mock");
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;

  const getArgValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    if (index === -1) return undefined;
    return process.argv[index + 1];
  };

  // Check for transform-only mode
  const transformOnly = process.argv.includes("--transform-only");
  const rawInputPath = getArgValue("--transform-only");

  if (transformOnly && rawInputPath) {
    console.log("🔄 Transforming activities from file (no API fetch)");
    console.log("===================================================\n");

    const exporter = new ActivityExporter(
      new GarminClient("dummy@example.com", "dummy", true)
    );

    const weekStart = getArgValue("--week-start");
    const weekEnd = getArgValue("--week-end");
    const outputPath =
      getArgValue("--output") || rawInputPath.replace("-raw.json", ".json");

    const success = await exporter.transformAndSave(
      rawInputPath,
      outputPath,
      weekStart,
      weekEnd
    );

    if (!success) {
      process.exit(1);
    }
    return;
  }

  if (!email || !password) {
    console.error("❌ Error: Credentials are required");
    console.error(
      "Please provide GARMIN_EMAIL and GARMIN_PASSWORD in .env"
    );
    process.exit(1);
  }

  const saveRaw = process.argv.includes("--raw");
  const includeDetails = !process.argv.includes("--no-detailed");
  const lastWeekOnly = process.argv.includes("--last-week");
  const thisWeekOnly = process.argv.includes("--this-week");

  // Get limit from arguments, excluding flags
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const limit = parseInt(args[0] || "20");
  const outputPath =
    args[1] || path.join(__dirname, "../data/activities.json");

  console.log("🚀 Garmin Activity Exporter");
  console.log("===========================\n");
  if (mockMode) {
    console.log("🔄 Running in MOCK mode (test data)\n");
  }
  if (saveRaw) {
    console.log("📋 Raw data will be saved for inspection\n");
  }
  if (includeDetails) {
    console.log(
      "🔍 Detailed mode enabled - fetching self evaluation and extra data\n"
    );
    console.log("⏱️  This will take ~1 second per activity to avoid rate limiting\n");
  }
  if (lastWeekOnly) {
    console.log("📅 Filtering to last week's activities only\n");
  }
  if (thisWeekOnly) {
    console.log("📅 Filtering to this week's activities only\n");
  }

  const garminClient = new GarminClient(email, password, mockMode);
  const exporter = new ActivityExporter(garminClient);

  const success = await exporter.extract(
    limit,
    outputPath,
    saveRaw,
    lastWeekOnly,
    thisWeekOnly
  );

  if (success) {
    console.log("\n✅ Activity export completed successfully!");
  } else {
    console.log("\n❌ Activity export failed");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
