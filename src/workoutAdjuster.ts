import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
// @github/copilot-sdk is ESM-only; loaded via dynamic import in createSession()
import {
  AdjustmentContext,
  AdjustmentResult,
  TrainingPlan,
  WeeklyWorkoutPlan,
  PlannedWorkout,
  WorkoutStep,
  WeekSummary,
} from "./shared/types";
import { ExtractedActivities } from "./shared/types";

const DEFAULT_MODEL = process.env.COPILOT_MODEL ?? "claude-sonnet-4.5";

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
  if (step.weightPercentage !== undefined)
    parts.push(`@${step.weightPercentage}%`);
  else if (step.weight !== undefined) parts.push(`@${step.weight}lbs`);
  if (step.targetValueOne !== undefined && step.targetValueTwo !== undefined)
    parts.push(`target:${step.targetValueOne}-${step.targetValueTwo}`);
  return parts.join(" ");
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

  const byName = (ws: PlannedWorkout[]) =>
    new Map(ws.map((w) => [w.workoutName, w]));
  const oldMap = byName(oldPlan.workouts);
  const newMap = byName(newPlan.workouts);

  for (const newW of newPlan.workouts) {
    const oldW = oldMap.get(newW.workoutName);
    if (!oldW) {
      lines.push(`  ✚ NEW: ${newW.workoutName} (${newW.scheduledDate ?? "no date"})`);
      continue;
    }

    const changedLines: string[] = [];

    if (oldW.scheduledDate !== newW.scheduledDate) {
      changedLines.push(`  Date: ${oldW.scheduledDate} → ${newW.scheduledDate}`);
    }

    const oldSteps = flattenForDiff(oldW.steps ?? []);
    const newSteps = flattenForDiff(newW.steps ?? []);
    const maxLen = Math.max(oldSteps.length, newSteps.length);
    for (let i = 0; i < maxLen; i++) {
      const os = oldSteps[i] ? describeStep(oldSteps[i]) : "(removed)";
      const ns = newSteps[i] ? describeStep(newSteps[i]) : "(removed)";
      if (os !== ns) {
        changedLines.push(`  Step ${i + 1}: ${os}  →  ${ns}`);
      }
    }

    if (changedLines.length > 0) {
      lines.push(`\n📋 ${newW.workoutName} (${newW.scheduledDate ?? "no date"})`);
      lines.push(...changedLines);
    }
  }

  for (const name of oldMap.keys()) {
    if (!newMap.has(name)) {
      lines.push(`  ✖ REMOVED: ${name}`);
    }
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
      result.push(s);
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

RULES:
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
14. If an activity shows strong performance (low RPE, good body battery, training effect ≥ 4), progress the next workout modestly (+2.5–5% weight or +1–2 reps or –5 sec/km pace).
15. If performance was poor (high RPE, low body battery < 20, missed sets), reduce load 5–10% or keep flat.
16. Respect the current periodization phase (hypertrophy = higher reps/volume, strength = lower reps/higher %).
17. After the JSON, on a new line starting with "SUMMARY:", write a concise human-readable bullet list of what you changed and why (this part WILL be shown to the user).

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

  /** Create a LLM session (no-op in mock mode) */
  async createSession(): Promise<void> {
    if (this.mockMode) return;

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
  private async sendPrompt(prompt: string): Promise<string> {
    if (this.mockMode) {
      return this.getMockResponse();
    }

    if (!this.session) {
      throw new Error("LLM session not initialized. Call createSession() first.");
    }

    let fullContent = "";
    let firstTokenReceived = false;
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
        const retry = await this.sendPrompt(fixPrompt);
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
        const retry = await this.sendPrompt(fixPrompt);
        return this.parseAndValidateResponse(retry, retryCount + 1);
      }
      throw new Error("LLM response does not contain a valid WeeklyWorkoutPlan structure after retries.");
    }

    return { plan, summary };
  }

  // ── Payload helpers ────────────────────────────────────────────────────────

  /**
   * Trim the workout plan down to what the LLM actually needs:
   * - Prefer workouts with a scheduledDate within the plan's week range.
   * - If none have scheduledDate (flat library dump), cap at `limit` and warn.
   */
  private trimPlanForLLM(plan: WeeklyWorkoutPlan, limit = 7): WeeklyWorkoutPlan {
    const scheduled = plan.workouts.filter((w) => !!w.scheduledDate);

    if (scheduled.length > 0) {
      // Filter to workouts within the plan's week range
      const inRange = plan.weekStart
        ? scheduled.filter(
            (w) =>
              w.scheduledDate! >= plan.weekStart &&
              w.scheduledDate! <= plan.weekEnd
          )
        : scheduled;
      const workouts = inRange.length > 0 ? inRange : scheduled.slice(0, limit);
      return { ...plan, workouts };
    }

    // No scheduledDate — this is probably the full library export.
    // Cap it and warn so the user knows to use a proper plan file.
    if (plan.workouts.length > limit) {
      console.warn(
        `\n⚠️  Workout file contains ${plan.workouts.length} workouts with no scheduled dates.` +
        `\n   Sending only the first ${limit} to the LLM. For better results, pass a weekly plan` +
        `\n   file (e.g. data/next-week.workouts.tmp.json from --generate-template).\n`
      );
    }
    return { ...plan, workouts: plan.workouts.slice(0, limit) };
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
      selfEvaluationFeeling: a.selfEvaluationFeeling,
      directWorkoutRpe: a.directWorkoutRpe,
      differenceBodyBattery: a.differenceBodyBattery,
      totalSets: a.totalSets,
      totalReps: a.totalReps,
      // Keep only main lifts (top sets) for strength; first 5 intervals for running
      exerciseSets: (a.exerciseSets ?? []).slice(0, 8),
    }));
  }

  // ── Main flows ─────────────────────────────────────────────────────────────

  /**
   * First call: analyze the context and produce an initial adjusted plan.
   */
  async analyzeAndAdjust(context: AdjustmentContext): Promise<AdjustmentResult> {
    const { activities, currentPlan, trainingPlan } = context;

    const trimmedPlan = this.trimPlanForLLM(currentPlan);
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

## Training progression context

Current phase: ${trainingPlan.periodization.currentPhase}
Week ${trainingPlan.periodization.weekInPhase} of ${trainingPlan.periodization.totalWeeksInPhase}

Goals:
- Primary: ${trainingPlan.goals.primary}
${trainingPlan.goals.secondary ? `- Secondary: ${trainingPlan.goals.secondary}` : ""}
${trainingPlan.goals.notes ? `- Notes: ${trainingPlan.goals.notes}` : ""}

Strength benchmarks (1RM):
${Object.entries(trainingPlan.strengthBenchmarks)
  .map(([k, v]) => `  ${k}: ${v.oneRepMax} lbs`)
  .join("\n")}

Running benchmarks:
${trainingPlan.runningBenchmarks.easyPace ? `  Easy pace: ${trainingPlan.runningBenchmarks.easyPace} min/km` : ""}
${trainingPlan.runningBenchmarks.fiveKPace ? `  5K pace: ${trainingPlan.runningBenchmarks.fiveKPace} min/km` : ""}

Phase notes: ${trainingPlan.periodization.phases.find((p) => p.name === trainingPlan.periodization.currentPhase)?.notes ?? ""}

Constraints: ${JSON.stringify(trainingPlan.constraints)}

Recent weekly history (last 3 weeks):
${JSON.stringify(trainingPlan.weeklyHistory.slice(-3), null, 2)}

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
    const rawResponse = await this.sendPrompt(prompt);
    console.log("─".repeat(60));

    this.saveLastResponse(rawResponse);
    const { plan, summary } = await this.parseAndValidateResponse(rawResponse);

    if (summary) {
      console.log("\n📝 LLM Summary:");
      console.log("─".repeat(60));
      console.log(summary);
      console.log("─".repeat(60));
    }

    return {
      adjustedPlan: plan,
      changeSummary: summary || formatChangeSummary(trimmedPlan, plan),
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
    const rawResponse = await this.sendPrompt(prompt);
    console.log("─".repeat(60));

    this.saveLastResponse(rawResponse);
    const { plan, summary } = await this.parseAndValidateResponse(rawResponse);

    if (summary) {
      console.log("\n📝 LLM Summary:");
      console.log("─".repeat(60));
      console.log(summary);
      console.log("─".repeat(60));
    }

    return {
      adjustedPlan: plan,
      changeSummary: summary || formatChangeSummary(currentPlan, plan),
      llmReasoning: rawResponse,
    };
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
    const rawResponse = await this.sendPrompt(prompt);

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

  /** Clean up the LLM session and client */
  async cleanup(): Promise<void> {
    if (this.mockMode) return;
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
