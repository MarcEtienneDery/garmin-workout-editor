/*
 * planModel.js — the logic of the Plans view: the plan laid out day by day, which workouts a Garmin action should take, and what the
 * button that confirms it says.
 *
 * Pure functions on a plan's workout list ([{ workoutName, workoutType, scheduledDate, workoutId, sendToDevice, ... }]) and the checks
 * against Garmin (the state of workout i: "synced", "modified", "not-uploaded", "missing", "error", or none while it is still being checked).
 * The page loads this as a plain script; the tests require() it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PlanModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY = 86_400_000;
  const ms = (iso) => Date.parse(iso + "T00:00:00Z");
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const addDays = (d, n) => iso(ms(d) + n * DAY);
  /** A real day written YYYY-MM-DD (2026-02-30 is not one). */
  const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(ms(v)) && iso(ms(v)) === v;
  /** The Monday of the week a day is in. */
  const mondayOf = (d) => addDays(d, -((new Date(ms(d)).getUTCDay() + 6) % 7));
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

  /** The days a workout is scheduled on: the valid ones, once each, in order. */
  function datesOf(w) {
    const raw = w && w.scheduledDate !== undefined && w.scheduledDate !== null ? [].concat(w.scheduledDate) : [];
    return [...new Set(raw.filter(isDay))].sort();
  }
  /** The scheduledDate values that are not days (they are skipped when scheduling). */
  const badDatesOf = (w) => ((w && w.scheduledDate !== undefined && w.scheduledDate !== null ? [].concat(w.scheduledDate) : []).filter((d) => !isDay(d)));

  const hasId = (w) => !!w && w.workoutId !== undefined && w.workoutId !== null && w.workoutId !== "";

  /** The kind a workout is drawn as in the grid: its type colour group. */
  const kindOf = (w) => (w && w.workoutType === "running" ? "run" : w && w.workoutType === "strength_training" ? "strength" : "other");

  /**
   * The plan day by day: one row per week (Monday to Sunday) from the week of the first scheduled day to the week of the last, with what is on
   * each day and what each week and the plan add up to. `measure(w)` gives a workout's { seconds, meters, sets } (the page's analysis of its
   * steps). Workouts with no valid day are listed apart, as are the scheduledDate values that are not days.
   */
  function scheduleGrid(list, { measure, today } = {}) {
    const dated = [], undated = [], bad = [];
    const items = new Map(); // day -> [{ index, kind }]
    (list || []).forEach((w, index) => {
      const days = datesOf(w);
      for (const value of badDatesOf(w)) bad.push({ index, value });
      if (!days.length) { undated.push(index); return; }
      dated.push(index);
      for (const d of days) { if (!items.has(d)) items.set(d, []); items.get(d).push({ index, kind: kindOf(w) }); }
    });
    const all = [...items.keys()].sort();
    const totals = { sessions: 0, meters: 0, seconds: 0, sets: 0, runs: 0, lifts: 0 };
    const weeks = [];
    if (all.length) {
      const first = mondayOf(all[0]), last = mondayOf(all[all.length - 1]);
      for (let monday = first, n = 1; monday <= last; monday = addDays(monday, 7), n++) {
        const week = { n, monday, sunday: addDays(monday, 6), days: [], sessions: 0, meters: 0, seconds: 0, sets: 0 };
        for (let i = 0; i < 7; i++) {
          const date = addDays(monday, i), here = items.get(date) || [];
          week.days.push({ date, today: date === today, items: here });
          for (const it of here) {
            const m = (measure && measure(list[it.index])) || {};
            week.sessions++; week.meters += num(m.meters); week.seconds += num(m.seconds); week.sets += num(m.sets);
            if (it.kind === "run") totals.runs++; else if (it.kind === "strength") totals.lifts++;
            if (it.kind === "run") totals.meters += num(m.meters);
            totals.seconds += num(m.seconds); totals.sets += num(m.sets);
          }
        }
        totals.sessions += week.sessions;
        weeks.push(week);
      }
    }
    return { weeks, totals, undated, bad, first: all[0] || null, last: all[all.length - 1] || null, dated };
  }

  /** "12.3 km", "850 m". */
  const kmText = (meters) => (meters >= 1000 ? `${Math.round(meters / 100) / 10} km` : `${Math.round(meters)} m`);
  /** "1 h 25", "40 min". */
  const timeText = (seconds) => { const m = Math.round(seconds / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };

  // ── Which workouts an action takes ──

  /** Whether a workout needs uploading: it is not on Garmin, differs from the copy there, is gone from there, or cannot be told. */
  const needsUpload = (w, state) => !hasId(w) || state !== "synced";

  const UPLOADS = ["upload", "upload_schedule"];
  /** The workouts an action starts with: for an upload "only what needs it", for the others all those they can use. */
  function defaultPick(action, list, stateOf) {
    const places = (list || []).map((_, i) => i);
    if (UPLOADS.includes(action)) return places.filter((i) => needsUpload(list[i], stateOf(i)));
    if (action === "schedule") return places.filter((i) => hasId(list[i]) && datesOf(list[i]).length);
    const flagged = places.filter((i) => hasId(list[i]) && list[i].sendToDevice);
    return flagged.length ? flagged : places.filter((i) => hasId(list[i]));
  }

  const ACTIONS = {
    upload: { label: "Upload", about: "Create or replace the workouts on Garmin" },
    schedule: { label: "Schedule", about: "Put the workouts' days on the Garmin calendar" },
    upload_schedule: { label: "Upload + schedule", about: "Both, in one go" },
    send: { label: "Send to watch", about: "The workouts flagged ‘send to watch’, else all that are on Garmin" },
  };

  /** What the page says about workout i for an action when it is `on` (chosen): a line, and whether it is a warning. */
  function rowNote(action, w, state, on) {
    const id = hasId(w) ? String(w.workoutId) : null, days = datesOf(w).length;
    if (UPLOADS.includes(action)) {
      let note, warn = false;
      if (!id) note = "New on Garmin";
      else if (state === "modified") { note = `${on ? "Replaces the copy on Garmin" : "Differs from the copy on Garmin"} (id ${id})${on ? ": deleted and recreated" : ""}`; warn = on; }
      else if (state === "missing") note = `Garmin has no workout ${id}: ${on ? "created again" : "not created"}`;
      else if (state === "synced") note = `Up to date on Garmin · ${on ? `will be replaced (id ${id})` : "left alone"}`;
      else note = `On Garmin as ${id}${on ? ": replaced" : ""}`;
      if (action === "upload_schedule" && on) note += days ? ` · ${plural(days, "day")} scheduled` : " · no day to schedule";
      return { note, warn };
    }
    if (action === "schedule") {
      if (!id) return { note: "No workoutId: skipped (upload it first)", warn: true };
      return { note: days ? `${plural(days, "day")}: ${datesOf(w).slice(0, 3).join(", ")}${days > 3 ? "…" : ""}` : "No day scheduled: nothing to put on the calendar", warn: !days };
    }
    if (!id) return { note: "No workoutId: skipped (upload it first)", warn: true };
    return { note: w.sendToDevice ? "Flagged ‘send to watch’" : "Not flagged ‘send to watch’", warn: false };
  }

  /**
   * An action on the workouts `picked` (places in the list): how many it takes, what the confirming button says, whether it can run, and a
   * line for every workout.
   */
  function describe(action, list, picked, stateOf) {
    const chosen = new Set(picked);
    const rows = (list || []).map((w, index) => {
      const state = stateOf(index), on = chosen.has(index), { note, warn } = rowNote(action, w, state, on);
      return { index, name: (w && w.workoutName) || `Workout ${index + 1}`, on, state, note, warn, days: datesOf(w).length, hasId: hasId(w) };
    });
    const taken = rows.filter((r) => r.on);
    const days = taken.reduce((n, r) => n + r.days, 0);
    const withId = taken.filter((r) => r.hasId).length;
    const usable = action === "send" ? withId : action === "schedule" ? taken.filter((r) => r.hasId && r.days).length : taken.length;
    let verb;
    if (action === "upload") verb = `Upload ${plural(taken.length, "workout")}`;
    else if (action === "schedule") verb = `Schedule ${plural(days, "day")}`;
    else if (action === "upload_schedule") verb = `Upload and schedule ${plural(taken.length, "workout")}`;
    else verb = `Send ${plural(taken.length, "workout")} to the watch`;
    const warnings = [];
    if (UPLOADS.includes(action) && withId) warnings.push(`A workout that has a workoutId is deleted and recreated on Garmin; the new ids are written back into the plan file. ${withId} of the ${taken.length} chosen ${withId === 1 ? "has" : "have"} one.`);
    return { rows, count: taken.length, days, withId, usable, verb, disabled: !taken.length || !usable, warnings };
  }

  /** The words the drawer's "only what needs it" chip shows, with the number of workouts. */
  const onlyLabel = (n) => `Only what needs it (${n})`;

  /** Whether `picked` is exactly the workouts an upload starts with (so the chip shows pressed). */
  function samePick(a, b) {
    const x = [...new Set(a)].sort((p, q) => p - q), y = [...new Set(b)].sort((p, q) => p - q);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }

  /** The `indexes` an action is sent with: none when it takes every workout (the whole plan), else the places chosen in order. */
  const indexesFor = (picked, count) => (new Set(picked).size === count ? undefined : [...new Set(picked)].sort((a, b) => a - b));

  return { isDay, mondayOf, addDays, datesOf, badDatesOf, hasId, kindOf, scheduleGrid, kmText, timeText, needsUpload, defaultPick, ACTIONS, rowNote, describe, onlyLabel, samePick, indexesFor };
});
