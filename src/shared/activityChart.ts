
import type { ExerciseSet } from "./types";

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
  zones: any[] | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const scalars = (o: any): Record<string, number | string | boolean> =>
  Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean")) as Record<string, number | string | boolean>;

export function decimate<T>(rows: T[], max: number): T[] {
  if (rows.length <= max || max < 2) return rows.length <= max ? rows : rows.slice(0, max);
  return Array.from({ length: max }, (_, i) => rows[Math.round((i * (rows.length - 1)) / (max - 1))]);
}

export function pruneChart(responses: ChartResponses): StoredChart {
  const d = responses.details ?? {};
  const descriptors = (Array.isArray(d.metricDescriptors) ? d.metricDescriptors : []).map((m: any) => ({
    metricsIndex: m?.metricsIndex,
    key: m?.key,
    unit: m?.unit ? { key: m.unit.key, factor: m.unit.factor } : undefined,
  }));
  const rows = (Array.isArray(d.activityDetailMetrics) ? d.activityDetailMetrics : []).map((m: any) => ({ metrics: Array.isArray(m?.metrics) ? m.metrics : [] }));
  const polyline = Array.isArray(d.geoPolylineDTO?.polyline) ? decimate(d.geoPolylineDTO.polyline.map((p: any) => scalars(p)), MAX_SAMPLES) : [];
  const laps = Array.isArray(responses.splits?.lapDTOs) ? responses.splits.lapDTOs.slice(0, MAX_LAPS).map((l: any) => scalars(l)) : null;
  const zones = Array.isArray(responses.zones)
    ? responses.zones.map((z: any) => scalars(z))
    : null;
  return {
    v: 1,
    details: { metricDescriptors: descriptors, activityDetailMetrics: decimate(rows, MAX_SAMPLES), ...(polyline.length ? { geoPolylineDTO: { polyline } } : {}) },
    splits: laps ? { lapDTOs: laps } : null,
    zones,
  };
}


const roundTo = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;

export function lapIntervals(stored: StoredChart | null | undefined): ExerciseSet[] {
  const laps: any[] = Array.isArray(stored?.splits?.lapDTOs) ? stored!.splits!.lapDTOs : [];
  return laps.map((l, i) => {
    const meters = num(l.distance), seconds = num(l.duration), step = num(l.wktStepIndex);
    return {
      exerciseName: `Lap ${num(l.lapIndex) ?? i + 1}`,
      category: "INTERVAL",
      sets: 1,
      duration: seconds === null ? undefined : Math.round(seconds),
      distance: meters === null ? undefined : roundTo(meters / 1000, 3),
      pace: meters !== null && seconds !== null && meters > 50 && seconds > 0 ? roundTo(seconds / 60 / (meters / 1000), 2) : undefined,
      avgHR: num(l.averageHR) ?? undefined,
      maxHR: num(l.maxHR) ?? undefined,
      splitType: typeof l.intensityType === "string" ? l.intensityType : undefined,
      step: step === null ? undefined : step + 1,
    };
  });
}

export interface Lap {
  index: number;
  meters: number;
  seconds: number;
  paceSec: number | null;
  avgHr: number | null;
  maxHr: number | null;
  gain: number | null;
  cadence: number | null;
  kind: string | null;
}

export interface KmSplit {
  index: number;
  meters: number;
  seconds: number;
  paceSec: number | null;
  avgHr: number | null;
  climb: number | null;
}

export interface Zone {
  zone: number;
  low: number | null;
  high: number | null;
  seconds: number;
}

export interface ChartData {
  time: (number | null)[];
  distance: (number | null)[];
  hr: (number | null)[];
  pace: (number | null)[];
  elevation: (number | null)[];
  cadence: (number | null)[];
  route: { lat: number[]; lon: number[]; distance: (number | null)[] } | null;
  laps: Lap[];
  splits: KmSplit[];
  zones: Zone[] | null;
}

const MIN_SPEED = 0.8;
export const PACE_FASTEST = 120;
export const PACE_SLOWEST = 900;

const pace = (speed: number | null): number | null => {
  if (speed === null || speed < MIN_SPEED) return null;
  const sec = 1000 / speed;
  return sec >= PACE_FASTEST && sec <= PACE_SLOWEST ? sec : null;
};

function column(descriptors: any[], rows: any[], keys: string[]): (number | null)[] | null {
  for (const key of keys) {
    const d = descriptors.find((x) => x && x.key === key && Number.isInteger(x.metricsIndex));
    if (d) return rows.map((r) => num(r.metrics?.[d.metricsIndex]));
  }
  return null;
}

function distanceAt(stamp: (number | null)[], distance: (number | null)[], t: unknown): number | null {
  if (typeof t !== "number") return null;
  const pts: { t: number; d: number }[] = [];
  for (let i = 0; i < stamp.length; i++) {
    const s = stamp[i], d = distance[i];
    if (s !== null && d !== null && (!pts.length || s >= pts[pts.length - 1].t)) pts.push({ t: s, d });
  }
  if (pts.length < 2 || t < pts[0].t || t > pts[pts.length - 1].t) return null;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  return b.t === a.t ? a.d : a.d + ((t - a.t) / (b.t - a.t)) * (b.d - a.d);
}

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

  let route: ChartData["route"] = null;
  const poly = Array.isArray(d.geoPolylineDTO?.polyline) ? d.geoPolylineDTO!.polyline : [];
  const valid = (lat: unknown, lon: unknown) => typeof lat === "number" && typeof lon === "number" && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  const fromPoly = poly.filter((p: any) => valid(p?.lat, p?.lon));
  if (fromPoly.length >= 2) {
    route = { lat: fromPoly.map((p: any) => p.lat), lon: fromPoly.map((p: any) => p.lon), distance: fromPoly.map((p: any) => num(p.distanceInMeters) ?? (stamp ? distanceAt(stamp, distance, p.time) : null)) };
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
    ? bands.map((z, i) => ({ zone: z.zoneNumber, low: num(z.zoneLowBoundary), high: num(bands[i + 1]?.zoneLowBoundary), seconds: num(z.secsInZone) ?? 0 }))
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


export interface ActivityStats {
  minHr: number | null;
  maxHr: number | null;
  maxSpeed: number | null;
  fastest1k: number | null;
  fastestMile: number | null;
  fastest5k: number | null;
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
  hrZones: number[] | null;
  segments: { kind: string; seconds: number; meters: number }[];
}

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

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
