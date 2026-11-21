import type { Database } from "./sqliteStore";

export const WELLNESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS wellness (
  profile    TEXT NOT NULL,
  day        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  data       TEXT NOT NULL,
  UNIQUE (profile, day, kind)
);
CREATE TABLE IF NOT EXISTS wellness_sync (
  profile     TEXT PRIMARY KEY,
  holder      TEXT,
  lease_until INTEGER,
  error       TEXT,
  retry_after INTEGER,
  updated_at  INTEGER
);
`;

export const WELLNESS_KINDS = ["summary", "sleep", "hrv", "heart_rate", "stress", "body_battery", "respiration", "spo2", "weight"] as const;
export type WellnessKind = (typeof WELLNESS_KINDS)[number];

export interface WellnessCounts {
  rows: number;
  days: number;
  oldest: string | null;
  newest: string | null;
}

export interface WellnessState {
  holder: string | null;
  leaseUntil: number | null;
  error: string | null;
  retryAfter: number | null;
}

export type NumOrNull = number | null;

export interface DayMetrics {
  day: string;
  sleepSeconds: NumOrNull;
  sleepScore: NumOrNull;
  deepSeconds: NumOrNull;
  lightSeconds: NumOrNull;
  remSeconds: NumOrNull;
  awakeSeconds: NumOrNull;
  awakeCount: NumOrNull;
  sleepStress: NumOrNull;
  sleepNeedMinutes: NumOrNull;
  overnightHrv: NumOrNull;
  hrvLastNight: NumOrNull;
  hrvWeeklyAvg: NumOrNull;
  hrvLowUpper: NumOrNull;
  hrvBalancedLow: NumOrNull;
  hrvBalancedHigh: NumOrNull;
  hrvStatus: string | null;
  restingHr: NumOrNull;
  restingHr7d: NumOrNull;
  avgStress: NumOrNull;
  maxStress: NumOrNull;
  bodyBatteryWake: NumOrNull;
  bodyBatteryHigh: NumOrNull;
  bodyBatteryLow: NumOrNull;
  bodyBatteryCharged: NumOrNull;
  bodyBatteryDrained: NumOrNull;
  steps: NumOrNull;
  moderateMinutes: NumOrNull;
  vigorousMinutes: NumOrNull;
  avgSleepRespiration: NumOrNull;
  avgWakingRespiration: NumOrNull;
  highRespiration: NumOrNull;
  lowRespiration: NumOrNull;
  avgSleepSpo2: NumOrNull;
  lowestSpo2: NumOrNull;
  totalKcal: NumOrNull;
  activeKcal: NumOrNull;
  bmrKcal: NumOrNull;
  weightKg: NumOrNull;
  bodyFatPercent: NumOrNull;
  muscleKg: NumOrNull;
  bmi: NumOrNull;
}

export interface DayProgress {
  fetchedAt: number;
  stepGoal: NumOrNull;
  intensityGoal: NumOrNull;
  distanceMeters: NumOrNull;
  bodyBatteryNow: NumOrNull;
  watchSyncedAt: NumOrNull;
}

type Field = keyof Omit<DayMetrics, "day">;

const SOURCES: Record<Field, [WellnessKind, string][]> = {
  sleepSeconds: [["sleep", "$.dailySleepDTO.sleepTimeSeconds"]],
  sleepScore: [["sleep", "$.dailySleepDTO.sleepScores.overall.value"]],
  deepSeconds: [["sleep", "$.dailySleepDTO.deepSleepSeconds"]],
  lightSeconds: [["sleep", "$.dailySleepDTO.lightSleepSeconds"]],
  remSeconds: [["sleep", "$.dailySleepDTO.remSleepSeconds"]],
  awakeSeconds: [["sleep", "$.dailySleepDTO.awakeSleepSeconds"]],
  awakeCount: [["sleep", "$.dailySleepDTO.awakeCount"]],
  sleepStress: [["sleep", "$.dailySleepDTO.avgSleepStress"]],
  sleepNeedMinutes: [["sleep", "$.dailySleepDTO.sleepNeed.actual"]],
  overnightHrv: [["sleep", "$.avgOvernightHrv"], ["hrv", "$.hrvSummary.lastNightAvg"]],
  hrvLastNight: [["hrv", "$.hrvSummary.lastNightAvg"], ["sleep", "$.avgOvernightHrv"]],
  hrvWeeklyAvg: [["hrv", "$.hrvSummary.weeklyAvg"]],
  hrvLowUpper: [["hrv", "$.hrvSummary.baseline.lowUpper"]],
  hrvBalancedLow: [["hrv", "$.hrvSummary.baseline.balancedLow"]],
  hrvBalancedHigh: [["hrv", "$.hrvSummary.baseline.balancedUpper"]],
  hrvStatus: [["hrv", "$.hrvSummary.status"], ["sleep", "$.hrvStatus"]],
  restingHr: [["summary", "$.restingHeartRate"], ["heart_rate", "$.restingHeartRate"], ["sleep", "$.restingHeartRate"]],
  restingHr7d: [["summary", "$.lastSevenDaysAvgRestingHeartRate"], ["heart_rate", "$.lastSevenDaysAvgRestingHeartRate"]],
  avgStress: [["summary", "$.averageStressLevel"], ["stress", "$.avgStressLevel"]],
  maxStress: [["summary", "$.maxStressLevel"], ["stress", "$.maxStressLevel"]],
  bodyBatteryWake: [["summary", "$.bodyBatteryAtWakeTime"]],
  bodyBatteryHigh: [["summary", "$.bodyBatteryHighestValue"]],
  bodyBatteryLow: [["summary", "$.bodyBatteryLowestValue"]],
  bodyBatteryCharged: [["summary", "$.bodyBatteryChargedValue"], ["body_battery", "$[0].charged"]],
  bodyBatteryDrained: [["summary", "$.bodyBatteryDrainedValue"], ["body_battery", "$[0].drained"]],
  steps: [["summary", "$.totalSteps"]],
  moderateMinutes: [["summary", "$.moderateIntensityMinutes"]],
  vigorousMinutes: [["summary", "$.vigorousIntensityMinutes"]],
  avgSleepRespiration: [["respiration", "$.avgSleepRespirationValue"], ["sleep", "$.dailySleepDTO.averageRespirationValue"]],
  avgWakingRespiration: [["respiration", "$.avgWakingRespirationValue"], ["summary", "$.avgWakingRespirationValue"]],
  highRespiration: [["respiration", "$.highestRespirationValue"], ["summary", "$.highestRespirationValue"]],
  lowRespiration: [["respiration", "$.lowestRespirationValue"], ["summary", "$.lowestRespirationValue"]],
  avgSleepSpo2: [["spo2", "$.avgSleepSpO2"]],
  lowestSpo2: [["spo2", "$.lowestSpO2"]],
  totalKcal: [["summary", "$.totalKilocalories"]],
  activeKcal: [["summary", "$.activeKilocalories"]],
  bmrKcal: [["summary", "$.bmrKilocalories"]],
  weightKg: [["weight", "$.totalAverage.weight"], ["weight", "$.dateWeightList[0].weight"]],
  bodyFatPercent: [["weight", "$.totalAverage.bodyFat"], ["weight", "$.dateWeightList[0].bodyFat"]],
  muscleKg: [["weight", "$.totalAverage.muscleMass"], ["weight", "$.dateWeightList[0].muscleMass"]],
  bmi: [["weight", "$.totalAverage.bmi"], ["weight", "$.dateWeightList[0].bmi"]],
};

const DIVISOR: Partial<Record<Field, number>> = { weightKg: 1000, muscleKg: 1000 };

const FIELDS = Object.keys(SOURCES) as Field[];
const TEXT_FIELDS = new Set<Field>(["hrvStatus"]);

export function emptyDayMetrics(day: string): DayMetrics {
  return Object.fromEntries([["day", day], ...FIELDS.map((f) => [f, null])]) as unknown as DayMetrics;
}

const column = (f: Field): string => {
  const places = SOURCES[f].map(([kind, path]) => `MAX(CASE WHEN kind = '${kind}' THEN json_extract(data, '${path}') END)`);
  const value = places.length > 1 ? `COALESCE(${places.join(", ")})` : places[0];
  return `${DIVISOR[f] ? `(${value}) / ${DIVISOR[f]}.0` : value} AS ${f}`;
};
const METRICS_SQL = `SELECT day, ${FIELDS.map(column).join(", ")}
FROM wellness WHERE profile = ? AND day BETWEEN ? AND ? GROUP BY day ORDER BY day`;

const num = (v: unknown): NumOrNull => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class WellnessTable {
  constructor(
    private readonly db: Database,
    private readonly tx: <T>(fn: () => T) => T
  ) {}

  hasRows(profile: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM wellness WHERE profile = ? LIMIT 1").get(profile);
  }

  hasWeighIn(profile: string): boolean {
    const paths = SOURCES.weightKg.map(([, path]) => `json_extract(data, '${path}') IS NOT NULL`).join(" OR ");
    return !!this.db.prepare(`SELECT 1 FROM wellness WHERE profile = ? AND kind = 'weight' AND (${paths}) LIMIT 1`).get(profile);
  }

  put(profile: string, day: string, kind: WellnessKind, data: unknown, now = Date.now()): void {
    this.tx(() =>
      this.db
        .prepare("INSERT INTO wellness (profile, day, kind, fetched_at, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT (profile, day, kind) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data")
        .run(profile, day, kind, now, JSON.stringify(data ?? null))
    );
  }

  get(profile: string, day: string, kind: WellnessKind): { data: any; fetchedAt: number } | null {
    const r = this.db.prepare("SELECT data, fetched_at FROM wellness WHERE profile = ? AND day = ? AND kind = ?").get(profile, day, kind);
    return r ? { data: JSON.parse(r.data), fetchedAt: r.fetched_at } : null;
  }

  forget(profile: string, day: string, kind: WellnessKind): void {
    this.db.prepare("DELETE FROM wellness WHERE profile = ? AND day = ? AND kind = ?").run(profile, day, kind);
  }

  forgetEmptyWeighIns(profile: string, from: string, to: string): number {
    const r = this.db
      .prepare("DELETE FROM wellness WHERE profile = ? AND kind = 'weight' AND day BETWEEN ? AND ? AND (data = 'null' OR COALESCE(json_array_length(json_extract(data, '$.dateWeightList')), 0) = 0)")
      .run(profile, from, to) as { changes: number | bigint };
    return Number(r.changes);
  }

  rowsOfDay(profile: string, day: string): { kind: WellnessKind; fetchedAt: number; bytes: number }[] {
    const rows = this.db.prepare("SELECT kind, fetched_at, length(data) AS bytes FROM wellness WHERE profile = ? AND day = ?").all(profile, day);
    return WELLNESS_KINDS.flatMap((kind) => rows.filter((r) => r.kind === kind).map((r) => ({ kind, fetchedAt: r.fetched_at as number, bytes: r.bytes as number })));
  }

  fetchedAt(profile: string, from: string, to: string): Map<string, number> {
    const rows = this.db.prepare("SELECT day, kind, fetched_at FROM wellness WHERE profile = ? AND day BETWEEN ? AND ?").all(profile, from, to);
    return new Map(rows.map((r) => [`${r.day}|${r.kind}`, r.fetched_at as number]));
  }

  counts(profile: string): WellnessCounts {
    const r = this.db.prepare("SELECT COUNT(*) AS rows, COUNT(DISTINCT day) AS days, MIN(day) AS oldest, MAX(day) AS newest FROM wellness WHERE profile = ?").get(profile) as { rows: number; days: number; oldest: string | null; newest: string | null };
    return { rows: r.rows, days: r.days, oldest: r.oldest ?? null, newest: r.newest ?? null };
  }

  progress(profile: string, day: string): DayProgress | null {
    const r = this.db
      .prepare(
        `SELECT fetched_at, json_extract(data, '$.dailyStepGoal') AS step_goal, json_extract(data, '$.intensityMinutesGoal') AS intensity_goal,
                json_extract(data, '$.totalDistanceMeters') AS distance, json_extract(data, '$.bodyBatteryMostRecentValue') AS battery_now,
                json_extract(data, '$.lastSyncTimestampGMT') AS watch_sync
         FROM wellness WHERE profile = ? AND day = ? AND kind = 'summary'`
      )
      .get(profile, day);
    if (!r) return null;
    const gmt = typeof r.watch_sync === "string" ? Date.parse(`${r.watch_sync}Z`) : NaN;
    return {
      fetchedAt: r.fetched_at as number,
      stepGoal: num(r.step_goal),
      intensityGoal: num(r.intensity_goal),
      distanceMeters: num(r.distance),
      bodyBatteryNow: num(r.battery_now),
      watchSyncedAt: Number.isFinite(gmt) ? gmt : null,
    };
  }

  metrics(profile: string, from: string, to: string): DayMetrics[] {
    return this.db
      .prepare(METRICS_SQL)
      .all(profile, from, to)
      .map((r) => {
        const m: Record<string, unknown> = { day: r.day };
        for (const f of FIELDS) m[f] = TEXT_FIELDS.has(f) ? (typeof r[f] === "string" && r[f] ? r[f] : null) : num(r[f]);
        return m as unknown as DayMetrics;
      });
  }


  state(profile: string): WellnessState {
    const r = this.db.prepare("SELECT * FROM wellness_sync WHERE profile = ?").get(profile);
    return { holder: r?.holder ?? null, leaseUntil: r?.lease_until ?? null, error: r?.error ?? null, retryAfter: r?.retry_after ?? null };
  }

  saveProgress(profile: string, progress: { error?: string | null; retryAfter?: number | null }, now = Date.now()): void {
    this.tx(() => {
      this.db.prepare("INSERT OR IGNORE INTO wellness_sync (profile) VALUES (?)").run(profile);
      const sets = ["updated_at = ?"], params: unknown[] = [now];
      if (progress.error !== undefined) { sets.push("error = ?"); params.push(progress.error); }
      if (progress.retryAfter !== undefined) { sets.push("retry_after = ?"); params.push(progress.retryAfter); }
      this.db.prepare(`UPDATE wellness_sync SET ${sets.join(", ")} WHERE profile = ?`).run(...params, profile);
    });
  }

  claim(profile: string, holder: string, leaseMs: number, now = Date.now()): boolean {
    return this.tx(() => {
      this.db.prepare("INSERT OR IGNORE INTO wellness_sync (profile) VALUES (?)").run(profile);
      const r = this.db.prepare("SELECT holder, lease_until FROM wellness_sync WHERE profile = ?").get(profile) as { holder: string | null; lease_until: number | null };
      if (r.holder && r.holder !== holder && (r.lease_until ?? 0) > now) return false;
      this.db.prepare("UPDATE wellness_sync SET holder = ?, lease_until = ?, updated_at = ? WHERE profile = ?").run(holder, now + leaseMs, now, profile);
      return true;
    });
  }

  renew(profile: string, holder: string, leaseMs: number, now = Date.now()): boolean {
    return this.tx(() => {
      const r = this.db.prepare("SELECT holder FROM wellness_sync WHERE profile = ?").get(profile);
      if (r?.holder !== holder) return false;
      this.db.prepare("UPDATE wellness_sync SET lease_until = ?, updated_at = ? WHERE profile = ?").run(now + leaseMs, now, profile);
      return true;
    });
  }

  release(profile: string, holder: string, now = Date.now()): void {
    this.tx(() => this.db.prepare("UPDATE wellness_sync SET holder = NULL, lease_until = NULL, updated_at = ? WHERE profile = ? AND holder = ?").run(now, profile, holder));
  }
}
