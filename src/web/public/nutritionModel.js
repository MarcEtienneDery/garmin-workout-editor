(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./recoveryModel.js") : root.RecoveryModel);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NutritionModel = api;
})(typeof self !== "undefined" ? self : this, function (RM) {
  "use strict";

  const { num, valid } = RM;
  const MINUS = "−";

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
  const grams = (v) => (valid(v) ? `${num(v, Number.isInteger(v) ? 0 : 1)} g` : "–");
  const signed = (v) => (valid(v) ? `${v > 0 ? "+" : v < 0 ? MINUS : ""}${num(Math.abs(v))} kcal` : "–");

  const macros = (f) => `P ${num(f.proteinG, Number.isInteger(f.proteinG) ? 0 : 1)} · C ${num(f.carbsG, Number.isInteger(f.carbsG) ? 0 : 1)} · F ${num(f.fatG, Number.isInteger(f.fatG) ? 0 : 1)}`;

  const nutrientAmount = (v, unit) => `${num(v, Number.isInteger(v) || (unit === "mg" && v >= 10) ? 0 : 1)} ${unit}`;

  function nutrientLine(nutrients) {
    return NUTRIENTS.filter((n) => valid((nutrients || {})[n.key])).map((n) => `${n.label} ${nutrientAmount(nutrients[n.key], n.unit)}`).join(" · ");
  }

  function nutrientTiles(day) {
    if (!day || !day.entries) return [];
    return NUTRIENTS.map((n) => {
      const t = (day.nutrients || {})[n.key];
      if (!t) return { key: n.key, label: n.label, value: "–", note: "no food states it", partial: false };
      const partial = t.foods < day.entries;
      return { key: n.key, label: n.label, value: `${partial ? "≥ " : ""}${nutrientAmount(t.amount, n.unit)}`, note: partial ? `from ${t.foods} of ${day.entries} foods` : `from ${day.entries === 1 ? "the food" : `all ${day.entries} foods`}`, partial };
    });
  }

  function shares(t) {
    const p = (t.proteinG || 0) * 4, c = (t.carbsG || 0) * 4, f = (t.fatG || 0) * 9, all = p + c + f;
    if (!(all > 0)) return null;
    const protein = Math.round((p / all) * 100), carbs = Math.round((c / all) * 100);
    return { protein, carbs, fat: Math.max(0, 100 - protein - carbs) };
  }

  const hasBurn = (view) => !view || view.burn !== false;

  function figures(view) {
    const d = view.day, logged = d.entries > 0, today = d.day === view.today;
    const s = shares(d);
    const net = d.netKcal;
    const kp = (view.progress || []).find((p) => p.key === "kcal");
    const eaten = { label: "Eaten", value: logged ? kcal(d.kcal) : "–", note: logged ? (kp ? `of ${num(kp.goal)}${kp.adjust && kp.adjust.added ? ` (+${num(kp.adjust.added)} burned)` : ""} · ${goalNote(kp, d.entries)}` : foods(d.entries)) : "nothing logged" };
    const burn = [
      { label: "Burned", value: kcal(d.burnedKcal), note: d.burnedKcal === null ? "no day summary from Garmin" : today ? "so far today, by Garmin" : "by Garmin" },
      { label: "Eaten − burned", value: signed(net), note: net === null ? (logged ? "needs the day's burn" : "needs a logged day") : `${net > 0 ? "above" : net < 0 ? "below" : "at"} what the day burned${today ? " so far" : ""}` },
    ];
    const macro = { label: "Macros", value: logged ? macros(d) : "–", note: s ? `${s.protein} % protein · ${s.carbs} % carbs · ${s.fat} % fat` : "grams a day" };
    return [eaten, ...(hasBurn(view) ? burn : []), macro];
  }

  function averageNote(average) {
    if (!average) return "";
    return `Average of ${average.days} logged day${average.days === 1 ? "" : "s"}: ${kcal(average.kcal)} · ${macros(average)}`;
  }


  const g = (key, label) => ({ key, label, grams: true });
  const GROUPS = [
    { name: "Eaten", fields: [{ key: "kcal", label: "Calories", unit: " kcal" }, g("proteinG", "Protein"), g("carbsG", "Carbs"), g("fatG", "Fat")] },
    { name: "Garmin", fields: [{ key: "burnedKcal", label: "Burned", unit: " kcal" }, { key: "netKcal", label: "Eaten − burned", net: true }] },
    { name: "Nutrients", fields: NUTRIENTS.map((n) => ({ key: n.key, label: n.label, unit: n.unit, nutrient: true })) },
  ];

  const groupsFor = (view) => (hasBurn(view) ? GROUPS : GROUPS.filter((group) => group.name !== "Garmin"));

  function cell(field, day) {
    if (field.net) return signed(day.netKcal);
    if (field.nutrient) {
      const t = day.entries && day.nutrients ? day.nutrients[field.key] : null;
      return t ? `${t.foods < day.entries ? "≥ " : ""}${nutrientAmount(t.amount, field.unit)}` : "–";
    }
    if (!day.entries && !/^burned/.test(field.key)) return "–";
    return field.grams ? grams(day[field.key]) : num(day[field.key], 0, field.unit || "");
  }

  const chartDays = (days) => days.map((d) => (d.entries ? d : { ...d, kcal: null, proteinG: null, carbsG: null, fatG: null }));

  const TARGET_TOLERANCE = 0.1;

  function standing(kind, amount, goal) {
    const ratio = amount / goal;
    if (kind === "min") return ratio >= 1 ? "ok" : "short";
    if (kind === "max") return ratio > 1 ? "over" : "ok";
    return ratio < 1 - TARGET_TOLERANCE ? "short" : ratio > 1 + TARGET_TOLERANCE ? "over" : "ok";
  }

  function standingLine(days, today, standOf, { good, words }) {
    const done = days.filter((d) => d.day !== today).map(standOf).filter(Boolean);
    if (!done.length) return "";
    const count = (s) => done.filter((x) => x === s).length;
    const parts = [`${count("ok")} of ${done.length} finished days ${good}`];
    if (words.over && count("over")) parts.push(`${count("over")} ${words.over}`);
    if (words.short && count("short")) parts.push(`${count("short")} ${words.short}`);
    return parts.join(" · ");
  }


  const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
  const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function weekStrip(view) {
    if (!view || !Array.isArray(view.week)) return [];
    const goals = view.goals || {}, follows = valid(goals.kcal) && valid(goals.kcalBurnPct);
    return view.week.map((w) => {
      const wd = weekdayOf(w.day), future = w.day > view.today, logged = !future && w.entries > 0;
      const goal = valid(goals.kcal) ? (follows ? w.kcalGoal : goals.kcal) : null, known = logged && valid(goal) && goal > 0;
      const over = known && w.kcal > goal * (1 + TARGET_TOLERANCE);
      const state = future ? "future" : !logged ? "none" : over ? "over" : "ok";
      const when = `${WEEKDAY_NAMES[wd]} ${Number(w.day.slice(8))} ${MONTH_SHORT[Number(w.day.slice(5, 7)) - 1]}`;
      return {
        day: w.day, weekday: WEEKDAY_NAMES[wd].slice(0, 3), number: Number(w.day.slice(8)), kcal: logged ? w.kcal : null, text: logged ? num(w.kcal) : "–", state,
        pct: known ? Math.min(1, w.kcal / goal) : null, today: w.day === view.today, selected: w.day === view.date,
        label: `${when}, ${future ? "not yet" : logged ? `${num(w.kcal)} kcal${over ? ", over the goal" : ""}` : "nothing logged"}`,
      };
    });
  }

  const finishedDays = (view) => ((view && view.days) || []).filter((d) => d.day !== view.today && d.entries > 0 && valid(d.kcal));
  const meanOf = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

  function insightTiles(view) {
    const days = finishedDays(view), goals = (view && view.goals) || {};
    if (!days.length) return [];
    const n = days.length, follows = valid(goals.kcal) && valid(goals.kcalBurnPct);
    const tiles = [{ label: `Average · ${n} day${n === 1 ? "" : "s"}`, value: num(Math.round(meanOf(days.map((d) => d.kcal)))), note: valid(goals.kcal) ? `kcal a day · goal ${num(goals.kcal)}` : "kcal a day" }];
    if (valid(goals.kcal)) {
      const over = days.filter((d) => { const goal = follows ? d.kcalGoal : goals.kcal; return valid(goal) && goal > 0 && d.kcal > goal * (1 + TARGET_TOLERANCE); }).length;
      tiles.push({ label: "On target", value: `${n - over} of ${n}`, note: over ? `days · ${over} over the goal` : "days · none over the goal" });
    }
    const protein = days.filter((d) => valid(d.proteinG));
    if (protein.length) {
      const reached = valid(goals.proteinG) ? protein.filter((d) => d.proteinG >= goals.proteinG).length : null;
      tiles.push({ label: "Protein", value: `${num(Math.round(meanOf(protein.map((d) => d.proteinG))))} g`, note: reached === null ? "a day" : `a day · goal ${num(goals.proteinG)} · reached ${reached} of ${protein.length}` });
    }
    const burned = days.filter((d) => valid(d.burnedKcal) && !d.burnedSoFar);
    if (burned.length >= 3) tiles.push({ label: "Eaten vs burned", value: signed(Math.round(meanOf(burned.map((d) => d.kcal - d.burnedKcal)))), note: "kcal a day, on average" });
    return tiles;
  }

  function weekdayPattern(view) {
    const days = finishedDays(view), rows = [1, 2, 3, 4, 5, 6, 0].map((wd) => {
      const mine = days.filter((d) => weekdayOf(d.day) === wd), protein = mine.filter((d) => valid(d.proteinG));
      return { wd, short: WEEKDAY_NAMES[wd][0], name: WEEKDAY_NAMES[wd], plural: `${WEEKDAY_NAMES[wd]}s`, n: mine.length, kcal: mine.length >= 2 ? Math.round(meanOf(mine.map((d) => d.kcal))) : null, proteinG: protein.length >= 2 ? Math.round(meanOf(protein.map((d) => d.proteinG))) : null };
    });
    const known = rows.filter((r) => r.kcal !== null);
    if (known.length < 3) return null;
    const hi = known.reduce((a, b) => (b.kcal > a.kcal ? b : a)), lo = known.reduce((a, b) => (b.kcal < a.kcal ? b : a));
    const parts = [];
    if (hi.kcal - lo.kcal >= lo.kcal * 0.1) parts.push(`${hi.plural} average ${num(hi.kcal)} kcal, ${num(hi.kcal - lo.kcal)} more than ${lo.plural}.`);
    const withProtein = rows.filter((r) => r.proteinG !== null);
    if (withProtein.length >= 3) {
      const all = meanOf(withProtein.map((r) => r.proteinG)), low = withProtein.reduce((a, b) => (b.proteinG < a.proteinG ? b : a));
      if (low.proteinG < all * 0.85) parts.push(`Protein is lowest on ${low.plural} (${low.proteinG} g).`);
    }
    return { rows, sentence: parts.join(" "), peak: Math.max(...known.map((r) => r.kcal)) };
  }

  function charts(view) {
    const burn = hasBurn(view), goals = (view && view.goals) || {}, today = view && view.today;
    const against = (key, unit) => (valid(goals[key]) ? { goal: { label: `Goal ${num(goals[key])} ${unit}`, value: goals[key] } } : {});
    const follows = valid(goals.kcal) && valid(goals.kcalBurnPct);
    const kcalLimit = (d) => (follows ? d.kcalGoal : goals.kcal);
    const kcalStands = (d) => (valid(goals.kcal) && valid(d.kcal) && valid(kcalLimit(d)) && kcalLimit(d) > 0 ? (standing("target", d.kcal, kcalLimit(d)) === "over" ? "over" : "ok") : null);
    const kcalGoal = follows ? { goal: { label: `Goal ${num(goals.kcal)} kcal + ${num(goals.kcalBurnPct)} % of active`, values: (d) => d.kcalGoal } } : against("kcal", "kcal");
    return [
      {
        id: "eaten", title: "Calories eaten", unit: "kcal", kind: "bars", min: 0, ticks: 6, value: (d) => d.kcal,
        ...(valid(goals.kcal) ? { color: (d) => (kcalStands(d) === "over" ? "over" : ""), colorKeys: { over: "Over the goal" }, summary: (days) => standingLine(days, today, kcalStands, { good: "on target", words: { over: "over" } }) } : {}), ...(burn ? { ref: { label: "Burned by Garmin", value: (d) => d.burnedKcal } } : {}), ...kcalGoal,
        read: (d) => (valid(d.kcal) ? `${num(d.kcal)} kcal${burn && valid(d.burnedKcal) ? ` · burned ${num(d.burnedKcal)}` : ""}${follows && valid(d.kcalGoal) ? ` · goal ${num(d.kcalGoal)}` : ""}${kcalStands(d) === "over" ? " · over the goal" : ""}` : "not logged"),
      },
      {
        id: "macros", title: "Macros", unit: "g", kind: "stack", min: 0, ticks: 4, scaleBy: 1,
        parts: [{ key: "proteinG", label: "Protein", cls: "protein" }, { key: "carbsG", label: "Carbs", cls: "carbs" }, { key: "fatG", label: "Fat", cls: "fat" }],
        read: (d) => (valid(d.kcal) ? macros(d) : "not logged"),
      },
      ...(valid(goals.proteinG) ? [{ id: "protein", title: "Protein", unit: "g", kind: "bars", min: 0, ticks: 4, value: (d) => d.proteinG, color: () => "protein", summary: (days) => standingLine(days, today, (d) => (valid(d.proteinG) ? standing("min", d.proteinG, goals.proteinG) : null), { good: `reached ${num(goals.proteinG)} g`, words: {} }), ...against("proteinG", "g"), read: (d) => (valid(d.proteinG) ? `${grams(d.proteinG)} · ${num((d.proteinG / goals.proteinG) * 100)} % of the goal` : "not logged") }] : []),
    ];
  }


  const bare = (v, unit) => num(v, unit === "kcal" || Number.isInteger(v) || (unit === "mg" && v >= 10) ? 0 : 1);
  const qty = (v, unit) => `${bare(v, unit)} ${unit}`;

  const goalValue = (p) => `${p.amount === null ? "–" : `${p.partial ? "≥ " : ""}${bare(p.amount, p.unit)}`} / ${qty(p.goal, p.unit)}`;

  function goalNote(p, entries) {
    if (p.state === "unknown" || p.left === null) return entries ? "no food states it" : "nothing logged";
    const rest = qty(Math.abs(p.left), p.unit), some = p.partial ? "up to " : "";
    if (p.state === "over") return `▲ over by ${p.partial ? "at least " : ""}${rest}`;
    if (p.kind === "max") return `${some}${rest} left`;
    if (p.state === "ok") return p.kind === "min" ? "✓ reached" : "✓ on target";
    return `${some}${rest} to go`;
  }

  function goalMeter(p) {
    if (p.amount === null) return null;
    const top = Math.max(p.goal, p.amount);
    return { fill: (p.amount / top) * 100, tick: p.amount > p.goal ? (p.goal / top) * 100 : null };
  }

  const MACRO_KCAL = { protein: 4, carbs: 4, fat: 9 };
  const MACRO_KEYS = [["protein", "proteinG", "Protein"], ["carbs", "carbsG", "Carbs"], ["fat", "fatG", "Fat"]];

  function calorieBar(day, goal) {
    if (!day.entries) return null;
    const parts = MACRO_KEYS.map(([cls, key, label]) => ({ cls, label, kcal: (day[key] || 0) * MACRO_KCAL[cls], grams: day[key] || 0 })), sum = parts.reduce((t, x) => t + x.kcal, 0);
    const top = Math.max(valid(goal) ? goal : 0, day.kcal) || 1, scale = day.kcal / top;
    const segments = sum > 0 ? parts.filter((x) => x.kcal > 0).map((x) => ({ ...x, width: (x.kcal / sum) * scale * 100 })) : [{ cls: "kcal", label: "Calories", kcal: day.kcal, grams: 0, width: scale * 100 }];
    return { segments, tick: valid(goal) && day.kcal > goal ? (goal / top) * 100 : null };
  }

  function calorieGoal(view) {
    const kp = (view.progress || []).find((p) => p.key === "kcal");
    return kp ? kp.goal : (view.goals || {}).kcal;
  }

  function goalLine(view) {
    const kp = (view.progress || []).find((p) => p.key === "kcal"), a = kp && kp.adjust;
    if (!a) return "";
    if (a.added === null) return `Goal ${qty(a.base, "kcal")} as set: no burn from Garmin for this day to add to it`;
    return `Goal ${qty(kp.goal, "kcal")} = ${num(a.base)} set + ${num(a.added)} (${num(a.pct)} % of ${num(a.activeKcal)} active kcal burned${view.day.day === view.today ? " so far" : ""})`;
  }

  function ring(view) {
    const d = view.day, kp = (view.progress || []).find((p) => p.key === "kcal"), goal = kp ? ` · goal ${qty(kp.goal, "kcal")}` : "";
    if (!d.entries) return { big: "–", small: kp ? `of ${qty(kp.goal, "kcal")}` : "kcal", state: "unknown", line: `Nothing logged${goal}`, label: `Nothing logged${goal}`, short: `Nothing logged${goal}` };
    const eaten = `${num(d.kcal)} kcal eaten`;
    if (!kp || kp.left === null) return { big: num(d.kcal), small: "kcal eaten", state: "none", line: foods(d.entries), label: eaten, short: eaten };
    const over = kp.left < 0, rest = `${num(Math.abs(kp.left))} kcal ${over ? "over" : "left"}`;
    return { big: num(Math.abs(kp.left)), small: over ? "kcal over" : "kcal left", state: kp.state, line: `${eaten}${goal}`, label: `${eaten} · ${rest}${goal}`, short: `${num(d.kcal)} / ${qty(kp.goal, "kcal")} · ${num(Math.abs(kp.left))} ${over ? "over" : "left"}` };
  }

  function burnLine(view) {
    const d = view.day;
    if (!hasBurn(view) || d.burnedKcal === null || d.burnedKcal === undefined) return "";
    return `Burned ${kcal(d.burnedKcal)}${d.day === view.today ? " so far" : ""} by Garmin${d.netKcal === null ? "" : ` · eaten − burned ${signed(d.netKcal)}`}`;
  }

  function macroRows(view) {
    const d = view.day, byKey = Object.fromEntries((view.progress || []).map((p) => [p.key, p]));
    return MACRO_KEYS.map(([cls, key, label]) => {
      const p = byKey[key];
      if (p) return { cls, key, label, value: goalValue(p), note: goalNote(p, d.entries), meter: goalMeter(p), state: p.state, kind: p.kind };
      return { cls, key, label, value: d.entries ? grams(d[key]) : "–", note: "", meter: null, state: "none", kind: null };
    });
  }

  function sharesLine(day) {
    const s = shares(day);
    return s ? `${s.protein} % protein · ${s.carbs} % carbs · ${s.fat} % fat of the macros' calories` : "";
  }

  function mealBars(view) {
    const d = view.day, goal = calorieGoal(view), blocks = d.meals || [], top = Math.max(0, ...blocks.map((b) => b.totals.kcal));
    return blocks.map((b) => {
      const t = b.totals, logged = t.entries > 0, parts = MACRO_KEYS.map(([cls, key, label]) => ({ cls, label, kcal: t[key] * MACRO_KCAL[cls] })), sum = parts.reduce((x, y) => x + y.kcal, 0);
      const base = valid(goal) ? goal : d.kcal;
      return {
        meal: b.meal, label: mealLabel(b.meal), logged,
        value: logged ? kcal(t.kcal) : "–",
        note: logged ? `${macros(t)}` : "nothing logged",
        share: logged && base > 0 ? Math.round((t.kcal / base) * 100) : null,
        shareOf: valid(goal) ? "of the goal" : "of the day",
        width: logged && top > 0 ? (t.kcal / top) * 100 : 0,
        segments: sum > 0 ? parts.filter((x) => x.kcal > 0).map((x) => ({ ...x, width: (x.kcal / sum) * 100 })) : logged ? [{ cls: "kcal", label: "Calories", kcal: t.kcal, width: 100 }] : [],
      };
    });
  }

  function nutrientRows(view) {
    const d = view.day, keys = new Set(NUTRIENT_KEYS), withGoal = (view.progress || []).filter((p) => keys.has(p.key));
    const goalRows = withGoal.map((p) => ({ key: p.key, label: p.label, value: goalValue(p), note: goalNote(p, d.entries), meter: goalMeter(p), state: p.state, kind: p.kind, partial: p.partial, goal: true }));
    const have = new Set(withGoal.map((p) => p.key));
    const rest = nutrientTiles(d).filter((t) => !have.has(t.key)).map((t) => ({ key: t.key, label: t.label, value: t.value, note: t.note, meter: null, state: "none", kind: null, partial: t.partial, goal: false }));
    return [...goalRows, ...rest];
  }

  const KIND_LABELS = { min: "at least", max: "at most", target: "the aim", burn: "100" };
  const kindLabel = (kind) => KIND_LABELS[kind] || "";



  function amount(text) {
    const t = String(text == null ? "" : text).trim().replace(",", ".");
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }

  function kcalOf(draft) {
    const [p, c, f] = [draft.proteinG, draft.carbsG, draft.fatG].map(amount);
    if (![p, c, f].some((v) => typeof v === "number")) return null;
    return [p, c, f].some((v) => v === undefined) ? null : Math.round(4 * (p || 0) + 4 * (c || 0) + 9 * (f || 0));
  }

  function followMacros(draft) {
    draft.fromMacros = ["proteinG", "carbsG", "fatG"].some((key) => String(draft[key] == null ? "" : draft[key]).trim() !== "");
    const k = draft.fromMacros ? kcalOf(draft) : null;
    draft.kcal = k === null ? "" : String(k);
    return draft;
  }

  function parseDraft(draft, full = false) {
    const name = String(draft.name || "").trim();
    if (!name) return { error: "Give the food a name." };
    const item = { name };
    for (const [key, label] of [["kcal", "Calories"], ["proteinG", "Protein"], ["carbsG", "Carbs"], ["fatG", "Fat"]]) {
      const v = key === "kcal" && draft.fromMacros ? null : amount(draft[key]);
      if (v === undefined) return { error: `${label} must be a number from 0.` };
      if (v !== null) item[key] = v;
    }
    if (item.kcal === undefined && item.proteinG === undefined && item.carbsG === undefined && item.fatG === undefined) return { error: "Give the calories or at least one macro." };
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
  const draftOf = (entry) => ({ name: entry.name, kcal: text(entry.kcal), proteinG: text(entry.proteinG), carbsG: text(entry.carbsG), fatG: text(entry.fatG), ...Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, text((entry.nutrients || {})[key])])) });
  const EMPTY_DRAFT = () => ({ name: "", kcal: "", proteinG: "", carbsG: "", fatG: "", ...Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, ""])) });
  const hasNumbers = (draft) => ["kcal", "proteinG", "carbsG", "fatG", ...NUTRIENT_KEYS].some((key) => String(draft[key] == null ? "" : draft[key]).trim() !== "");
  const hasNutrients = (draft) => NUTRIENT_KEYS.some((key) => String(draft[key] == null ? "" : draft[key]).trim() !== "");

  function recentMatch(recent, name) {
    const key = String(name || "").trim().toLowerCase();
    return key ? (recent || []).find((r) => r.name.toLowerCase() === key) || null : null;
  }

  const fold = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  function recentFor(recent, meal, query) {
    const words = fold(query).split(/\s+/).filter(Boolean);
    const found = (recent || []).filter((r) => words.every((w) => fold(r.name).includes(w)));
    return [...found.filter((r) => r.meal === meal), ...found.filter((r) => r.meal !== meal)];
  }

  const again = (f) => ({ name: f.name, kcal: f.kcal, proteinG: f.proteinG, carbsG: f.carbsG, fatG: f.fatG, nutrients: { ...(f.nutrients || {}) }, product: f.product || null });

  const foods = (n) => `${n} food${n === 1 ? "" : "s"}`;


  function gtinOk(code) {
    if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
    let sum = 0;
    for (let i = code.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += Number(code[i]) * w;
    return (10 - (sum % 10)) % 10 === Number(code[code.length - 1]);
  }

  function expandUpcE(code) {
    if (!/^[01]\d{7}$/.test(code)) return null;
    const n = code[0], x = code.slice(1, 7), check = code[7], last = Number(x[5]);
    const body = last <= 2 ? `${n}${x.slice(0, 2)}${x[5]}0000${x.slice(2, 5)}` : last === 3 ? `${n}${x.slice(0, 3)}00000${x.slice(3, 5)}` : last === 4 ? `${n}${x.slice(0, 4)}00000${x[4]}` : `${n}${x.slice(0, 5)}0000${x[5]}`;
    const full = body + check;
    return gtinOk(full) ? full : null;
  }

  function normalizeBarcode(text) {
    const code = String(text == null ? "" : text).replace(/[\s-]/g, "");
    if (!/^\d{8,14}$/.test(code)) return null;
    if (code.length === 8) return gtinOk(code) ? code : expandUpcE(code);
    return gtinOk(code) ? code : null;
  }


  const MAX_AMOUNT = 2000;
  function parseAmount(text) {
    const n = Number(String(text == null ? "" : text).trim().replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  const round1 = (v) => Math.round(v * 10) / 10;
  const amountGrams = (food, amount, unit) => (unit === "portion" && food.servingG ? amount * food.servingG : amount);
  const scale = (per100, grams) => ({ kcal: Math.round((per100.kcal * grams) / 100), proteinG: round1((per100.proteinG * grams) / 100), carbsG: round1((per100.carbsG * grams) / 100), fatG: round1((per100.fatG * grams) / 100) });

  function scaleNutrients(per100, grams) {
    const out = {};
    for (const key of NUTRIENT_KEYS) if (valid((per100 || {})[key])) out[key] = round1((per100[key] * grams) / 100);
    return out;
  }

  const brandOf = (food) => (food.brand && !food.name.toLowerCase().includes(food.brand.toLowerCase()) ? food.brand : "");

  const unitOf = (food) => (food.unit === "ml" ? "ml" : "g");
  const plain = (v) => String(round1(v));
  function entryName(food, amount, unit) {
    const base = brandOf(food) ? `${food.name} (${brandOf(food)})` : food.name;
    const tail = unit === "portion" && food.servingG ? ` · ${plain(amount)} × ${plain(food.servingG)} ${unitOf(food)}` : ` · ${plain(amount)} ${unitOf(food)}`;
    return base.length + tail.length <= 120 ? base + tail : `${base.slice(0, 120 - tail.length - 1).trimEnd()}…${tail}`;
  }

  function portion(food, amountText, unit) {
    const amount = parseAmount(amountText);
    if (amount === null) return null;
    const grams = amountGrams(food, amount, unit);
    if (grams > MAX_AMOUNT) return null;
    const per = unit === "portion" && food.servingG ? "portion" : "g";
    const product = { code: food.code || null, name: food.name, brand: food.brand || null, unit: unitOf(food), per100: food.per100, nutrients: food.nutrients || {}, servingG: food.servingG || null, servingText: food.servingText || null, amount, per };
    return { amount, grams, nutrition: scale(food.per100, grams), nutrients: scaleNutrients(food.nutrients, grams), name: entryName(food, amount, unit), product };
  }

  const QUANTITY_TAIL = / · (?:(\d+(?:\.\d+)?) × (\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)) (g|ml)$/;

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

  const pickOf = (product) => ({ food: { ...product, complete: true }, amount: plain(product.amount), unit: product.per });

  const allNutrients = (nutrients) => Object.fromEntries(NUTRIENT_KEYS.map((key) => [key, valid((nutrients || {})[key]) ? nutrients[key] : null]));

  const per100Line = (food) => `${num(food.per100.kcal)} kcal · ${macros(food.per100)} per 100 ${unitOf(food)}`;
  const foodTitle = (food) => (brandOf(food) ? `${food.name} · ${brandOf(food)}` : food.name);


  const AI_LIMITS = { minText: 3, maxText: 1000, maxPhotos: 3 };

  function mealForHour(hour) {
    const h = Number(hour);
    if (!Number.isFinite(h)) return "snack";
    return h < 4 ? "snack" : h < 10 ? "breakfast" : h < 14 ? "lunch" : h < 17 ? "snack" : h < 22 ? "dinner" : "snack";
  }

  function canEstimate(text, photoCount) {
    const n = String(text == null ? "" : text).trim().length;
    return n === 0 ? photoCount > 0 : n >= AI_LIMITS.minText && n <= AI_LIMITS.maxText;
  }

  const PER_100_MAX = { kcal: 950, g: 100, mg: 40000 };

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

  const aiRows = (items) => (items || []).map((item) => ({ item, food: aiFood(item), amount: plain(item.amount), meal: item.meal }));

  function aiRowValue(row) {
    if (row.food) return portion(row.food, row.amount, "g");
    const i = row.item;
    return { grams: i.amount, nutrition: { kcal: i.kcal, proteinG: i.proteinG, carbsG: i.carbsG, fatG: i.fatG }, nutrients: i.nutrients || {}, name: entryName({ name: i.name, brand: null, unit: i.unit }, i.amount, "g"), product: null };
  }

  const aiGroups = (rows) => Object.keys(MEAL_LABELS).map((meal) => ({ meal, rows: rows.filter((r) => r.meal === meal) })).filter((g) => g.rows.length);

  function aiTotals(rows) {
    const t = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
    for (const row of rows) {
      const v = aiRowValue(row);
      if (!v) continue;
      for (const key of Object.keys(t)) t[key] += v.nutrition[key];
    }
    return { kcal: Math.round(t.kcal), proteinG: round1(t.proteinG), carbsG: round1(t.carbsG), fatG: round1(t.fatG) };
  }

  const approx = (t) => `≈ ${kcal(t.kcal)} · ${macros(t)}`;

  const CONFIDENCE_LABELS = { low: "Low", medium: "Medium", high: "High" };

  function aiConfidence(level, improve) {
    const known = Object.prototype.hasOwnProperty.call(CONFIDENCE_LABELS, level) ? level : null, tip = String(improve == null ? "" : improve).trim();
    if (!known && !tip) return null;
    return { level: known, label: known ? `Confidence: ${CONFIDENCE_LABELS[known]}` : "", tip };
  }

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

  return { TARGET_TOLERANCE, standing, weekStrip, insightTiles, weekdayPattern, AI_LIMITS, mealForHour, canEstimate, aiFood, aiRows, aiRowValue, aiGroups, aiTotals, approx, aiConfidence, aiItems, gtinOk, expandUpcE, normalizeBarcode, MAX_AMOUNT, parseAmount, amountGrams, scale, brandOf, entryName, portion, productOf, pickOf, allNutrients, per100Line, foodTitle, MEAL_LABELS, mealLabel, kcal, grams, signed, macros, shares, hasBurn, figures, averageNote, bare, qty, goalValue, goalNote, goalMeter, calorieBar, ring, calorieGoal, goalLine, burnLine, macroRows, sharesLine, mealBars, nutrientRows, kindLabel, GROUPS, groupsFor, cell, chartDays, charts, kcalOf, followMacros, parseDraft, draftOf, EMPTY_DRAFT, hasNumbers, hasNutrients, recentMatch, recentFor, again, foods, NUTRIENTS, nutrientLine, nutrientTiles, scaleNutrients };
});
