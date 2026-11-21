(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WelcomeModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CODE_LENGTH = 12;
  const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;

  const normalizeCode = (text) => String(text == null ? "" : text).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);

  const formatCode = (text) => normalizeCode(text).replace(/(.{4})(?=.)/g, "$1-");

  function inviteFromSearch(search) {
    try { return formatCode(new URLSearchParams(search || "").get("invite")); } catch { return ""; }
  }

  const inviteLink = (origin, code) => `${String(origin).replace(/\/+$/, "")}/?invite=${formatCode(code)}`;

  function codeProblem(text) {
    const code = normalizeCode(text);
    if (!code) return "Enter the invite code.";
    if (code.length < CODE_LENGTH) return `The invite code is ${CODE_LENGTH} letters and digits.`;
    return "";
  }

  function left(at, now) {
    const ms = at - now;
    if (ms <= 0) return "";
    const n = (v, unit) => `${v} ${unit}${v === 1 ? "" : "s"}`;
    if (ms >= DAY) return n(Math.round(ms / DAY), "day");
    if (ms >= HOUR) return n(Math.round(ms / HOUR), "hour");
    return n(Math.max(1, Math.round(ms / MIN)), "minute");
  }

  function inviteState(invite, now) {
    const used = `${invite.uses} of ${invite.maxUses} used`;
    const who = invite.joined.length ? ` · ${invite.joined.join(", ")}` : "";
    if (invite.status === "revoked") return { label: "Cancelled", cls: "err", line: used + who };
    if (invite.status === "expired") return { label: "Expired", cls: "warn", line: used + who };
    if (invite.status === "used") return { label: "Used up", cls: "", line: used + who };
    const expiry = invite.expiresAt === null ? "never expires" : `${left(invite.expiresAt, now)} left`;
    return { label: "Active", cls: "ok", line: `${used} · ${expiry}${who}` };
  }

  const EXPIRY_CHOICES = [
    { days: 1, label: "1 day" },
    { days: 7, label: "7 days" },
    { days: 30, label: "30 days" },
    { days: null, label: "Never" },
  ];

  const isActive = (invite) => invite.status === "active";

  function welcomeSteps(options) {
    const o = options || {};
    return ["welcome", "goals", ...(o.garmin === false ? [] : ["garmin"]), "start"];
  }

  const GOAL_FIELDS = [
    { key: "kcal", label: "Calories" },
    { key: "proteinG", label: "Protein" },
  ];

  const STARTS = [
    { id: "food", view: "food", title: "Log a meal", text: "Type what you ate, scan a barcode or take a photo." },
    { id: "plans", view: "plans", title: "Make a plan", text: "Write a training plan: workouts by day, sent to your watch if you connect Garmin." },
    { id: "today", view: "today", title: "Look around", text: "Today shows your workouts, food and health numbers at a glance." },
  ];

  return { CODE_LENGTH, normalizeCode, formatCode, inviteFromSearch, inviteLink, codeProblem, left, inviteState, EXPIRY_CHOICES, isActive, welcomeSteps, GOAL_FIELDS, STARTS };
});
