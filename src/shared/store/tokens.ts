/**
 * tokens.ts — the Garmin login tokens of each profile, kept in the database next to everything else.
 *
 * One row per profile: the OAuth tokens the Garmin library hands out (as JSON text), the account they belong to and when
 * they were saved. The MCP server and the web editor, two processes, share the row, so a login by one serves the other.
 * They are not documents: they never appear in the document list, its history or an export.
 */
import type { Database } from "./sqliteStore";

export const TOKEN_SCHEMA = `
CREATE TABLE IF NOT EXISTS garmin_tokens (
  profile  TEXT PRIMARY KEY,
  email    TEXT NOT NULL,
  data     TEXT NOT NULL,
  saved_at INTEGER NOT NULL
) WITHOUT ROWID;
`;

export interface StoredToken {
  email: string;
  /** The tokens as the Garmin library exported them. */
  data: unknown;
  /** Milliseconds since the epoch. */
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
      return null; // a row that is not JSON is as good as none
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
