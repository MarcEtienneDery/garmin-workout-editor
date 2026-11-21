import type { Database } from "./sqliteStore";

export const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS web_sessions (
  id_hash    TEXT PRIMARY KEY,
  admin      INTEGER NOT NULL,
  profile    TEXT,
  bound      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
`;

export interface StoredSession {
  admin: boolean;
  profile: string | null;
  bound: string;
  createdAt: number;
  renewedAt: number;
  expiresAt: number;
}

export class SessionTable {
  constructor(private readonly db: Database) {}

  get(idHash: string): StoredSession | null {
    const r = this.db.prepare("SELECT admin, profile, bound, created_at, renewed_at, expires_at FROM web_sessions WHERE id_hash = ?").get(idHash);
    return r ? { admin: r.admin === 1, profile: r.profile ?? null, bound: r.bound, createdAt: r.created_at, renewedAt: r.renewed_at, expiresAt: r.expires_at } : null;
  }

  create(idHash: string, who: { admin: boolean; profile: string | null }, bound: string, expiresAt: number, now = Date.now()): void {
    this.deleteExpired(now);
    this.db
      .prepare("INSERT INTO web_sessions (id_hash, admin, profile, bound, created_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(idHash, who.admin ? 1 : 0, who.profile, bound, now, now, expiresAt);
  }

  renew(idHash: string, expiresAt: number, now = Date.now()): void {
    this.db.prepare("UPDATE web_sessions SET renewed_at = ?, expires_at = ? WHERE id_hash = ?").run(now, expiresAt, idHash);
  }

  delete(idHash: string): void {
    this.db.prepare("DELETE FROM web_sessions WHERE id_hash = ?").run(idHash);
  }

  deleteExpired(now = Date.now()): void {
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at < ?").run(now);
  }
}
