/*
 * nutritionModel.js — the logic of the Food view: how a meal, calories and grams are said, the figures at the top, the
 * macro shares, the fields of the daily table, the charts, and what a food form holds before it is sent.
 *
 * Pure functions on what GET /api/nutrition returns ({ today, date, day: { meals, kcal, proteinG, ... burnedKcal, netKcal },
 * days: [{ day, kcal, ... }], average, recent }). Loaded by the page as a plain script after recoveryModel.js (the numbers
 * and dates are said the same way); the tests require() it. The server checks every number again.
 */
(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./recoveryModel.js") : root.RecoveryModel);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NutritionModel = api;
})(typeof self !== "undefined" ? self : this, function (RM) {
  "use strict";

  const { num, valid } = RM;
  const MINUS = "−";

  const MEAL_LABELS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snacks" };
  const mealLabel = (meal) => MEAL_LABELS[meal] || meal;

  const kcal = (v) => (valid(v) ? `${num(v)} kcal` : "–");
  /** Grams, with a decimal only when there is one: "30 g", "12.5 g". */
  const grams = (v) => (valid(v) ? `${num(v, Number.isInteger(v) ? 0 : 1)} g` : "–");
  /** A difference in calories, signed: "+250 kcal", "−300 kcal". */
  const signed = (v) => (valid(v) ? `${v > 0 ? "+" : v < 0 ? MINUS : ""}${num(Math.abs(v))} kcal` : "–");

  /** "P 30 · C 45 · F 12" for one food or a total. */
  const macros = (f) => `P ${num(f.proteinG, Number.isInteger(f.proteinG) ? 0 : 1)} · C ${num(f.carbsG, Number.isInteger(f.carbsG) ? 0 : 1)} · F ${num(f.fatG, Number.isInteger(f.fatG) ? 0 : 1)}`;

  /** The share of the macros' own calories (4 kcal a gram of protein and carbs, 9 of fat) that each makes, in whole percent; null when there are none. */
  function shares(t) {
    const p = (t.proteinG || 0) * 4, c = (t.carbsG || 0) * 4, f = (t.fatG || 0) * 9, all = p + c + f;
    if (!(all > 0)) return null;
    const protein = Math.round((p / all) * 100), carbs = Math.round((c / all) * 100);
    return { protein, carbs, fat: Math.max(0, 100 - protein - carbs) };
  }

  /** The tiles above the day: eaten, burned, the difference, and the macros with their shares. */
  function figures(view) {
    const d = view.day, logged = d.entries > 0, today = d.day === view.today;
    const s = shares(d);
    const net = d.netKcal;
    return [
      { label: "Eaten", value: logged ? kcal(d.kcal) : "–", note: logged ? `${d.entries} food${d.entries === 1 ? "" : "s"}` : "nothing logged" },
      { label: "Burned", value: kcal(d.burnedKcal), note: d.burnedKcal === null ? "no day summary from Garmin" : today ? "so far today, by Garmin" : "by Garmin" },
      { label: "Eaten − burned", value: signed(net), note: net === null ? (logged ? "needs the day's burn" : "needs a logged day") : `${net > 0 ? "above" : net < 0 ? "below" : "at"} what the day burned${today ? " so far" : ""}` },
      { label: "Macros", value: logged ? macros(d) : "–", note: s ? `${s.protein} % protein · ${s.carbs} % carbs · ${s.fat} % fat` : "grams a day" },
    ];
  }

  /** What the logged days before today average, or null. */
  function averageNote(average) {
    if (!average) return "";
    return `Average of ${average.days} logged day${average.days === 1 ? "" : "s"}: ${kcal(average.kcal)} · ${macros(average)}`;
  }

  // ── The daily table and the charts ──────────────────────────────────────

  const g = (key, label) => ({ key, label, grams: true });
  /** The numbers of a day, in the groups the table shows. */
  const GROUPS = [
    { name: "Eaten", fields: [{ key: "kcal", label: "Calories", unit: " kcal" }, g("proteinG", "Protein"), g("carbsG", "Carbs"), g("fatG", "Fat")] },
    { name: "Garmin", fields: [{ key: "burnedKcal", label: "Burned", unit: " kcal" }, { key: "netKcal", label: "Eaten − burned", net: true }] },
  ];

  /** How one field of a day reads; a day nothing was logged on has no eaten numbers. */
  function cell(field, day) {
    if (field.net) return signed(day.netKcal);
    if (!day.entries && !/^burned/.test(field.key)) return "–";
    return field.grams ? grams(day[field.key]) : num(day[field.key], 0, field.unit || "");
  }

  /** The days for the charts: a day nothing was logged on has no eaten numbers (it is not a day of zero). */
  const chartDays = (days) => days.map((d) => (d.entries ? d : { ...d, kcal: null, proteinG: null, carbsG: null, fatG: null }));

  /** What the view draws: the calories eaten against the burn, and the macros piled up. */
  function charts() {
    return [
      {
        id: "eaten", title: "Calories eaten", unit: "kcal", kind: "bars", min: 0, value: (d) => d.kcal, ref: { label: "Burned by Garmin", value: (d) => d.burnedKcal },
        read: (d) => (valid(d.kcal) ? `${num(d.kcal)} kcal${valid(d.burnedKcal) ? ` · burned ${num(d.burnedKcal)}` : ""}` : "not logged"),
      },
      {
        id: "macros", title: "Macros", unit: "g", kind: "stack", min: 0, scaleBy: 1,
        parts: [{ key: "proteinG", label: "Protein", cls: "protein" }, { key: "carbsG", label: "Carbs", cls: "carbs" }, { key: "fatG", label: "Fat", cls: "fat" }],
        read: (d) => (valid(d.kcal) ? macros(d) : "not logged"),
      },
    ];
  }

  // ── The food form ───────────────────────────────────────────────────────

  /** A form field's text as a number, null when empty, undefined when it is not a number from 0. */
  function amount(text) {
    const t = String(text == null ? "" : text).trim().replace(",", ".");
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }

  /** The calories the macros add up to (4 a gram of protein and carbs, 9 of fat), null when none is given. Same as the server's. */
  function kcalOf(draft) {
    const [p, c, f] = [draft.proteinG, draft.carbsG, draft.fatG].map(amount);
    if (![p, c, f].some((v) => typeof v === "number")) return null;
    return [p, c, f].some((v) => v === undefined) ? null : Math.round(4 * (p || 0) + 4 * (c || 0) + 9 * (f || 0));
  }

  /**
   * What the form holds as the fields of a food to send ({ item }), or what is wrong with it ({ error }). A field left empty
   * is left out, so the server works the calories out from the macros; with `full` (changing a food) every field is sent:
   * an empty macro is 0 and empty calories are the macros' sum.
   */
  function parseDraft(draft, full = false) {
    const name = String(draft.name || "").trim();
    if (!name) return { error: "Give the food a name." };
    const item = { name };
    for (const [key, label] of [["kcal", "Calories"], ["proteinG", "Protein"], ["carbsG", "Carbs"], ["fatG", "Fat"]]) {
      const v = amount(draft[key]);
      if (v === undefined) return { error: `${label} must be a number from 0.` };
      if (v !== null) item[key] = v;
    }
    if (item.kcal === undefined && item.proteinG === undefined && item.carbsG === undefined && item.fatG === undefined) return { error: "Give the calories or at least one macro." };
    if (full) {
      for (const key of ["proteinG", "carbsG", "fatG"]) if (item[key] === undefined) item[key] = 0;
      if (item.kcal === undefined) item.kcal = kcalOf(item);
    }
    return { item };
  }

  const text = (v) => (valid(v) ? String(v) : "");
  /** The form fields (as text) for a food already logged, to change it. */
  const draftOf = (entry) => ({ name: entry.name, kcal: text(entry.kcal), proteinG: text(entry.proteinG), carbsG: text(entry.carbsG), fatG: text(entry.fatG) });
  const EMPTY_DRAFT = () => ({ name: "", kcal: "", proteinG: "", carbsG: "", fatG: "" });

  /** The food used lately by this name (any case), to fill the form in again; null when there is none. */
  function recentMatch(recent, name) {
    const key = String(name || "").trim().toLowerCase();
    return key ? (recent || []).find((r) => r.name.toLowerCase() === key) || null : null;
  }

  return { MEAL_LABELS, mealLabel, kcal, grams, signed, macros, shares, figures, averageNote, GROUPS, cell, chartDays, charts, kcalOf, parseDraft, draftOf, EMPTY_DRAFT, recentMatch };
});
