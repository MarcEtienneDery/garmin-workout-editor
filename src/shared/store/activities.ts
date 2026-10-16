import type { Database } from "./sqliteStore";

/**
 * The Garmin activities of each profile, one row per activity, kept in the same database as the documents.
 *
 * An activity is written once and rarely changes on Garmin, so a row is never refetched to refresh it. It keeps
 * Garmin's list item as it came (`raw`) and, once fetched, the activity's details (`detail`: the activity itself and
 * its exercise sets), so the slim format can be rebuilt from them later without asking Garmin again. The columns are
 * only what the views filter and sort by.
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
CREATE TABLE IF NOT EXISTS activity_sync (
  profile      TEXT PRIMARY KEY,
  complete     INTEGER NOT NULL DEFAULT 0,
  next_offset  INTEGER NOT NULL DEFAULT 0,
  holder       TEXT,
  lease_until  INTEGER,
  error        TEXT,
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

export interface SyncState {
  complete: boolean;
  /** Where an unfinished listing resumes. */
  nextOffset: number;
  /** Who holds the lease, and until when (ms). */
  holder: string | null;
  leaseUntil: number | null;
  /** Why the last sync stopped early, if it did. */
  error: string | null;
  updatedAt: number | null;
}

export interface ActivityCounts {
  total: number;
  withDetail: number;
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

  /** Keep an activity's details (and when they were fetched), clearing any failures. */
  setDetail(profile: string, id: string, detail: unknown, now = Date.now()): void {
    this.tx(() => this.db.prepare("UPDATE activities SET detail = ?, detail_at = ?, detail_failed = 0 WHERE profile = ? AND id = ?").run(JSON.stringify(detail), now, profile, id));
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

  get(profile: string, id: string): StoredActivity | undefined {
    const row = this.db.prepare("SELECT * FROM activities WHERE profile = ? AND id = ?").get(profile, id);
    return row && toActivity(row);
  }

  counts(profile: string): ActivityCounts {
    const r = this.db
      .prepare("SELECT COUNT(*) AS total, COUNT(detail) AS with_detail, MAX(start_local) AS newest, MIN(start_local) AS oldest FROM activities WHERE profile = ?")
      .get(profile) as Row;
    return { total: r.total, withDetail: r.with_detail, newest: r.newest ?? null, oldest: r.oldest ?? null };
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
      updatedAt: r?.updated_at ?? null,
    };
  }

  /** Record progress: whether the whole history is listed, where a listing resumes, and why a sync stopped. */
  saveProgress(profile: string, progress: { complete?: boolean; nextOffset?: number; error?: string | null }, now = Date.now()): void {
    this.tx(() => {
      this.db.prepare("INSERT OR IGNORE INTO activity_sync (profile) VALUES (?)").run(profile);
      const sets = ["updated_at = ?"], params: unknown[] = [now];
      if (progress.complete !== undefined) { sets.push("complete = ?"); params.push(progress.complete ? 1 : 0); }
      if (progress.nextOffset !== undefined) { sets.push("next_offset = ?"); params.push(progress.nextOffset); }
      if (progress.error !== undefined) { sets.push("error = ?"); params.push(progress.error); }
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
