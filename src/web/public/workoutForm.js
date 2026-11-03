/*
 * workoutForm.js — the workout form: a workout's name, type, days and notes, and its steps edited in place, as exercises with their
 * sets (strength) or as steps and repeats that each aim for one target (run, ride, cardio).
 *
 * The form keeps no copy of the workout. It reads the workout from its host each time it draws (the plan open in the Plans view, or
 * the workout in the Workouts view's dialog), and every change goes back through the host, whose JSON editor holds it: the JSON is one
 * tap away and already shows the change, Undo is the editor's, and Save, the checks and the comparison with Garmin work as before.
 * What the steps mean (blocks, edits, units, checks) is workoutFormModel.js; this file draws it and turns taps into its edits.
 *
 * A plain script: the page loads it after workoutModel.js, workoutFormModel.js, exerciseMuscles.js and muscleMap.js.
 */
(function (root) {
  "use strict";
  const M = root.WorkoutFormModel, WM = root.WorkoutModel;
  const REST_CHOICES = [0, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300];
  const DRAG_SLOP = 4; // pixels a grip moves before it drags
  let seq = 0;

  /** An element: h("div", { class, text, value, on…: handler, other attributes }, ...children). */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "value") el.value = v;
      else if (k.startsWith("on")) el[k] = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  }

  const muscleLabel = (id) => ((root.MuscleMap && root.MuscleMap.MUSCLES.find((m) => m.id === id)) || { label: id }).label;
  const muscles = (name) => {
    const m = root.MuscleMap ? root.MuscleMap.musclesOf(name) : null;
    return m ? m.primary.map(muscleLabel).join(" · ") : "";
  };
  /** Whether a name is one of Garmin's exercises: exerciseMuscles.js lists every one (a test keeps it so), so no request is needed. */
  const known = root.MuscleMap ? (name) => Object.prototype.hasOwnProperty.call(root.MuscleMap.EXERCISES, name) : null;

  /** The box that scrolls: `node` itself, or the nearest box around it. */
  function scroller(node) {
    for (let n = node; n; n = n.parentElement) {
      const s = getComputedStyle(n).overflowY;
      if ((s === "auto" || s === "scroll") && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement;
  }

  /**
   * Put `nodes` in `box` in place of what it holds, as the person had it: the box it scrolls in stays where it was (Chrome scrolls it to
   * its top when the focused element goes), and the field that had the focus has it again (the one with the same data-fk), with its
   * selection. The page's plan view draws with it too.
   */
  function redraw(box, nodes) {
    const active = document.activeElement, inside = !!active && box.contains(active);
    const key = inside ? active.getAttribute("data-fk") : null;
    const sel = inside && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    const pane = scroller(box), top = pane.scrollTop;
    box.replaceChildren(...nodes);
    pane.scrollTop = top;
    const again = key && box.querySelector(`[data-fk="${CSS.escape(key)}"]`);
    if (!again || again.disabled) return;
    again.focus({ preventScroll: true });
    if (sel && again.setSelectionRange && again.type === "text") try { again.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ }
  }

  /**
   * A form for one workout. opts:
   *   read()          → { workout, problem }: the workout as the host holds it now, or why there is none to show
   *   write(workout)  the workout changed: the host keeps it (in its JSON, with an Undo step)
   *   unit()          "lb" or "kg": how weights are shown and typed (they are kept in lb)
   *   pacer()         the pacer of workoutModel.js for the estimates (or null)
   *   picture(w, a)   an element that draws the workout (its profile, or the muscles it works); `a` is WM.analyze's answer
   *   about(a)        [ⓘ button, note] saying how the estimate was timed, or null (the page's help())
   *   exercises()     a promise of { exercises: [{ name, category }], used: [names] }, asked when the picker first opens
   *   isDay(v), today()  the page's: a real day of the calendar written YYYY-MM-DD, and today's
   *   phone()         whether the screen is a phone's; place(menu, anchor) puts a menu by its button (a phone shows it as a sheet)
   *   toast(text), toastUndo(text, undo), undo(), ask(dialog options) → answer or null, toJson(stepIndex), modal(dialog)
   * Returns { el, render, schedule, retime }: render draws it again from read(); schedule does so once the current event is over; retime
   * draws its overview again and nothing else (the estimate, once the runs it is timed from are known), so no field is replaced.
   */
  function create(opts) {
    const el = h("div", { class: "wf" });
    const units = new Map(); // the unit (km or m) a distance field was switched to, by field
    const listId = `wf-rests-${++seq}`;
    let renderTimer = 0, catalog = null, drag = null, follow = null; // follow: the card a keyboard move took, which keeps the focus
    let overviewNodes = []; // what the last draw's overview() put in the form, for retime()

    function render() {
      clearTimeout(renderTimer);
      redraw(el, draw().flat().filter(Boolean));
      if (follow === null) return;
      const card = el.querySelectorAll(".wf-list > .wf-card")[follow];
      follow = null;
      card?.querySelector("input, select, button")?.focus({ preventScroll: true });
    }
    /** Draw again once the event that changed the workout is over: a field left by Tab has given the focus to the next one by then. */
    const schedule = () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 0); };

    /** Garmin's exercises and their categories, asked once, when the picker first opens; worked out once for the picker's lists. */
    function loadCatalog() {
      catalog = catalog || Promise.resolve(opts.exercises()).then((r) => ({
        all: r.exercises,
        used: r.used || [],
        categories: [...new Set(r.exercises.map((e) => e.category))].sort(),
        byName: new Map(r.exercises.map((e) => [e.name, e])),
      }), (e) => { catalog = null; throw e; });
      return catalog;
    }

    // ── Drawing ──

    function draw() {
      overviewNodes = [];
      const { workout: w, problem } = opts.read();
      if (!w) return [h("div", { class: "wf-note", text: problem || "No workout." })];
      const trouble = problem || M.formProblem(w);
      if (trouble) return [h("div", { class: "wf-note warn" }, h("p", { text: trouble }), h("button", { type: "button", onclick: () => opts.toJson(null) }, "Edit in JSON"))];
      const flat = M.flatten(w.steps || []), blocks = M.toBlocks(flat);
      const offsets = []; blocks.reduce((at, b, k) => { offsets[k] = at; return at + b.steps.length; }, 0);
      const problems = new Map();
      for (const p of M.check({ ...w, steps: flat }, known)) (problems.get(p.i) || problems.set(p.i, []).get(p.i)).push(p);
      const ctx = { w, flat, blocks, offsets, problems, mode: M.modeOf(w), unit: opts.unit() };
      ctx.cards = ctx.mode === "strength" ? M.strengthCards(blocks) : blocks.map((b, k) => ({ kind: b.times > 1 ? "repeat" : "step", k, count: 1 }));
      overviewNodes = [overview(ctx)].flat().filter(Boolean);
      return [head(ctx), overviewNodes, stepsOf(ctx), adder(ctx), restList()];
    }

    /** The overview drawn again in its place, from the workout as it is now: a field being typed in or picked from is left alone. */
    function retime() {
      if (!overviewNodes.length || !overviewNodes[0].isConnected || overviewNodes.some((n) => n.contains(document.activeElement))) return;
      const { workout: w, problem } = opts.read();
      if (!w || problem || M.formProblem(w)) return;
      const now = [overview({ w, flat: M.flatten(w.steps || []), unit: opts.unit() })].flat().filter(Boolean);
      overviewNodes[0].before(...now);
      for (const n of overviewNodes) n.remove();
      overviewNodes = now;
    }

    const write = (w) => opts.write(w);
    const writeBlocks = (ctx, blocks) => write({ ...ctx.w, steps: M.fromBlocks(blocks) });
    const writeStep = (ctx, k, j, fn) => writeBlocks(ctx, M.updateStep(ctx.blocks, k, j, fn));

    /** A field that was typed wrong: it says so, and keeps what was typed so it can be put right. */
    function bad(input, text) {
      input.setAttribute("aria-invalid", "true");
      opts.toast(text);
    }

    function restList() {
      return h("datalist", { id: listId }, REST_CHOICES.map((s) => h("option", { value: M.clock(s) })));
    }

    // ── Small fields ──

    /** A field with its label above it. */
    const field = (label, ...controls) => h("div", { class: "wf-f" }, h("span", { class: "wf-fl", text: label }), h("div", { class: "wf-fc" }, controls));

    /**
     * A text field that keeps what `parse` makes of what is typed (trimmed): `set` gets it; null is text that is not one (said as
     * `what: …`, and kept to be put right).
     */
    function entry({ value, label, fk, mode = "decimal", placeholder, list }, parse, what, set) {
      const input = h("input", { type: "text", inputmode: mode, class: "wf-num", value, placeholder, list, "aria-label": label, "data-fk": fk });
      input.onchange = () => {
        const text = input.value.trim(), v = parse(text);
        if (v === null) return bad(input, `${what}: ${text}`);
        set(v);
      };
      return input;
    }
    const positive = (n) => (n !== null && n > 0 ? n : null);

    /** A number with − and + beside it (a phone's thumb), between min and max. */
    function stepper(value, min, max, set, fk, label) {
      const now = Math.round(Number(value) || 0);
      const input = h("input", { type: "text", inputmode: "numeric", class: "wf-num wf-int", value: now ? String(now) : "", "aria-label": label, "data-fk": fk });
      const go = (n) => { const v = Math.max(min, Math.min(max, n)); if (v !== now) set(v); else input.value = String(now || ""); };
      input.onchange = () => { const n = parseInt(input.value, 10); if (Number.isFinite(n)) go(n); else bad(input, `Not a number: ${input.value.trim()}`); };
      return h("span", { class: "wf-stepper" },
        h("button", { type: "button", class: "wf-sb", "aria-label": `${label}: one less`, disabled: now <= min, "data-fk": fk + ":-", onclick: () => go(now - 1) }, "−"),
        input,
        h("button", { type: "button", class: "wf-sb", "aria-label": `${label}: one more`, disabled: now >= max, "data-fk": fk + ":+", onclick: () => go(now + 1) }, "+"));
    }

    /** The field of how a step ends: its reps (a stepper), its time (a bare number counts as `bare`), or the number another of Garmin's ends counts; null on the lap button. */
    function endInput(ctx, k, j, end, bare) {
      const key = `${k}:${j}`;
      if (end.by === "reps") return stepper(end.value, 1, 999, (n) => writeStep(ctx, k, j, (s) => M.withEnd(s, "reps", n)), `reps:${key}`, "Reps");
      if (end.by === "time") return entry({ value: end.value ? M.clock(end.value) : "", label: "Time", fk: `t:${key}`, mode: "text", placeholder: "m:ss" }, (t) => positive(M.parseClock(t, bare)), "Not a time", (sec) => writeStep(ctx, k, j, (s) => M.withEnd(s, "time", sec)));
      if (end.by && end.by !== "lap") return entry({ value: end.value ? String(end.value) : "", label: M.prettyName(end.by), fk: `ev:${key}` }, (t) => positive(M.parseNumber(t)), "Not a number above 0", (n) => writeStep(ctx, k, j, (s) => M.patched(s, { endConditionValue: n })));
      return null;
    }

    /** The rest after a set or a step: typed as 1:30 or in seconds, emptied for none. */
    const restInput = (ctx, k, j, st, label) => entry({ value: st.restTimeSeconds ? M.clock(st.restTimeSeconds) : "", label, fk: `rest:${k}:${j}`, mode: "numeric", placeholder: "—", list: listId },
      (t) => (t ? M.parseClock(t, "s") : 0), "Not a time", (sec) => writeStep(ctx, k, j, (s) => M.withRest(s, sec)));

    // ── The head: name, type, days, notes ──

    function head(ctx) {
      const { w } = ctx;
      const name = h("input", { type: "text", class: "wf-name", value: w.workoutName ?? "", placeholder: "Workout name", "aria-label": "Workout name", autocomplete: "off", spellcheck: "false", "data-fk": "name" });
      name.onchange = () => {
        const v = name.value.trim();
        if (!v) { name.value = w.workoutName ?? ""; opts.toast("A workout needs a name."); return; }
        if (v !== w.workoutName) write({ ...w, workoutName: v });
      };
      const type = h("select", { "aria-label": "Type of workout", "data-fk": "type" });
      for (const t of M.TYPES) type.add(new Option(M.SPORTS[t].label, t));
      if (!M.SPORTS[w.workoutType]) type.add(new Option(w.workoutType ? M.prettyName(w.workoutType) : "No type", w.workoutType ?? ""));
      type.value = w.workoutType ?? "";
      type.onchange = () => changeType(ctx, type.value);
      const send = h("input", { type: "checkbox", "data-fk": "send" });
      send.checked = !!w.sendToDevice;
      send.onchange = () => write(M.patched(w, { sendToDevice: send.checked ? true : undefined }));

      const days = [].concat(w.scheduledDate ?? []);
      const setDays = (list) => write(M.patched(w, { scheduledDate: list.length === 0 ? undefined : list.length === 1 ? list[0] : list }));
      const dayBox = h("div", { class: "wf-days" });
      days.forEach((d, i) => {
        const input = h("input", { type: opts.isDay(d) ? "date" : "text", value: String(d), "aria-label": `Day ${i + 1}`, "data-fk": `day:${i}` });
        input.onchange = () => { const v = input.value.trim(); setDays(v ? days.map((x, j) => (j === i ? v : x)) : days.filter((_, j) => j !== i)); };
        dayBox.append(h("span", { class: "wf-day" }, input, h("button", { type: "button", class: "wf-x", title: "Not on this day", "aria-label": `Not on ${d}`, "data-fk": `dayx:${i}`, onclick: () => setDays(days.filter((_, j) => j !== i)) }, "×")));
      });
      // a day added is a week after the last one (else today)
      const nextDay = () => {
        const last = [...days].reverse().find(opts.isDay);
        return last ? new Date(Date.parse(last + "T00:00:00Z") + 7 * 864e5).toISOString().slice(0, 10) : opts.today();
      };
      dayBox.append(h("button", { type: "button", class: "wf-link", "data-fk": "addday", onclick: () => setDays([...days, nextDay()]) }, days.length ? "+ Day" : "+ Schedule"));

      const notes = h("textarea", { class: "wf-notes", rows: 1, placeholder: "Notes", "aria-label": "Notes", "data-fk": "desc" });
      notes.value = w.description ?? "";
      const fit = () => { notes.style.height = "auto"; notes.style.height = Math.min(notes.scrollHeight + 2, 240) + "px"; };
      notes.oninput = fit;
      requestAnimationFrame(fit);
      notes.onchange = () => write(M.patched(w, { description: notes.value === "" && w.description === undefined ? undefined : notes.value }));

      return h("section", { class: "wf-head" },
        name,
        h("div", { class: "wf-row" },
          h("label", { class: "wf-f" }, h("span", { class: "wf-fl", text: "Type" }), type),
          h("label", { class: "wf-check" }, send, "Send to watch"),
          w.workoutId !== undefined && w.workoutId !== null && w.workoutId !== "" ? h("small", { class: "wf-dim", text: `On Garmin · ${w.workoutId}`, title: "Garmin's id of this workout: an upload replaces it" }) : null),
        h("div", { class: "wf-row" }, field("Days", dayBox)),
        notes);
    }

    async function changeType(ctx, type) {
      const { w, flat } = ctx, from = M.modeOf(w), to = M.modeOf({ workoutType: type });
      let steps = w.steps;
      if (from !== to && from !== "json" && to !== "json" && flat.length) {
        const label = (M.SPORTS[type] || { label: type }).label.toLowerCase();
        const answer = await opts.ask({
          title: `Make it a ${label} workout?`,
          text: to === "strength" ? "Its steps are not exercises." : "Its steps are exercises with sets.",
          options: [{ id: "fresh", checked: true, label: `Start its steps again as a new ${label} workout (Undo brings these back)` }],
          ok: "Change the type",
        });
        if (!answer) return render();
        if (answer.fresh) steps = M.starterSteps(type);
      } else if (from === "endurance" && to === "endurance") {
        // a pace and a speed are both kept in m/s: a pace on a ride becomes a speed, and a speed on a run a pace
        const swap = { cycling: ["pace.zone", "speed.zone"], running: ["speed.zone", "pace.zone"] }[type];
        if (swap && flat.some((st) => st.targetType === swap[0])) steps = flat.map((st) => (st.targetType === swap[0] ? { ...st, targetType: swap[1] } : st));
      }
      write({ ...w, workoutType: type, ...(steps !== undefined ? { steps } : {}) });
    }

    // ── The overview: the estimate in a line, and the picture ──

    function overview(ctx) {
      const w = { ...ctx.w, steps: ctx.flat };
      if (!ctx.flat.length && !w.distanceMeters) return null;
      const a = WM.analyze(w, { pacer: opts.pacer(), unit: ctx.unit }), approx = a.assumed || a.open ? "~" : "";
      const parts = [];
      if (a.seconds) parts.push(approx + WM.duration(a.seconds));
      if (a.meters) parts.push(approx + WM.distance(a.meters));
      if (a.sets) parts.push(`${a.sets} set${a.sets === 1 ? "" : "s"} · ${a.exercises} exercise${a.exercises === 1 ? "" : "s"}`);
      else if (a.steps) parts.push(`${a.steps} step${a.steps === 1 ? "" : "s"}`);
      const summary = h("summary", { text: parts.join(" · ") || "Overview" });
      const box = h("details", { class: "wf-pic" }, summary);
      if (overviewOpen === null) overviewOpen = !opts.phone(); // open on a desktop, shut on a phone until opened
      box.open = overviewOpen;
      box.ontoggle = () => { overviewOpen = box.open; if (box.open && !box.querySelector(".wvbox")) box.append(opts.picture(w, a)); };
      if (box.open) box.append(opts.picture(w, a));
      // how the steps with no pace were timed: behind an ⓘ in the line, the note under it (outside the box, so it shows when shut)
      const about = opts.about ? opts.about(a) : null;
      if (!about) return box;
      summary.append(about[0]);
      return [box, about[1]];
    }

    // ── The steps ──

    function stepsOf(ctx) {
      if (ctx.mode !== "strength" && !ctx.flat.length && ctx.w.distanceMeters) return distanceOnly(ctx);
      const list = h("ol", { class: "wf-list", "aria-label": ctx.mode === "strength" ? "Exercises" : "Steps" });
      ctx.cards.forEach((card, c) => list.append(cardOf(ctx, card, c)));
      if (!ctx.cards.length) list.append(h("li", { class: "wf-note", text: ctx.mode === "strength" ? "No exercises yet." : "No steps yet." }));
      list.addEventListener("pointerdown", (e) => startDrag(e, ctx, list));
      list.addEventListener("keydown", (e) => {
        if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        const li = e.target.closest(".wf-card");
        if (!li || li.parentElement !== list) return;
        const c = +li.dataset.c, by = e.key === "ArrowUp" ? -1 : 1, to = moveTo(ctx, c, by);
        if (to === null) return;
        e.preventDefault();
        follow = c + by;
        writeBlocks(ctx, M.moveBlocks(ctx.blocks, ctx.cards[c].k, ctx.cards[c].count, to));
      });
      return list;
    }

    function cardOf(ctx, card, c) {
      if (card.kind === "exercise") return exerciseCard(ctx, card, c);
      if (card.kind === "superset") return supersetCard(ctx, card, c);
      if (card.kind === "repeat") return repeatCard(ctx, card, c);
      const st = ctx.blocks[card.k].steps[0];
      return h("li", { class: `wf-card k-${WM.kindOf(st)}`, "data-c": c }, stepRow(ctx, card.k, 0, c));
    }

    /** Where card c lands one place up (by -1) or down (1), as the block index moveBlocks takes; null at either end. */
    function moveTo(ctx, c, by) {
      const other = ctx.cards[c + by];
      if (!other) return null;
      return by < 0 ? other.k : other.k + other.count;
    }

    const grip = () => h("span", { class: "wf-grip", title: "Drag to move (or Alt+↑ / Alt+↓)", "aria-hidden": "true" }, "⠿");
    const link = (label, fk, onclick, aria) => h("button", { type: "button", class: "wf-link", "data-fk": fk, "aria-label": aria, title: aria, onclick }, label);

    /** The menu of a card: move it, duplicate it, its own items, its JSON, delete it (with Undo). */
    function cardMenu(ctx, c, what, extra) {
      const card = ctx.cards[c], up = moveTo(ctx, c, -1), down = moveTo(ctx, c, 1);
      return [
        up !== null && { label: "Move up", run: () => writeBlocks(ctx, M.moveBlocks(ctx.blocks, card.k, card.count, up)) },
        down !== null && { label: "Move down", run: () => writeBlocks(ctx, M.moveBlocks(ctx.blocks, card.k, card.count, down)) },
        { label: "Duplicate", run: () => writeBlocks(ctx, M.duplicateBlocks(ctx.blocks, card.k, card.count)) },
        ...extra,
        { label: "Edit in JSON", run: () => opts.toJson(ctx.offsets[card.k]) },
        { label: "Delete", danger: true, run: () => { writeBlocks(ctx, M.removeBlocks(ctx.blocks, card.k, card.count)); opts.toastUndo(`${what} deleted`, opts.undo); } },
      ];
    }

    /** The menu of step j of repeat (or superset) k: move it inside, its own items, its JSON, delete it (with Undo). */
    function insideMenu(ctx, k, j, what, extra) {
      const b = ctx.blocks[k];
      return [
        j > 0 && { label: "Move up", run: () => writeBlocks(ctx, M.moveInside(ctx.blocks, k, j, -1)) },
        j < b.steps.length - 1 && { label: "Move down", run: () => writeBlocks(ctx, M.moveInside(ctx.blocks, k, j, 1)) },
        ...extra,
        { label: "Edit in JSON", run: () => opts.toJson(ctx.offsets[k] + j) },
        { label: "Delete", danger: true, run: () => { writeBlocks(ctx, b.steps.length > 1 ? M.takeOut(ctx.blocks, k, j) : M.removeBlocks(ctx.blocks, k)); opts.toastUndo(`${what} deleted`, opts.undo); } },
      ];
    }

    /** The head of a repeat or a superset: its title, how many times, its menu. */
    const groupHead = (ctx, k, title, word, items) => h("div", { class: "wf-ch" }, grip(),
      h("div", { class: "wf-t" }, h("span", { class: "wf-title", text: title })),
      h("div", { class: "wf-times" }, stepper(ctx.blocks[k].times, 2, 99, (n) => writeBlocks(ctx, M.setTimes(ctx.blocks, k, n)), `times:${k}`, word === "rounds" ? "Rounds" : "Times"), h("span", { class: "wf-dim", text: word })),
      menu(items, `More for the ${title.toLowerCase()}`, `menu:${k}`));

    /** An exercise's name, which opens the picker (`rename(to)` gets the one picked), and the muscles it works. */
    function exerciseTitle(name, fk, rename) {
      const pick = h("button", { type: "button", class: "wf-exname", title: "Pick another exercise", "data-fk": fk }, M.prettyName(name), h("span", { class: "wf-caret", "aria-hidden": "true" }, " ▾"));
      pick.onclick = () => pickExercise(name).then((to) => { if (to && to !== name) rename(to); });
      const worked = muscles(name);
      return h("div", { class: "wf-t" }, pick, worked ? h("small", { class: "wf-dim", text: worked }) : null);
    }

    /** The problems of the step at flat position i, under the part of the form that edits it. */
    function messages(ctx, i) {
      const list = ctx.problems.get(i) || [];
      return list.length ? h("div", { class: "wf-msgs" }, list.map((p) => h("div", { class: "msg " + p.level, text: p.text }))) : null;
    }

    // ── Strength: an exercise and its lines of sets ──

    function exerciseCard(ctx, card, c) {
      const { blocks } = ctx, first = blocks[card.k].steps[0], name = first.exerciseName, title = M.prettyName(name);
      const next = ctx.cards[c + 1];
      const canJoin = card.count === 1 && next && ((next.kind === "exercise" && next.count === 1) || next.kind === "superset");
      const same = card.count > 1 ? M.sameSets(blocks, card.k, card.count) : null;
      const lines = Array.from({ length: card.count }, (_, j) => [card.k + j, 0]);
      const items = cardMenu(ctx, c, title, [
        canJoin && { label: "Superset with the next exercise", run: () => writeBlocks(ctx, joinNext(ctx, card, next)) },
        card.count === 1 && blocks[card.k].times > 1 && { label: "Give each set its own line", run: () => writeBlocks(ctx, M.eachSet(blocks, card.k)) },
        same && { label: "Make the sets one line", run: () => writeBlocks(ctx, same) },
        ...countItems(ctx, lines, first),
      ]);
      const li = h("li", { class: "wf-card wf-ex k-work", "data-c": c },
        h("div", { class: "wf-ch" }, grip(), exerciseTitle(name, `ex:${card.k}`, (to) => writeBlocks(ctx, renamed(blocks, lines, name, to))), menu(items, `More for ${title}`, `menu:${card.k}`)));
      for (let j = 0; j < card.count; j++) li.append(setLine(ctx, card.k + j, card.count > 1));
      const last = blocks[card.k + card.count - 1].steps[0];
      li.append(h("div", { class: "wf-cfoot" }, link("+ Different set", `addset:${card.k}`, () => writeBlocks(ctx, M.insertBlocks(blocks, card.k + card.count, [M.once(M.copyStep(last))])))));
      return li;
    }

    /** One line of an exercise's sets: how many, the reps (or a time), the load, the rest after each. */
    function setLine(ctx, k, removable) {
      const b = ctx.blocks[k], st = b.steps[0];
      const line = h("div", { class: "wf-line" },
        field("Sets", stepper(b.times, 1, 99, (n) => writeBlocks(ctx, M.setTimes(ctx.blocks, k, n)), `sets:${k}`, "Sets")),
        liftEnd(ctx, k, 0, st),
        load(ctx, k, 0, st),
        field("Rest", restInput(ctx, k, 0, st, "Rest")),
        removable ? h("button", { type: "button", class: "wf-x", title: "Remove these sets", "aria-label": "Remove these sets", "data-fk": `setx:${k}`, onclick: () => writeBlocks(ctx, M.removeBlocks(ctx.blocks, k)) }, "×") : null);
      return h("div", {}, line, messages(ctx, ctx.offsets[k]));
    }

    /** How an exercise's set ends: reps (most), a time (a plank), or the lap button (as many as you can); the menu switches it. */
    function liftEnd(ctx, k, j, st) {
      const end = M.endOf(st);
      const label = { reps: "Reps", time: "Time", lap: "Until done" }[end.by] || M.prettyName(end.by || "value");
      return field(label, endInput(ctx, k, j, end, "s") || h("span", { class: "wf-dim", text: "lap press" }));
    }

    /** The menu items that switch how the sets at `refs` ([block, step] pairs) are counted and loaded, as `st` is now. */
    function countItems(ctx, refs, st) {
      const each = (fn) => () => { let blocks = ctx.blocks; for (const [k, j] of refs) blocks = M.updateStep(blocks, k, j, fn); writeBlocks(ctx, blocks); };
      const by = M.endOf(st).by, pct = st.weightPercentage !== undefined;
      return [
        by !== "reps" && { label: "Count reps", run: each((s) => M.withEnd(s, "reps", 10)) },
        by !== "time" && { label: "Time each set instead", run: each((s) => M.withEnd(s, "time", 60)) },
        by !== "lap" && { label: "Until done (as many as you can)", run: each((s) => M.withEnd(s, "lap", 0)) },
        pct ? { label: "Load as a weight", run: each((s) => M.patched(s, { weightPercentage: undefined, benchmarkKey: undefined })) }
          : { label: "Load as a % of the 1RM", run: each((s) => M.patched(s, { weight: undefined, weightPercentage: 70, benchmarkKey: s.benchmarkKey || s.exerciseName })) },
      ];
    }

    /** The load: a weight in the profile's unit (kept in lb), or a percentage of a one-rep max (the menu switches). Empty is none: body weight. */
    function load(ctx, k, j, st) {
      const unit = ctx.unit, key = `${k}:${j}`;
      if (st.weightPercentage !== undefined) {
        const of = st.benchmarkKey && st.benchmarkKey !== st.exerciseName ? h("small", { class: "wf-dim", text: `of ${M.prettyName(st.benchmarkKey)}` }) : null;
        return field("% of 1RM", entry({ value: String(st.weightPercentage ?? ""), label: "Percent of the one-rep max", fk: `pct:${key}` },
          (t) => positive(M.parseNumber(t)), "Not a percentage above 0", (n) => writeStep(ctx, k, j, (s) => M.patched(s, { weightPercentage: n }))), of);
      }
      return field(`Weight (${unit === "kg" ? "kg" : "lb"})`, entry({ value: M.weightText(st.weight, unit), label: `Weight in ${unit}`, fk: `w:${key}`, placeholder: "—" },
        (t) => (t ? M.parseWeight(t, unit) : 0), "Not a weight", (lb) => writeStep(ctx, k, j, (s) => M.patched(s, { weight: lb > 0 ? lb : undefined }))));
    }

    /** An exercise card joined with the next card (an exercise, or a superset it goes first in). */
    function joinNext(ctx, card, next) {
      if (next.kind === "exercise") return M.joinBlocks(ctx.blocks, card.k, 2, { superset: true });
      const st = M.withRest(ctx.blocks[card.k].steps[0], 0);
      return M.removeBlocks(M.insertInto(ctx.blocks, next.k, 0, [st]), card.k);
    }

    /** The exercise `from` renamed `to` in the steps at `refs` ([block, step] pairs); a 1RM it was a percentage of follows. */
    function renamed(blocks, refs, from, to) {
      return refs.reduce((out, [k, j]) => M.updateStep(out, k, j, (s) => M.patched(s, { exerciseName: to, benchmarkKey: s.benchmarkKey === from ? to : s.benchmarkKey })), blocks);
    }

    // ── Strength: a superset ──

    function supersetCard(ctx, card, c) {
      const { blocks } = ctx, k = card.k, b = blocks[k];
      const items = cardMenu(ctx, c, "Superset", [{ label: "Split into its exercises", run: () => writeBlocks(ctx, M.splitBlock(blocks, k)) }]);
      const li = h("li", { class: "wf-card wf-ss k-work", "data-c": c }, groupHead(ctx, k, "Superset", "rounds", items));
      b.steps.forEach((st, j) => li.append(member(ctx, k, j, st, j === b.steps.length - 1)));
      li.append(h("div", { class: "wf-cfoot" }, link("+ Exercise", `ssadd:${k}`, () => pickExercise().then((name) => {
        if (!name) return;
        // the new exercise goes last, so the rest after the round moves to it
        const last = b.steps[b.steps.length - 1], added = M.withRest(M.newSet(name, { reps: M.endOf(last).value || 10 }), last.restTimeSeconds || 0);
        writeBlocks(ctx, M.insertInto(M.updateStep(blocks, k, b.steps.length - 1, (s) => M.withRest(s, 0)), k, undefined, [added]));
      }), "Add an exercise to the superset")));
      return li;
    }

    function member(ctx, k, j, st, last) {
      const b = ctx.blocks[k], name = st.exerciseName, title = M.prettyName(name);
      const items = insideMenu(ctx, k, j, title, [
        { label: "Take out of the superset", run: () => writeBlocks(ctx, M.takeOut(ctx.blocks, k, j, { keep: true, times: b.times })) },
        ...countItems(ctx, [[k, j]], st),
      ]);
      return h("div", { class: "wf-member" },
        h("div", { class: "wf-mh" }, exerciseTitle(name, `ex:${k}:${j}`, (to) => writeBlocks(ctx, renamed(ctx.blocks, [[k, j]], name, to))), menu(items, `More for ${title}`, `menu:${k}:${j}`)),
        h("div", { class: "wf-line" }, liftEnd(ctx, k, j, st), load(ctx, k, j, st), field(last ? "Rest after the round" : "Rest after", restInput(ctx, k, j, st, last ? "Rest after the round" : "Rest after"))),
        messages(ctx, ctx.offsets[k] + j));
    }

    // ── A step, and a repeat of steps (run, ride; and the warm-up of a lifting day) ──

    function repeatCard(ctx, card, c) {
      const k = card.k, b = ctx.blocks[k];
      const items = cardMenu(ctx, c, "Repeat", [{ label: "Do these steps once", run: () => writeBlocks(ctx, M.setTimes(ctx.blocks, k, 1)) }]);
      const inner = h("ol", { class: "wf-inner" });
      b.steps.forEach((st, j) => inner.append(h("li", { class: `k-${WM.kindOf(st)}` }, stepRow(ctx, k, j, null))));
      const add = (type) => () => writeBlocks(ctx, M.insertInto(ctx.blocks, k, undefined, [M.newStep(ctx.w, type)]));
      return h("li", { class: "wf-card wf-rep", "data-c": c },
        groupHead(ctx, k, "Repeat", "times", items),
        inner,
        h("div", { class: "wf-cfoot" }, link("+ Step", `rstep:${k}`, add(ctx.mode === "strength" ? "other" : "interval")), link("+ Recovery", `rrec:${k}`, add("recovery"))));
    }

    /** One step: its kind, how it ends, what it aims for, and a rest after it. `c` is its card when it is a card of its own (null in a repeat). */
    function stepRow(ctx, k, j, c) {
      const st = ctx.blocks[k].steps[j], key = `${k}:${j}`, strength = ctx.mode === "strength";
      const kinds = strength ? ["warmup", "rest", "recovery", "cooldown", "other"] : ["warmup", "interval", "recovery", "rest", "cooldown", "other"];
      const kind = h("select", { "aria-label": "Kind of step", "data-fk": `kind:${key}` });
      for (const t of kinds) kind.add(new Option(M.kindLabel(t, ctx.w), t));
      if (!kinds.includes(st.stepType)) kind.add(new Option(M.kindLabel(st.stepType, ctx.w), st.stepType ?? ""));
      kind.value = st.stepType ?? "";
      kind.onchange = () => writeStep(ctx, k, j, (s) => M.patched(s, { stepType: kind.value }));

      const rested = st.restTimeSeconds ? { label: "No rest after it", run: () => writeStep(ctx, k, j, (s) => M.withRest(s, 0)) } : { label: "Add a rest after it", run: () => writeStep(ctx, k, j, (s) => M.withRest(s, 60)) };
      const items = c !== null
        ? cardMenu(ctx, c, "Step", [{ label: "Repeat it", run: () => writeBlocks(ctx, M.setTimes(ctx.blocks, k, 2)) }, rested])
        : insideMenu(ctx, k, j, "Step", [
          { label: "Duplicate", run: () => writeBlocks(ctx, M.insertInto(ctx.blocks, k, j + 1, [M.copyStep(st)])) },
          { label: "Take out of the repeat", run: () => writeBlocks(ctx, M.takeOut(ctx.blocks, k, j, { keep: true })) },
          rested,
        ]);

      const fields = h("div", { class: "wf-sf" }, kind, endField(ctx, k, j, st), !strength || (st.targetType && st.targetType !== "no.target") ? target(ctx, k, j, st) : null);
      const row = h("div", { class: `wf-step k-${WM.kindOf(st)}` }, c !== null ? grip() : h("span"), fields, menu(items, "More for this step", `menu:${key}`));
      const under = [];
      if (st.exerciseName) under.push(h("small", { class: "wf-dim", text: M.prettyName(st.exerciseName) }));
      if (st.restTimeSeconds) under.push(h("div", { class: "wf-then" }, h("span", { class: "wf-fl", text: "Then rest" }), restInput(ctx, k, j, st, "Then rest"), h("button", { type: "button", class: "wf-x", title: "No rest after it", "aria-label": "No rest after it", "data-fk": `restx:${key}`, onclick: () => writeStep(ctx, k, j, (s) => M.withRest(s, 0)) }, "×")));
      under.push(messages(ctx, ctx.offsets[k] + j));
      if (under.some(Boolean)) row.append(h("div", { class: "wf-under" }, under));
      return row;
    }

    /** How a step ends: a distance (km or m), a time, the lap button; another of Garmin's ends shows as a number. */
    function endField(ctx, k, j, st) {
      const end = M.endOf(st), key = `${k}:${j}`, dist = end.by === "distance";
      const unit = dist ? units.get(key) || M.distanceUnit(end.value) : null;
      const by = h("select", { "aria-label": "Ends after", title: "Ends after a distance, a time, or when you press the lap button", "data-fk": `by:${key}` });
      const choices = ctx.mode === "strength" ? [["time", "time"], ["lap", "lap"]] : [["km", "km"], ["m", "m"], ["time", "time"], ["lap", "lap"]];
      for (const [v, label] of choices) by.add(new Option(label, v));
      const own = dist ? unit : end.by;
      if (!choices.some(([v]) => v === own)) by.add(new Option(M.prettyName(own || "none"), own || ""));
      by.value = own || "";
      by.onchange = () => {
        const v = by.value;
        if (v === "km" || v === "m") {
          units.set(key, v);
          return dist ? render() : writeStep(ctx, k, j, (s) => M.withEnd(s, "distance", v === "km" ? 1000 : 400));
        }
        writeStep(ctx, k, j, (s) => M.withEnd(s, v, v === "time" ? M.defaultTime(s.stepType) : 0));
      };
      const input = dist
        ? entry({ value: M.distanceIn(end.value, unit), label: `Distance in ${unit}`, fk: `ev:${key}` }, (t) => M.parseDistance(t, unit), "Not a distance", (m) => writeStep(ctx, k, j, (s) => M.withEnd(s, "distance", m)))
        : endInput(ctx, k, j, end, st.stepType === "rest" ? "s" : "min");
      return h("span", { class: "wf-end" }, input, by);
    }

    /** What a step aims for, as a range typed in the target's unit: a pace fast end first, as runners say it. */
    function target(ctx, k, j, st) {
      const key = `${k}:${j}`, type = st.targetType || "no.target", info = M.TARGETS[type] || {}, t = M.targetOf(st);
      const pick = h("select", { "aria-label": "Target", "data-fk": `tt:${key}` });
      for (const tt of M.targetsFor(ctx.w, st)) pick.add(new Option((M.TARGETS[tt] || { label: tt }).label, tt));
      if (!M.TARGETS[type]) pick.add(new Option(type, type));
      pick.value = type;
      pick.onchange = () => {
        const speeds = ["pace.zone", "speed.zone"], keep = speeds.includes(type) && speeds.includes(pick.value);
        writeStep(ctx, k, j, (s) => M.withTarget(s, pick.value, keep ? t.lo : null, keep ? t.hi : null));
      };
      const row = h("span", { class: "wf-tgt" }, pick);
      if (!info.field) return row;
      const show = (v) => (v === null ? "" : info.field === "pace" ? M.paceText(v) : info.field === "kmh" ? M.kmhText(v) : String(Math.round(v * 10) / 10));
      const parse = (text) => (info.field === "pace" ? M.parsePace(text) : info.field === "kmh" ? M.parseKmh(text) : M.parseNumber(text));
      const ends = info.field === "pace" ? [t.hi, t.lo] : [t.lo, t.hi];
      const unit = M.targetUnit(type, ctx.w), what = info.label.toLowerCase();
      const fields = ends.map((v, n) => h("input", { type: "text", inputmode: info.field === "pace" ? "text" : "decimal", class: "wf-num", value: show(v), placeholder: info.field === "pace" ? "m:ss" : "", "aria-label": `${info.label} ${n === 0 ? "from" : "to"}`, "data-fk": `tv${n}:${key}` }));
      const put = () => { // the two ends are written together, so a range is never half new
        const values = fields.map((f) => (f.value.trim() ? parse(f.value) : null));
        const wrong = fields.find((f, n) => f.value.trim() && (values[n] === null || values[n] <= 0));
        if (wrong) return bad(wrong, `Not a ${what}: ${wrong.value.trim()}`);
        writeStep(ctx, k, j, (s) => M.withTarget(s, type, values[0], values[1]));
      };
      fields.forEach((f) => (f.onchange = put));
      row.append(fields[0], h("span", { class: "wf-dim", text: "–" }), fields[1], h("span", { class: "wf-dim", text: unit }));
      return row;
    }

    /** A distance-only run: Garmin makes its steps from the distance. */
    function distanceOnly(ctx) {
      const { w } = ctx, unit = M.distanceUnit(w.distanceMeters);
      const input = entry({ value: M.distanceIn(w.distanceMeters, unit), label: `Distance in ${unit}`, fk: "dist" }, (t) => M.parseDistance(t, unit), "Not a distance", (m) => write({ ...w, distanceMeters: m }));
      const steps = () => write({ ...w, steps: M.fromBlocks([M.once(M.newStep(w, "interval", { by: "distance", value: w.distanceMeters }))]) });
      return h("div", { class: "wf-simple" },
        h("p", { class: "wf-dim", text: "No steps: Garmin makes its own for the distance." }),
        h("div", { class: "wf-row" }, h("div", { class: "wf-f" }, h("span", { class: "wf-fl", text: "Distance" }), input, h("span", { class: "wf-dim", text: unit })),
          h("button", { type: "button", "data-fk": "addsteps", onclick: steps }, "Plan the steps")));
    }

    // ── Adding ──

    function adder(ctx) {
      const { w, blocks } = ctx, bar = h("div", { class: "wf-add" });
      if (ctx.mode !== "strength" && !ctx.flat.length && w.distanceMeters) return null;
      const one = (b, type) => b && b.times === 1 && b.steps[0].stepType === type;
      const warm = one(blocks[0], "warmup"), cool = one(blocks[blocks.length - 1], "cooldown");
      const at = cool ? blocks.length - 1 : blocks.length; // what is added goes before the cool-down
      const add = (label, fk, run, title) => bar.append(h("button", { type: "button", "data-fk": fk, title, onclick: run }, label));
      const insert = (added) => writeBlocks(ctx, M.insertBlocks(blocks, at, added));
      if (ctx.mode === "strength") {
        add("+ Exercise", "add:ex", () => pickExercise().then((name) => name && insert([{ steps: [M.newSet(name, lastSet(ctx))], times: 3 }])));
        add("+ Rest", "add:rest", () => insert([M.once(M.newStep(w, "rest"))]));
      } else {
        add("+ Step", "add:step", () => insert([M.once(M.newStep(w, "interval"))]));
        add("+ Repeat", "add:rep", () => insert([{ steps: [M.newStep(w, "interval"), M.newStep(w, "recovery")], times: 4 }]), "A step and its recovery, done several times");
        add("+ Rest", "add:rest", () => insert([M.once(M.newStep(w, "rest"))]));
      }
      if (!warm) add("+ Warm-up", "add:wu", () => writeBlocks(ctx, M.insertBlocks(blocks, 0, [M.once(M.newStep(w, "warmup"))])));
      if (!cool) add("+ Cool-down", "add:cd", () => writeBlocks(ctx, M.insertBlocks(blocks, blocks.length, [M.once(M.newStep(w, "cooldown"))])));
      const presets = M.PRESETS[w.workoutType];
      if (presets) {
        const pick = h("select", { "aria-label": "Add a ready-made part", "data-fk": "add:preset" }, h("option", { value: "", text: "+ Ready-made…" }));
        for (const p of presets) pick.add(new Option(p.label, p.id));
        pick.onchange = () => { const p = presets.find((x) => x.id === pick.value); if (p) insert(p.blocks(w)); };
        bar.append(pick);
      }
      return bar;
    }

    /** The reps and the rest of the workout's last exercise, for the next one added. */
    function lastSet(ctx) {
      const st = [...ctx.flat].reverse().find(M.isExercise);
      if (!st) return { reps: 10, rest: 90 };
      const end = M.endOf(st);
      return { reps: end.by === "reps" && end.value ? end.value : 10, rest: st.restTimeSeconds ?? 90 };
    }

    // ── Menus ──

    let menuEl = null;
    /** A ⋯ button whose menu lists `items` ({ label, run, danger }; falsy ones are left out). */
    function menu(items, label, fk) {
      const b = h("button", { type: "button", class: "wf-more", title: label, "aria-label": label, "aria-haspopup": "menu", "data-fk": fk }, "⋯");
      b.onclick = (e) => { e.stopPropagation(); openMenu(b, items.filter(Boolean)); };
      return b;
    }

    function openMenu(anchor, items) {
      if (!menuEl) {
        menuEl = h("div", { class: "wf-menu", popover: "auto", role: "menu" });
        menuEl.addEventListener("keydown", (e) => {
          const all = [...menuEl.querySelectorAll("button")], at = all.indexOf(document.activeElement);
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length].focus(); }
        });
      }
      // a page under a modal dialog cannot be tapped: inside the Workouts view's dialog, the menu lives in it
      const host = anchor.closest("dialog") || document.body;
      if (menuEl.parentElement !== host) host.append(menuEl);
      if (menuEl.matches(":popover-open")) menuEl.hidePopover();
      menuEl.replaceChildren(...items.map((it) => h("button", { type: "button", role: "menuitem", class: it.danger ? "danger" : "", onclick: () => { menuEl.hidePopover(); it.run(); } }, it.label)));
      menuEl.ontoggle = (e) => {
        if (e.newState !== "closed") return;
        if (anchor.isConnected && !el.contains(document.activeElement)) anchor.focus({ preventScroll: true });
        menuEl.ontoggle = null; // its items and its button belong to a drawing that is gone once the form changes
        menuEl.replaceChildren();
      };
      menuEl.showPopover();
      opts.place(menuEl, anchor);
      menuEl.querySelector("button")?.focus();
    }

    // ── The exercise picker ──

    let picker = null;
    /** Pick one of Garmin's exercises: resolves to its name, or null when the picker is closed. */
    function pickExercise(current) {
      return loadCatalog().then((cat) => new Promise((resolve) => {
        const p = picker || (picker = makePicker());
        let picked = null;
        p.state = { cat, category: "", current };
        p.search.value = "";
        fillChips(p);
        fillList(p);
        p.dlg.onclose = () => { p.dlg.onclose = null; resolve(picked); };
        p.choose = (name) => { picked = name; p.dlg.close(); };
        opts.modal(p.dlg);
        p.search.focus();
      }), (e) => { opts.toast(`The exercise list did not load: ${e.message}`); return null; });
    }

    function makePicker() {
      const search = h("input", { type: "search", placeholder: "Search: bench, rdl, db row…", "aria-label": "Search Garmin's exercises", autocomplete: "off", spellcheck: "false" });
      const cats = h("div", { class: "wf-pk-cats", role: "group", "aria-label": "Category" });
      const list = h("div", { class: "wf-pk-list" });
      const close = h("button", { type: "button", "aria-label": "Close" }, "✕");
      // the id is what the page's history entry for an open dialog names (Back closes it)
      const dlg = h("dialog", { class: "wf-pick", "aria-label": "Pick an exercise", id: `wfpick${++seq}` },
        h("div", { class: "dhead" }, h("b", { text: "Pick an exercise" }), close),
        h("div", { class: "wf-pk-bar" }, search), cats, list);
      document.body.append(dlg);
      const p = { dlg, search, cats, list, state: null, choose: null };
      close.onclick = () => dlg.close();
      search.oninput = () => fillList(p);
      search.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); const first = list.querySelector("button"); if (first) first.click(); }
        if (e.key === "ArrowDown") { e.preventDefault(); list.querySelector("button")?.focus(); }
      };
      list.onkeydown = (e) => {
        const all = [...list.querySelectorAll("button")], at = all.indexOf(document.activeElement);
        if (e.key === "ArrowDown" && at < all.length - 1) { e.preventDefault(); all[at + 1].focus(); }
        if (e.key === "ArrowUp") { e.preventDefault(); (at > 0 ? all[at - 1] : search).focus(); }
      };
      return p;
    }

    /** The categories, once each time the picker opens; a tap narrows the list to one (another tap on it, to all). */
    function fillChips(p) {
      const chips = ["", ...p.state.cat.categories].map((cat) => {
        const chip = h("button", { type: "button", class: "tchip", "aria-pressed": String(cat === ""), "data-cat": cat }, cat ? M.prettyName(cat) : "All");
        chip.onclick = () => {
          p.state.category = cat === p.state.category ? "" : cat;
          for (const b of p.cats.children) b.setAttribute("aria-pressed", String(b.dataset.cat === p.state.category));
          fillList(p);
        };
        return chip;
      });
      p.cats.replaceChildren(...chips);
    }

    function fillList(p) {
      const { cat, category, current } = p.state, query = p.search.value;
      const row = (e) => h("button", { type: "button", class: "wf-pk-row" + (e.name === current ? " cur" : ""), onclick: () => p.choose(e.name) },
        h("b", { text: M.prettyName(e.name) }), h("small", { text: [M.prettyName(e.category), muscles(e.name)].filter(Boolean).join(" · ") }));
      const out = [];
      if (!query.trim() && !category) {
        const mine = cat.used.map((n) => cat.byName.get(n)).filter(Boolean);
        if (mine.length) out.push(h("div", { class: "wf-pk-h", text: "In your plans" }), ...mine.map(row));
        out.push(h("div", { class: "wf-pk-h", text: `Type to search Garmin's ${cat.all.length} exercises, or pick a category.` }));
      } else {
        const hits = M.searchExercises(cat.all, query, { category, recent: cat.used, limit: 80 });
        out.push(...(hits.length ? hits.map(row) : [h("div", { class: "wf-pk-h", text: "No exercise has all these words." })]));
      }
      p.list.replaceChildren(...out);
    }

    // ── Dragging a card to another place ──
    // The grip (⠿) of a card picks it up once moved a few pixels (it does not scroll the page, so a finger drags it at once); the gap it
    // would land in is marked, and letting go there moves it. Escape, or letting go where it was, puts it back.

    function startDrag(e, ctx, list) {
      const handle = e.target.closest(".wf-grip");
      if (!handle || e.button > 0) return;
      const li = handle.closest(".wf-card");
      if (!li || li.parentElement !== list) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      drag = { ctx, list, li, c: +li.dataset.c, x: e.clientX, y: e.clientY, active: false, gap: null, handle, id: e.pointerId };
      handle.onpointermove = moveDrag;
      handle.onpointerup = (ev) => endDrag(ev, true);
      handle.onpointercancel = (ev) => endDrag(ev, false);
      addEventListener("keydown", escDrag, true);
    }

    function moveDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_SLOP) return;
        drag.active = true;
        drag.li.classList.add("wf-lifted");
        document.body.classList.add("wf-dragging");
      }
      const cards = [...drag.list.children].filter((x) => x.classList.contains("wf-card"));
      let gap = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { gap = i; break; }
      }
      drag.gap = gap;
      cards.forEach((x, i) => { x.classList.toggle("wf-drop-before", i === gap); x.classList.toggle("wf-drop-after", gap === cards.length && i === cards.length - 1); });
      // near the top or the bottom of what scrolls, it scrolls
      const box = scroller(drag.list), r = box.getBoundingClientRect();
      if (e.clientY < r.top + 40) box.scrollBy(0, -12); else if (e.clientY > r.bottom - 40) box.scrollBy(0, 12);
    }

    function endDrag(e, drop) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const d = drag;
      drag = null;
      removeEventListener("keydown", escDrag, true);
      d.handle.onpointermove = d.handle.onpointerup = d.handle.onpointercancel = null;
      document.body.classList.remove("wf-dragging");
      d.li.classList.remove("wf-lifted");
      d.list.querySelectorAll(".wf-drop-before, .wf-drop-after").forEach((x) => x.classList.remove("wf-drop-before", "wf-drop-after"));
      if (!drop || !d.active || d.gap === null || d.gap === d.c || d.gap === d.c + 1) return;
      const { ctx } = d, card = ctx.cards[d.c], to = d.gap < ctx.cards.length ? ctx.cards[d.gap].k : ctx.blocks.length;
      writeBlocks(ctx, M.moveBlocks(ctx.blocks, card.k, card.count, to));
    }

    const escDrag = (e) => { if (e.key === "Escape" && drag) { e.preventDefault(); e.stopPropagation(); endDrag(null, false); } };

    return { el, render, schedule, retime };
  }

  // whether the overview is open, for every form: open on a desktop, shut on a phone until opened (decided when the first one is drawn)
  let overviewOpen = null;

  root.WorkoutForm = { create, redraw };
})(typeof self !== "undefined" ? self : this);
