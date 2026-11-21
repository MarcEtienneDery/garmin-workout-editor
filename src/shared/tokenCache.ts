import * as fs from "fs";
import * as path from "path";
import { getStore, getStorePath } from "./store";

interface CacheEntry {
  oauth1Token: any;
  oauth2Token: any;
  timestamp: number;
  email: string;
}

export class TokenCache {
  private profile: string;
  private legacyFile: string;

  get profileName(): string {
    return this.profile;
  }

  constructor(cacheDir: string = "data") {
    this.profile = path.basename(path.resolve(cacheDir));
    this.legacyFile = path.join(cacheDir, ".garmin-token-cache.json");
  }

  private entry(): CacheEntry | null {
    const stored = fs.existsSync(getStorePath()) ? getStore().tokens.get(this.profile) : null;
    const row: CacheEntry | null = stored ? { ...(stored.data as Pick<CacheEntry, "oauth1Token" | "oauth2Token">), email: stored.email, timestamp: stored.savedAt } : null;
    const file = this.readLegacyFile();
    if (!file) return row;
    if (row && !(file.timestamp > row.timestamp)) {
      fs.rmSync(this.legacyFile, { force: true });
      return row;
    }
    getStore().tokens.put(this.profile, file.email, { oauth1Token: file.oauth1Token, oauth2Token: file.oauth2Token }, file.timestamp);
    fs.rmSync(this.legacyFile, { force: true });
    console.log("✓ Token cache moved into the database");
    return file;
  }

  private readLegacyFile(): CacheEntry | null {
    if (!fs.existsSync(this.legacyFile)) return null;
    try {
      const entry = JSON.parse(fs.readFileSync(this.legacyFile, "utf-8")) as CacheEntry;
      return entry && typeof entry.email === "string" && Number.isFinite(entry.timestamp) ? entry : null;
    } catch {
      return null;
    }
  }

  saveToken(email: string, oauth1Token: any, oauth2Token: any): void {
    try {
      getStore().tokens.put(this.profile, email, { oauth1Token, oauth2Token });
      fs.rmSync(this.legacyFile, { force: true });
      console.log(
        `💾 Token cache saved for ${email}`
      );
    } catch (error: any) {
      console.warn(`⚠️ Failed to save token cache: ${error.message}`);
    }
  }

  loadToken(email: string): { oauth1Token: any; oauth2Token: any } | null {
    try {
      const entry = this.entry();
      if (!entry) {
        return null;
      }

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
