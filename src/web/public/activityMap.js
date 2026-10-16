/*
 * activityMap.js — the route of an activity on a tile map.
 *
 * Leaflet is served from this server (/vendor/leaflet/) and loaded the first time a route is drawn. The tiles come from
 * OpenStreetMap: the browser asks for the tiles around the route, which tells OSM roughly where it is. Nothing is
 * prefetched, and the attribution Leaflet shows must stay. Tiles are the standard light ones, turned dark with a CSS
 * filter on the tile layer only (the route keeps its colours).
 */
(function (root) {
  "use strict";

  const AM = root.ActivityModel;
  const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

  let loading = null;
  /**
   * Leaflet, loaded once on first use; rejects when the script cannot be fetched. The page also has Monaco's AMD loader,
   * and a UMD library that sees `define.amd` registers itself with that loader instead of setting the global L, so the
   * loader is set aside while Leaflet's script runs.
   */
  function load() {
    if (root.L && root.L.map) return Promise.resolve(root.L);
    return (loading ||= new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = "/vendor/leaflet/leaflet.css";
      document.head.append(css);
      const amd = root.define;
      root.define = undefined;
      const script = document.createElement("script");
      script.src = "/vendor/leaflet/leaflet.js";
      script.onload = () => { root.define = amd; root.L && root.L.map ? resolve(root.L) : (loading = null, reject(new Error("The map library did not start."))); };
      script.onerror = () => { root.define = amd; loading = null; reject(new Error("The map library did not load.")); };
      document.head.append(script);
    }));
  }

  /** Green for fast, red for slow: t from 0 (fast) to 1 (slow). */
  const heat = (t) => `hsl(${Math.round(120 * (1 - Math.min(1, Math.max(0, t))))} 70% 48%)`;

  /**
   * Draw the route into `container`. chart is the ChartData of the activity (route, plus the series to colour it by).
   * Returns a promise of { setCursor(routeIndex | null), recolor(by), destroy(), invalidate() }.
   * options.onCursor(routeIndex | null) is called as the pointer moves near the route.
   */
  async function create(container, chart, { colorBy = "pace", onCursor } = {}) {
    const L = await load();
    const route = chart.route;
    const points = route.lat.map((lat, i) => [lat, route.lon[i]]);
    const map = L.map(container, { zoomControl: true, scrollWheelZoom: false, dragging: !L.Browser.mobile, tap: false, attributionControl: true });
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
    const group = L.layerGroup().addTo(map);
    const cursor = L.circleMarker(points[0], { radius: 7, color: "#fff", weight: 2, fillColor: "#0e7ad1", fillOpacity: 1, interactive: false });

    /** The series the route is coloured by, one value per route point (by distance along the activity). */
    function valuesFor(by) {
      const series = by === "hr" ? chart.hr : by === "pace" ? AM.smooth(chart.pace, 5) : null;
      if (!series) return null;
      const out = route.lat.map((_, j) => {
        const i = AM.chartIndexFor(chart, j);
        return i >= 0 ? series[i] : null;
      });
      return out.some((v) => v !== null && v !== undefined) ? out : null;
    }

    function recolor(by) {
      group.clearLayers();
      const values = valuesFor(by);
      if (!values) {
        L.polyline(points, { color: "#0e7ad1", weight: 4, opacity: 0.95 }).addTo(group);
      } else {
        const [lo, hi] = AM.trimRange(values, 5, 95) || [0, 1];
        // pace: a high number is slow; heart rate: a high number is hard. Either way, high is red.
        values.forEach((v, j) => {
          if (j === 0) return;
          const t = v === null || v === undefined ? 0.5 : (v - lo) / (hi - lo || 1);
          L.polyline([points[j - 1], points[j]], { color: heat(t), weight: 4.5, opacity: 0.95, lineCap: "round" }).addTo(group);
        });
      }
      L.circleMarker(points[0], { radius: 6, color: "#fff", weight: 2, fillColor: "#22a24a", fillOpacity: 1, interactive: false }).addTo(group);
      L.circleMarker(points[points.length - 1], { radius: 6, color: "#fff", weight: 2, fillColor: "#e0393c", fillOpacity: 1, interactive: false }).addTo(group);
    }
    recolor(colorBy);
    map.fitBounds(L.latLngBounds(points), { padding: [18, 18] });

    // The pointer near the route moves the graphs' cursor: the nearest route point, if it is close enough to mean it.
    let lastIndex = -2;
    map.on("mousemove", (e) => {
      let best = -1, gap = Infinity;
      const here = map.latLngToContainerPoint(e.latlng);
      for (let j = 0; j < points.length; j++) {
        const p = map.latLngToContainerPoint(points[j]), g = (p.x - here.x) ** 2 + (p.y - here.y) ** 2;
        if (g < gap) { gap = g; best = j; }
      }
      const index = gap <= 30 * 30 ? best : -1;
      if (index !== lastIndex) { lastIndex = index; if (onCursor) onCursor(index >= 0 ? index : null); }
    });
    map.on("mouseout", () => { lastIndex = -2; if (onCursor) onCursor(null); });

    // A pane that was hidden when the map was made (a phone's detail pane, a collapsed section) has no size yet:
    // tell Leaflet when it gets one, or the tiles stay grey.
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(() => map.invalidateSize()) : null;
    if (watch) watch.observe(container);

    return {
      setCursor(index) {
        if (index === null || index < 0 || index >= points.length) { cursor.remove(); return; }
        cursor.setLatLng(points[index]);
        if (!map.hasLayer(cursor)) cursor.addTo(map);
        cursor.bringToFront();
      },
      recolor,
      invalidate: () => map.invalidateSize(),
      destroy() { if (watch) watch.disconnect(); map.remove(); },
      map,
    };
  }

  root.ActivityMap = { create, load };
})(typeof self !== "undefined" ? self : this);
