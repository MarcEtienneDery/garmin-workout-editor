/*
 * settingsModel.js — the logic of the Settings view: how long ago or from now a time is, what state the Renpho sync is
 * in, how a weigh-in and a log line read.
 *
 * Pure functions on what GET /api/settings returns ({ garmin, web, renpho: { account, settings, state, counts, recent, log }, encryption }),
 * and the checks of the web sign-in password typed twice (the server makes the same ones, in the same words).
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

  return { ago, until, renphoStatus, uploadState, FIELDS, cell, stamp, MIN_PASSWORD, passwordProblem, profileProblem };
});
