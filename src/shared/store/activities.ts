import type { Database } from "./sqliteStore";

/**
 * The Garmin activities of each profile, one row per activity, kept in the same database as the documents.
 *
 * An activity is written once and rarely changes on Garmin, so a row is never refetched to refresh it. It keeps
 * Garmin's list item as it came (`raw`) and, once fetched, the activity's details (`detail`: the activity itself and
 * its exercise sets), so the slim format can be rebuilt from them later without asking Garmin again. The columns are
 * only what the views filter and sort by.
 *
 * An activity's chart data (the time series, the route, the laps and the heart-rate zones Garmin keeps apart from the
 * activity) lives in `activity_charts`, in the shape Garmin sent it, pruned and decimated to a few hundred samples: the
 * charts are drawn from it when read, so a change to how they are read never needs Garmin again. A row without data only
 * counts the failures.
 *
 * Next to the rows, one `activity_sync` row per profile remembers how far the listing got (`complete`, `next_offset`)
 * and who is syncing (a lease), because the MCP server and the web editor are two processes with two Garmin sessions.
 */
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

/** A young activity's details are fetched again no sooner than this after the last time. */
export const REFRESH_YOUNG_MS = 6 * 3_600_000;

/** How many times an activity's details may fail before it is left alone (a deleted activity answers 404 forever). */
export const MAX_DETAIL_FAILURES = 3;

/** A new activity, as the sync builds it from Garmin's list item. */
export interface NewActivity {
  id: string;
  /** "YYYY-MM-DD HH:MM:SS", UTC and local time of the start. */
  startGmt: string;
  startLocal: string;
  /** running, strength_training, cycling, swimming or other. */
  type: string;
  name: string;
  duration: number | null;
  /** Meters, as Garmin lists it. */
  distance: number | null;
  avgHr: number | null;
  workoutId: string | null;
  raw: unknown;
}

export interface StoredActivity extends Omit<NewActivity, "raw"> {
  raw: any;
  /** The activity's details and exercise sets; null until fetched. */
  detail: any | null;
  detailAt: number | null;
  syncedAt: number;
}

/** One activity's columns and the few list-item fields the lifetime stats add up. */
export interface LifetimeRow {
  id: string;
  startLocal: string;
  type: string;
  name: string;
  distance: number | null;
  duration: number | null;
  /** Climb in meters, calories, VO2max and, for strength, the sets and reps, as the list item has them. */
  gain: number | null;
  calories: number | null;
  vo2: number | null;
  sets: number | null;
  reps: number | null;
}

/** A strength session with its details, for the exercise stats. */
export interface StrengthRow {
  id: string;
  startLocal: string;
  raw: any;
  detail: any;
}

/** What a list shows of an activity: columns and a few fields of the list item, read in SQL so the 15-20 KB of raw JSON is not parsed in node. */
export interface ActivitySummary {
  id: string;
  startLocal: string;
  type: string;
  name: string;
  /** Meters and seconds, as Garmin lists them. */
  distance: number | null;
  duration: number | null;
  avgHr: number | null;
  maxHr: number | null;
  /** Average speed in m/s. */
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
  /** Where an unfinished listing resumes. */
  nextOffset: number;
  /** Who holds the lease, and until when (ms). */
  holder: string | null;
  leaseUntil: number | null;
  /** Why the last sync stopped early, if it did. */
  error: string | null;
  /** A background sync does not start again before this instant (ms), after it stopped on an error. */
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

/** The instant an activity started, from its "YYYY-MM-DD HH:MM:SS" GMT string. */
export const startMs = (startGmt: string): number => Date.parse(startGmt.replace(" ", "T") + "Z");

export class ActivityTable {
  constructor(
    private readonly db: Database,
    private readonly tx: <T>(fn: () => T) => T
  ) {}

  /** Store the activities that are not stored yet and leave the others as they are. Returns how many were new. */
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

  /** Which of these ids are stored already. */
  known(profile: string, ids: string[]): Set<string> {
    const found = new Set<string>();
    const select = this.db.prepare("SELECT 1 AS yes FROM activities WHERE profile = ? AND id = ?");
    for (const id of ids) if (select.get(profile, id)) found.add(id);
    return found;
  }

  /**
   * Keep an activity's details (and when they were fetched), clearing any failures. A list item may lack the workout
   * the activity came from; the details carry it as metadataDTO.associatedWorkoutId, so the column is filled from there.
   */
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

  /** The details of this activity could not be fetched; after MAX_DETAIL_FAILURES it is no longer tried. */
  noteDetailFailure(profile: string, id: string): void {
    this.tx(() => this.db.prepare("UPDATE activities SET detail_failed = detail_failed + 1 WHERE profile = ? AND id = ?").run(profile, id));
  }

  /**
   * The activities whose details are missing, newest first, plus those whose details were fetched less than
   * `settleMs` after they started and at least `refreshMs` ago: RPE and feel are often entered after the workout,
   * so those may still change. Once fetched after `settleMs`, details are final.
   */
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

  /** The stored activities that started between two instants ("YYYY-MM-DD HH:MM:SS" GMT, either may be left out), newest first. */
  between(profile: string, options: { from?: string; to?: string; type?: string; limit?: number } = {}): StoredActivity[] {
    const where = ["profile = ?"], params: unknown[] = [profile];
    if (options.from) { where.push("start_gmt >= ?"); params.push(options.from); }
    if (options.to) { where.push("start_gmt <= ?"); params.push(options.to); }
    if (options.type) { where.push("type = ?"); params.push(options.type); }
    params.push(options.limit ?? 1_000_000);
    return this.db.prepare(`SELECT * FROM activities WHERE ${where.join(" AND ")} ORDER BY start_gmt DESC LIMIT ?`).all(...params).map(toActivity);
  }

  // ── Chart data ──

  /** Keep an activity's chart data, as Garmin sent it (pruned). An empty answer is stored too: it is an answer. */
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

  /** Garmin refused this activity's chart data for a reason other than a rate limit; after MAX_DETAIL_FAILURES it is left alone. */
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

  /** The activities that have no chart data yet, newest first. */
  needingChart(profile: string, options: { limit?: number; ids?: string[] } = {}): { id: string; startGmt: string; type: string }[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.start_gmt, a.type FROM activities a
         LEFT JOIN activity_charts c ON c.profile = a.profile AND c.id = a.id
         WHERE a.profile = ? AND c.data IS NULL AND COALESCE(c.failed, 0) < ? ORDER BY a.start_gmt DESC LIMIT ?`
      )
      .all(profile, MAX_DETAIL_FAILURES, options.limit ?? 1_000_000);
    const wanted = options.ids ? new Set(options.ids) : null;
    return rows.filter((r) => !wanted || wanted.has(r.id)).map((r) => ({ id: r.id, startGmt: r.start_gmt, type: r.type }));
  }

  // ── For the lifetime stats ──

  /**
   * A short string that changes whenever an activity is added or gets its details (or a young one's details are fetched
   * again), so a cached answer can be kept for exactly as long as the table stays the same.
   */
  fingerprint(profile: string): string {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n, COUNT(detail) AS d, COALESCE(MAX(synced_at), 0) AS s, COALESCE(MAX(detail_at), 0) AS t FROM activities WHERE profile = ?")
      .get(profile) as Row;
    return `${r.n}:${r.d}:${r.s}:${r.t}`;
  }

  /** Every activity's columns and list-item fields, oldest first; the raw JSON is read in SQL, not parsed here. */
  lifetimeRows(profile: string): LifetimeRow[] {
    return this.db
      .prepare(
        `SELECT id, start_local, type, name, distance, duration,
                json_extract(raw, '$.elevationGain') AS gain, json_extract(raw, '$.calories') AS calories,
                json_extract(raw, '$.vO2MaxValue') AS vo2, json_extract(raw, '$.totalSets') AS sets, json_extract(raw, '$.totalReps') AS reps
         FROM activities WHERE profile = ? ORDER BY start_local`
      )
      .all(profile)
      .map((r) => ({
        id: r.id, startLocal: r.start_local, type: r.type, name: r.name, distance: r.distance ?? null, duration: r.duration ?? null,
        gain: typeof r.gain === "number" ? r.gain : null, calories: typeof r.calories === "number" ? r.calories : null,
        vo2: typeof r.vo2 === "number" ? r.vo2 : null, sets: typeof r.sets === "number" ? r.sets : null, reps: typeof r.reps === "number" ? r.reps : null,
      }));
  }

  /** The fastest split the watch timed inside each activity (`fastestSplit_<meters>` in the list item), as distance and seconds. */
  fastestSplits(profile: string): { id: string; meters: number; seconds: number }[] {
    return this.db
      .prepare("SELECT a.id AS id, j.key AS key, j.value AS value FROM activities a, json_each(a.raw) j WHERE a.profile = ? AND j.key GLOB 'fastestSplit_[0-9]*'")
      .all(profile)
      .flatMap((r) => {
        const meters = Number(String(r.key).slice("fastestSplit_".length)), seconds = typeof r.value === "number" ? r.value : NaN;
        return Number.isFinite(meters) && meters > 0 && Number.isFinite(seconds) && seconds > 0 ? [{ id: r.id as string, meters, seconds }] : [];
      });
  }

  /** The strength sessions whose details are stored, oldest first. */
  strengthRows(profile: string): StrengthRow[] {
    return this.db
      .prepare("SELECT id, start_local, raw, detail FROM activities WHERE profile = ? AND type = 'strength_training' AND detail IS NOT NULL ORDER BY start_local")
      .all(profile)
      .map((r) => ({ id: r.id as string, startLocal: r.start_local as string, raw: JSON.parse(r.raw as string), detail: JSON.parse(r.detail as string) }));
  }

  /** The newest activities as list rows, newest first. */
  summaries(profile: string, limit = 5000): ActivitySummary[] {
    return this.db
      .prepare(
        `SELECT id, start_local, type, name, distance, duration, avg_hr, workout_id, detail IS NOT NULL AS detailed,
                COALESCE(json_extract(raw, '$.maxHR'), json_extract(detail, '$.summaryDTO.maxHR')) AS max_hr,
                COALESCE(json_extract(raw, '$.averageSpeed'), json_extract(detail, '$.summaryDTO.averageSpeed')) AS speed,
                COALESCE(json_extract(raw, '$.trainingEffectLabel'), json_extract(detail, '$.summaryDTO.trainingEffectLabel')) AS label,
                json_extract(raw, '$.aerobicTrainingEffect') AS aerobic, json_extract(raw, '$.elevationGain') AS elevation,
                COALESCE(json_extract(raw, '$.calories'), json_extract(detail, '$.summaryDTO.calories')) AS calories,
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

  // ── Where the sync stands, and who is running it ──

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

  /** Record progress: whether the whole history is listed, where a listing resumes, why a sync stopped and when it may try again. */
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

  /** Become the one that syncs this profile. False while another holder's lease runs; a lease that ran out is taken over. */
  claim(profile: string, holder: string, leaseMs: number, now = Date.now()): boolean {
    return this.tx(() => {
      this.db.prepare("INSERT OR IGNORE INTO activity_sync (profile) VALUES (?)").run(profile);
      const r = this.db.prepare("SELECT holder, lease_until FROM activity_sync WHERE profile = ?").get(profile) as Row;
      if (r.holder && r.holder !== holder && r.lease_until > now) return false;
      this.db.prepare("UPDATE activity_sync SET holder = ?, lease_until = ?, updated_at = ? WHERE profile = ?").run(holder, now + leaseMs, now, profile);
      return true;
    });
  }

  /** Extend the lease; false when it was lost (it ran out and another holder took over). */
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
