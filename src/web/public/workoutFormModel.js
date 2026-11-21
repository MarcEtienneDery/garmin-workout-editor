(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(node ? require("./workoutModel.js") : root.WorkoutModel);
  if (node) module.exports = api;
  else root.WorkoutFormModel = api;
})(typeof self !== "undefined" ? self : this, function (WM) {
  "use strict";

  const { LB_PER_KG, clock, prettyName } = WM;
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const isStep = (s) => s !== null && typeof s === "object" && !Array.isArray(s);
  const hasGroup = (st) => st.repeatGroupIndex !== undefined && st.repeatGroupIndex !== null;
  const round = (n, places) => { const f = 10 ** places; return Math.round(n * f) / f; };

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


  const SPORTS = {
    strength_training: { mode: "strength", label: "Strength", targets: ["no.target"], end: "reps", work: "Exercise" },
    running: { mode: "endurance", label: "Run", targets: ["no.target", "pace.zone", "heart.rate.zone", "cadence.zone", "power.zone"], cadence: "spm", end: "distance", work: "Run" },
    cycling: { mode: "endurance", label: "Bike", targets: ["no.target", "power.zone", "heart.rate.zone", "cadence.zone", "speed.zone"], cadence: "rpm", end: "time", work: "Ride" },
    cardio: { mode: "endurance", label: "Cardio", targets: ["no.target", "heart.rate.zone"], end: "time", work: "Interval" },
    other: { mode: "endurance", label: "Other", targets: ["no.target", "heart.rate.zone"], end: "time", work: "Interval" },
    swimming: { mode: "json", label: "Swim", targets: [], end: "distance", work: "Swim" },
  };
  const TYPES = Object.keys(SPORTS);
  const sportOf = (w) => SPORTS[w && w.workoutType] || null;

  function modeOf(w) {
    const sport = sportOf(w);
    if (sport) return sport.mode;
    return w && typeof w.workoutType === "string" && w.workoutType ? "endurance" : "strength";
  }

  const kindLabel = (type, w) => (type === "interval" || type === "exercise" ? (sportOf(w) || SPORTS.other).work : WM.KIND_LABEL[type] || prettyName(type || "step"));

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

  function targetsFor(w, st) {
    const list = [...(sportOf(w) || SPORTS.other).targets];
    const own = st && st.targetType;
    if (own && !list.includes(own) && TARGETS[own]) list.push(own);
    return list;
  }


  function parseClock(text, bare = "s") {
    const t = String(text ?? "").trim().replace(/\s+/g, "").replace(",", ".");
    if (!t) return null;
    if (/^\d+(\.\d+)?$/.test(t)) return round(Number(t) * (bare === "min" ? 60 : 1), 1);
    const unit = /^(\d+(?:\.\d+)?)(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)$/i.exec(t);
    if (unit) return round(Number(unit[1]) * (/^h/i.test(unit[2]) ? 3600 : /^m/i.test(unit[2]) ? 60 : 1), 1);
    const m = /^(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
    if (!m || Number(m[3]) >= 60 || (m[1] !== undefined && Number(m[2]) >= 60)) return null;
    return round(Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]), 1);
  }

  const paceText = (speed) => (num(speed) > 0 ? WM.pace(speed) : "");

  function parsePace(text) {
    let t = String(text ?? "").trim().replace(/\s|\/km$/gi, "");
    if (/^\d{1,2}$/.test(t)) t = `${t}:00`;
    else if (/^\d{3,4}$/.test(t)) t = `${t.slice(0, -2)}:${t.slice(-2)}`;
    else if (/^\d{1,2}[.,]\d{2}$/.test(t)) t = t.replace(/[.,]/, ":");
    const seconds = /:/.test(t) ? parseClock(t) : null;
    return seconds && seconds >= 60 && seconds <= 3600 ? round(1000 / seconds, 3) : null;
  }

  const kmhText = (speed) => (num(speed) > 0 ? String(round(speed * 3.6, 1)) : "");
  function parseKmh(text) {
    const n = parseNumber(text);
    return n !== null && n > 0 && n < 200 ? round(n / 3.6, 3) : null;
  }

  function parseNumber(text) {
    const t = String(text ?? "").trim().replace(",", ".");
    return /^-?\d+(\.\d+)?$/.test(t) || /^-?\.\d+$/.test(t) ? Number(t) : null;
  }

  const distanceUnit = (meters) => (num(meters) && meters < 1000 && Number.isInteger(meters) ? "m" : "km");
  const distanceIn = (meters, unit) => (num(meters) ? String(unit === "m" ? round(meters, 1) : round(meters / 1000, 3)) : "");
  function parseDistance(text, unit = "km") {
    const m = /^\s*(\d+(?:[.,]\d+)?|[.,]\d+)\s*(km|m)?\s*$/i.exec(String(text ?? ""));
    if (!m) return null;
    const value = Number(m[1].replace(",", ".")), u = (m[2] || unit).toLowerCase();
    const meters = u === "km" ? value * 1000 : value;
    return meters > 0 ? round(meters, 1) : null;
  }

  function weightText(lb, unit = "lb") {
    if (!(num(lb) > 0)) return "";
    return String(unit === "kg" ? round(lb / LB_PER_KG, 1) : round(lb, 1));
  }
  function parseWeight(text, unit = "lb") {
    const n = parseNumber(text);
    if (n === null || n < 0) return null;
    return unit === "kg" ? round(n * LB_PER_KG, 2) : round(n, 1);
  }


  const MIRROR = { reps: "reps", time: "durationSeconds", distance: "distanceMeters" };

  function endOf(st) {
    const by = st.endCondition, v = num(st.endConditionValue);
    if (by === "lap.button") return { by: "lap", value: 0 };
    if (MIRROR[by]) return { by, value: v || num(st[MIRROR[by]]) };
    if (!by && st.stepType === "rest") return { by: "time", value: v || num(st.durationSeconds) };
    return { by: by || "", value: v };
  }

  function withEnd(st, by, value) {
    const lap = by === "lap", patch = { endCondition: lap ? "lap.button" : by, endConditionValue: lap ? 0 : value, reps: undefined, durationSeconds: undefined, distanceMeters: undefined };
    if (MIRROR[by]) patch[MIRROR[by]] = value;
    return patched(st, patch);
  }

  function targetOf(st) {
    const type = st.targetType || "no.target", a = st.targetValueOne, b = st.targetValueTwo;
    if (isNum(a) && isNum(b)) return { type, lo: Math.min(a, b), hi: Math.max(a, b) };
    return { type, lo: isNum(a) ? a : isNum(b) ? b : null, hi: null };
  }

  function withTarget(st, type, lo, hi) {
    if (type === "no.target" || type === "open") return patched(st, { targetType: type, targetValueOne: undefined, targetValueTwo: undefined });
    let one = isNum(lo) ? lo : undefined, two = isNum(hi) ? hi : undefined;
    if (one !== undefined && two !== undefined && one > two) [one, two] = [two, one];
    const now = targetOf(st);
    if (st.targetType === type && now.lo === (one ?? null) && now.hi === (two ?? null)) return st;
    return patched(st, { targetType: type, targetValueOne: one, targetValueTwo: two });
  }

  const withRest = (st, seconds) => patched(st, { restTimeSeconds: num(seconds) > 0 ? seconds : undefined });

  const isExercise = (st) => isStep(st) && !!st.exerciseName && !["warmup", "cooldown", "rest", "recovery"].includes(st.stepType);


  const isNested = (st) => isStep(st) && Array.isArray(st.repeatSteps);

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
    return out.map((s, i) => patched(s, { stepOrder: i + 1 }));
  }


  const once = (st) => ({ steps: [st], times: 1, gi: undefined });
  const copyStep = (st) => { const { repeatGroupIndex: _g, numberOfRepeats: _n, ...rest } = JSON.parse(JSON.stringify(st)); return rest; };

  function setTimes(blocks, k, times) {
    const b = blocks[k], n = Math.max(1, Math.floor(num(times)) || 1);
    if (n === b.times) return blocks;
    if (n > 1) return blocks.map((x, i) => (i === k ? { ...b, times: n } : x));
    return [...blocks.slice(0, k), ...b.steps.map(once), ...blocks.slice(k + 1)];
  }

  const insertBlocks = (blocks, at, added) => [...blocks.slice(0, at), ...added, ...blocks.slice(at)];
  const removeBlocks = (blocks, k, count = 1) => [...blocks.slice(0, k), ...blocks.slice(k + count)];

  function moveBlocks(blocks, k, count, to) {
    if (to >= k && to <= k + count) return blocks;
    const moving = blocks.slice(k, k + count), rest = removeBlocks(blocks, k, count);
    const at = to > k ? to - count : to;
    return insertBlocks(rest, at, moving);
  }

  function duplicateBlocks(blocks, k, count = 1) {
    const copies = blocks.slice(k, k + count).map((b) => ({ steps: b.steps.map(copyStep), times: b.times, gi: undefined }));
    return insertBlocks(blocks, k + count, copies);
  }

  function updateStep(blocks, k, j, fn) {
    const b = blocks[k], st = b.steps[j], next = fn(st);
    if (next === st) return blocks;
    return blocks.map((x, i) => (i === k ? { ...b, steps: b.steps.map((s, m) => (m === j ? next : s)) } : x));
  }

  function insertInto(blocks, k, j, steps) {
    const b = blocks[k], at = j === undefined ? b.steps.length : j;
    return blocks.map((x, i) => (i === k ? { ...b, times: Math.max(2, b.times), steps: [...b.steps.slice(0, at), ...steps, ...b.steps.slice(at)] } : x));
  }

  function takeOut(blocks, k, j, { keep = false, times = 1 } = {}) {
    const b = blocks[k], st = b.steps[j], left = b.steps.filter((_, m) => m !== j);
    const rest = left.length ? [{ ...b, steps: left }] : [];
    const out = keep ? [{ ...once(st), times: Math.max(1, times) }] : [];
    return [...blocks.slice(0, k), ...(keep && j === 0 ? [...out, ...rest] : [...rest, ...out]), ...blocks.slice(k + 1)];
  }

  function moveInside(blocks, k, j, by) {
    const b = blocks[k], to = j + by;
    if (to >= 0 && to < b.steps.length) {
      const steps = [...b.steps];
      [steps[j], steps[to]] = [steps[to], steps[j]];
      return blocks.map((x, i) => (i === k ? { ...b, steps } : x));
    }
    if (b.steps.length === 1) return blocks;
    const st = b.steps[j], left = { ...b, steps: b.steps.filter((_, m) => m !== j) }, alone = once(st);
    return [...blocks.slice(0, k), ...(to < 0 ? [alone, left] : [left, alone]), ...blocks.slice(k + 1)];
  }

  function joinBlocks(blocks, k, count, { superset = false } = {}) {
    const parts = blocks.slice(k, k + count), steps = parts.flatMap((b) => b.steps);
    const times = Math.max(2, ...parts.map((b) => b.times));
    const keptGi = parts.find((b) => b.times > 1 && b.gi !== undefined);
    const joined = superset ? steps.map((st, i) => (i < steps.length - 1 ? withRest(st, 0) : st)) : steps;
    return [...blocks.slice(0, k), { steps: joined, times, gi: keptGi ? keptGi.gi : undefined }, ...blocks.slice(k + count)];
  }

  function splitBlock(blocks, k) {
    const b = blocks[k];
    if (b.steps.length < 2) return blocks;
    return [...blocks.slice(0, k), ...b.steps.map((st, j) => ({ steps: [st], times: b.times, gi: j === 0 ? b.gi : undefined })), ...blocks.slice(k + 1)];
  }


  function eachSet(blocks, k) {
    const b = blocks[k];
    if (b.steps.length !== 1 || b.times < 2) return blocks;
    const sets = Array.from({ length: b.times }, (_, i) => once(i === 0 ? b.steps[0] : copyStep(b.steps[0])));
    return [...blocks.slice(0, k), ...sets, ...blocks.slice(k + 1)];
  }

  function sameSets(blocks, k, count) {
    const lines = blocks.slice(k, k + count);
    const key = (b) => JSON.stringify(copyStep(b.steps[0]), (name, v) => (name === "stepOrder" ? undefined : v));
    if (lines.some((b) => b.steps.length !== 1 || key(b) !== key(lines[0]))) return null;
    const times = lines.reduce((t, b) => t + b.times, 0);
    return [...blocks.slice(0, k), { steps: [lines[0].steps[0]], times, gi: lines.find((b) => b.gi !== undefined)?.gi }, ...blocks.slice(k + count)];
  }


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



  function newStep(w, type = "interval", end) {
    const sport = sportOf(w) || SPORTS.other;
    const [by, value] = end ? [end.by, end.value]
      : (type === "warmup" || type === "cooldown") && sport.mode === "strength" ? ["lap", 0]
      : TIMES[type] ? ["time", TIMES[type]]
      : sport.end === "distance" ? ["distance", 1000] : sport.end === "reps" ? ["reps", 10] : ["time", defaultTime(type)];
    return withEnd({ stepType: type, targetType: "no.target" }, by, value);
  }

  const TIMES = { warmup: 600, cooldown: 300, rest: 60, recovery: 120 };
  const defaultTime = (type) => TIMES[type] || 600;

  function newSet(exerciseName, { reps = 10, weight, rest = 90 } = {}) {
    let st = withEnd({ stepType: "interval", targetType: "no.target", exerciseName }, "reps", reps);
    if (num(weight) > 0) st = { ...st, weight };
    return withRest(st, rest);
  }

  function starterSteps(type) {
    const w = { workoutType: type }, work = { running: { by: "distance", value: 5000 }, cycling: { by: "time", value: 2400 } }[type];
    const blocks = modeOf(w) === "strength"
      ? [once(newStep(w, "warmup")), { steps: [newSet("BARBELL_BACK_SQUAT", { reps: 8 })], times: 3 }, { steps: [newSet("BARBELL_BENCH_PRESS", { reps: 8 })], times: 3 }]
      : work ? [newStep(w, "warmup"), newStep(w, "interval", work), newStep(w, "cooldown")].map(once)
      : [once(newStep(w, "interval", { by: "time", value: 1800 }))];
    return fromBlocks(blocks);
  }

  const newWorkout = (type, name) => ({ workoutName: name, workoutType: type, description: "", sendToDevice: true, steps: starterSteps(type) });

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


  const STEP_TYPES = ["warmup", "cooldown", "interval", "recovery", "rest", "exercise", "repeat", "other"];
  const END_TYPES = ["reps", "time", "distance", "lap.button", "iterations", "calories", "heart.rate"];

  function formProblem(w) {
    if (!w || typeof w !== "object" || Array.isArray(w)) return "This is not a workout.";
    if (w.steps !== undefined && !Array.isArray(w.steps)) return "Its steps are not a list.";
    const steps = w.steps || [], bad = steps.findIndex((s) => !isStep(s));
    if (bad >= 0) return `Step ${bad + 1} is not a step.`;
    if (flatten(steps) === null) return "A repeat holds another repeat, which the form cannot show.";
    if (modeOf(w) === "json") return `The form does not edit ${SPORTS[w.workoutType].label.toLowerCase()} workouts: the JSON does.`;
    return "";
  }

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


  const ALIASES = { DB: ["DUMBBELL"], BB: ["BARBELL"], KB: ["KETTLEBELL"], RDL: ["ROMANIAN", "DEADLIFT"], OHP: ["OVERHEAD", "PRESS"], SLDL: ["STIFF", "DEADLIFT"], PULLUP: ["PULL", "UP"], CHINUP: ["CHIN", "UP"], PUSHUP: ["PUSH", "UP"], SITUP: ["SIT", "UP"] };

  function searchExercises(all, query, { category, recent = [], limit = 60 } = {}) {
    const words = String(query ?? "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).flatMap((t) => ALIASES[t] || [t]);
    const rank = new Map(recent.map((name, i) => [name, i]));
    const hits = all.filter((e) => {
      if (category && e.category !== category) return false;
      const joined = words.length ? e.name.replace(/_/g, "") : "";
      return words.every((t) => e.name.includes(t) || joined.includes(t));
    });
    const starts = (e) => (words.length && e.name.startsWith(words[0]) ? 0 : 1);
    hits.sort((a, b) => (rank.has(a.name) ? rank.get(a.name) : 1e9) - (rank.has(b.name) ? rank.get(b.name) : 1e9) || starts(a) - starts(b) || a.name.length - b.name.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return hits.slice(0, limit);
  }

  return {
    SPORTS, TYPES, TARGETS, PRESETS,
    modeOf, kindLabel, targetUnit, targetsFor, prettyName,
    clock, parseClock, paceText, parsePace, kmhText, parseKmh, parseNumber, distanceUnit, distanceIn, parseDistance, weightText, parseWeight,
    endOf, withEnd, targetOf, withTarget, withRest, isExercise, patched, formProblem,
    flatten, toBlocks, fromBlocks,
    once, setTimes, insertBlocks, removeBlocks, moveBlocks, duplicateBlocks, updateStep, insertInto, takeOut, moveInside, joinBlocks, splitBlock, eachSet, sameSets, copyStep,
    strengthCards,
    newStep, newSet, defaultTime, starterSteps, newWorkout,
    check, searchExercises,
  };
});
