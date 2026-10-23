/*
 * trendCharts.js — the pictures of the Recovery and Weight views: one small chart per measure over the days (a line with
 * Garmin's balanced range, stacked parts (a part with a `weight` counts that many times in the bar), a range, bars), all sharing one hover cursor, and a click that picks the day.
 * Plain DOM and SVG, no library. What to draw comes from RecoveryModel / WeightModel, the scales from RecoveryModel; they have the tests.
 */
(function (root) {
  "use strict";

  const RM = root.RecoveryModel;
  const { make, html } = root.ActivityCharts;
  const W = 600, H = 124, LEFT = 40, RIGHT = 8, TOP = 8, BOTTOM = 18;

  /** A path through the points, broken wherever a day has no value (`connect`: joined across them, for what is measured now and then). */
  function pathOf(points, connect = false) {
    let d = "", pen = false;
    for (const p of points) {
      if (!p && connect) continue;
      if (!p) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
      pen = true;
    }
    return d;
  }

  /** Decimals for the tick labels: enough that neighbouring ticks do not read the same. */
  const tickDigits = (ticks) => { const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1; return step < 0.1 ? 2 : step < 1 ? 1 : 0; };

  /** One chart. Returns the element and a function that puts its cursor on a day (null: back to the picked day). */
  function chart(days, spec, { selected, onHover, onPick }) {
    const card = html("div", "rc"), head = html("div", "rch"), readout = html("span", "rcr");
    head.append(html("b", "", spec.title + (spec.unit ? ` (${spec.unit})` : "")), readout);
    card.append(head);

    const n = days.length, step = (W - LEFT - RIGHT) / Math.max(1, n), xAt = (i) => LEFT + step * (i + 0.5);
    const per = (fn) => days.map((d, i) => { const v = fn(d, i, days); return RM.valid(v) ? v : null; }); // a value may look at the days around it
    let values = [], include = [];
    let totals = null, lows = null, highs = null, bandLo = null, bandHi = null, refs = null, vals = null;
    if (spec.kind === "stack") {
      totals = days.map((d) => { const parts = spec.parts.filter((p) => RM.valid(d[p.key])); return parts.length ? parts.reduce((a, p) => a + d[p.key] * (p.weight || 1), 0) / spec.scaleBy : null; });
      values = totals;
    } else {
      vals = per(spec.value);
      values = vals;
      if (spec.kind === "range") { lows = per(spec.low); highs = per(spec.high); include = include.concat(lows, highs); }
    }
    if (spec.band) { bandLo = per((d) => spec.band(d)[0]); bandHi = per((d) => spec.band(d)[1]); include = include.concat(bandLo, bandHi); }
    if (spec.ref) { refs = per(spec.ref.value); include = include.concat(refs); }

    const sc = RM.scale(values, { min: spec.min, max: spec.max, include });
    if (!sc || !values.some((v) => v !== null)) {
      card.append(html("div", "rcnone", "No data in this range."));
      return { el: card, setCursor() {} };
    }
    const yAt = (v) => TOP + (1 - (v - sc.min) / (sc.max - sc.min)) * (H - TOP - BOTTOM);

    const svg = make("svg", { viewBox: `0 0 ${W} ${H}`, class: "rcsvg", role: "img", "aria-label": spec.title });
    for (const t of sc.ticks) {
      svg.append(make("line", { x1: LEFT, x2: W - RIGHT, y1: yAt(t), y2: yAt(t), class: "rc-grid" }));
      svg.append(make("text", { x: LEFT - 4, y: yAt(t) + 3, class: "rc-tick", "text-anchor": "end" }, RM.num(t, tickDigits(sc.ticks))));
    }
    const every = n <= 14 ? 2 : n <= 35 ? 7 : 14; // a label every few days, counted back from the last day
    days.forEach((d, i) => {
      if ((n - 1 - i) % every === 0)
        svg.append(make("text", { x: xAt(i), y: H - 4, class: "rc-x", "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }, RM.shortDay(d.day)));
    });
    const sel = days.findIndex((d) => d.day === selected);
    if (sel >= 0) svg.append(make("rect", { x: xAt(sel) - step / 2, y: TOP, width: step, height: H - TOP - BOTTOM, class: "rc-sel" }));

    if (bandLo) {
      let run = [];
      const flush = () => {
        if (run.length > 1) svg.append(make("path", { class: "rc-band", d: `M${run.map(([i, hi]) => `${xAt(i).toFixed(1)} ${yAt(hi).toFixed(1)}`).join("L")}L${[...run].reverse().map(([i, , lo]) => `${xAt(i).toFixed(1)} ${yAt(lo).toFixed(1)}`).join("L")}Z` }));
        run = [];
      };
      days.forEach((_, i) => { if (bandLo[i] !== null && bandHi[i] !== null) run.push([i, bandHi[i], bandLo[i]]); else flush(); });
      flush();
    }
    if (refs && refs.some((v) => v !== null)) svg.append(make("path", { class: "rc-ref", d: pathOf(refs.map((v, i) => (v === null ? null : [xAt(i), yAt(v)]))) }));

    const bw = Math.max(2, step * 0.7);
    days.forEach((d, i) => {
      if (spec.kind === "stack") {
        let acc = 0;
        for (const p of spec.parts) {
          const v = RM.valid(d[p.key]) ? (d[p.key] * (p.weight || 1)) / spec.scaleBy : 0;
          if (v > 0) svg.append(make("rect", { x: xAt(i) - bw / 2, y: yAt(acc + v), width: bw, height: Math.max(0, yAt(acc) - yAt(acc + v)), class: `rc-part ${p.cls}` }));
          acc += v;
        }
      } else if (spec.kind === "bars" && vals[i] !== null) {
        svg.append(make("rect", { x: xAt(i) - bw / 2, y: yAt(vals[i]), width: bw, height: Math.max(0, yAt(Math.max(sc.min, 0)) - yAt(vals[i])), class: `rc-bar ${spec.color ? spec.color(d) : ""}` }));
      } else if (spec.kind === "range" && lows[i] !== null && highs[i] !== null) {
        svg.append(make("line", { x1: xAt(i), x2: xAt(i), y1: yAt(lows[i]), y2: yAt(highs[i]), class: "rc-range" }));
      }
    });
    if (spec.kind === "line") svg.append(make("path", { class: "rc-line", d: pathOf(vals.map((v, i) => (v === null ? null : [xAt(i), yAt(v)])), spec.connect) }));
    if (spec.kind === "line" || spec.kind === "range") vals.forEach((v, i) => { if (v !== null) svg.append(make("circle", { cx: xAt(i), cy: yAt(v), r: 2.4, class: "rc-dot" })); });

    const cursor = make("line", { y1: TOP, y2: H - BOTTOM, class: "rc-cursor", visibility: "hidden" });
    const over = make("rect", { x: LEFT, y: 0, width: W - LEFT - RIGHT, height: H, class: "rc-over" });
    const indexAt = (e) => {
      const r = svg.getBoundingClientRect();
      return Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width * W - LEFT) / step)));
    };
    over.addEventListener("pointermove", (e) => onHover(indexAt(e)));
    over.addEventListener("pointerleave", () => onHover(null));
    over.addEventListener("click", (e) => onPick(days[indexAt(e)].day));
    svg.append(cursor, over);
    card.append(svg);

    const legend = html("div", "rcl");
    const key = (cls, text) => { const s = html("span", "rck"), i = html("i", cls); s.append(i, text); legend.append(s); };
    if (spec.band) key("sw-band", "Garmin's balanced range");
    if (spec.ref) key("sw-ref", spec.ref.label);
    if (spec.kind === "stack") for (const p of spec.parts) key(`sw-part ${p.cls}`, p.label);
    if (spec.kind === "range") key("sw-range", "low to high of the day, dot on waking");
    if (legend.childNodes.length) card.append(legend);

    const say = (i) => { readout.textContent = i === null || !days[i] ? "" : `${RM.dayLabel(days[i].day)}: ${spec.read(days[i], i, days)}`; };
    const picked = sel >= 0 ? sel : null;
    say(picked);
    return {
      el: card,
      setCursor(i) {
        const at = i === null ? picked : i;
        say(at);
        if (i === null) cursor.setAttribute("visibility", "hidden");
        else { cursor.setAttribute("x1", xAt(i)); cursor.setAttribute("x2", xAt(i)); cursor.setAttribute("visibility", "visible"); }
      },
    };
  }

  /** The charts of a view for the days (oldest first); `selected` is the day picked, onPick(day) is called on a click. */
  function trends(days, specs, { selected, onPick }) {
    const box = html("div", "rcharts");
    const cards = [];
    const hover = (i) => cards.forEach((c) => c.setCursor(i));
    for (const spec of specs) {
      const c = chart(days, spec, { selected, onHover: hover, onPick });
      cards.push(c);
      box.append(c.el);
    }
    return box;
  }

  root.TrendCharts = { trends, chart };
})(typeof self !== "undefined" ? self : this);
