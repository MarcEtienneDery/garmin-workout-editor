/**
 * credentials.ts — the logins of each profile for the services the app talks to (Garmin Connect, Renpho), kept in the
 * database like the Garmin tokens, so the Settings view can set them and the MCP server and the web editor, two
 * processes, both see a change at once.
 *
 * The password is encrypted when CREDENTIALS_KEY is set (see seal.ts) and kept as given when it is not; it is never sent
 * back to a browser: the Settings view only learns that one is set.
 */
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

  /** The login; throws SealKeyError when its password is encrypted and CREDENTIALS_KEY is missing or wrong. */
  get(profile: string, service: CredentialService): Credential | null {
    const r = this.db.prepare("SELECT email, password, updated_at FROM credentials WHERE profile = ? AND service = ?").get(profile, service);
    if (!r) return null;
    const context = `${profile}|${service}`, password = open(r.password, context);
    // a password saved before there was a key is encrypted the first time it is read with one
    if (sealing() && !isSealed(r.password)) this.db.prepare("UPDATE credentials SET password = ? WHERE profile = ? AND service = ?").run(seal(password, context), profile, service);
    return { email: r.email, password, updatedAt: r.updated_at };
  }

  put(profile: string, service: CredentialService, email: string, password: string, now = Date.now()): void {
    this.db
      .prepare("INSERT INTO credentials (profile, service, email, password, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (profile, service) DO UPDATE SET email = excluded.email, password = excluded.password, updated_at = excluded.updated_at")
      .run(profile, service, email, seal(password, `${profile}|${service}`), now);
  }

  /** How many passwords are stored as plain text, which the Settings view warns about. */
  plainCount(): number {
    return this.db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE password NOT LIKE 'enc1:%'").get()!.n as number;
  }

  delete(profile: string, service: CredentialService): void {
    this.db.prepare("DELETE FROM credentials WHERE profile = ? AND service = ?").run(profile, service);
  }

  /** The profiles that have a login for the service, by name. */
  profiles(service: CredentialService): string[] {
    return this.db.prepare("SELECT profile FROM credentials WHERE service = ? ORDER BY profile").all(service).map((r) => r.profile as string);
  }
}
