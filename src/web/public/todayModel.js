(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(node ? require("./recoveryModel.js") : root.RecoveryModel, node ? require("./activityModel.js") : root.ActivityModel, node ? require("./nutritionModel.js") : root.NutritionModel);
  if (node) module.exports = api;
  else root.TodayModel = api;
})(typeof self !== "undefined" ? self : this, function (RM, AM, NM) {
  "use strict";

  const { num, valid } = RM;
  const MINUTE_MS = 60_000;
  const STALE_MS = 30 * MINUTE_MS;
  const WATCH_STALE_MS = 3 * 60 * MINUTE_MS;


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

  function freshness(view, now) {
    const p = view.progress;
    if (view.health === false) return { text: "", stale: false };
    if (!p) return { text: "Garmin's summary for today is not stored yet.", stale: true };
    const parts = [];
    if (valid(p.watchSyncedAt)) parts.push(`Watch synced ${ago(p.watchSyncedAt, now)}`);
    parts.push(`${parts.length ? "fetched" : "Fetched"} ${ago(p.fetchedAt, now)}`);
    return { text: parts.join(" · "), stale: now - p.fetchedAt > STALE_MS };
  }

  function watchHint(view, now) {
    const p = view.progress;
    if (!p || !valid(p.watchSyncedAt) || now - p.watchSyncedAt <= WATCH_STALE_MS) return "";
    return "The watch has not synced for a while, so these numbers may be behind. Open Garmin Connect on your phone (pull down to sync), then press Sync here.";
  }


  function tileTrend(view, id) {
    const days = Array.isArray(view.trend) ? view.trend : [];
    const pick = {
      steps: (d) => ({ n: d.steps, say: (n) => num(n) }),
      intensity: (d) => ({ n: d.minutes, say: (n) => `${num(n)} min` }),
      battery: (d) => ({ n: d.bodyBatteryWake, say: (n) => num(n) }),
      sleep: (d) => ({ n: present(d.sleepSeconds) ? d.sleepSeconds / 3600 : null, say: (n) => RM.hm(Math.round(n * 3600)) }),
    }[id];
    if (!pick || days.length < 2) return null;
    const rows = days.map(pick);
    if (rows.filter((r) => present(r.n)).length < 2) return null;
    const what = { steps: "Steps", intensity: "Intensity minutes a day", battery: "Body Battery on waking", sleep: "Sleep" }[id];
    return { values: rows.map((r) => (present(r.n) ? r.n : null)), text: `${what}, last ${days.length} days: ${rows.map((r) => (present(r.n) ? r.say(r.n) : "none")).join(", ")}` };
  }

  function sparkline(values, width, height, pad) {
    const known = values.filter(present);
    if (known.length < 2) return null;
    const lo = Math.min(...known), hi = Math.max(...known), span = hi - lo;
    const x = (i) => +(pad + (i * (width - 2 * pad)) / (values.length - 1)).toFixed(1);
    const y = (n) => +(span === 0 ? height / 2 : height - pad - ((n - lo) / span) * (height - 2 * pad)).toFixed(1);
    const runs = [];
    let run = null, last = null;
    values.forEach((n, i) => {
      if (!present(n)) { run = null; return; }
      if (!run) { run = []; runs.push(run); }
      last = [x(i), y(n)];
      run.push(last);
    });
    return { runs, last, lastIsToday: present(values[values.length - 1]) };
  }

  const gaugeFill = (score) => (valid(score) ? Math.max(0, Math.min(100, score)) / 100 : 0);


  const percent = (value, goal) => (valid(value) && valid(goal) && goal > 0 ? Math.round((value / goal) * 100) : null);

  const present = (v) => valid(v);
  const join = (parts) => parts.filter(Boolean).join(" · ");

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
        trend: tileTrend(view, "steps"),
        value: present(steps) ? num(steps) : "–",
        note: !present(steps) ? "not synced yet" : join([stepPct !== null ? `of ${num(stepGoal)} · ${stepPct}%` : "steps", km]),
      },
      {
        id: "intensity", label: "Intensity minutes", go: "recovery", pct: weekPct, done: weekPct !== null && weekPct >= 100,
        trend: tileTrend(view, "intensity"),
        value: stored ? num(week.minutes) : "–",
        note: !stored ? "not synced yet" : join([present(goal) ? `of ${num(goal)} this week · ${weekPct}%` : "this week", short]),
      },
      {
        id: "battery", label: "Body Battery", go: "recovery", pct: present(now) ? Math.max(0, Math.min(100, now)) : null, done: false,
        trend: tileTrend(view, "battery"),
        value: present(now) ? num(now) : "–",
        note: join([present(day.bodyBatteryWake) && `woke at ${num(day.bodyBatteryWake)}`, present(day.bodyBatteryLow) && `low ${num(day.bodyBatteryLow)}`, present(day.avgStress) && `stress ${num(day.avgStress)}`]) || "no reading yet",
      },
      {
        id: "sleep", label: "Sleep", go: "recovery", pct: sleepPct, done: sleepPct !== null && sleepPct >= 100,
        trend: tileTrend(view, "sleep"),
        value: RM.hm(day.sleepSeconds),
        note: present(day.sleepSeconds) ? join([present(day.sleepScore) && `score ${num(day.sleepScore)}`, need !== null && `need ${RM.hm(need)}`, present(day.restingHr) && `resting HR ${num(day.restingHr)}`]) : "none stored for last night",
      },
    ];
  }

  const foodView = (view) => ({ date: view.today, today: view.today, day: view.food, goals: view.goals || {}, progress: view.foodProgress || [], burn: !!view.health });


  const typeLabel = (type) => (type ? type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "");
  const dayName = (date, today) => (date === today ? "Today" : date === RM.addDays(today, 1) ? "Tomorrow" : RM.dayLabel(date));

  function workoutDays(view, measure) {
    const days = new Map([[view.today, []]]);
    for (const w of view.workouts) {
      if (!days.has(w.date)) days.set(w.date, []);
      const m = (measure && w.workout && measure(w.workout)) || {}, seconds = m.seconds || w.seconds;
      const meta = join([typeLabel(w.type), m.meters > 0 && AM.distance(+(m.meters / 1000).toFixed(1)), seconds > 0 && `${m.assumed ? "~" : ""}${AM.duration(seconds)}`]);
      days.get(w.date).push({ name: w.name, meta, done: !!w.done, path: w.path, index: w.index, workout: w.workout });
    }
    return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => ({ date, label: dayName(date, view.today), today: date === view.today, items, done: items.filter((i) => i.done).length }));
  }

  const activityLine = (a) => ({
    id: a.id,
    name: a.name,
    meta: join([a.time, AM.distance(a.km), AM.duration(a.seconds), present(a.calories) && a.calories > 0 && `${num(a.calories)} kcal`]),
  });

  function readinessLine(readiness) {
    const info = RM.bandInfo(readiness.band);
    return { label: info.label, cls: info.cls, score: readiness.score, text: readiness.suggestion };
  }

  return { STALE_MS, WATCH_STALE_MS, ago, freshness, watchHint, percent, tileTrend, sparkline, gaugeFill, progressTiles, foodView, typeLabel, dayName, workoutDays, activityLine, readinessLine };
});
