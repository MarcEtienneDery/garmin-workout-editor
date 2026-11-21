import { open, seal, isSealed, sealing } from "./seal";
import type { Database } from "./sqliteStore";

export const CREDENTIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS credentials (
  profile    TEXT NOT NULL,
  service    TEXT NOT NULL,
  email      TEXT NOT NULL,
  password   TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile, service)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS login_checks (
  profile    TEXT NOT NULL,
  service    TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  message    TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (profile, service)
) WITHOUT ROWID;
`;

export const CREDENTIAL_SERVICES = ["garmin", "renpho"] as const;
export type CredentialService = (typeof CREDENTIAL_SERVICES)[number];

export interface Credential {
  email: string;
  password: string;
  updatedAt: number;
}

export class CredentialTable {
  constructor(private readonly db: Database) {}

  get(profile: string, service: CredentialService): Credential | null {
    const r = this.db.prepare("SELECT email, password, updated_at FROM credentials WHERE profile = ? AND service = ?").get(profile, service);
    if (!r) return null;
    const context = `${profile}|${service}`, password = open(r.password, context);
    if (sealing() && !isSealed(r.password)) this.db.prepare("UPDATE credentials SET password = ? WHERE profile = ? AND service = ?").run(seal(password, context), profile, service);
    return { email: r.email, password, updatedAt: r.updated_at };
  }

  recordCheck(profile: string, service: CredentialService, ok: boolean, message: string, now = Date.now()): void {
    this.db
      .prepare("INSERT INTO login_checks (profile, service, ok, message, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (profile, service) DO UPDATE SET ok = excluded.ok, message = excluded.message, checked_at = excluded.checked_at")
      .run(profile, service, ok ? 1 : 0, message.slice(0, 500), now);
  }

  lastCheck(profile: string, service: CredentialService): { ok: boolean; message: string; at: number } | null {
    const r = this.db.prepare("SELECT ok, message, checked_at FROM login_checks WHERE profile = ? AND service = ?").get(profile, service);
    return r ? { ok: r.ok === 1, message: r.message as string, at: r.checked_at as number } : null;
  }

  put(profile: string, service: CredentialService, email: string, password: string, now = Date.now()): void {
    this.db.prepare("DELETE FROM login_checks WHERE profile = ? AND service = ?").run(profile, service);
    this.db
      .prepare("INSERT INTO credentials (profile, service, email, password, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (profile, service) DO UPDATE SET email = excluded.email, password = excluded.password, updated_at = excluded.updated_at")
      .run(profile, service, email, seal(password, `${profile}|${service}`), now);
  }

  plainCount(): number {
    return this.db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE password NOT LIKE 'enc1:%'").get()!.n as number;
  }

  plainWarning(): string | null {
    const plain = this.plainCount();
    return plain > 0 && !sealing() ? `CREDENTIALS_KEY is not set: ${plain} saved Garmin/Renpho password${plain === 1 ? " is" : "s are"} stored as plain text in the database. Set it on every service that shares the database.` : null;
  }

  delete(profile: string, service: CredentialService): void {
    this.db.prepare("DELETE FROM credentials WHERE profile = ? AND service = ?").run(profile, service);
    this.db.prepare("DELETE FROM login_checks WHERE profile = ? AND service = ?").run(profile, service);
  }

  profiles(service: CredentialService): string[] {
    return this.db.prepare("SELECT profile FROM credentials WHERE service = ? ORDER BY profile").all(service).map((r) => r.profile as string);
  }
}
