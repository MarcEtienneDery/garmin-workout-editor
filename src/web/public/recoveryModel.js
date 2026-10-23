/*
 * recoveryModel.js — the logic of the Recovery view: how a readiness band, a day, an hour count or a stored number is
 * said, the fields the daily table lists, the charts the view draws and the scale of each.
 *
 * Pure functions on what GET /api/wellness returns ({ date, readiness, days: [DayMetrics], baselines, stored, sync }).
 * The page loads this as a plain script before its own code and the tests require() it. Dates are YYYY-MM-DD strings,
 * never put through Date's own parser; the weekday goes through UTC milliseconds so a day never slips.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RecoveryModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY_MS = 86_400_000;
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const msOf = (iso) => Date.parse(iso + "T00:00:00Z");
  const valid = (v) => typeof v === "number" && Number.isFinite(v);

  const addDays = (iso, n) => new Date(msOf(iso) + n * DAY_MS).toISOString().slice(0, 10);
  /** "Mon 12 Oct". */
  const dayLabel = (iso) => `${DOW[new Date(msOf(iso)).getUTCDay()]} ${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;
  /** "12 Oct". */
  const shortDay = (iso) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;

  const BANDS = {
    "go-harder": { label: "Go harder", cls: "go" },
    "as-planned": { label: "As planned", cls: "plan" },
    "back-off": { label: "Back off", cls: "back" },
    unknown: { label: "Not enough data", cls: "unknown" },
  };
  const bandInfo = (band) => BANDS[band] || BANDS.unknown;

  /** The class of a signal's score, -2 (well below normal) to +2, for its dot. */
  const pip = (score) => (score <= -2 ? "m2" : score === -1 ? "m1" : score === 0 ? "z" : score === 1 ? "p1" : "p2");

  // ── Numbers ─────────────────────────────────────────────────────────────

  /** A number with its digits and unit, or an en dash when the day has none. */
  const num = (v, digits = 0, unit = "") => (valid(v) ? `${v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${unit}` : "–");
  /** Seconds as "7 h 24" (hours and minutes). */
  const hm = (seconds) => {
    if (!valid(seconds) || seconds <= 0) return "–";
    const m = Math.round(seconds / 60);
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
  };
  const hours = (seconds, digits = 1) => (valid(seconds) ? `${(seconds / 3600).toFixed(digits)} h` : "–");
  /** Bytes as "12 KB". */
  const size = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

  /** What is stored for a day, in the order the sync fetches it, with its name. */
  const KINDS = [
    { kind: "summary", label: "Daily summary" }, { kind: "sleep", label: "Sleep" }, { kind: "hrv", label: "HRV" }, { kind: "heart_rate", label: "Heart rate" },
    { kind: "stress", label: "Stress" }, { kind: "body_battery", label: "Body Battery" }, { kind: "respiration", label: "Respiration" }, { kind: "spo2", label: "SpO2" },
  ];

  /** Garmin's JSON as indented text with every list of plain numbers or words on one line, so a day's series do not run for pages. */
  const compactJson = (value) => JSON.stringify(value, null, 2).replace(/\[\s*([^[\]{}]*?)\s*\]/g, (_, inner) => `[${inner.replace(/\s*\n\s*/g, " ")}]`);

  // ── The fields of a day, as the table lists them ────────────────────────

  /** Every stored number of a day, in the groups the table shows; fmt says how a cell reads. */
  const GROUPS = [
    { name: "Sleep", fields: [
      { key: "sleepSeconds", label: "Slept", fmt: hm }, { key: "sleepScore", label: "Score" }, { key: "sleepNeedMinutes", label: "Need", fmt: (v) => hm(valid(v) ? v * 60 : null) },
      { key: "deepSeconds", label: "Deep", fmt: hm }, { key: "lightSeconds", label: "Light", fmt: hm }, { key: "remSeconds", label: "REM", fmt: hm }, { key: "awakeSeconds", label: "Awake", fmt: hm },
      { key: "awakeCount", label: "Wakings" }, { key: "sleepStress", label: "Sleep stress" },
    ] },
    { name: "HRV", fields: [
      { key: "hrvLastNight", label: "Last night", unit: " ms" }, { key: "hrvWeeklyAvg", label: "7-day avg", unit: " ms" }, { key: "hrvBalancedLow", label: "Balanced low", unit: " ms" },
      { key: "hrvBalancedHigh", label: "Balanced high", unit: " ms" }, { key: "hrvLowUpper", label: "Low below", unit: " ms" }, { key: "hrvStatus", label: "Status", text: true }, { key: "overnightHrv", label: "In sleep data", unit: " ms" },
    ] },
    { name: "Heart", fields: [{ key: "restingHr", label: "Resting", unit: " bpm" }, { key: "restingHr7d", label: "7-day avg", unit: " bpm" }] },
    { name: "Body Battery", fields: [
      { key: "bodyBatteryWake", label: "On waking" }, { key: "bodyBatteryHigh", label: "High" }, { key: "bodyBatteryLow", label: "Low" }, { key: "bodyBatteryCharged", label: "Charged" }, { key: "bodyBatteryDrained", label: "Drained" },
    ] },
    { name: "Stress", fields: [{ key: "avgStress", label: "Average" }, { key: "maxStress", label: "Max" }] },
    { name: "Day", fields: [{ key: "steps", label: "Steps" }, { key: "moderateMinutes", label: "Moderate min" }, { key: "vigorousMinutes", label: "Vigorous min" }] },
    { name: "Breathing", fields: [
      { key: "avgSleepRespiration", label: "In sleep", unit: " /min", digits: 1 }, { key: "avgWakingRespiration", label: "Awake", unit: " /min", digits: 1 },
      { key: "lowRespiration", label: "Lowest", unit: " /min", digits: 1 }, { key: "highRespiration", label: "Highest", unit: " /min", digits: 1 },
      { key: "avgSleepSpo2", label: "SpO2 in sleep", unit: "%" }, { key: "lowestSpo2", label: "Lowest SpO2", unit: "%" },
    ] },
  ];

  /** How one field of a day reads; text fields are shown as they are, in lower case. */
  function cell(field, day) {
    const v = day[field.key];
    if (field.fmt) return field.fmt(v);
    if (field.text) return typeof v === "string" && v ? v.toLowerCase().replace(/_/g, " ") : "–";
    return num(v, field.digits || 0, field.unit || "");
  }

  // ── Scales ──────────────────────────────────────────────────────────────

  /** A rounded step for a range split into about `count` parts. */
  function niceStep(range, count) {
    const raw = range / Math.max(1, count), mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
  }

  /**
   * The vertical scale for some values: rounded to a step, a little room around them, and `min` / `max` held when given.
   * Null when there are no values.
   */
  function scale(values, { min, max, include = [], pad = 0.1, count = 3 } = {}) {
    const xs = values.concat(include).filter(valid);
    if (!xs.length) return null;
    let lo = Math.min(...xs), hi = Math.max(...xs);
    if (hi === lo) { hi += 1; lo -= 1; }
    const room = (hi - lo) * pad;
    lo = valid(min) ? min : lo - room;
    hi = valid(max) ? max : hi + room;
    const step = niceStep(hi - lo, count);
    lo = valid(min) ? min : Math.floor(lo / step) * step;
    hi = valid(max) ? max : Math.ceil(hi / step) * step;
    const ticks = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi + step / 1e6; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
    return { min: lo, max: hi, ticks };
  }

  // ── The charts ──────────────────────────────────────────────────────────

  /** The stress levels Garmin names: 0-25 rest, 26-50 low, 51-75 medium, 76-100 high. */
  const stressClass = (v) => (!valid(v) ? "" : v <= 25 ? "s0" : v <= 50 ? "s1" : v <= 75 ? "s2" : "s3");

  /**
   * What the view draws, one entry per chart: kind line (with an optional band and reference line), stack (parts piled in
   * a bar), range (a low-high stroke with a dot) or bars. read(day) gives what the hover says.
   */
  const CHARTS = [
    {
      id: "hrv", title: "HRV overnight", unit: "ms", kind: "line", value: (d) => d.hrvLastNight, band: (d) => [d.hrvBalancedLow, d.hrvBalancedHigh], ref: { label: "7-day average", value: (d) => d.hrvWeeklyAvg },
      read: (d) => (valid(d.hrvLastNight) ? `${num(d.hrvLastNight)} ms${valid(d.hrvBalancedLow) && valid(d.hrvBalancedHigh) ? ` · balanced ${num(d.hrvBalancedLow)}–${num(d.hrvBalancedHigh)}` : ""}` : "–"),
    },
    {
      id: "rhr", title: "Resting heart rate", unit: "bpm", kind: "line", value: (d) => d.restingHr, ref: { label: "7-day average", value: (d) => d.restingHr7d },
      read: (d) => (valid(d.restingHr) ? `${num(d.restingHr)} bpm${valid(d.restingHr7d) ? ` · 7-day ${num(d.restingHr7d)}` : ""}` : "–"),
    },
    {
      id: "resp", title: "Breathing", unit: "/min", kind: "line", value: (d) => d.avgSleepRespiration, ref: { label: "Awake average", value: (d) => d.avgWakingRespiration },
      read: (d) => (valid(d.avgSleepRespiration) ? `${num(d.avgSleepRespiration, 1)} /min asleep${valid(d.avgWakingRespiration) ? ` · ${num(d.avgWakingRespiration, 1)} awake` : ""}` : "–"),
    },
    {
      id: "sleep", title: "Sleep", unit: "h", kind: "stack", min: 0,
      parts: [{ key: "deepSeconds", label: "Deep", cls: "deep" }, { key: "remSeconds", label: "REM", cls: "rem" }, { key: "lightSeconds", label: "Light", cls: "light" }, { key: "awakeSeconds", label: "Awake", cls: "awake" }],
      scaleBy: 3600, ref: { label: "Need", value: (d) => (valid(d.sleepNeedMinutes) ? d.sleepNeedMinutes / 60 : null) },
      read: (d) => (valid(d.sleepSeconds) ? `${hm(d.sleepSeconds)}${valid(d.sleepScore) ? ` · score ${num(d.sleepScore)}` : ""}` : "–"),
    },
    {
      id: "bb", title: "Body Battery", unit: "", kind: "range", min: 0, max: 100, low: (d) => d.bodyBatteryLow, high: (d) => d.bodyBatteryHigh, value: (d) => d.bodyBatteryWake,
      read: (d) => (valid(d.bodyBatteryWake) ? `${num(d.bodyBatteryWake)} on waking${valid(d.bodyBatteryLow) && valid(d.bodyBatteryHigh) ? ` · ${num(d.bodyBatteryLow)}–${num(d.bodyBatteryHigh)} over the day` : ""}` : "–"),
    },
    { id: "stress", title: "Stress", unit: "", kind: "bars", min: 0, max: 100, value: (d) => d.avgStress, color: (d) => stressClass(d.avgStress), read: (d) => (valid(d.avgStress) ? `average ${num(d.avgStress)}${valid(d.maxStress) ? ` · max ${num(d.maxStress)}` : ""}` : "–") },
    { id: "steps", title: "Steps", unit: "", kind: "bars", min: 0, value: (d) => d.steps, read: (d) => (valid(d.steps) ? `${num(d.steps)} steps` : "–") },
    {
      // as Garmin counts them toward its goal: a vigorous minute twice, so the bar is the day's total
      id: "intensity", title: "Intensity minutes", unit: "min", kind: "stack", min: 0, scaleBy: 1,
      parts: [{ key: "moderateMinutes", label: "Moderate", cls: "moderate" }, { key: "vigorousMinutes", label: "Vigorous (counts twice)", cls: "vigorous", weight: 2 }],
      read: (d) => {
        if (!valid(d.moderateMinutes) && !valid(d.vigorousMinutes)) return "–";
        const moderate = valid(d.moderateMinutes) ? d.moderateMinutes : 0, vigorous = valid(d.vigorousMinutes) ? d.vigorousMinutes : 0;
        return `${num(moderate + 2 * vigorous)} min · ${num(moderate)} moderate, ${num(vigorous)} vigorous`;
      },
    },
  ];

  return { addDays, dayLabel, shortDay, bandInfo, BANDS, pip, num, hm, hours, size, KINDS, compactJson, GROUPS, cell, niceStep, scale, stressClass, CHARTS, valid };
});
