/**
 * seal.ts — encryption at rest for the secrets in the database (the passwords of `credentials`).
 *
 * AES-256-GCM under a key made from the CREDENTIALS_KEY environment variable, which lives with the deployment (the
 * compose file) and not in the database, so a copy of the database file, a backup of it, gives no password. Each value
 * has its own random nonce and is bound to its row (profile and service), so one cannot be moved to another row.
 * It does not protect against someone who can read the running containers' environment: the app has to decrypt to log in.
 *
 * Without the key nothing is encrypted (the value is kept as given), and a value saved that way is encrypted the first
 * time it is read once a key is set. A sealed value without the right key is an error that says so, never an empty answer.
 */
import * as crypto from "crypto";

const PREFIX = "enc1:";

/** A sealed value that cannot be opened: the key is missing or is not the one it was sealed with. */
export class SealKeyError extends Error {}

function key(): Buffer | null {
  const secret = process.env.CREDENTIALS_KEY;
  return secret ? Buffer.from(crypto.hkdfSync("sha256", secret, "garmin-workout-editor", "credentials", 32)) : null;
}

/** Whether new secrets are encrypted. */
export const sealing = (): boolean => key() !== null;

export const isSealed = (stored: string): boolean => stored.startsWith(PREFIX);

/** The value as it is stored: encrypted when there is a key. `context` ties it to its row. */
export function seal(plain: string, context: string): string {
  const k = key();
  if (!k) return plain;
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, nonce);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
}

/** The value a stored one holds. A stored value that is not sealed is returned as it is. */
export function open(stored: string, context: string): string {
  if (!isSealed(stored)) return stored;
  const k = key();
  if (!k) throw new SealKeyError("A saved password is encrypted, but CREDENTIALS_KEY is not set.");
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new SealKeyError("A saved password could not be decrypted: CREDENTIALS_KEY is not the key it was saved with.");
  }
}
