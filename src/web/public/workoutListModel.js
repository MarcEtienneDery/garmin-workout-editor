(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WorkoutListModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const compare = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
  const typeOf = (r) => r.workoutType || "other";

  const GROUP = { modified: "attention", missing: "attention", error: "attention", synced: "ok", "not-uploaded": "notuploaded", "garmin-only": "garminonly", checking: "checking" };
  const RANK = { missing: 0, error: 1, modified: 2, "not-uploaded": 3, checking: 4, "garmin-only": 5, synced: 6 };

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

  function typeCounts(rows) {
    const counts = new Map();
    for (const r of rows) counts.set(typeOf(r), (counts.get(typeOf(r)) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]));
  }

  function planCounts(rows) {
    const counts = new Map();
    for (const r of rows) for (const p of new Set(r.plans.map((x) => x.path))) counts.set(p, (counts.get(p) || 0) + 1);
    return [...counts].sort((a, b) => compare(a[0], b[0])).map(([path, count]) => ({ path, count }));
  }

  function statusCounts(rows, stateOf) {
    const counts = { all: rows.length, attention: 0, ok: 0, notuploaded: 0, garminonly: 0, checking: 0 };
    for (const r of rows) counts[GROUP[stateOf(r)] || "checking"]++;
    return counts;
  }

  const isFiltered = ({ query, status, plan, types, upcoming } = {}) =>
    !!((query || "").trim() || (status && status !== "all") || (plan && plan !== "all") || (types && types.size) || upcoming);

  return { SORTS, GROUP, sortRows, filterRows, typeCounts, planCounts, nextDate, isFiltered, statusCounts };
});
