/*
 * activityModel.js — the logic of the Activities view: rows into weeks, totals, filters, the number formats of a row,
 * and which planned workouts an activity answers (done) or leaves open (missed, upcoming).
 *
 * Pure functions on the rows GET /api/activities returns ({ id, date, time, type, name, km, seconds, paceSec, avgHr,
 * workoutId, ... }) and the plans GET /api/calendar returns. The page loads this as a plain script before its own code and
 * the tests require() it. Dates are YYYY-MM-DD strings and are never put through Date's own parser (Safari refuses
 * some forms); week arithmetic goes through UTC milliseconds so a day never slips.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ActivityModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY_MS = 86_400_000;
  const msOf = (iso) => Date.parse(iso + "T00:00:00Z");
  const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  const pad = (n) => String(n).padStart(2, "0");

  /** The Monday (YYYY-MM-DD) of the week a day is in. */
  function weekOf(iso) {
    const ms = msOf(iso);
    return isoOf(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS);
  }

  // ── Totals and weeks ─────────────────────────────────────────────────────

  /** Sessions, distance and time of some rows, and the same per sport. */
  function totals(rows) {
    const sum = { count: 0, km: 0, seconds: 0, bySport: {} };
    for (const r of rows) {
      const sport = (sum.bySport[r.type] = sum.bySport[r.type] || { count: 0, km: 0, seconds: 0 });
      for (const t of [sum, sport]) { t.count++; t.km += r.km || 0; t.seconds += r.seconds || 0; }
    }
    sum.km = Math.round(sum.km * 10) / 10;
    for (const t of Object.values(sum.bySport)) t.km = Math.round(t.km * 10) / 10;
    return sum;
  }

  /** Newest first: the later day, then the later start time. */
  const newestFirst = (a, b) => (a.date === b.date ? (b.time || "").localeCompare(a.time || "") : b.date.localeCompare(a.date));

  /** Rows grouped by week, newest week first, each week's rows newest first, with the week's totals. */
  function groupWeeks(rows) {
    const weeks = new Map();
    for (const r of [...rows].sort(newestFirst)) {
      const week = weekOf(r.date);
      if (!weeks.has(week)) weeks.set(week, []);
      weeks.get(week).push(r);
    }
    return [...weeks].map(([week, list]) => ({ week, rows: list, totals: totals(list) }));
  }

  /** Rows by day. */
  function byDate(rows) {
    const days = new Map();
    for (const r of [...rows].sort(newestFirst).reverse()) { // a day reads in the order it was lived
      if (!days.has(r.date)) days.set(r.date, []);
      days.get(r.date).push(r);
    }
    return days;
  }

  // ── Filters ──────────────────────────────────────────────────────────────

  /** The first day of a range ("4w", "12w", "1y", "all") counted back from today; null for all of it. */
  function rangeStart(range, today) {
    const back = { "4w": 28, "12w": 84, "1y": 365 }[range];
    return back ? isoOf(msOf(today) - back * DAY_MS) : null;
  }

  /** The rows of the chosen types (none chosen: all), from a day on, whose name holds the query. */
  function filterRows(rows, { types, query, from } = {}) {
    const q = (query || "").trim().toLowerCase();
    return rows.filter((r) => (!types || !types.size || types.has(r.type)) && (!from || r.date >= from) && (!q || r.name.toLowerCase().includes(q)));
  }

  // ── Formats ──────────────────────────────────────────────────────────────

  /** 3125 -> "52 min", 3900 -> "1 h 05 min", 45 -> "45 s" */
  function duration(seconds) {
    if (!seconds) return "";
    const s = Math.round(seconds);
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
  }

  /** 337 -> "5:37 /km" */
  const pace = (sec) => {
    if (!sec) return "";
    const t = Math.round(sec); // round first, so 299.6 s is 5:00 and not 4:60
    return `${Math.floor(t / 60)}:${pad(t % 60)} /km`;
  };

  /** 10.4 -> "10.4 km", 0.8 -> "800 m" */
  const distance = (km) => (km ? (km < 1 ? `${Math.round(km * 1000)} m` : `${+km.toFixed(1)} km`) : "");

  /** "08:30" -> "08:30"; kept as text, never parsed as a date */
  const clock = (time) => time || "";

  // ── Planned against done ─────────────────────────────────────────────────

  /** The sport an activity of a plan type is recorded as: cardio and anything unnamed are "other". */
  const planSport = (type) => ({ running: "running", strength_training: "strength_training", cycling: "cycling", swimming: "swimming" }[type] || "other");

  const sameId = (a, b) => a !== undefined && a !== null && a !== "" && b !== undefined && b !== null && b !== "" && String(a) === String(b);

  /**
   * The workouts the plans schedule, each with whether an activity answers it.
   * - One entry per session: plans that schedule the same workout on the same day (the same workoutId, or the same name)
   *   count once, and one activity answers them all.
   * - An activity answers a workout when it carries its workoutId, and failing that when it is the same sport on the same
   *   day. The id is not enough alone: an upload deletes and recreates a workout, so an activity done before it carries
   *   the old id. An activity answers one session only.
   * - status: done; today (not done yet); missed (the day is past); upcoming.
   * `plans` are the plans GET /api/calendar returns; `from` and `to` bound the days looked at.
   */
  function planned(plans, rows, today, { from, to } = {}) {
    const sessions = new Map();
    for (const plan of plans) {
      for (const w of plan.workouts) {
        for (const date of w.dates || []) {
          if ((from && date < from) || (to && date > to)) continue;
          const key = date + "|" + (w.workoutId ? "id:" + w.workoutId : "name:" + String(w.workoutName).trim().toLowerCase());
          if (!sessions.has(key)) sessions.set(key, { date, name: w.workoutName, type: w.workoutType, sport: planSport(w.workoutType), workoutId: w.workoutId || null, plans: [], status: null, activityId: null });
          sessions.get(key).plans.push({ path: plan.path, index: w.index, name: plan.name || plan.path });
        }
      }
    }
    const list = [...sessions.values()].sort((a, b) => a.date.localeCompare(b.date));
    const claimed = new Set();
    const pass = (answers) => {
      for (const s of list) {
        if (s.activityId) continue;
        const hit = rows.find((r) => r.date === s.date && !claimed.has(r.id) && answers(s, r));
        if (hit) { s.activityId = hit.id; claimed.add(hit.id); }
      }
    };
    pass((s, r) => sameId(s.workoutId, r.workoutId));
    pass((s, r) => s.sport === r.type);
    for (const s of list) s.status = s.activityId ? "done" : s.date < today ? "missed" : s.date === today ? "today" : "upcoming";
    return list;
  }

  return { weekOf, totals, groupWeeks, byDate, rangeStart, filterRows, duration, pace, distance, clock, planned, planSport, newestFirst };
});
