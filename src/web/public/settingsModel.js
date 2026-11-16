/*
 * settingsModel.js — the logic of the Settings view: how long ago or from now a time is, what state the Renpho sync is
 * in, how a weigh-in and a log line read.
 *
 * Pure functions on what GET /api/settings returns ({ garmin, web, renpho: { account, settings, state, counts, recent, log }, encryption }),
 * the checks of the web sign-in password typed twice (the server makes the same ones, in the same words), and the daily food goals form
 * (what it sends, and a note on how the macros' calories compare with the calorie goal).
 * Loaded by the page as a plain script; the tests require() it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SettingsModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  const unit = (ms) => (ms < HOUR ? `${Math.max(1, Math.round(ms / MIN))} min` : ms < DAY ? `${Math.round(ms / HOUR)} h` : `${Math.round(ms / DAY)} d`);

  /** "3 min ago", "2 h ago", "just now"; "never" when there is no time. */
  const ago = (at, now) => (at === null || at === undefined ? "never" : now - at < 45_000 ? "just now" : `${unit(now - at)} ago`);
  /** "in 2 h", "due now"; an en dash when there is no time. */
  const until = (at, now) => (at === null || at === undefined ? "–" : at <= now ? "due now" : `in ${unit(at - now)}`);

  /** The label and colour of the Renpho sync's state: a chip. */
  function renphoStatus(view, now) {
    const { account, settings, state } = view;
    if (!account) return { label: "No login", cls: "" };
    if (state.running) return { label: "Running", cls: "ok" };
    if (state.errorKind === "login") return { label: "Login refused", cls: "err" };
    if (state.error) return { label: "Last run failed", cls: "warn" };
    if (!settings.fetchEnabled) return { label: "Off", cls: "" };
    return state.lastOkAt ? { label: `On, every ${settings.intervalHours} h`, cls: "ok" } : { label: "On, waiting for the first run", cls: "warn" };
  }

  /** Where a weigh-in stands with Garmin. */
  const uploadState = (m) => (m.pushedAt ? { label: "on Garmin", cls: "ok" } : m.pushError ? { label: "failed", cls: "err" } : { label: "not uploaded", cls: "" });

  /** The numbers of a weigh-in the table lists, in the order and with the names Renpho uses, as Renpho sent them. */
  const FIELDS = [
    { key: "weight", label: "weight" }, { key: "bodyfat", label: "bodyfat" }, { key: "water", label: "water" }, { key: "muscle", label: "muscle" },
    { key: "bone", label: "bone" }, { key: "bmi", label: "bmi" }, { key: "visfat", label: "visfat" }, { key: "bodyage", label: "bodyage" }, { key: "bmr", label: "bmr" }, { key: "weightUnit", label: "unit" },
  ];
  const value = (v) => (v === null || v === undefined || v === "" ? "–" : typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v));
  const cell = (m, field) => value(m.fields[field.key]);

  /** "2026-10-18 14:05" from a time in milliseconds, in the browser's zone. */
  const stamp = (ms) => {
    const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  /** The fewest characters of a web sign-in password. */
  const MIN_PASSWORD = 8;

  /** What is wrong with a password typed in two fields, in words for the person; "" when it is fine. */
  function passwordProblem(password, confirm) {
    if (!password) return "Enter a password.";
    if (password.length < MIN_PASSWORD) return `The password is at least ${MIN_PASSWORD} characters.`;
    if (password !== confirm) return "The two passwords are not the same.";
    return "";
  }

  /** What is wrong with the form that adds a profile (a name, and the password twice); "" when it is fine. */
  function profileProblem(name, password, confirm) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(name).trim())) return "A profile name is letters, numbers, hyphens and underscores, at most 64.";
    return passwordProblem(password, confirm);
  }

  /**
   * The number typed in a goal field, NaN when it is not one. A comma is a thousands separator when three digits follow it and the figure
   * does not start with 0 ("2,000" is 2000, "1,234,567" too), else a decimal comma ("150,5"); with a comma and a point, the last of the two is
   * the decimal one ("1.234,5", "1,234.5"); spaces and apostrophes between digits group them ("2 000", "2'000").
   */
  function goalNumber(text) {
    let t = String(text == null ? "" : text).trim().replace(/[\s\u00a0\u202f']/g, "");
    if (t.includes(",") && t.includes(".")) {
      const comma = t.lastIndexOf(",") > t.lastIndexOf(".");
      t = comma ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
    } else if (/^[1-9]\d{0,2}(,\d{3})+$/.test(t)) t = t.replace(/,/g, "");
    else t = t.replace(",", ".");
    return t === "" ? NaN : Number(t);
  }

  /**
   * The patch to send for the goals form: `texts` holds what is typed in each field (by key), `fields` is what GET /api/settings lists, `current`
   * the goals now set. A field with a number sets that goal, an empty one removes the goal if there is one (null), else it is left out. Or
   * what is wrong ({ error }). The server checks the same and the upper limits.
   */
  function goalsPatch(texts, fields, current) {
    const goals = {};
    for (const f of fields) {
      const text = String(texts[f.key] == null ? "" : texts[f.key]).trim();
      if (!text) {
        if (current[f.key] !== undefined) goals[f.key] = null;
        continue;
      }
      const n = goalNumber(text);
      if (!Number.isFinite(n) || n <= 0) return { error: `${f.label} must be a number above 0, or empty for no goal.` };
      goals[f.key] = n;
    }
    if (typeof goals.kcalBurnPct === "number" && !(goalNumber(texts.kcal) > 0)) return { error: "Set a calorie goal to add the burned calories to." };
    if (typeof goals.kcalBurnPct === "number" && goals.kcalBurnPct > 100) return { error: "The share of the active calories added to the calorie goal is at most 100 %." };
    return { goals };
  }

  /** What the typed protein, carbs and fat goals add up to in calories (4, 4 and 9 a gram), against the calorie goal; "" until all three are typed. */
  function macroGoalsNote(texts) {
    const n = (key) => { const v = goalNumber(texts[key]); return Number.isFinite(v) && v > 0 ? v : null; };
    const [p, c, f, k] = [n("proteinG"), n("carbsG"), n("fatG"), n("kcal")];
    if (p === null || c === null || f === null) return "";
    const sum = Math.round(4 * p + 4 * c + 9 * f), base = `Protein, carbs and fat add up to ${sum.toLocaleString()} kcal`;
    if (k === null) return `${base}.`;
    const off = Math.round((Math.abs(sum - k) / k) * 100);
    return off <= 5 ? `${base}, in line with the calorie goal.` : `${base}, ${off} % ${sum > k ? "above" : "below"} the calorie goal of ${k.toLocaleString()}.`;
  }


  // ── The overview, the sections' state and the preview of the goals ─────────

  const when = (ms, now) => ago(ms, now);

  /**
   * How the Garmin login stands, for its tile and chip: { label, tone (ok / warn / err / ""), text }. `check` is what the last test of the login said
   * (null: never tested, or the login changed since); `mock` is mock mode, where nothing reaches Garmin.
   */
  function garminState(g, mock, now) {
    if (g.error) return { label: "Key unreadable", tone: "err", text: "The saved password is encrypted with a key this server does not have: set CREDENTIALS_KEY as it was, or connect Garmin again." };
    if (!g.connected) return { label: "Not connected", tone: "", text: "Optional: plans, the calendar, food and a Renpho scale work without it." };
    if (mock) return { label: "Mock mode", tone: "", text: "A mock Garmin answers: nothing is sent to the real one." };
    const c = g.check;
    if (!c) return { label: "Connected", tone: "", text: `${g.email || "A login"} is saved; it has not been tested since it was saved.` };
    return c.ok ? { label: "Connected", tone: "ok", text: `${g.email || "The login"}: accepted ${when(c.at, now)}.` } : { label: "Login refused", tone: "err", text: `${c.message || "Garmin refused the login."} (${when(c.at, now)}).` };
  }

  /** The sentence on the Renpho tile and its tone. */
  function renphoTile(view, now) {
    const s = renphoStatus(view, now);
    const last = view.state && view.state.lastOkAt ? `last weigh-in sync ${when(view.state.lastOkAt, now)}` : view.account ? "no run yet" : "";
    return { label: s.label, tone: s.cls, text: view.account ? `${view.account.email || "A login"}${last ? ` · ${last}` : ""}` : "Optional: weigh-ins from a Renpho scale." };
  }

  /** The Food AI tile: which AI answers, and how many estimates are left today. */
  function aiTile(ai) {
    if (!ai) return { label: "Unknown", tone: "", text: "" };
    if (!ai.enabled) return { label: "Off", tone: "", text: "No AI is set up for the Food view; the search, the barcode and typing by hand still work." };
    const name = ai.backend === "gemini" ? "Gemini" : ai.backend === "claude" || ai.backend === "cli" || ai.backend === "api" ? "Claude" : String(ai.backend || "AI");
    return { label: name, tone: "ok", text: `${ai.remaining} of ${ai.limit} estimates left today` };
  }

  /** The sign-in and storage tile: the password of the profile, and how the saved passwords are kept. */
  function signinTile(d) {
    const enc = d.encryption || { enabled: false, plain: 0 };
    if (!d.web.hasPassword) return { label: "No password", tone: "warn", text: "This profile cannot sign in on its own yet." };
    if (enc.plain) return { label: "Password set", tone: "warn", text: `${enc.plain} saved password${enc.plain === 1 ? " is" : "s are"} still plain text.` };
    return { label: "Password set", tone: "ok", text: enc.enabled ? "Saved passwords are encrypted." : "Saved passwords are kept as plain text (no CREDENTIALS_KEY)." };
  }

  /** What needs attention: { items: [{ key, tone, title, text, fix: { label, section } }], headline }. */
  function overview(d, ctx, now) {
    const items = [], g = garminState(d.garmin, ctx.mock, now), r = d.renpho, enc = d.encryption || { enabled: false, plain: 0 };
    if (g.tone === "err") items.push({ key: "garmin", tone: "err", title: g.label === "Login refused" ? "Garmin refused the login" : "The saved Garmin password cannot be read", text: g.label === "Login refused" ? "Sync, health data and sending workouts are stopped until it is fixed." : g.text, fix: { label: "Fix it", section: "connections" } });
    if (r && r.account && r.state) {
      if (r.state.errorKind === "login") items.push({ key: "renpho", tone: "err", title: "Renpho refused the login", text: "Weigh-ins are not fetched until the login is fixed.", fix: { label: "Fix it", section: "connections" } });
      else if (r.state.error) items.push({ key: "renpho", tone: "warn", title: "The last Renpho run failed", text: "It tries again by itself; the log says why.", fix: { label: "Open the log", section: "connections" } });
    }
    if (enc.plain) items.push({ key: "plain", tone: "warn", title: `${enc.plain} saved password${enc.plain === 1 ? " is" : "s are"} still plain text`, text: enc.enabled ? "They are encrypted the next time they are used." : "They are encrypted once CREDENTIALS_KEY is set and they are used again.", fix: { label: "How to fix", section: "signin" } });
    if (!d.web.hasPassword) items.push({ key: "web", tone: "warn", title: "This profile has no sign-in password", text: "It cannot sign in on its own until one is set.", fix: { label: "Set one", section: "signin" } });
    const n = items.length;
    return { items, headline: n ? `${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention` : "Everything is set up", ok: !n, worst: items.some((i) => i.tone === "err") ? "err" : n ? "warn" : "ok" };
  }

  /** The goals set, as chips: [{ key, value, unit, label }] for the Overview. The weight goal is not a food goal and is shown by the caller in its unit. */
  function goalChips(goals) {
    const v = goals.values || {}, out = [];
    for (const f of goals.fields || []) {
      if (f.kind === "burn" || f.kind === "weight" || v[f.key] === undefined) continue;
      out.push({ key: f.key, value: v[f.key], unit: f.unit, label: f.label });
    }
    return out;
  }

  /** The count of food goals set (the share of the burn and the weight are not food goals). */
  const goalCount = (goals) => Object.keys(goals.values || {}).filter((k) => k !== "kcalBurnPct" && k !== "weightKg").length;

  const TOLERANCE = 0.1; // the same 10 % that counts as on target in the Food view (nutritionModel.js TARGET_TOLERANCE)

  /**
   * A sample day against the calorie and macro goals, for the preview: what is eaten is `fraction` of the calorie goal (the macros in proportion
   * to their goals). Rows { label, amount, goal, pct (0 to 1), state: short / ok / over }.
   */
  function previewDay(values, fraction) {
    const rows = [];
    const add = (label, goal, unit) => { if (typeof goal === "number" && goal > 0) { const amount = Math.round(goal * fraction), pct = Math.min(1, fraction); rows.push({ label, amount, goal, unit, pct, state: fraction > 1 + TOLERANCE ? "over" : fraction >= 1 - TOLERANCE ? "ok" : "short" }); } };
    add("Calories", values.kcal, "kcal"); add("Protein", values.proteinG, "g"); add("Carbs", values.carbsG, "g"); add("Fat", values.fatG, "g");
    return { rows, left: typeof values.kcal === "number" ? Math.round(values.kcal * (1 - fraction)) : null };
  }

  /** The worked example for a calorie goal that follows the burn: { base, pct, active, total, text }, or null without both. */
  function burnExample(values, active = 800) {
    const base = values.kcal, pct = values.kcalBurnPct;
    if (typeof base !== "number" || typeof pct !== "number") return null;
    const total = Math.round(base + (pct / 100) * active);
    const n = (v) => v.toLocaleString();
    return { base, pct, active, total, text: `${n(base)} + ${pct} % × ${n(active)} = ${n(total)} kcal` };
  }

  /** The checklist beside the new password: [{ ok, text }]. */
  function passwordChecklist(password, confirm) {
    return [
      { ok: password.length >= MIN_PASSWORD, text: `At least ${MIN_PASSWORD} characters` },
      { ok: password.length > 0 && password === confirm, text: "Both typed the same" },
    ];
  }

  return { garminState, renphoTile, aiTile, signinTile, overview, goalChips, goalCount, previewDay, burnExample, passwordChecklist, goalsPatch, goalNumber, macroGoalsNote, ago, until, renphoStatus, uploadState, FIELDS, cell, stamp, MIN_PASSWORD, passwordProblem, profileProblem };
});
