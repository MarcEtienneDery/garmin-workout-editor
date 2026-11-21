import * as crypto from "crypto";
import type { Database, Row } from "./sqliteStore";

export const INVITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  note       TEXT NOT NULL,
  max_uses   INTEGER NOT NULL,
  uses       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS invite_uses (
  profile TEXT PRIMARY KEY,
  code    TEXT NOT NULL,
  used_at INTEGER NOT NULL
) WITHOUT ROWID;
`;

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 12;
export const MAX_INVITES = 200;
export const MAX_INVITE_USES = 100;
export const MAX_NOTE = 60;

export const normalizeCode = (code: unknown): string => (typeof code === "string" ? code.toUpperCase().replace(/[^A-Z0-9]/g, "") : "");

export const displayCode = (code: string): string => code.replace(/(.{4})(?=.)/g, "$1-");

export function newCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
}

export type InviteProblem = "unknown" | "revoked" | "expired" | "used";

export type InviteStatus = "active" | InviteProblem;

export interface Invite {
  code: string;
  note: string;
  maxUses: number;
  uses: number;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  joined: string[];
  status: Exclude<InviteStatus, "unknown">;
}

function statusOf(r: Row, now: number): Exclude<InviteStatus, "unknown"> {
  if (r.revoked_at != null) return "revoked";
  if (r.expires_at != null && r.expires_at <= now) return "expired";
  if (r.uses >= r.max_uses) return "used";
  return "active";
}

export class InviteTable {
  constructor(
    private readonly db: Database,
    private readonly tx: <T>(fn: () => T) => T
  ) {}

  create(input: { note?: string; maxUses?: number; expiresAt?: number | null }, now = Date.now()): string {
    return this.tx(() => {
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM invites").get()?.n as number;
      if (count >= MAX_INVITES) throw new Error(`There are ${MAX_INVITES} invites already: remove some first.`);
      const code = newCode();
      this.db
        .prepare("INSERT INTO invites (code, note, max_uses, uses, created_at, expires_at, revoked_at) VALUES (?, ?, ?, 0, ?, ?, NULL)")
        .run(code, (input.note ?? "").slice(0, MAX_NOTE), input.maxUses ?? 1, now, input.expiresAt ?? null);
      return code;
    });
  }

  list(now = Date.now()): Invite[] {
    const joined = new Map<string, string[]>();
    for (const r of this.db.prepare("SELECT profile, code FROM invite_uses ORDER BY used_at, profile").all()) joined.set(r.code, [...(joined.get(r.code) ?? []), r.profile]);
    return this.db
      .prepare("SELECT code, note, max_uses, uses, created_at, expires_at, revoked_at FROM invites ORDER BY created_at DESC, code")
      .all()
      .map((r) => ({
        code: r.code,
        note: r.note,
        maxUses: r.max_uses,
        uses: r.uses,
        createdAt: r.created_at,
        expiresAt: r.expires_at ?? null,
        revokedAt: r.revoked_at ?? null,
        joined: joined.get(r.code) ?? [],
        status: statusOf(r, now),
      }));
  }

  check(code: unknown, now = Date.now()): InviteStatus {
    const normal = normalizeCode(code);
    if (!normal) return "unknown";
    const r = this.db.prepare("SELECT max_uses, uses, expires_at, revoked_at FROM invites WHERE code = ?").get(normal);
    return r ? statusOf(r, now) : "unknown";
  }

  use(code: unknown, profile: string, now = Date.now()): void {
    this.tx(() => {
      const status = this.check(code, now);
      if (status !== "active") throw new InviteError(status === "unknown" ? "unknown" : status);
      const normal = normalizeCode(code);
      this.db.prepare("UPDATE invites SET uses = uses + 1 WHERE code = ?").run(normal);
      this.db.prepare("INSERT INTO invite_uses (profile, code, used_at) VALUES (?, ?, ?)").run(profile, normal, now);
    });
  }

  revoke(code: unknown, now = Date.now()): boolean {
    return this.tx(() => {
      const normal = normalizeCode(code);
      const r = this.db.prepare("SELECT 1 AS found FROM invites WHERE code = ?").get(normal);
      if (!r) return false;
      this.db.prepare("UPDATE invites SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL").run(now, normal);
      return true;
    });
  }

  remove(code: unknown): boolean {
    return this.tx(() => {
      const normal = normalizeCode(code);
      const r = this.db.prepare("SELECT 1 AS found FROM invites WHERE code = ?").get(normal);
      if (!r) return false;
      this.db.prepare("DELETE FROM invite_uses WHERE code = ?").run(normal);
      this.db.prepare("DELETE FROM invites WHERE code = ?").run(normal);
      return true;
    });
  }
}

export class InviteError extends Error {
  constructor(readonly problem: InviteProblem) {
    super(
      problem === "expired"
        ? "That invite has expired. Ask for a new one."
        : problem === "used"
          ? "That invite has been used up. Ask for a new one."
          : problem === "revoked"
            ? "That invite was cancelled. Ask for a new one."
            : "That invite code is not valid."
    );
  }
}
