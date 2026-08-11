/**
 * testPrompt.ts — Display the full LLM prompt for review and adjustment
 *
 * This utility loads sample data and shows the exact prompt that would be
 * sent to the LLM, allowing you to review and refine the prompt.
 *
 * Usage:
 *   npm run test-prompt
 *   npm run test-prompt -- --output data/prompt-debug.md
 *
 * It will:
 *   1. Load activities.json (completed activities from last week)
 *   2. Load next-week.workouts.tmp.json (template for next week)
 *   3. Load training-plan.json (progression context)
 *   4. Build the full system prompt + user prompt
 *   5. Display it in the terminal
 *   6. Save to a file for easy review
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { WorkoutAdjuster } from "./workoutAdjuster";
import {
  ExtractedActivities,
  WeeklyWorkoutPlan,
  TrainingPlan,
} from "./shared/types";

dotenv.config();

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main() {
  const outputFile =
    getArgValue("--output") || "data/prompt-debug.md";
  const dataDir = "data";

  console.log("📋 Building LLM prompt for review...\n");

  // Load data files
  let activities: ExtractedActivities | null = null;
  let workoutPlan: WeeklyWorkoutPlan | null = null;
  let trainingPlan: TrainingPlan | null = null;

  const activitiesPath = path.join(dataDir, "activities.json");
  const workoutPath = path.join(dataDir, "next-week.workouts.tmp.json");
  const planPath = path.join(dataDir, "training-plan.json");

  if (!fs.existsSync(activitiesPath)) {
    console.warn(`⚠️  Activities file not found: ${activitiesPath}`);
    console.log("   (You can generate this by running: npm run export-activities)");
  } else {
    activities = JSON.parse(fs.readFileSync(activitiesPath, "utf-8"));
    console.log(`✅ Loaded activities from ${activitiesPath}`);
  }

  if (!fs.existsSync(workoutPath)) {
    console.warn(`⚠️  Workout plan not found: ${workoutPath}`);
    console.log("   (You can generate this by running: npm run manage-workouts -- --next-week)");
  } else {
    workoutPlan = JSON.parse(fs.readFileSync(workoutPath, "utf-8"));
    console.log(`✅ Loaded weekly workouts from ${workoutPath}`);
  }

  if (!fs.existsSync(planPath)) {
    console.warn(`⚠️  Training plan not found: ${planPath}`);
    console.log("   (You can initialize this by running: npm run adjust-workouts -- --init-plan)");
  } else {
    trainingPlan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
    console.log(`✅ Loaded training plan from ${planPath}`);
  }

  if (!activities || !workoutPlan || !trainingPlan) {
    console.error("\n❌ Missing required data files. Please ensure:");
    console.error("   1. data/activities.json exists");
    console.error("   2. data/next-week.workouts.tmp.json exists");
    console.error("   3. data/training-plan.json exists");
    process.exit(1);
  }

  console.log("\n📍 Building prompt structure...\n");

  // Create adjuster to build the prompt components
  const adjuster = new WorkoutAdjuster({
    modelName: process.env.COPILOT_MODEL ?? "gpt-5.2",
    mockMode: true, // Don't need LLM for this
  });

  // Build the system prompt
  const systemPrompt = adjuster.buildSystemPrompt();

  // Trim workouts to next week
  const trimmedPlan: WeeklyWorkoutPlan = {
    ...workoutPlan,
    workouts: workoutPlan.workouts.filter((w) => {
      if (!w.scheduledDate) return false;
      const weekStart = new Date(workoutPlan.weekStart);
      const weekEnd = new Date(workoutPlan.weekEnd);
      const dates = Array.isArray(w.scheduledDate)
        ? w.scheduledDate
        : [w.scheduledDate];
      return dates.some((d) => {
        const scheduled = new Date(d);
        return scheduled >= weekStart && scheduled <= weekEnd;
      });
    }),
  };

  // Filter activities to last week
  const filteredActivitiesArray = activities.activities.slice(-7);
  // Compact activities (same logic as in WorkoutAdjuster)
  const compactActs = filteredActivitiesArray.map((a) => ({
    activityName: a.activityName,
    activityType: a.activityType,
    startTime: a.startTime,
    duration: a.duration,
    distance: a.distance,
    avgHR: a.avgHR,
    maxHR: a.maxHR,
    avgPace: a.avgPace,
    aerobicTrainingEffect: a.aerobicTrainingEffect,
    anaerobicTrainingEffect: a.anaerobicTrainingEffect,
    trainingEffectLabel: a.trainingEffectLabel,
    directWorkoutFeel: a.directWorkoutFeel,
    directWorkoutRpe: a.directWorkoutRpe,
    differenceBodyBattery: a.differenceBodyBattery,
    totalSets: a.totalSets,
    totalReps: a.totalReps,
    exerciseSets: (a.exerciseSets ?? []).slice(0, 8),
  }));

  // Build the user prompt (exactly as in adjustWorkouts.ts)
  const userPrompt = `
## Last week's completed activities

Week: ${activities.weekStart} to ${activities.weekEnd}
Total activities: ${activities.totalActivities}

${JSON.stringify(compactActs, null, 2)}

---

## Current workout plan for next week

Week: ${trimmedPlan.weekStart} to ${trimmedPlan.weekEnd}

${JSON.stringify(trimmedPlan, null, 2)}

---

## Full Training Plan

${JSON.stringify(trainingPlan, null, 2)}

---

Analyze the completed activities vs the plan. Consider:
- Which workouts were completed vs missed?
- How did actual performance (weights used, pace, HR, RPE, body battery) compare to the targets in the plan?
- Are we on track for the ${trainingPlan.periodization.currentPhase} phase goals?
- What adjustments should we make to next week's workouts?

Return the adjusted WeeklyWorkoutPlan JSON, then SUMMARY:.
`.trim();

  // Display in terminal
  console.log("═".repeat(80));
  console.log("SYSTEM PROMPT (appended to every message)");
  console.log("═".repeat(80));
  console.log(systemPrompt);
  console.log("\n");

  console.log("═".repeat(80));
  console.log("USER PROMPT (the analysis request)");
  console.log("═".repeat(80));
  console.log(userPrompt);
  console.log("\n");

  // Save to file
  const fullPrompt = `# LLM Prompt Debug

**Generated:** ${new Date().toISOString()}

## System Message (Appended)

\`\`\`
${systemPrompt}
\`\`\`

## User Message

\`\`\`
${userPrompt}
\`\`\`

---

## Data Summary

- Activities: ${activities.totalActivities} total, ${compactActs.length} shown
- Workouts: ${trimmedPlan.workouts.length} planned for next week
- Training phase: ${trainingPlan.periodization.currentPhase}
- Week in phase: ${trainingPlan.periodization.weekInPhase} of ${trainingPlan.periodization.totalWeeksInPhase}

`;

  fs.writeFileSync(outputFile, fullPrompt);
  console.log(`✅ Saved full prompt to: ${outputFile}`);
  console.log(`   Open it in an editor to review the instructions and context.\n`);

  // Print helpful tips
  console.log("💡 Tips for improving the prompt:");
  console.log("   1. Review the SYSTEM RULES — are they clear and complete?");
  console.log("   2. Check the BUSINESS RULES — do they guide the LLM correctly?");
  console.log("   3. Look at the user prompt data — is it well structured?");
  console.log("   4. Edit buildSystemPrompt() in src/workoutAdjuster.ts to adjust");
  console.log("   5. Re-run this command to see your changes");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
