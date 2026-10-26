/*
 * nutritionModel.js — the logic of the Food view: how a meal, calories and grams are said, the figures at the top, the
 * macro shares, the fields of the daily table, the charts, and what a food form holds before it is sent.
 *
 * Pure functions on what GET /api/nutrition returns ({ today, date, day: { meals, kcal, proteinG, nutrients, ... burnedKcal, netKcal },
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

  /**
   * The nutrients beyond the macros, in the order of a Canadian Nutrition Facts table: the same list as NUTRIENTS in shared/nutrients.ts
   * (a test keeps the two equal). A food either states one or it does not: unknown is never zero, and a total says how many foods it counts.
   */
  const NUTRIENTS = [
    { key: "fiberG", label: "Fiber", unit: "g" },
    { key: "sugarsG", label: "Sugars", unit: "g" },
    { key: "satFatG", label: "Saturated fat", unit: "g" },
    { key: "transFatG", label: "Trans fat", unit: "g" },
    { key: "cholesterolMg", label: "Cholesterol", unit: "mg" },
    { key: "sodiumMg", label: "Sodium", unit: "mg" },
    { key: "potassiumMg", label: "Potassium", unit: "mg" },
    { key: "calciumMg", label: "Calcium", unit: "mg" },
    { key: "ironMg", label: "Iron", unit: "mg" },
  ];
  const NUTRIENT_KEYS = NUTRIENTS.map((n) => n.key);

  const MEAL_LABELS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snacks" };
  const mealLabel = (meal) => MEAL_LABELS[meal] || meal;

  const kcal = (v) => (valid(v) ? `${num(v)} kcal` : "–");
  /** Grams, with a decimal only when there is one: "30 g", "12.5 g". */
  const grams = (v) => (valid(v) ? `${num(v, Number.isInteger(v) ? 0 : 1)} g` : "–");
  /** A difference in calories, signed: "+250 kcal", "−300 kcal". */
  const signed = (v) => (valid(v) ? `${v > 0 ? "+" : v < 0 ? MINUS : ""}${num(Math.abs(v))} kcal` : "–");

  /** "P 30 · C 45 · F 12" for one food or a total. */
  const macros = (f) => `P ${num(f.proteinG, Number.isInteger(f.proteinG) ? 0 : 1)} · C ${num(f.carbsG, Number.isInteger(f.carbsG) ? 0 : 1)} · F ${num(f.fatG, Number.isInteger(f.fatG) ? 0 : 1)}`;

  /** An amount of a nutrient with a decimal only when there is one: "3 g", "12.5 g", "1.5 mg"; milligrams from 10 up are whole ("410 mg"), a labelled precision no one reads. */
  const nutrientAmount = (v, unit) => `${num(v, Number.isInteger(v) || (unit === "mg" && v >= 10) ? 0 : 1)} ${unit}`;

  /** "Fiber 3 g · Sodium 410 mg": the nutrients a food states, in the list's order; "" when it states none. */
  function nutrientLine(nutrients) {
    return NUTRIENTS.filter((n) => valid((nutrients || {})[n.key])).map((n) => `${n.label} ${nutrientAmount(nutrients[n.key], n.unit)}`).join(" · ");
  }

  /**
   * The tiles of a day's nutrients: one for each nutrient, "–" for one no food states. A total that counts fewer foods than the day
   * has is a lower bound, so it reads "≥ 18 g" with the note "from 4 of 6 foods". A day with nothing logged has no tiles.
   */
  function nutrientTiles(day) {
    if (!day || !day.entries) return [];
    return NUTRIENTS.map((n) => {
      const t = (day.nutrients || {})[n.key];
      if (!t) return { key: n.key, label: n.label, value: "–", note: "no food states it", partial: false };
      const partial = t.foods < day.entries;
      return { key: n.key, label: n.label, value: `${partial ? "≥ " : ""}${nutrientAmount(t.amount, n.unit)}`, note: partial ? `from ${t.foods} of ${day.entries} foods` : `from ${day.entries === 1 ? "the food" : `all ${day.entries} foods`}`, partial };
    });
  }

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
      { label: "Eaten", value: logged ? kcal(d.kcal) : "–", note: logged ? foods(d.entries) : "nothing logged" },
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
    { name: "Nutrients", fields: NUTRIENTS.map((n) => ({ key: n.key, label: n.label, unit: n.unit, nutrient: true })) },
  ];

  /** How one field of a day reads; a day nothing was logged on has no eaten numbers. */
  function cell(field, day) {
    if (field.net) return signed(day.netKcal);
    if (field.nutrient) {
      const t = day.entries && day.nutrients ? day.nutrients[field.key] : null;
      return t ? `${t.foods < day.entries ? "≥ " : ""}${nutrientAmount(t.amount, field.unit)}` : "–";
    }
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
    // a nutrient left empty is unknown: it is left out of a new food, and sent as null when changing one so that it is removed (never as 0)
    const nutrients = {};
    for (const n of NUTRIENTS) {
      const v = amount(draft[n.key]);
      if (v === undefined) return { error: `${n.label} must be a number from 0.` };
      if (v !== null) nutrients[n.key] = v;
      else if (full) nutrients[n.key] = null;
    }
    if (Object.keys(nutrients).length) item.nutrients = nutrients;
    if (full) {
      for (const key of ["proteinG", "carbsG", "fatG"]) if (item[key] === undefined) item[key] = 0;
      if (item.kcal === undefined) item.kcal = kcalOf(item);
    }
    return { item };
  }

  const text = (v) => (valid(v) ? String(v) : "");
  /** The form fields (as text) for a food already logged, to change it. */
  const draftOf = (entry) => ({ name: entry.name, kcal: text(entry.kcal), proteinG: text(entry.proteinG), carbsG: text(entry.carbsG), fatG: text(entry.fatG), ...Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, text((entry.nutrients || {})[key])])) });
  const EMPTY_DRAFT = () => ({ name: "", kcal: "", proteinG: "", carbsG: "", fatG: "", ...Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, ""])) });
  /** True when the form holds any number, the calories, a macro or a nutrient. */
  const hasNumbers = (draft) => ["kcal", "proteinG", "carbsG", "fatG", ...NUTRIENT_KEYS].some((key) => String(draft[key] == null ? "" : draft[key]).trim() !== "");
  /** True when the form holds a nutrient (so the section for them is shown open). */
  const hasNutrients = (draft) => NUTRIENT_KEYS.some((key) => String(draft[key] == null ? "" : draft[key]).trim() !== "");

  /** The food used lately by this name (any case), to fill the form in again; null when there is none. */
  function recentMatch(recent, name) {
    const key = String(name || "").trim().toLowerCase();
    return key ? (recent || []).find((r) => r.name.toLowerCase() === key) || null : null;
  }

  /** Text compared without case or accents, so "creme" finds "Crème". */
  const fold = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  /**
   * The foods used lately to offer again in a meal, each as it was logged (one tap adds it as is): the ones last logged in this meal
   * first, then the others, newest first in each. With a query, only the ones whose name holds every word of it.
   */
  function recentFor(recent, meal, query) {
    const words = fold(query).split(/\s+/).filter(Boolean);
    const found = (recent || []).filter((r) => words.every((w) => fold(r.name).includes(w)));
    return [...found.filter((r) => r.meal === meal), ...found.filter((r) => r.meal !== meal)];
  }

  /** The fields of a logged food to log it again: its name, numbers, the nutrients it states and the product it was scaled from. */
  const again = (f) => ({ name: f.name, kcal: f.kcal, proteinG: f.proteinG, carbsG: f.carbsG, fatG: f.fatG, nutrients: { ...(f.nutrients || {}) }, product: f.product || null });

  /** "3 foods", "1 food". */
  const foods = (n) => `${n} food${n === 1 ? "" : "s"}`;

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

  /** The nutrients of `grams` of a food that holds `per100` of them in 100 g; a nutrient the food does not state stays unknown (absent), and nothing is added for it. */
  function scaleNutrients(per100, grams) {
    const out = {};
    for (const key of NUTRIENT_KEYS) if (valid((per100 || {})[key])) out[key] = round1((per100[key] * grams) / 100);
    return out;
  }

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

  /**
   * What eating `amountText` (grams, or portions) of a food comes to: the grams, the calories and macros, the nutrients it states, the
   * name to log it under and the product to keep with it (so it can be changed by quantity later); null when the quantity is no number
   * or more than MAX_AMOUNT g.
   */
  function portion(food, amountText, unit) {
    const amount = parseAmount(amountText);
    if (amount === null) return null;
    const grams = amountGrams(food, amount, unit);
    if (grams > MAX_AMOUNT) return null;
    const per = unit === "portion" && food.servingG ? "portion" : "g";
    const product = { code: food.code || null, name: food.name, brand: food.brand || null, unit: unitOf(food), per100: food.per100, nutrients: food.nutrients || {}, servingG: food.servingG || null, servingText: food.servingText || null, amount, per };
    return { amount, grams, nutrition: scale(food.per100, grams), nutrients: scaleNutrients(food.nutrients, grams), name: entryName(food, amount, unit), product };
  }

  /** The tail entryName gives a food: " · 170 g", " · 2 × 30 g". */
  const QUANTITY_TAIL = / · (?:(\d+(?:\.\d+)?) × (\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)) (g|ml)$/;

  /**
   * The product a logged food was scaled from, to change its quantity: the one kept with it, or when none is kept (it was logged before
   * products were, or its numbers were corrected since), one worked out from its numbers and the quantity its name ends with
   * (" · 150 g"): exact at that quantity, within the rounding of the numbers at another, and a correction scales with it. Null for a
   * food typed in or estimated.
   */
  function productOf(entry) {
    if (entry.product) return entry.product;
    const m = QUANTITY_TAIL.exec(entry.name || "");
    if (!m) return null;
    const servingG = m[1] ? Number(m[2]) : null, amount = Number(m[1] || m[3]), grams = servingG ? amount * servingG : amount;
    if (!(grams > 0) || !(m.index > 0)) return null;
    const per100 = (v) => Math.round(((v * 100) / grams) * 100) / 100;
    const nutrients = {};
    for (const key of NUTRIENT_KEYS) if (valid((entry.nutrients || {})[key])) nutrients[key] = per100(entry.nutrients[key]);
    return { code: null, name: entry.name.slice(0, m.index), brand: null, unit: m[4], per100: { kcal: per100(entry.kcal), proteinG: per100(entry.proteinG), carbsG: per100(entry.carbsG), fatG: per100(entry.fatG) }, nutrients, servingG, servingText: null, amount, per: servingG ? "portion" : "g" };
  }

  /** What the quantity picker starts from to change a logged food scaled from `product`: the food, the quantity as text and its unit. */
  const pickOf = (product) => ({ food: { ...product, complete: true }, amount: plain(product.amount), unit: product.per });

  /** Every nutrient of a food, null for one it does not state: a change sends them all, so one the new quantity or food does not state is removed. */
  const allNutrients = (nutrients) => Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, valid((nutrients || {})[key]) ? nutrients[key] : null]));

  /** "52 kcal · P 9.5 · C 4 · F 0" per 100 g (or ml). */
  const per100Line = (food) => `${num(food.per100.kcal)} kcal · ${macros(food.per100)} per 100 ${unitOf(food)}`;
  /** A food as the results list shows it: the name and the brand. */
  const foodTitle = (food) => (brandOf(food) ? `${food.name} · ${brandOf(food)}` : food.name);

  // ── Foods estimated by AI from words and photos (the Food view's "Describe or photograph what you ate" box) ──

  /** What the server takes of a question: the same as MIN_TEXT, MAX_TEXT and MAX_PHOTOS of shared/foodAi.ts (a test keeps them equal). */
  const AI_LIMITS = { minText: 3, maxText: 1000, maxPhotos: 3 };

  /** The meal a food is most likely in at this hour (0 to 23), for when the person's words do not say: breakfast until 10, lunch until 14, a snack until 17, dinner until 22, else a snack. */
  function mealForHour(hour) {
    const h = Number(hour);
    if (!Number.isFinite(h)) return "snack";
    return h < 4 ? "snack" : h < 10 ? "breakfast" : h < 14 ? "lunch" : h < 17 ? "snack" : h < 22 ? "dinner" : "snack";
  }

  /** True when there is something to estimate: a few words (not too many), or a photo alone. Same as the server's check. */
  function canEstimate(text, photoCount) {
    const n = String(text == null ? "" : text).trim().length;
    return n === 0 ? photoCount > 0 : n >= AI_LIMITS.minText && n <= AI_LIMITS.maxText;
  }

  /** What 100 g (or ml) can hold, as the server's parseProduct checks it: a gram of anything is at most 100 g, and fat is at most 9 kcal a gram. */
  const PER_100_MAX = { kcal: 950, g: 100, mg: 40000 };

  /**
   * An estimated food ({ name, amount, unit, kcal, proteinG, carbsG, fatG, nutrients } for the amount eaten) as a Food holding its
   * numbers per 100 g (or ml), so the grams box and the log work as for a food found on Open Food Facts: portion() scales it and gives the
   * name and the product kept with the entry. Null when the numbers cannot be per 100 g (the server would refuse the product): the row
   * is then logged as estimated, with no quantity to change.
   */
  function aiFood(item) {
    const amount = Number(item.amount);
    if (!(amount > 0)) return null;
    const per = (v) => Math.round(((Number(v) * 100) / amount) * 100) / 100;
    const per100 = { kcal: per(item.kcal), proteinG: per(item.proteinG), carbsG: per(item.carbsG), fatG: per(item.fatG) };
    const nutrients = {};
    for (const n of NUTRIENTS) {
      const v = (item.nutrients || {})[n.key];
      if (valid(v)) nutrients[n.key] = per(v);
    }
    if (![per100.kcal, per100.proteinG, per100.carbsG, per100.fatG].every(valid)) return null;
    if (per100.kcal > PER_100_MAX.kcal || [per100.proteinG, per100.carbsG, per100.fatG].some((v) => v > PER_100_MAX.g)) return null;
    if (NUTRIENTS.some((n) => valid(nutrients[n.key]) && nutrients[n.key] > PER_100_MAX[n.unit])) return null;
    return { code: null, name: item.name, brand: null, per100, nutrients, complete: true, unit: item.unit === "ml" ? "ml" : "g", servingG: null, servingText: null };
  }

  /** The rows of an estimate to check before logging: each estimated food with its Food, the amount as the text of the grams box and its meal. */
  const aiRows = (items) => (items || []).map((item) => ({ item, food: aiFood(item), amount: plain(item.amount), meal: item.meal }));

  /**
   * What a row comes to at its amount: { grams, nutrition, nutrients, name, product }, as portion() gives it. A row with no Food keeps the
   * numbers it was estimated with (and logs them with no product). Null when the amount is no number above 0 or more than MAX_AMOUNT.
   */
  function aiRowValue(row) {
    if (row.food) return portion(row.food, row.amount, "g");
    const i = row.item;
    return { grams: i.amount, nutrition: { kcal: i.kcal, proteinG: i.proteinG, carbsG: i.carbsG, fatG: i.fatG }, nutrients: i.nutrients || {}, name: entryName({ name: i.name, brand: null, unit: i.unit }, i.amount, "g"), product: null };
  }

  /** The rows by meal, in the day's order, only the meals that have rows: [{ meal, rows }]. */
  const aiGroups = (rows) => Object.keys(MEAL_LABELS).map((meal) => ({ meal, rows: rows.filter((r) => r.meal === meal) })).filter((g) => g.rows.length);

  /** The calories and macros of the rows that have a good amount, summed. */
  function aiTotals(rows) {
    const t = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
    for (const row of rows) {
      const v = aiRowValue(row);
      if (!v) continue;
      for (const key of Object.keys(t)) t[key] += v.nutrition[key];
    }
    return { kcal: Math.round(t.kcal), proteinG: round1(t.proteinG), carbsG: round1(t.carbsG), fatG: round1(t.fatG) };
  }

  /** "≈ 306 kcal · P 15 · C 16 · F 21": an estimate's numbers, marked as estimates. */
  const approx = (t) => `≈ ${kcal(t.kcal)} · ${macros(t)}`;

  /** The foods to send to POST /api/nutrition ({ items }, each with its own meal), or what is wrong ({ error }): a row whose amount is no good cannot be logged. */
  function aiItems(rows) {
    if (!rows.length) return { error: "There is nothing to log." };
    const items = [];
    for (const row of rows) {
      const v = aiRowValue(row);
      if (!v) return { error: `Give ${row.item.name} an amount above 0 (up to ${MAX_AMOUNT}).` };
      items.push({ name: v.name, ...v.nutrition, nutrients: v.nutrients, product: v.product, meal: row.meal });
    }
    return { items };
  }

  return { AI_LIMITS, mealForHour, canEstimate, aiFood, aiRows, aiRowValue, aiGroups, aiTotals, approx, aiItems, gtinOk, expandUpcE, normalizeBarcode, MAX_AMOUNT, parseAmount, amountGrams, scale, brandOf, entryName, portion, productOf, pickOf, allNutrients, per100Line, foodTitle, MEAL_LABELS, mealLabel, kcal, grams, signed, macros, shares, figures, averageNote, GROUPS, cell, chartDays, charts, kcalOf, parseDraft, draftOf, EMPTY_DRAFT, hasNumbers, hasNutrients, recentMatch, recentFor, again, foods, NUTRIENTS, nutrientLine, nutrientTiles, scaleNutrients };
});
