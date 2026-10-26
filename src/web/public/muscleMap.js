/*
 * muscleMap.js — which muscles a strength workout trains, and the body drawing that shows it.
 *
 * Pure functions, loaded by the page as a plain script and require()d by the tests. A Garmin exercise name (BARBELL_BENCH_PRESS) gives
 * the muscles it works, from the table in exerciseMuscles.js: some primary, some secondary. A set counts 2 for each primary muscle and 1
 * for each secondary one, so a muscle's score is twice its "sets" (a primary set is a set, a secondary one half a set). The drawing
 * shades each muscle in one colour, darker the higher its score is against the workout's highest.
 */
(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./exerciseMuscles.js") : root.ExerciseMuscles);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MuscleMap = api;
})(typeof self !== "undefined" ? self : this, function (EXERCISES) {
  "use strict";

  const PRIMARY_POINTS = 2; // a primary muscle gets twice what a secondary one does
  const SECONDARY_POINTS = 1;

  /** The muscles drawn, in the order the list reads. */
  const MUSCLES = [
    { id: "chest", label: "Chest" },
    { id: "frontDelts", label: "Front delts" },
    { id: "sideDelts", label: "Side delts" },
    { id: "rearDelts", label: "Rear delts" },
    { id: "traps", label: "Traps" },
    { id: "lats", label: "Lats" },
    { id: "upperBack", label: "Upper back" },
    { id: "lowerBack", label: "Lower back" },
    { id: "biceps", label: "Biceps" },
    { id: "triceps", label: "Triceps" },
    { id: "forearms", label: "Forearms" },
    { id: "abs", label: "Abs" },
    { id: "obliques", label: "Obliques" },
    { id: "glutes", label: "Glutes" },
    { id: "quads", label: "Quads" },
    { id: "adductors", label: "Inner thighs" },
    { id: "hamstrings", label: "Hamstrings" },
    { id: "calves", label: "Calves" },
  ];
  const LABEL = Object.fromEntries(MUSCLES.map((m) => [m.id, m.label]));

  // ── Exercise → muscles ──────────────────────────────────────────────────
  // The table in exerciseMuscles.js has one line for each exercise Garmin lists. A name that is not there, and the exercises the table
  // gives no muscles (cardio, warm-ups, stretches), work no muscle: the view says so.

  /** The muscles an exercise works, { primary, secondary }, or null when none is known (cardio, or a name that is not Garmin's). */
  function musclesOf(exerciseName) {
    let name = String(exerciseName || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, ""); // "Weighted Chin Up" as Garmin lists a done set, WEIGHTED_CHIN_UP as a plan has it
    if (/^[0-9]/.test(name)) name = `_${name}`; // Garmin keys "3 Way Calf Raise" as _3_WAY_CALF_RAISE
    const found = Object.prototype.hasOwnProperty.call(EXERCISES, name) ? EXERCISES[name] : null;
    return found && found[0].length ? { primary: found[0], secondary: found[1] } : null;
  }

  /**
   * What a workout trains, from its exercises and their number of sets ([{ name, sets }]): per muscle the direct sets (as a primary
   * muscle), the indirect sets (as a secondary one), and its score (2 a direct set, 1 an indirect one). `max` is the highest score;
   * `unknown` lists the exercises with no known muscles, whose sets are not counted.
   */
  function tally(exercises) {
    const found = new Map(), unknown = [];
    for (const { name, sets } of exercises || []) {
      const m = musclesOf(name);
      if (!m) { unknown.push({ name, sets }); continue; }
      const add = (id, key) => { const e = found.get(id) || { id, label: LABEL[id], direct: 0, indirect: 0, score: 0 }; e[key] += sets; found.set(id, e); };
      for (const id of m.primary) add(id, "direct");
      for (const id of m.secondary) add(id, "indirect");
    }
    const muscles = [...found.values()].map((e) => ({ ...e, score: e.direct * PRIMARY_POINTS + e.indirect * SECONDARY_POINTS })).sort((a, b) => b.score - a.score || MUSCLES.findIndex((m) => m.id === a.id) - MUSCLES.findIndex((m) => m.id === b.id));
    return { muscles, max: muscles.length ? muscles[0].score : 0, unknown };
  }

  /** A muscle's score as sets: a primary set is one, a secondary set half of one. "3", "4.5". */
  const setsOf = (score) => String(Math.round((score / PRIMARY_POINTS) * 10) / 10);

  // ── Colour ──────────────────────────────────────────────────────────────

  const COLD = [60, 60, 62]; // a muscle the workout does not train
  const HOT = [232, 69, 60]; // the muscle trained most
  const FLOOR = 0.28; // the lightest a trained muscle is drawn, so one set still shows against the grey

  const hex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const mix = (t) => hex(COLD.map((c, i) => c + (HOT[i] - c) * t));

  /** The fill of a muscle with `score` when the highest is `max`: one colour, more of it the more sets. */
  const fillOf = (score, max) => (score > 0 && max > 0 ? mix(FLOOR + (1 - FLOOR) * Math.min(1, score / max)) : hex(COLD));

  // ── The drawing ─────────────────────────────────────────────────────────
  // Two figures on a 120 x 262 grid, front and back. A shape is a list of points joined by a smooth closed curve ([x, y, ...]), or a
  // rounded rectangle ({ rect: [x, y, w, h] }); each is drawn for the left side and again, mirrored, for the right. The body is the
  // same outline on both figures.

  const W = 120, H = 262, MID = W / 2;

  /** A smooth curve through the points (Catmull-Rom as cubic Béziers), closed or open. */
  function curve(pts, closed) {
    const n = pts.length, at = (i) => pts[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))], f = (v) => Math.round(v * 10) / 10;
    let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
    }
    return d + (closed ? "Z" : "");
  }

  const pairs = (flat) => flat.reduce((out, v, i) => (i % 2 ? (out[out.length - 1].push(v), out) : (out.push([v]), out)), []);
  const blob = (...flat) => curve(pairs(flat), true);
  const rect = (x, y, w, h, r = 2) => `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;

  // The outline of the left half, from the neck down the arm and the leg to the foot; the centre line closes it.
  const OUTLINE = pairs([
    60, 24, 54, 26, 53.5, 33, 45, 36, 34, 40, 28, 45, 25, 56, 22, 72, 20, 90, 17, 106, 13, 124, 10, 136, 8, 146, 12, 152, 18, 148, 21, 138, 25, 120, 29, 102, 32, 88, 34, 74, 36, 62,
    39, 82, 42, 100, 40, 116, 38, 134, 39, 156, 41, 176, 41.5, 192, 40, 212, 42, 232, 43, 246, 41, 254, 51, 256, 55, 246, 55.5, 228, 57, 208, 56, 190, 57, 172, 59, 150, 60, 132,
  ]);

  const FRONT = {
    traps: [blob(55.5, 28.5, 52, 32.5, 46.5, 35.2, 40, 37.8, 34.5, 40.2, 33, 42, 36, 43.5, 42, 41.5, 48, 39, 53, 36.5, 55.5, 34)],
    chest: [blob(58.5, 44, 50, 42, 41, 45, 36.5, 52, 37, 60, 43, 66, 51, 68, 58.5, 65)],
    frontDelts: [blob(36, 41.5, 31.5, 43, 29.5, 49, 30.5, 57, 33, 62, 37, 58, 38.5, 50)],
    sideDelts: [blob(30.5, 42, 26, 45, 24.5, 53, 25.5, 61, 28.5, 62, 29.5, 53, 31, 47)],
    biceps: [blob(28, 66, 24.5, 72, 24, 82, 26.5, 90, 30.5, 89, 32, 80, 32, 71)],
    forearms: [blob(25, 96, 19.5, 102, 16, 114, 14, 128, 18, 131, 22, 122, 25.5, 108, 27, 98)],
    abs: [rect(47, 71, 11.5, 11), rect(47, 84, 11.5, 11), rect(47.5, 97, 11, 11), rect(48.5, 110, 9.5, 8)],
    obliques: [blob(39.5, 70, 37, 76, 37.5, 90, 41, 104, 45, 106, 46, 90, 44.5, 74)],
    adductors: [blob(57.5, 134, 52, 138, 53, 152, 56, 168, 58.5, 160, 59, 144)],
    quads: [blob(45, 124, 41, 138, 40.5, 158, 42.5, 176, 49, 178, 53, 164, 55, 148, 52, 130)],
    calves: [blob(45, 190, 42.5, 202, 43.5, 224, 47, 240, 51, 238, 53.5, 222, 54, 202, 52, 190)],
  };
  const BACK = {
    traps: [blob(58.5, 25.5, 53, 29.5, 46, 33.5, 39.5, 38, 35, 41, 38, 46, 44, 50.5, 51, 54, 58.5, 62)],
    rearDelts: [blob(37, 42, 32, 43, 29, 49, 30, 57, 34, 61, 37.5, 55, 38, 48)],
    sideDelts: [blob(30.5, 42, 26, 45, 24.5, 53, 25.5, 61, 28.5, 62, 29.5, 53, 31, 47)],
    upperBack: [blob(58.5, 61, 51, 54, 45, 53, 41, 58, 43, 66, 51, 70, 58.5, 69)],
    lats: [blob(40.5, 63, 36.5, 71, 37, 87, 41.5, 101, 48, 107, 54.5, 102, 57.5, 90, 57, 77, 51, 67)],
    lowerBack: [blob(58.5, 88, 54, 90, 51, 98, 51.5, 110, 58.5, 114)],
    triceps: [blob(28, 62, 24.5, 70, 24, 82, 26, 91, 30.5, 90, 32.5, 80, 32, 68)],
    forearms: [blob(25, 96, 19.5, 102, 16, 114, 14, 128, 18, 131, 22, 122, 25.5, 108, 27, 98)],
    glutes: [blob(58.5, 118, 50, 115, 43, 119, 40.5, 128, 44, 138, 53, 140, 58.5, 134)],
    hamstrings: [blob(57, 144, 47, 143, 42.5, 154, 42, 170, 45, 180, 52, 180, 56, 168, 58, 152)],
    calves: [blob(44.5, 188, 42, 200, 43.5, 216, 47, 228, 51.5, 218, 54, 202, 52, 190)],
  };

  const mirror = (d) => `<path d="${d}" transform="translate(${W} 0) scale(-1 1)"/>`;
  const both = (d) => `<path d="${d}"/>${mirror(d)}`;

  /**
   * One figure as SVG text. `paint(id)` says how to draw a muscle: { fill, title }, or null to draw it untrained.
   * Nothing from the person goes into the text: the muscle names are this file's, the titles are numbers.
   */
  function figure(view, paint) {
    const shapes = view === "back" ? BACK : FRONT;
    const body = `<g class="mm-body" fill="${hex(COLD)}" fill-opacity=".45" stroke="#6a6a6a" stroke-width=".8" stroke-linejoin="round"><circle cx="${MID}" cy="13" r="10.5"/>${both(`${curve(OUTLINE)}Z`)}</g>`;
    const parts = MUSCLES.filter((m) => shapes[m.id]).map((m) => {
      const p = (paint && paint(m.id)) || {};
      const title = p.title ? `<title>${p.title}</title>` : "";
      return `<g class="mm-muscle" data-muscle="${m.id}" fill="${p.fill || hex(COLD)}">${title}${shapes[m.id].map(both).join("")}</g>`;
    });
    return `<svg class="mm-fig" viewBox="0 0 ${W} ${H}" role="img" aria-label="${view === "back" ? "Back" : "Front"} of the body" xmlns="http://www.w3.org/2000/svg">${body}<g stroke="#1e1e1e" stroke-width=".8" stroke-linejoin="round">${parts.join("")}</g></svg>`;
  }

  return { MUSCLES, EXERCISES, PRIMARY_POINTS, SECONDARY_POINTS, musclesOf, tally, setsOf, fillOf, mix, figure };
});
