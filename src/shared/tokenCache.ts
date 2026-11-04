import * as fs from "fs";
import * as path from "path";
import { getStore, getStorePath } from "./store";

interface CacheEntry {
  oauth1Token: any;
  oauth2Token: any;
  timestamp: number;
  email: string;
}

/**
 * TokenCache keeps the Garmin session tokens of one profile in the database (the garmin_tokens table, see
 * store/tokens.ts) to avoid repeated authentication and throttling. Nothing is written to a file.
 *
 * Tokens have no age limit of ours: the OAuth1 token lasts about a year and the library trades it for a new access token
 * whenever Garmin refuses the old one, so only Garmin rejecting the session (or the login being changed) ends a cache. A
 * limit of days threw away working sessions and sent the next call to a fresh login, which Garmin throttles with 429.
 *
 * A cache file left by an earlier version (`<profile data dir>/.garmin-token-cache.json`) is taken into the database the
 * first time it is looked at, and deleted once it is safely there, so nobody has to log in again for the move. A file
 * put there by hand later (a login made on another machine) is taken in the same way when it is newer than the database's.
 *
 * The profile is the name of the data directory the cache was made for (data/<profile>).
 */
export class TokenCache {
  private profile: string;
  /** Where an earlier version kept the cache; only read to move it into the database. */
  private legacyFile: string;

  /** The profile this cache belongs to (the name of its data directory). */
  get profileName(): string {
    return this.profile;
  }

  constructor(cacheDir: string = "data") {
    this.profile = path.basename(path.resolve(cacheDir));
    this.legacyFile = path.join(cacheDir, ".garmin-token-cache.json");
  }

  /**
   * The entry in use. A file left by an earlier version (or copied in by hand, see the README's 2FA note) is taken into the
   * database when it is newer than what the database has, and deleted either way, so the file never lingers.
   */
  private entry(): CacheEntry | null {
    const stored = fs.existsSync(getStorePath()) ? getStore().tokens.get(this.profile) : null;
    const row: CacheEntry | null = stored ? { ...(stored.data as Pick<CacheEntry, "oauth1Token" | "oauth2Token">), email: stored.email, timestamp: stored.savedAt } : null;
    const file = this.readLegacyFile();
    if (!file) return row;
    if (row && !(file.timestamp > row.timestamp)) {
      fs.rmSync(this.legacyFile, { force: true }); // the database already has a newer login
      return row;
    }
    getStore().tokens.put(this.profile, file.email, { oauth1Token: file.oauth1Token, oauth2Token: file.oauth2Token }, file.timestamp);
    fs.rmSync(this.legacyFile, { force: true }); // only after the row is in; the other process may have removed it already
    console.log("✓ Token cache moved into the database");
    return file;
  }

  /** The cache file of an earlier version, when there is one that can be read. */
  private readLegacyFile(): CacheEntry | null {
    if (!fs.existsSync(this.legacyFile)) return null;
    try {
      const entry = JSON.parse(fs.readFileSync(this.legacyFile, "utf-8")) as CacheEntry;
      return entry && typeof entry.email === "string" && Number.isFinite(entry.timestamp) ? entry : null;
    } catch {
      return null; // not a cache we can read; it is left alone
    }
  }

  /**
   * Save session cookies to cache
   */
  saveToken(email: string, oauth1Token: any, oauth2Token: any): void {
    try {
      getStore().tokens.put(this.profile, email, { oauth1Token, oauth2Token });
      fs.rmSync(this.legacyFile, { force: true }); // the database has the fresh one
      console.log(
        `💾 Token cache saved for ${email}`
      );
    } catch (error: any) {
      console.warn(`⚠️ Failed to save token cache: ${error.message}`);
    }
  }

  /**
   * Load session cookies from cache
   */
  loadToken(email: string): { oauth1Token: any; oauth2Token: any } | null {
    try {
      const entry = this.entry();
      if (!entry) {
        return null;
      }

      // Verify the email matches
      if (entry.email !== email) {
        console.log(
          `ℹ️ Token cache is for different email (${entry.email}), skipping`
        );
        return null;
      }

      const days = Math.floor((Date.now() - entry.timestamp) / (24 * 60 * 60 * 1000));
      console.log(`✓ Loaded cached token for ${email} (saved ${days} day${days !== 1 ? "s" : ""} ago)`);

      return { oauth1Token: entry.oauth1Token, oauth2Token: entry.oauth2Token };
    } catch (error: any) {
      console.warn(`⚠️ Failed to load token cache: ${error.message}`);
      return null;
    }
  }

  /**
   * Clear token cache
   */
  clearToken(): void {
    try {
      let cleared = false;
      if (fs.existsSync(getStorePath())) {
        getStore().tokens.delete(this.profile);
        cleared = true;
      }
      if (fs.existsSync(this.legacyFile)) {
        fs.rmSync(this.legacyFile, { force: true });
        cleared = true;
      }
      if (cleared) console.log("✓ Token cache cleared");
    } catch (error: any) {
      console.warn(`⚠️ Failed to clear token cache: ${error.message}`);
    }
  }

  /**
   * Check if token cache exists and is valid
   */
  hasCachedToken(email: string): boolean {
    try {
      const entry = this.entry();
      return !!entry && entry.email === email;
    } catch {
      return false;
    }
  }
}

export default TokenCache;
