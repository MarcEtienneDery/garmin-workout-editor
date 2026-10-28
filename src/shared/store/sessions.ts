/**
 * sessions.ts — the web editor's sign-in sessions, kept in the database so they outlive a restart of the server.
 *
 * One row per session. The browser holds a random id in a cookie; the row is keyed by the SHA-256 of that id, so a copy of the
 * database cannot be used to sign in. `bound` ties the session to the secret it was made with (the profile's password hash, or
 * the admin token), salted with the id hash: when that secret changes the session stops working, and the table never holds a
 * bare hash of the admin token.
 */
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
  /** The profile of a profile sign-in; null for the admin. */
  profile: string | null;
  bound: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  renewedAt: number;
  expiresAt: number;
}

export class SessionTable {
  constructor(private readonly db: Database) {}

  /** The session, or null when there is none (an expired one is returned too: the caller decides, and deletes it). */
  get(idHash: string): StoredSession | null {
    const r = this.db.prepare("SELECT admin, profile, bound, created_at, renewed_at, expires_at FROM web_sessions WHERE id_hash = ?").get(idHash);
    return r ? { admin: r.admin === 1, profile: r.profile ?? null, bound: r.bound, createdAt: r.created_at, renewedAt: r.renewed_at, expiresAt: r.expires_at } : null;
  }

  /** A new session; the ones that already expired are dropped at the same time. */
  create(idHash: string, who: { admin: boolean; profile: string | null }, bound: string, expiresAt: number, now = Date.now()): void {
    this.deleteExpired(now);
    this.db
      .prepare("INSERT INTO web_sessions (id_hash, admin, profile, bound, created_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(idHash, who.admin ? 1 : 0, who.profile, bound, now, now, expiresAt);
  }

  /** The session was used: it now lasts until `expiresAt`. */
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
