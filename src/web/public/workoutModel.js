/*
 * workoutModel.js — what one workout looks like as a picture: its step tree, a timeline of coloured
 * segments, the text on each card, and the estimated totals.
 *
 * Pure functions on the plan-format workout ({ workoutType, steps: [...] }), shared by the page
 * (which loads this as a plain script before its own code) and by the tests (which require() it).
 * Steps are the flat list the plan files use: a repeat is a run of consecutive steps that carry the
 * same repeatGroupIndex and a numberOfRepeats above 1. Nested repeatSteps are understood too.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WorkoutModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ASSUMED_PACE = 360; // seconds per km, for steps that give a distance or a time but no pace target
  const SECONDS_PER_REP = 3; // a rep step has no duration of its own; the estimate counts this much per rep
  const MIN_RUNS = 3; // fewer runs than this say too little about how fast you go
  const NEAREST_RUNS = 5; // runs at the closest heart rate that set the pace of a heart-rate step
  const MAX_SEGMENTS = 160; // beyond this, repeats are drawn once, as one wide segment

  const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
  const pad = (n) => String(n).padStart(2, "0");
  const prettyName = (key) => String(key).toLowerCase().split("_").map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(" ");
  const isStep = (s) => s !== null && typeof s === "object" && !Array.isArray(s);

  // ── Formatting ──────────────────────────────────────────────────────────

  /** 45 -> "0:45", 3725 -> "1:02:05" */
  function clock(seconds) {
    const s = Math.round(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  /** 45 -> "45 s", 1500 -> "25 min", 3900 -> "1 h 05 min" */
  function duration(seconds) {
    const s = Math.round(seconds);
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
  }

  /** 800 -> "800 m", 11800 -> "11.8 km" */
  function distance(meters) {
    return meters < 1000 ? `${Math.round(meters)} m` : `${+(meters / 1000).toFixed(2)} km`;
  }

  /** m/s -> "5:00" per km */
  function pace(speed) {
    return clock(1000 / speed);
  }

  // ── What a step is and what it asks for ─────────────────────────────────

  const KIND = { warmup: "warmup", cooldown: "cooldown", recovery: "recovery", rest: "rest", interval: "work", exercise: "work", repeat: "work" };
  const kindOf = (st) => KIND[st.stepType] || "other";
  const KIND_LABEL = { warmup: "Warm up", cooldown: "Cool down", recovery: "Recover", rest: "Rest", other: "Other" };
  const SPORT_LABEL = { running: "Run", cycling: "Ride", swimming: "Swim" };
  const GENERIC_EXERCISE = new Set(["RUN", "CARDIO"]); // names that say nothing a step's type has not said

  const isRun = (w, st) => (w && w.workoutType === "running") || (st && st.exerciseName === "RUN");

  /** An exercise done for a number of reps: the cards for these list their sets together. */
  const isSet = (st) => !!st.exerciseName && st.endCondition === "reps" && ["interval", "exercise", "other"].includes(st.stepType);

  function titleOf(st, w) {
    const kind = kindOf(st), exercise = st.exerciseName && !GENERIC_EXERCISE.has(st.exerciseName) ? prettyName(st.exerciseName) : "";
    if (kind === "work" || (kind === "other" && st.stepType === "other")) {
      return { title: exercise || SPORT_LABEL[w && w.workoutType] || "Interval", subtitle: "" };
    }
    return { title: KIND_LABEL[kind], subtitle: exercise };
  }

  /**
   * Learns how fast you run from past runs ({ pace: seconds per km, hr: average bpm }, as GET /api/runs lists them),
   * to time the steps that name no pace: a step with a heart-rate target takes the median pace of the runs nearest
   * that heart rate, any other step the easy pace (the median of the easier half of the runs). null when there are too few runs.
   */
  function pacerFrom(runs) {
    const list = (Array.isArray(runs) ? runs : []).filter((r) => r && num(r.pace) > 0 && num(r.hr) > 0);
    if (list.length < MIN_RUNS) return null;
    const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const easier = [...list].sort((a, b) => a.hr - b.hr).slice(0, Math.ceil(list.length / 2));
    return {
      runs: list.length,
      easy: median(easier.map((r) => r.pace)),
      forHr: (hr) => median([...list].sort((a, b) => Math.abs(a.hr - hr) - Math.abs(b.hr - hr)).slice(0, NEAREST_RUNS).map((r) => r.pace)),
    };
  }

  /** The target, as text, plus a number on a per-kind scale for the height of its bar. */
  function targetOf(st) {
    const a = num(st.targetValueOne), b = num(st.targetValueTwo), lo = Math.min(a || b, b || a), hi = Math.max(a, b);
    const span = (f, unit) => `${lo === hi ? f(lo) : `${f(lo)}–${f(hi)}`}${unit}`;
    switch (st.targetType) {
      case "heart.rate.zone":
        if (!lo) return null;
        return !b && a <= 5 ? { label: "Heart rate", value: `Zone ${a}`, kind: "hr", mid: 0 } : { label: "Heart rate", value: span(String, " bpm"), kind: "hr", mid: (lo + hi) / 2 };
      case "pace.zone":
        // the values are speeds in m/s; a pace lists the faster end first
        return lo ? { label: "Pace", value: `${lo === hi ? pace(lo) : `${pace(hi)}–${pace(lo)}`} /km`, kind: "speed", mid: (lo + hi) / 2 } : null;
      case "speed.zone":
        return lo ? { label: "Speed", value: span((v) => (v * 3.6).toFixed(1), " km/h"), kind: "speed", mid: (lo + hi) / 2 } : null;
      case "power.zone":
        return lo ? { label: "Power", value: span(String, " W"), kind: "power", mid: (lo + hi) / 2 } : null;
      case "cadence.zone":
        return lo ? { label: "Cadence", value: span(String, " spm"), kind: "cadence", mid: (lo + hi) / 2 } : null;
      case "open":
        return { label: "Target", value: "Open", kind: "", mid: 0 };
      default:
        return null;
    }
  }

  /** What ends the step, as one of seconds, meters, reps; lap is true when only the lap button ends it. */
  function measure(st) {
    const v = num(st.endConditionValue);
    if (st.endCondition === "reps") return { reps: v || num(st.reps) };
    if (st.endCondition === "time") return { seconds: v || num(st.durationSeconds) };
    if (st.endCondition === "distance") return { meters: v || num(st.distanceMeters) };
    if (!st.endCondition) return st.stepType === "rest" ? { seconds: v || num(st.durationSeconds) } : {};
    // lap.button and the rest: a duration or distance written beside it is the plan, the button is how it ends
    const lap = st.endCondition === "lap.button";
    if (num(st.durationSeconds)) return { seconds: st.durationSeconds, lap };
    if (num(st.distanceMeters)) return { meters: st.distanceMeters, lap };
    return lap ? { lap } : { other: { name: st.endCondition, value: v } };
  }

  /**
   * Seconds and meters of one run through the step. A step's own pace target sets its speed; with none, the pacer's
   * pace for its heart-rate target or its easy pace, and with no pacer 6:00/km. Those are assumed. open: nothing says how long.
   */
  function stepMetrics(st, w, pacer) {
    const m = measure(st), target = targetOf(st), run = isRun(w, st);
    let seconds = m.seconds || 0, meters = m.meters || 0, assumed = false, paceFrom = null;
    const speedOf = () => {
      if (target && target.kind === "speed") return target.mid;
      assumed = true;
      if (pacer) { paceFrom = "runs"; return 1000 / (target && target.kind === "hr" && target.mid ? pacer.forHr(target.mid) : pacer.easy); }
      paceFrom = "default";
      return 1000 / ASSUMED_PACE;
    };
    if (meters && !seconds) {
      const sp = run || (target && target.kind === "speed") ? speedOf() : 0;
      if (sp) seconds = meters / sp;
    } else if (seconds && !meters && run) {
      meters = seconds * speedOf();
    } else if (m.reps) {
      seconds = m.reps * SECONDS_PER_REP; assumed = true;
    }
    return { seconds, meters, assumed, paceFrom, open: !seconds && !meters };
  }

  const loadOf = (st) => num(st.weight) || num(st.weightPercentage);

  /** The text on a step's card: a title and the values that go under it, each with a label. */
  function describeStep(st, w) {
    const { title, subtitle } = titleOf(st, w), m = measure(st), metrics = [];
    if (m.seconds) metrics.push({ value: clock(m.seconds), label: m.lap ? "Time (lap button)" : "Time" });
    else if (m.meters) metrics.push({ value: distance(m.meters), label: m.lap ? "Distance (lap button)" : "Distance" });
    else if (m.reps) metrics.push({ value: String(m.reps), label: "Reps" });
    else if (m.lap) metrics.push({ value: "Lap button", label: "Ends when you press it" });
    else if (m.other) metrics.push({ value: m.other.value ? String(m.other.value) : "—", label: prettyName(m.other.name) });
    const target = targetOf(st);
    if (target) metrics.push({ value: target.value, label: target.label });
    if (num(st.weight)) metrics.push({ value: `${st.weight} lb`, label: "Weight" });
    if (num(st.weightPercentage)) metrics.push({ value: `${st.weightPercentage}%`, label: `of ${st.benchmarkKey ? prettyName(st.benchmarkKey) : "1RM"}` });
    if (num(st.restTimeSeconds)) metrics.push({ value: clock(st.restTimeSeconds), label: "Rest" });
    return { kind: kindOf(st), title, subtitle, metrics, open: !!m.lap && !m.seconds && !m.meters };
  }

  /** The line a set has on its exercise's card. */
  function describeSet(st, times) {
    return {
      times,
      reps: String(num(st.endConditionValue) || num(st.reps)),
      load: num(st.weight) ? `${st.weight} lb` : num(st.weightPercentage) ? `${st.weightPercentage}%` : "",
      rest: num(st.restTimeSeconds) ? clock(st.restTimeSeconds) : "",
    };
  }

  // ── The step tree ───────────────────────────────────────────────────────
  // step: one step, once | sets: one exercise's consecutive sets | group: steps done N times.
  // Every node has a key, which ties a card to its segments in the profile; steps carry their
  // position in the list (index), which is how a difference with Garmin names them.

  function buildTree(steps) {
    let key = 0;
    const list = Array.isArray(steps) ? steps : [];

    function add(out, st, index, times) {
      if (isSet(st)) {
        const last = out[out.length - 1];
        if (last && last.kind === "sets" && last.name === st.exerciseName) last.lines.push({ st, index, times });
        else out.push({ kind: "sets", key: key++, name: st.exerciseName, lines: [{ st, index, times }] });
      } else if (times > 1) {
        out.push({ kind: "group", key: key++, times, children: [{ kind: "step", key: key++, st, index }] });
      } else out.push({ kind: "step", key: key++, st, index });
    }

    function walk(entries, out) {
      for (let i = 0; i < entries.length; ) {
        const { st, index } = entries[i];
        if (Array.isArray(st.repeatSteps) && st.repeatSteps.length) {
          const times = Math.max(1, num(st.numberOfRepeats) || 1), inner = [];
          walk(st.repeatSteps.filter(isStep).map((s) => ({ st: s, index: null })), inner);
          if (times > 1) out.push({ kind: "group", key: key++, times, children: inner });
          else out.push(...inner);
          i++;
          continue;
        }
        const times = Math.max(1, num(st.numberOfRepeats) || 1);
        const members = [entries[i]];
        if (st.repeatGroupIndex !== undefined && st.repeatGroupIndex !== null) {
          while (i + members.length < entries.length && entries[i + members.length].st.repeatGroupIndex === st.repeatGroupIndex) members.push(entries[i + members.length]);
        }
        i += members.length;
        if (times <= 1 || st.repeatGroupIndex === undefined || st.repeatGroupIndex === null) {
          // a group that repeats once is just its steps
          for (const m of members) add(out, m.st, m.index, 1);
        } else if (members.length === 1) add(out, st, index, times);
        else {
          const children = [];
          for (const m of members) add(children, m.st, m.index, 1);
          out.push({ kind: "group", key: key++, times, children });
        }
      }
    }

    const nodes = [];
    walk(list.map((st, index) => ({ st, index })).filter((e) => isStep(e.st)), nodes);
    return nodes;
  }

  /** A group of more than one exercise, done in rounds. */
  const isSuperset = (group) => new Set(group.children.flatMap((c) => (c.kind === "sets" ? [c.name] : []))).size > 1;

  // ── The profile ─────────────────────────────────────────────────────────

  const TIER = { warmup: 0.5, cooldown: 0.5, work: 0.8, recovery: 0.3, rest: 0.2, other: 0.6 };

  function timeline(nodes, w, expand, pacer) {
    const segs = [];
    const push = (key, st, count, index) => {
      const m = stepMetrics(st, w, pacer), text = describeStep(st, w);
      segs.push({ key, index, kind: kindOf(st), st, seconds: m.seconds * count, meters: m.meters * count, assumed: m.assumed, paceFrom: m.paceFrom, open: m.open, count, text: [text.title, ...text.metrics.filter((x) => x.label !== "Rest").map((x) => (x.label === "Reps" ? `${x.value} reps` : x.value))].join(" · ") });
      if (num(st.restTimeSeconds)) segs.push({ key, index, kind: "rest", st, seconds: st.restTimeSeconds * count, meters: 0, assumed: false, paceFrom: null, open: false, count, text: `Rest ${clock(st.restTimeSeconds)}` });
    };
    (function walk(list, mult) {
      for (const n of list) {
        if (n.kind === "step") push(n.key, n.st, mult, n.index);
        else if (n.kind === "sets") {
          for (const { st, times, index } of n.lines) {
            if (expand) for (let t = 0; t < times; t++) push(n.key, st, mult, index);
            else push(n.key, st, times * mult, index);
          }
        } else if (expand) for (let r = 0; r < n.times; r++) walk(n.children, mult);
        else walk(n.children, mult * n.times);
      }
    })(nodes, 1);
    return segs;
  }

  /** Give each segment a weight (its width) and a height (0 to 1) for the bar chart. */
  function shape(segs) {
    const known = segs.reduce((t, s) => t + s.seconds, 0) || segs.length * 60;
    for (const s of segs) {
      // lap-button steps and steps of unknown length get a placeholder of at least three minutes, so they show; short ones get a minimum
      s.weight = s.seconds ? Math.max(s.seconds, known * 0.012) : Math.max(known * 0.12, 180);
    }
    const levels = {}, loads = {};
    for (const s of segs) {
      const t = targetOf(s.st);
      if (t && t.kind && t.mid) { const l = (levels[t.kind] = levels[t.kind] || { lo: Infinity, hi: -Infinity }); l.lo = Math.min(l.lo, t.mid); l.hi = Math.max(l.hi, t.mid); }
      const load = loadOf(s.st);
      if (load) { const k = num(s.st.weight) ? "weight" : "percentage"; loads[k] = Math.max(loads[k] || 0, load); }
    }
    for (const s of segs) {
      let h = TIER[s.kind] ?? TIER.other;
      const t = s.kind === "rest" ? null : targetOf(s.st), load = s.kind === "rest" ? 0 : loadOf(s.st);
      if (load) h = 0.35 + 0.6 * (load / loads[num(s.st.weight) ? "weight" : "percentage"]);
      else if (t && t.kind && levels[t.kind] && levels[t.kind].hi > levels[t.kind].lo) h *= 0.8 + 0.2 * ((t.mid - levels[t.kind].lo) / (levels[t.kind].hi - levels[t.kind].lo));
      s.height = Math.max(0.15, Math.min(1, h));
    }
    return segs;
  }

  /** Everything the picture needs for one workout. options.pacer (from pacerFrom) times the steps that name no pace. */
  function analyze(w, options) {
    const pacer = (options && options.pacer) || null;
    const steps = w && Array.isArray(w.steps) ? w.steps.filter(isStep) : [];
    const tree = buildTree(steps);
    let segments = timeline(tree, w, true, pacer);
    if (segments.length > MAX_SEGMENTS) segments = timeline(tree, w, false, pacer);
    shape(segments);
    const total = { seconds: 0, meters: 0, assumed: false, open: 0, paceFrom: null };
    for (const s of segments) {
      total.seconds += s.seconds; total.meters += s.meters;
      if (s.assumed) total.assumed = true;
      if (s.paceFrom && total.paceFrom !== "runs") total.paceFrom = s.paceFrom;
      if (s.open && s.kind !== "rest") total.open++;
    }
    const exercises = new Set(), perExercise = new Map(), sets = (function count(list, mult) {
      return list.reduce((n, node) => {
        if (node.kind === "sets") {
          const times = node.lines.reduce((t, l) => t + l.times * mult, 0);
          exercises.add(node.name); perExercise.set(node.name, (perExercise.get(node.name) || 0) + times);
          return n + times;
        }
        return n + (node.kind === "group" ? count(node.children, mult * node.times) : 0);
      }, 0);
    })(tree, 1);
    const estimated = !total.seconds && num(w && w.estimatedDurationSeconds);
    return {
      tree, segments, steps: steps.length, sets, exercises: exercises.size, setCounts: [...perExercise].map(([name, count]) => ({ name, sets: count })),
      seconds: total.seconds || estimated || 0, meters: total.meters || num(w && w.distanceMeters),
      assumed: total.assumed, open: total.open, pace: { from: total.paceFrom, runs: pacer ? pacer.runs : 0, easy: pacer ? pacer.easy : ASSUMED_PACE }, hasSteps: steps.length > 0,
    };
  }

  /** Positions (0-based) of the steps that a list of differences from Garmin names. */
  function changedSteps(differences) {
    const out = new Set();
    for (const d of differences || []) {
      let m = /^Step (\d+)\b/.exec(d);
      if (m) { out.add(+m[1] - 1); continue; }
      m = /^Steps: (\d+) in the plan, (\d+) on Garmin/.exec(d);
      if (m) for (let i = Math.min(+m[1], +m[2]); i < Math.max(+m[1], +m[2]); i++) out.add(i);
    }
    return out;
  }

  return { analyze, pacerFrom, buildTree, describeStep, describeSet, changedSteps, isSuperset, clock, duration, distance, pace, targetOf, stepMetrics, prettyName, ASSUMED_PACE, SECONDS_PER_REP };
});
