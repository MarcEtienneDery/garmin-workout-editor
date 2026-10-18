/*
 * weightModel.js — the logic of the Weight view: a weight in kg or lb, the figures at the top, the fields of the daily
 * table and the charts (weight, body fat, muscle, calories burned).
 *
 * Pure functions on what GET /api/weight returns ({ today, date, body, days: [{ day, weightKg, ... }], stored, sync }).
 * Weights arrive in kilograms and are shown in the unit the person picks. Loaded by the page as a plain script after
 * recoveryModel.js (the numbers and dates are said the same way); the tests require() it.
 */
(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./recoveryModel.js") : root.RecoveryModel);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WeightModel = api;
})(typeof self !== "undefined" ? self : this, function (RM) {
  "use strict";

  const { num, valid, shortDay } = RM;
  const LB_PER_KG = 2.2046226218;
  const UNITS = { lb: { label: "lb", of: (kg) => kg * LB_PER_KG }, kg: { label: "kg", of: (kg) => kg } };
  const unitOf = (name) => UNITS[name] || UNITS.lb;
  const MINUS = "−";

  /** A weight given in kg, said in the unit: "181.0 lb". */
  const weight = (kg, unit, digits = 1) => (valid(kg) ? `${num(unitOf(unit).of(kg), digits)} ${unitOf(unit).label}` : "–");
  /** A change given in kg, signed, in the unit: "+0.5 lb", "−0.7 lb"; no sign when it rounds to nothing. */
  function change(kg, unit, digits = 1) {
    if (!valid(kg)) return "–";
    const v = unitOf(unit).of(kg), rounds = Math.round(Math.abs(v) * 10 ** digits) === 0;
    return `${rounds ? "" : v > 0 ? "+" : MINUS}${num(Math.abs(v), digits)} ${unitOf(unit).label}`;
  }

  // ── The daily table ─────────────────────────────────────────────────────

  const kcal = (key, label) => ({ key, label, unit: " kcal" });
  /** The stored numbers of a day, in the groups the table shows; weights are said in the picked unit. */
  const GROUPS = [
    { name: "Weigh-in", fields: [
      { key: "weightKg", label: "Weight", weight: true }, { key: "bodyFatPercent", label: "Body fat", unit: " %", digits: 1 },
      { key: "muscleKg", label: "Muscle", weight: true }, { key: "bmi", label: "BMI", digits: 1 },
    ] },
    { name: "Calories burned", fields: [kcal("totalKcal", "All day"), kcal("activeKcal", "Active"), kcal("bmrKcal", "At rest")] },
  ];

  /** How one field of a day reads, in the unit. */
  const cell = (field, day, unit) => (field.weight ? weight(day[field.key], unit) : num(day[field.key], field.digits || 0, field.unit || ""));

  /** What is stored for a day that this view lists with its raw responses. */
  const KINDS = [{ kind: "weight", label: "Weigh-in" }, { kind: "summary", label: "Daily summary (calories)" }];

  // ── The figures at the top ──────────────────────────────────────────────

  const DIRECTION = { gaining: "gaining", losing: "losing", steady: "steady" };
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  /** The tiles above the charts: the last weigh-in, the trend, how many weigh-ins, the calories burned a day (the days that are over). */
  function figures({ body, days, today }, unit) {
    const last = body.latest, done = days.filter((d) => d.day < today && valid(d.totalKcal));
    const trend = body.perWeekKg === null
      ? { value: "–", note: "needs 3 weigh-ins over a week or more" }
      : { value: body.direction === "steady" ? "steady" : `${change(body.perWeekKg, unit)} / week`, note: `${DIRECTION[body.direction]} · ${change(body.changeKg, unit)} from ${shortDay(body.first.day)} to ${shortDay(body.latest.day)}` };
    const active = done.map((d) => d.activeKcal).filter(valid);
    return [
      { label: "Last weigh-in", value: last ? weight(last.kg, unit) : "–", note: last ? `${shortDay(last.day)}${valid(last.bodyFatPercent) ? ` · ${num(last.bodyFatPercent, 1)} % fat` : ""}` : "none in these days" },
      { label: "Trend", ...trend },
      { label: "Weigh-ins", value: String(body.weighIns), note: `in ${days.length} days` },
      { label: "Burned a day", value: done.length ? `${num(mean(done.map((d) => d.totalKcal)))} kcal` : "–", note: done.length ? `${active.length ? `${num(mean(active))} active · ` : ""}${done.length} full day${done.length === 1 ? "" : "s"}` : "no full day stored" },
    ];
  }

  // ── The charts ──────────────────────────────────────────────────────────

  /** What the view draws for the days, in the unit: weight always, body fat and muscle once the scale has measured them. */
  function charts(days, unit) {
    const u = unitOf(unit), has = (key) => days.some((d) => valid(d[key]));
    const ofKg = (key) => (d) => (valid(d[key]) ? u.of(d[key]) : null);
    const out = [{
      id: "weight", title: "Weight", unit: u.label, kind: "line", connect: true, value: ofKg("weightKg"),
      read: (d) => (valid(d.weightKg) ? `${weight(d.weightKg, unit)}${valid(d.bodyFatPercent) ? ` · ${num(d.bodyFatPercent, 1)} % fat` : ""}` : "–"),
    }];
    if (has("bodyFatPercent")) out.push({ id: "fat", title: "Body fat", unit: "%", kind: "line", connect: true, value: (d) => d.bodyFatPercent, read: (d) => (valid(d.bodyFatPercent) ? `${num(d.bodyFatPercent, 1)} %` : "–") });
    if (has("muscleKg")) out.push({ id: "muscle", title: "Muscle mass", unit: u.label, kind: "line", connect: true, value: ofKg("muscleKg"), read: (d) => weight(d.muscleKg, unit) });
    out.push({
      id: "burned", title: "Calories burned", unit: "kcal", kind: "stack", min: 0, scaleBy: 1,
      parts: [{ key: "bmrKcal", label: "At rest", cls: "bmr" }, { key: "activeKcal", label: "Active", cls: "active" }],
      read: (d) => (valid(d.totalKcal) ? `${num(d.totalKcal)} kcal${valid(d.activeKcal) ? ` · ${num(d.activeKcal)} active` : ""}` : "–"),
    });
    return out;
  }

  return { UNITS, unitOf, weight, change, GROUPS, cell, KINDS, figures, charts };
});
