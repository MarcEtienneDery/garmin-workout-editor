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
  /** The intensity minutes of a day as Garmin counts them toward its goal (a vigorous minute twice); null when the day has none stored. */
  const intensityMinutes = (d) => (valid(d.moderateMinutes) || valid(d.vigorousMinutes) ? (valid(d.moderateMinutes) ? d.moderateMinutes : 0) + 2 * (valid(d.vigorousMinutes) ? d.vigorousMinutes : 0) : null);

  /**
   * The mean of a day's value and the `size - 1` days before it, over the days that have one (a day with nothing stored is
   * unknown, not zero, so it does not pull the mean down); null on a day that has none itself.
   */
  function rollingMean(days, i, size, value) {
    if (!days[i] || !valid(value(days[i]))) return null;
    const seen = days.slice(Math.max(0, i - size + 1), i + 1).map(value).filter(valid);
    return seen.reduce((a, b) => a + b, 0) / seen.length;
  }

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
      id: "intensity", title: "Intensity minutes", unit: "", kind: "stack", min: 0, scaleBy: 1,
      parts: [{ key: "moderateMinutes", label: "Moderate", cls: "moderate" }, { key: "vigorousMinutes", label: "Vigorous (counts twice)", cls: "vigorous", weight: 2 }],
      ref: { label: "3-day average", value: (d, i, days) => (days ? rollingMean(days, i, 3, intensityMinutes) : null) },
      read: (d, i, days) => {
        const total = intensityMinutes(d);
        if (total === null) return "–";
        const moderate = valid(d.moderateMinutes) ? d.moderateMinutes : 0, vigorous = valid(d.vigorousMinutes) ? d.vigorousMinutes : 0;
        const avg = days ? rollingMean(days, i, 3, intensityMinutes) : null;
        // the average before the split: a narrow card cuts the end of the line
        return `${num(total)} min${avg === null ? "" : ` · 3-day average ${num(avg)}`} · ${num(moderate)} moderate, ${num(vigorous)} vigorous`;
      },
    },
  ];

  // ── The verdict ─────────────────────────────────────────────────────────

  /**
   * Where the score's zones start (the score is 50 + 50 × the weighted mean of the signals, so these are the server's thresholds in
   * src/shared/readiness.ts, BACK_OFF_AT -0.25 and GO_HARDER_AT 0.4, which a test compares): a score under 37.5 is Back off, from 70 Go harder.
   */
  const BACK_OFF_SCORE = 37.5, GO_HARDER_SCORE = 70;
  /** The signals that must be at normal or better for Go harder. */
  const CORE = ["hrv", "restingHr", "sleep"];
  const SIGNAL_NAMES = { hrv: "HRV", restingHr: "Resting heart rate", sleep: "Sleep", bodyBattery: "Body Battery", stress: "Stress yesterday", load: "Training load" };
  const signalName = (key) => SIGNAL_NAMES[key] || key;
  const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

  /** The zone a score is in: "back", "plan" or "go"; "" when there is no score. */
  const zoneOf = (score) => (!valid(score) ? "" : score < BACK_OFF_SCORE ? "back" : score >= GO_HARDER_SCORE ? "go" : "plan");

  /**
   * The seven days of the week the day shown is in, Monday first, for the strip: each with its score and band (`zone`: back, plan, go, or
   * none when the day cannot be judged; future for a day to come), its weekday and number, whether it is today or the day shown, and the
   * words a screen reader says. `data` is what GET /api/wellness sends ({ week, date, today }).
   */
  function weekStrip(data) {
    if (!data || !Array.isArray(data.week)) return [];
    return data.week.map((w) => {
      const wd = new Date(msOf(w.day)).getUTCDay(), future = w.day > data.today;
      const zone = future ? "future" : valid(w.score) ? BANDS[w.band] ? BANDS[w.band].cls : "" : "none";
      const info = bandInfo(w.band), name = zone === "future" || zone === "none" ? "" : info.label.toLowerCase();
      const when = `${DOW[wd]} ${Number(w.day.slice(8, 10))} ${MON[Number(w.day.slice(5, 7)) - 1]}`;
      return {
        day: w.day, weekday: DOW[wd], number: Number(w.day.slice(8, 10)), band: w.band, score: valid(w.score) ? w.score : null, zone, name,
        text: valid(w.score) && !future ? String(w.score) : "–", today: w.day === data.today, selected: w.day === data.date,
        label: `${when}, ${future ? "not yet" : valid(w.score) ? `${name}, ${w.score} of 100` : "no verdict"}`,
      };
    });
  }

  /**
   * What the gauge draws: the score's place on the half circle (0 to 1), the three zones with where each ends, and the one the score is in.
   * Null when the day has no score.
   */
  function gauge(readiness) {
    if (!readiness || !valid(readiness.score)) return null;
    const score = Math.max(0, Math.min(100, readiness.score));
    return {
      score: readiness.score, at: score / 100, zone: zoneOf(readiness.score),
      zones: [{ cls: "back", from: 0, to: BACK_OFF_SCORE }, { cls: "plan", from: BACK_OFF_SCORE, to: GO_HARDER_SCORE }, { cls: "go", from: GO_HARDER_SCORE, to: 100 }],
      label: `Score ${readiness.score} of 100, in the ${bandInfo(readiness.band).label} zone`,
    };
  }

  /** Words and emphasis for a line: [{ text, strong }], so the page puts them in without building HTML. */
  const seg = (text, strong = false) => ({ text, strong });

  /** "HRV, resting heart rate and sleep" for the names of some core signals. */
  const nameList = (keys) => {
    const names = keys.map((k, i) => (i === 0 ? signalName(k) : lower(signalName(k))));
    return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  };

  /**
   * What it would take to be in another band, as a line the page shows under the verdict: segments of words, some strong. Go harder needs a
   * score of 70 and HRV, resting heart rate and sleep at normal or better (and not a low confidence); Back off is under 37.5 or an HRV well
   * below its range, whatever the rest says. Empty when the day cannot be judged.
   */
  function changeLine(readiness) {
    if (!readiness || !valid(readiness.score) || !Array.isArray(readiness.signals)) return [];
    const { band, score, signals, confidence } = readiness;
    const below = signals.filter((s) => CORE.includes(s.name) && s.score < 0).map((s) => s.name);
    const hrvLow = signals.some((s) => s.name === "hrv" && s.score <= -2);
    const toGo = Math.ceil(GO_HARDER_SCORE - score), toBack = score - (Math.ceil(BACK_OFF_SCORE) - 1); // Back off is a score of 37 or less
    if (band === "go-harder") {
      return [seg("Holding Go harder", true), seg(` takes a score of ${GO_HARDER_SCORE} or more and ${nameList(CORE)} all at normal or better. One hard session, then it reads the load again.`)];
    }
    if (band === "back-off") {
      const byScore = score < BACK_OFF_SCORE, out = [];
      if (hrvLow) out.push(seg("HRV well below your range", true), seg(" sets Back off whatever the rest says. "));
      out.push(seg("As planned", true), seg(` comes back${byScore ? ` at a score of ${Math.ceil(BACK_OFF_SCORE)} (${Math.ceil(BACK_OFF_SCORE) - score} more)` : ""}${hrvLow ? `${byScore ? " once" : " when"} HRV is back in your range` : ""}.`));
      return out;
    }
    const out = [seg("Go harder", true)];
    if (toGo > 0) out.push(seg(` needs a score of ${GO_HARDER_SCORE} (${toGo} more)${below.length || confidence === "low" ? "" : " with HRV, resting heart rate and sleep at normal or better"}`));
    else out.push(seg(below.length || confidence === "low" ? ` needs more than the score (it is enough at ${score})` : ` is within reach: the score is enough at ${score}`));
    if (below.length) out.push(seg(`${toGo > 0 ? ", and " : ": "}${lower(nameList(below))} ${below.length === 1 ? "has" : "have"} to reach normal`));
    if (confidence === "low") out.push(seg(`${toGo > 0 || below.length ? ", and " : ": "}more signals are needed to be sure`));
    out.push(seg(". "), seg("Back off", true), seg(` starts under ${Math.ceil(BACK_OFF_SCORE)} (${toBack} less), or if HRV falls well below your range.`));
    return out;
  }

  /** The five steps of a signal's meter, worst first: which one the signal is on ("on"), and its class. */
  function signalMeter(signal) {
    const score = Math.max(-2, Math.min(2, Math.round(signal.score)));
    return { steps: [-2, -1, 0, 1, 2].map((s) => s === score), pip: pip(score), label: `${signalName(signal.name)}: ${["well below", "below", "at", "above", "well above"][score + 2]} your normal` };
  }

  /** The rows of the signals of the day: its name and value, the meter, the reason and the baseline; the signal that counts most is marked. */
  function signalRows(readiness) {
    if (!readiness || !Array.isArray(readiness.signals)) return [];
    const top = Math.max(0, ...readiness.signals.map((s) => s.weight || 0));
    return readiness.signals.map((s) => ({ key: s.name, name: signalName(s.name), value: s.value, reason: s.reason, baseline: s.baseline, score: s.score, meter: signalMeter(s), most: top > 0 && s.weight === top && readiness.signals.some((o) => o.weight < top) }));
  }

  /** What the day left out, as a line ("Not counted: HRV: no HRV for the night."); "" when everything was counted. */
  function notCounted(readiness) {
    if (!readiness || !Array.isArray(readiness.missing) || !readiness.missing.length) return "";
    return "Not counted: " + readiness.missing.map((m) => m.replace(/^(\w+): /, (_, k) => `${signalName(k)}: `)).join("; ") + ".";
  }

  /**
   * The load before the day as bars: the sessions (units against the usual) and Garmin's intensity minutes against theirs, each a fill on a
   * track that is twice the usual, a tick at the usual, and a `cls` for how heavy (light up to 70 % of the usual, heavy from 130 %, very from
   * 160 %, as the server scores them). Null without a load.
   */
  function loadBars(readiness) {
    const l = readiness && readiness.load;
    if (!l) return null;
    const kind = (ratio) => (!valid(ratio) ? "usual" : ratio >= 1.6 ? "veryheavy" : ratio >= 1.3 ? "heavy" : ratio <= 0.7 ? "light" : "usual");
    const bar = (label, value, ratio, usual) => ({ label, value, ratio: valid(ratio) ? ratio : null, pct: valid(ratio) ? Math.round(ratio * 100) : null, fill: valid(ratio) ? Math.min(100, (ratio / 2) * 100) : null, cls: kind(ratio), usual: valid(usual) ? `usual ${num(usual)}` : "no usual to compare with yet" });
    const bars = [bar(`Last 3 days · ${l.sessions} session${l.sessions === 1 ? "" : "s"}`, `${num(l.acute)} units`, l.ratio, l.usual)];
    if (l.intensity) bars.push(bar("Intensity minutes, last 3 days", `${num(l.intensity.acute)} min`, l.intensity.ratio, l.intensity.usual));
    return {
      bars, sessions: l.sessions,
      hard: valid(l.hoursSinceHard) ? `${num(Math.round(l.hoursSinceHard))} h ago` : "none in 3 days",
    };
  }

  /** What was slept last night, for its card: the time, the score, the stages as shares of the stages, and how much of the need it was; null with no sleep stored. */
  function sleepCard(day) {
    if (!day || !valid(day.sleepSeconds) || day.sleepSeconds <= 0) return null;
    const parts = [["deep", "Deep", day.deepSeconds], ["rem", "REM", day.remSeconds], ["light", "Light", day.lightSeconds], ["awake", "Awake", day.awakeSeconds]].filter(([, , s]) => valid(s) && s > 0);
    const total = parts.reduce((a, p) => a + p[2], 0);
    const need = valid(day.sleepNeedMinutes) && day.sleepNeedMinutes > 0 ? day.sleepNeedMinutes * 60 : null;
    const pct = need ? Math.round((day.sleepSeconds / need) * 100) : null;
    return {
      time: hm(day.sleepSeconds), score: valid(day.sleepScore) ? day.sleepScore : null,
      stages: parts.map(([cls, label, s]) => ({ cls, label, text: hm(s), width: (s / total) * 100 })),
      pct, fill: pct === null ? null : Math.min(100, pct), cls: pct === null ? "" : pct >= 95 ? "ok" : pct >= 80 ? "warn" : "short", need: need ? (need % 3600 === 0 ? `${need / 3600} h` : hm(need)) : null,
      wakings: valid(day.awakeCount) ? day.awakeCount : null, stress: valid(day.sleepStress) ? day.sleepStress : null,
    };
  }

  // ── The readiness chart ──────────────────────────────────────────────────

  /** The days of a range with each one's readiness merged in (readinessScore, readinessBand), for the charts. */
  function chartDays(data) {
    const by = new Map(((data && data.readinessDays) || []).map((r) => [r.day, r]));
    return ((data && data.days) || []).map((d) => { const r = by.get(d.day); return { ...d, readinessScore: r && valid(r.score) ? r.score : null, readinessBand: r ? r.band : "unknown" }; });
  }

  /** A bar for each day's score, in the colour of its band, with the normal day (50) as the reference. */
  const READINESS_CHART = {
    id: "readiness", title: "Readiness", unit: "score", kind: "bars", min: 0, max: 100, ticks: 4, value: (d) => d.readinessScore,
    color: (d) => (valid(d.readinessScore) ? zoneOf(d.readinessScore) : ""), colorKeys: { back: "Back off", plan: "As planned", go: "Go harder" },
    goal: { value: 50, label: "A normal day, 50" },
    read: (d) => (valid(d.readinessScore) ? `${d.readinessScore} · ${bandInfo(d.readinessBand).label.toLowerCase()}` : "no verdict"),
  };
  /** The charts of the Trends: the readiness first, then the measures it is made of. */
  const TRENDS = [READINESS_CHART, ...CHARTS];

  return { intensityMinutes, rollingMean, addDays, dayLabel, shortDay, bandInfo, BANDS, pip, num, hm, hours, size, KINDS, compactJson, GROUPS, cell, niceStep, scale, stressClass, CHARTS, valid, BACK_OFF_SCORE, GO_HARDER_SCORE, SIGNAL_NAMES, signalName, zoneOf, weekStrip, gauge, changeLine, signalMeter, signalRows, notCounted, loadBars, sleepCard, chartDays, READINESS_CHART, TRENDS };
});
