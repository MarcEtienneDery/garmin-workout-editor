/*
 * welcomeModel.js — the logic of signing up with an invite and of the welcome flow a new profile is shown once (pure).
 *
 * Invite codes: how one is typed and shown (XXXX-XXXX-XXXX, any case, dashes or none), how a link carries it (/?invite=XXXX-XXXX-XXXX) and
 * how it is read back from the address, the checks the sign-up form makes before it asks, and how the admin's list words an invite's state.
 * The welcome flow: which steps a profile is taken through, and the goals its second step sets.
 * Loaded by the page as a plain script; the tests require() it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WelcomeModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CODE_LENGTH = 12;
  const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;

  /** What was typed or pasted as a code: upper case, letters and digits only, at most the twelve a code has. */
  const normalizeCode = (text) => String(text == null ? "" : text).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);

  /** A code as it is shown and typed back into the field: XXXX-XXXX-XXXX (a partial code gets the dashes it has reached). */
  const formatCode = (text) => normalizeCode(text).replace(/(.{4})(?=.)/g, "$1-");

  /** The code in an address's query string (`?invite=...`), shown as XXXX-XXXX-XXXX; "" when there is none. */
  function inviteFromSearch(search) {
    try { return formatCode(new URLSearchParams(search || "").get("invite")); } catch { return ""; }
  }

  /** The link that carries a code, for an origin such as https://plans.example.com. */
  const inviteLink = (origin, code) => `${String(origin).replace(/\/+$/, "")}/?invite=${formatCode(code)}`;

  /** What is wrong with the code in the sign-up form, in words for the person; "" when it can be sent. */
  function codeProblem(text) {
    const code = normalizeCode(text);
    if (!code) return "Enter the invite code.";
    if (code.length < CODE_LENGTH) return `The invite code is ${CODE_LENGTH} letters and digits.`;
    return "";
  }

  /** How long until `at`, in words ("6 days", "3 hours", "20 minutes"); "" when it has passed. */
  function left(at, now) {
    const ms = at - now;
    if (ms <= 0) return "";
    const n = (v, unit) => `${v} ${unit}${v === 1 ? "" : "s"}`;
    if (ms >= DAY) return n(Math.round(ms / DAY), "day");
    if (ms >= HOUR) return n(Math.round(ms / HOUR), "hour");
    return n(Math.max(1, Math.round(ms / MIN)), "minute");
  }

  /** What the admin's list says about an invite: a label and colour for its chip, and a line (uses, expiry, who joined). */
  function inviteState(invite, now) {
    const used = `${invite.uses} of ${invite.maxUses} used`;
    const who = invite.joined.length ? ` · ${invite.joined.join(", ")}` : "";
    if (invite.status === "revoked") return { label: "Cancelled", cls: "err", line: used + who };
    if (invite.status === "expired") return { label: "Expired", cls: "warn", line: used + who };
    if (invite.status === "used") return { label: "Used up", cls: "", line: used + who };
    const expiry = invite.expiresAt === null ? "never expires" : `${left(invite.expiresAt, now)} left`;
    return { label: "Active", cls: "ok", line: `${used} · ${expiry}${who}` };
  }

  /** The days an invite can be made to last, as the Settings form offers them (`days: null` never expires). */
  const EXPIRY_CHOICES = [
    { days: 1, label: "1 day" },
    { days: 7, label: "7 days" },
    { days: 30, label: "30 days" },
    { days: null, label: "Never" },
  ];

  /** Whether an invite can be copied or cancelled (it works now) rather than only forgotten. */
  const isActive = (invite) => invite.status === "active";

  /** The welcome flow's steps, in order. Garmin is offered unless the editor is in mock mode (Garmin writes are refused there). */
  function welcomeSteps(options) {
    const o = options || {};
    return ["welcome", "goals", ...(o.garmin === false ? [] : ["garmin"]), "start"];
  }

  /** The goals the welcome flow asks for: a calorie target and a protein minimum, both optional. */
  const GOAL_FIELDS = [
    { key: "kcal", label: "Calories" },
    { key: "proteinG", label: "Protein" },
  ];

  /** Where a profile can start from the last step: the view each choice opens. */
  const STARTS = [
    { id: "food", view: "food", title: "Log a meal", text: "Type what you ate, scan a barcode or take a photo." },
    { id: "plans", view: "plans", title: "Make a plan", text: "Write a training plan: workouts by day, sent to your watch if you connect Garmin." },
    { id: "today", view: "today", title: "Look around", text: "Today shows your workouts, food and health numbers at a glance." },
  ];

  return { CODE_LENGTH, normalizeCode, formatCode, inviteFromSearch, inviteLink, codeProblem, left, inviteState, EXPIRY_CHOICES, isActive, welcomeSteps, GOAL_FIELDS, STARTS };
});
