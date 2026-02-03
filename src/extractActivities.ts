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
