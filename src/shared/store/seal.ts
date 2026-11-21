import * as crypto from "crypto";

const PREFIX = "enc1:";

export class SealKeyError extends Error {}

function key(): Buffer | null {
  const secret = process.env.CREDENTIALS_KEY;
  return secret ? Buffer.from(crypto.hkdfSync("sha256", secret, "garmin-workout-editor", "credentials", 32)) : null;
}

export const sealing = (): boolean => key() !== null;

export const isSealed = (stored: string): boolean => stored.startsWith(PREFIX);

export function seal(plain: string, context: string): string {
  const k = key();
  if (!k) return plain;
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, nonce);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
}

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
