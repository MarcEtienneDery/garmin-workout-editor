/**
 * profiles.ts — the profiles that exist: one per person the app keeps plans, food and (when they connect them) Garmin and
 * Renpho data for. A profile is a name; nothing about it needs a Garmin login, and the logins, when there are any, are in
 * `credentials`. The only secret a profile row holds is the hash of the password of its own sign-in to the web editor.
 *
 * A database made before this table existed has its profiles taken from the names its other tables already hold, once.
 */
import * as crypto from "crypto";
import { promisify } from "util";
import { MAX_PROFILE_NAME, PROFILE_NAME_REGEX } from "./paths";
import type { Database } from "./sqliteStore";

export const PROFILE_SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  name              TEXT PRIMARY KEY,
  created_at        INTEGER NOT NULL,
  web_password_hash TEXT
) WITHOUT ROWID;
`;

/** A name that is only letters, digits, hyphens and underscores, at most MAX_PROFILE_NAME of them (it names the profile's data/<name>/ folder). */
export const isProfileName = (name: unknown): name is string => typeof name === "string" && PROFILE_NAME_REGEX.test(name);

/** Where each existing table keeps a profile's name. */
const NAME_SOURCES = [
  "SELECT profile AS name FROM credentials",
  "SELECT profile AS name FROM garmin_tokens",
  "SELECT profile AS name FROM activities",
  "SELECT profile AS name FROM wellness",
  "SELECT profile AS name FROM nutrition",
  "SELECT profile AS name FROM renpho_settings",
  "SELECT profile AS name FROM renpho_measurements",
  "SELECT owner AS name FROM documents WHERE owner IS NOT NULL",
  "SELECT substr(path, 6, instr(substr(path, 6), '/') - 1) AS name FROM documents WHERE path LIKE 'data/%/%'",
];

/**
 * Register the profiles an older database already has data for. Runs inside the transaction that creates the schema, and only
 * while the table is empty, so a profile is never brought back and two processes opening the file together cannot both do it.
 */
export function backfillProfiles(db: Database, now = Date.now()): void {
  if (db.prepare("SELECT 1 FROM profiles LIMIT 1").get()) return;
  db.prepare(
    `INSERT OR IGNORE INTO profiles (name, created_at) SELECT DISTINCT name, ? FROM (${NAME_SOURCES.join(" UNION ALL ")}) WHERE name <> '' AND length(name) <= ${MAX_PROFILE_NAME} AND name NOT GLOB '*[^A-Za-z0-9_-]*'`
  ).run(now);
}

const KEY_BYTES = 32;

/** A password as it is kept: `scrypt$<salt>$<key>`, salted, so two equal passwords differ and the database gives none away. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${crypto.scryptSync(password, salt, KEY_BYTES).toString("base64")}`;
}

/** The salt and key of a hash made by hashPassword, or null for anything else (a hash that is damaged matches nothing). */
function parseHash(hash: string): { salt: Buffer; key: Buffer } | null {
  const [scheme, salt, key, extra] = hash.split("$");
  if (scheme !== "scrypt" || !salt || !key || extra !== undefined) return null;
  const parsed = { salt: Buffer.from(salt, "base64"), key: Buffer.from(key, "base64") };
  return parsed.salt.length > 0 && parsed.key.length > 0 ? parsed : null;
}

/** Whether a password is the one a hash was made from. */
export function passwordMatches(password: string, hash: string): boolean {
  const parsed = parseHash(hash);
  if (!parsed) return false;
  try {
    const actual = crypto.scryptSync(password, parsed.salt, parsed.key.length);
    return actual.length === parsed.key.length && crypto.timingSafeEqual(actual, parsed.key);
  } catch {
    return false;
  }
}

const scryptAsync = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/** passwordMatches without holding up the server while scrypt runs: the web sign-in checks passwords with this one. */
export async function passwordMatchesAsync(password: string, hash: string): Promise<boolean> {
  const parsed = parseHash(hash);
  if (!parsed) return false;
  try {
    const actual = await scryptAsync(password, parsed.salt, parsed.key.length);
    return actual.length === parsed.key.length && crypto.timingSafeEqual(actual, parsed.key);
  } catch {
    return false;
  }
}

let decoy: string | undefined;

/**
 * A check against a password nobody has, always false and as slow as a real one. A sign-in with a name that is no profile, or a
 * profile that has no password, takes as long as one with a real password, so the time does not say which names exist.
 */
export async function decoyCheck(password: string): Promise<false> {
  decoy ??= hashPassword(crypto.randomBytes(16).toString("hex"));
  await passwordMatchesAsync(password, decoy);
  return false;
}

export class ProfileTable {
  constructor(private readonly db: Database) {}

  /** Every profile, by name. */
  names(): string[] {
    return this.db.prepare("SELECT name FROM profiles ORDER BY name").all().map((r) => r.name as string);
  }

  has(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM profiles WHERE name = ?").get(name);
  }

  /**
   * Make a profile with its web sign-in password, in one statement, so there is never a moment it exists without one (the password
   * is mandatory). Throws when the name is taken.
   */
  create(name: string, password: string, now = Date.now()): void {
    if (!isProfileName(name)) throw new Error(`Invalid profile name "${name}". Use only letters, numbers, hyphens, and underscores.`);
    this.db.prepare("INSERT INTO profiles (name, created_at, web_password_hash) VALUES (?, ?, ?)").run(name, now, hashPassword(password));
  }

  /** Register a profile; one that exists is left as it is. (One without a web password is not complete: the Settings view asks for it.) */
  add(name: string, now = Date.now()): void {
    if (!isProfileName(name)) throw new Error(`Invalid profile name "${name}". Use only letters, numbers, hyphens, and underscores.`);
    this.db.prepare("INSERT OR IGNORE INTO profiles (name, created_at) VALUES (?, ?)").run(name, now);
  }

  /** The hash of the profile's web sign-in password, or null when it has none. */
  webPasswordHash(name: string): string | null {
    return (this.db.prepare("SELECT web_password_hash FROM profiles WHERE name = ?").get(name)?.web_password_hash as string | null | undefined) ?? null;
  }

  /** The profiles that can sign in to the web editor. */
  withWebPassword(): string[] {
    return this.db.prepare("SELECT name FROM profiles WHERE web_password_hash IS NOT NULL ORDER BY name").all().map((r) => r.name as string);
  }

  /**
   * Set the web sign-in password of a profile; the profile is registered if it is not. The password is mandatory, so the app never
   * passes null (Settings has no way to remove it); null only clears it for tests and repairs.
   */
  setWebPassword(name: string, password: string | null, now = Date.now()): void {
    this.add(name, now);
    this.db.prepare("UPDATE profiles SET web_password_hash = ? WHERE name = ?").run(password === null ? null : hashPassword(password), name);
  }

  checkWebPassword(name: string, password: string): boolean {
    const hash = this.webPasswordHash(name);
    return !!hash && passwordMatches(password, hash);
  }

  /** checkWebPassword off the event loop, and as slow for a profile with no password as for one with (see decoyCheck). */
  async checkWebPasswordAsync(name: string, password: string): Promise<boolean> {
    const hash = this.webPasswordHash(name);
    return hash ? passwordMatchesAsync(password, hash) : decoyCheck(password);
  }
}
