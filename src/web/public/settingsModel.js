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
   * The patch to send for the goals form: `texts` holds what is typed in each field (by key), `fields` is what GET /api/settings lists, `current`
   * the goals now set. A field with a number sets that goal, an empty one removes the goal if there is one (null), else it is left out. Or
   * what is wrong ({ error }). The server checks the same and the upper limits.
   */
  function goalsPatch(texts, fields, current) {
    const goals = {};
    for (const f of fields) {
      const text = String(texts[f.key] == null ? "" : texts[f.key]).trim().replace(",", ".");
      if (!text) {
        if (current[f.key] !== undefined) goals[f.key] = null;
        continue;
      }
      const n = Number(text);
      if (!Number.isFinite(n) || n <= 0) return { error: `${f.label} must be a number above 0, or empty for no goal.` };
      goals[f.key] = n;
    }
    if (typeof goals.kcalBurnPct === "number" && !(Number(String(texts.kcal == null ? "" : texts.kcal).trim().replace(",", ".")) > 0)) return { error: "Set a calorie goal to add the burned calories to." };
    if (typeof goals.kcalBurnPct === "number" && goals.kcalBurnPct > 100) return { error: "The share of the active calories added to the calorie goal is at most 100 %." };
    return { goals };
  }

  /** What the typed protein, carbs and fat goals add up to in calories (4, 4 and 9 a gram), against the calorie goal; "" until all three are typed. */
  function macroGoalsNote(texts) {
    const n = (key) => { const v = Number(String(texts[key] == null ? "" : texts[key]).trim().replace(",", ".")); return Number.isFinite(v) && v > 0 ? v : null; };
    const [p, c, f, k] = [n("proteinG"), n("carbsG"), n("fatG"), n("kcal")];
    if (p === null || c === null || f === null) return "";
    const sum = Math.round(4 * p + 4 * c + 9 * f), base = `Protein, carbs and fat add up to ${sum.toLocaleString()} kcal`;
    if (k === null) return `${base}.`;
    const off = Math.round((Math.abs(sum - k) / k) * 100);
    return off <= 5 ? `${base}, in line with the calorie goal.` : `${base}, ${off} % ${sum > k ? "above" : "below"} the calorie goal of ${k.toLocaleString()}.`;
  }

  return { goalsPatch, macroGoalsNote, ago, until, renphoStatus, uploadState, FIELDS, cell, stamp, MIN_PASSWORD, passwordProblem, profileProblem };
});
