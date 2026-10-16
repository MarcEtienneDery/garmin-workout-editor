/**
 * activityChart.ts — an activity's chart data: what is kept of Garmin's answers, and how the charts are read from it.
 *
 * Three read-only Garmin answers hold what the graphs need:
 *   details  /activity-service/activity/{id}/details   the time series (metricDescriptors + activityDetailMetrics) and the route
 *   splits   /activity-service/activity/{id}/splits    the laps the watch recorded (lapDTOs)
 *   zones    /activity-service/activity/{id}/hrTimeInZones   seconds in each heart-rate zone, with the zone's lower bound
 *
 * pruneChart keeps them in the shape Garmin sent, only smaller (a few hundred samples, the fields the charts use), and
 * buildChart reads the charts from that every time they are asked for. The parsing is deliberately forgiving: a missing
 * metric leaves its series empty rather than failing, and a change to how it is read never needs Garmin again.
 */

/** Rows kept of a series or a route, however many Garmin sends. */
export const MAX_SAMPLES = 300;
const MAX_LAPS = 500;

export interface ChartResponses {
  details?: any;
  splits?: any;
  zones?: any;
}

export interface StoredChart {
  v: 1;
  details: { metricDescriptors: any[]; activityDetailMetrics: { metrics: unknown[] }[]; geoPolylineDTO?: { polyline: any[] } };
  splits: { lapDTOs: any[] } | null;
  zones: { zoneNumber: number; secsInZone: number; zoneLowBoundary: number | null }[] | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pick = (o: any, keys: string[]) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));

/** At most `max` of the rows, evenly spread, always the first and the last. */
export function decimate<T>(rows: T[], max: number): T[] {
  if (rows.length <= max || max < 2) return rows.length <= max ? rows : rows.slice(0, max);
  return Array.from({ length: max }, (_, i) => rows[Math.round((i * (rows.length - 1)) / (max - 1))]);
}

const POLYLINE_FIELDS = ["lat", "lon", "altitude", "time", "distanceInMeters", "speed"];
const LAP_FIELDS = [
  "lapIndex", "startTimeGMT", "distance", "duration", "movingDuration", "elevationGain", "elevationLoss", "averageSpeed", "maxSpeed",
  "averageHR", "maxHR", "averageRunCadence", "averageBikeCadence", "calories", "intensityType", "wktStepIndex", "messageIndex",
];

/** Garmin's three answers, smaller. Anything missing or oddly shaped is left out, not guessed at. */
export function pruneChart(responses: ChartResponses): StoredChart {
  const d = responses.details ?? {};
  const descriptors = (Array.isArray(d.metricDescriptors) ? d.metricDescriptors : []).map((m: any) => ({
    metricsIndex: m?.metricsIndex,
    key: m?.key,
    unit: m?.unit ? { key: m.unit.key, factor: m.unit.factor } : undefined,
  }));
  const rows = (Array.isArray(d.activityDetailMetrics) ? d.activityDetailMetrics : []).map((m: any) => ({ metrics: Array.isArray(m?.metrics) ? m.metrics : [] }));
  const polyline = Array.isArray(d.geoPolylineDTO?.polyline) ? decimate(d.geoPolylineDTO.polyline.map((p: any) => pick(p, POLYLINE_FIELDS)), MAX_SAMPLES) : [];
  const laps = Array.isArray(responses.splits?.lapDTOs) ? responses.splits.lapDTOs.slice(0, MAX_LAPS).map((l: any) => pick(l, LAP_FIELDS)) : null;
  const zones = Array.isArray(responses.zones)
    ? responses.zones.map((z: any) => ({ zoneNumber: z?.zoneNumber, secsInZone: z?.secsInZone, zoneLowBoundary: num(z?.zoneLowBoundary) }))
    : null;
  return {
    v: 1,
    details: { metricDescriptors: descriptors, activityDetailMetrics: decimate(rows, MAX_SAMPLES), ...(polyline.length ? { geoPolylineDTO: { polyline } } : {}) },
    splits: laps ? { lapDTOs: laps } : null,
    zones,
  };
}

// ── Reading the charts ───────────────────────────────────────────────────

export interface Lap {
  index: number;
  meters: number;
  seconds: number;
  paceSec: number | null;
  avgHr: number | null;
  maxHr: number | null;
  gain: number | null;
  cadence: number | null;
  /** INTERVAL, WARMUP, COOLDOWN, RECOVERY, ACTIVE ... as the watch labelled the lap. */
  kind: string | null;
}

export interface KmSplit {
  /** 1-based; the last one may be shorter than the others. */
  index: number;
  meters: number;
  seconds: number;
  paceSec: number | null;
  avgHr: number | null;
  /** Net climb over the split, in meters. */
  climb: number | null;
}

export interface Zone {
  zone: number;
  /** Lower bound in bpm, and the next zone's lower bound (null for the last). */
  low: number | null;
  high: number | null;
  seconds: number;
}

export interface ChartData {
  /** One value per sample, null where Garmin gave none. Time in seconds from the start, distance in meters. */
  time: (number | null)[];
  distance: (number | null)[];
  hr: (number | null)[];
  /** Pace in seconds per km; null where the speed was too low to mean a pace. */
  pace: (number | null)[];
  elevation: (number | null)[];
  cadence: (number | null)[];
  /** The route, with each point's distance so the cursor can find it; null for an activity without GPS. */
  route: { lat: number[]; lon: number[]; distance: (number | null)[] } | null;
  laps: Lap[];
  splits: KmSplit[];
  zones: Zone[] | null;
}

/** Slower than this is standing, not a pace (3.0 km/h is 20:00/km, and a pace graph needs better than that). */
const MIN_SPEED = 0.8;
/** The pace graph's limits, in seconds per km. */
export const PACE_FASTEST = 120;
export const PACE_SLOWEST = 900;

const pace = (speed: number | null): number | null => {
  if (speed === null || speed < MIN_SPEED) return null;
  const sec = 1000 / speed;
  return sec >= PACE_FASTEST && sec <= PACE_SLOWEST ? sec : null;
};

/** The column of one metric, found by the key Garmin names it with; the first of the keys that is there wins. */
function column(descriptors: any[], rows: any[], keys: string[]): (number | null)[] | null {
  for (const key of keys) {
    const d = descriptors.find((x) => x && x.key === key && Number.isInteger(x.metricsIndex));
    if (d) return rows.map((r) => num(r.metrics?.[d.metricsIndex]));
  }
  return null;
}

/** Km splits worked out from the distance and time series: the time at each full kilometer by interpolation. */
export function kmSplits(distance: (number | null)[], time: (number | null)[], hr: (number | null)[], elevation: (number | null)[]): KmSplit[] {
  const pts: { d: number; t: number; hr: number | null; e: number | null }[] = [];
  for (let i = 0; i < distance.length; i++) {
    const d = distance[i], t = time[i];
    if (d !== null && t !== null && (!pts.length || d >= pts[pts.length - 1].d)) pts.push({ d, t, hr: hr[i] ?? null, e: elevation[i] ?? null });
  }
  if (pts.length < 2) return [];
  const total = pts[pts.length - 1].d;
  const at = (target: number) => {
    let i = pts.findIndex((p) => p.d >= target);
    if (i <= 0) return { t: pts[0].t, e: pts[0].e };
    const a = pts[i - 1], b = pts[i], f = b.d === a.d ? 0 : (target - a.d) / (b.d - a.d);
    return { t: a.t + f * (b.t - a.t), e: a.e !== null && b.e !== null ? a.e + f * (b.e - a.e) : b.e };
  };
  const out: KmSplit[] = [];
  for (let k = 0, start = pts[0].d; start < total - 1; k++) {
    const end = Math.min(start + 1000, total), from = at(start), to = at(end);
    const meters = end - start, seconds = to.t - from.t;
    const inside = pts.filter((p) => p.d >= start && p.d <= end && p.hr !== null).map((p) => p.hr as number);
    out.push({
      index: k + 1,
      meters: Math.round(meters),
      seconds: Math.round(seconds),
      paceSec: meters > 0 && seconds > 0 ? Math.round((seconds / meters) * 1000) : null,
      avgHr: inside.length ? Math.round(inside.reduce((a, b) => a + b, 0) / inside.length) : null,
      climb: from.e !== null && to.e !== null ? Math.round(to.e - from.e) : null,
    });
    start = end;
  }
  return out;
}

/** The charts of one activity, read from what was stored; null when nothing was stored. */
export function buildChart(stored: StoredChart | null | undefined): ChartData | null {
  if (!stored || typeof stored !== "object") return null;
  const d = stored.details ?? ({} as StoredChart["details"]);
  const descriptors = Array.isArray(d.metricDescriptors) ? d.metricDescriptors : [];
  const rows = Array.isArray(d.activityDetailMetrics) ? d.activityDetailMetrics : [];

  const stamp = column(descriptors, rows, ["directTimestamp"]);
  const duration = column(descriptors, rows, ["sumElapsedDuration", "sumDuration"]);
  let time: (number | null)[];
  if (stamp && stamp.some((v) => v !== null)) {
    const t0 = stamp.find((v) => v !== null) as number;
    time = stamp.map((v) => (v === null ? null : (v - t0) / 1000));
  } else if (duration) time = duration;
  else time = rows.map((_, i) => i);
  const distance = column(descriptors, rows, ["sumDistance"]) ?? rows.map(() => null);
  const speed = column(descriptors, rows, ["directSpeed", "directGradeAdjustedSpeed"]) ?? rows.map(() => null);
  const hr = column(descriptors, rows, ["directHeartRate"]) ?? rows.map(() => null);
  const elevation = column(descriptors, rows, ["directElevation", "directAltitude"]) ?? rows.map(() => null);
  const cadence = column(descriptors, rows, ["directDoubleCadence", "directRunCadence", "directBikeCadence"]) ?? rows.map(() => null);

  // The route: Garmin's polyline, or failing that the latitude and longitude columns of the series.
  let route: ChartData["route"] = null;
  const poly = Array.isArray(d.geoPolylineDTO?.polyline) ? d.geoPolylineDTO!.polyline : [];
  const valid = (lat: unknown, lon: unknown) => typeof lat === "number" && typeof lon === "number" && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  const fromPoly = poly.filter((p: any) => valid(p?.lat, p?.lon));
  if (fromPoly.length >= 2) {
    route = { lat: fromPoly.map((p: any) => p.lat), lon: fromPoly.map((p: any) => p.lon), distance: fromPoly.map((p: any) => num(p.distanceInMeters)) };
  } else {
    const lat = column(descriptors, rows, ["directLatitude"]), lon = column(descriptors, rows, ["directLongitude"]);
    if (lat && lon) {
      const idx = lat.map((_, i) => i).filter((i) => valid(lat[i], lon[i]));
      if (idx.length >= 2) route = { lat: idx.map((i) => lat[i] as number), lon: idx.map((i) => lon[i] as number), distance: idx.map((i) => distance[i]) };
    }
  }

  const laps: Lap[] = (Array.isArray(stored.splits?.lapDTOs) ? stored.splits!.lapDTOs : []).map((l: any, i: number) => {
    const meters = num(l.distance) ?? 0, seconds = num(l.duration) ?? 0;
    return {
      index: num(l.lapIndex) ?? i + 1,
      meters: Math.round(meters),
      seconds: Math.round(seconds),
      paceSec: meters > 50 && seconds > 0 ? Math.round((seconds / meters) * 1000) : null,
      avgHr: num(l.averageHR),
      maxHr: num(l.maxHR),
      gain: num(l.elevationGain),
      cadence: num(l.averageRunCadence) ?? num(l.averageBikeCadence),
      kind: typeof l.intensityType === "string" ? l.intensityType : null,
    };
  });

  const bands = (Array.isArray(stored.zones) ? stored.zones : []).filter((z) => z && Number.isInteger(z.zoneNumber)).sort((a, b) => a.zoneNumber - b.zoneNumber);
  const zones: Zone[] | null = bands.length
    ? bands.map((z, i) => ({ zone: z.zoneNumber, low: z.zoneLowBoundary, high: bands[i + 1]?.zoneLowBoundary ?? null, seconds: z.secsInZone ?? 0 }))
    : null;

  return {
    time,
    distance,
    hr,
    pace: speed.map(pace),
    elevation,
    cadence,
    route,
    laps,
    splits: kmSplits(distance, time, hr, elevation),
    zones,
  };
}

// ── The numbers beside the charts ─────────────────────────────────────────

export interface ActivityStats {
  minHr: number | null;
  maxHr: number | null;
  /** Meters per second. */
  maxSpeed: number | null;
  /** Seconds for the fastest kilometer, mile and 5 km. */
  fastest1k: number | null;
  fastestMile: number | null;
  fastest5k: number | null;
  /** Centimeters. */
  stride: number | null;
  steps: number | null;
  maxCadence: number | null;
  elevationLoss: number | null;
  minElevation: number | null;
  maxElevation: number | null;
  vo2max: number | null;
  location: string | null;
  movingSeconds: number | null;
  elapsedSeconds: number | null;
  aerobicMessage: string | null;
  anaerobicMessage: string | null;
  /** Seconds in heart-rate zones 1 to 5, as the list item has them; null when it has none. */
  hrZones: number[] | null;
  /** Time and distance by how the watch split the activity (run, walk, stand), when it did. */
  segments: { kind: string; seconds: number; meters: number }[];
}

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** What the list item and the details say beyond the headline numbers; each is null when Garmin did not give it. */
export function activityStats(raw: any, detail: any): ActivityStats {
  const r = raw ?? {}, s = detail?.summaryDTO ?? {};
  const first = (...values: unknown[]) => values.map(num).find((v) => v !== null) ?? null;
  const zones = [1, 2, 3, 4, 5].map((i) => num(r[`hrTimeInZone_${i}`]));
  const kinds: Record<string, string> = { RWD_RUN: "run", RWD_WALK: "walk", RWD_STAND: "stand" };
  const segments = (Array.isArray(r.splitSummaries) ? r.splitSummaries : [])
    .filter((x: any) => kinds[x?.splitType] && num(x.duration) !== null)
    .map((x: any) => ({ kind: kinds[x.splitType], seconds: Math.round(x.duration), meters: Math.round(num(x.distance) ?? 0) }));
  return {
    minHr: first(s.minHR, r.minHR),
    maxHr: first(r.maxHR, s.maxHR),
    maxSpeed: first(r.maxSpeed, s.maxSpeed),
    fastest1k: first(r.fastestSplit_1000),
    fastestMile: first(r.fastestSplit_1609),
    fastest5k: first(r.fastestSplit_5000),
    stride: first(r.avgStrideLength, s.strideLength),
    steps: first(r.steps, s.steps),
    maxCadence: first(r.maxRunningCadenceInStepsPerMinute, s.maxRunCadence),
    elevationLoss: first(r.elevationLoss, s.elevationLoss),
    minElevation: first(r.minElevation, s.minElevation),
    maxElevation: first(r.maxElevation, s.maxElevation),
    vo2max: first(r.vO2MaxValue),
    location: text(r.locationName) ?? text(detail?.locationName),
    movingSeconds: first(r.movingDuration, s.movingDuration),
    elapsedSeconds: first(r.elapsedDuration, s.elapsedDuration),
    aerobicMessage: text(r.aerobicTrainingEffectMessage) ?? text(s.aerobicTrainingEffectMessage),
    anaerobicMessage: text(r.anaerobicTrainingEffectMessage) ?? text(s.anaerobicTrainingEffectMessage),
    hrZones: zones.some((z) => z !== null && z > 0) ? zones.map((z) => z ?? 0) : null,
    segments,
  };
}
