// eslint-disable-next-line @typescript-eslint/no-var-requires
const SM = require("../web/public/settingsModel.js");

const NOW = Date.parse("2026-10-18T15:00:00");
const view = (over: any = {}) => ({
  account: { email: "a@b.c", hasPassword: true },
  settings: { fetchEnabled: true, intervalHours: 3 },
  state: { running: false, error: null, errorKind: null, lastOkAt: NOW - 600_000 },
  ...over,
});

describe("times", () => {
  it("says how long ago or from now", () => {
    expect(SM.ago(null, NOW)).toBe("never");
    expect(SM.ago(NOW - 10_000, NOW)).toBe("just now");
    expect(SM.ago(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(SM.ago(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(SM.ago(NOW - 2 * 86_400_000, NOW)).toBe("2 d ago");
    expect(SM.until(null, NOW)).toBe("–");
    expect(SM.until(NOW - 1, NOW)).toBe("due now");
    expect(SM.until(NOW + 90 * 60_000, NOW)).toBe("in 2 h");
    expect(SM.until(NOW + 20 * 60_000, NOW)).toBe("in 20 min");
  });

  it("says a time as a date and minutes", () => {
    expect(SM.stamp(new Date(2026, 9, 18, 7, 5).getTime())).toBe("2026-10-18 07:05");
  });
});

describe("the state of the sync", () => {
  it("is told in a few words, most urgent first", () => {
    expect(SM.renphoStatus(view({ account: null }), NOW)).toEqual({ label: "No login", cls: "" });
    expect(SM.renphoStatus(view({ state: { running: true } }), NOW).label).toBe("Running");
    expect(SM.renphoStatus(view({ state: { errorKind: "login", error: "x", running: false } }), NOW)).toEqual({ label: "Login refused", cls: "err" });
    expect(SM.renphoStatus(view({ state: { errorKind: "other", error: "x", running: false } }), NOW)).toEqual({ label: "Last run failed", cls: "warn" });
    expect(SM.renphoStatus(view({ settings: { fetchEnabled: false } }), NOW)).toEqual({ label: "Off", cls: "" });
    expect(SM.renphoStatus(view(), NOW)).toEqual({ label: "On, every 3 h", cls: "ok" });
    expect(SM.renphoStatus(view({ state: { lastOkAt: null, running: false } }), NOW).label).toBe("On, waiting for the first run");
  });
});

describe("a weigh-in", () => {
  const m = { fields: { weight: 81.7, bodyfat: 17.8456, water: null, muscle: "44.5", bone: undefined, weightUnit: 1 }, pushedAt: null, pushError: null };

  it("reads each number as Renpho sent it, an en dash for what it did not send", () => {
    const by = (key: string) => SM.FIELDS.find((f: any) => f.key === key);
    expect(SM.cell(m, by("weight"))).toBe("81.7");
    expect(SM.cell(m, by("bodyfat"))).toBe("17.85");
    expect(SM.cell(m, by("water"))).toBe("–");
    expect(SM.cell(m, by("muscle"))).toBe("44.5");
    expect(SM.cell(m, by("bone"))).toBe("–");
  });

  it("says where it stands with Garmin", () => {
    expect(SM.uploadState(m)).toEqual({ label: "not uploaded", cls: "" });
    expect(SM.uploadState({ ...m, pushError: "no" })).toEqual({ label: "failed", cls: "err" });
    expect(SM.uploadState({ ...m, pushedAt: 5, pushError: "old" })).toEqual({ label: "on Garmin", cls: "ok" });
  });
});

describe("the web sign-in password typed twice", () => {
  it("accepts two equal passwords of enough characters", () => {
    expect(SM.passwordProblem("long enough", "long enough")).toBe("");
    expect(SM.passwordProblem("12345678", "12345678")).toBe("");
  });

  it("says what is wrong: nothing typed, too short, or two fields that differ", () => {
    expect(SM.passwordProblem("", "")).toBe("Enter a password.");
    expect(SM.passwordProblem("short", "short")).toBe(`The password is at least ${SM.MIN_PASSWORD} characters.`);
    expect(SM.passwordProblem("long enough", "long enougH")).toBe("The two passwords are not the same.");
    expect(SM.passwordProblem("long enough", "")).toBe("The two passwords are not the same.");
  });

  it("checks a new profile's name first, then its password", () => {
    expect(SM.profileProblem("SAM", "long enough", "long enough")).toBe("");
    expect(SM.profileProblem(" Sam_2-b ", "long enough", "long enough")).toBe("");
    expect(SM.profileProblem("a b", "long enough", "long enough")).toMatch(/letters, numbers, hyphens and underscores/);
    expect(SM.profileProblem("", "long enough", "long enough")).toMatch(/letters, numbers/);
    expect(SM.profileProblem("SAM", "long enough", "nope")).toBe("The two passwords are not the same.");
  });
});

describe("the goals form", () => {
  const fields = [{ key: "kcal", label: "Calories" }, { key: "proteinG", label: "Protein" }, { key: "sodiumMg", label: "Sodium" }];

  it("sends the numbers typed, takes a comma for a point, and removes a goal whose field was emptied", () => {
    expect(SM.goalsPatch({ kcal: "2200", proteinG: " 140,5 ", sodiumMg: "" }, fields, { kcal: 2000, sodiumMg: 2300 })).toEqual({ goals: { kcal: 2200, proteinG: 140.5, sodiumMg: null } });
  });

  it.each([
    ["2000", 2000], ["2,000", 2000], ["12,345", 12345], ["1,234,567", 1234567], ["2 000", 2000], ["2\u00a0000", 2000], ["2'000", 2000],
    ["150,5", 150.5], ["1,5", 1.5], ["0,500", 0.5], ["1.234,5", 1234.5], ["1,234.5", 1234.5], ["150.5", 150.5], [" 70 ", 70],
  ])("reads %s as %d: a comma before three digits groups thousands, else it is a decimal comma", (text, n) => {
    expect(SM.goalNumber(text)).toBe(n);
  });

  it.each([[""], ["abc"], ["2,00,0x"], ["1e999"]])("does not read %j as a number", (text) => {
    expect(Number.isFinite(SM.goalNumber(text))).toBe(false);
  });

  it("saves a calorie goal typed with a thousands comma as that many calories, and compares the macros against it", () => {
    expect(SM.goalsPatch({ kcal: "2,000", proteinG: "150,5" }, fields, {})).toEqual({ goals: { kcal: 2000, proteinG: 150.5 } });
    expect(SM.macroGoalsNote({ proteinG: "130", carbsG: "250", fatG: "70", kcal: "2,000" })).toBe(`Protein, carbs and fat add up to ${(2150).toLocaleString()} kcal, 8 % above the calorie goal of ${(2000).toLocaleString()}.`);
  });

  it("leaves out an empty field that has no goal: nothing to remove", () => {
    expect(SM.goalsPatch({ kcal: "", proteinG: "", sodiumMg: "" }, fields, {})).toEqual({ goals: {} });
    expect(SM.goalsPatch({}, fields, { kcal: 2000 })).toEqual({ goals: { kcal: null } });
  });

  it("sends the share of the burn only with a calorie goal, and removes it when it is emptied (turned off)", () => {
    const withBurn = [...fields.slice(0, 1), { key: "kcalBurnPct", label: "Share of active calories" }, ...fields.slice(1)];
    expect(SM.goalsPatch({ kcal: "2200", kcalBurnPct: "50" }, withBurn, {})).toEqual({ goals: { kcal: 2200, kcalBurnPct: 50 } });
    expect(SM.goalsPatch({ kcal: "2200", kcalBurnPct: "" }, withBurn, { kcal: 2200, kcalBurnPct: 50 })).toEqual({ goals: { kcal: 2200, kcalBurnPct: null } });
    expect(SM.goalsPatch({ kcal: "2200", kcalBurnPct: "" }, withBurn, { kcal: 2200 })).toEqual({ goals: { kcal: 2200 } });
    expect(SM.goalsPatch({ kcal: "", kcalBurnPct: "50" }, withBurn, {})).toEqual({ error: "Set a calorie goal to add the burned calories to." });
    expect(SM.goalsPatch({ kcal: "2200", kcalBurnPct: "150" }, withBurn, {})).toEqual({ error: "The share of the active calories added to the calorie goal is at most 100 %." });
  });

  it.each([["abc"], ["0"], ["-5"], ["1e999"]])("says what is wrong with %s", (text) => {
    expect(SM.goalsPatch({ kcal: "2000", proteinG: text }, fields, {})).toEqual({ error: "Protein must be a number above 0, or empty for no goal." });
  });

  it("compares the macros' calories with the calorie goal once all three macros are typed", () => {
    expect(SM.macroGoalsNote({ proteinG: "140", carbsG: "250" })).toBe("");
    expect(SM.macroGoalsNote({ proteinG: "140", carbsG: "250", fatG: "70" })).toBe(`Protein, carbs and fat add up to ${(2190).toLocaleString()} kcal.`);
    expect(SM.macroGoalsNote({ kcal: "2200", proteinG: "140", carbsG: "250", fatG: "70" })).toBe("Protein, carbs and fat add up to 2,190 kcal, in line with the calorie goal.".replace("2,190", (2190).toLocaleString()));
    expect(SM.macroGoalsNote({ kcal: "1800", proteinG: "140", carbsG: "250", fatG: "70" })).toBe(`Protein, carbs and fat add up to ${(2190).toLocaleString()} kcal, 22 % above the calorie goal of ${(1800).toLocaleString()}.`);
    expect(SM.macroGoalsNote({ kcal: "2600", proteinG: "140", carbsG: "250", fatG: "70" })).toMatch(/16 % below the calorie goal/);
  });
});

describe("the overview of the Settings view", () => {
  const NM = require("../web/public/nutritionModel.js");
  const NOW = 10 * 3_600_000;
  const base = (over: any = {}) => ({
    garmin: { connected: false, email: null, hasPassword: false, check: null },
    web: { hasPassword: true },
    renpho: { account: null, settings: {}, state: {} },
    encryption: { enabled: true, plain: 0 },
    goals: { values: {}, fields: [] },
    ...over,
  });

  it("says how the Garmin login stands: none, saved and untested, accepted, refused, unreadable, mock", () => {
    expect(SM.garminState({ connected: false }, false, NOW).label).toBe("Not connected");
    expect(SM.garminState({ connected: true, email: "a@b.c", check: null }, false, NOW)).toMatchObject({ label: "Connected", tone: "" });
    expect(SM.garminState({ connected: true, email: "a@b.c", check: { ok: true, message: "", at: NOW - 2 * 3_600_000 } }, false, NOW)).toMatchObject({ tone: "ok", text: "a@b.c: accepted 2 h ago." });
    expect(SM.garminState({ connected: true, email: "a@b.c", check: { ok: false, message: "Bad password", at: NOW - 60_000 } }, false, NOW)).toMatchObject({ label: "Login refused", tone: "err" });
    expect(SM.garminState({ connected: true, email: null, error: "no key" }, false, NOW)).toMatchObject({ label: "Key unreadable", tone: "err" });
    expect(SM.garminState({ connected: true, email: "a@b.c", check: null }, true, NOW).label).toBe("Mock mode");
  });

  it("is all clear when nothing is wrong, and lists what needs attention, each with where to fix it", () => {
    expect(SM.overview(base(), { mock: false }, NOW)).toMatchObject({ ok: true, headline: "Everything is set up", items: [] });
    const d = base({
      garmin: { connected: true, email: "a@b.c", check: { ok: false, message: "x", at: NOW } },
      renpho: { account: { email: "r@b.c" }, settings: {}, state: { error: "boom", errorKind: "other" } },
      encryption: { enabled: false, plain: 3 },
    });
    const o = SM.overview(d, { mock: false }, NOW);
    expect(o.headline).toBe("3 things need attention");
    expect(o.worst).toBe("err");
    expect(o.items.map((i: any) => [i.key, i.fix.section])).toEqual([["garmin", "connections"], ["renpho", "connections"], ["plain", "signin"]]);
    expect(SM.overview(base({ web: { hasPassword: false } }), { mock: false }, NOW).items[0]).toMatchObject({ key: "web", tone: "warn" });
    expect(SM.overview(base({ encryption: { enabled: true, plain: 1 } }), {}, NOW).headline).toBe("1 thing needs attention");
  });

  it("tells the Food AI and the sign-in apart in their tiles", () => {
    expect(SM.aiTile({ enabled: true, backend: "gemini", remaining: 14, limit: 20 })).toMatchObject({ label: "Gemini", text: "14 of 20 estimates left today" });
    expect(SM.aiTile({ enabled: false, backend: null, remaining: 0, limit: 20 }).label).toBe("Off");
    expect(SM.signinTile(base({ encryption: { enabled: false, plain: 2 } }))).toMatchObject({ tone: "warn", text: "2 saved passwords are still plain text." });
    expect(SM.signinTile(base({ web: { hasPassword: false } })).label).toBe("No password");
  });

  it("counts and lists the food goals, leaving out the burn share and the weight", () => {
    const goals = { values: { kcal: 2400, proteinG: 150, kcalBurnPct: 50, weightKg: 80 }, fields: [{ key: "kcal", label: "Calories", unit: "kcal" }, { key: "proteinG", label: "Protein", unit: "g" }, { key: "kcalBurnPct", kind: "burn" }, { key: "weightKg", kind: "weight" }] };
    expect(SM.goalCount(goals)).toBe(2);
    expect(SM.goalChips(goals).map((c: any) => c.key)).toEqual(["kcal", "proteinG"]);
  });

  it("previews a sample day against the goals with the Food view's tolerance, and works the burn example", () => {
    expect(SM.previewDay({ kcal: 2400, proteinG: 150 }, 0.5)).toMatchObject({ left: 1200, rows: [{ label: "Calories", amount: 1200, state: "short" }, { label: "Protein", amount: 75 }] });
    expect(SM.previewDay({ kcal: 2000 }, 1.05).rows[0].state).toBe("ok");
    expect(SM.previewDay({ kcal: 2000 }, 1.2).rows[0].state).toBe("over");
    expect(SM.previewDay({}, 0.5)).toEqual({ rows: [], left: null });
    expect(SM.burnExample({ kcal: 2600, kcalBurnPct: 50 })!.text).toBe(`${(2600).toLocaleString()} + 50 % × 800 = ${(3000).toLocaleString()} kcal`);
    expect(SM.burnExample({ kcal: 2600 })).toBeNull();
    const justOver = 1 + NM.TARGET_TOLERANCE + 0.001, onEdge = 1 + NM.TARGET_TOLERANCE - 0.001;
    expect(SM.previewDay({ kcal: 2000 }, justOver).rows[0].state).toBe("over");
    expect(SM.previewDay({ kcal: 2000 }, onEdge).rows[0].state).toBe("ok");
  });

  it("checks the new password as it is typed", () => {
    expect(SM.passwordChecklist("short", "short")).toEqual([{ ok: false, text: "At least 8 characters" }, { ok: true, text: "Both typed the same" }]);
    expect(SM.passwordChecklist("longenough", "different")).toEqual([{ ok: true, text: "At least 8 characters" }, { ok: false, text: "Both typed the same" }]);
    expect(SM.passwordChecklist("", "")[1].ok).toBe(false);
  });
});

describe("setting an assistant up with the MCP server", () => {
  it("names the server after the profile, in a form every client takes", () => {
    expect(SM.mcpServerName("MED")).toBe("garmin-med");
    expect(SM.mcpServerName("Marc_Étienne 2")).toBe("garmin-marc-tienne-2");
    expect(SM.mcpServerName("___")).toBe("garmin-editor");
    expect(SM.mcpServerName(undefined)).toBe("garmin-editor");
  });

  it("writes the connector address, the Claude Code command and the config entry", () => {
    const [connector, code, json] = SM.mcpSnippets({ url: "https://mcp.example.com", token: "gwm_abc", profile: "MED" });
    expect(connector).toMatchObject({ id: "connector", text: "https://mcp.example.com/mcp/gwm_abc" });
    expect(code).toMatchObject({ id: "code", text: 'claude mcp add --transport http garmin-med https://mcp.example.com/mcp --header "Authorization: Bearer gwm_abc"' });
    expect(JSON.parse(json.text)).toEqual({ mcpServers: { "garmin-med": { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer gwm_abc" } } } });
  });

  it("puts a placeholder where the address or the token is not known", () => {
    const [connector, code] = SM.mcpSnippets({ url: null, token: null, profile: "MED" });
    expect(connector.text).toBe("https://<your-mcp-host>/mcp/<your-token>");
    expect(code.text).toContain("Bearer <your-token>");
    expect(SM.mcpSnippets({ url: "http://10.0.0.2:8787", token: null, profile: "MED" })[0].text).toBe("http://10.0.0.2:8787/mcp/<your-token>");
  });

  it("says when a token was made and used", () => {
    expect(SM.mcpTokenLine({ createdAt: NOW - 2 * 86_400_000, lastUsedAt: null }, NOW)).toBe("Made 2 d ago; not used yet.");
    expect(SM.mcpTokenLine({ createdAt: NOW - 2 * 86_400_000, lastUsedAt: NOW - 3 * 3_600_000 }, NOW)).toBe("Made 2 d ago; last used 3 h ago.");
  });
});
