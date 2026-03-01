/**
 * adjustWorkouts.ts — LLM-powered workout adjustment CLI
 *
 * Flow:
 *   1. Fetch last/this week's activities from Garmin (or load from file)
 *   2. Load next week's workout plan (or load from file)
 *   3. Load training progression config (data/training-plan.json)
 *   4. Send context to LLM via @github/copilot-sdk
 *   5. Interactive CLI loop: review → give feedback → re-adjust
 *   6. On approval: save adjusted plan, optionally upload + schedule to Garmin
 *   7. Append weekly summary to training plan history
 *
 * Usage:
 *   npm run adjust-workouts
 *   npm run adjust-workouts -- --this-week
 *   npm run adjust-workouts -- --activities data/activities.json --workouts data/next-week.workouts.tmp.json
 *   npm run adjust-workouts -- --init-plan
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
  interactiveLoop,
  formatChangeSummary,
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
  --last-week                  Fetch last week's activities (default)
  --this-week                  Fetch this week's activities instead
  --activities <path>          Use an already-saved activities JSON file
  --workouts <path>            Use an already-saved workout plan JSON file
  --plan <path>                Training plan config (default: data/training-plan.json)
  --model <name>               Override LLM model (default: $COPILOT_MODEL or claude-sonnet-4.5)
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mockMode =
    process.env.MOCK_MODE === "true" || hasFlag("--mock");
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;

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

  if (!mockMode && needsGarmin && (!email || !password)) {
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
  const modelName = getArgValue("--model");
  const dryRun = hasFlag("--dry-run");

  const thisWeek = hasFlag("--this-week");
  // Default to last week if neither flag is given
  const lastWeek = !thisWeek;

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

  // ── Step 2: Load / fetch next week's workout plan ─────────────────────────
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

  // ── Step 3: Load training plan ────────────────────────────────────────────
  if (!fs.existsSync(trainingPlanPath)) {
    console.error(`❌ Training plan not found at ${trainingPlanPath}`);
    console.error("   Run: npm run adjust-workouts -- --init-plan");
    process.exit(1);
  }

  // ── Step 4: Build context object ─────────────────────────────────────────
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

  // ── Step 5: Create LLM session ────────────────────────────────────────────
  console.log(`🤖 Initializing LLM session (model: ${modelName ?? process.env.COPILOT_MODEL ?? "claude-sonnet-4.5"})...`);
  await adjuster.createSession();

  // ── Step 6: Initial analysis ──────────────────────────────────────────────
  let analysisResult;
  try {
    analysisResult = await adjuster.analyzeAndAdjust(context);
  } catch (e) {
    console.error(`\n❌ LLM analysis failed: ${(e as Error).message}`);
    await adjuster.cleanup();
    process.exit(1);
  }

  // ── Step 7: Interactive loop ──────────────────────────────────────────────
  const approvedPlan = await interactiveLoop(adjuster, analysisResult, workoutPlan);

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

  // ── Step 8: Save approved plan ────────────────────────────────────────────
  fs.writeFileSync(outputPath, JSON.stringify(approvedPlan, null, 2), "utf-8");
  console.log(`\n✅ Adjusted plan saved to ${outputPath}`);

  // ── Step 9: Upload & schedule ─────────────────────────────────────────────
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
        console.error(`   You can retry manually: npm run manage-workouts -- --upload-and-schedule ${outputPath}`);
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

  // ── Step 10: Append weekly summary ────────────────────────────────────────
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
