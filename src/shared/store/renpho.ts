/**
 * renpho.ts — the Renpho scale sync of each profile: its settings, every weigh-in as Renpho sent it, who is syncing and
 * how the last run went, and a short log of what happened for the Settings view to show.
 *
 * `renpho_measurements` is a ledger: one row per weigh-in, the JSON exactly as Renpho gave it (`data`), when it was
 * uploaded to Garmin (`pushed_at`; null until then) and why an upload failed. A weigh-in is uploaded once and never again.
 * The login is in `credentials` (service "renpho"), not here.
 */
import type { Database } from "./sqliteStore";

export const RENPHO_SCHEMA = `
CREATE TABLE IF NOT EXISTS renpho_settings (
  profile        TEXT PRIMARY KEY,
  area_code      TEXT NOT NULL DEFAULT 'US',
  fetch_enabled  INTEGER NOT NULL DEFAULT 0,
  push_enabled   INTEGER NOT NULL DEFAULT 0,
  push_since     TEXT,
  interval_hours INTEGER NOT NULL DEFAULT 3
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS renpho_measurements (
  profile     TEXT NOT NULL,
  measure_id  TEXT NOT NULL,
  measured_at INTEGER NOT NULL,
  day         TEXT NOT NULL,
  data        TEXT NOT NULL,
  pushed_at   INTEGER,
  push_error  TEXT,
  reread_at   INTEGER,
  PRIMARY KEY (profile, measure_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS renpho_by_time ON renpho_measurements (profile, measured_at);
CREATE TABLE IF NOT EXISTS renpho_sync (
  profile     TEXT PRIMARY KEY,
  holder      TEXT,
  lease_until INTEGER,
  last_run_at INTEGER,
  last_ok_at  INTEGER,
  next_run_at INTEGER,
  error       TEXT,
  error_kind  TEXT,
  updated_at  INTEGER
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS renpho_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  profile TEXT NOT NULL,
  at      INTEGER NOT NULL,
  level   TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS renpho_log_by_profile ON renpho_log (profile, id);
`;

/** Log lines kept per profile. */
export const KEEP_LOG = 200;
/** The hours between two runs the Settings view offers. */
export const INTERVAL_HOURS = [1, 3, 6, 12, 24] as const;

export interface RenphoSettings {
  areaCode: string;
  fetchEnabled: boolean;
  pushEnabled: boolean;
  /** Weigh-ins before this day (YYYY-MM-DD) are never uploaded. */
  pushSince: string | null;
  intervalHours: number;
}

export const DEFAULT_SETTINGS: RenphoSettings = { areaCode: "US", fetchEnabled: false, pushEnabled: false, pushSince: null, intervalHours: 3 };

export interface RenphoState {
  holder: string | null;
  leaseUntil: number | null;
  lastRunAt: number | null;
  lastOkAt: number | null;
  nextRunAt: number | null;
  error: string | null;
  /** "login" when Renpho refused the login (never retried until the login is saved or tested again), "other" for anything else. */
  errorKind: "login" | "other" | null;
}

export interface Measurement {
  id: string;
  measuredAt: number;
  day: string;
  /** Renpho's weigh-in as it came. */
  data: Record<string, unknown>;
  pushedAt: number | null;
  pushError: string | null;
}

export interface MeasurementCounts {
  total: number;
  pending: number;
  pushed: number;
  failed: number;
  oldest: number | null;
  newest: number | null;
}

export interface LogLine {
  id: number;
  at: number;
  level: "info" | "warn" | "error";
  message: string;
}

const toMeasurement = (r: any): Measurement => ({ id: r.measure_id, measuredAt: r.measured_at, day: r.day, data: JSON.parse(r.data), pushedAt: r.pushed_at ?? null, pushError: r.push_error ?? null });

export class RenphoTable {
  constructor(
    private readonly db: Database,
    private readonly tx: <T>(fn: () => T) => T
  ) {}

  // ── Settings ──

  settings(profile: string): RenphoSettings {
    const r = this.db.prepare("SELECT * FROM renpho_settings WHERE profile = ?").get(profile);
    return r ? { areaCode: r.area_code, fetchEnabled: !!r.fetch_enabled, pushEnabled: !!r.push_enabled, pushSince: r.push_since ?? null, intervalHours: r.interval_hours } : { ...DEFAULT_SETTINGS };
  }

  saveSettings(profile: string, change: Partial<RenphoSettings>): RenphoSettings {
    return this.tx(() => {
      const next = { ...this.settings(profile), ...change };
      this.db
        .prepare("INSERT INTO renpho_settings (profile, area_code, fetch_enabled, push_enabled, push_since, interval_hours) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (profile) DO UPDATE SET area_code = excluded.area_code, fetch_enabled = excluded.fetch_enabled, push_enabled = excluded.push_enabled, push_since = excluded.push_since, interval_hours = excluded.interval_hours")
        .run(profile, next.areaCode, next.fetchEnabled ? 1 : 0, next.pushEnabled ? 1 : 0, next.pushSince, next.intervalHours);
      return next;
    });
  }

  /** The profiles whose fetch is switched on. */
  enabledProfiles(): string[] {
    return this.db.prepare("SELECT profile FROM renpho_settings WHERE fetch_enabled = 1 ORDER BY profile").all().map((r) => r.profile as string);
  }

  // ── Weigh-ins ──

  /** Keep a weigh-in the ledger does not have yet; false when it is there already (what is there is left as it is). */
  addMeasurement(profile: string, m: { id: string; measuredAt: number; day: string; data: unknown }): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO renpho_measurements (profile, measure_id, measured_at, day, data) VALUES (?, ?, ?, ?, ?)").run(profile, m.id, m.measuredAt, m.day, JSON.stringify(m.data)) as { changes: number | bigint };
    return Number(r.changes) > 0;
  }

  /** The weigh-ins newest first (`limit`), or oldest first from `since` when given, optionally only those not uploaded. */
  measurements(profile: string, options: { limit?: number; pending?: boolean; sinceDay?: string } = {}): Measurement[] {
    const where = ["profile = ?"], params: unknown[] = [profile];
    if (options.pending) where.push("pushed_at IS NULL");
    if (options.sinceDay) { where.push("day >= ?"); params.push(options.sinceDay); }
    const order = options.pending ? "ASC" : "DESC";
    const limit = options.limit ? ` LIMIT ${Math.max(1, Math.floor(options.limit))}` : "";
    return this.db.prepare(`SELECT * FROM renpho_measurements WHERE ${where.join(" AND ")} ORDER BY measured_at ${order}${limit}`).all(...params).map(toMeasurement);
  }

  counts(profile: string): MeasurementCounts {
    const r = this.db
      .prepare("SELECT COUNT(*) AS total, SUM(pushed_at IS NULL) AS pending, SUM(pushed_at IS NOT NULL) AS pushed, SUM(pushed_at IS NULL AND push_error IS NOT NULL) AS failed, MIN(measured_at) AS oldest, MAX(measured_at) AS newest FROM renpho_measurements WHERE profile = ?")
      .get(profile) as any;
    return { total: r.total ?? 0, pending: r.pending ?? 0, pushed: r.pushed ?? 0, failed: r.failed ?? 0, oldest: r.oldest ?? null, newest: r.newest ?? null };
  }

  markPushed(profile: string, ids: string[], now = Date.now()): void {
    this.tx(() => {
      const stmt = this.db.prepare("UPDATE renpho_measurements SET pushed_at = ?, push_error = NULL WHERE profile = ? AND measure_id = ?");
      for (const id of ids) stmt.run(now, profile, id);
    });
  }

  markFailed(profile: string, ids: string[], error: string): void {
    this.tx(() => {
      const stmt = this.db.prepare("UPDATE renpho_measurements SET push_error = ? WHERE profile = ? AND measure_id = ? AND pushed_at IS NULL");
      for (const id of ids) stmt.run(error, profile, id);
    });
  }

  /** The days of weigh-ins uploaded before `before` whose Garmin weigh-in has not been read again since: Garmin has had the time to take the file in. */
  daysToReread(profile: string, before: number): { days: string[]; ids: string[] } {
    const rows = this.db.prepare("SELECT measure_id, day FROM renpho_measurements WHERE profile = ? AND pushed_at IS NOT NULL AND pushed_at <= ? AND reread_at IS NULL").all(profile, before);
    return { days: [...new Set(rows.map((r) => r.day as string))].sort(), ids: rows.map((r) => r.measure_id as string) };
  }

  markReread(profile: string, ids: string[], now = Date.now()): void {
    this.tx(() => {
      const stmt = this.db.prepare("UPDATE renpho_measurements SET reread_at = ? WHERE profile = ? AND measure_id = ?");
      for (const id of ids) stmt.run(now, profile, id);
    });
  }

  /** Forget every weigh-in of the profile (the ledger only; nothing on Garmin changes). */
  clearMeasurements(profile: string): void {
    this.db.prepare("DELETE FROM renpho_measurements WHERE profile = ?").run(profile);
  }

  // ── The sync's state and lease ──

  state(profile: string): RenphoState {
    const r = this.db.prepare("SELECT * FROM renpho_sync WHERE profile = ?").get(profile);
    return { holder: r?.holder ?? null, leaseUntil: r?.lease_until ?? null, lastRunAt: r?.last_run_at ?? null, lastOkAt: r?.last_ok_at ?? null, nextRunAt: r?.next_run_at ?? null, error: r?.error ?? null, errorKind: r?.error_kind ?? null };
  }

  saveState(profile: string, change: Partial<Pick<RenphoState, "lastRunAt" | "lastOkAt" | "nextRunAt" | "error" | "errorKind">>, now = Date.now()): void {
    const columns = { lastRunAt: "last_run_at", lastOkAt: "last_ok_at", nextRunAt: "next_run_at", error: "error", errorKind: "error_kind" } as const;
    this.tx(() => {
      this.db.prepare("INSERT OR IGNORE INTO renpho_sync (profile) VALUES (?)").run(profile);
      const sets = ["updated_at = ?"], params: unknown[] = [now];
      for (const [key, column] of Object.entries(columns)) {
        const value = (change as Record<string, unknown>)[key];
        if (value !== undefined) { sets.push(`${column} = ?`); params.push(value); }
      }
      this.db.prepare(`UPDATE renpho_sync SET ${sets.join(", ")} WHERE profile = ?`).run(...params, profile);
    });
  }

  /** Become the one that syncs this profile. False while another holder's lease runs; a lease that ran out is taken over. */
  claim(profile: string, holder: string, leaseMs: number, now = Date.now()): boolean {
    return this.tx(() => {
      this.db.prepare("INSERT OR IGNORE INTO renpho_sync (profile) VALUES (?)").run(profile);
      const r = this.db.prepare("SELECT holder, lease_until FROM renpho_sync WHERE profile = ?").get(profile) as { holder: string | null; lease_until: number | null };
      if (r.holder && r.holder !== holder && (r.lease_until ?? 0) > now) return false;
      this.db.prepare("UPDATE renpho_sync SET holder = ?, lease_until = ?, updated_at = ? WHERE profile = ?").run(holder, now + leaseMs, now, profile);
      return true;
    });
  }

  release(profile: string, holder: string, now = Date.now()): void {
    this.tx(() => this.db.prepare("UPDATE renpho_sync SET holder = NULL, lease_until = NULL, updated_at = ? WHERE profile = ? AND holder = ?").run(now, profile, holder));
  }

  // ── The log ──

  log(profile: string, level: LogLine["level"], message: string, now = Date.now()): void {
    this.tx(() => {
      this.db.prepare("INSERT INTO renpho_log (profile, at, level, message) VALUES (?, ?, ?, ?)").run(profile, now, level, message.slice(0, 500));
      this.db.prepare("DELETE FROM renpho_log WHERE profile = ? AND id <= (SELECT id FROM renpho_log WHERE profile = ? ORDER BY id DESC LIMIT 1 OFFSET ?)").run(profile, profile, KEEP_LOG);
    });
  }

  /** The log, newest first. */
  logLines(profile: string, limit = 50): LogLine[] {
    return this.db.prepare("SELECT id, at, level, message FROM renpho_log WHERE profile = ? ORDER BY id DESC LIMIT ?").all(profile, limit).map((r) => ({ id: r.id, at: r.at, level: r.level, message: r.message }));
  }

  /** Forget the profile's log. */
  clearLog(profile: string): void {
    this.db.prepare("DELETE FROM renpho_log WHERE profile = ?").run(profile);
  }
}
