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
  const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(ms(v)) && iso(ms(v)) === v;
  const mondayOf = (d) => addDays(d, -((new Date(ms(d)).getUTCDay() + 6) % 7));
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

  function datesOf(w) {
    const raw = w && w.scheduledDate !== undefined && w.scheduledDate !== null ? [].concat(w.scheduledDate) : [];
    return [...new Set(raw.filter(isDay))].sort();
  }
  const badDatesOf = (w) => ((w && w.scheduledDate !== undefined && w.scheduledDate !== null ? [].concat(w.scheduledDate) : []).filter((d) => !isDay(d)));

  const hasId = (w) => !!w && w.workoutId !== undefined && w.workoutId !== null && w.workoutId !== "";

  const kindOf = (w) => (w && w.workoutType === "running" ? "run" : w && w.workoutType === "strength_training" ? "strength" : "other");

  function scheduleGrid(list, { measure, today } = {}) {
    const dated = [], undated = [], bad = [];
    const items = new Map();
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

  const kmText = (meters) => (meters >= 1000 ? `${Math.round(meters / 100) / 10} km` : `${Math.round(meters)} m`);
  const timeText = (seconds) => { const m = Math.round(seconds / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };


  const needsUpload = (w, state) => !hasId(w) || state !== "synced";

  const UPLOADS = ["upload", "upload_schedule"];
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

  const onlyLabel = (n) => `Only what needs it (${n})`;

  function samePick(a, b) {
    const x = [...new Set(a)].sort((p, q) => p - q), y = [...new Set(b)].sort((p, q) => p - q);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }

  const indexesFor = (picked, count) => (new Set(picked).size === count ? undefined : [...new Set(picked)].sort((a, b) => a - b));

  return { isDay, mondayOf, addDays, datesOf, badDatesOf, hasId, kindOf, scheduleGrid, kmText, timeText, needsUpload, defaultPick, ACTIONS, rowNote, describe, onlyLabel, samePick, indexesFor };
});
