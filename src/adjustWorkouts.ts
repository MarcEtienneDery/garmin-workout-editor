/**
 * adjustWorkouts.ts — LLM-powered workout adjustment CLI
 *
 * Flow:
 *   1. Ask which week's activities to analyze (or use --last-week/--this-week)
 *   2. Sync workout library from Garmin
 *   3. Generate next-week workout template from library
 *   4. Load training progression config (data/training-plan.json)
 *   5. Send context to LLM via @github/copilot-sdk
 *   6. Per-workout interactive review: approve, edit, skip, or view each workout
 *   7. On approval: save adjusted plan, upload + schedule approved workouts to Garmin
 *   8. Append weekly summary to training plan history
 *
 * Usage:
 *   npm run adjust-workouts
 *   npm run adjust-workouts -- --this-week
 *   npm run adjust-workouts -- --activities data/activities.json --workouts data/next-week.workouts.tmp.json
 *   npm run adjust-workouts -- --init-plan
 *   npm run adjust-workouts -- --revisit-plan --plan data/training-plan.json
 *   npm run adjust-workouts -- --mock
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

import { GarminClient } from "./shared/garminClient";
import ActivityExporter from "./activityExporter";
import WorkoutEditor from "./workoutEditor";
import {
  WorkoutAdjuster,
  perWorkoutReviewLoop,
} from "./workoutAdjuster";
import { AdjustmentContext, TrainingPlan, WeeklyWorkoutPlan } from "./shared/types";

dotenv.config();

// ─── Helpers ────────────────────────────────────────────────────────────────

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function printUsage(): void {
  console.log(`
Usage: npm run adjust-workouts -- [options]

Options:
  --init-plan                  Scaffold data/training-plan.json template and exit
  --revisit-plan               Revisit and rewrite the training plan with LLM
  --last-week                  Fetch last week's activities (default)
  --this-week                  Fetch this week's activities instead
  --activities <path>          Use an already-saved activities JSON file
  --workouts <path>            Use a saved weekly workout plan JSON file (recommended: data/next-week.workouts.tmp.json)
  --plan <path>                Training plan config (default: data/training-plan.json)
  --review-notes <text>        Extra instructions for training-plan revisit
  --model <name>               Override LLM model (default: $COPILOT_MODEL or gpt-5.2)
  --output <path>              Override output path for the adjusted plan
  --dry-run                    Validate only; do not upload or schedule
  --mock                       Use mock data (no Garmin API, no LLM)

Environment variables:
  GARMIN_EMAIL / GARMIN_PASSWORD   Garmin Connect credentials
  COPILOT_MODEL                    Default LLM model name
  MOCK_MODE=true                   Enable mock mode globally
`);
}

/**
 * Generate a training-plan.json template at the given path.
 * Copies the bundled template or creates a minimal one if missing.
 */
function initTrainingPlan(outputPath: string): void {
  const templatePath = path.join(__dirname, "../data/training-plan.json");

  if (fs.existsSync(outputPath)) {
    console.log(`⚠️  ${outputPath} already exists. Delete it first to re-initialize.`);
    return;
  }

  if (fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, outputPath);
    console.log(`✅ Training plan template created at: ${outputPath}`);
  } else {
    // Minimal fallback
    const minimal: TrainingPlan = {
      version: "1.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      athlete: { name: "Athlete", experienceLevel: "intermediate" },
      goals: {
        primary: "Build overall strength and aerobic fitness",
        secondary: undefined,
        notes: undefined,
      },
      strengthBenchmarks: {},
      runningBenchmarks: {},
      periodization: {
        currentPhase: "Hypertrophy",
        weekInPhase: 1,
        totalWeeksInPhase: 4,
        phases: [
          { name: "Hypertrophy", totalWeeks: 4 },
          { name: "Strength", totalWeeks: 4 },
          { name: "Deload", totalWeeks: 1 },
        ],
      },
      constraints: {},
      weeklyHistory: [],
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(minimal, null, 2), "utf-8");
    console.log(`✅ Minimal training plan created at: ${outputPath}`);
  }

  console.log("📝 Edit the file to set your goals, benchmarks, and periodization phase, then re-run.");
}

/**
 * Prompt the user yes/no in the terminal.
 */
async function yesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<boolean>((resolve) => {
    rl.question(`${question} [y/n] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

/**
 * Prompt the user to choose which week's activities to analyze.
 * Returns { lastWeek, thisWeek } booleans.
 */
async function promptWeekChoice(): Promise<{ lastWeek: boolean; thisWeek: boolean }> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log("\nWhich week's activities should we analyze?");
    console.log("  [1] Last week (default)");
    console.log("  [2] Current week");
    rl.question("> ", (answer) => {
      rl.close();
      const choice = answer.trim();
      if (choice === "2") {
        resolve({ lastWeek: false, thisWeek: true });
      } else {
        resolve({ lastWeek: true, thisWeek: false });
      }
    });
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mockMode =
    process.env.MOCK_MODE === "true" || hasFlag("--mock");
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  const revisitPlan = hasFlag("--revisit-plan");

  console.log("🏋️  Garmin Workout Adjuster (AI-powered)");
  console.log("=========================================\n");

  if (mockMode) console.log("🔄 Running in MOCK mode (no Garmin API, no LLM)\n");

  // ── --init-plan ──────────────────────────────────────────────────────────
  if (hasFlag("--init-plan")) {
    const planOutput =
      getArgValue("--plan") ??
      path.join(__dirname, "../data/training-plan.json");
    initTrainingPlan(planOutput);
    return;
  }

  // ── Validate credentials (not needed in mock or file-only mode) ──────────
  const activitiesFilePath = getArgValue("--activities");
  const workoutsFilePath = getArgValue("--workouts");
  const needsGarmin = !activitiesFilePath || !workoutsFilePath;
  const reviewNotes = getArgValue("--review-notes");

  if (!revisitPlan && !mockMode && needsGarmin && (!email || !password)) {
    console.error("❌ Error: GARMIN_EMAIL and GARMIN_PASSWORD are required.");
    console.error("   Use --activities and --workouts to load from files instead.");
    printUsage();
    process.exit(1);
  }

  // ── Paths ────────────────────────────────────────────────────────────────
  const trainingPlanPath =
    getArgValue("--plan") ??
    path.join(__dirname, "../data/training-plan.json");
  const outputPath =
    getArgValue("--output") ??
    path.join(__dirname, "../data/workouts-adjusted.json");
  const tempActivitiesPath = path.join(__dirname, "../data/activities.json");
  const tempWorkoutsPath = path.join(__dirname, "../data/next-week.workouts.tmp.json");
  const tempWorkoutsExportPath = path.join(__dirname, "../data/workouts.json");
  const modelName = getArgValue("--model");
  const dryRun = hasFlag("--dry-run");

  if (revisitPlan) {
    if (!fs.existsSync(trainingPlanPath)) {
      console.error(`❌ Training plan not found at ${trainingPlanPath}`);
      console.error("   Run: npm run adjust-workouts -- --init-plan");
      process.exit(1);
    }

    const adjuster = new WorkoutAdjuster({
      modelName,
      mockMode,
    });

    const trainingPlan = adjuster.loadTrainingPlan(trainingPlanPath);
    const activities =
      activitiesFilePath && fs.existsSync(activitiesFilePath)
        ? adjuster.loadActivities(activitiesFilePath)
        : undefined;
    const workoutPlan =
      workoutsFilePath && fs.existsSync(workoutsFilePath)
        ? adjuster.loadWorkoutPlan(workoutsFilePath)
        : undefined;

    console.log("📘 Revisit mode: training plan");
    console.log(`   Plan       : ${trainingPlanPath}`);
    if (activities) {
      console.log(`   Activities : ${activities.totalActivities} (${activities.weekStart} → ${activities.weekEnd})`);
    }
    if (workoutPlan) {
      console.log(`   Workouts   : ${workoutPlan.workouts.length} (${workoutPlan.weekStart} → ${workoutPlan.weekEnd})`);
    }

    const planOutputPath = getArgValue("--output") ?? trainingPlanPath;

    console.log(`\n🤖 Initializing LLM session (model: ${modelName ?? process.env.COPILOT_MODEL ?? "gpt-5.2"})...`);
    await adjuster.createSession();

    try {
      const result = await adjuster.revisitTrainingPlan(trainingPlan, {
        activities,
        currentPlan: workoutPlan,
        reviewNotes,
      });

      fs.writeFileSync(
        planOutputPath,
        JSON.stringify(result.updatedPlan, null, 2),
        "utf-8"
      );

      console.log(`\n✅ Revised training plan saved to ${planOutputPath}`);
      if (result.summary) {
        console.log("\n📝 LLM Summary:");
        console.log("─".repeat(60));
        console.log(result.summary);
        console.log("─".repeat(60));
      }
    } catch (e) {
      console.error(`\n❌ Training plan revisit failed: ${(e as Error).message}`);
      process.exitCode = 1;
    } finally {
      await adjuster.cleanup();
    }

    return;
  }

  // ── Week selection: flags override, otherwise prompt interactively ─────
  let thisWeek: boolean;
  let lastWeek: boolean;
  if (hasFlag("--this-week")) {
    thisWeek = true;
    lastWeek = false;
  } else if (hasFlag("--last-week")) {
    thisWeek = false;
    lastWeek = true;
  } else if (!activitiesFilePath) {
    const choice = await promptWeekChoice();
    thisWeek = choice.thisWeek;
    lastWeek = choice.lastWeek;
  } else {
    // Loading from file — week flags irrelevant
    thisWeek = false;
    lastWeek = true;
  }

  // ── Garmin client ────────────────────────────────────────────────────────
  const garminClient = new GarminClient(
    email ?? "dummy@example.com",
    password ?? "dummy",
    mockMode
  );
  const activityExporter = new ActivityExporter(garminClient);
  const workoutEditor = new WorkoutEditor(garminClient);

  // ── Step 1: Load / fetch activities ──────────────────────────────────────
  let resolvedActivitiesPath = activitiesFilePath;

  if (!resolvedActivitiesPath) {
    console.log(`📥 Fetching ${lastWeek ? "last" : "this"} week's activities from Garmin...`);
    const success = await activityExporter.extract(
      50,
      tempActivitiesPath,
      false,
      lastWeek,
      thisWeek
    );
    if (!success) {
      console.error("❌ Failed to fetch activities. Try --activities <path> to use a saved file.");
      process.exit(1);
    }
    resolvedActivitiesPath = tempActivitiesPath;
    console.log(`✅ Activities saved to ${tempActivitiesPath}\n`);
  } else {
    console.log(`📂 Loading activities from ${resolvedActivitiesPath}`);
  }

  // ── Step 2: Sync workout library from Garmin ──────────────────────────────
  if (!workoutsFilePath && !mockMode) {
    console.log("📥 Syncing workout library from Garmin...");
    try {
      await workoutEditor.exportWorkouts(tempWorkoutsExportPath, true, false);
    } catch (e) {
      console.error(`❌ Could not sync workout library: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // ── Step 3: Load / fetch next week's workout plan ─────────────────────────
  let resolvedWorkoutsPath = workoutsFilePath;

  if (!resolvedWorkoutsPath) {
    console.log("📥 Generating next-week workout plan from Garmin library...");
    try {
      await workoutEditor.generateNextWeekPlanTemplate(tempWorkoutsPath);
      resolvedWorkoutsPath = tempWorkoutsPath;
      console.log(`✅ Workout template saved to ${tempWorkoutsPath}\n`);
    } catch (e) {
      console.error(`❌ Failed to generate workout template: ${(e as Error).message}`);
      console.error("   Try --workouts <path> to use a saved plan file.");
      process.exit(1);
    }
  } else {
    console.log(`📂 Loading workout plan from ${resolvedWorkoutsPath}`);
  }

  // ── Step 4: Load training plan ────────────────────────────────────────────
  if (!fs.existsSync(trainingPlanPath)) {
    console.error(`❌ Training plan not found at ${trainingPlanPath}`);
    console.error("   Run: npm run adjust-workouts -- --init-plan");
    process.exit(1);
  }

  // ── Step 5: Build context object ─────────────────────────────────────────
  const adjuster = new WorkoutAdjuster({
    modelName,
    mockMode,
  });

  const activities = adjuster.loadActivities(resolvedActivitiesPath);
  const workoutPlan = adjuster.loadWorkoutPlan(resolvedWorkoutsPath);
  const trainingPlan = adjuster.loadTrainingPlan(trainingPlanPath);

  console.log(`\n📊 Context loaded:`);
  console.log(`   Activities : ${activities.totalActivities} (${activities.weekStart} → ${activities.weekEnd})`);
  console.log(`   Workouts   : ${workoutPlan.workouts.length} (${workoutPlan.weekStart} → ${workoutPlan.weekEnd})`);
  console.log(`   Phase      : ${trainingPlan.periodization.currentPhase} (week ${trainingPlan.periodization.weekInPhase}/${trainingPlan.periodization.totalWeeksInPhase})\n`);

  const context: AdjustmentContext = {
    activities,
    currentPlan: workoutPlan,
    trainingPlan,
  };

  // ── Step 6: Create LLM session ────────────────────────────────────────────
  console.log(`🤖 Initializing LLM session (model: ${modelName ?? process.env.COPILOT_MODEL ?? "gpt-5.2"})...`);
  await adjuster.createSession();

  // ── Step 7: Initial analysis ──────────────────────────────────────────────
  let analysisResult;
  try {
    analysisResult = await adjuster.analyzeAndAdjust(context);
  } catch (e) {
    console.error(`\n❌ LLM analysis failed: ${(e as Error).message}`);
    await adjuster.cleanup();
    process.exit(1);
  }

  // ── Step 8: Per-workout interactive review ───────────────────────────────
  const approvedPlan = await perWorkoutReviewLoop(adjuster, analysisResult, workoutPlan);

  if (!approvedPlan) {
    // User quit — save current state anyway
    const quitPath = outputPath.replace(".json", ".draft.json");
    fs.writeFileSync(
      quitPath,
      JSON.stringify(analysisResult.adjustedPlan, null, 2),
      "utf-8"
    );
    console.log(`\n💾 Draft saved to ${quitPath}`);
    console.log("   Re-run with --workouts to continue from this draft.");
    await adjuster.cleanup();
    return;
  }

  // ── Step 9: Save approved plan ────────────────────────────────────────────
  fs.writeFileSync(outputPath, JSON.stringify(approvedPlan, null, 2), "utf-8");
  console.log(`\n✅ Adjusted plan saved to ${outputPath}`);

  // ── Step 10: Upload & schedule ────────────────────────────────────────────
  if (!dryRun) {
    const doUpload = await yesNo("\n🚀 Upload and schedule workouts to Garmin?");
    if (doUpload) {
      try {
        console.log("\n📤 Uploading workouts...");
        await workoutEditor.uploadWorkoutsFromFile(outputPath, false);
        console.log("\n📅 Scheduling workouts...");
        await workoutEditor.scheduleWorkoutPlan(approvedPlan);
        console.log("\n✅ Workouts uploaded and scheduled!");
      } catch (e) {
        console.error(`\n❌ Upload/schedule failed: ${(e as Error).message}`);
        console.error(`   You can retry manually: npm run manage-workouts -- --import-and-schedule ${outputPath}`);
        process.exit(1);
      }
    }
  } else {
    console.log("\n🔍 DRY-RUN: Upload skipped.");
    try {
      await workoutEditor.uploadWorkoutsFromFile(outputPath, true);
    } catch (e) {
      console.error(`Validation error: ${(e as Error).message}`);
    }
  }

  // ── Step 11: Append weekly summary ───────────────────────────────────────
  try {
    await adjuster.appendWeekSummary(context, trainingPlanPath);
    // Also advance periodization week counter
    trainingPlan.periodization.weekInPhase += 1;
    if (trainingPlan.periodization.weekInPhase > trainingPlan.periodization.totalWeeksInPhase) {
      const phases = trainingPlan.periodization.phases;
      const currentIdx = phases.findIndex(
        (p) => p.name === trainingPlan.periodization.currentPhase
      );
      const nextPhase = phases[(currentIdx + 1) % phases.length];
      console.log(
        `\n📈 Phase complete! Advancing: ${trainingPlan.periodization.currentPhase} → ${nextPhase.name}`
      );
      trainingPlan.periodization.currentPhase = nextPhase.name;
      trainingPlan.periodization.weekInPhase = 1;
      trainingPlan.periodization.totalWeeksInPhase = nextPhase.totalWeeks;
    }
    trainingPlan.updatedAt = new Date().toISOString();
    fs.writeFileSync(trainingPlanPath, JSON.stringify(trainingPlan, null, 2), "utf-8");
  } catch (e) {
    console.error(`\n⚠️  Could not append weekly summary: ${(e as Error).message}`);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await adjuster.cleanup();
  console.log("\n🎉 Done!");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
