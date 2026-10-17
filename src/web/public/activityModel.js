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

  // ── Charts ───────────────────────────────────────────────────────────────

  /** Round axis bounds and ticks (about `count` of them) for values between lo and hi. */
  function niceRange(lo, hi, count = 3) {
    if (!(hi > lo)) { lo -= 1; hi += 1; }
    const raw = (hi - lo) / count, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
    const from = Math.floor(lo / step) * step, to = Math.ceil(hi / step) * step, ticks = [];
    for (let v = from; v <= to + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { lo: from, hi: to, ticks };
  }

  /** A moving average over `window` samples, ignoring gaps; a sample that was a gap stays one. */
  function smooth(values, window = 5) {
    const half = window >> 1;
    return values.map((v, i) => {
      if (v === null || v === undefined) return null;
      let sum = 0, n = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) if (values[j] !== null && values[j] !== undefined) { sum += values[j]; n++; }
      return n ? sum / n : null;
    });
  }

  /** The lowest and highest of the values once the extremes are set aside, so a spike does not squash a graph; null with none. */
  function trimRange(values, lowPct = 2, highPct = 98) {
    const xs = values.filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
    if (!xs.length) return null;
    const at = (p) => xs[Math.min(xs.length - 1, Math.max(0, Math.round((p / 100) * (xs.length - 1))))];
    return [at(lowPct), at(highPct)];
  }

  /** The index of the sample nearest to x in a series that rises (gaps are skipped); -1 when there is none. */
  function nearestIndex(xs, x) {
    let best = -1, gap = Infinity;
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] === null || xs[i] === undefined) continue;
      const g = Math.abs(xs[i] - x);
      if (g < gap) { gap = g; best = i; } else if (xs[i] > x) break;
    }
    return best;
  }

  /** Seconds in each heart-rate zone as shares of the total. */
  function zoneShares(seconds) {
    const total = (seconds || []).reduce((a, b) => a + (b || 0), 0);
    return (seconds || []).map((s, i) => ({ zone: i + 1, seconds: s || 0, pct: total ? Math.round(((s || 0) / total) * 100) : 0 }));
  }

  /**
   * The sets of one exercise as runs of identical sets: [{ count, reps, weight }], in the order they were done. A set
   * with no reps (or no weight) has 0 there, which is what Garmin gives when the watch did not count it.
   */
  function setRuns(x) {
    const n = Math.max(1, (x && x.sets) || 1);
    const reps = x && Array.isArray(x.repsList) ? x.repsList : Array(n).fill((x && x.reps) || 0);
    const weights = x && Array.isArray(x.weightList) ? x.weightList : Array(n).fill((x && x.weight) || 0);
    const runs = [];
    for (let i = 0; i < Math.max(n, reps.length, weights.length); i++) {
      const r = reps[i] || 0, w = weights[i] || 0, last = runs[runs.length - 1];
      if (last && last.reps === r && last.weight === w) last.count++;
      else runs.push({ count: 1, reps: r, weight: w });
    }
    return runs;
  }

  /** A lift's name as the key a benchmark is filed under: "Barbell Bench Press" and BARBELL_BENCH_PRESS both give BENCH_PRESS. */
  const liftKey = (name) => String(name || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^BARBELL_/, "");

  /** The Epley estimate of a one-rep max from one set; null when the set cannot say (no weight, no counted reps, or over 12 reps). */
  function estimate1RM(weight, reps) {
    if (!(weight > 0) || !(reps > 0) || reps > 12) return null;
    return reps === 1 ? weight : weight * (1 + reps / 30);
  }

  /** 0 to 3 for how heavy a set is: under 65% of the max, to 80, to 90, and beyond. */
  const intensityBand = (pct) => (pct < 65 ? 0 : pct < 80 ? 1 : pct < 90 ? 2 : 3);

  /**
   * Each loaded exercise's sets as a percentage of its one-rep max, in the order they were done, with consecutive sets of one
   * weight together. The max is the profile's benchmark for that lift when it has one ({ BARBELL_BENCH_PRESS: 266 }),
   * otherwise the best Epley estimate among the sets of the activity. An exercise with neither is left out.
   * Returns [{ name, oneRm, source: "benchmark" | "estimate", runs: [{ count, weight, pct, band }] }].
   */
  function intensity(lifts, benchmarks) {
    const known = {};
    for (const [k, v] of Object.entries(benchmarks || {})) if (typeof v === "number" && v > 0) known[liftKey(k)] = v;
    const byName = new Map();
    for (const x of lifts || []) {
      if (!x || x.category === "INTERVAL" || !x.exerciseName) continue;
      const e = byName.get(x.exerciseName) || { name: x.exerciseName, sets: [] };
      e.sets.push(...setRuns(x).filter((r) => r.weight > 0).map((r) => ({ ...r })));
      byName.set(x.exerciseName, e);
    }
    const out = [];
    for (const e of byName.values()) {
      if (!e.sets.length) continue;
      const benchmark = known[liftKey(e.name)];
      const oneRm = benchmark || Math.max(0, ...e.sets.map((r) => estimate1RM(r.weight, r.reps) || 0));
      if (!oneRm) continue;
      const runs = [];
      for (const r of e.sets) {
        const last = runs[runs.length - 1];
        if (last && last.weight === r.weight) last.count += r.count;
        else runs.push({ count: r.count, weight: r.weight });
      }
      out.push({
        name: e.name, oneRm: Math.round(oneRm), source: benchmark ? "benchmark" : "estimate",
        runs: runs.map((r) => { const pct = Math.round((r.weight / oneRm) * 100); return { ...r, pct, band: intensityBand(pct) }; }),
      });
    }
    return out;
  }

  /** One run as text: "6 @ 40 lb", "3 × 6 @ 40 lb", "135 lb" for a set whose reps were not counted, "3 × 12" without weight; "" with neither. */
  function runText(run) {
    const w = run.weight ? `${+run.weight.toFixed(1)} lb` : "";
    const core = run.reps && w ? `${run.reps} @ ${w}` : run.reps ? String(run.reps) : w;
    return core && run.count > 1 ? `${run.count} × ${core}` : core;
  }

  /** What was planned against what was done: time and distance, each with the difference. */
  function compare(planned, actual) {
    const rows = [];
    const row = (label, p, a, format) => {
      if (!p || !a) return;
      rows.push({ label, planned: format(p), actual: format(a), delta: Math.round((a - p) * 1000) / 1000, pct: Math.round(((a - p) / p) * 100) });
    };
    row("Time", planned.seconds, actual.seconds, duration);
    row("Distance", planned.km, actual.km, distance);
    return rows;
  }

  /** Seconds as m:ss, or h:mm:ss from an hour on, for an axis. */
  function axisClock(sec) {
    const t = Math.round(sec), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(t % 60)}` : `${m}:${pad(t % 60)}`;
  }

  /** Where on the route (an index) the activity was at sample i of the series: by distance, else in proportion. -1 with no route. */
  function routeIndexFor(chart, i) {
    const route = chart && chart.route;
    if (!route || !route.lat.length) return -1;
    const d = chart.distance[i];
    if (d !== null && d !== undefined && route.distance.some((x) => x !== null && x !== undefined)) return nearestIndex(route.distance, d);
    const n = chart.time.length;
    return n > 1 ? Math.round((i / (n - 1)) * (route.lat.length - 1)) : 0;
  }

  /** The sample of the series for a point of the route, the other way round. -1 with no series. */
  function chartIndexFor(chart, j) {
    if (!chart || !chart.time.length || !chart.route) return -1;
    const d = chart.route.distance[j];
    if (d !== null && d !== undefined && chart.distance.some((x) => x !== null && x !== undefined)) return nearestIndex(chart.distance, d);
    return chart.route.lat.length > 1 ? Math.round((j / (chart.route.lat.length - 1)) * (chart.time.length - 1)) : 0;
  }

  return { setRuns, runText, intensity, estimate1RM, intensityBand, liftKey, routeIndexFor, chartIndexFor, niceRange, smooth, trimRange, nearestIndex, zoneShares, compare, axisClock, weekOf, totals, groupWeeks, byDate, rangeStart, filterRows, duration, pace, distance, clock, planned, planSport, newestFirst };
});
