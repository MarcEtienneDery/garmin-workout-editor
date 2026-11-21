import type { Database } from "./sqliteStore";

export const ACTIVITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS activities (
  profile       TEXT NOT NULL,
  id            TEXT NOT NULL,
  start_gmt     TEXT NOT NULL,
  start_local   TEXT NOT NULL,
  type          TEXT NOT NULL,
  name          TEXT NOT NULL,
  duration      REAL,
  distance      REAL,
  avg_hr        REAL,
  workout_id    TEXT,
  raw           TEXT NOT NULL,
  detail        TEXT,
  detail_at     INTEGER,
  detail_failed INTEGER NOT NULL DEFAULT 0,
  synced_at     INTEGER NOT NULL,
  PRIMARY KEY (profile, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS activities_by_day ON activities (profile, start_local);
CREATE INDEX IF NOT EXISTS activities_by_start ON activities (profile, start_gmt);
CREATE TABLE IF NOT EXISTS activity_charts (
  profile    TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT,
  fetched_at INTEGER,
  failed     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS activity_sync (
  profile      TEXT PRIMARY KEY,
  complete     INTEGER NOT NULL DEFAULT 0,
  next_offset  INTEGER NOT NULL DEFAULT 0,
  holder       TEXT,
  lease_until  INTEGER,
  error        TEXT,
  retry_after  INTEGER,
  updated_at   INTEGER
);
`;

export const REFRESH_YOUNG_MS = 6 * 3_600_000;

export const MAX_DETAIL_FAILURES = 3;

export interface NewActivity {
  id: string;
  startGmt: string;
  startLocal: string;
  type: string;
  name: string;
  duration: number | null;
  distance: number | null;
  avgHr: number | null;
  workoutId: string | null;
  raw: unknown;
}

export interface StoredActivity extends Omit<NewActivity, "raw"> {
  raw: any;
  detail: any | null;
  detailAt: number | null;
  syncedAt: number;
}

export interface LifetimeRow {
  id: string;
  startLocal: string;
  type: string;
  name: string;
  distance: number | null;
  duration: number | null;
  gain: number | null;
  calories: number | null;
  vo2: number | null;
  sets: number | null;
  reps: number | null;
}

export interface LoadRow {
  id: string;
  startLocal: string;
  type: string;
  name: string;
  seconds: number | null;
  avgHr: number | null;
  maxHr: number | null;
  rpe: number | null;
}

export interface ActivitySummary {
  id: string;
  startLocal: string;
  type: string;
  name: string;
  distance: number | null;
  duration: number | null;
  avgHr: number | null;
  maxHr: number | null;
  speed: number | null;
  trainingEffectLabel: string | null;
  aerobicEffect: number | null;
  elevationGain: number | null;
  calories: number | null;
  sets: number | null;
  reps: number | null;
  workoutId: string | null;
  detailed: boolean;
}

export interface SyncState {
  complete: boolean;
  nextOffset: number;
  holder: string | null;
  leaseUntil: number | null;
  error: string | null;
  retryAfter: number | null;
  updatedAt: number | null;
}

export interface ActivityCounts {
  total: number;
  withDetail: number;
  withChart: number;
  newest: string | null;
  oldest: string | null;
}

type Row = Record<string, any>;

const CALORIES = "COALESCE(json_extract(raw, '$.calories'), json_extract(detail, '$.summaryDTO.calories'))";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const toActivity = (r: Row): StoredActivity => ({
  id: r.id,
  startGmt: r.start_gmt,
  startLocal: r.start_local,
  type: r.type,
  name: r.name,
  duration: r.duration,
  distance: r.distance,
  avgHr: r.avg_hr,
  workoutId: r.workout_id,
  raw: JSON.parse(r.raw),
  detail: r.detail === null ? null : JSON.parse(r.detail),
  detailAt: r.detail_at,
  syncedAt: r.synced_at,
});

export const startMs = (startGmt: string): number => Date.parse(startGmt.replace(" ", "T") + "Z");

export class ActivityTable {
  constructor(
    private readonly db: Database,
    private readonly tx: <T>(fn: () => T) => T
  ) {}

  insertNew(profile: string, activities: NewActivity[], now = Date.now()): number {
    return this.tx(() => {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO activities (profile, id, start_gmt, start_local, type, name, duration, distance, avg_hr, workout_id, raw, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      let added = 0;
      for (const a of activities) {
        const result = insert.run(profile, a.id, a.startGmt, a.startLocal, a.type, a.name, a.duration, a.distance, a.avgHr, a.workoutId, JSON.stringify(a.raw), now) as { changes?: number | bigint };
        added += Number(result?.changes ?? 0);
      }
      return added;
    });
  }

  known(profile: string, ids: string[]): Set<string> {
    const found = new Set<string>();
    const select = this.db.prepare("SELECT 1 AS yes FROM activities WHERE profile = ? AND id = ?");
    for (const id of ids) if (select.get(profile, id)) found.add(id);
    return found;
  }

  setDetail(profile: string, id: string, detail: unknown, now = Date.now()): void {
    const text = JSON.stringify(detail);
    this.tx(() =>
      this.db
        .prepare(
          `UPDATE activities SET detail = ?, detail_at = ?, detail_failed = 0,
             workout_id = COALESCE(workout_id, CAST(json_extract(?, '$.metadataDTO.associatedWorkoutId') AS TEXT), CAST(json_extract(?, '$.workoutId') AS TEXT))
           WHERE profile = ? AND id = ?`
        )
        .run(text, now, text, text, profile, id)
    );
  }

  noteDetailFailure(profile: string, id: string): void {
    this.tx(() => this.db.prepare("UPDATE activities SET detail_failed = detail_failed + 1 WHERE profile = ? AND id = ?").run(profile, id));
  }

  needingDetail(profile: string, options: { limit?: number; settleMs: number; refreshMs?: number; ids?: string[]; now?: number }): { id: string; startGmt: string; type: string }[] {
    const limit = options.limit ?? 1_000_000;
    const missing = this.db
      .prepare("SELECT id, start_gmt, type FROM activities WHERE profile = ? AND detail IS NULL AND detail_failed < ? ORDER BY start_gmt DESC LIMIT ?")
      .all(profile, MAX_DETAIL_FAILURES, limit);
    const recent = this.db
      .prepare(
        `SELECT id, start_gmt, type FROM activities
         WHERE profile = ? AND detail IS NOT NULL AND detail_failed < ?
           AND detail_at < CAST(strftime('%s', start_gmt) AS INTEGER) * 1000 + ? AND detail_at <= ?
         ORDER BY start_gmt DESC`
      )
      .all(profile, MAX_DETAIL_FAILURES, options.settleMs, (options.now ?? Date.now()) - (options.refreshMs ?? REFRESH_YOUNG_MS));
    const wanted = options.ids ? new Set(options.ids) : null;
    return [...recent, ...missing]
      .filter((r) => !wanted || wanted.has(r.id))
      .sort((a, b) => b.start_gmt.localeCompare(a.start_gmt))
      .slice(0, limit)
      .map((r) => ({ id: r.id, startGmt: r.start_gmt, type: r.type }));
  }

  between(profile: string, options: { from?: string; to?: string; type?: string; limit?: number } = {}): StoredActivity[] {
    const where = ["profile = ?"], params: unknown[] = [profile];
    if (options.from) { where.push("start_gmt >= ?"); params.push(options.from); }
    if (options.to) { where.push("start_gmt <= ?"); params.push(options.to); }
    if (options.type) { where.push("type = ?"); params.push(options.type); }
    params.push(options.limit ?? 1_000_000);
    return this.db.prepare(`SELECT * FROM activities WHERE ${where.join(" AND ")} ORDER BY start_gmt DESC LIMIT ?`).all(...params).map(toActivity);
  }


  setChart(profile: string, id: string, data: unknown, now = Date.now()): void {
    this.tx(() =>
      this.db
        .prepare(
          `INSERT INTO activity_charts (profile, id, data, fetched_at, failed) VALUES (?, ?, ?, ?, 0)
           ON CONFLICT (profile, id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at, failed = 0`
        )
        .run(profile, id, JSON.stringify(data), now)
    );
  }

  noteChartFailure(profile: string, id: string): void {
    this.tx(() =>
      this.db
        .prepare("INSERT INTO activity_charts (profile, id, failed) VALUES (?, ?, 1) ON CONFLICT (profile, id) DO UPDATE SET failed = failed + 1")
        .run(profile, id)
    );
  }

  getChart(profile: string, id: string): any | null {
    const r = this.db.prepare("SELECT data FROM activity_charts WHERE profile = ? AND id = ?").get(profile, id);
    return r && r.data !== null && r.data !== undefined ? JSON.parse(r.data) : null;
  }

  needingChart(profile: string, options: { limit?: number; ids?: string[] } = {}): { id: string; startGmt: string; type: string }[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.start_gmt, a.type FROM activities a
         LEFT JOIN activity_charts c ON c.profile = a.profile AND c.id = a.id
         WHERE a.profile = ? AND c.data IS NULL AND COALESCE(c.failed, 0) < ? ORDER BY a.start_gmt DESC`
      )
      .all(profile, MAX_DETAIL_FAILURES);
    const wanted = options.ids ? new Set(options.ids) : null;
    return rows.filter((r) => !wanted || wanted.has(r.id)).slice(0, options.limit ?? rows.length).map((r) => ({ id: r.id, startGmt: r.start_gmt, type: r.type }));
  }


  fingerprint(profile: string): string {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n, COUNT(detail) AS d, COALESCE(MAX(synced_at), 0) AS s, COALESCE(MAX(detail_at), 0) AS t FROM activities WHERE profile = ?")
      .get(profile) as Row;
    return `${r.n}:${r.d}:${r.s}:${r.t}`;
  }

  lifetimeRows(profile: string): LifetimeRow[] {
    return this.db
      .prepare(
        `SELECT id, start_local, type, name, distance, duration,
                json_extract(raw, '$.elevationGain') AS gain, ${CALORIES} AS calories,
                json_extract(raw, '$.vO2MaxValue') AS vo2, json_extract(raw, '$.totalSets') AS sets, json_extract(raw, '$.totalReps') AS reps
         FROM activities WHERE profile = ?`
      )
      .all(profile)
      .map((r) => ({
        id: r.id, startLocal: r.start_local, type: r.type, name: r.name, distance: r.distance ?? null, duration: r.duration ?? null,
        gain: num(r.gain), calories: num(r.calories), vo2: num(r.vo2), sets: num(r.sets), reps: num(r.reps),
      }));
  }

  fastestSplits(profile: string): { id: string; meters: number; seconds: number }[] {
    return this.db
      .prepare("SELECT a.id AS id, j.key AS key, j.value AS value FROM activities a, json_each(a.raw) j WHERE a.profile = ? AND a.type = 'running' AND j.key GLOB 'fastestSplit_[0-9]*'")
      .all(profile)
      .flatMap((r) => {
        const meters = Number(String(r.key).slice("fastestSplit_".length)), seconds = typeof r.value === "number" ? r.value : NaN;
        return meters > 0 && seconds > 0 ? [{ id: r.id as string, meters, seconds }] : [];
      });
  }

  loadRows(profile: string, sinceLocal: string): LoadRow[] {
    return this.db
      .prepare(
        `SELECT id, start_local, type, name, duration, avg_hr, json_extract(raw, '$.maxHR') AS max_hr, json_extract(detail, '$.summaryDTO.directWorkoutRpe') AS rpe
         FROM activities WHERE profile = ? AND start_local >= ? ORDER BY start_local`
      )
      .all(profile, sinceLocal)
      .map((r) => ({ id: r.id, startLocal: r.start_local, type: r.type, name: r.name, seconds: num(r.duration), avgHr: num(r.avg_hr), maxHr: num(r.max_hr), rpe: num(r.rpe) }));
  }

  localOffsetMinutes(profile: string): number | null {
    const r = this.db.prepare("SELECT start_gmt, start_local FROM activities WHERE profile = ? ORDER BY start_gmt DESC LIMIT 1").get(profile);
    if (!r) return null;
    const at = (s: string) => Date.parse(`${String(s).replace(" ", "T")}Z`);
    const minutes = (at(r.start_local) - at(r.start_gmt)) / 60_000;
    return Number.isFinite(minutes) ? Math.round(minutes / 15) * 15 : null;
  }

  summaries(profile: string, limit = 5000): ActivitySummary[] {
    return this.db
      .prepare(
        `SELECT id, start_local, type, name, distance, duration, avg_hr, workout_id, detail IS NOT NULL AS detailed,
                COALESCE(json_extract(raw, '$.maxHR'), json_extract(detail, '$.summaryDTO.maxHR')) AS max_hr,
                COALESCE(json_extract(raw, '$.averageSpeed'), json_extract(detail, '$.summaryDTO.averageSpeed')) AS speed,
                COALESCE(json_extract(raw, '$.trainingEffectLabel'), json_extract(detail, '$.summaryDTO.trainingEffectLabel')) AS label,
                json_extract(raw, '$.aerobicTrainingEffect') AS aerobic, json_extract(raw, '$.elevationGain') AS elevation,
                ${CALORIES} AS calories,
                json_extract(raw, '$.totalSets') AS sets, json_extract(raw, '$.totalReps') AS reps
         FROM activities WHERE profile = ? ORDER BY start_gmt DESC LIMIT ?`
      )
      .all(profile, limit)
      .map((r) => ({
        id: r.id,
        startLocal: r.start_local,
        type: r.type,
        name: r.name,
        distance: r.distance,
        duration: r.duration,
        avgHr: r.avg_hr,
        maxHr: r.max_hr ?? null,
        speed: r.speed ?? null,
        trainingEffectLabel: r.label ?? null,
        aerobicEffect: r.aerobic ?? null,
        elevationGain: r.elevation ?? null,
        calories: r.calories ?? null,
        sets: r.sets ?? null,
        reps: r.reps ?? null,
        workoutId: r.workout_id,
        detailed: !!r.detailed,
      }));
  }

  get(profile: string, id: string): StoredActivity | undefined {
    const row = this.db.prepare("SELECT * FROM activities WHERE profile = ? AND id = ?").get(profile, id);
    return row && toActivity(row);
  }

  counts(profile: string): ActivityCounts {
    const r = this.db
      .prepare("SELECT COUNT(*) AS total, COUNT(detail) AS with_detail, MAX(start_local) AS newest, MIN(start_local) AS oldest FROM activities WHERE profile = ?")
      .get(profile) as Row;
    const charts = this.db.prepare("SELECT COUNT(*) AS n FROM activity_charts WHERE profile = ? AND data IS NOT NULL").get(profile) as Row;
    return { total: r.total, withDetail: r.with_detail, withChart: charts.n, newest: r.newest ?? null, oldest: r.oldest ?? null };
  }


  state(profile: string): SyncState {
    const r = this.db.prepare("SELECT * FROM activity_sync WHERE profile = ?").get(profile);
    return {
      complete: !!r?.complete,
      nextOffset: r?.next_offset ?? 0,
      holder: r?.holder ?? null,
      leaseUntil: r?.lease_until ?? null,
      error: r?.error ?? null,
      retryAfter: r?.retry_after ?? null,
      updatedAt: r?.updated_at ?? null,
    };
  }

  saveProgress(profile: string, progress: { complete?: boolean; nextOffset?: number; error?: string | null; retryAfter?: number | null }, now = Date.now()): void {
    this.tx(() => {
      this.db.prepare("INSERT OR IGNORE INTO activity_sync (profile) VALUES (?)").run(profile);
      const sets = ["updated_at = ?"], params: unknown[] = [now];
      if (progress.complete !== undefined) { sets.push("complete = ?"); params.push(progress.complete ? 1 : 0); }
      if (progress.nextOffset !== undefined) { sets.push("next_offset = ?"); params.push(progress.nextOffset); }
      if (progress.error !== undefined) { sets.push("error = ?"); params.push(progress.error); }
      if (progress.retryAfter !== undefined) { sets.push("retry_after = ?"); params.push(progress.retryAfter); }
      this.db.prepare(`UPDATE activity_sync SET ${sets.join(", ")} WHERE profile = ?`).run(...params, profile);
    });
  }

  claim(profile: string, holder: string, leaseMs: number, now = Date.now()): boolean {
    return this.tx(() => {
      this.db.prepare("INSERT OR IGNORE INTO activity_sync (profile) VALUES (?)").run(profile);
      const r = this.db.prepare("SELECT holder, lease_until FROM activity_sync WHERE profile = ?").get(profile) as Row;
      if (r.holder && r.holder !== holder && r.lease_until > now) return false;
      this.db.prepare("UPDATE activity_sync SET holder = ?, lease_until = ?, updated_at = ? WHERE profile = ?").run(holder, now + leaseMs, now, profile);
      return true;
    });
  }

  renew(profile: string, holder: string, leaseMs: number, now = Date.now()): boolean {
    return this.tx(() => {
      const r = this.db.prepare("SELECT holder FROM activity_sync WHERE profile = ?").get(profile);
      if (r?.holder !== holder) return false;
      this.db.prepare("UPDATE activity_sync SET lease_until = ?, updated_at = ? WHERE profile = ?").run(now + leaseMs, now, profile);
      return true;
    });
  }

  release(profile: string, holder: string, now = Date.now()): void {
    this.tx(() => this.db.prepare("UPDATE activity_sync SET holder = NULL, lease_until = NULL, updated_at = ? WHERE profile = ? AND holder = ?").run(now, profile, holder));
  }
}
