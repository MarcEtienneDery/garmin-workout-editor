/*
 * workoutFormModel.js — the logic of the workout form: how a workout's flat list of steps reads as the blocks the form shows
 * (exercises and their sets, supersets, steps and repeats), the edits the form makes, the units it shows and the checks it runs.
 *
 * The plan's JSON stays the one copy of a workout. The form reads the steps with `toBlocks`, an edit changes the blocks, and
 * `fromBlocks` writes them back. Only what an edit is about changes: a step the edit does not touch is the same object, and a workout
 * opened and written back untouched keeps its JSON as it was, so nothing shows as different from Garmin for having been looked at.
 * Steps are the flat list the plan files and the upload use: a repeat is a run of consecutive steps that carry the same
 * repeatGroupIndex and a numberOfRepeats above 1, and restTimeSeconds on a step is a rest after it. A list written with nested
 * repeatSteps (as the demo data is) is read as the same blocks; the first edit writes it flat, the only form the upload understands.
 *
 * Pure functions, shared by the page (which loads this as a plain script) and the tests (which require() it).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WorkoutFormModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LB_PER_KG = 2.20462262;
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
  const isStep = (s) => s !== null && typeof s === "object" && !Array.isArray(s);
  const hasGroup = (st) => st.repeatGroupIndex !== undefined && st.repeatGroupIndex !== null;
  const round = (n, places) => { const f = 10 ** places; return Math.round(n * f) / f; };
  const pad = (n) => String(n).padStart(2, "0");
  const prettyName = (key) => String(key).toLowerCase().split("_").filter(Boolean).map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(" ");

  /** A copy of `obj` with `patch` applied: a key set to undefined goes. The same object when nothing changes. */
  function patched(obj, patch) {
    let out = null;
    for (const [key, value] of Object.entries(patch)) {
      const has = Object.prototype.hasOwnProperty.call(obj, key);
      if (value === undefined ? !has : has && obj[key] === value) continue;
      out = out || { ...obj };
      if (value === undefined) delete out[key];
      else out[key] = value;
    }
    return out || obj;
  }

  // ── The sports and what their steps can ask for ─────────────────────────

  /**
   * What the form offers for each workout type. strength: exercises with sets; endurance: steps and repeats with one target each;
   * json: no form (swimming has pool lengths and strokes the plan format does not hold). `targets` are the target types offered,
   * `cadence` the unit a cadence is counted in, `end` how a new step ends, `work` the name of a work step.
   */
  const SPORTS = {
    strength_training: { mode: "strength", label: "Strength", targets: ["no.target"], end: "reps", work: "Exercise" },
    running: { mode: "endurance", label: "Run", targets: ["no.target", "pace.zone", "heart.rate.zone", "cadence.zone", "power.zone"], cadence: "spm", end: "distance", work: "Run" },
    cycling: { mode: "endurance", label: "Bike", targets: ["no.target", "power.zone", "heart.rate.zone", "cadence.zone", "speed.zone"], cadence: "rpm", end: "time", work: "Ride" },
    cardio: { mode: "endurance", label: "Cardio", targets: ["no.target", "heart.rate.zone"], end: "time", work: "Interval" },
    other: { mode: "endurance", label: "Other", targets: ["no.target", "heart.rate.zone"], end: "time", work: "Interval" },
    swimming: { mode: "json", label: "Swim", targets: [], end: "distance", work: "Swim" },
  };
  /** The workout types the form's type list offers, in its order. */
  const TYPES = ["strength_training", "running", "cycling", "cardio", "other", "swimming"];
  const sportOf = (w) => SPORTS[w && w.workoutType] || null;

  /** How the form edits a workout: "strength", "endurance" or "json". A type the plans do not know (walking, say) gets the plain step editor. */
  function modeOf(w) {
    const sport = sportOf(w);
    if (sport) return sport.mode;
    return w && typeof w.workoutType === "string" && w.workoutType ? "endurance" : "strength";
  }

  /** The kinds of step, in the order the form lists them. `work` is the sport's own word for a work step (Run, Ride). */
  const KINDS = [
    { type: "warmup", label: "Warm up" },
    { type: "interval", label: "work" },
    { type: "recovery", label: "Recover" },
    { type: "rest", label: "Rest" },
    { type: "cooldown", label: "Cool down" },
    { type: "other", label: "Other" },
  ];
  const kindLabel = (type, w) => {
    if (type === "interval" || type === "exercise") return (sportOf(w) || SPORTS.other).work;
    const k = KINDS.find((x) => x.type === type);
    return k ? k.label : prettyName(type || "step");
  };

  /** Target types: the label, the unit and how a value is written in a field. Values are as the plan holds them (speeds in m/s). */
  const TARGETS = {
    "no.target": { label: "No target" },
    "pace.zone": { label: "Pace", unit: "/km", field: "pace" },
    "speed.zone": { label: "Speed", unit: "km/h", field: "kmh" },
    "heart.rate.zone": { label: "Heart rate", unit: "bpm", field: "int" },
    "power.zone": { label: "Power", unit: "W", field: "int" },
    "cadence.zone": { label: "Cadence", unit: "spm", field: "int" },
    open: { label: "Open" },
  };
  const targetUnit = (type, w) => (type === "cadence.zone" ? (sportOf(w) || SPORTS.running).cadence || "spm" : (TARGETS[type] || {}).unit || "");

  /** The target types a step of this workout can pick: the sport's, plus the one it has (so a step is never shown without its own). */
  function targetsFor(w, st) {
    const list = [...(sportOf(w) || SPORTS.other).targets];
    const own = st && st.targetType;
    if (own && !list.includes(own) && TARGETS[own]) list.push(own);
    return list;
  }

  // ── Units: what a field shows, and what a field typed means ─────────────

  /** 45 -> "0:45", 3725 -> "1:02:05". */
  function clock(seconds) {
    const s = Math.round(num(seconds)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  /**
   * Seconds from "1:02:05", "4:30", "4:30.5" or a bare number, which counts as `bare` ("s" or "min": a rest is typed in seconds, a step in
   * minutes). null for text that is not a time; 0 is a time.
   */
  function parseClock(text, bare = "s") {
    const t = String(text ?? "").trim().replace(/\s+/g, "");
    if (!t) return null;
    if (/^\d+(\.\d+)?$/.test(t)) return round(Number(t) * (bare === "min" ? 60 : 1), 1);
    const m = /^(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
    if (!m || Number(m[3]) >= 60 || (m[1] !== undefined && Number(m[2]) >= 60)) return null;
    return round(Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]), 1);
  }

  /** A pace from a speed in m/s: 3.333 -> "5:00" (per km). "" for no speed. */
  const paceText = (speed) => (num(speed) > 0 ? clock(1000 / speed) : "");

  /** A speed in m/s from a pace typed as "4:58" (or "458", "4.58"), to the thousandth. null when it is not a pace. */
  function parsePace(text) {
    let t = String(text ?? "").trim().replace(/\s|\/km$/gi, "");
    if (/^\d{1,2}$/.test(t)) t = `${t}:00`; // 5 -> 5:00
    else if (/^\d{3,4}$/.test(t)) t = `${t.slice(0, -2)}:${t.slice(-2)}`; // 458 -> 4:58
    else if (/^\d{1,2}[.,]\d{2}$/.test(t)) t = t.replace(/[.,]/, ":"); // 4.58 -> 4:58
    const seconds = /:/.test(t) ? parseClock(t) : null;
    return seconds && seconds >= 60 && seconds <= 3600 ? round(1000 / seconds, 3) : null;
  }

  /** km/h from m/s: 8.333 -> "30" ("30.5"); "" for none. */
  const kmhText = (speed) => (num(speed) > 0 ? String(round(speed * 3.6, 1)) : "");
  /** m/s from km/h typed, to the thousandth. null when it is not a speed. */
  function parseKmh(text) {
    const n = parseNumber(text);
    return n !== null && n > 0 && n < 200 ? round(n / 3.6, 3) : null;
  }

  /** A number typed with a comma or a point; null when it is not one. */
  function parseNumber(text) {
    const t = String(text ?? "").trim().replace(",", ".");
    return /^-?\d+(\.\d+)?$/.test(t) || /^-?\.\d+$/.test(t) ? Number(t) : null;
  }

  /** A distance for a field: under a kilometre in metres, else in km. { value: "400", unit: "m" } or { value: "2.5", unit: "km" }. */
  function distanceField(meters) {
    const m = num(meters);
    if (!m) return { value: "", unit: "km" };
    return m < 1000 && Number.isInteger(m) ? { value: String(m), unit: "m" } : { value: String(round(m / 1000, 3)), unit: "km" };
  }
  /** Metres from a distance typed in `unit` ("km" or "m"); a trailing "km" or "m" typed with it wins. null when it is not a distance. */
  function parseDistance(text, unit = "km") {
    const m = /^\s*(\d+(?:[.,]\d+)?|[.,]\d+)\s*(km|m)?\s*$/i.exec(String(text ?? ""));
    if (!m) return null;
    const value = Number(m[1].replace(",", ".")), u = (m[2] || unit).toLowerCase();
    const meters = u === "km" ? value * 1000 : value;
    return meters > 0 ? round(meters, 1) : null;
  }

  /** A weight kept in lb, as the unit shows it: 195 -> "195" (lb) or "88.5" (kg). "" for none. */
  function weightText(lb, unit = "lb") {
    if (!(num(lb) > 0)) return "";
    return String(unit === "kg" ? round(lb / LB_PER_KG, 1) : round(lb, 1));
  }
  /** The lb a weight typed in `unit` keeps: whole tenths of a lb typed in lb, hundredths when it comes from kg. null when it is not a weight. */
  function parseWeight(text, unit = "lb") {
    const n = parseNumber(text);
    if (n === null || n < 0) return null;
    return unit === "kg" ? round(n * LB_PER_KG, 2) : round(n, 1);
  }
  /** A weight in lb said in the unit, with it: "195 lb", "88.5 kg". */
  const weightLabel = (lb, unit = "lb") => `${weightText(lb, unit) || 0} ${unit === "kg" ? "kg" : "lb"}`;

  // ── One step: how it ends, what it aims for, its rest ───────────────────

  const MIRROR = { reps: "reps", time: "durationSeconds", distance: "distanceMeters" };

  /** How a step ends: { by, value }. by is reps, time, distance, lap, or another of Garmin's (calories, heart.rate, iterations), value its number. */
  function endOf(st) {
    const by = st.endCondition, v = num(st.endConditionValue);
    if (by === "lap.button") return { by: "lap", value: 0 };
    if (by === "reps") return { by, value: v || num(st.reps) };
    if (by === "time") return { by, value: v || num(st.durationSeconds) };
    if (by === "distance") return { by, value: v || num(st.distanceMeters) };
    if (!by && st.stepType === "rest") return { by: "time", value: v || num(st.durationSeconds) };
    return { by: by || "", value: v };
  }

  /**
   * The step ending another way: `by` reps, time, distance or lap (any other of Garmin's is kept as it is), `value` its number. The
   * field that mirrors the value (reps, durationSeconds, distanceMeters) follows, and the mirrors of the other ends go.
   */
  function withEnd(st, by, value) {
    if (by === "lap") return patched(st, { endCondition: "lap.button", endConditionValue: 0, reps: undefined, durationSeconds: undefined, distanceMeters: undefined });
    const patch = { endCondition: by, endConditionValue: value, reps: undefined, durationSeconds: undefined, distanceMeters: undefined };
    if (MIRROR[by]) patch[MIRROR[by]] = value;
    return patched(st, patch);
  }

  /** The target: { type, lo, hi } with the plan's values (speeds in m/s), lo the lower number. */
  function targetOf(st) {
    const type = st.targetType || "no.target";
    const a = st.targetValueOne, b = st.targetValueTwo;
    const has = (v) => typeof v === "number" && isFinite(v);
    if (has(a) && has(b)) return { type, lo: Math.min(a, b), hi: Math.max(a, b) };
    return { type, lo: has(a) ? a : has(b) ? b : null, hi: has(b) && has(a) ? Math.max(a, b) : null };
  }

  /**
   * The step aiming for another target. A range goes in as the plan keeps it: the lower number first (for a pace, the slower speed).
   * No target drops the values. A type that is unchanged with the same numbers leaves the step as it was, whichever order it held them in.
   */
  function withTarget(st, type, lo, hi) {
    if (type === "no.target" || type === "open") return patched(st, { targetType: type, targetValueOne: undefined, targetValueTwo: undefined });
    const has = (v) => typeof v === "number" && isFinite(v);
    let one = has(lo) ? lo : undefined, two = has(hi) ? hi : undefined;
    if (one !== undefined && two !== undefined && one > two) [one, two] = [two, one];
    const now = targetOf(st);
    if (st.targetType === type && now.lo === (one ?? null) && now.hi === (two ?? null)) return st;
    return patched(st, { targetType: type, targetValueOne: one, targetValueTwo: two });
  }

  /** The step with this rest after it (seconds); 0 or less takes the rest away. */
  const withRest = (st, seconds) => patched(st, { restTimeSeconds: num(seconds) > 0 ? seconds : undefined });

  /** A set: a step that does an exercise (a warm-up, a recovery or a rest that names one is still that). */
  const isExercise = (st) => isStep(st) && !!st.exerciseName && !["warmup", "cooldown", "rest", "recovery"].includes(st.stepType);

  // ── Nested repeats: read as flat ────────────────────────────────────────

  const isNested = (st) => isStep(st) && Array.isArray(st.repeatSteps);

  /**
   * The flat list for steps that may hold nested repeats ({ stepType: "repeat", numberOfRepeats, repeatSteps: [...] }): each repeat's
   * steps carry its count and an index of their own, and a timed rest that follows a step inside it becomes that step's
   * restTimeSeconds, as Garmin's own steps read. The same array when nothing is nested; null when a repeat holds another repeat,
   * which the flat list cannot hold.
   */
  function flatten(steps) {
    const list = Array.isArray(steps) ? steps : [];
    if (!list.some(isNested)) return list;
    let next = Math.max(-1, ...list.filter((s) => isStep(s) && hasGroup(s)).map((s) => num(s.repeatGroupIndex))) + 1;
    const out = [];
    for (const st of list) {
      if (!isNested(st)) { out.push(st); continue; }
      const inner = st.repeatSteps.filter(isStep);
      if (inner.some(isNested)) return null;
      const times = Math.max(1, num(st.numberOfRepeats) || (st.endCondition === "iterations" ? num(st.endConditionValue) : 0) || 1);
      const merged = [];
      for (const s of inner) {
        const prev = merged[merged.length - 1];
        const rest = s.stepType === "rest" && endOf(s).by === "time" && endOf(s).value > 0 ? endOf(s).value : 0;
        if (rest && prev && prev.stepType !== "rest" && !num(prev.restTimeSeconds)) merged[merged.length - 1] = { ...prev, restTimeSeconds: rest };
        else merged.push(s);
      }
      const gi = next++;
      for (const s of merged) {
        const { repeatGroupIndex: _g, numberOfRepeats: _n, ...plain } = s;
        out.push(times > 1 ? { ...plain, numberOfRepeats: times, repeatGroupIndex: gi } : plain);
      }
    }
    return out.map((s, i) => (isStep(s) && s.stepOrder !== undefined ? patched(s, { stepOrder: i + 1 }) : s));
  }

  // ── Blocks: the flat list as the form shows it ──────────────────────────
  // A block is { steps, times, gi }: steps done `times` times. A repeat (times above 1) has one or more steps; a block done once
  // always has one. `gi` is the repeatGroupIndex the block's steps carry (undefined for none).

  /** The blocks of a flat list, read as the upload reads it: consecutive steps with the same repeatGroupIndex are one repeat, as many times as the first says. */
  function toBlocks(steps) {
    const list = (Array.isArray(steps) ? steps : []).filter(isStep);
    const blocks = [];
    for (let i = 0; i < list.length; ) {
      const st = list[i];
      let end = i + 1;
      if (hasGroup(st)) while (end < list.length && list[end].repeatGroupIndex === st.repeatGroupIndex) end++;
      const times = Math.max(1, Math.floor(num(st.numberOfRepeats)) || 1);
      if (hasGroup(st) && times > 1) blocks.push({ steps: list.slice(i, end), times, gi: st.repeatGroupIndex });
      else for (let j = i; j < end; j++) blocks.push({ steps: [list[j]], times: 1, gi: hasGroup(list[j]) ? list[j].repeatGroupIndex : undefined });
      i = end;
    }
    return blocks;
  }

  /**
   * The flat list of these blocks. A repeat's steps carry its count and its index: it keeps the index it had when no other repeat
   * holds it yet, and gets a new one otherwise (a repeat copied, or two that the list once numbered alike). A step done once drops a
   * count above 1, and the index it had when that index would join it to a repeat beside it. stepOrder follows the order when the
   * steps have one. Steps that need no change are the same objects.
   */
  function fromBlocks(blocks) {
    const groups = blocks.filter((b) => b.times > 1);
    const taken = new Set(), gis = new Map();
    for (const b of groups) if (b.gi !== undefined && b.gi !== null && !taken.has(b.gi)) { taken.add(b.gi); gis.set(b, b.gi); }
    let next = Math.max(-1, ...[...taken].map(num), ...blocks.flatMap((b) => b.steps.filter(hasGroup).map((s) => num(s.repeatGroupIndex)))) + 1;
    for (const b of groups) if (!gis.has(b)) gis.set(b, next++);

    const out = [];
    blocks.forEach((b, k) => {
      if (b.times > 1) {
        for (const st of b.steps) out.push(patched(st, { numberOfRepeats: b.times, repeatGroupIndex: gis.get(b) }));
        return;
      }
      for (const st of b.steps) {
        const near = [blocks[k - 1], blocks[k + 1]].filter((n) => n && n.times > 1).map((n) => gis.get(n));
        const joins = hasGroup(st) && near.includes(st.repeatGroupIndex);
        out.push(num(st.numberOfRepeats) > 1 || joins ? patched(st, { numberOfRepeats: undefined, repeatGroupIndex: undefined }) : st);
      }
    });
    const ordered = out.some((s) => s.stepOrder !== undefined);
    return ordered ? out.map((s, i) => patched(s, { stepOrder: i + 1 })) : out;
  }

  // ── Edits on blocks (each returns a new list; the blocks it does not touch are the same objects) ──

  const block = (steps, times = 1) => ({ steps, times: steps.length > 1 ? Math.max(2, times) : Math.max(1, times), gi: undefined });
  const copyStep = (st) => { const { repeatGroupIndex: _g, numberOfRepeats: _n, ...rest } = JSON.parse(JSON.stringify(st)); return rest; };

  /** A block's steps done another number of times. Down to 1, a repeat of several steps becomes those steps, each a block of its own. */
  function setTimes(blocks, k, times) {
    const b = blocks[k], n = Math.max(1, Math.floor(num(times)) || 1);
    if (n === b.times) return blocks;
    if (n > 1) return blocks.map((x, i) => (i === k ? { ...b, times: n } : x));
    return [...blocks.slice(0, k), ...b.steps.map((st) => ({ steps: [st], times: 1, gi: undefined })), ...blocks.slice(k + 1)];
  }

  const insertBlocks = (blocks, at, added) => [...blocks.slice(0, at), ...added, ...blocks.slice(at)];
  const removeBlocks = (blocks, k, count = 1) => [...blocks.slice(0, k), ...blocks.slice(k + count)];

  /** Blocks k..k+count-1 moved so they start where block `to` is now (to is counted before the move). */
  function moveBlocks(blocks, k, count, to) {
    if (to >= k && to <= k + count) return blocks;
    const moving = blocks.slice(k, k + count), rest = removeBlocks(blocks, k, count);
    const at = to > k ? to - count : to;
    return insertBlocks(rest, at, moving);
  }

  /** A copy of blocks k..k+count-1 right after them: new steps, and a repeat gets an index of its own when written. */
  function duplicateBlocks(blocks, k, count = 1) {
    const copies = blocks.slice(k, k + count).map((b) => ({ steps: b.steps.map(copyStep), times: b.times, gi: undefined }));
    return insertBlocks(blocks, k + count, copies);
  }

  /** Change step j of block k (its position in the block); `fn` gets the step and returns it changed. */
  function updateStep(blocks, k, j, fn) {
    const b = blocks[k], st = b.steps[j], next = fn(st);
    if (next === st) return blocks;
    return blocks.map((x, i) => (i === k ? { ...b, steps: b.steps.map((s, m) => (m === j ? next : s)) } : x));
  }

  /** Steps added into repeat k at position j (at its end without one). */
  function insertInto(blocks, k, j, steps) {
    const b = blocks[k], at = j === undefined ? b.steps.length : j;
    return blocks.map((x, i) => (i === k ? { ...b, times: Math.max(2, b.times), steps: [...b.steps.slice(0, at), ...steps, ...b.steps.slice(at)] } : x));
  }

  /** Step j taken out of repeat k (dropped, or, with `keep`, put after the repeat as a step done once). A repeat left with one step stays a repeat of it. */
  function takeOut(blocks, k, j, { keep = false } = {}) {
    const b = blocks[k], st = b.steps[j], left = b.steps.filter((_, m) => m !== j);
    const rest = left.length ? [{ ...b, steps: left }] : [];
    const out = keep ? [{ steps: [st], times: 1, gi: undefined }] : [];
    return [...blocks.slice(0, k), ...(keep && j === 0 ? [...out, ...rest] : [...rest, ...out]), ...blocks.slice(k + 1)];
  }

  /** Step j of repeat k moved by `by` (-1 up, 1 down) inside it; past either end it leaves the repeat, before or after it. */
  function moveInside(blocks, k, j, by) {
    const b = blocks[k], to = j + by;
    if (to >= 0 && to < b.steps.length) {
      const steps = [...b.steps];
      [steps[j], steps[to]] = [steps[to], steps[j]];
      return blocks.map((x, i) => (i === k ? { ...b, steps } : x));
    }
    if (b.steps.length === 1) return blocks;
    const st = b.steps[j], left = { ...b, steps: b.steps.filter((_, m) => m !== j) }, alone = { steps: [st], times: 1, gi: undefined };
    return [...blocks.slice(0, k), ...(to < 0 ? [alone, left] : [left, alone]), ...blocks.slice(k + 1)];
  }

  /**
   * Blocks k..k+count-1 joined into one repeat (a superset, or a repeat of steps): their steps, done as many times as the most any
   * of them was. For a superset, only the last exercise keeps its rest: the rest after a round.
   */
  function joinBlocks(blocks, k, count, { superset = false } = {}) {
    const parts = blocks.slice(k, k + count), steps = parts.flatMap((b) => b.steps);
    const times = Math.max(2, ...parts.map((b) => b.times));
    const keptGi = parts.find((b) => b.times > 1 && b.gi !== undefined);
    const joined = superset ? steps.map((st, i) => (i < steps.length - 1 ? withRest(st, 0) : st)) : steps;
    return [...blocks.slice(0, k), { steps: joined, times, gi: keptGi ? keptGi.gi : undefined }, ...blocks.slice(k + count)];
  }

  /** Repeat k split: each of its steps done as many times on its own (a superset back into its exercises' sets). */
  function splitBlock(blocks, k) {
    const b = blocks[k];
    if (b.steps.length < 2) return blocks;
    return [...blocks.slice(0, k), ...b.steps.map((st, j) => ({ steps: [st], times: b.times, gi: j === 0 ? b.gi : undefined })), ...blocks.slice(k + 1)];
  }

  /** Repeat k undone: its steps once each, in order (a repeat of steps no longer repeated). */
  const unrepeat = (blocks, k) => setTimes(blocks, k, 1);

  /** A line of N sets made N lines of one set each, so each set can differ. */
  function eachSet(blocks, k) {
    const b = blocks[k];
    if (b.steps.length !== 1 || b.times < 2) return blocks;
    const sets = Array.from({ length: b.times }, (_, i) => ({ steps: [i === 0 ? b.steps[0] : copyStep(b.steps[0])], times: 1, gi: undefined }));
    return [...blocks.slice(0, k), ...sets, ...blocks.slice(k + 1)];
  }

  /** Lines k..k+count-1 of one exercise, all alike, made one line of that many sets again. null when they differ. */
  function sameSets(blocks, k, count) {
    const lines = blocks.slice(k, k + count);
    const key = (b) => JSON.stringify(copyStep(b.steps[0]), (name, v) => (name === "stepOrder" ? undefined : v));
    if (lines.some((b) => b.steps.length !== 1 || key(b) !== key(lines[0]))) return null;
    const times = lines.reduce((t, b) => t + b.times, 0);
    return [...blocks.slice(0, k), { steps: [lines[0].steps[0]], times, gi: lines.find((b) => b.gi !== undefined)?.gi }, ...blocks.slice(k + count)];
  }

  // ── The strength view: exercises with their lines of sets, and supersets ──

  /**
   * The cards of a strength workout, over its blocks. exercise: the consecutive lines of one exercise (a line is a block of one
   * exercise step: its sets are the block's times); superset: a repeat of two or more exercises; repeat: any other repeat; step:
   * any other step (warm-up, rest, cool-down). Each card says which blocks it covers: `k` the first, `count` how many.
   */
  function strengthCards(blocks) {
    const cards = [];
    blocks.forEach((b, k) => {
      const one = b.steps.length === 1 ? b.steps[0] : null;
      if (one && isExercise(one)) {
        const last = cards[cards.length - 1];
        if (last && last.kind === "exercise" && last.name === one.exerciseName && last.k + last.count === k) { last.count++; return; }
        cards.push({ kind: "exercise", k, count: 1, name: one.exerciseName });
      } else if (b.steps.length > 1 && b.steps.every(isExercise)) cards.push({ kind: "superset", k, count: 1 });
      else if (b.times > 1) cards.push({ kind: "repeat", k, count: 1 });
      else cards.push({ kind: "step", k, count: 1 });
    });
    return cards;
  }

  /** The sets of an exercise card, counted. */
  const setCount = (blocks, card) => blocks.slice(card.k, card.k + card.count).reduce((t, b) => t + b.times, 0);

  // ── New steps and workouts ──────────────────────────────────────────────

  /**
   * A new step of this kind for the workout's sport. It ends as `end` says ({ by, value }), else the kind's way: a warm-up or a
   * cool-down of a strength workout on the lap button, else 10 and 5 minutes; a rest one minute, a recovery two; a work step the sport's way.
   */
  function newStep(w, type = "interval", end) {
    const sport = sportOf(w) || SPORTS.other, strength = sport.mode === "strength";
    const [by, value] = end ? [end.by, end.value]
      : type === "warmup" || type === "cooldown" ? (strength ? ["lap", 0] : ["time", type === "warmup" ? 600 : 300])
      : type === "rest" ? ["time", 60] : type === "recovery" ? ["time", 120]
      : sport.end === "distance" ? ["distance", 1000] : sport.end === "reps" ? ["reps", 10] : ["time", 600];
    return withEnd({ stepType: type, targetType: "no.target" }, by, value);
  }

  /** A set of an exercise: `reps` reps, at `weight` lb when there is one, with `rest` seconds after it. */
  function newSet(exerciseName, { reps = 10, weight, rest = 90 } = {}) {
    let st = withEnd({ stepType: "interval", targetType: "no.target", exerciseName }, "reps", reps);
    if (num(weight) > 0) st = { ...st, weight };
    return withRest(st, rest);
  }

  /** The steps a new workout of this type starts with. */
  function starterSteps(type) {
    const w = { workoutType: type };
    let blocks;
    if (modeOf(w) === "strength") blocks = [{ steps: [newStep(w, "warmup")], times: 1 }, { steps: [newSet("BARBELL_BACK_SQUAT", { reps: 8 })], times: 3 }, { steps: [newSet("BARBELL_BENCH_PRESS", { reps: 8 })], times: 3 }];
    else if (type === "running") blocks = [newStep(w, "warmup"), newStep(w, "interval", { by: "distance", value: 5000 }), newStep(w, "cooldown")].map((st) => ({ steps: [st], times: 1 }));
    else if (type === "cycling") blocks = [newStep(w, "warmup"), newStep(w, "interval", { by: "time", value: 2400 }), newStep(w, "cooldown")].map((st) => ({ steps: [st], times: 1 }));
    else blocks = [{ steps: [newStep(w, "interval", { by: "time", value: 1800 })], times: 1 }];
    return fromBlocks(blocks).map((st, i) => ({ ...st, stepOrder: i + 1 }));
  }

  /** A new workout of this type, named. */
  const newWorkout = (type, name) => ({ workoutName: name, workoutType: type, description: "", sendToDevice: true, steps: starterSteps(type) });

  /** Ready-made blocks the endurance form can add: { id, label, blocks(w) }. */
  const PRESETS = {
    running: [
      { id: "intervals", label: "Intervals 5 × 1 km", blocks: (w) => [{ steps: [newStep(w, "interval", { by: "distance", value: 1000 }), newStep(w, "recovery")], times: 5 }] },
      { id: "strides", label: "Strides 4 × 20 s", blocks: (w) => [{ steps: [withRest(newStep(w, "interval", { by: "time", value: 20 }), 40)], times: 4 }] },
      { id: "tempo", label: "Tempo 20 min", blocks: (w) => [{ steps: [newStep(w, "interval", { by: "time", value: 1200 })], times: 1 }] },
    ],
    cycling: [
      { id: "sweetspot", label: "Sweet spot 3 × 10 min", blocks: (w) => [{ steps: [newStep(w, "interval", { by: "time", value: 600 }), newStep(w, "recovery", { by: "time", value: 300 })], times: 3 }] },
      { id: "vo2", label: "VO2 5 × 3 min", blocks: (w) => [{ steps: [newStep(w, "interval", { by: "time", value: 180 }), newStep(w, "recovery", { by: "time", value: 180 })], times: 5 }] },
      { id: "cadence", label: "Cadence drills 6 × 1 min", blocks: (w) => [{ steps: [newStep(w, "interval", { by: "time", value: 60 }), newStep(w, "recovery", { by: "time", value: 60 })], times: 6 }] },
    ],
  };

  // ── Checks: what the upload would refuse, field by field ────────────────
  // The server's validation (the same as before an upload) stays the judge; these say at once which field is wrong.

  const STEP_TYPES = ["warmup", "cooldown", "interval", "recovery", "rest", "exercise", "repeat", "other"];
  const END_TYPES = ["reps", "time", "distance", "lap.button", "iterations", "calories", "heart.rate"];

  /** Why the form cannot show this workout, which the JSON still edits: a reason, or "" when it can. */
  function formProblem(w) {
    if (!w || typeof w !== "object" || Array.isArray(w)) return "This is not a workout.";
    if (w.steps !== undefined && !Array.isArray(w.steps)) return "Its steps are not a list.";
    const steps = w.steps || [], bad = steps.findIndex((s) => !isStep(s));
    if (bad >= 0) return `Step ${bad + 1} is not a step.`;
    if (flatten(steps) === null) return "A repeat holds another repeat, which the form cannot show.";
    if (modeOf(w) === "json") return `The form does not edit ${SPORTS[w.workoutType].label.toLowerCase()} workouts: the JSON does.`;
    return "";
  }

  /**
   * The problems of a workout's steps: { i (position in the flat list), field, level ("err" refused by the upload, "warn" worth a
   * look), text }. `known(name)` says whether an exercise name is Garmin's.
   */
  function check(w, known) {
    const out = [], steps = Array.isArray(w && w.steps) ? w.steps : [];
    const add = (i, field, level, text) => out.push({ i, field, level, text });
    steps.forEach((st, i) => {
      if (!isStep(st)) return add(i, "", "err", "Not a step.");
      const end = endOf(st);
      if (!STEP_TYPES.includes(st.stepType)) add(i, "kind", "err", `"${st.stepType ?? ""}" is not a kind of step Garmin knows.`);
      if (!TARGETS[st.targetType]) add(i, "target", "err", st.targetType ? `"${st.targetType}" is not a target Garmin knows.` : "Say what the step aims for (or no target).");
      if (st.endCondition && !END_TYPES.includes(st.endCondition)) add(i, "end", "err", `"${st.endCondition}" is not an end Garmin knows.`);
      else if (!st.endCondition && st.stepType !== "rest") add(i, "end", "err", "Say how the step ends.");
      else if (end.by !== "lap" && st.endCondition && !(num(st.endConditionValue) > 0)) add(i, "end", "err", end.by === "reps" ? "Give at least 1 rep." : end.by === "time" ? "Give a time." : end.by === "distance" ? "Give a distance." : "Give a value above 0.");
      for (const [by, field] of Object.entries(MIRROR)) {
        if (st.endCondition === by && st[field] !== undefined && st[field] !== st.endConditionValue) add(i, "end", "err", `${field} (${st[field]}) and endConditionValue (${st.endConditionValue}) differ.`);
      }
      if (st.weight !== undefined && !(num(st.weight) >= 0 && st.weight <= 1000)) add(i, "weight", "err", "A weight between 0 and 1000 lb.");
      if (st.weightPercentage !== undefined) {
        if (!(st.weightPercentage > 0 && st.weightPercentage <= 200)) add(i, "weight", "err", "A percentage above 0 and up to 200.");
        if (!st.benchmarkKey) add(i, "weight", "err", "A percentage of which exercise's 1RM?");
      }
      if (st.restTimeSeconds !== undefined && !(num(st.restTimeSeconds) >= 0)) add(i, "rest", "err", "A rest of 0 or more.");
      if (st.exerciseName && known && !known(st.exerciseName)) add(i, "exercise", "err", `${st.exerciseName} is not one of Garmin's exercises.`);
      if (!st.exerciseName && ["interval", "exercise"].includes(st.stepType) && (st.weight !== undefined || st.endCondition === "reps") && modeOf(w) === "strength") add(i, "exercise", "warn", "Pick the exercise.");
      const t = targetOf(st);
      if (TARGETS[t.type] && TARGETS[t.type].field && t.lo === null) add(i, "target", "warn", `Give the ${TARGETS[t.type].label.toLowerCase()} to aim for.`);
      if (t.type === "heart.rate.zone" && t.lo !== null && (t.lo < 30 || (t.hi !== null && t.hi > 250))) add(i, "target", "warn", "A heart rate between 30 and 250 bpm.");
      if (t.type === "pace.zone" && t.lo !== null && (t.lo < 0.5 || (t.hi !== null && t.hi > 12))) add(i, "target", "warn", "A pace between 1:24 and 33:20 per km.");
    });
    return out;
  }

  // ── Exercise search ──────────────────────────────────────────────────────

  /** Words people type for a part of Garmin's names. */
  const ALIASES = { DB: ["DUMBBELL"], BB: ["BARBELL"], KB: ["KETTLEBELL"], RDL: ["ROMANIAN", "DEADLIFT"], OHP: ["OVERHEAD", "PRESS"], SLDL: ["STIFF", "DEADLIFT"], PULLUP: ["PULL", "UP"], CHINUP: ["CHIN", "UP"], PUSHUP: ["PUSH", "UP"], SITUP: ["SIT", "UP"] };

  /**
   * Garmin exercises ([{ name, category }]) that match every word typed (in the name, or the name without its underscores), in
   * `category` when one is given. The ones in `recent` (names, most used first) come first, then names that start with the first word,
   * then the shorter names.
   */
  function searchExercises(all, query, { category, recent = [], limit = 60 } = {}) {
    const words = String(query ?? "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).flatMap((t) => ALIASES[t] || [t]);
    const rank = new Map(recent.map((name, i) => [name, i]));
    const hits = all.filter((e) => (!category || e.category === category) && words.every((t) => e.name.includes(t) || e.name.replace(/_/g, "").includes(t)));
    const starts = (e) => (words.length && e.name.startsWith(words[0]) ? 0 : 1);
    hits.sort((a, b) => (rank.has(a.name) ? rank.get(a.name) : 1e9) - (rank.has(b.name) ? rank.get(b.name) : 1e9) || starts(a) - starts(b) || a.name.length - b.name.length || a.name.localeCompare(b.name));
    return hits.slice(0, limit);
  }

  return {
    LB_PER_KG, SPORTS, TYPES, KINDS, TARGETS, PRESETS, ALIASES,
    modeOf, sportOf, kindLabel, targetUnit, targetsFor, prettyName,
    clock, parseClock, paceText, parsePace, kmhText, parseKmh, parseNumber, distanceField, parseDistance, weightText, parseWeight, weightLabel,
    endOf, withEnd, targetOf, withTarget, withRest, isExercise, patched, formProblem,
    flatten, toBlocks, fromBlocks,
    setTimes, insertBlocks, removeBlocks, moveBlocks, duplicateBlocks, updateStep, insertInto, takeOut, moveInside, joinBlocks, splitBlock, unrepeat, eachSet, sameSets, block, copyStep,
    strengthCards, setCount,
    newStep, newSet, starterSteps, newWorkout,
    check, searchExercises,
  };
});
