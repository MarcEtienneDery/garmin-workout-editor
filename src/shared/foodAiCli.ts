/**
 * foodAiCli.ts — asking Claude for an estimate through Claude Code's headless mode (`claude -p`), for a server that has a Claude plan
 * (Pro, Max) and no API credit. The estimate then runs on the plan's own usage limits, not on a paid balance: Anthropic's support article
 * "Use the Claude Agent SDK with your Claude plan" says `claude -p` and the Agent SDK still draw from subscription limits (they paused a
 * change to that in June 2026, so it can change again). A plan is for one person: every profile of this server asks on that one login.
 *
 * One run is one question: the person's words and photos go in as one stream-json user message (images are content blocks, so there
 * are no files and no tools), Claude Code is given no tools at all and none of the machine's settings, hooks, skills or MCP servers
 * (`--tools ""`, `--restricted`, `--strict-mcp-config`, `--disable-slash-commands`), the food log's own system prompt replaces its default
 * one, and the answer is the `structured_output` of the final `result` event, which follows the same JSON Schema as the API's answer.
 * `--bare` is not used: it ignores the plan login. The login in a container is a token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN).
 *
 * The child gets an allowlist of the environment, never ANTHROPIC_API_KEY (which Claude Code would prefer to the plan, and bill). The
 * spawning is `runClaude`, injected in tests; everything else is plain functions.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FoodAiError } from "./foodAiError";

/** A first run starts Claude Code and may fill its prompt cache; a slow one is still an answer. */
export const CLI_TIMEOUT_MS = 90_000;
/** Claude Code takes a few hundred MB: more than this at once on a NAS is a way to stall it. */
export const CLI_MAX_RUNNING = 2;
const MAX_OUTPUT = 8_000_000;

/** One run of the program: what to start and with what. */
export interface CliCall {
  bin: string;
  args: string[];
  /** What to write to its stdin, which is then closed. */
  input: string;
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
}

/** What a run left: its exit code, what it printed, and whether it had to be killed or could not be started. */
export interface CliOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the program could not be started (ENOENT: not installed). */
  error?: NodeJS.ErrnoException;
}

export type CliRunner = (call: CliCall) => Promise<CliOutput>;

/** Start the program, feed it the input, and collect what it prints; it is killed at the timeout or when it prints more than MAX_OUTPUT. */
export const runClaude: CliRunner = (call) =>
  new Promise((resolve) => {
    let settled = false, stdout = "", stderr = "", timedOut = false;
    const done = (code: number | null, error?: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, error });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(call.bin, call.args, { cwd: call.cwd, env: call.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      return resolve({ code: null, stdout, stderr, timedOut, error: error as NodeJS.ErrnoException });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, call.timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT) child.kill("SIGKILL");
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on("error", (error) => done(null, error as NodeJS.ErrnoException));
    child.on("close", (code) => done(code));
    child.stdin?.on("error", () => undefined); // it exited before reading: its own exit says why
    child.stdin?.end(call.input);
  });

/** The environment variables the child may see: the ones it needs to run and reach Anthropic, and the plan login. Nothing else, ANTHROPIC_API_KEY least of all. */
const PASS = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"];

export function cliEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_COLOR: "1" };
  for (const key of PASS) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

/** The flags of a run: one message in and the events out as stream-json (the only way to send an image), the answer in a JSON Schema, no tools, nothing of the machine's configuration, nothing kept. */
export function cliArgs(model: string, system: string, schema: unknown): string[] {
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--json-schema", JSON.stringify(schema), "--system-prompt", system,
    "--tools", "", "--model", model, "--effort", "low",
    "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config", "--restricted",
  ];
}

/** The one user message of a run, as a line of stream-json: `content` is the blocks of the Messages API (images first, then the text). */
export const cliInput = (content: unknown[]): string => `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The events a run printed, one JSON object a line; a line that is not JSON is skipped. */
function eventsOf(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = record(JSON.parse(line));
      if (event) events.push(event);
    } catch {
      // not an event
    }
  }
  return events;
}

/** When the plan's window that refused the run opens again, in words ("in about 2 h 10 min"), from the run's rate limit event; "" when it says nothing of it. */
function resetsIn(events: Record<string, unknown>[], now: number): string {
  for (const event of [...events].reverse()) {
    const info = event.type === "rate_limit_event" ? record(event.rate_limit_info) : null;
    const at = info && info.status !== "allowed" ? Number(info.resetsAt) : NaN;
    if (!Number.isFinite(at)) continue;
    const minutes = Math.max(1, Math.round((at * 1000 - now) / 60_000));
    return minutes >= 60 ? ` It resets in about ${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}.` : ` It resets in about ${minutes} min.`;
  }
  return "";
}

/** The failure a result event reports, in words. Claude Code's own text and the SDK's go to nobody: the class of failure is all the page learns. */
function failureOf(result: Record<string, unknown>, events: Record<string, unknown>[], now: number): FoodAiError {
  const text = String(result.result ?? ""), status = Number(result.api_error_status) || 0;
  console.error(`food AI: claude reported an error${status ? ` (${status})` : ""}`);
  if (status === 401 || status === 403 || /not logged in|failed to authenticate|\/login|oauth/i.test(text)) {
    return new FoodAiError("upstream", "Claude Code is not signed in on the server. Make a token with `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN.");
  }
  if (status === 429 || /usage limit|limit reached|rate limit|too many requests/i.test(text)) {
    return new FoodAiError("upstream", `Your Claude plan's usage limit is reached for now.${resetsIn(events, now) || " Try again later."}`);
  }
  if (status >= 500 || /overloaded/i.test(text)) return new FoodAiError("upstream", "Claude is having trouble right now. Try again.");
  return new FoodAiError("upstream", "Claude could not make this estimate. Try again.");
}

/** What a finished run came to: the answer as an object, null when Claude gave none, or `refused`. A run that failed to ask throws a FoodAiError. */
export type CliReply = { stop: "ok"; answer: unknown } | { stop: "refused"; answer: null } | { stop: "unreadable"; answer: null };

export function replyOf(out: CliOutput, now = Date.now()): CliReply {
  if (out.error) {
    const missing = out.error.code === "ENOENT" || out.error.code === "EACCES";
    console.error(`food AI: claude could not be started (${out.error.code ?? "error"})`);
    throw new FoodAiError(missing ? "unconfigured" : "upstream", missing ? "Claude Code is not installed on this server (FOOD_AI_CLAUDE_BIN names the program to run)." : "Claude Code could not be started on this server.");
  }
  if (out.timedOut) {
    console.error("food AI: claude timed out");
    throw new FoodAiError("upstream", "Claude did not answer in time. Try again.");
  }
  const events = eventsOf(out.stdout), result = [...events].reverse().find((e) => e.type === "result");
  if (!result) {
    console.error(`food AI: claude exited ${out.code} with no result`);
    throw new FoodAiError("upstream", "Claude Code gave no answer. Try again.");
  }
  if (result.is_error) throw failureOf(result, events, now);
  if (record(result.structured_output)) return { stop: "ok", answer: result.structured_output };
  return result.stop_reason === "refusal" || Number(result.safety_stops) > 0 ? { stop: "refused", answer: null } : { stop: "unreadable", answer: null };
}

export interface CliQuestion {
  model: string;
  system: string;
  schema: unknown;
  /** The user message: image blocks first, then a text block. */
  content: unknown[];
}

let running = 0;

/** How many runs are under way (for tests). */
export const cliRunning = (): number => running;

/** Ask Claude Code one question, in an empty directory of its own that is removed after; at most CLI_MAX_RUNNING at once. */
export async function askCli(question: CliQuestion, env: NodeJS.ProcessEnv, run: CliRunner = runClaude): Promise<CliReply> {
  if (running >= CLI_MAX_RUNNING) throw new FoodAiError("busy", "Estimates are already running for someone else. Try again in a few seconds.");
  running++;
  let cwd: string | null = null;
  try {
    try {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), "food-ai-"));
    } catch {
      throw new FoodAiError("upstream", "Claude Code could not be started on this server.");
    }
    const out = await run({ bin: (env.FOOD_AI_CLAUDE_BIN ?? "").trim() || "claude", args: cliArgs(question.model, question.system, question.schema), input: cliInput(question.content), env: cliEnv(env), cwd, timeoutMs: CLI_TIMEOUT_MS });
    return replyOf(out);
  } finally {
    running--;
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  }
}

