import { MAX_SAMPLES, PACE_FASTEST, PACE_SLOWEST, activityStats, buildChart, decimate, kmSplits, pruneChart } from "../shared/activityChart";

// Garmin-shaped answers with made-up values and made-up coordinates (nowhere near anyone's home).
const KEYS = ["directTimestamp", "sumDistance", "directHeartRate", "directSpeed", "directElevation", "directDoubleCadence", "sumDuration", "directGradeAdjustedSpeed", "directAirTemperature"];
// the columns are not in the order the code reads them, so that a lookup by position would fail
const ORDER = [3, 0, 6, 1, 8, 2, 4, 7, 5];

/** A run of `n` samples a second apart at 3 m/s: 10 km in about 56 minutes when n is 3334. */
function details(n: number, over: { speed?: (i: number) => number; withPolyline?: boolean; withLatLon?: boolean } = {}) {
  const speed = over.speed ?? (() => 3);
  const rows: any[] = [];
  let dist = 0;
  for (let i = 0; i < n; i++) {
    dist += speed(i);
    const byKey: Record<string, number> = {
      directTimestamp: 1_700_000_000_000 + i * 1000, sumDistance: dist, directHeartRate: 140 + (i % 20), directSpeed: speed(i),
      directElevation: 40 + Math.sin(i / 200) * 5, directDoubleCadence: 172, sumDuration: i, directGradeAdjustedSpeed: speed(i), directAirTemperature: 18,
    };
    const metrics = new Array(KEYS.length);
    KEYS.forEach((k, ki) => (metrics[ORDER[ki]] = byKey[k]));
    rows.push({ metrics });
  }
  const polyline = Array.from({ length: Math.min(n, 800) }, (_, i) => ({
    lat: 10 + i * 0.00002, lon: 20 + i * 0.00003, altitude: 40, time: 1_700_000_000_000 + i * 4000, distanceInMeters: i * 12, speed: 3, extendedCoordinate: false, cumulativeAscent: 3, valid: true,
  }));
  return {
    activityId: 1, measurementCount: KEYS.length, metricsCount: n,
    metricDescriptors: KEYS.map((key, ki) => ({ metricsIndex: ORDER[ki], key, unit: { id: 1, key: "x", factor: 1 } })),
    activityDetailMetrics: rows,
    ...(over.withPolyline === false ? {} : { geoPolylineDTO: { startPoint: { lat: 10, lon: 20 }, polyline } }),
    heartRateDTOs: null,
  };
}

const laps = [
  { lapIndex: 1, startTimeGMT: "2026-09-05T11:57:00.0", distance: 1000, duration: 330, movingDuration: 329, elevationGain: 4, elevationLoss: 2, averageSpeed: 3.03, maxSpeed: 3.5, averageHR: 140, maxHR: 150, averageRunCadence: 170, intensityType: "WARMUP", calories: 60, wktStepIndex: 0, messageIndex: 0, ignored: "x" },
  { lapIndex: 2, distance: 8000, duration: 2340, averageHR: 166, maxHR: 182, intensityType: "INTERVAL" },
  { lapIndex: 3, distance: 10, duration: 5, intensityType: "REST" },
];
const zones = [{ zoneNumber: 2, secsInZone: 800, zoneLowBoundary: 120 }, { zoneNumber: 1, secsInZone: 50, zoneLowBoundary: 90 }, { zoneNumber: 3, secsInZone: 900, zoneLowBoundary: 140 }];

describe("pruning what Garmin sent", () => {
  it("keeps the original shape, with a few hundred samples and only the fields the charts use", () => {
    const kept = pruneChart({ details: details(3334), splits: { lapDTOs: laps, other: "x" }, zones });
    expect(kept.v).toBe(1);
    expect(kept.details.activityDetailMetrics).toHaveLength(MAX_SAMPLES);
    expect(kept.details.activityDetailMetrics[0].metrics).toHaveLength(KEYS.length);
    expect(kept.details.metricDescriptors.map((m) => m.key)).toEqual(KEYS);
    expect(kept.details.geoPolylineDTO!.polyline).toHaveLength(MAX_SAMPLES);
    expect(Object.keys(kept.details.geoPolylineDTO!.polyline[0]).sort()).toEqual(["altitude", "distanceInMeters", "lat", "lon", "speed", "time"]);
    expect(kept.splits!.lapDTOs[0]).not.toHaveProperty("ignored");
    expect(JSON.stringify(kept).length).toBeLessThan(80_000);
  });

  it("keeps the first and the last sample when it thins a series", () => {
    expect(decimate([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4)).toEqual([1, 4, 7, 10]);
    expect(decimate([1, 2, 3], 5)).toEqual([1, 2, 3]);
    const kept = pruneChart({ details: details(1000) });
    expect(kept.details.activityDetailMetrics[0].metrics[ORDER[1]]).toBe(3);
    expect(kept.details.activityDetailMetrics[MAX_SAMPLES - 1].metrics[ORDER[1]]).toBe(3000);
  });

  it("copes with an answer that has nothing: no GPS, no series, no laps, odd shapes", () => {
    expect(pruneChart({})).toEqual({ v: 1, details: { metricDescriptors: [], activityDetailMetrics: [] }, splits: null, zones: null });
    expect(pruneChart({ details: { metricDescriptors: "x", activityDetailMetrics: [null, { metrics: "y" }] }, splits: { lapDTOs: "z" }, zones: {} }).details.activityDetailMetrics).toEqual([{ metrics: [] }, { metrics: [] }]);
    expect(pruneChart({ details: details(50, { withPolyline: false }) }).details.geoPolylineDTO).toBeUndefined();
  });
});

describe("reading the charts", () => {
  const stored = pruneChart({ details: details(3334), splits: { lapDTOs: laps }, zones });
  const chart = buildChart(stored)!;

  it("finds each series by the key Garmin names it with, whatever the column order", () => {
    expect(chart.time).toHaveLength(MAX_SAMPLES);
    expect(chart.time[0]).toBe(0);
    expect(chart.time[MAX_SAMPLES - 1]).toBeCloseTo(3333, 0);
    expect(chart.distance[MAX_SAMPLES - 1]).toBeCloseTo(10002, 0);
    expect(chart.hr[0]).toBe(140);
    expect(chart.cadence[0]).toBe(172);
    expect(chart.elevation[0]).toBeCloseTo(40, 0);
    expect(chart.pace[0]).toBeCloseTo(333.3, 0); // 3 m/s
  });

  it("leaves a pace out where the speed is too low to be one, or absurd", () => {
    const slow = buildChart(pruneChart({ details: details(20, { speed: (i) => (i < 5 ? 0 : i < 10 ? 0.3 : i < 15 ? 20 : 3) }) }))!;
    expect(slow.pace.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(slow.pace.slice(5, 10)).toEqual([null, null, null, null, null]);
    expect(slow.pace.slice(10, 15)).toEqual([null, null, null, null, null]); // 20 m/s is 0:50/km
    expect(slow.pace[19]).toBeCloseTo(333, 0);
    for (const p of chart.pace) if (p !== null) expect(p).toBeGreaterThanOrEqual(PACE_FASTEST), expect(p).toBeLessThanOrEqual(PACE_SLOWEST);
  });

  it("draws the route from the polyline, with each point's distance", () => {
    expect(chart.route!.lat).toHaveLength(MAX_SAMPLES);
    expect(chart.route!.lat[0]).toBe(10);
    expect(chart.route!.distance[1]).toBeGreaterThan(0);
  });

  it("falls back on latitude and longitude columns, and says there is no route when there is none", () => {
    const withCols = details(30, { withPolyline: false });
    const keys = [...withCols.metricDescriptors, { metricsIndex: 9, key: "directLatitude" }, { metricsIndex: 10, key: "directLongitude" }];
    const rows = withCols.activityDetailMetrics.map((r: any, i: number) => ({ metrics: [...r.metrics, 10 + i * 0.001, i === 3 ? 0 : 20 + i * 0.001] }));
    rows[3].metrics[9] = 0; // a (0, 0) glitch
    const r = buildChart(pruneChart({ details: { ...withCols, metricDescriptors: keys, activityDetailMetrics: rows } }))!.route!;
    expect(r.lat).toHaveLength(29);
    expect(buildChart(pruneChart({ details: details(30, { withPolyline: false }) }))!.route).toBeNull();
  });

  it("reads the laps the watch recorded, with their kind and a pace only where the lap is long enough", () => {
    expect(chart.laps).toHaveLength(3);
    expect(chart.laps[0]).toEqual({ index: 1, meters: 1000, seconds: 330, paceSec: 330, avgHr: 140, maxHr: 150, gain: 4, cadence: 170, kind: "WARMUP" });
    expect(chart.laps[1]).toEqual(expect.objectContaining({ index: 2, paceSec: 293, avgHr: 166, kind: "INTERVAL" }));
    expect(chart.laps[2].paceSec).toBeNull(); // 10 m
  });

  it("reads the zones in order, each with the next one's lower bound as its upper", () => {
    expect(chart.zones).toEqual([
      { zone: 1, low: 90, high: 120, seconds: 50 },
      { zone: 2, low: 120, high: 140, seconds: 800 },
      { zone: 3, low: 140, high: null, seconds: 900 },
    ]);
    expect(buildChart(pruneChart({ details: details(20), zones: [{ zoneNumber: 1, secsInZone: 5 }] }))!.zones).toEqual([{ zone: 1, low: null, high: null, seconds: 5 }]);
    expect(buildChart(pruneChart({ details: details(20) }))!.zones).toBeNull();
  });

  it("works out km splits from the distance and the time, leaving out a sliver of a few meters at the end", () => {
    expect(chart.splits).toHaveLength(10);
    expect(chart.splits[0]).toEqual(expect.objectContaining({ index: 1, meters: 1000, seconds: 333, paceSec: 333 }));
    expect(chart.splits[0].avgHr).toBeGreaterThan(130);
    expect(chart.splits[9].meters).toBeGreaterThan(990);
  });

  it("returns nothing for what was never stored, and an empty chart for an activity with no series", () => {
    expect(buildChart(null)).toBeNull();
    expect(buildChart(undefined)).toBeNull();
    const empty = buildChart(pruneChart({}))!;
    expect(empty.time).toEqual([]);
    expect(empty.route).toBeNull();
    expect(empty.laps).toEqual([]);
    expect(empty.splits).toEqual([]);
  });
});

describe("km splits", () => {
  it("keeps a real partial last kilometer", () => {
    const [, , last] = kmSplits([0, 1000, 2000, 2500], [0, 300, 600, 750], [null, null, null, null], [null, null, null, null]);
    expect(last).toEqual(expect.objectContaining({ index: 3, meters: 500, seconds: 150, paceSec: 300 }));
  });

  it("interpolates the time at each kilometer between samples", () => {
    const distance = [0, 600, 1200, 1800, 2400], time = [0, 200, 400, 600, 800]; // 3 m/s
    const [a, b, c] = kmSplits(distance, time, [null, null, null, null, null], [null, null, null, null, null]);
    expect([a.seconds, b.seconds]).toEqual([333, 333]);
    expect(c.meters).toBe(400);
    expect(c.paceSec).toBe(333);
  });

  it("skips samples that go backwards and needs two points", () => {
    expect(kmSplits([0], [0], [null], [null])).toEqual([]);
    expect(kmSplits([0, 1000, 500, 2000], [0, 300, 310, 600], [null, null, null, null], [null, null, null, null]).map((s) => s.meters)).toEqual([1000, 1000]);
  });
});

describe("the numbers beside the charts", () => {
  const raw = {
    maxHR: 182, maxSpeed: 4.1, fastestSplit_1000: 268.4, fastestSplit_1609: 440, fastestSplit_5000: 1400, avgStrideLength: 96.1, steps: 8800,
    maxRunningCadenceInStepsPerMinute: 192, elevationLoss: 12, minElevation: 38, maxElevation: 51, vO2MaxValue: 52, locationName: "Nowhere",
    movingDuration: 2900, elapsedDuration: 3000, aerobicTrainingEffectMessage: "IMPROVING_AEROBIC_BASE_2", anaerobicTrainingEffectMessage: "NO_ANAEROBIC_BENEFIT_0",
    hrTimeInZone_1: 52.4, hrTimeInZone_2: 860, hrTimeInZone_3: 875, hrTimeInZone_4: 0, hrTimeInZone_5: 0,
    splitSummaries: [
      { splitType: "RWD_STAND", duration: 11.3, distance: 16.8 }, { splitType: "RWD_RUN", duration: 1774.4, distance: 5039.6 }, { splitType: "RWD_WALK", duration: 30, distance: 40 }, { splitType: "INTERVAL_ACTIVE", duration: 5 },
    ],
  };

  it("reads each number from the list item, and from the details when the list item lacks it", () => {
    const s = activityStats(raw, { summaryDTO: { minHR: 85 }, locationName: "Elsewhere" });
    expect(s).toEqual(expect.objectContaining({ minHr: 85, maxHr: 182, maxSpeed: 4.1, fastest1k: 268.4, fastestMile: 440, fastest5k: 1400, stride: 96.1, steps: 8800, maxCadence: 192, elevationLoss: 12, vo2max: 52, location: "Nowhere", movingSeconds: 2900, elapsedSeconds: 3000 }));
    expect(s.hrZones).toEqual([52.4, 860, 875, 0, 0]);
    expect(s.segments).toEqual([{ kind: "stand", seconds: 11, meters: 17 }, { kind: "run", seconds: 1774, meters: 5040 }, { kind: "walk", seconds: 30, meters: 40 }]);
    const fallback = activityStats({}, { summaryDTO: { maxHR: 160, strideLength: 90, maxRunCadence: 180, elevationLoss: 3 }, locationName: "Elsewhere" });
    expect(fallback).toEqual(expect.objectContaining({ maxHr: 160, stride: 90, maxCadence: 180, elevationLoss: 3, location: "Elsewhere", hrZones: null, segments: [] }));
  });

  it("gives null for what Garmin did not say, and copes with nothing at all", () => {
    const s = activityStats(undefined, undefined);
    for (const [key, value] of Object.entries(s)) expect(value === null || (Array.isArray(value) && value.length === 0)).toBe(true);
    expect(activityStats({ hrTimeInZone_1: 0, hrTimeInZone_2: 0 }, null).hrZones).toBeNull();
  });
});
