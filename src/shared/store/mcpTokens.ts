/**
 * mcpTokens.ts — the tokens that let an AI assistant use the MCP server as ONE profile, and nothing else.
 *
 * The server's own MCP_AUTH_TOKEN reaches every profile (it is the admin's). A profile's token, made in its Settings, reaches that profile
 * only: the MCP server runs every tool call with the profile it names (see context.ts). A profile has at most one token; making another
 * replaces it, so the old one stops working at once.
 *
 * Only the SHA-256 of a token is kept (a token is 256 random bits, so a fast hash is enough), so a copy of the database holds nothing that
 * can be used to connect. The token itself is shown once, when it is made. Both processes (the MCP server, which checks tokens, and the web
 * editor, which makes them) read the same table, so a new or removed token applies at once.
 */
import * as crypto from "crypto";
import type { Database } from "./sqliteStore";

export const MCP_TOKEN_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_tokens (
  profile      TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
) WITHOUT ROWID;
`;

/** Every profile token starts with this, so it is told from the admin's and from other secrets at a glance (and by secret scanners). */
export const MCP_TOKEN_PREFIX = "gwm_";
const TOKEN_LENGTH = MCP_TOKEN_PREFIX.length + 64;
/** A token in use is marked at most this often, so a chatty client does not write on every call. */
const TOUCH_EVERY_MS = 5 * 60_000;

const hashOf = (token: string): string => crypto.createHash("sha256").update(token).digest("hex");

/** Whether a string has the shape of a profile token (cheap: junk never reaches the database). */
export const looksLikeMcpToken = (candidate: string): boolean => candidate.length === TOKEN_LENGTH && candidate.startsWith(MCP_TOKEN_PREFIX) && /^[0-9a-f]+$/.test(candidate.slice(MCP_TOKEN_PREFIX.length));

export interface McpTokenInfo {
  createdAt: number;
  /** When it last opened a connection (kept to within a few minutes); null while it has not. */
  lastUsedAt: number | null;
}

export class McpTokenTable {
  constructor(private readonly db: Database) {}

  /** Make the profile's token, replacing the one it had. The token is returned here and kept nowhere. */
  create(profile: string, now = Date.now()): string {
    const token = MCP_TOKEN_PREFIX + crypto.randomBytes(32).toString("hex");
    this.db
      .prepare("INSERT INTO mcp_tokens (profile, token_hash, created_at, last_used_at) VALUES (?, ?, ?, NULL) ON CONFLICT (profile) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, last_used_at = NULL")
      .run(profile, hashOf(token), now);
    return token;
  }

  /** The profile a token belongs to, or null (it was never made, was replaced or was removed). A token that is used is marked as such. */
  profileOf(token: string, now = Date.now()): string | null {
    if (!looksLikeMcpToken(token)) return null;
    const r = this.db.prepare("SELECT profile, last_used_at FROM mcp_tokens WHERE token_hash = ?").get(hashOf(token));
    if (!r) return null;
    if (r.last_used_at == null || now - r.last_used_at >= TOUCH_EVERY_MS) {
      try {
        this.db.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE profile = ?").run(now, r.profile);
      } catch {
        /* the mark is a convenience: a busy database must not turn a good token away */
      }
    }
    return r.profile;
  }

  info(profile: string): McpTokenInfo | null {
    const r = this.db.prepare("SELECT created_at, last_used_at FROM mcp_tokens WHERE profile = ?").get(profile);
    return r ? { createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null } : null;
  }

  /** Whether there was a token to remove. */
  remove(profile: string): boolean {
    const had = this.info(profile) !== null;
    this.db.prepare("DELETE FROM mcp_tokens WHERE profile = ?").run(profile);
    return had;
  }
}
