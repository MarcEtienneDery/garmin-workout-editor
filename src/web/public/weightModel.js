(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./recoveryModel.js") : root.RecoveryModel);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WeightModel = api;
})(typeof self !== "undefined" ? self : this, function (RM) {
  "use strict";

  const { num, valid, shortDay, dayLabel } = RM;
  const LB_PER_KG = 2.2046226218;
  const UNITS = { lb: { label: "lb", of: (kg) => kg * LB_PER_KG }, kg: { label: "kg", of: (kg) => kg } };
  const unitOf = (name) => UNITS[name] || UNITS.lb;
  const MINUS = "−";
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  const weight = (kg, unit, digits = 1) => (valid(kg) ? `${num(unitOf(unit).of(kg), digits)} ${unitOf(unit).label}` : "–");
  function change(kg, unit, digits = 1) {
    if (!valid(kg)) return "–";
    const v = unitOf(unit).of(kg), rounds = Math.round(Math.abs(v) * 10 ** digits) === 0;
    return `${rounds ? "" : v > 0 ? "+" : MINUS}${num(Math.abs(v), digits)} ${unitOf(unit).label}`;
  }


  const kcal = (key, label) => ({ key, label, unit: " kcal" });
  const GROUPS = [
    { name: "Weigh-in", fields: [
      { key: "weightKg", label: "Weight", weight: true }, { key: "bodyFatPercent", label: "Body fat", unit: " %", digits: 1 },
      { key: "muscleKg", label: "Muscle", weight: true }, { key: "bmi", label: "BMI", digits: 1 },
    ] },
    { name: "Calories burned", fields: [kcal("totalKcal", "All day"), kcal("activeKcal", "Active"), kcal("bmrKcal", "At rest")] },
  ];

  const cell = (field, day, unit) => (field.weight ? weight(day[field.key], unit) : num(day[field.key], field.digits || 0, field.unit || ""));

  const KINDS = [{ kind: "weight", label: "Weigh-in" }, { kind: "summary", label: "Daily summary (calories)" }];


  const DAY_MS = 86_400_000;
  const STEADY_PER_WEEK_KG = 0.1, MIN_WEIGH_INS = 3, MIN_SPAN_DAYS = 7;
  const KCAL_PER_KG = 7700;
  const SWING_SIGMAS = 1.5;

  const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
  const mondayOf = (iso) => RM.addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
  const roundTo = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;
  const kgIn = (value, unit) => (unit === "kg" ? value : value / LB_PER_KG);
  const inUnit = (kg, unit) => unitOf(unit).of(kg);

  function signed(kg, unit, digits = 1) {
    if (!valid(kg)) return "–";
    const v = inUnit(kg, unit), rounds = Math.round(Math.abs(v) * 10 ** digits) === 0;
    return `${rounds ? "" : v > 0 ? "+" : MINUS}${num(Math.abs(v), digits)}`;
  }

  function fitLine(points) {
    const pts = points.filter((p) => valid(p.v)).sort((a, b) => (a.day < b.day ? -1 : 1));
    if (pts.length < MIN_WEIGH_INS) return null;
    const x0 = dayNumber(pts[0].day), span = dayNumber(pts[pts.length - 1].day) - x0;
    if (span < MIN_SPAN_DAYS) return null;
    const xs = pts.map((p) => dayNumber(p.day) - x0), ys = pts.map((p) => p.v), mx = mean(xs), my = mean(ys);
    const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0), intercept = my - slope * mx;
    const at = (day) => intercept + slope * (dayNumber(day) - x0);
    const sigma = Math.sqrt(pts.reduce((s, p) => s + (p.v - at(p.day)) ** 2, 0) / pts.length);
    return { n: pts.length, slope, perWeek: slope * 7, span, firstDay: pts[0].day, lastDay: pts[pts.length - 1].day, at, sigma, swing: SWING_SIGMAS * sigma };
  }

  const weightPoints = (days) => days.filter((d) => valid(d.weightKg)).map((d) => ({ day: d.day, v: d.weightKg }));

  function trendOf(days) {
    const points = weightPoints(days), fit = fitLine(points);
    const base = { weighIns: points.length, perWeekKg: null, changeKg: null, direction: null, fit };
    if (!fit) return base;
    const perWeekKg = roundTo(fit.slope * 7, 2);
    return { ...base, perWeekKg, changeKg: roundTo(fit.slope * fit.span, 1), direction: Math.abs(perWeekKg) < STEADY_PER_WEEK_KG ? "steady" : perWeekKg > 0 ? "gaining" : "losing" };
  }

  function fullDays(d, range) {
    const have = new Map((d.days || []).map((x) => [x.day, x]));
    const from = RM.addDays(d.today, -(range - 1)), out = [];
    for (let day = from; day <= d.today; day = RM.addDays(day, 1)) out.push(have.get(day) || { day, weightKg: null, bodyFatPercent: null, muscleKg: null, bmi: null, totalKcal: null, activeKcal: null, bmrKcal: null });
    return out;
  }


  const WORD = { losing: "Losing", steady: "Steady", gaining: "Gaining" };

  function weeksWords(weeks) {
    if (weeks < 1.5) return "about a week";
    if (weeks > 104) return "more than two years";
    return `about ${Math.round(weeks)} weeks`;
  }

  function goalOf(goalKg, fit, lastKg, today, unit) {
    if (!valid(goalKg)) return null;
    const out = { kg: goalKg, value: weight(goalKg, unit), togo: valid(lastKg) ? `${num(Math.abs(inUnit(lastKg - goalKg, unit)), 1)} ${unitOf(unit).label} ${lastKg > goalKg ? "above" : lastKg < goalKg ? "below" : "from"}` : null, state: "none", chip: null, line: null, weeks: null };
    if (!fit) return out;
    const gap = fit.at(fit.lastDay) - goalKg, dir = Math.abs(roundTo(fit.slope * 7, 2)) < STEADY_PER_WEEK_KG ? "steady" : fit.slope > 0 ? "gaining" : "losing";
    const side = `${num(Math.abs(inUnit(gap, unit)), 1)} ${unitOf(unit).label} ${gap > 0 ? "above" : "below"}`;
    if (Math.abs(gap) <= 0.3) return { ...out, state: "reached", chip: "At the goal", line: `The line is at your goal of ${out.value}.` };
    if (dir === "steady") return { ...out, state: "steady", line: `The line is ${side} your goal of ${out.value}, and steady.` };
    if ((gap > 0 && fit.slope < 0) || (gap < 0 && fit.slope > 0)) {
      const weeks = Math.abs(gap) / Math.abs(fit.perWeek);
      return { ...out, state: "toward", chip: "Toward the goal", weeks, line: `At this rate, ${out.value} is ${weeksWords(weeks)} away.` };
    }
    return { ...out, state: "away", chip: "Away from the goal", line: `The line is ${side} your goal of ${out.value}, and moving away from it.` };
  }

  function hero(d, unit, range) {
    const t = trendOf(d.days), pts = weightPoints(d.days), n = pts.length, last = pts[n - 1], fit = t.fit;
    const out = { n, dir: t.direction, title: fit ? WORD[t.direction] : "Too early", rate: { kind: "none", text: "needs 3 weigh-ins over a week or more" }, summary: `${n} weigh-in${n === 1 ? "" : "s"} so far. A trend needs ${MIN_WEIGH_INS}, spread over at least a week.`, tiles: [], projection: null, goal: null };
    const above = fit && last ? last.v - fit.at(last.day) : null;
    out.tiles = [
      { label: "Last weigh-in", value: last ? weight(last.v, unit) : "–", note: last ? dayLabel(last.day) : "none in these days" },
      { label: "From your line", value: fit ? change(above, unit) : "–", note: fit ? (Math.abs(above) <= fit.swing ? "inside the usual swing" : "outside the usual swing") : "no line yet" },
      { label: "Weigh-ins", value: String(n), of: `of ${range} days`, note: fit ? `usual swing ±${num(inUnit(fit.swing, unit), 1)} ${unitOf(unit).label}` : "one a day is best" },
    ];
    if (fit) {
      out.rate = t.direction === "steady" ? { kind: "steady", text: "steady" } : { kind: "rate", text: change(t.perWeekKg, unit), per: "/ week" };
      out.summary = `${t.direction === "steady" ? "No change beyond the day-to-day swing" : `${change(t.changeKg, unit)} over the ${fit.span} days between your first and last weigh-in`}, from ${weight(fit.at(fit.firstDay), unit)} to ${weight(fit.at(fit.lastDay), unit)}. A straight line fitted through ${n} weigh-ins.`;
      if (t.direction !== "steady") out.projection = { kg: fit.at(RM.addDays(d.today, 28)), value: weight(fit.at(RM.addDays(d.today, 28)), unit) };
    }
    out.goal = goalOf(d.goalKg, fit, last ? last.v : null, d.today, unit);
    return out;
  }


  function weekStrip(d, unit) {
    if (!d || !d.date) return [];
    const fit = fitLine(weightPoints(d.days || [])), by = new Map((d.days || []).map((x) => [x.day, x])), monday = mondayOf(d.date);
    return Array.from({ length: 7 }, (_, i) => {
      const day = RM.addDays(monday, i), x = by.get(day), has = !!x && valid(x.weightKg), future = day > d.today;
      const state = future ? "future" : has ? "weighed" : "none", off = has && fit ? x.weightKg - fit.at(day) : null;
      return {
        day, weekday: dayLabel(day).slice(0, 3), number: Number(day.slice(8)), kg: has ? x.weightKg : null, state, today: day === d.today, selected: day === d.date,
        text: has ? num(inUnit(x.weightKg, unit), 1) : "–", delta: future ? "" : has ? (fit ? signed(off, unit) : "weigh-in") : "none",
        label: `${dayLabel(day)}, ${future ? "not yet" : has ? `${weight(x.weightKg, unit)}${fit ? `, ${change(off, unit)} from the line` : ""}` : "no weigh-in"}`,
      };
    });
  }

  const canStep = (d, range, dir) => !!d && !!d.date && (dir < 0 ? d.date > RM.addDays(d.today, -(range - 1)) : d.date < d.today);


  const WEEK_BAR_KG = 1.2;

  function byWeek(d, unit, range, limit = 8) {
    const weeks = new Map();
    for (const p of weightPoints(d.days || [])) { const m = mondayOf(p.day); weeks.set(m, [...(weeks.get(m) || []), p.v]); }
    const avgOf = (m) => (weeks.has(m) ? mean(weeks.get(m)) : null);
    const from = mondayOf(RM.addDays(d.today, -(range - 1))), rows = [];
    for (let m = mondayOf(d.today); m >= from; m = RM.addDays(m, -7)) {
      const n = (weeks.get(m) || []).length, avg = avgOf(m), before = avgOf(RM.addDays(m, -7)), delta = avg !== null && before !== null ? avg - before : null;
      rows.push({
        monday: m, label: `${shortDay(m)} – ${shortDay(RM.addDays(m, 6))}`, now: m === mondayOf(d.today), n, avgKg: avg, avg: avg === null ? "–" : weight(avg, unit),
        note: `${m === mondayOf(d.today) ? "this week, so far · " : ""}${n ? `${n} weigh-in${n === 1 ? "" : "s"}` : "no weigh-ins"}`,
        deltaKg: delta, change: delta === null ? "–" : change(delta, unit), fill: delta === null ? 0 : Math.max(-1, Math.min(1, delta / WEEK_BAR_KG)),
      });
    }
    return rows.slice(0, limit);
  }


  function burned(d) {
    const done = (d.days || []).filter((x) => x.day < d.today && valid(x.totalKcal));
    if (!done.length) return null;
    const total = Math.round(mean(done.map((x) => x.totalKcal))), withActive = done.filter((x) => valid(x.activeKcal)), active = withActive.length ? Math.round(mean(withActive.map((x) => x.activeKcal))) : null;
    const bars = done.slice(-14).map((x) => ({ day: x.day, total: x.totalKcal, active: valid(x.activeKcal) ? Math.min(x.activeKcal, x.totalKcal) : 0, rest: Math.max(0, x.totalKcal - (valid(x.activeKcal) ? x.activeKcal : 0)), label: `${dayLabel(x.day)}: ${num(x.totalKcal)} kcal` }));
    return { total, active, rest: active === null ? null : total - active, days: done.length, bars, max: Math.max(...bars.map((b) => b.total)), foot: `${done.length} full day${done.length === 1 ? "" : "s"} · Garmin's estimate from the watch · the last ${bars.length} days above` };
  }

  function intakeCard(d, unit) {
    const i = d.intake;
    if (!i || !i.days || i.eatenKcal === null || i.burnedKcal === null) return null;
    const perWeekKg = ((i.eatenKcal - i.burnedKcal) * 7) / KCAL_PER_KG, scale = d.body && valid(d.body.perWeekKg) ? d.body.perWeekKg : null;
    const parts = [{ t: `On the ${i.days} day${i.days === 1 ? "" : "s"} with food logged, ` }];
    if (i.days >= 3) {
      parts.push({ t: "that is " }, { t: `${change(perWeekKg, unit)} a week`, strong: true }, { t: " by the numbers" });
      if (scale !== null) parts.push({ t: ", against " }, { t: change(scale, unit), strong: true }, { t: " on the scale" });
      parts.push({ t: ". " });
    } else parts.push({ t: "that is too few to set against the scale. " });
    parts.push({ t: "A day without a log counts as unknown, not zero, so a gap usually means food that was not logged." });
    return { eaten: i.eatenKcal, burned: i.burnedKcal, days: i.days, loggedDays: i.loggedDays, perWeekKg: i.days >= 3 ? perWeekKg : null, parts };
  }


  const hasBody = (d) => (d.days || []).some((x) => valid(x.bodyFatPercent));
  const tabs = (d) => (hasBody(d) ? ["weight", "body", "data"] : ["weight", "data"]);

  const smooth = (values) => values.map((_, k) => mean(values.slice(Math.max(0, k - 3), k + 4)));

  function bodySnapshot(d, unit) {
    if (!hasBody(d)) return null;
    const row = (key, label, say, change) => {
      const pts = (d.days || []).filter((x) => valid(x[key])).map((x) => ({ day: x.day, v: x[key] }));
      if (!pts.length) return null;
      const last = pts[pts.length - 1], fit = change ? fitLine(pts) : null;
      return { key, label, day: dayLabel(last.day), value: say(last.v), change: fit ? change(fit.slope * fit.span) : "", spark: smooth(pts.map((p) => p.v)) };
    };
    return [
      row("bodyFatPercent", "Body fat", (v) => `${num(v, 1)} %`, (kg) => `${kg > 0 ? "+" : MINUS}${num(Math.abs(kg), 1)} pts`),
      row("muscleKg", "Muscle", (v) => weight(v, unit), (kg) => change(kg, unit)),
      row("bmi", "BMI", (v) => num(v, 1), null),
    ].filter(Boolean);
  }

  const compositionPoints = (days) => days.filter((x) => valid(x.weightKg) && valid(x.bodyFatPercent)).map((x) => ({ day: x.day, fat: (x.weightKg * x.bodyFatPercent) / 100, lean: x.weightKg * (1 - x.bodyFatPercent / 100) }));

  function bodyTiles(d, unit) {
    const snap = bodySnapshot(d, unit) || [], by = Object.fromEntries(snap.map((r) => [r.key, r]));
    const note = (r, tail) => (r ? `${r.day}${r.change ? ` · ${r.change} over the range` : ""}${tail || ""}` : "");
    return [
      by.bodyFatPercent && { label: "Body fat", value: by.bodyFatPercent.value, note: note(by.bodyFatPercent) },
      by.muscleKg && { label: "Muscle", value: by.muscleKg.value, note: note(by.muscleKg) },
      by.bmi && { label: "BMI", value: by.bmi.value, note: `${by.bmi.day} · from the weight and your height` },
    ].filter(Boolean);
  }

  function came(d, unit) {
    const pts = compositionPoints(d.days || []), fat = fitLine(pts.map((p) => ({ day: p.day, v: p.fat }))), lean = fitLine(pts.map((p) => ({ day: p.day, v: p.lean })));
    if (!fat || !lean) return null;
    const df = fat.slope * fat.span, dl = lean.slope * lean.span, tot = df + dl, top = Math.max(Math.abs(df), Math.abs(dl), Math.abs(tot)) * 1.15 || 1;
    let share = null, line = "";
    if (tot < -0.05) {
      if (df <= 0 && dl <= 0) { share = Math.round((Math.abs(df) / (Math.abs(df) + Math.abs(dl))) * 100); line = `About ${share} % of the loss was fat.`; }
      else if (df < 0) line = "The loss was fat: lean mass rose.";
      else line = "The loss was lean mass: fat mass rose.";
    }
    const row = (label, sub, kg) => ({ label, sub, kg, text: change(kg, unit), frac: kg / top });
    return { rows: [row("Fat mass", "weight × body fat", df), row("Lean mass", "the rest", dl), row("Weight", "fat + lean", tot)], share, line, fat, lean, firstDay: pts[0].day };
  }


  function weightSpec(d, unit) {
    const u = unitOf(unit), fit = fitLine(weightPoints(d.days || []));
    return {
      id: "weight", title: "Weigh-ins and trend", unit: u.label, kind: "dots", ticks: 5,
      value: (x) => (valid(x.weightKg) ? u.of(x.weightKg) : null),
      ref: fit ? { label: "trend line", value: (x) => u.of(fit.at(x.day)) } : undefined,
      band: fit ? (x) => [u.of(fit.at(x.day) - fit.swing), u.of(fit.at(x.day) + fit.swing)] : undefined,
      bandLabel: fit ? `usual day-to-day swing (±${num(u.of(fit.swing), 1)} ${u.label})` : undefined,
      goal: valid(d.goalKg) ? { value: u.of(d.goalKg), label: `goal ${weight(d.goalKg, unit)}` } : undefined,
      read: (x) => (valid(x.weightKg) ? `${weight(x.weightKg, unit)}${fit ? ` · ${change(x.weightKg - fit.at(x.day), unit)} from the line` : ""}` : "no weigh-in"),
    };
  }

  function bodySpecs(d, unit) {
    const u = unitOf(unit), days = d.days || [], specs = [], c = came(d, unit), pts = compositionPoints(days), byDay = new Map(pts.map((p) => [p.day, p]));
    if (c) {
      const f0 = c.fat.at(c.firstDay), l0 = c.lean.at(c.firstDay);
      specs.push({
        id: "compare", title: "Fat mass and lean mass, change since the first weigh-in", unit: u.label, kind: "dots", ticks: 5,
        value: (x) => (byDay.has(x.day) ? u.of(byDay.get(x.day).fat - f0) : null), ref: { label: "fitted trends", value: (x) => u.of(c.fat.at(x.day) - f0) },
        second: { label: "lean mass", value: (x) => (byDay.has(x.day) ? u.of(byDay.get(x.day).lean - l0) : null), ref: { value: (x) => u.of(c.lean.at(x.day) - l0) } },
        dotLabel: "fat mass",
        read: (x) => (byDay.has(x.day) ? `fat ${change(byDay.get(x.day).fat - f0, unit)} · lean ${change(byDay.get(x.day).lean - l0, unit)}` : "–"),
      });
    }
    const fatFit = fitLine(days.filter((x) => valid(x.bodyFatPercent)).map((x) => ({ day: x.day, v: x.bodyFatPercent })));
    specs.push({
      id: "fat", title: "Body fat", unit: "%", kind: "dots", dotLabel: "scale reading",
      value: (x) => (valid(x.bodyFatPercent) ? x.bodyFatPercent : null), ref: fatFit ? { label: "trend line", value: (x) => fatFit.at(x.day) } : undefined,
      read: (x) => (valid(x.bodyFatPercent) ? `${num(x.bodyFatPercent, 1)} %` : "–"),
    });
    if (days.some((x) => valid(x.muscleKg))) {
      const muscleFit = fitLine(days.filter((x) => valid(x.muscleKg)).map((x) => ({ day: x.day, v: x.muscleKg })));
      specs.push({
        id: "muscle", title: "Muscle mass", unit: u.label, kind: "dots", dotLabel: "scale reading",
        value: (x) => (valid(x.muscleKg) ? u.of(x.muscleKg) : null), ref: muscleFit ? { label: "trend line", value: (x) => u.of(muscleFit.at(x.day)) } : undefined,
        read: (x) => weight(x.muscleKg, unit),
      });
    }
    return specs;
  }


  function parseWeight(text, unit) {
    const n = Number(String(text == null ? "" : text).trim().replace(",", "."));
    return String(text == null ? "" : text).trim() && Number.isFinite(n) && n > 0 ? kgIn(n, unit) : NaN;
  }
  const weightInput = (kg, unit) => (valid(kg) ? String(roundTo(inUnit(kg, unit), 1)) : "");

  return {
    UNITS, unitOf, weight, change, signed, GROUPS, cell, KINDS, LIMITS: { STEADY_PER_WEEK_KG, MIN_WEIGH_INS, MIN_SPAN_DAYS }, KCAL_PER_KG,
    mondayOf, fitLine, weightPoints, trendOf, fullDays, hero, goalOf, weekStrip, canStep, byWeek, burned, intakeCard, hasBody, tabs, smooth,
    bodySnapshot, bodyTiles, came, weightSpec, bodySpecs, parseWeight, weightInput,
  };
});
