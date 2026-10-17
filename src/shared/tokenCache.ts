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
  private readonly CACHE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor(cacheDir: string = "data") {
    this.profile = path.basename(path.resolve(cacheDir));
    this.legacyFile = path.join(cacheDir, ".garmin-token-cache.json");
  }

  /**
   * The entry in use. A file left by an earlier version (or copied in by hand, see the README's 2FA note) is taken into the
   * database when it is newer than what the database has, and deleted either way, so the file never lingers.
   */
  private entry(): CacheEntry | null {
    const row = fs.existsSync(getStorePath()) ? (getStore().tokens.get(this.profile)?.data as CacheEntry | undefined) ?? null : null;
    const file = this.readLegacyFile();
    if (!file) return row;
    if (row && !(file.timestamp > row.timestamp)) {
      fs.rmSync(this.legacyFile, { force: true }); // the database already has a newer login
      return row;
    }
    getStore().tokens.put(this.profile, file.email, file, file.timestamp);
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
    const entry: CacheEntry = {
      oauth1Token,
      oauth2Token,
      timestamp: Date.now(),
      email,
    };

    try {
      getStore().tokens.put(this.profile, email, entry, entry.timestamp);
      fs.rmSync(this.legacyFile, { force: true }); // the database has the fresh one
      console.log(
        `💾 Token cache saved for ${email} (expires in 7 days)`
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

      // Verify email matches and cache is not expired
      if (entry.email !== email) {
        console.log(
          `ℹ️ Token cache is for different email (${entry.email}), skipping`
        );
        return null;
      }

      const age = Date.now() - entry.timestamp;
      if (age > this.CACHE_DURATION_MS) {
        console.log("ℹ️ Token cache expired (7 days old), will re-authenticate");
        this.clearToken();
        return null;
      }

      const daysRemaining = Math.floor(
        (this.CACHE_DURATION_MS - age) / (24 * 60 * 60 * 1000)
      );
      console.log(
        `✓ Loaded cached token for ${email} (expires in ${daysRemaining} day${daysRemaining !== 1 ? "s" : ""})`
      );

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
      if (!entry || entry.email !== email) {
        return false;
      }
      return Date.now() - entry.timestamp <= this.CACHE_DURATION_MS;
    } catch {
      return false;
    }
  }
}

export default TokenCache;
