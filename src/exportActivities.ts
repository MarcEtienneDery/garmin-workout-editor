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
    const typeFilter = getArgValue("--type");
    const outputPath =
      getArgValue("--output") || rawInputPath.replace("-raw.json", ".json");

    const success = await exporter.transformAndSave(
      rawInputPath,
      outputPath,
      weekStart,
      weekEnd,
      typeFilter
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
  const last4WeeksOnly = process.argv.includes("--last-4-weeks");
  const typeFilter = getArgValue("--type");

  // Compute --last-4-weeks as a customWeekStart (Monday 4 weeks ago)
  let customWeekStart = getArgValue("--week-start");
  let customWeekEnd = getArgValue("--week-end");
  if (last4WeeksOnly && !customWeekStart) {
    const now = new Date();
    const utcDay = now.getUTCDay();
    const daysSinceMonday = utcDay === 0 ? 6 : utcDay - 1;
    const monday4WeeksAgo = new Date(now);
    monday4WeeksAgo.setUTCDate(now.getUTCDate() - daysSinceMonday - 21);
    monday4WeeksAgo.setUTCHours(0, 0, 0, 0);
    customWeekStart = monday4WeeksAgo.toISOString().split("T")[0];
  }

  // Get limit from positional arguments, excluding flags and their values
  const flagsWithValues = new Set(["--type", "--week-start", "--week-end", "--output", "--transform-only"]);
  const args: string[] = [];
  const rawArgs = process.argv.slice(2);
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith("--")) {
      if (flagsWithValues.has(arg)) i++; // skip the value too
    } else {
      args.push(arg);
    }
  }
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
  if (last4WeeksOnly) {
    console.log(`📅 Filtering to last 4 weeks (from ${customWeekStart})\n`);
  }
  if (typeFilter) {
    console.log(`🏃 Filtering to activity type: ${typeFilter}\n`);
  }
  if (customWeekStart) {
    console.log(`📅 Filtering from: ${customWeekStart}${customWeekEnd ? ` → ${customWeekEnd}` : " onwards"}\n`);
  }

  const garminClient = new GarminClient(email, password, mockMode);
  const exporter = new ActivityExporter(garminClient);

  const success = await exporter.extract(
    limit,
    outputPath,
    saveRaw,
    includeDetails,
    lastWeekOnly,
    thisWeekOnly,
    typeFilter,
    customWeekStart,
    customWeekEnd
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
