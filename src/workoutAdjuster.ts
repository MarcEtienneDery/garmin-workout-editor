import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
// @github/copilot-sdk is ESM-only; loaded via dynamic import in createSession()
import {
  AdjustmentContext,
  AdjustmentResult,
  ExtractedActivities,
  GarminActivity,
  TrainingPlan,
  WeeklyWorkoutPlan,
  PlannedWorkout,
  WorkoutStep,
  WeekSummary,
  WeeklySummaryResult,
} from "./shared/types";

const DEFAULT_MODEL = process.env.COPILOT_MODEL ?? "gpt-5.4";

// ─── JSON extraction helpers ──────────────────────────────────────────────────

/**
 * Extract the first valid JSON object or array from a string that may contain
 * markdown fences, prose, etc.
 */
export function extractJson(text: string): unknown {
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : text.trim();

  try {
    return JSON.parse(candidate);
  } catch {
    // Try to locate the largest JSON object/array by scanning for { or [
    const starts = [...candidate.matchAll(/[{[]/g)].map((m) => m.index!);
    for (const start of starts) {
      const slice = candidate.slice(start);
      try {
        return JSON.parse(slice);
      } catch {
        // try next start position
      }
    }
    throw new Error("No valid JSON found in LLM response");
  }
}

// ─── Diff / display helpers ──────────────────────────────────────────────────

function describeStep(step: WorkoutStep): string {
  if (step.stepType === "repeat") {
    return `repeat×${step.numberOfRepeats ?? "?"} [${(step.repeatSteps ?? [])
      .map(describeStep)
      .join(", ")}]`;
  }
  const parts: string[] = [step.stepType];
  if (step.exerciseName) parts.push(step.exerciseName);
  if (step.endConditionValue !== undefined && step.endCondition) {
    parts.push(`${step.endConditionValue}${step.endCondition === "reps" ? " reps" : step.endCondition === "time" ? "s" : "m"}`);
  }
  if (
    step.reps !== undefined &&
    !(step.endCondition === "reps" && step.endConditionValue === step.reps)
  ) {
    parts.push(`${step.reps} reps`);
  }
  if (
    step.durationSeconds !== undefined &&
    !(step.endCondition === "time" && step.endConditionValue === step.durationSeconds)
  ) {
    parts.push(`${step.durationSeconds}s`);
  }
  if (
    step.distanceMeters !== undefined &&
    !(step.endCondition === "distance" && step.endConditionValue === step.distanceMeters)
  ) {
    parts.push(`${step.distanceMeters}m`);
  }
  if (step.weightPercentage !== undefined)
    parts.push(`@${step.weightPercentage}%`);
  else if (step.weight !== undefined) parts.push(`@${step.weight}lbs`);
  if (step.targetValueOne !== undefined && step.targetValueTwo !== undefined)
    parts.push(`target:${step.targetValueOne}-${step.targetValueTwo}`);
  return parts.join(" ");
}

type StepDiffOp =
  | { type: "equal"; oldIndex: number; newIndex: number }
  | { type: "replace"; oldIndex: number; newIndex: number }
  | { type: "remove"; oldIndex: number }
  | { type: "add"; newIndex: number };

function shouldMergeIntoReplace(oldStep: WorkoutStep, newStep: WorkoutStep): boolean {
  if (oldStep.stepType !== newStep.stepType) {
    return false;
  }

  const oldExercise = normalizeExerciseName(oldStep.exerciseName);
  const newExercise = normalizeExerciseName(newStep.exerciseName);

  if (oldExercise || newExercise) {
    return oldExercise === newExercise;
  }

  if (oldStep.endCondition && newStep.endCondition) {
    return oldStep.endCondition === newStep.endCondition;
  }

  return true;
}

function normalizeExerciseName(name: string | undefined): string {
  if (!name) return "";
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeSelectorText(text: string | undefined): string {
  if (!text) return "";
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function tokenizeSelectorText(text: string | undefined): string[] {
  const normalized = normalizeSelectorText(text);
  if (!normalized) return [];

  const stopWords = new Set([
    "WORKOUT",
    "SESSION",
    "THE",
    "AND",
    "WITH",
    "FOR",
    "DAY",
    "EASY",
    "QUALITY",
  ]);

  return normalized
    .split("_")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stopWords.has(token));
}

function inferWorkoutTypeFromText(text: string | undefined): PlannedWorkout["workoutType"] | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();

  if (lower.includes("bike") || lower.includes("cycling") || lower.includes("cycle")) {
    return "cycling";
  }

  if (lower.includes("swim") || lower.includes("swimming")) {
    return "swimming";
  }

  if (
    lower.includes("run") ||
    lower.includes("pace") ||
    lower.includes("interval") ||
    lower.includes("tempo") ||
    lower.includes("threshold") ||
    lower.includes("zone") ||
    lower.includes("km")
  ) {
    return "running";
  }

  if (
    lower.includes("squat") ||
    lower.includes("bench") ||
    lower.includes("deadlift") ||
    lower.includes("lift") ||
    lower.includes("strength")
  ) {
    return "strength_training";
  }

  return undefined;
}

interface WeeklySelectionTarget {
  day: string;
  workoutNameHint?: string;
  normalizedNameHint?: string;
  workoutTypeHint?: PlannedWorkout["workoutType"];
  tokens: string[];
}

function sameScheduledDate(
  aDate?: string | string[],
  bDate?: string | string[]
): boolean {
  if (!aDate || !bDate) return false;
  const aArr = Array.isArray(aDate) ? aDate : [aDate];
  const bArr = Array.isArray(bDate) ? bDate : [bDate];
  if (aArr.length !== bArr.length) return false;
  return aArr.every((d, i) => d === bArr[i]);
}

function formatScheduledDate(date?: string | string[]): string {
  if (!date) return "unscheduled";
  if (Array.isArray(date)) return date.join(", ");
  return date;
}

function workoutIdentityMatches(
  a: PlannedWorkout | undefined,
  b: PlannedWorkout
): boolean {
  if (!a) return false;

  if (a.workoutId !== undefined && b.workoutId !== undefined) {
    if (String(a.workoutId) === String(b.workoutId)) return true;
  }

  if (
    a.workoutName === b.workoutName &&
    a.scheduledDate &&
    b.scheduledDate &&
    sameScheduledDate(a.scheduledDate, b.scheduledDate)
  ) {
    return true;
  }

  return a.workoutName === b.workoutName;
}

function findMatchingWorkoutIndex(
  workouts: PlannedWorkout[],
  target: PlannedWorkout,
  usedIndices?: Set<number>
): number {
  const isUsed = (index: number) => (usedIndices ? usedIndices.has(index) : false);

  if (target.workoutId !== undefined) {
    const byId = workouts.findIndex(
      (workout, index) =>
        !isUsed(index) &&
        workout.workoutId !== undefined &&
        String(workout.workoutId) === String(target.workoutId)
    );
    if (byId !== -1) return byId;
  }

  if (target.scheduledDate) {
    const byNameDate = workouts.findIndex(
      (workout, index) =>
        !isUsed(index) &&
        workout.workoutName === target.workoutName &&
        sameScheduledDate(workout.scheduledDate, target.scheduledDate)
    );
    if (byNameDate !== -1) return byNameDate;
  }

  return workouts.findIndex(
    (workout, index) =>
      !isUsed(index) && workout.workoutName === target.workoutName
  );
}

function diffSteps(oldSteps: WorkoutStep[], newSteps: WorkoutStep[]): StepDiffOp[] {
  const oldDesc = oldSteps.map(describeStep);
  const newDesc = newSteps.map(describeStep);
  const m = oldDesc.length;
  const n = newDesc.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => 0)
  );

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldDesc[i] === newDesc[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const rawOps: Array<
    { type: "equal"; oldIndex: number; newIndex: number } |
    { type: "remove"; oldIndex: number } |
    { type: "add"; newIndex: number }
  > = [];

  let i = 0;
  let j = 0;

  while (i < m && j < n) {
    if (oldDesc[i] === newDesc[j]) {
      rawOps.push({ type: "equal", oldIndex: i, newIndex: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rawOps.push({ type: "remove", oldIndex: i });
      i++;
    } else {
      rawOps.push({ type: "add", newIndex: j });
      j++;
    }
  }

  while (i < m) {
    rawOps.push({ type: "remove", oldIndex: i });
    i++;
  }

  while (j < n) {
    rawOps.push({ type: "add", newIndex: j });
    j++;
  }

  // Smart merging: pair consecutive removes with consecutive adds
  const mergedOps: StepDiffOp[] = [];
  let k = 0;
  while (k < rawOps.length) {
    const current = rawOps[k];
    
    if (current.type === "remove") {
      // Collect all consecutive removes
      const removes: Array<{ oldIndex: number; k: number }> = [];
      let idx = k;
      while (idx < rawOps.length && rawOps[idx].type === "remove") {
        removes.push({ oldIndex: (rawOps[idx] as any).oldIndex, k: idx });
        idx++;
      }
      
      // Collect all consecutive adds that follow
      const adds: Array<{ newIndex: number; k: number }> = [];
      let addIdx = idx;
      while (addIdx < rawOps.length && rawOps[addIdx].type === "add") {
        adds.push({ newIndex: (rawOps[addIdx] as any).newIndex, k: addIdx });
        addIdx++;
      }
      
      // Pair removes with adds by index first, then by content
      const usedAdds = new Set<number>();
      for (const remove of removes) {
        let found = false;
        
        // Try to match by index first
        for (let i = 0; i < adds.length; i++) {
          if (!usedAdds.has(i) && remove.oldIndex === adds[i].newIndex) {
            if (shouldMergeIntoReplace(oldSteps[remove.oldIndex], newSteps[adds[i].newIndex])) {
              mergedOps.push({
                type: "replace",
                oldIndex: remove.oldIndex,
                newIndex: adds[i].newIndex,
              });
              usedAdds.add(i);
              found = true;
              break;
            }
          }
        }
        
        // If no index match, try content-based matching
        if (!found) {
          for (let i = 0; i < adds.length; i++) {
            if (!usedAdds.has(i)) {
              if (shouldMergeIntoReplace(oldSteps[remove.oldIndex], newSteps[adds[i].newIndex])) {
                mergedOps.push({
                  type: "replace",
                  oldIndex: remove.oldIndex,
                  newIndex: adds[i].newIndex,
                });
                usedAdds.add(i);
                found = true;
                break;
              }
            }
          }
        }
        
        // If still not found, treat as standalone remove
        if (!found) {
          mergedOps.push({ type: "remove", oldIndex: remove.oldIndex });
        }
      }
      
      // Add unmatched adds
      for (let i = 0; i < adds.length; i++) {
        if (!usedAdds.has(i)) {
          mergedOps.push({ type: "add", newIndex: adds[i].newIndex });
        }
      }
      
      k = addIdx;
    } else {
      mergedOps.push(current);
      k++;
    }
  }

  return mergedOps;
}



function buildStepDiffLines(
  oldSteps: WorkoutStep[],
  newSteps: WorkoutStep[],
  arrow: string
): string[] {
  const lines: string[] = [];
  const ops = diffSteps(oldSteps, newSteps);

  // Sort operations by their final position for display
  const sortedOps = [...ops].sort((a, b) => {
    // Get sort key for each operation
    const aKey = a.type === "equal" ? -1 : a.type === "remove" ? a.oldIndex : a.newIndex;
    const bKey = b.type === "equal" ? -1 : b.type === "remove" ? b.oldIndex : b.newIndex;
    return aKey - bKey;
  });

  for (const op of sortedOps) {
    if (op.type === "equal") {
      continue;
    }

    if (op.type === "replace") {
      const oldStep = describeStep(oldSteps[op.oldIndex]);
      const newStep = describeStep(newSteps[op.newIndex]);
      const stepNumber = op.newIndex + 1;
      lines.push(`  Step ${stepNumber}: ${oldStep}  ${arrow}  ${newStep}`);
      continue;
    }

    if (op.type === "remove") {
      const oldStep = describeStep(oldSteps[op.oldIndex]);
      const stepNumber = op.oldIndex + 1;
      lines.push(`  Step ${stepNumber}: ${oldStep}  ${arrow}  (removed)`);
      continue;
    }

    const newStep = describeStep(newSteps[op.newIndex]);
    const stepNumber = op.newIndex + 1;
    lines.push(`  Step ${stepNumber}: (added)  ${arrow}  ${newStep}`);
  }

  return lines;
}

/**
 * Build a human-readable diff of two WeeklyWorkoutPlans.
 * Returns a multi-line string listing changed workouts and steps.
 */
export function formatChangeSummary(
  oldPlan: WeeklyWorkoutPlan,
  newPlan: WeeklyWorkoutPlan
): string {
  const lines: string[] = ["─── Suggested Changes ───────────────────────────"];

  const matchedOldIndices = new Set<number>();

  for (const newW of newPlan.workouts) {
    const oldIndex = findMatchingWorkoutIndex(
      oldPlan.workouts,
      newW,
      matchedOldIndices
    );
    const oldW = oldIndex !== -1 ? oldPlan.workouts[oldIndex] : undefined;

    if (oldIndex !== -1) {
      matchedOldIndices.add(oldIndex);
    }

    if (!oldW) {
      lines.push(`  ✚ NEW: ${newW.workoutName} (${formatScheduledDate(newW.scheduledDate)})`);
      continue;
    }

    const changedLines: string[] = [];

    if (!sameScheduledDate(oldW.scheduledDate, newW.scheduledDate)) {
      changedLines.push(
        `  Date: ${formatScheduledDate(oldW.scheduledDate)} → ${formatScheduledDate(newW.scheduledDate)}`
      );
    }

    const oldSteps = flattenForDiff(oldW.steps ?? []);
    const newSteps = flattenForDiff(newW.steps ?? []);
    changedLines.push(...buildStepDiffLines(oldSteps, newSteps, "→"));

    if (changedLines.length > 0) {
      lines.push(`\n📋 ${newW.workoutName} (${formatScheduledDate(newW.scheduledDate)})`);
      lines.push(...changedLines);
    }
  }

  for (let oldIndex = 0; oldIndex < oldPlan.workouts.length; oldIndex++) {
    if (matchedOldIndices.has(oldIndex)) continue;
    lines.push(`  ✖ REMOVED: ${oldPlan.workouts[oldIndex].workoutName}`);
  }

  if (lines.length === 1) lines.push("  (No structural changes detected)");
  lines.push("────────────────────────────────────────────────");
  return lines.join("\n");
}

/** Flatten repeat groups for step-level diffing */
function flattenForDiff(steps: WorkoutStep[]): WorkoutStep[] {
  const result: WorkoutStep[] = [];
  for (const s of steps) {
    if (s.stepType === "repeat" && s.repeatSteps) {
      for (let i = 0; i < (s.numberOfRepeats ?? 1); i++) {
        result.push(...flattenForDiff(s.repeatSteps));
      }
    } else {
      const legacyRepeats =
        s.stepType !== "repeat" &&
        typeof s.numberOfRepeats === "number" &&
        s.numberOfRepeats > 1
          ? s.numberOfRepeats
          : 1;

      for (let i = 0; i < legacyRepeats; i++) {
        if (legacyRepeats === 1) {
          result.push(s);
        } else {
          result.push({
            ...s,
            numberOfRepeats: undefined,
            repeatGroupIndex: undefined,
          });
        }
      }
    }
  }
  return result;
}

// ─── WorkoutAdjuster class ───────────────────────────────────────────────────

export class WorkoutAdjuster {
  // Typed as any because @github/copilot-sdk is ESM-only and loaded dynamically
  private client: any = null;
  private session: any = null;
  private modelName: string;
  private mockMode: boolean;

  constructor(options: {
    modelName?: string;
    mockMode?: boolean;
  } = {}) {
    this.modelName = options.modelName ?? DEFAULT_MODEL;
    this.mockMode = options.mockMode ?? false;
  }

  // ── Context loading ────────────────────────────────────────────────────────

  /** Load activities JSON from disk */
  loadActivities(filePath: string): ExtractedActivities {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as ExtractedActivities;
  }

  /** Load a WeeklyWorkoutPlan JSON from disk */
  loadWorkoutPlan(filePath: string): WeeklyWorkoutPlan {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    // Support both flat array and WeeklyWorkoutPlan wrapper
    if (Array.isArray(parsed)) {
      return {
        generatedAt: new Date().toISOString(),
        weekStart: "",
        weekEnd: "",
        workouts: parsed,
      };
    }
    return parsed as WeeklyWorkoutPlan;
  }

  /** Load the training plan config from disk */
  loadTrainingPlan(filePath: string): TrainingPlan {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as TrainingPlan;
  }

  // ── LLM session management ─────────────────────────────────────────────────

  /** Build the system prompt describing the task and JSON schema */
  buildSystemPrompt(): string {
    return `You are a professional strength and conditioning coach assistant.
Your job is to review an athlete's completed activities from the past week,
compare them to their planned workouts and training progression, then produce
an adjusted workout plan for the upcoming week as valid JSON.

SYSTEM RULES (FORMAT + SCHEMA):
1. Output ONLY valid JSON matching the WeeklyWorkoutPlan schema — no prose, no markdown fences.
2. Preserve all workoutId values exactly.
3. Keep workoutName and scheduledDate values unchanged unless explicitly asked to swap days.
4. Exercise names must remain in SCREAMING_SNAKE_CASE (e.g., BARBELL_BENCH_PRESS).
5. weight is in lbs (0–1000).
6. weightPercentage is 0–200 and requires a matching benchmarkKey.
7. endConditionValue must be a positive number.
8. Valid stepTypes: warmup, cooldown, interval, recovery, rest, exercise, repeat, other.
9. Valid endConditions: reps, time, distance, lap.button, iterations, calories, heart.rate.
10. Valid targetTypes: no.target, heart.rate.zone, pace.zone, speed.zone, power.zone, cadence.zone, open.
11. For repeat groups: stepType must be "repeat", include numberOfRepeats (positive integer) and repeatSteps array.
12. Paces for running targets are in m/s (targetValueOne = slower limit, targetValueTwo = faster limit).
13. Only adjust workouts that fall in the next week's date range (weekStart–weekEnd of the plan).
14. **CRITICAL: Do not add, remove, or duplicate steps; only edit existing step fields (weights/percent/reps/rest).**
15. **Preserve the exact step count and ensure unique, sequential stepOrder values.**
16. **Validate output: no duplicate steps (same exerciseName + stepOrder) and return strictly valid JSON.**
17. After the JSON, on a new line starting with "SUMMARY:", write a concise human-readable bullet list of what you changed and why (this part WILL be shown to the user).

BUSINESS RULES (TRAINING ADJUSTMENTS):
1. The primary driver of adjustments must be the TrainingPlan (goals, periodization phase, benchmarks, and constraints). Use previous-week activity performance only as a secondary signal.
2. At the start of a new TrainingPlan or at the beginning of a phase (early weeks), place minimal weight on previous activities and follow the planned progression baseline.
3. If an activity shows strong performance (RPE ≤ 40, Feel ≥ 60, good body battery, training effect ≥ 4), progress the next workout modestly (+2.5–5% weight or +1–2 reps or –5 sec/km pace).
4. If performance was poor (RPE ≥ 70, Feel ≤ 30, low body battery < 20, missed sets), reduce load 5–10% or keep flat.
5. Respect the current periodization phase (hypertrophy = higher reps/volume, strength = lower reps/higher %).
6. **STRICT CONSTRAINT: Never duplicate steps. Each exercise-stepOrder pair must be unique within a workout. Only modify existing step fields (weight, percentage, reps, rest time). Do not add new steps; return the input step count exactly as provided.**

WeeklyWorkoutPlan schema:
{
  "generatedAt": "ISO timestamp",
  "weekStart": "YYYY-MM-DD",
  "weekEnd": "YYYY-MM-DD",
  "source": "llm-adjusted",
  "workouts": [
    {
      "workoutId": number | string,
      "workoutName": "string",
      "workoutType": "strength_training" | "running" | "cycling" | "swimming",
      "scheduledDate": "YYYY-MM-DD",
      "steps": [WorkoutStep]
    }
  ]
}`;
  }

  /** Create a LLM session */
  async createSession(): Promise<void> {
    if (this.mockMode) {
      console.log("   Mock mode: skipping LLM session initialization.");
      return;
    }

    await this.createCopilotSdkSession();
  }

  private async createCopilotSdkSession(): Promise<void> {
    const { CopilotClient } = await import("@github/copilot-sdk");

    // Auth: prefer GitHub token env vars, then BYOK (OpenAI / Anthropic)
    const githubToken =
      process.env.COPILOT_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN;

    const openAiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    if (!githubToken && !openAiKey && !anthropicKey) {
      throw new Error(
        "No LLM credentials found. Add one of the following to your .env file:\n" +
        "  GITHUB_TOKEN=ghp_...           (GitHub personal access token with Copilot access)\n" +
        "  OPENAI_API_KEY=sk-...          (BYOK — OpenAI)\n" +
        "  ANTHROPIC_API_KEY=sk-ant-...   (BYOK — Anthropic)\n" +
        "\nTo get a GitHub token: https://github.com/settings/tokens → Generate new token → No scopes needed for Copilot Business/Enterprise."
      );
    }

    const clientOptions: Record<string, unknown> = {};
    if (githubToken) {
      clientOptions.githubToken = githubToken;
      console.log(`   Auth: GitHub token (${githubToken.slice(0, 8)}...)`);
    }

    this.client = new CopilotClient(clientOptions);
    await this.client.start();

    const sessionConfig: Record<string, unknown> = {
      systemMessage: { mode: "append", content: this.buildSystemPrompt() },
    };

    // BYOK — override model inference with a direct provider
    if (!githubToken && openAiKey) {
      console.log("   Auth: BYOK — OpenAI");
      sessionConfig.model = this.modelName.startsWith("claude") ? "gpt-4o" : this.modelName;
      sessionConfig.provider = {
        type: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: openAiKey,
      };
    } else if (!githubToken && anthropicKey) {
      console.log("   Auth: BYOK — Anthropic");
      sessionConfig.model = this.modelName.startsWith("gpt") ? "claude-sonnet-4-5" : this.modelName;
      sessionConfig.provider = {
        type: "anthropic",
        apiKey: anthropicKey,
      };
    } else {
      sessionConfig.model = this.modelName;
    }

    this.session = await this.client.createSession(sessionConfig as any);
  }

  /**
   * Send a prompt to the LLM and collect the full response.
   * Streams tokens to stdout in real-time. Prints a heartbeat line while waiting
   * for the first token so the user knows the process is alive.
   */
  private async sendPrompt(prompt: string, callLabel = "llm"): Promise<string> {
    if (this.mockMode) {
      return this.getMockResponse();
    }

    return this.sendPromptCopilotSdk(prompt, callLabel);
  }

  private async sendPromptCopilotSdk(prompt: string, callLabel: string): Promise<string> {
    if (!this.session) {
      throw new Error("LLM session not initialized. Call createSession() first.");
    }

    let fullContent = "";
    let firstTokenReceived = false;
    let firstTokenTime: number | null = null;
    const startTime = Date.now();

    // Heartbeat: print elapsed time every 4s until first token arrives
    const heartbeat = setInterval(() => {
      if (!firstTokenReceived) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        process.stdout.write(`\r⏳ Waiting for LLM response... ${elapsed}s`);
      }
    }, 4000);

    return new Promise<string>((resolve, reject) => {
      const unsubDelta = this.session!.on("assistant.message_delta", (event: any) => {
        const delta = event.data?.deltaContent ?? "";
        if (delta) {
          if (!firstTokenReceived) {
            firstTokenReceived = true;
            firstTokenTime = Date.now();
            clearInterval(heartbeat);
            process.stdout.write("\r"); // clear the heartbeat line
          }
          process.stdout.write(delta);
          fullContent += delta;
        }
      });

      const unsubMsg = this.session!.on(
        "assistant.message",
        (event: any) => {
          clearInterval(heartbeat);
          unsubDelta();
          unsubMsg();
          const finalContent = event.data.content ?? fullContent;
          if (finalContent && !firstTokenReceived) {
            // Model returned content without deltas (non-streaming)
            process.stdout.write(finalContent);
          }
          process.stdout.write("\n");

          const endTime = Date.now();
          const totalSec = ((endTime - startTime) / 1000).toFixed(1);
          const ttftPart = firstTokenTime != null
            ? `TTFT: ${((firstTokenTime - startTime) / 1000).toFixed(1)}s`
            : "TTFT: n/a";
          process.stdout.write(
            `⏱  [${callLabel}] prompt: ${prompt.length.toLocaleString()} chars | ${ttftPart} | total: ${totalSec}s\n`
          );

          resolve(finalContent);
        }
      );

      const unsubErr = this.session!.on("error" as any, (event: any) => {
        clearInterval(heartbeat);
        unsubErr();
        reject(new Error(`LLM error: ${JSON.stringify(event)}`));
      });

      this.session!.send({ prompt }).catch((e: unknown) => {
        clearInterval(heartbeat);
        reject(e);
      });
    });
  }

  /**
   * Parse the LLM response into JSON + summary text.
   * Handles models that emit both a JSON block and a SUMMARY: section.
   * Auto-retries up to 2× sending validation errors back to the LLM.
   */
  private async parseAndValidateResponse(
    rawResponse: string,
    retryCount = 0
  ): Promise<{ plan: WeeklyWorkoutPlan; summary: string }> {
    // Split JSON portion from SUMMARY: section
    const summaryMatch = rawResponse.match(/\nSUMMARY:([\s\S]*)$/m);
    const summary = summaryMatch ? summaryMatch[1].trim() : "";
    const jsonPortion = summaryMatch
      ? rawResponse.slice(0, summaryMatch.index)
      : rawResponse;

    let parsed: unknown;
    try {
      parsed = extractJson(jsonPortion);
    } catch (e) {
      if (retryCount < 2) {
        console.error(`\n⚠️  LLM returned unparseable JSON. Asking for correction (attempt ${retryCount + 1}/2)...`);
        const fixPrompt = `Your previous response could not be parsed as JSON. Error: ${(e as Error).message}\nPlease return ONLY the WeeklyWorkoutPlan JSON with no additional text, followed by SUMMARY: on a new line.`;
        const retry = await this.sendPrompt(fixPrompt, "retry");
        return this.parseAndValidateResponse(retry, retryCount + 1);
      }
      throw new Error(`Failed to parse LLM response as JSON after 2 retries: ${(e as Error).message}`);
    }

    const plan = parsed as WeeklyWorkoutPlan;

    // Basic structural validation
    if (!plan.workouts || !Array.isArray(plan.workouts)) {
      if (retryCount < 2) {
        console.error(`\n⚠️  LLM response missing 'workouts' array. Asking for correction...`);
        const fixPrompt = `Your previous response was missing the 'workouts' array. Please return valid WeeklyWorkoutPlan JSON with a 'workouts' array, followed by SUMMARY: on a new line.`;
        const retry = await this.sendPrompt(fixPrompt, "retry");
        return this.parseAndValidateResponse(retry, retryCount + 1);
      }
      throw new Error("LLM response does not contain a valid WeeklyWorkoutPlan structure after retries.");
    }

    // Check for duplicate steps (same exerciseName + stepOrder)
    if (this.planHasDuplicates(plan)) {
      if (retryCount < 2) {
        console.error(`\n⚠️  LLM response contains duplicate steps (same exerciseName + stepOrder). Asking for correction...`);
        const duplicateDetails = plan.workouts
          .map((w) => {
            const dups = this.detectDuplicateSteps(w);
            if (dups.length === 0) return null;
            return `Workout "${w.workoutName}": ${dups.map((d) => `${d.exerciseName}@stepOrder ${d.stepOrder} (${d.count}× found)`).join(", ")}`;
          })
          .filter(Boolean)
          .join("; ");
        const fixPrompt = `Your JSON has duplicate steps: ${duplicateDetails}. Each (exerciseName, stepOrder) pair must be unique within a workout. Remove the duplicate entries while preserving the other steps. Return the corrected JSON.`;
        const retry = await this.sendPrompt(fixPrompt, "retry");
        return this.parseAndValidateResponse(retry, retryCount + 1);
      }
      throw new Error(
        "LLM response contains duplicate steps after 2 retries. Unable to proceed."
      );
    }

    return { plan, summary };
  }

  /**
   * Detect duplicate steps within a workout.
   * A duplicate is defined as steps with the same exerciseName and stepOrder.
   * Returns an array of duplicate step signatures for error reporting.
   */
  private detectDuplicateSteps(
    workout: PlannedWorkout
  ): Array<{ exerciseName: string; stepOrder: number; count: number }> {
    if (!workout.steps) return [];

    const stepMap = new Map<string, number>(); // key: "exerciseName:stepOrder"
    const duplicates: Array<{ exerciseName: string; stepOrder: number; count: number }> = [];

    for (const step of workout.steps) {
      // Skip steps without stepOrder (shouldn't happen, but be safe)
      if (step.stepOrder === undefined) continue;

      const exerciseName = step.exerciseName || "(no exercise)";
      const key = `${exerciseName}:${step.stepOrder}`;

      const count = (stepMap.get(key) ?? 0) + 1;
      stepMap.set(key, count);

      if (count > 1 && !duplicates.some((d) => d.exerciseName === exerciseName && d.stepOrder === step.stepOrder)) {
        duplicates.push({ exerciseName, stepOrder: step.stepOrder, count });
      }
    }

    return duplicates;
  }

  /**
   * Check plan for duplicate steps across all workouts.
   * Returns true if any duplicates found.
   */
  private planHasDuplicates(plan: WeeklyWorkoutPlan): boolean {
    if (!plan.workouts) return false;

    for (const workout of plan.workouts) {
      const duplicates = this.detectDuplicateSteps(workout);
      if (duplicates.length > 0) {
        return true;
      }
    }

    return false;
  }

  // ── Payload helpers ────────────────────────────────────────────────────────

  private buildWeeklySelectionTargets(trainingPlan: TrainingPlan): WeeklySelectionTarget[] {
    const weeklyStructure = trainingPlan.weeklyStructure;

    if (!weeklyStructure || typeof weeklyStructure !== "object") {
      return [];
    }

    const targets: WeeklySelectionTarget[] = [];

    for (const [day, value] of Object.entries(weeklyStructure)) {
      if (typeof value === "string") {
        if (/\b(off|rest|mobility|recovery)\b/i.test(value)) {
          continue;
        }

        const typeHint = inferWorkoutTypeFromText(value);
        const normalizedNameHint = normalizeSelectorText(value);
        const tokens = tokenizeSelectorText(value);

        if (!typeHint && !normalizedNameHint) {
          continue;
        }

        targets.push({
          day,
          workoutNameHint: value,
          normalizedNameHint: normalizedNameHint || undefined,
          workoutTypeHint: typeHint,
          tokens,
        });
        continue;
      }

      if (!value || typeof value !== "object") {
        continue;
      }

      const entry = value as Record<string, unknown>;
      const workoutName =
        typeof entry.workoutName === "string" ? entry.workoutName : undefined;
      const description =
        typeof entry.description === "string" ? entry.description : undefined;
      const explicitWorkoutType =
        typeof entry.workoutType === "string"
          ? (entry.workoutType as PlannedWorkout["workoutType"])
          : undefined;

      const selectorText = workoutName ?? description;
      const normalizedNameHint = normalizeSelectorText(selectorText);
      const typeHint =
        explicitWorkoutType ??
        inferWorkoutTypeFromText(`${workoutName ?? ""} ${description ?? ""}`.trim());

      if (!workoutName && !description && !typeHint) {
        continue;
      }

      targets.push({
        day,
        workoutNameHint: selectorText,
        normalizedNameHint: normalizedNameHint || undefined,
        workoutTypeHint: typeHint,
        tokens: tokenizeSelectorText(selectorText),
      });
    }

    return targets;
  }

  private scoreWorkoutAgainstTarget(
    workout: PlannedWorkout,
    target: WeeklySelectionTarget
  ): number {
    let score = 0;

    const workoutNameNormalized = normalizeSelectorText(workout.workoutName);
    const workoutTokens = tokenizeSelectorText(workout.workoutName);

    if (target.workoutTypeHint && workout.workoutType === target.workoutTypeHint) {
      score += 25;
    }

    if (target.normalizedNameHint) {
      if (workoutNameNormalized === target.normalizedNameHint) {
        score += 70;
      } else if (
        workoutNameNormalized.includes(target.normalizedNameHint) ||
        target.normalizedNameHint.includes(workoutNameNormalized)
      ) {
        score += 40;
      }

      if (target.tokens.length > 0 && workoutTokens.length > 0) {
        const workoutTokenSet = new Set(workoutTokens);
        let overlap = 0;
        for (const token of target.tokens) {
          if (workoutTokenSet.has(token)) {
            overlap += 1;
          }
        }
        score += Math.min(20, overlap * 6);
      }
    }

    if (workout.steps && workout.steps.length > 0) {
      score += 2;
    }

    return score;
  }

  private selectWorkoutsFromUnscheduledLibrary(
    plan: WeeklyWorkoutPlan,
    trainingPlan: TrainingPlan,
    limit = 7
  ): PlannedWorkout[] {
    const targets = this.buildWeeklySelectionTargets(trainingPlan);

    if (targets.length === 0) {
      throw new Error(
        "Workout plan contains unscheduled workouts, but training plan weeklyStructure is missing or unusable for auto-selection. " +
        "Provide a curated weekly workout file (for example data/next-week.workouts.tmp.json), schedule dates, or add workoutName/workoutType hints under weeklyStructure."
      );
    }

    const desiredCount = Math.min(plan.workouts.length, Math.max(1, targets.length));
    const selectedIndices = new Set<number>();
    const selectedWorkouts: PlannedWorkout[] = [];

    let namedTargets = 0;
    let namedMatches = 0;

    for (const target of targets) {
      const hasNameHint = !!target.normalizedNameHint;
      if (hasNameHint) {
        namedTargets += 1;
      }

      let bestIndex = -1;
      let bestScore = -1;

      for (let index = 0; index < plan.workouts.length; index++) {
        if (selectedIndices.has(index)) continue;
        const workout = plan.workouts[index];
        const score = this.scoreWorkoutAgainstTarget(workout, target);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }

      const minScore = hasNameHint ? 35 : target.workoutTypeHint ? 20 : 45;
      if (bestIndex !== -1 && bestScore >= minScore) {
        selectedIndices.add(bestIndex);
        selectedWorkouts.push(plan.workouts[bestIndex]);
        if (hasNameHint) {
          namedMatches += 1;
        }
      }

      if (selectedWorkouts.length >= desiredCount) {
        break;
      }
    }

    if (selectedWorkouts.length < desiredCount) {
      const fallbackCandidates = plan.workouts
        .map((workout, index) => {
          if (selectedIndices.has(index)) {
            return null;
          }
          const bestScore = targets.reduce((maxScore, target) => {
            return Math.max(maxScore, this.scoreWorkoutAgainstTarget(workout, target));
          }, 0);

          return { index, bestScore };
        })
        .filter((candidate): candidate is { index: number; bestScore: number } => !!candidate)
        .sort((a, b) => {
          if (b.bestScore !== a.bestScore) {
            return b.bestScore - a.bestScore;
          }
          return a.index - b.index;
        });

      for (const candidate of fallbackCandidates) {
        if (selectedWorkouts.length >= desiredCount) {
          break;
        }

        if (candidate.bestScore < 15) {
          continue;
        }

        selectedIndices.add(candidate.index);
        selectedWorkouts.push(plan.workouts[candidate.index]);
      }
    }

    const minNamedMatches =
      namedTargets > 0 ? Math.max(1, Math.ceil(namedTargets * 0.5)) : 0;
    const minTotalMatches = Math.max(1, Math.ceil(desiredCount * 0.6));

    if (
      selectedWorkouts.length < minTotalMatches ||
      (namedTargets > 0 && namedMatches < minNamedMatches)
    ) {
      throw new Error(
        `Unable to confidently auto-select a weekly subset from ${plan.workouts.length} unscheduled workouts ` +
        `(selected ${selectedWorkouts.length}/${desiredCount}, named matches ${namedMatches}/${namedTargets}). ` +
        "Pass a curated weekly workout file (for example data/next-week.workouts.tmp.json) or schedule dates in the workout file before running adjust-workouts."
      );
    }

    if (selectedWorkouts.length > limit) {
      console.warn(
        `\n⚠️  Auto-selection inferred ${selectedWorkouts.length} workouts from weeklyStructure (limit hint: ${limit}).` +
        "\n   Sending all inferred workouts to preserve weekly intent.\n"
      );
    }

    console.log(
      `   Auto-selected ${selectedWorkouts.length} workout(s) from ${plan.workouts.length} unscheduled entries using training-plan weeklyStructure.`
    );

    return selectedWorkouts;
  }

  /**
   * Trim the workout plan down to what the LLM actually needs:
   * - Prefer workouts with a scheduledDate within the plan's week range.
   * - If none have scheduledDate, attempt deterministic selection from trainingPlan.weeklyStructure.
   * - Fail fast on low-confidence matching instead of arbitrary first-N truncation.
   */
  private trimPlanForLLM(
    plan: WeeklyWorkoutPlan,
    options: {
      limit?: number;
      trainingPlan?: TrainingPlan;
    } = {}
  ): WeeklyWorkoutPlan {
    const limit = options.limit ?? 7;
    const scheduled = plan.workouts.filter((w) => !!w.scheduledDate);

    if (scheduled.length > 0) {
      // Filter to workouts within the plan's week range
      const inRange = plan.weekStart
        ? scheduled.filter((w) => {
            const dates = Array.isArray(w.scheduledDate)
              ? w.scheduledDate
              : [w.scheduledDate!];
            return dates.some((d) => d >= plan.weekStart && d <= plan.weekEnd);
          })
        : scheduled;
      const workouts = inRange.length > 0 ? inRange : scheduled.slice(0, limit);
      return { ...plan, workouts };
    }

    if (!options.trainingPlan) {
      if (plan.workouts.length > limit) {
        console.warn(
          `\n⚠️  Workout context has ${plan.workouts.length} unscheduled workouts and no training-plan selector context.` +
          `\n   Sending only the first ${limit} workouts in this optional context.\n`
        );
      }
      return { ...plan, workouts: plan.workouts.slice(0, limit) };
    }

    if (plan.workouts.length <= limit) {
      return plan;
    }

    const workouts = this.selectWorkoutsFromUnscheduledLibrary(
      plan,
      options.trainingPlan,
      limit
    );

    return { ...plan, workouts };
  }

  /**
   * Extract unique workout IDs from activities that have workoutId field.
   * Returns a Set of workout IDs that were actually performed.
   */
  private extractWorkoutIds(activities: ExtractedActivities): Set<string | number> {
    const workoutIds = new Set<string | number>();
    activities.activities.forEach(a => {
      if (a.workoutId != null) {
        workoutIds.add(a.workoutId);
      }
    });
    return workoutIds;
  }

  /**
   * Filter workouts to only those that have a matching performed activity.
   * Uses strict workoutId matching between activities and workout templates.
   */
  private filterWorkoutsByIds(
    plan: WeeklyWorkoutPlan,
    performedIds: Set<string | number>
  ): WeeklyWorkoutPlan {
    const filteredWorkouts = plan.workouts.filter(w => {
      if (w.workoutId == null) return false;
      return performedIds.has(w.workoutId);
    });
    return {
      ...plan,
      workouts: filteredWorkouts,
    };
  }

  /**
   * Compact activities for the prompt: keep key metrics, truncate exerciseSets
   * to the most important entries to reduce token count.
   */
  private compactActivities(activities: ExtractedActivities): object[] {
    return activities.activities.map((a) => ({
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
      // Keep only main lifts (top sets) for strength; first 5 intervals for running
      exerciseSets: (a.exerciseSets ?? []).slice(0, 8),
    }));
  }

  private validateTrainingPlanShape(plan: TrainingPlan): void {
    if (!plan || typeof plan !== "object") {
      throw new Error("Training plan must be a JSON object");
    }

    if (!plan.version || !plan.athlete || !plan.goals || !plan.periodization) {
      throw new Error(
        "Training plan missing required fields: version, athlete, goals, or periodization"
      );
    }

    if (!plan.periodization.currentPhase || !Array.isArray(plan.periodization.phases)) {
      throw new Error(
        "Training plan periodization is invalid (missing currentPhase or phases)"
      );
    }

    if (!Array.isArray(plan.weeklyHistory)) {
      throw new Error("Training plan weeklyHistory must be an array");
    }
  }

  private isEarlyPhase(trainingPlan: TrainingPlan): boolean {
    const weekInPhase = trainingPlan.periodization?.weekInPhase;
    return typeof weekInPhase === "number" && weekInPhase <= 2;
  }

  private extractTrainingPlanMainLiftBaselines(
    trainingPlan: TrainingPlan
  ): Map<string, { exerciseName: string; minSets: number }> {
    const baselines = new Map<string, { exerciseName: string; minSets: number }>();
    const weeklyStructure = trainingPlan.weeklyStructure;

    if (!weeklyStructure || typeof weeklyStructure !== "object") {
      return baselines;
    }

    for (const entry of Object.values(weeklyStructure)) {
      if (!entry || typeof entry !== "object") continue;

      const typedEntry = entry as Record<string, unknown>;
      const workoutName = typedEntry.workoutName;
      const exercises = typedEntry.exercises;

      if (typeof workoutName !== "string" || !Array.isArray(exercises)) {
        continue;
      }

      for (const exerciseEntry of exercises) {
        if (!exerciseEntry || typeof exerciseEntry !== "object") continue;

        const typedExercise = exerciseEntry as Record<string, unknown>;
        const exerciseName = typedExercise.exercise;
        const sets = typedExercise.sets;

        if (typeof exerciseName !== "string" || !Array.isArray(sets)) {
          continue;
        }

        const workSet = sets.find((setEntry) => {
          if (!setEntry || typeof setEntry !== "object") return false;
          const typedSet = setEntry as Record<string, unknown>;
          return (
            typeof typedSet.phase === "string" &&
            typedSet.phase.toLowerCase() === "work" &&
            typeof typedSet.sets === "number" &&
            typedSet.sets > 0
          );
        }) as Record<string, unknown> | undefined;

        if (workSet && typeof workSet.sets === "number") {
          baselines.set(workoutName, {
            exerciseName: normalizeExerciseName(exerciseName),
            minSets: workSet.sets,
          });
          break;
        }
      }
    }

    return baselines;
  }

  private countExerciseSets(
    steps: WorkoutStep[],
    normalizedExerciseName: string,
    repeatMultiplier = 1
  ): number {
    let count = 0;

    for (const step of steps) {
      if (step.stepType === "repeat" && step.repeatSteps) {
        const repeats = step.numberOfRepeats ?? 1;
        count += this.countExerciseSets(
          step.repeatSteps,
          normalizedExerciseName,
          repeatMultiplier * repeats
        );
        continue;
      }

      if (normalizeExerciseName(step.exerciseName) === normalizedExerciseName) {
        count += repeatMultiplier;
      }
    }

    return count;
  }

  private findFirstExerciseStep(
    steps: WorkoutStep[],
    normalizedExerciseName: string
  ): WorkoutStep | undefined {
    for (const step of steps) {
      if (step.stepType === "repeat" && step.repeatSteps) {
        const nested = this.findFirstExerciseStep(
          step.repeatSteps,
          normalizedExerciseName
        );
        if (nested) return nested;
        continue;
      }

      if (normalizeExerciseName(step.exerciseName) === normalizedExerciseName) {
        return step;
      }
    }

    return undefined;
  }

  private cloneStep(step: WorkoutStep): WorkoutStep {
    return JSON.parse(JSON.stringify(step)) as WorkoutStep;
  }

  /**
   * Get the maximum stepOrder in a list of steps (recursive, including repeat groups).
   */
  private getMaxStepOrder(steps: WorkoutStep[]): number {
    let max = 0;
    for (const step of steps) {
      if (step.stepOrder !== undefined && step.stepOrder > max) {
        max = step.stepOrder;
      }
      if (step.stepType === "repeat" && step.repeatSteps) {
        max = Math.max(max, this.getMaxStepOrder(step.repeatSteps));
      }
    }
    return max;
  }

  private ensureWorkoutExerciseSetMinimum(
    workout: PlannedWorkout,
    normalizedExerciseName: string,
    minSets: number
  ): PlannedWorkout {
    if (!workout.steps || minSets <= 0 || !normalizedExerciseName) {
      return workout;
    }

    const currentSets = this.countExerciseSets(workout.steps, normalizedExerciseName);
    if (currentSets >= minSets) {
      return workout;
    }

    const templateStep = this.findFirstExerciseStep(workout.steps, normalizedExerciseName);
    if (!templateStep) {
      return workout;
    }

    // Clone steps to meet minimum set requirements.
    // Assign new, unique stepOrder values to avoid (exerciseName, stepOrder) duplicates.
    const updatedSteps = [...workout.steps];
    const maxStepOrder = this.getMaxStepOrder(updatedSteps);
    let nextStepOrder = maxStepOrder + 1;

    for (let i = currentSets; i < minSets; i++) {
      const clonedStep = this.cloneStep(templateStep);
      clonedStep.stepOrder = nextStepOrder;
      nextStepOrder++;
      updatedSteps.push(clonedStep);
    }

    return {
      ...workout,
      steps: updatedSteps,
    };
  }

  private applyMainLiftBaselinesFromTrainingPlan(
    trainingPlan: TrainingPlan,
    plan: WeeklyWorkoutPlan
  ): WeeklyWorkoutPlan {
    if (!this.isEarlyPhase(trainingPlan)) {
      return plan;
    }

    const baselinesByWorkoutName = this.extractTrainingPlanMainLiftBaselines(trainingPlan);
    if (baselinesByWorkoutName.size === 0) {
      return plan;
    }

    return {
      ...plan,
      workouts: plan.workouts.map((workout) => {
        const baseline = baselinesByWorkoutName.get(workout.workoutName);
        if (!baseline) return workout;
        return this.ensureWorkoutExerciseSetMinimum(
          workout,
          baseline.exerciseName,
          baseline.minSets
        );
      }),
    };
  }

  private guessPrimaryExerciseName(workout: PlannedWorkout): string | undefined {
    const steps = flattenForDiff(workout.steps ?? []);
    const firstExercise = steps.find((step) => !!step.exerciseName)?.exerciseName;
    if (!firstExercise) return undefined;
    return normalizeExerciseName(firstExercise);
  }

  private applyPrimarySetFloorsFromBasePlan(
    basePlan: WeeklyWorkoutPlan,
    adjustedPlan: WeeklyWorkoutPlan
  ): WeeklyWorkoutPlan {
    const updatedWorkouts = adjustedPlan.workouts.map((adjustedWorkout) => {
      const baseIndex = findMatchingWorkoutIndex(basePlan.workouts, adjustedWorkout);
      if (baseIndex === -1) return adjustedWorkout;

      const baseWorkout = basePlan.workouts[baseIndex];
      const primaryExercise = this.guessPrimaryExerciseName(baseWorkout);
      if (!primaryExercise) return adjustedWorkout;

      const baseSets = this.countExerciseSets(
        baseWorkout.steps ?? [],
        primaryExercise
      );
      if (baseSets <= 0) return adjustedWorkout;

      return this.ensureWorkoutExerciseSetMinimum(
        adjustedWorkout,
        primaryExercise,
        baseSets
      );
    });

    return {
      ...adjustedPlan,
      workouts: updatedWorkouts,
    };
  }

  /**
   * Audit plan for duplicate steps after post-processing.
   * Logs warnings if duplicates are found (they may have been introduced by step-cloning in post-processing).
   */
  private auditForDuplicatesWarning(plan: WeeklyWorkoutPlan): void {
    if (!plan.workouts) return;

    const allDuplicates: Array<{
      workoutName: string;
      exerciseName: string;
      stepOrder: number;
      count: number;
    }> = [];

    for (const workout of plan.workouts) {
      const duplicates = this.detectDuplicateSteps(workout);
      for (const dup of duplicates) {
        allDuplicates.push({
          workoutName: workout.workoutName,
          exerciseName: dup.exerciseName,
          stepOrder: dup.stepOrder,
          count: dup.count,
        });
      }
    }

    if (allDuplicates.length > 0) {
      console.warn(
        "\n⚠️  POST-PROCESSING AUDIT: Found duplicate steps in final plan (likely from step-cloning to meet minimum set requirements):"
      );
      for (const dup of allDuplicates) {
        console.warn(
          `    - Workout "${dup.workoutName}": ${dup.exerciseName} @ stepOrder ${dup.stepOrder} appears ${dup.count} times`
        );
      }
    }
  }

  // ── Main flows ─────────────────────────────────────────────────────────────

  /**
   * First call: analyze the context and produce an initial adjusted plan.
   */
  async analyzeAndAdjust(context: AdjustmentContext): Promise<AdjustmentResult> {
    const { activities, currentPlan, trainingPlan } = context;

    // Only apply workout filtering if workouts have scheduledDate (not a library plan)
    // This allows auto-selection logic to work for unscheduled library plans
    const hasScheduledDates = currentPlan.workouts.some(w => w.scheduledDate != null);
    let planToUse = currentPlan;

    if (hasScheduledDates) {
      // Extract performed workout IDs (from activities that have one) and filter workouts
      const performedIds = this.extractWorkoutIds(activities);
      planToUse = this.filterWorkoutsByIds(currentPlan, performedIds);
      console.log(
        `   Filtered workouts: ${currentPlan.workouts.length} → ${planToUse.workouts.length} (matching performed activities)`
      );
      if (performedIds.size > 0) {
        console.log(
          `   Matched workout IDs: ${Array.from(performedIds).join(", ")}`
        );
      }
    } else {
      console.log(
        `   Skipping workout filtering (unscheduled library → using auto-selection)`
      );
    }

    const trimmedPlan = this.trimPlanForLLM(planToUse, {
      trainingPlan,
      limit: 7,
    });
    const compactActs = this.compactActivities(activities);

    console.log(`   Sending ${trimmedPlan.workouts.length} workout(s) and ${compactActs.length} activit(ies) to LLM.`);

    // Build compact but information-rich prompt
    const prompt = `
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

    console.log("\n🤖 Sending context to LLM for analysis...");
    console.log("─".repeat(60));
    const rawResponse = await this.sendPrompt(prompt, "analyzeAndAdjust");
    console.log("─".repeat(60));

    this.saveLastResponse(rawResponse);
    const { plan, summary } = await this.parseAndValidateResponse(rawResponse);
    const withTrainingBaselines = this.applyMainLiftBaselinesFromTrainingPlan(
      trainingPlan,
      plan
    );
    const guardedPlan = this.applyPrimarySetFloorsFromBasePlan(
      trimmedPlan,
      withTrainingBaselines
    );

    if (summary) {
      console.log("\n📝 LLM Summary:");
      console.log("─".repeat(60));
      console.log(summary);
      console.log("─".repeat(60));
    }

    // Audit for duplicates that may have been introduced by post-processing
    this.auditForDuplicatesWarning(guardedPlan);

    return {
      adjustedPlan: guardedPlan,
      changeSummary: summary || formatChangeSummary(trimmedPlan, guardedPlan),
      llmReasoning: rawResponse,
    };
  }

  /** Save the raw LLM response to disk for inspection. */
  private saveLastResponse(content: string): void {
    try {
      const outPath = path.join(__dirname, "../data/llm-response-last.txt");
      fs.writeFileSync(outPath, content, "utf-8");
    } catch {
      // Non-fatal
    }
  }

  /**
   * Subsequent call: apply user feedback and re-adjust the plan.
   */
  async iterate(
    feedback: string,
    currentPlan: WeeklyWorkoutPlan
  ): Promise<AdjustmentResult> {
    const prompt = `
## User feedback on the adjusted plan

${feedback}

## Current adjusted plan (for reference)

${JSON.stringify(currentPlan, null, 2)}

Please apply the feedback and return the updated WeeklyWorkoutPlan JSON, then SUMMARY:.
`.trim();

    console.log("\n🤖 Applying feedback...");
    console.log("─".repeat(60));
    const rawResponse = await this.sendPrompt(prompt, "iterate");
    console.log("─".repeat(60));

    this.saveLastResponse(rawResponse);
    const { plan, summary } = await this.parseAndValidateResponse(rawResponse);
    const guardedPlan = this.applyPrimarySetFloorsFromBasePlan(currentPlan, plan);

    if (summary) {
      console.log("\n📝 LLM Summary:");
      console.log("─".repeat(60));
      console.log(summary);
      console.log("─".repeat(60));
    }

    return {
      adjustedPlan: guardedPlan,
      changeSummary: summary || formatChangeSummary(currentPlan, guardedPlan),
      llmReasoning: rawResponse,
    };
  }

  /**
   * Revisit and refine a TrainingPlan using LLM guidance.
   * Returns an updated TrainingPlan plus a short summary of changes.
   */
  async revisitTrainingPlan(
    trainingPlan: TrainingPlan,
    options: {
      activities?: ExtractedActivities;
      currentPlan?: WeeklyWorkoutPlan;
      reviewNotes?: string;
    } = {}
  ): Promise<{ updatedPlan: TrainingPlan; summary: string; llmReasoning: string }> {
    const compactActivities = options.activities
      ? this.compactActivities(options.activities)
      : undefined;
    const trimmedWorkoutPlan = options.currentPlan
      ? this.trimPlanForLLM(options.currentPlan, { limit: 7 })
      : undefined;

    const prompt = `
You are reviewing and improving a strength + endurance TrainingPlan JSON.

GOAL:
- Revisit this training plan and produce a refined version that is internally consistent,
  realistic, and aligned with current progression.

RULES:
1. Return ONLY valid TrainingPlan JSON (same top-level schema), then on a new line: SUMMARY:
2. Preserve athlete identity and long-term intent unless notes explicitly ask to change.
3. Keep fields machine-readable; no markdown fences.
4. Ensure periodization fields are coherent: currentPhase, weekInPhase, totalWeeksInPhase, phases[].
5. Keep weeklyHistory as an array.
6. Update updatedAt timestamp.

${options.reviewNotes?.trim() ? `USER NOTES:\n${options.reviewNotes.trim()}\n` : ""}

CURRENT TRAINING PLAN:
${JSON.stringify(trainingPlan, null, 2)}

${trimmedWorkoutPlan ? `CURRENT WORKOUT PLAN CONTEXT:\n${JSON.stringify(trimmedWorkoutPlan, null, 2)}\n` : ""}

${compactActivities ? `RECENT ACTIVITIES CONTEXT:\n${JSON.stringify(compactActivities, null, 2)}\n` : ""}

Return the updated TrainingPlan JSON, then SUMMARY:.
`.trim();

    console.log("\n🤖 Revisiting training plan with LLM...");
    console.log("─".repeat(60));
    let rawResponse = await this.sendPrompt(prompt, "revisitTrainingPlan");
    console.log("─".repeat(60));

    this.saveLastResponse(rawResponse);

    for (let attempt = 0; attempt < 3; attempt++) {
      const summaryMatch = rawResponse.match(/\nSUMMARY:([\s\S]*)$/m);
      const summary = summaryMatch ? summaryMatch[1].trim() : "";
      const jsonPortion = summaryMatch
        ? rawResponse.slice(0, summaryMatch.index)
        : rawResponse;

      try {
        const parsed = extractJson(jsonPortion) as TrainingPlan;
        this.validateTrainingPlanShape(parsed);

        return {
          updatedPlan: parsed,
          summary,
          llmReasoning: rawResponse,
        };
      } catch (error: any) {
        if (attempt === 2) {
          throw new Error(
            `Failed to parse/validate TrainingPlan after retries: ${error.message}`
          );
        }

        console.error(
          `\n⚠️  Invalid TrainingPlan response. Asking LLM for a corrected JSON-only response (attempt ${attempt + 1}/2)...`
        );
        rawResponse = await this.sendPrompt(
          `Your previous response was invalid: ${error.message}. Return ONLY valid TrainingPlan JSON matching the original schema, then SUMMARY: on a new line.`,
          "retry"
        );
        this.saveLastResponse(rawResponse);
      }
    }

    throw new Error("Unexpected failure while revisiting training plan");
  }

  /**
   * Ask the LLM to generate a 2-4 sentence weekly summary and append it to the
   * training plan's weeklyHistory.
   */
  async appendWeekSummary(
    context: AdjustmentContext,
    trainingPlanPath: string
  ): Promise<void> {
    const { activities, currentPlan, trainingPlan } = context;

    const prompt = `
Summarize last week's training in 2-4 sentences, covering:
- Overall adherence (which workouts were completed vs skipped)
- Key performance highlights (notable lifts, running paces)
- Any issues or fatigue signs (high RPE, low body battery)
- Whether progression was applied for next week

Return ONLY a JSON object with these fields:
{
  "weekStart": "${activities.weekStart}",
  "weekEnd": "${activities.weekEnd}",
  "summary": "...",
  "adherence": "full" | "partial" | "missed",
  "adjustmentsMade": "..."
}
`.trim();

    console.log("\n📝 Generating weekly summary...");
    const rawResponse = await this.sendPrompt(prompt, "appendWeekSummary");

    let summaryEntry: WeekSummary;
    try {
      summaryEntry = extractJson(rawResponse) as WeekSummary;
    } catch {
      // If parsing fails, create a minimal entry
      summaryEntry = {
        weekStart: activities.weekStart,
        weekEnd: activities.weekEnd,
        summary: rawResponse.slice(0, 500),
        adherence: "partial",
      };
    }

    // Append to training plan
    trainingPlan.weeklyHistory.push(summaryEntry);
    trainingPlan.updatedAt = new Date().toISOString();

    fs.writeFileSync(trainingPlanPath, JSON.stringify(trainingPlan, null, 2), "utf-8");
    console.log(`✅ Weekly summary appended to ${path.basename(trainingPlanPath)}`);
  }

  /**
   * Re-adjust a single workout based on user feedback.
   * Sends only the workout + feedback to the LLM and returns the updated workout.
   */
  async iterateSingleWorkout(
    feedback: string,
    workout: PlannedWorkout
  ): Promise<PlannedWorkout> {
    const prompt = `
## User feedback on a single workout

Workout: ${workout.workoutName} (${workout.scheduledDate ?? "unscheduled"})

Feedback: ${feedback}

## Current workout (for reference)

${JSON.stringify(workout, null, 2)}

Apply the feedback and return ONLY the updated single workout as a JSON object (PlannedWorkout schema, not wrapped in WeeklyWorkoutPlan), then SUMMARY:.
`.trim();

    console.log("\n🤖 Adjusting workout...");
    console.log("─".repeat(60));
    const rawResponse = await this.sendPrompt(prompt, "iterateSingleWorkout");
    console.log("─".repeat(60));

    this.saveLastResponse(rawResponse);

    // Extract JSON + summary
    const summaryMatch = rawResponse.match(/\nSUMMARY:([\s\S]*)$/m);
    const summary = summaryMatch ? summaryMatch[1].trim() : "";
    const jsonPortion = summaryMatch
      ? rawResponse.slice(0, summaryMatch.index)
      : rawResponse;

    let parsed: unknown;
    try {
      parsed = extractJson(jsonPortion);
    } catch (e) {
      console.error(`⚠️  Could not parse LLM response. Keeping original workout.`);
      return workout;
    }

    if (summary) {
      console.log("\n📝 LLM Summary:");
      console.log(summary);
    }

    const parsedWorkout = parsed as PlannedWorkout;
    const primaryExercise = this.guessPrimaryExerciseName(workout);
    if (!primaryExercise) {
      return parsedWorkout;
    }

    const baseSets = this.countExerciseSets(workout.steps ?? [], primaryExercise);
    if (baseSets <= 0) {
      return parsedWorkout;
    }

    return this.ensureWorkoutExerciseSetMinimum(
      parsedWorkout,
      primaryExercise,
      baseSets
    );
  }

  // ── Two-phase LLM analysis ─────────────────────────────────────────────────

  /**
   * Match a PlannedWorkout to the closest GarminActivity from last week.
   * Tiered strategy: workoutId → same date + type → same day-of-week + type → type only.
   * Pass usedIds to prevent double-matching the same activity to two workouts.
   */
  private matchActivityToWorkout(
    workout: PlannedWorkout,
    activities: ExtractedActivities,
    usedIds: Set<string>
  ): GarminActivity | undefined {
    const typeCompatible = (
      actType: string,
      workoutType: string | undefined
    ): boolean => {
      if (!workoutType) return true;
      return actType === workoutType;
    };

    const available = activities.activities.filter((a) => !usedIds.has(a.id));

    // 1. Same workoutId
    if (workout.workoutId != null) {
      const match = available.find(
        (a) => a.workoutId != null && String(a.workoutId) === String(workout.workoutId)
      );
      if (match) return match;
    }

    // 2. Same date + compatible type
    if (workout.scheduledDate) {
      const dates = Array.isArray(workout.scheduledDate)
        ? workout.scheduledDate
        : [workout.scheduledDate];
      const match = available.find(
        (a) =>
          dates.includes(a.startTime.slice(0, 10)) &&
          typeCompatible(a.activityType, workout.workoutType)
      );
      if (match) return match;
    }

    // 3. Same day-of-week in the previous week + compatible type
    if (workout.scheduledDate) {
      const dates = Array.isArray(workout.scheduledDate)
        ? workout.scheduledDate
        : [workout.scheduledDate];
      const workoutDows = dates.map((d) => new Date(d).getUTCDay());
      const match = available.find(
        (a) =>
          workoutDows.includes(new Date(a.startTime).getUTCDay()) &&
          typeCompatible(a.activityType, workout.workoutType)
      );
      if (match) return match;
    }

    // 4. First available activity with matching type
    return available.find((a) => typeCompatible(a.activityType, workout.workoutType));
  }

  /**
   * Extract benchmark entries relevant to a specific workout's exercises.
   * For strength workouts, matches step exerciseNames against strengthBenchmarks.
   * For running workouts, returns runningBenchmarks.
   */
  private extractRelevantBenchmarks(
    workout: PlannedWorkout,
    trainingPlan: TrainingPlan
  ): string {
    const isRunning = workout.workoutType === "running";
    if (isRunning) {
      const rb = trainingPlan.runningBenchmarks;
      if (!rb || Object.keys(rb).length === 0) return "";
      return Object.entries(rb)
        .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
        .join("\n");
    }

    const exerciseNames = new Set<string>();
    for (const step of workout.steps ?? []) {
      if (step.exerciseName) exerciseNames.add(normalizeExerciseName(step.exerciseName) ?? "");
      for (const sub of step.repeatSteps ?? []) {
        if (sub.exerciseName) exerciseNames.add(normalizeExerciseName(sub.exerciseName) ?? "");
      }
    }

    const sb = trainingPlan.strengthBenchmarks ?? {};
    const lines: string[] = [];
    for (const [key, val] of Object.entries(sb)) {
      if (exerciseNames.has(normalizeExerciseName(key) ?? "")) {
        lines.push(`  ${key}: ${val.oneRepMax} lbs 1RM (updated ${val.lastUpdated})`);
      }
    }
    return lines.join("\n");
  }

  /**
   * Phase 1: Send all activities + training plan to get a concise weekly summary.
   * Returns plain-text summary with a readiness signal (HIGH/MODERATE/LOW).
   */
  async getWeeklySummary(
    activities: ExtractedActivities,
    trainingPlan: TrainingPlan
  ): Promise<WeeklySummaryResult> {
    const { currentPhase, weekInPhase, totalWeeksInPhase } = trainingPlan.periodization;

    if (this.mockMode) {
      return {
        summaryText: [
          `- Completed ${activities.totalActivities} session(s) this week.`,
          `- Phase: ${currentPhase}, week ${weekInPhase}/${totalWeeksInPhase}.`,
          `- Mock mode: no real LLM called.`,
          `- MODERATE`,
        ].join("\n"),
        phase: currentPhase,
        weekInPhase,
        readinessSignal: "moderate",
      };
    }

    // Top 5 benchmarks by most recently updated
    const topBenchmarks = Object.entries(trainingPlan.strengthBenchmarks ?? {})
      .sort((a, b) => b[1].lastUpdated.localeCompare(a[1].lastUpdated))
      .slice(0, 5)
      .map(([k, v]) => `  ${k}: ${v.oneRepMax} lbs 1RM`)
      .join("\n");

    const compactActs = this.compactActivities(activities);

    const prompt = `
## Task: Weekly Training Summary

Produce a CONCISE plain-text summary (4-8 bullet points). Do NOT output JSON.

Cover:
- Overall training adherence (sessions completed vs missed)
- Performance highlights and key metrics (top weights, paces, HR trends)
- Fatigue and recovery signals (body battery drain, RPE, feel ratings)
- Phase progress: are we on track for ${currentPhase} goals (week ${weekInPhase}/${totalWeeksInPhase})?
- Readiness for next week: end your last bullet with the single word HIGH, MODERATE, or LOW

## Training Plan Context
Phase: ${currentPhase} — Week ${weekInPhase} of ${totalWeeksInPhase}
Goals: ${trainingPlan.goals.primary}${topBenchmarks ? `\nTop benchmarks:\n${topBenchmarks}` : ""}

## Last Week's Activities
Week: ${activities.weekStart} to ${activities.weekEnd}
Total: ${activities.totalActivities}

${JSON.stringify(compactActs, null, 2)}
`.trim();

    console.log("\n🤖 Getting weekly summary...");
    console.log("─".repeat(60));
    const rawResponse = await this.sendPrompt(prompt, "getWeeklySummary");
    console.log("─".repeat(60));

    const readinessMatch = rawResponse.match(/\b(HIGH|MODERATE|LOW)\b/i);
    const readinessSignal = readinessMatch
      ? (readinessMatch[1].toLowerCase() as "high" | "moderate" | "low")
      : "moderate";

    return {
      summaryText: rawResponse.trim(),
      phase: currentPhase,
      weekInPhase,
      readinessSignal,
    };
  }

  /**
   * Phase 2: Generate an adjusted PlannedWorkout using the weekly summary,
   * the matching last-week activity, and the workout template.
   */
  async generateSingleWorkout(
    workout: PlannedWorkout,
    weeklySummary: WeeklySummaryResult,
    matchedActivity: GarminActivity | undefined,
    trainingPlan: TrainingPlan
  ): Promise<PlannedWorkout> {
    if (this.mockMode) {
      return workout;
    }

    const benchmarkSection = this.extractRelevantBenchmarks(workout, trainingPlan);
    const { currentPhase, weekInPhase, totalWeeksInPhase } = trainingPlan.periodization;

    const activitySection = matchedActivity
      ? `Activity: ${matchedActivity.activityName} on ${matchedActivity.startTime.slice(0, 10)} (${matchedActivity.activityType})
Duration: ${matchedActivity.duration}s | HR: ${matchedActivity.avgHR ?? "N/A"} | Feel(freshness 1-100): ${matchedActivity.directWorkoutFeel ?? "N/A"} | RPE(effort 1-100): ${matchedActivity.directWorkoutRpe ?? "N/A"}
Body battery: ${matchedActivity.differenceBodyBattery ?? "N/A"} | Training effect: ${matchedActivity.aerobicTrainingEffect ?? "N/A"}
${JSON.stringify((matchedActivity.exerciseSets ?? []).slice(0, 6), null, 2)}`
      : "No matching activity found for this workout slot (may have been skipped or unlogged).";

    const prompt = `
## Task: Adjust a Single Workout

Using the weekly context below, produce the adjusted version of this ONE workout.
Output ONLY a valid PlannedWorkout JSON object (not wrapped in WeeklyWorkoutPlan), then on a new line: SUMMARY: followed by a 1-3 sentence explanation of changes.

## Weekly Summary
${weeklySummary.summaryText}

Readiness: ${weeklySummary.readinessSignal.toUpperCase()}

## Training Plan Excerpts
Phase: ${currentPhase} — Week ${weekInPhase} of ${totalWeeksInPhase}
Goals: ${trainingPlan.goals.primary}${benchmarkSection ? `\nRelevant benchmarks:\n${benchmarkSection}` : ""}

## Matching Last-Week Activity
${activitySection}

## Workout Template to Adjust
${JSON.stringify(workout, null, 2)}

Adjust the workout according to the context. Return PlannedWorkout JSON then SUMMARY:.
`.trim();

    console.log(`\n🤖 Generating: ${workout.workoutName} (${workout.scheduledDate ?? "unscheduled"})...`);
    console.log("─".repeat(60));
    const rawResponse = await this.sendPrompt(prompt, "generateSingleWorkout");
    console.log("─".repeat(60));

    this.saveLastResponse(rawResponse);

    const summaryMatch = rawResponse.match(/\nSUMMARY:([\s\S]*)$/m);
    const summary = summaryMatch ? summaryMatch[1].trim() : "";
    const jsonPortion = summaryMatch
      ? rawResponse.slice(0, summaryMatch.index)
      : rawResponse;

    let parsed: unknown;
    try {
      parsed = extractJson(jsonPortion);
    } catch {
      console.warn(`⚠️  Could not parse LLM response for "${workout.workoutName}". Using original.`);
      return workout;
    }

    if (summary) {
      console.log("\n📝 Changes:");
      console.log(summary);
    }

    const parsedWorkout = parsed as PlannedWorkout;
    const primaryExercise = this.guessPrimaryExerciseName(workout);
    if (!primaryExercise) return parsedWorkout;

    const baseSets = this.countExerciseSets(workout.steps ?? [], primaryExercise);
    if (baseSets <= 0) return parsedWorkout;

    return this.ensureWorkoutExerciseSetMinimum(parsedWorkout, primaryExercise, baseSets);
  }

  /**
   * Two-phase orchestrator: Phase 1 gets a weekly summary, Phase 2 generates
   * each workout individually. More focused prompts than analyzeAndAdjust().
   */
  async analyzeAndAdjustTwoPhase(
    context: AdjustmentContext,
    onProgress?: (step: string) => void
  ): Promise<AdjustmentResult> {
    const { activities, currentPlan, trainingPlan } = context;

    const hasScheduledDates = currentPlan.workouts.some((w) => w.scheduledDate != null);
    let planToUse = currentPlan;
    if (hasScheduledDates) {
      const performedIds = this.extractWorkoutIds(activities);
      planToUse = this.filterWorkoutsByIds(currentPlan, performedIds);
      console.log(
        `   Filtered workouts: ${currentPlan.workouts.length} → ${planToUse.workouts.length} (matching performed activities)`
      );
    }

    const trimmedPlan = this.trimPlanForLLM(planToUse, { trainingPlan, limit: 7 });
    const total = trimmedPlan.workouts.length;

    // Phase 1: weekly summary
    onProgress?.("Step 7a: Getting weekly summary...");
    const weeklySummary = await this.getWeeklySummary(activities, trainingPlan);
    console.log("\n--- Weekly Summary ---");
    console.log(weeklySummary.summaryText);
    console.log(`Readiness: ${weeklySummary.readinessSignal}`);

    // Phase 2: per-workout generation
    const adjustedWorkouts: PlannedWorkout[] = [];
    const usedActivityIds = new Set<string>();

    for (let i = 0; i < total; i++) {
      const workout = trimmedPlan.workouts[i];
      onProgress?.(`Step 7b: Generating workout ${i + 1}/${total}: ${workout.workoutName}...`);

      const matched = this.matchActivityToWorkout(workout, activities, usedActivityIds);
      if (matched) usedActivityIds.add(matched.id);

      let adjusted: PlannedWorkout;
      try {
        adjusted = await this.generateSingleWorkout(workout, weeklySummary, matched, trainingPlan);
      } catch (e) {
        console.warn(`\n⚠️  Generation failed for "${workout.workoutName}": ${(e as Error).message}`);
        console.warn(`   Using original template.`);
        adjusted = workout;
      }
      adjustedWorkouts.push(adjusted);
    }

    const rawPlan: WeeklyWorkoutPlan = {
      ...trimmedPlan,
      source: "llm-adjusted",
      workouts: adjustedWorkouts,
    };

    const withTrainingBaselines = this.applyMainLiftBaselinesFromTrainingPlan(trainingPlan, rawPlan);
    const guardedPlan = this.applyPrimarySetFloorsFromBasePlan(trimmedPlan, withTrainingBaselines);
    this.auditForDuplicatesWarning(guardedPlan);

    return {
      adjustedPlan: guardedPlan,
      changeSummary: formatChangeSummary(trimmedPlan, guardedPlan),
      llmReasoning: weeklySummary.summaryText,
    };
  }

  /** Clean up the LLM session and client */
  async cleanup(): Promise<void> {
    try {
      if (this.session) {
        await this.session.destroy();
        this.session = null;
      }
      if (this.client) {
        await this.client.stop();
        this.client = null;
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  // ── Mock mode ──────────────────────────────────────────────────────────────

  private getMockResponse(): string {
    return `{
  "generatedAt": "${new Date().toISOString()}",
  "weekStart": "2026-02-23",
  "weekEnd": "2026-03-01",
  "source": "llm-adjusted",
  "workouts": []
}
SUMMARY:
- Mock mode: No real LLM was called.
- This is a placeholder adjusted plan.
- In real mode, weights and reps would be adjusted based on last week's performance.`;
  }
}

// ─── Interactive CLI loop ──────────────────────────────────────────────────────

/**
 * Interactive stdin loop: displays the plan, prompts the user for
 * [a]pprove / [e]feedback / [q]uit, and returns the final approved plan
 * or null if the user quit.
 */
export async function interactiveLoop(
  adjuster: WorkoutAdjuster,
  initialResult: AdjustmentResult,
  originalPlan: WeeklyWorkoutPlan
): Promise<WeeklyWorkoutPlan | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  let currentResult = initialResult;
  let currentPlan = initialResult.adjustedPlan;

  let keepGoing = true;
  let approved = false;

  while (keepGoing) {
    console.log("\n" + currentResult.changeSummary + "\n");
    console.log("📋 Adjusted plan preview:");
    console.log("─────────────────────────");
    for (const w of currentPlan.workouts) {
      const stepCount = (w.steps ?? []).length;
      console.log(`  ${w.scheduledDate ?? "?"} │ ${w.workoutName} (${stepCount} steps)`);
    }
    console.log("─────────────────────────");

    const answer = await question(
      '\nChoose: [a] Approve & upload  [e] Give feedback  [s] Save to file  [q] Quit\n> '
    );
    const choice = answer.trim().toLowerCase();

    if (choice === "a" || choice === "approve") {
      approved = true;
      keepGoing = false;
    } else if (choice === "q" || choice === "quit") {
      approved = false;
      keepGoing = false;
    } else if (choice === "s" || choice === "save") {
      const filePath = path.join(process.cwd(), "data/workouts-adjusted.json");
      fs.writeFileSync(filePath, JSON.stringify(currentPlan, null, 2), "utf-8");
      console.log(`\n💾 Saved to ${filePath}`);
    } else if (choice === "e" || choice === "edit") {
      const feedback = await question(
        "Enter your feedback (press Enter twice to submit):\n> "
      );
      if (feedback.trim()) {
        currentResult = await adjuster.iterate(feedback, currentPlan);
        currentPlan = currentResult.adjustedPlan;
      }
    } else {
      console.log("  Unrecognized choice. Try a, e, s, or q.");
    }
  }

  rl.close();
  return approved ? currentPlan : null;
}

// ─── Per-workout review helpers ──────────────────────────────────────────────

/**
 * Pretty-print all steps of a single workout.
 */
export function displayWorkoutDetail(workout: PlannedWorkout): void {
  const steps = workout.steps ?? [];
  if (steps.length === 0) {
    console.log("  (no steps)");
    return;
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const parts: string[] = [`  ${i + 1}.`];

    // Step type badge
    parts.push(`[${s.stepType}]`);

    // Exercise name
    if (s.exerciseName) parts.push(s.exerciseName);

    // Repeat group
    if (s.stepType === "repeat" && s.numberOfRepeats) {
      parts.push(`x${s.numberOfRepeats}`);
      console.log(parts.join(" "));
      if (s.repeatSteps) {
        for (let j = 0; j < s.repeatSteps.length; j++) {
          const rs = s.repeatSteps[j];
          const rParts: string[] = [`     ${i + 1}.${j + 1}`, `[${rs.stepType}]`];
          if (rs.exerciseName) rParts.push(rs.exerciseName);
          if (rs.reps !== undefined) rParts.push(`${rs.reps} reps`);
          if (rs.durationSeconds !== undefined) rParts.push(`${rs.durationSeconds}s`);
          if (rs.weight !== undefined) rParts.push(`@${rs.weight}lbs`);
          if (rs.weightPercentage !== undefined) rParts.push(`@${rs.weightPercentage}%`);
          if (rs.restTimeSeconds) rParts.push(`rest:${rs.restTimeSeconds}s`);
          if (rs.targetValueOne !== undefined && rs.targetValueTwo !== undefined) {
            rParts.push(`target:${rs.targetValueOne}-${rs.targetValueTwo}`);
          }
          console.log(rParts.join(" "));
        }
      }
      continue;
    }

    // End condition details
    if (s.reps !== undefined) parts.push(`${s.reps} reps`);
    if (s.durationSeconds !== undefined) parts.push(`${s.durationSeconds}s`);
    if (s.distanceMeters !== undefined) parts.push(`${s.distanceMeters}m`);

    // Weight
    if (s.weight !== undefined) parts.push(`@${s.weight}lbs`);
    if (s.weightPercentage !== undefined) {
      parts.push(`@${s.weightPercentage}%`);
      if (s.benchmarkKey) parts.push(`of ${s.benchmarkKey}`);
    }

    // Target zones
    if (s.targetType && s.targetType !== "no.target" && s.targetValueOne !== undefined && s.targetValueTwo !== undefined) {
      parts.push(`target(${s.targetType}):${s.targetValueOne}-${s.targetValueTwo}`);
    }

    // Rest
    if (s.restTimeSeconds) parts.push(`rest:${s.restTimeSeconds}s`);

    console.log(parts.join(" "));
  }
}

/**
 * Display a side-by-side diff of a single workout (old vs new).
 */
export function formatSingleWorkoutDiff(
  oldWorkout: PlannedWorkout | undefined,
  newWorkout: PlannedWorkout
): string {
  const lines: string[] = [];

  if (!oldWorkout) {
    lines.push(`  NEW workout (no original to compare)`);
    return lines.join("\n");
  }

  // Date change
  if (oldWorkout.scheduledDate !== newWorkout.scheduledDate) {
    lines.push(
      `  Date: ${formatScheduledDate(oldWorkout.scheduledDate)} -> ${formatScheduledDate(newWorkout.scheduledDate)}`
    );
  }

  // Step-level diff
  const oldSteps = flattenForDiff(oldWorkout.steps ?? []);
  const newSteps = flattenForDiff(newWorkout.steps ?? []);
  const stepDiffLines = buildStepDiffLines(oldSteps, newSteps, "->");
  lines.push(...stepDiffLines);

  if (stepDiffLines.length === 0) {
    lines.push("  (no changes)");
  }

  return lines.join("\n");
}

/**
 * Per-workout interactive review loop.
 * Iterates through each workout individually, allowing approve/edit/skip per workout.
 * Returns the final WeeklyWorkoutPlan with only approved workouts, or null if user quit.
 */
export async function perWorkoutReviewLoop(
  adjuster: WorkoutAdjuster,
  initialResult: AdjustmentResult,
  originalPlan: WeeklyWorkoutPlan
): Promise<WeeklyWorkoutPlan | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  const adjustedPlan = initialResult.adjustedPlan;
  const workouts = [...adjustedPlan.workouts];
  const matchedOriginalIndices = new Set<number>();

  // Show overall summary first
  if (initialResult.changeSummary) {
    console.log("\n" + initialResult.changeSummary);
  }

  console.log(`\n📋 Reviewing ${workouts.length} workout(s) individually...\n`);

  const approved: PlannedWorkout[] = [];
  const skipped: string[] = [];
  let quit = false;

  for (let i = 0; i < workouts.length; i++) {
    let workout = workouts[i];
    const originalIndex = findMatchingWorkoutIndex(
      originalPlan.workouts,
      workout,
      matchedOriginalIndices
    );
    const original =
      originalIndex !== -1 ? originalPlan.workouts[originalIndex] : undefined;
    if (originalIndex !== -1) {
      matchedOriginalIndices.add(originalIndex);
    }

    let comparisonBase = original;
    let reviewingThisWorkout = true;

    while (reviewingThisWorkout) {
      console.log("═".repeat(60));
      console.log(`  Workout ${i + 1}/${workouts.length}: ${workout.workoutName}`);
      console.log(`  Date: ${workout.scheduledDate ?? "unscheduled"} | Type: ${workout.workoutType ?? "unknown"}`);
      console.log("─".repeat(60));

      // Show diff
      const diff = formatSingleWorkoutDiff(comparisonBase, workout);
      console.log(diff);
      console.log("─".repeat(60));

      const answer = await question(
        "\n  [a] Approve  [e] Edit (give feedback)  [v] View details  [s] Skip  [q] Quit\n  > "
      );
      const choice = answer.trim().toLowerCase();

      if (choice === "a" || choice === "approve") {
        approved.push(workout);
        console.log(`  ✅ Approved: ${workout.workoutName}`);
        reviewingThisWorkout = false;
      } else if (choice === "s" || choice === "skip") {
        skipped.push(workout.workoutName);
        console.log(`  ⏭️  Skipped: ${workout.workoutName}`);
        reviewingThisWorkout = false;
      } else if (choice === "v" || choice === "view") {
        console.log("\n  Full step details:");
        displayWorkoutDetail(workout);
      } else if (choice === "e" || choice === "edit") {
        const feedback = await question("  Enter feedback:\n  > ");
        if (feedback.trim()) {
          const previousWorkout = workout;
          workout = await adjuster.iterateSingleWorkout(feedback, workout);
          workouts[i] = workout;
          comparisonBase = previousWorkout;
          // Loop back to show updated diff
        }
      } else if (choice === "q" || choice === "quit") {
        quit = true;
        reviewingThisWorkout = false;
      } else {
        console.log("  Unrecognized choice. Try a, e, v, s, or q.");
      }
    }

    if (quit) break;
  }

  rl.close();

  if (quit) {
    return null;
  }

  // Show summary
  console.log("\n" + "═".repeat(60));
  console.log("📊 Review Summary");
  console.log("─".repeat(60));
  console.log(`  Approved: ${approved.length}`);
  if (skipped.length > 0) {
    console.log(`  Skipped:  ${skipped.length} (${skipped.join(", ")})`);
  }
  console.log("─".repeat(60));

  for (const w of approved) {
    console.log(`  ${w.scheduledDate ?? "?"} | ${w.workoutName}`);
  }
  console.log("═".repeat(60));

  if (approved.length === 0) {
    console.log("\n  No workouts approved.");
    return null;
  }

  // Build final plan with only approved workouts
  return {
    ...adjustedPlan,
    workouts: approved,
  };
}
