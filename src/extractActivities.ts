import * as dotenv from "dotenv";
import * as path from "path";
import GarminExtractor from "./garminExtractor";

// Load environment variables
dotenv.config();

async function main() {
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  const sessionCookie = process.env.GARMIN_SESSION_COOKIE;
  const mockMode = process.env.MOCK_MODE === "true" || process.argv.includes("--mock");

  if (!sessionCookie && (!email || !password)) {
    console.error(
      "❌ Error: Credentials are required"
    );
    console.error("Provide ONE of the following:");
    console.error("  1. GARMIN_EMAIL and GARMIN_PASSWORD in .env");
    console.error("  2. GARMIN_SESSION_COOKIE in .env or environment");
    console.error("");
    console.error("For session cookie method, see GET_SESSION.md");
    process.exit(1);
  }

  const extractor = new GarminExtractor(email || "", password || "", mockMode);
  const limit = parseInt(process.argv[2] || "20");
  const outputPath =
    process.argv[3] || path.join(__dirname, "../data/activities.json");

  console.log("🚀 Garmin Activity Extractor");
  console.log("============================\n");
  if (mockMode) {
    console.log("🔄 Running in MOCK mode (test data)\n");
  }
  if (sessionCookie) {
    console.log("🔑 Using session cookie authentication\n");
  }

  const success = await extractor.extract(limit, outputPath);

  if (success) {
    console.log("\n✅ Extraction completed successfully!");
  } else {
    console.log("\n❌ Extraction failed");
    console.log("\n� Authentication Issue Detected:");
    console.log("   Garmin is blocking automated login attempts.");
    console.log("");
    console.log("🔧 Quick Fixes:");
    console.log("   1. Use session cookie method (recommended):");
    console.log("      → See GET_SESSION.md for instructions");
    console.log("      → Extract cookie from browser after logging in");
    console.log("      → Set: export GARMIN_SESSION_COOKIE=\"<your-cookie>\"");
    console.log("");
    console.log("   2. Disable 2FA if enabled:");
    console.log("      → Go to https://connect.garmin.com/");
    console.log("      → Account Settings → Security → Disable 2FA");
    console.log("      → Try again");
    console.log("");
    console.log("   3. Check account status:");
    console.log("      → Log in manually at https://connect.garmin.com/");
    console.log("      → Ensure account isn't locked");
    console.log("");
    console.log("📖 Full details: See AUTH_ISSUES.md and GET_SESSION.md");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
