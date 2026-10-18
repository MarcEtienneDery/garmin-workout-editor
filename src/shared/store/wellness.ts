import type { Database } from "./sqliteStore";

/**
 * The daily health data Garmin keeps for each profile: sleep, HRV, the day's summary (resting heart rate, Body Battery,
 * stress, steps, intensity minutes), the heart-rate, stress and Body Battery series, respiration and SpO2.
 *
 * One row per profile, day and kind, holding the response exactly as Garmin sent it (`data`; JSON `null` when Garmin has
 * nothing of that kind for the day). Nothing derived is stored: what a view needs is read out of the responses with SQL
 * (see `metrics`), so a better reading of them never needs Garmin again. A day's sleep and HRV are the night that ended
 * that morning; the other kinds are the day itself. The last days still change (the watch syncs late), so the sync
 * fetches them again for a while; older rows are final.
 *
 * Next to the rows, one `wellness_sync` row per profile remembers why a sync stopped and who is syncing (a lease), as the
 * activities do: the MCP server and the web editor are two processes with two Garmin sessions.
 */
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

/** What is kept, most useful for a daily readiness first: the sync fetches the kinds in this order. */
export const WELLNESS_KINDS = ["summary", "sleep", "hrv", "heart_rate", "stress", "body_battery", "respiration", "spo2"] as const;
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

/** A number, or null. */
export type NumOrNull = number | null;

/** What a day's responses say, the fields a daily check reads. Seconds, minutes, bpm, ms and 0-100 scores as Garmin gives them. */
export interface DayMetrics {
  day: string;
  // the night that ended that morning
  sleepSeconds: NumOrNull;
  sleepScore: NumOrNull;
  deepSeconds: NumOrNull;
  lightSeconds: NumOrNull;
  remSeconds: NumOrNull;
  awakeSeconds: NumOrNull;
  awakeCount: NumOrNull;
  sleepStress: NumOrNull;
  /** What Garmin says the night should have been, in minutes. */
  sleepNeedMinutes: NumOrNull;
  overnightHrv: NumOrNull;
  // HRV: last night against Garmin's own baseline band
  hrvLastNight: NumOrNull;
  hrvWeeklyAvg: NumOrNull;
  /** The top of Garmin's "low" HRV range: below it, last night was low. */
  hrvLowUpper: NumOrNull;
  hrvBalancedLow: NumOrNull;
  hrvBalancedHigh: NumOrNull;
  hrvStatus: string | null;
  // the day
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
  avgSleepSpo2: NumOrNull;
  lowestSpo2: NumOrNull;
}

type Field = keyof Omit<DayMetrics, "day">;

/** Where each field lives in the stored responses: its kind and its JSON path. A field with several places takes the first one that has it. */
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
  avgSleepSpo2: [["spo2", "$.avgSleepSpO2"]],
  lowestSpo2: [["spo2", "$.lowestSpO2"]],
};

const FIELDS = Object.keys(SOURCES) as Field[];
const TEXT_FIELDS = new Set<Field>(["hrvStatus"]);

/** One column per field: the first of its places that holds a value. Paths and kinds are constants above, never input. */
const column = (f: Field): string => {
  const places = SOURCES[f].map(([kind, path]) => `MAX(CASE WHEN kind = '${kind}' THEN json_extract(data, '${path}') END)`);
  return `${places.length > 1 ? `COALESCE(${places.join(", ")})` : places[0]} AS ${f}`;
};
const METRICS_SQL = `SELECT day, ${FIELDS.map(column).join(", ")}
FROM wellness WHERE profile = ? AND day BETWEEN ? AND ? GROUP BY day ORDER BY day`;

const num = (v: unknown): NumOrNull => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class WellnessTable {
  constructor(
    private readonly db: Database,
    private readonly tx: <T>(fn: () => T) => T
  ) {}

  /** Keep one response as Garmin sent it; `undefined` is kept as JSON null, an answer of "nothing for that day". */
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

  /** When each stored response was fetched, keyed "day|kind", for the days from `from` to `to` inclusive. */
  fetchedAt(profile: string, from: string, to: string): Map<string, number> {
    const rows = this.db.prepare("SELECT day, kind, fetched_at FROM wellness WHERE profile = ? AND day BETWEEN ? AND ?").all(profile, from, to);
    return new Map(rows.map((r) => [`${r.day}|${r.kind}`, r.fetched_at as number]));
  }

  counts(profile: string): WellnessCounts {
    const r = this.db.prepare("SELECT COUNT(*) AS rows, COUNT(DISTINCT day) AS days, MIN(day) AS oldest, MAX(day) AS newest FROM wellness WHERE profile = ?").get(profile) as { rows: number; days: number; oldest: string | null; newest: string | null };
    return { rows: r.rows, days: r.days, oldest: r.oldest ?? null, newest: r.newest ?? null };
  }

  /** The fields of every stored day from `from` to `to` inclusive, oldest first; a field no response has is null. Read in SQL: the responses are never parsed here. */
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

  // ── Who is syncing, and why the last sync stopped ──

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

  /** Become the one that syncs this profile. False while another holder's lease runs; a lease that ran out is taken over. */
  claim(profile: string, holder: string, leaseMs: number, now = Date.now()): boolean {
    return this.tx(() => {
      this.db.prepare("INSERT OR IGNORE INTO wellness_sync (profile) VALUES (?)").run(profile);
      const r = this.db.prepare("SELECT holder, lease_until FROM wellness_sync WHERE profile = ?").get(profile) as { holder: string | null; lease_until: number | null };
      if (r.holder && r.holder !== holder && (r.lease_until ?? 0) > now) return false;
      this.db.prepare("UPDATE wellness_sync SET holder = ?, lease_until = ?, updated_at = ? WHERE profile = ?").run(holder, now + leaseMs, now, profile);
      return true;
    });
  }

  /** Extend the lease; false when it was lost (it ran out and another holder took over). */
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
