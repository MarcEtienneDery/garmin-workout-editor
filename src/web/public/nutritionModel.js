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

  // ── Barcodes ────────────────────────────────────────────────────────────

  /** A digit string of 8, 12, 13 or 14 digits whose last digit is the GTIN check digit (alternate weights 3 and 1 from the right). */
  function gtinOk(code) {
    if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
    let sum = 0;
    for (let i = code.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += Number(code[i]) * w;
    return (10 - (sum % 10)) % 10 === Number(code[code.length - 1]);
  }

  /** The 12-digit UPC-A a UPC-E (8 digits) stands for, or null when it is not a valid one. */
  function expandUpcE(code) {
    if (!/^[01]\d{7}$/.test(code)) return null;
    const n = code[0], x = code.slice(1, 7), check = code[7], last = Number(x[5]);
    const body = last <= 2 ? `${n}${x.slice(0, 2)}${x[5]}0000${x.slice(2, 5)}` : last === 3 ? `${n}${x.slice(0, 3)}00000${x.slice(3, 5)}` : last === 4 ? `${n}${x.slice(0, 4)}00000${x[4]}` : `${n}${x.slice(0, 5)}0000${x[5]}`;
    const full = body + check;
    return gtinOk(full) ? full : null;
  }

  /** What a barcode reader or the person typed as the code to look up: digits only, with a good check digit, a UPC-E expanded; null when it is not a barcode. */
  function normalizeBarcode(text) {
    const code = String(text == null ? "" : text).replace(/[\s-]/g, "");
    if (!/^\d{8,14}$/.test(code)) return null;
    if (code.length === 8) return gtinOk(code) ? code : expandUpcE(code);
    return gtinOk(code) ? code : null;
  }

  // ── A food found by name or barcode, and how much of it was eaten ───────

  const MAX_AMOUNT = 2000;
  /** A quantity typed in (grams, or a number of portions): a number above 0, else null. */
  function parseAmount(text) {
    const n = Number(String(text == null ? "" : text).trim().replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  const round1 = (v) => Math.round(v * 10) / 10;
  /** Grams eaten: the amount typed, or portions times the portion's size (a food with no portion size has no portions). */
  const amountGrams = (food, amount, unit) => (unit === "portion" && food.servingG ? amount * food.servingG : amount);
  /** The calories and macros of `grams` of a food that holds `per100` in 100 g; liquids are taken as 1 g a ml. */
  const scale = (per100, grams) => ({ kcal: Math.round((per100.kcal * grams) / 100), proteinG: round1((per100.proteinG * grams) / 100), carbsG: round1((per100.carbsG * grams) / 100), fatG: round1((per100.fatG * grams) / 100) });

  /** The brand to show next to a food's name: none when the name has it already ("Nutella" by Nutella). */
  const brandOf = (food) => (food.brand && !food.name.toLowerCase().includes(food.brand.toLowerCase()) ? food.brand : "");

  const unitOf = (food) => (food.unit === "ml" ? "ml" : "g");
  const plain = (v) => String(round1(v));
  /** What the log calls a food that was scaled: "Greek yogurt (Chobani) · 170 g" or "· 2 × 30 g", at most 120 characters. */
  function entryName(food, amount, unit) {
    const base = brandOf(food) ? `${food.name} (${brandOf(food)})` : food.name;
    const tail = unit === "portion" && food.servingG ? ` · ${plain(amount)} × ${plain(food.servingG)} ${unitOf(food)}` : ` · ${plain(amount)} ${unitOf(food)}`;
    return base.length + tail.length <= 120 ? base + tail : `${base.slice(0, 120 - tail.length - 1).trimEnd()}…${tail}`;
  }

  /** What eating `amountText` (grams, or portions) of a food comes to: the grams, the calories and macros, and the name to log it under; null when the quantity is no number or more than MAX_AMOUNT g. */
  function portion(food, amountText, unit) {
    const amount = parseAmount(amountText);
    if (amount === null) return null;
    const grams = amountGrams(food, amount, unit);
    if (grams > MAX_AMOUNT) return null;
    return { amount, grams, nutrition: scale(food.per100, grams), name: entryName(food, amount, unit) };
  }

  /** "52 kcal · P 9.5 · C 4 · F 0" per 100 g (or ml). */
  const per100Line = (food) => `${num(food.per100.kcal)} kcal · ${macros(food.per100)} per 100 ${unitOf(food)}`;
  /** A food as the results list shows it: the name and the brand. */
  const foodTitle = (food) => (brandOf(food) ? `${food.name} · ${brandOf(food)}` : food.name);

  return { gtinOk, expandUpcE, normalizeBarcode, MAX_AMOUNT, parseAmount, amountGrams, scale, brandOf, entryName, portion, per100Line, foodTitle, MEAL_LABELS, mealLabel, kcal, grams, signed, macros, shares, figures, averageNote, GROUPS, cell, chartDays, charts, kcalOf, parseDraft, draftOf, EMPTY_DRAFT, recentMatch };
});
