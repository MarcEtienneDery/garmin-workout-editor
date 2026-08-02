import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { GarminClient } from "./shared/garminClient";
import WorkoutEditor from "./workoutEditor";
import { requireProfile } from "./shared/profileLoader";

// Load base env (for non-profile vars)
dotenv.config();

async function main() {
  const mockMode =
    process.env.MOCK_MODE === "true" || process.argv.includes("--mock");

  // Load profile (required unless mock mode)
  const profile = requireProfile(mockMode);
  const email = profile.email;
  const password = profile.password;
  const dataDir = profile.dataDir;

  console.log(`👤 Profile: ${profile.name}`);

  const getArgValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    if (index === -1) return undefined;
    return process.argv[index + 1];
  };

  const exportWorkouts = process.argv.includes("--export");
  const generateTemplate = process.argv.includes("--generate-template");
  const scheduleFromPlan = process.argv.includes("--schedule");
  const copyPlanNextWeek = process.argv.includes("--copy-next-week");
  const importAndSchedule = process.argv.includes("--import-and-schedule");
  const uploadWorkouts = process.argv.includes("--upload");
  const uploadSingle = process.argv.includes("--upload-single");
  const sendToDevice = process.argv.includes("--send-to-device");
  const startNewPlan = process.argv.includes("--start-new-plan");
  const saveRaw = process.argv.includes("--raw");
  const dryRun = process.argv.includes("--dry-run");

  if (!mockMode && !startNewPlan && (!email || !password)) {
    console.error("❌ Error: Credentials are required");
    console.error(
      "Please provide GARMIN_EMAIL and GARMIN_PASSWORD in .env.<profile>"
    );
    process.exit(1);
  }

  const workoutsOutputPath =
    getArgValue("--output") ||
    path.join(dataDir, "workouts.json");
  const templateOutputPath =
    getArgValue("--template-output") ||
    path.join(dataDir, "next-week.workouts.tmp.json");
  const planInputPath =
    getArgValue("--schedule") ||
    getArgValue("--copy-next-week") ||
    getArgValue("--import-and-schedule");
  const startNewPlanWorkoutPath = getArgValue("--start-new-plan");
  const trainingPlanPath =
    getArgValue("--plan") ||
    path.join(dataDir, "training-plan.json");
  const uploadInputPath = getArgValue("--upload");
  const uploadWorkoutId = getArgValue("--upload-single");
  const sendToDevicePath = getArgValue("--send-to-device");
  const deviceIdArg = getArgValue("--device-id");

  console.log("🏋️  Garmin Workout Manager");
  console.log("===========================\n");
  if (mockMode) {
    console.log("🔄 Running in MOCK mode (test data)\n");
  }
  if (dryRun) {
    console.log("🔍 DRY-RUN mode enabled (validation only, no API changes)\n");
  }

  const garminClient = new GarminClient(
    email ?? "dummy@example.com",
    password ?? "dummy",
    mockMode,
    dataDir
  );
  const editor = new WorkoutEditor(garminClient);

  try {
    if (startNewPlan) {
      if (!startNewPlanWorkoutPath) {
        console.error(
          "❌ Error: Missing workout plan path for --start-new-plan"
        );
        console.error("Usage: npm run manage-workouts -- --start-new-plan <workout-plan-path> --plan <training-plan-path>");
        process.exit(1);
      }

      console.log("🆕 Starting new training plan and resetting schedule...\n");
      await editor.startNewTrainingPlan(
        trainingPlanPath,
        startNewPlanWorkoutPath
      );
      console.log("\n✅ Training plan updated and schedule reset successfully!");
      return;
    }

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
      await editor.uploadAndScheduleWorkoutPlan(plan);
      
      // Save the updated plan with new workoutIds back to the file
      console.log("\n💾 Saving updated workout IDs to file...");
      fs.writeFileSync(planInputPath, JSON.stringify(plan, null, 2), "utf-8");
      console.log(`✅ Updated file with new workout IDs: ${planInputPath}`);
      
      console.log("\n✅ Workouts imported and scheduled successfully!");
      return;
    }

    if (uploadWorkouts) {
      if (!uploadInputPath) {
        console.error("❌ Error: Missing file path for --upload");
        console.error("Usage: npm run manage-workouts -- --upload <path>");
        console.error("Example: npm run manage-workouts -- --upload data/workouts.json");
        process.exit(1);
      }

      console.log(dryRun ? "🔍 Validating workouts...\n" : "📤 Uploading workouts to Garmin...\n");
      const result = await editor.uploadWorkoutsFromFile(uploadInputPath, dryRun);
      
      if (!dryRun) {
        if (result.failed > 0) {
          console.log("\n⚠️  Some workouts failed to upload");
          process.exit(1);
        } else {
          console.log("\n✅ All workouts uploaded successfully!");
        }
      }
      return;
    }

    if (uploadSingle) {
      if (!uploadWorkoutId) {
        console.error("❌ Error: Missing workout ID for --upload-single");
        console.error("Usage: npm run manage-workouts -- --upload-single <workout-id>");
        console.error("Example: npm run manage-workouts -- --upload-single 12345678");
        process.exit(1);
      }

      console.log(dryRun ? "🔍 Validating single workout...\n" : "📤 Uploading single workout to Garmin...\n");
      
      // Load workouts file
      const workoutsPath = getArgValue("--file") || path.join(__dirname, "../data/workouts.json");
      const fileContent = require("fs").readFileSync(workoutsPath, "utf-8");
      const data = JSON.parse(fileContent);
      
      let workouts = Array.isArray(data) ? data : data.workouts;
      const workout = workouts.find((w: any) => String(w.workoutId) === String(uploadWorkoutId));
      
      if (!workout) {
        console.error(`❌ Error: Workout with ID ${uploadWorkoutId} not found in ${workoutsPath}`);
        process.exit(1);
      }

      const newId = await editor.uploadWorkout(workout, dryRun);
      
      if (!dryRun && newId === null) {
        console.log("\n❌ Workout upload failed");
        process.exit(1);
      } else if (!dryRun && newId !== null && newId !== -1) {
        // Write updated ID back to source file
        workout.workoutId = newId;
        const updatedWorkouts = Array.isArray(data) ? workouts : { ...data, workouts };
        require("fs").writeFileSync(workoutsPath, JSON.stringify(updatedWorkouts, null, 2));
        console.log(`\n📝 Updated workout ID to ${newId} in ${workoutsPath}`);
        console.log("\n✅ Workout uploaded successfully!");
      }
      return;
    }

    if (sendToDevice) {
      if (!sendToDevicePath) {
        console.error("❌ Error: Missing file path for --send-to-device");
        console.error("Usage: npm run manage-workouts -- --send-to-device <path> [--device-id <id>]");
        process.exit(1);
      }

      const fileContent = fs.readFileSync(sendToDevicePath, "utf-8");
      const data = JSON.parse(fileContent);
      let workouts = Array.isArray(data) ? data : data.workouts;

      if (!workouts || workouts.length === 0) {
        console.error("❌ Error: No workouts found in file");
        process.exit(1);
      }

      // Filter to only workouts flagged with sendToDevice: true
      const flagged = workouts.filter((w: any) => w.sendToDevice);
      const toSend = flagged.length > 0 ? flagged : workouts;

      if (flagged.length > 0) {
        console.log(`📋 Found ${flagged.length} workout(s) flagged with sendToDevice\n`);
      } else {
        console.log(`📋 No sendToDevice flags found — sending all ${toSend.length} workout(s)\n`);
      }

      const deviceId = deviceIdArg ? Number(deviceIdArg) : undefined;
      await editor.sendWorkoutsToDevice(toSend, deviceId);
      console.log("\n✅ Workouts sent to device successfully!");
      return;
    }

    // Default: show usage
    console.log("Usage:");
    console.log(
      "  npm run export-activities -- --transform-only <raw-file>   Transform activities from raw file"
    );
    console.log(
      "  npm run manage-workouts -- --transform-only <raw-file>     Transform workouts from raw file"
    );
    console.log(
      "  npm run export-activities -- 20                            Export last 20 activities"
    );
    console.log(
      "  npm run manage-workouts -- --export                        Export all workouts with details"
    );
    console.log(
      "  npm run manage-workouts -- --generate-template             Generate next week template"
    );
    console.log(
      "  npm run manage-workouts -- --copy-next-week <path>         Copy plan to next week"
    );
    console.log(
      "  npm run manage-workouts -- --start-new-plan <path> --plan <training-plan-path>"
    );
    console.log(
      "  npm run manage-workouts -- --schedule <path>               Schedule workouts from plan"
    );
    console.log(
      "  npm run manage-workouts -- --import-and-schedule <path>    Import and add to calendar"
    );
    console.log(
      "  npm run manage-workouts -- --upload <path>                 Upload workouts to Garmin (delete + recreate)"
    );
    console.log(
      "  npm run manage-workouts -- --upload-single <id>            Upload single workout by ID"
    );
    console.log(
      "  npm run manage-workouts -- --send-to-device <path>         Send workouts to watch/device"
    );
    console.log("\nOptions:");
    console.log("  --output <path>              Set workout export output path");
    console.log(
      "  --template-output <path>     Set template/plan output path"
    );
    console.log("  --plan <path>                Training plan path (for --start-new-plan)");
    console.log("  --week-start <YYYY-MM-DD>    Override week start date (transform only)");
    console.log("  --week-end <YYYY-MM-DD>      Override week end date (transform only)");
    console.log("  --file <path>                Specify workouts file (for --upload-single)");
    console.log("  --device-id <id>             Target device ID (for --send-to-device, auto-detects if omitted)");
    console.log("  --dry-run                    Validate and preview without uploading");
    console.log("  --mock                       Use mock data for testing");
    console.log("  --raw                        Save raw API response for debugging");
  } catch (error: any) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
