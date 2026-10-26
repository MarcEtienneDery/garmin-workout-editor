import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CLI_MAX_RUNNING, type CliCall, type CliOutput, askCli, cliArgs, cliEnv, cliInput, cliRunning, replyOf, runClaude } from "../shared/foodAiCli";
import { FoodAiError } from "../shared/foodAiError";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const line = (event: object) => JSON.stringify(event);
const answer = { items: [{ name: "Eggs", portion: "2", meal: "breakfast", amount: 100, unit: "g", kcal: 143, proteinG: 12.6, carbsG: 0.7, fatG: 9.5, nutrients: {} }], note: "" };
const resultLine = (over: Record<string, unknown> = {}) => line({ type: "result", subtype: "success", is_error: false, stop_reason: "tool_use", terminal_reason: "completed", result: JSON.stringify(answer), structured_output: answer, ...over });
const out = (...lines: string[]): CliOutput => ({ code: 0, stdout: `${lines.join("\n")}\n`, stderr: "", timedOut: false });

let quiet: jest.SpyInstance;
beforeEach(() => {
  quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => quiet.mockRestore());

describe("what claude is started with", () => {
  it("gives it one message in and events out, the schema, the food log's prompt, no tools and nothing of the machine's configuration", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const args = cliArgs("claude-sonnet-5-5", "You estimate food.", schema);
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args[0]).toBe("-p");
    expect(after("--input-format")).toBe("stream-json");
    expect(after("--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose"); // stream-json output needs it
    expect(after("--json-schema")).toBe(JSON.stringify(schema));
    expect(after("--system-prompt")).toBe("You estimate food.");
    expect(after("--tools")).toBe(""); // no tools at all: a prompt cannot make it run anything
    expect(after("--model")).toBe("claude-sonnet-5-5");
    expect(after("--effort")).toBe("low");
    for (const flag of ["--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config", "--restricted"]) expect(args).toContain(flag);
    expect(args).not.toContain("--bare"); // bare mode ignores the plan login
  });

  it("writes the message as one line of stream-json, with the blocks as given", () => {
    const blocks = [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } }, { type: "text", text: "hello" }];
    const input = cliInput(blocks);
    expect(input.endsWith("\n")).toBe(true);
    expect(input.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(input)).toEqual({ type: "user", message: { role: "user", content: blocks } });
  });

  it("lets the child see what it needs and the plan login, and none of the server's secrets, the API key above all", () => {
    const env = cliEnv({
      PATH: "/usr/bin", HOME: "/home/node", LANG: "C.UTF-8", HTTPS_PROXY: "http://proxy:3128", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", CLAUDE_CONFIG_DIR: "/tmp/claude",
      ANTHROPIC_API_KEY: "sk-ant-api-key", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "http://elsewhere", WEB_AUTH_TOKEN: "web", CREDENTIALS_KEY: "k", MCP_AUTH_TOKEN: "m", GARMIN_PASSWORD: "p",
    } as NodeJS.ProcessEnv);
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/node", LANG: "C.UTF-8", HTTPS_PROXY: "http://proxy:3128", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", CLAUDE_CONFIG_DIR: "/tmp/claude" });
    expect(Object.keys(env).sort()).toEqual(["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "HOME", "HTTPS_PROXY", "LANG", "NO_COLOR", "PATH"]);
    expect(cliEnv({ PATH: "/bin", HOME: "" } as NodeJS.ProcessEnv)).not.toHaveProperty("HOME"); // an empty one is none
  });
});

describe("what a run came to", () => {
  it("takes the structured output of the last result event", () => {
    const stale = resultLine({ structured_output: { items: [], note: "old" } });
    expect(replyOf(out(line({ type: "system", subtype: "init" }), stale, line({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }), resultLine()))).toEqual({ stop: "ok", answer });
  });

  it("skips what is not an event", () => {
    expect(replyOf({ code: 0, stdout: `not json\n\n[1,2]\n"str"\n${resultLine()}\nhalf a li`, stderr: "", timedOut: false })).toEqual({ stop: "ok", answer });
  });

  it("says refused when Claude declined, and unreadable when it gave no answer", () => {
    expect(replyOf(out(resultLine({ structured_output: undefined, stop_reason: "refusal" })))).toEqual({ stop: "refused", answer: null });
    expect(replyOf(out(resultLine({ structured_output: undefined, safety_stops: 1 })))).toEqual({ stop: "refused", answer: null });
    expect(replyOf(out(resultLine({ structured_output: undefined })))).toEqual({ stop: "unreadable", answer: null });
    expect(replyOf(out(resultLine({ structured_output: "a string" })))).toEqual({ stop: "unreadable", answer: null });
  });

  const fails = (over: Record<string, unknown>, events: string[] = []) => {
    try {
      replyOf(out(...events, resultLine({ is_error: true, structured_output: undefined, result: "", ...over })), NOW);
    } catch (error) {
      return error as FoodAiError;
    }
    throw new Error("did not fail");
  };

  it.each([
    ["no login at all", { result: "Not logged in · Please run /login", api_error_status: null }, /not signed in on the server.*claude setup-token.*CLAUDE_CODE_OAUTH_TOKEN/],
    ["a token that is refused", { result: "Failed to authenticate. API Error: 401 OAuth access token is invalid.", api_error_status: 401 }, /not signed in on the server/],
    ["a 403", { result: "forbidden", api_error_status: 403 }, /not signed in on the server/],
    ["the plan's limit", { result: "5-hour limit reached ∙ resets 7pm", api_error_status: 429 }, /usage limit is reached for now\. Try again later\./],
    ["a limit named in the text only", { result: "Claude usage limit reached", api_error_status: null }, /usage limit is reached/],
    ["an overloaded service", { result: "Overloaded", api_error_status: 529 }, /having trouble right now/],
    ["a server error", { result: "boom", api_error_status: 500 }, /having trouble right now/],
    ["anything else", { result: "something odd with sk-secret-text", api_error_status: 400 }, /could not make this estimate/],
  ])("words %s for the person and shows none of Claude Code's own text", (_what, over, message) => {
    const error = fails(over);
    expect(error).toBeInstanceOf(FoodAiError);
    expect(error.kind).toBe("upstream");
    expect(error.message).toMatch(message);
    expect(error.message).not.toMatch(/sk-secret-text|Overloaded|forbidden|boom/);
  });

  it("says when the plan's window opens again, from the rate limit event", () => {
    const event = (status: string, resetsAt: number) => line({ type: "rate_limit_event", rate_limit_info: { status, resetsAt, rateLimitType: "five_hour" } });
    const at = (minutes: number) => Math.floor((NOW + minutes * 60_000) / 1000);
    expect(fails({ api_error_status: 429 }, [event("rejected", at(130))]).message).toMatch(/It resets in about 2 h 10 min\.$/);
    expect(fails({ api_error_status: 429 }, [event("rejected", at(120))]).message).toMatch(/It resets in about 2 h\.$/);
    expect(fails({ api_error_status: 429 }, [event("rejected", at(25))]).message).toMatch(/It resets in about 25 min\.$/);
    expect(fails({ api_error_status: 429 }, [event("rejected", at(0))]).message).toMatch(/about 1 min\.$/);
    expect(fails({ api_error_status: 429 }, [event("allowed", at(130))]).message).toMatch(/Try again later\.$/); // an allowed window is not the one that refused
    expect(fails({ api_error_status: 429 }, [line({ type: "rate_limit_event" })]).message).toMatch(/Try again later\.$/);
  });

  it("fails for a run that was killed, could not start, or printed no result", () => {
    const quietly = (o: CliOutput) => {
      try {
        replyOf(o);
      } catch (error) {
        return error as FoodAiError;
      }
      throw new Error("did not fail");
    };
    const timed = quietly({ code: null, stdout: "", stderr: "", timedOut: true });
    expect([timed.kind, timed.message]).toEqual(["upstream", "Claude did not answer in time. Try again."]);
    const missing = quietly({ code: null, stdout: "", stderr: "", timedOut: false, error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) });
    expect(missing.kind).toBe("unconfigured");
    expect(missing.message).toMatch(/not installed on this server.*FOOD_AI_CLAUDE_BIN/);
    expect(missing.message).not.toMatch(/ENOENT/);
    expect(quietly({ code: null, stdout: "", stderr: "", timedOut: false, error: Object.assign(new Error("x"), { code: "EMFILE" }) }).kind).toBe("upstream");
    const none = quietly({ code: 1, stdout: line({ type: "system", subtype: "init" }), stderr: "crash", timedOut: false });
    expect([none.kind, none.message]).toEqual(["upstream", "Claude Code gave no answer. Try again."]);
    expect(quiet).toHaveBeenCalledWith("food AI: claude exited 1 with no result");
  });
});

describe("asking claude", () => {
  const question = { model: "claude-sonnet-5-5", system: "sys", schema: { type: "object" }, content: [{ type: "text", text: "hi" }] };

  it("runs the program named by FOOD_AI_CLAUDE_BIN, else claude, in an empty directory of its own that is gone after", async () => {
    let seen: CliCall | null = null, existed = false, empty = false;
    const run = jest.fn(async (call: CliCall) => {
      seen = call;
      existed = fs.statSync(call.cwd).isDirectory();
      empty = fs.readdirSync(call.cwd).length === 0;
      return out(resultLine());
    });
    expect(await askCli(question, { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "sk-no" } as NodeJS.ProcessEnv, run)).toEqual({ stop: "ok", answer });
    const call = seen as unknown as CliCall;
    expect(call.bin).toBe("claude");
    expect(call.args).toEqual(cliArgs("claude-sonnet-5-5", "sys", { type: "object" }));
    expect(JSON.parse(call.input).message.content).toEqual(question.content);
    expect(call.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(call.timeoutMs).toBeGreaterThanOrEqual(30_000);
    expect(existed && empty).toBe(true);
    expect(fs.existsSync(call.cwd)).toBe(false);
    expect(path.dirname(call.cwd)).toBe(os.tmpdir());
    await askCli(question, { FOOD_AI_CLAUDE_BIN: " /opt/claude " } as NodeJS.ProcessEnv, run);
    expect(run.mock.calls[1][0].bin).toBe("/opt/claude");
  });

  it("removes the directory and frees its place when the run fails", async () => {
    let cwd = "";
    const run = jest.fn(async (call: CliCall) => {
      cwd = call.cwd;
      throw new Error("spawn exploded");
    });
    await expect(askCli(question, {}, run)).rejects.toThrow("spawn exploded");
    expect(fs.existsSync(cwd)).toBe(false);
    expect(cliRunning()).toBe(0);
    await expect(askCli(question, {}, async () => ({ code: null, stdout: "", stderr: "", timedOut: true }))).rejects.toThrow(/did not answer in time/);
    expect(cliRunning()).toBe(0);
  });

  it("runs at most CLI_MAX_RUNNING at once and says so to the next", async () => {
    const finish: (() => void)[] = [];
    const slow = () => new Promise<CliOutput>((resolve) => finish.push(() => resolve(out(resultLine()))));
    const first = Array.from({ length: CLI_MAX_RUNNING }, () => askCli(question, {}, slow));
    expect(cliRunning()).toBe(CLI_MAX_RUNNING);
    const busy = await askCli(question, {}, slow).then(() => null, (e) => e);
    expect(busy).toBeInstanceOf(FoodAiError);
    expect(busy.kind).toBe("busy");
    finish.forEach((f) => f());
    await Promise.all(first);
    expect(cliRunning()).toBe(0);
    const again = askCli(question, {}, slow);
    finish[finish.length - 1]();
    expect((await again).stop).toBe("ok");
  });
});

describe("starting the program", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A program of its own that behaves as `body` says (a node script). */
  const program = (body: string) => {
    const file = path.join(dir, "claude");
    fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const call = (bin: string, over: Partial<CliCall> = {}): CliCall => ({ bin, args: ["-p", "--flag", ""], input: "one line\n", env: { PATH: process.env.PATH ?? "" }, cwd: dir, timeoutMs: 10_000, ...over });

  it("writes the input to its stdin and collects what it prints", async () => {
    const bin = program(`let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { console.log(JSON.stringify({ type: "result", args: process.argv.slice(2), got: s, cwd: process.cwd(), key: process.env.ANTHROPIC_API_KEY ?? null, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null })); });`);
    const res = await runClaude(call(bin, { env: { PATH: process.env.PATH ?? "", CLAUDE_CODE_OAUTH_TOKEN: "tok" } }));
    expect([res.code, res.timedOut, res.error]).toEqual([0, false, undefined]);
    const seen = JSON.parse(res.stdout);
    expect(seen).toMatchObject({ args: ["-p", "--flag", ""], got: "one line\n", cwd: fs.realpathSync(dir), key: null, token: "tok" }); // an empty argument arrives as an empty argument
  });

  it("reports an exit code and what it said on stderr", async () => {
    const res = await runClaude(call(program(`console.error("bad things"); process.exit(3);`)));
    expect([res.code, res.stderr.trim(), res.timedOut]).toEqual([3, "bad things", false]);
  });

  it("kills a program that does not finish in time", async () => {
    const started = Date.now();
    const res = await runClaude(call(program(`setTimeout(() => {}, 60000); process.stdin.resume();`), { timeoutMs: 300 }));
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("says when the program is not there", async () => {
    const res = await runClaude(call(path.join(dir, "no-such-program")));
    expect(res.error?.code).toBe("ENOENT");
    expect(res.code).toBeNull();
  });

  it("survives a program that exits without reading its input", async () => {
    const res = await runClaude(call(program(`process.exit(0);`), { input: "x".repeat(2_000_000) }));
    expect(res.code).toBe(0);
  });

  it("works with askCli end to end: a program that answers like claude -p does", async () => {
    const bin = program(`process.stdin.resume(); process.stdin.on("end", () => { console.log(JSON.stringify({ type: "system", subtype: "init" })); console.log(JSON.stringify(${JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "tool_use", structured_output: answer })})); });`);
    expect(await askCli({ model: "m", system: "s", schema: {}, content: [{ type: "text", text: "hi" }] }, { PATH: process.env.PATH ?? "", FOOD_AI_CLAUDE_BIN: bin } as NodeJS.ProcessEnv)).toEqual({ stop: "ok", answer });
  });
});
