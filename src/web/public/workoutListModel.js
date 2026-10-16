/*
 * workoutListModel.js — how the Workouts view orders and narrows its list: sort keys, filters, and the counts the
 * filter controls show.
 *
 * Pure functions on the rows GET /api/workouts returns ({ key, workoutName, workoutType, updatedDate, plans, dates,
 * state }). The row's sync state comes from the page (the checks against Garmin arrive one plan at a time), so the
 * functions take it as `stateOf`. The page loads this as a plain script before its own code and the tests require() it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WorkoutListModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const compare = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true }); // "W2" before "W10"
  const typeOf = (r) => r.workoutType || "other";

  /** What the status filter and the status sort make of a row's state. */
  const GROUP = { modified: "attention", missing: "attention", error: "attention", synced: "ok", "not-uploaded": "notuploaded", "garmin-only": "garminonly", checking: "checking" };
  /** Needing a look first: workouts that are gone from Garmin or cannot be checked, then those that differ, then those never uploaded. */
  const RANK = { missing: 0, error: 1, modified: 2, "not-uploaded": 3, checking: 4, "garmin-only": 5, synced: 6 };

  /** The first day from today on that the plans schedule the workout, or null. */
  function nextDate(row, today) {
    return (row.dates || []).filter((d) => d >= today).sort()[0] || null;
  }

  const SORTS = {
    updated: "Updated",
    name: "Name",
    type: "Type",
    status: "Attention first",
    scheduled: "Next scheduled",
  };

  /** A sorted copy. `updated` keeps Garmin's own order (the most recently updated first) for rows that carry no date. */
  function sortRows(rows, key, { stateOf, today }) {
    const byName = (a, b) => compare(a.workoutName, b.workoutName);
    const order = {
      updated: (a, b) => (a.updatedDate && b.updatedDate ? String(b.updatedDate).localeCompare(String(a.updatedDate)) : Number(!a.updatedDate) - Number(!b.updatedDate)),
      name: byName,
      type: (a, b) => compare(typeOf(a), typeOf(b)) || byName(a, b),
      status: (a, b) => RANK[stateOf(a)] - RANK[stateOf(b)] || byName(a, b),
      scheduled: (a, b) => {
        const x = nextDate(a, today), y = nextDate(b, today);
        return x && y ? x.localeCompare(y) || byName(a, b) : Number(!x) - Number(!y) || byName(a, b);
      },
    }[key] || (() => 0);
    return [...rows].sort(order);
  }

  /**
   * The rows that pass every filter that is set.
   * query: words of the name, type and plan files | status: all, attention, ok, notuploaded, garminonly
   * plan: all, none or a plan path | types: a Set of types (empty: any) | upcoming: scheduled today or later
   */
  function filterRows(rows, { query, status, plan, types, upcoming } = {}, { stateOf, today }) {
    const words = (query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((r) => {
      if (words.length) {
        const hay = [r.workoutName, r.workoutType, ...r.plans.map((p) => p.path)].join(" ").toLowerCase();
        if (!words.every((w) => hay.includes(w))) return false;
      }
      if (status && status !== "all" && GROUP[stateOf(r)] !== status) return false;
      if (plan && plan !== "all" && (plan === "none" ? r.plans.length > 0 : !r.plans.some((p) => p.path === plan))) return false;
      if (types && types.size && !types.has(typeOf(r))) return false;
      if (upcoming && !nextDate(r, today)) return false;
      return true;
    });
  }

  /** [type, count] by count. */
  function typeCounts(rows) {
    const counts = new Map();
    for (const r of rows) counts.set(typeOf(r), (counts.get(typeOf(r)) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]));
  }

  /** The plan files the rows come from, with how many workouts each holds, by path. */
  function planCounts(rows) {
    const counts = new Map();
    for (const r of rows) for (const p of new Set(r.plans.map((x) => x.path))) counts.set(p, (counts.get(p) || 0) + 1);
    return [...counts].sort((a, b) => compare(a[0], b[0])).map(([path, count]) => ({ path, count }));
  }

  /** Is any filter set (the search included)? */
  const isFiltered = ({ query, status, plan, types, upcoming } = {}) =>
    !!((query || "").trim() || (status && status !== "all") || (plan && plan !== "all") || (types && types.size) || upcoming);

  return { SORTS, GROUP, sortRows, filterRows, typeCounts, planCounts, nextDate, isFiltered };
});
