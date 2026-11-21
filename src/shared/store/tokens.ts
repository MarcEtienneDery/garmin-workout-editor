import type { Database } from "./sqliteStore";

export const TOKEN_SCHEMA = `
CREATE TABLE IF NOT EXISTS garmin_tokens (
  profile  TEXT PRIMARY KEY,
  email    TEXT NOT NULL,
  data     TEXT NOT NULL,
  saved_at INTEGER NOT NULL
) WITHOUT ROWID;
`;

export const LIMIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS garmin_limits (
  profile TEXT PRIMARY KEY,
  since   INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  count   INTEGER NOT NULL
) WITHOUT ROWID;
`;

export interface StoredToken {
  email: string;
  data: unknown;
  savedAt: number;
}

export class TokenTable {
  constructor(private readonly db: Database) {}

  get(profile: string): StoredToken | null {
    const r = this.db.prepare("SELECT email, data, saved_at FROM garmin_tokens WHERE profile = ?").get(profile) as { email: string; data: string; saved_at: number } | undefined;
    if (!r) return null;
    try {
      return { email: r.email, data: JSON.parse(r.data), savedAt: r.saved_at };
    } catch {
      return null;
    }
  }

  put(profile: string, email: string, data: unknown, now = Date.now()): void {
    this.db
      .prepare("INSERT INTO garmin_tokens (profile, email, data, saved_at) VALUES (?, ?, ?, ?) ON CONFLICT (profile) DO UPDATE SET email = excluded.email, data = excluded.data, saved_at = excluded.saved_at")
      .run(profile, email, JSON.stringify(data), now);
  }

  delete(profile: string): void {
    this.db.prepare("DELETE FROM garmin_tokens WHERE profile = ?").run(profile);
  }
}

export interface GarminLimit {
  since: number;
  lastAt: number;
  count: number;
}

export class LimitTable {
  constructor(private readonly db: Database) {}

  get(profile: string): GarminLimit | null {
    const r = this.db.prepare("SELECT since, last_at, count FROM garmin_limits WHERE profile = ?").get(profile) as { since: number; last_at: number; count: number } | undefined;
    return r ? { since: r.since, lastAt: r.last_at, count: r.count } : null;
  }

  record(profile: string, now = Date.now()): void {
    this.db
      .prepare("INSERT INTO garmin_limits (profile, since, last_at, count) VALUES (?, ?, ?, 1) ON CONFLICT (profile) DO UPDATE SET last_at = excluded.last_at, count = count + 1")
      .run(profile, now, now);
  }

  clear(profile: string): void {
    this.db.prepare("DELETE FROM garmin_limits WHERE profile = ?").run(profile);
  }
}
