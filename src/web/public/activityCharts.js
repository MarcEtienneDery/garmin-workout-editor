/*
 * activityCharts.js — the pictures of one activity: stacked graphs of heart rate, pace, elevation and cadence with a
 * cursor, bars for laps and kilometer splits and the heart-rate zone bar.
 *
 * Plain DOM and SVG, no library. The numbers it needs (ranges, smoothing, zone shares) come from
 * ActivityModel, which has the tests; this file only draws. ChartData is what GET /api/activity returns as `chart`.
 */
(function (root) {
  "use strict";

  const AM = root.ActivityModel;
  const NS = "http://www.w3.org/2000/svg";
  const make = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const html = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const ZONE_COLORS = ["#8b8b8b", "#1f78d1", "#22a24a", "#d7ba7d", "#e0393c"];
  const W = 420, H = 86, LEFT = 38, RIGHT = 8, TOP = 6, BOTTOM = 6;
  const valid = (v) => v !== null && v !== undefined;

  // ── Stacked graphs with one cursor ──────────────────────────────────────

  const paceText = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

  /** The panels an activity can have; each is drawn only when its series holds enough samples. */
  function panelsOf(chart) {
    const all = [
      { key: "hr", label: "Heart rate", unit: "bpm", values: chart.hr, color: "#e0393c", format: (v) => String(Math.round(v)) },
      { key: "pace", label: "Pace", unit: "/km", values: AM.smooth(chart.pace, 5), color: "#1f78d1", format: paceText, invert: true, trim: true },
      { key: "elevation", label: "Elevation", unit: "m", values: chart.elevation, color: "#8e6bd1", format: (v) => String(Math.round(v)), area: true },
      { key: "cadence", label: "Cadence", unit: "spm", values: AM.smooth(chart.cadence, 5), color: "#22a24a", format: (v) => String(Math.round(v)), trim: true },
    ];
    return all.filter((p) => p.values.filter(valid).length >= 3);
  }

  /**
   * The graphs of one activity. Returns { el, setCursor(index), destroy() }. onCursor(index | null) is called as the
   * pointer moves over a graph, so a map can follow it; setCursor moves the cursor from outside (the map).
   */
  function graphs(chart, { onCursor } = {}) {
    const panels = panelsOf(chart);
    const hasDistance = chart.distance.filter(valid).length >= 3 && Math.max(...chart.distance.filter(valid)) >= 500;
    const hasTime = chart.time.filter(valid).length >= 3;
    const state = { axis: hasDistance ? "distance" : "time", cursor: null };
    const el = html("div", "acg");
    if (!panels.length || (!hasDistance && !hasTime)) return { el, setCursor() {}, destroy() {} };

    const bar = html("div", "acbar");
    const seg = html("div", "seg");
    const axisButtons = {};
    if (hasDistance && hasTime) {
      for (const [axis, label] of [["distance", "Distance"], ["time", "Time"]]) {
        const b = html("button", "", label);
        b.onclick = () => { state.axis = axis; draw(); };
        axisButtons[axis] = b; seg.append(b);
      }
      bar.append(seg);
    }
    const readout = html("span", "acread");
    bar.append(readout);
    el.append(bar);
    const body = html("div", "acbody");
    el.append(body);

    let cursorParts = [];

    function draw() {
      body.replaceChildren(); cursorParts = [];
      for (const [axis, b] of Object.entries(axisButtons)) b.setAttribute("aria-pressed", String(axis === state.axis));
      const xs = state.axis === "distance" ? chart.distance : chart.time;
      const xv = xs.filter(valid), x0 = Math.min(...xv), x1 = Math.max(...xv);
      const sx = (x) => LEFT + ((x - x0) / (x1 - x0 || 1)) * (W - LEFT - RIGHT);
      const xLabel = state.axis === "distance" ? (v) => `${+(v / 1000).toFixed(1)} km` : (v) => AM.axisClock(v);

      for (const p of panels) {
        const vals = p.values.filter(valid);
        const range = p.trim ? AM.trimRange(p.values, 2, 98) : [Math.min(...vals), Math.max(...vals)];
        const scale = AM.niceRange(range[0], range[1], 2);
        const sy = (v) => {
          const f = (Math.min(Math.max(v, scale.lo), scale.hi) - scale.lo) / (scale.hi - scale.lo || 1);
          return TOP + (p.invert ? f : 1 - f) * (H - TOP - BOTTOM);
        };
        const box = html("div", "acp");
        const head = html("div", "act");
        head.append(html("span", "", `${p.label} (${p.unit})`));
        const value = html("b", "acv");
        head.append(value);
        const svg = make("svg", { viewBox: `0 0 ${W} ${H}`, class: "acsvg", role: "img", "aria-label": `${p.label} over the activity` });
        // heart-rate zone bands, behind the line, when Garmin gave the bounds
        if (p.key === "hr" && chart.zones) {
          chart.zones.filter((z) => z.low !== null).forEach((z) => {
            const top = z.high === null ? scale.hi : Math.min(z.high, scale.hi), bottom = Math.max(z.low, scale.lo);
            if (top > bottom) svg.append(make("rect", { x: LEFT, width: W - LEFT - RIGHT, y: sy(top), height: Math.max(0, sy(bottom) - sy(top)), fill: ZONE_COLORS[(z.zone - 1) % 5], opacity: 0.16 }));
          });
        }
        for (const t of scale.ticks) {
          svg.append(make("line", { x1: LEFT, x2: W - RIGHT, y1: sy(t), y2: sy(t), class: "acgrid" }));
          svg.append(make("text", { x: LEFT - 4, y: sy(t) + 3, class: "aclab", "text-anchor": "end" }, p.format(t)));
        }
        // the line, broken where a sample is missing; a dashed bridge joins the two sides (a stop has no pace, but the run goes on)
        let d = "", bridge = "", pen = false, area = "", last = null;
        xs.forEach((x, i) => {
          const v = p.values[i];
          if (!valid(x) || !valid(v)) { pen = false; return; }
          const px = sx(x).toFixed(1), py = sy(v).toFixed(1);
          if (!pen && last) bridge += `M${last} L${px} ${py}`;
          d += `${pen ? "L" : "M"}${px} ${py}`;
          pen = true;
          last = `${px} ${py}`;
        });
        if (p.area && d) {
          const first = xs.findIndex((x, i) => valid(x) && valid(p.values[i])), last = xs.length - 1 - [...xs].reverse().findIndex((x, i) => valid(x) && valid(p.values[xs.length - 1 - i]));
          area = `${d} L${sx(xs[last]).toFixed(1)} ${H - BOTTOM} L${sx(xs[first]).toFixed(1)} ${H - BOTTOM} Z`;
          svg.append(make("path", { d: area, fill: p.color, opacity: 0.18, stroke: "none" }));
        }
        if (bridge) svg.append(make("path", { d: bridge, fill: "none", stroke: p.color, "stroke-width": 1.2, "stroke-dasharray": "3 3", opacity: 0.55 }));
        svg.append(make("path", { d, fill: "none", stroke: p.color, "stroke-width": 1.6, "stroke-linejoin": "round" }));
        const line = make("line", { y1: TOP, y2: H - BOTTOM, class: "accur", visibility: "hidden" });
        const dot = make("circle", { r: 3.2, fill: p.color, stroke: "#fff", "stroke-width": 1, visibility: "hidden" });
        svg.append(line, dot);
        box.append(head, svg);
        body.append(box);
        cursorParts.push({ p, line, dot, value, sx, sy });
        // pointer events, not mouse events: a finger drags the cursor too, and a vertical drag still scrolls the pane
        const move = (e) => {
          const r = svg.getBoundingClientRect();
          if (!r.width) return;
          const fx = ((e.clientX - r.left) / r.width) * W;
          const x = x0 + ((fx - LEFT) / (W - LEFT - RIGHT)) * (x1 - x0);
          const i = AM.nearestIndex(xs, Math.min(x1, Math.max(x0, x)));
          if (i >= 0) { place(i); if (onCursor) onCursor(i); }
        };
        svg.addEventListener("pointermove", move);
        svg.addEventListener("pointerdown", move);
        svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { place(null); if (onCursor) onCursor(null); } });
      }
      // the shared x axis
      const axis = make("svg", { viewBox: `0 0 ${W} 16`, class: "acsvg acaxis", "aria-hidden": "true" });
      const ticks = AM.niceRange(x0, x1, 4).ticks.filter((t) => t >= x0 && t <= x1);
      for (const t of ticks) axis.append(make("text", { x: sx(t), y: 11, class: "aclab", "text-anchor": "middle" }, xLabel(t)));
      body.append(axis);
      place(state.cursor);
    }

    /** Put the cursor at a sample, or hide it. */
    function place(i) {
      state.cursor = i;
      const xs = state.axis === "distance" ? chart.distance : chart.time;
      for (const part of cursorParts) {
        const v = i === null ? null : part.p.values[i], x = i === null ? null : xs[i];
        const show = valid(v) && valid(x);
        for (const n of [part.line, part.dot]) n.setAttribute("visibility", show ? "visible" : "hidden");
        if (show) {
          part.line.setAttribute("x1", part.sx(x)); part.line.setAttribute("x2", part.sx(x));
          part.dot.setAttribute("cx", part.sx(x)); part.dot.setAttribute("cy", part.sy(v));
        }
        part.value.textContent = show ? `${part.p.format(v)} ${part.p.unit}` : "";
      }
      const t = i === null ? null : chart.time[i], d = i === null ? null : chart.distance[i];
      readout.textContent = i === null ? "" : [hasDistance && valid(d) ? `${+(d / 1000).toFixed(2)} km` : "", valid(t) ? AM.axisClock(t) : ""].filter(Boolean).join(" · ");
    }

    draw();
    return { el, setCursor: place, destroy() { cursorParts = []; el.remove(); }, get axis() { return state.axis; }, xs: () => (state.axis === "distance" ? chart.distance : chart.time) };
  }

  // ── Bars ────────────────────────────────────────────────────────────────

  /** Rows with a bar: label, text, a share (0..1) and a class (fast, slow) for the bar's colour. */
  function bars(rows) {
    const box = html("div", "abars");
    for (const r of rows) {
      const row = html("div", "abarrow" + (r.cls ? " " + r.cls : ""));
      const track = html("span", "abartrack"), fill = html("span", "abarfill");
      fill.style.width = `${Math.max(2, Math.round(r.share * 100))}%`;
      track.append(fill);
      row.append(html("span", "abl", r.label), html("span", "abv", r.value), track, html("span", "abx", r.extra || ""));
      if (r.title) row.title = r.title;
      box.append(row);
    }
    return box;
  }

  /** Laps or splits as bars of speed: the longer the bar, the faster. */
  function paceBars(items, { label, extra, title }) {
    const speeds = items.filter((x) => x.paceSec).map((x) => 1 / x.paceSec);
    if (!speeds.length) return html("div", "anote", "No pace in these.");
    const best = Math.max(...speeds), fastest = Math.min(...items.filter((x) => x.paceSec).map((x) => x.paceSec)), slowest = Math.max(...items.filter((x) => x.paceSec).map((x) => x.paceSec));
    return bars(items.map((x) => ({
      label: label(x),
      value: x.paceSec ? paceText(x.paceSec) : "–",
      share: x.paceSec ? 1 / x.paceSec / best : 0,
      cls: items.length > 2 && x.paceSec === fastest ? "fast" : items.length > 2 && x.paceSec === slowest ? "slow" : "",
      extra: extra(x),
      title: title ? title(x) : "",
    })));
  }

  /** Time in each heart-rate zone as one stacked bar and a legend. */
  function zoneBar(seconds, zones) {
    const shares = AM.zoneShares(seconds);
    const box = html("div", "azones");
    const stack = html("div", "azstack");
    for (const z of shares) {
      if (!z.seconds) continue;
      const seg = html("span", "azseg");
      seg.style.cssText = `width:${z.seconds / shares.reduce((a, b) => a + b.seconds, 0) * 100}%; background:${ZONE_COLORS[z.zone - 1]}`;
      seg.title = `Zone ${z.zone}: ${AM.duration(z.seconds)} (${z.pct}%)`;
      stack.append(seg);
    }
    const legend = html("div", "azlegend");
    for (const z of shares) {
      const band = zones && zones.find((x) => x.zone === z.zone);
      const range = band && band.low !== null ? ` ${band.low}${band.high !== null ? "–" + band.high : "+"} bpm` : "";
      const item = html("span", "azitem" + (z.seconds ? "" : " none"));
      const dot = html("i"); dot.style.background = ZONE_COLORS[z.zone - 1];
      item.append(dot, `Z${z.zone}${range}: ${z.seconds ? AM.duration(z.seconds) + " · " + z.pct + "%" : "–"}`);
      legend.append(item);
    }
    box.append(stack, legend);
    return box;
  }

  root.ActivityCharts = { graphs, paceBars, zoneBar, paceText, ZONE_COLORS, make, html };
})(typeof self !== "undefined" ? self : this);
