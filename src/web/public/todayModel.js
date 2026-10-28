/*
 * todayModel.js — the logic of the Today view, the page that opens first: the tiles that show how far the day is (steps,
 * the week's intensity minutes, Body Battery, sleep), the food figures, the workouts planned for today and the days after,
 * what was already done, and how old the numbers are.
 *
 * Pure functions on what GET /api/today returns ({ today, day, progress, week, readiness, workouts, activities, food, sync }).
 * Loaded by the page as a plain script after recoveryModel.js, activityModel.js and nutritionModel.js (the numbers, dates,
 * durations and calories are said the same way); the tests require() it. A number the day does not have yet is null and shows
 * as "not synced yet": it never shows as zero. Time is passed in (`now`, milliseconds), never read from the clock here.
 */
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(node ? require("./recoveryModel.js") : root.RecoveryModel, node ? require("./activityModel.js") : root.ActivityModel, node ? require("./nutritionModel.js") : root.NutritionModel);
  if (node) module.exports = api;
  else root.TodayModel = api;
})(typeof self !== "undefined" ? self : this, function (RM, AM, NM) {
  "use strict";

  const { num, valid } = RM;
  const MINUTE_MS = 60_000;
  /** The server fetches today's summary again once it is this old, so older than this is worth a Sync. */
  const STALE_MS = 30 * MINUTE_MS;
  /** The watch has been this long without a sync with the phone before the page says so. */
  const WATCH_STALE_MS = 3 * 60 * MINUTE_MS;

  // ── How old ─────────────────────────────────────────────────────────────

  /** "just now", "12 min ago", "3 h ago", "2 days ago". */
  function ago(ms, now) {
    if (!valid(ms)) return "";
    const minutes = Math.max(0, Math.floor((now - ms) / MINUTE_MS));
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  /**
   * How current the day's numbers are. Steps are as of the last time the watch synced with Garmin, which can be hours before we
   * fetched them, so both are said. `stale`: nothing is stored, or it was fetched long ago (STALE_MS) and is shown in the warning colour; Sync fetches it again once it is a minute old, stale or not.
   */
  function freshness(view, now) {
    const p = view.progress;
    if (view.health === false) return { text: "", stale: false }; // no Garmin and nothing from it: there is no summary to wait for
    if (!p) return { text: "Garmin's summary for today is not stored yet.", stale: true };
    const parts = [];
    if (valid(p.watchSyncedAt)) parts.push(`Watch synced ${ago(p.watchSyncedAt, now)}`);
    parts.push(`${parts.length ? "fetched" : "Fetched"} ${ago(p.fetchedAt, now)}`);
    return { text: parts.join(" · "), stale: now - p.fetchedAt > STALE_MS };
  }

  /**
   * What to do when the watch has not synced with Garmin for a while, or "". Garmin gives no way to ask the watch to sync from
   * here: it uploads through the Garmin Connect app on the phone, so the numbers stay as they were however often Sync is pressed.
   * Said only when Garmin gave the watch's time: without it there is nothing to say.
   */
  function watchHint(view, now) {
    const p = view.progress;
    if (!p || !valid(p.watchSyncedAt) || now - p.watchSyncedAt <= WATCH_STALE_MS) return "";
    return "The watch has not synced for a while, so these numbers may be behind. Open Garmin Connect on your phone (pull down to sync), then press Sync here.";
  }

  // ── Progress tiles ──────────────────────────────────────────────────────

  /** Whole percent of a goal, or null without a value or a goal. It can pass 100. */
  const percent = (value, goal) => (valid(value) && valid(goal) && goal > 0 ? Math.round((value / goal) * 100) : null);

  const present = (v) => valid(v);
  const join = (parts) => parts.filter(Boolean).join(" · ");

  /**
   * The tiles with a bar. Each is { id, label, value, note, pct, done, go }: pct is null for no bar, done when the goal is met,
   * go the view a click opens.
   */
  function progressTiles(view) {
    const day = view.day || {}, p = view.progress, week = view.week;
    const steps = day.steps, stepGoal = p ? p.stepGoal : null, stepPct = percent(steps, stepGoal);
    const km = p && present(p.distanceMeters) && p.distanceMeters > 0 ? AM.distance(+(p.distanceMeters / 1000).toFixed(1)) : "";

    const stored = week && week.daysStored > 0;
    const goal = p ? p.intensityGoal : null, weekPct = stored ? percent(week.minutes, goal) : null;
    const short = stored && week.daysStored < week.days ? `${week.daysStored} of ${week.days} days stored` : "";

    const now = p ? p.bodyBatteryNow : null;

    const need = present(day.sleepNeedMinutes) ? day.sleepNeedMinutes * 60 : null, sleepPct = percent(day.sleepSeconds, need);

    return [
      {
        id: "steps", label: "Steps", go: "recovery", pct: stepPct, done: stepPct !== null && stepPct >= 100,
        value: present(steps) ? num(steps) : "–",
        note: !present(steps) ? "not synced yet" : join([stepPct !== null ? `of ${num(stepGoal)} · ${stepPct}%` : "steps", km]),
      },
      {
        id: "intensity", label: "Intensity minutes", go: "recovery", pct: weekPct, done: weekPct !== null && weekPct >= 100,
        value: stored ? num(week.minutes) : "–",
        note: !stored ? "not synced yet" : join([present(goal) ? `of ${num(goal)} this week · ${weekPct}%` : "this week", short]),
      },
      {
        id: "battery", label: "Body Battery", go: "recovery", pct: present(now) ? Math.max(0, Math.min(100, now)) : null, done: false,
        value: present(now) ? num(now) : "–",
        note: join([present(day.bodyBatteryWake) && `woke at ${num(day.bodyBatteryWake)}`, present(day.bodyBatteryLow) && `low ${num(day.bodyBatteryLow)}`, present(day.avgStress) && `stress ${num(day.avgStress)}`]) || "no reading yet",
      },
      {
        id: "sleep", label: "Sleep", go: "recovery", pct: sleepPct, done: sleepPct !== null && sleepPct >= 100,
        value: RM.hm(day.sleepSeconds),
        note: present(day.sleepSeconds) ? join([present(day.sleepScore) && `score ${num(day.sleepScore)}`, need !== null && `need ${RM.hm(need)}`, present(day.restingHr) && `resting HR ${num(day.restingHr)}`]) : "none stored for last night",
      },
    ];
  }

  /** The food tiles: eaten, burned so far, the difference and the macros, worded as the Food view words them. */
  const foodTiles = (view) => NM.figures({ today: view.today, day: view.food, progress: view.foodProgress }).map((tile) => ({ ...tile, go: "food" }));

  // ── Workouts and what was done ──────────────────────────────────────────

  const typeLabel = (type) => (type ? type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "");
  const dayName = (date, today) => (date === today ? "Today" : date === RM.addDays(today, 1) ? "Tomorrow" : RM.dayLabel(date));

  /**
   * The planned workouts by day, today first (listed even when nothing is planned), then each later day that has one. `measure`
   * (optional) totals a workout from its steps as { seconds, meters, assumed }: plans seldom state a duration, and an assumed
   * pace makes the time an estimate, shown with a "~".
   */
  function workoutDays(view, measure) {
    const days = new Map([[view.today, []]]);
    for (const w of view.workouts) {
      if (!days.has(w.date)) days.set(w.date, []);
      const m = (measure && w.workout && measure(w.workout)) || {}, seconds = m.seconds || w.seconds;
      const meta = join([typeLabel(w.type), m.meters > 0 && AM.distance(+(m.meters / 1000).toFixed(1)), seconds > 0 && `${m.assumed ? "~" : ""}${AM.duration(seconds)}`]);
      days.get(w.date).push({ name: w.name, meta, done: !!w.done, path: w.path, index: w.index });
    }
    return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => ({ date, label: dayName(date, view.today), today: date === view.today, items, done: items.filter((i) => i.done).length }));
  }

  /** An activity done today as a line: its name, and when, how far, how long and how many calories. */
  const activityLine = (a) => ({
    id: a.id,
    name: a.name,
    meta: join([a.time, AM.distance(a.km), AM.duration(a.seconds), present(a.calories) && a.calories > 0 && `${num(a.calories)} kcal`]),
  });

  /** The readiness for the day's workout as a chip and a sentence. */
  function readinessLine(readiness) {
    const info = RM.bandInfo(readiness.band);
    return { label: info.label, cls: info.cls, score: readiness.score, text: readiness.suggestion };
  }

  return { STALE_MS, WATCH_STALE_MS, ago, freshness, watchHint, percent, progressTiles, foodTiles, typeLabel, dayName, workoutDays, activityLine, readinessLine };
});
