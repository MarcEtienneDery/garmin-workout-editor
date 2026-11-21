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

export const MCP_TOKEN_PREFIX = "gwm_";
const TOKEN_LENGTH = MCP_TOKEN_PREFIX.length + 64;
const TOUCH_EVERY_MS = 5 * 60_000;

const hashOf = (token: string): string => crypto.createHash("sha256").update(token).digest("hex");

export const looksLikeMcpToken = (candidate: string): boolean => candidate.length === TOKEN_LENGTH && candidate.startsWith(MCP_TOKEN_PREFIX) && /^[0-9a-f]+$/.test(candidate.slice(MCP_TOKEN_PREFIX.length));

export interface McpTokenInfo {
  createdAt: number;
  lastUsedAt: number | null;
}

export class McpTokenTable {
  constructor(private readonly db: Database) {}

  create(profile: string, now = Date.now()): string {
    const token = MCP_TOKEN_PREFIX + crypto.randomBytes(32).toString("hex");
    this.db
      .prepare("INSERT INTO mcp_tokens (profile, token_hash, created_at, last_used_at) VALUES (?, ?, ?, NULL) ON CONFLICT (profile) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, last_used_at = NULL")
      .run(profile, hashOf(token), now);
    return token;
  }

  profileOf(token: string, now = Date.now()): string | null {
    if (!looksLikeMcpToken(token)) return null;
    const r = this.db.prepare("SELECT profile, last_used_at FROM mcp_tokens WHERE token_hash = ?").get(hashOf(token));
    if (!r) return null;
    if (r.last_used_at == null || now - r.last_used_at >= TOUCH_EVERY_MS) {
      try {
        this.db.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE profile = ?").run(now, r.profile);
      } catch {
      }
    }
    return r.profile;
  }

  info(profile: string): McpTokenInfo | null {
    const r = this.db.prepare("SELECT created_at, last_used_at FROM mcp_tokens WHERE profile = ?").get(profile);
    return r ? { createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null } : null;
  }

  remove(profile: string): boolean {
    const had = this.info(profile) !== null;
    this.db.prepare("DELETE FROM mcp_tokens WHERE profile = ?").run(profile);
    return had;
  }
}
