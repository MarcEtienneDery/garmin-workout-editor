import * as fs from "fs";
import * as path from "path";

interface CacheEntry {
  oauth1Token: any;
  oauth2Token: any;
  timestamp: number;
  email: string;
}

/**
 * TokenCache manages persistent storage and retrieval of Garmin session tokens/cookies
 * to avoid repeated authentication and throttling.
 */
export class TokenCache {
  private cacheDir: string;
  private cacheFile: string;
  private readonly CACHE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor(cacheDir: string = "data") {
    this.cacheDir = cacheDir;
    this.cacheFile = path.join(this.cacheDir, ".garmin-token-cache.json");
    this.ensureCacheDir();
  }

  /**
   * Ensure cache directory exists
   */
  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
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
      fs.writeFileSync(this.cacheFile, JSON.stringify(entry, null, 2), "utf-8");
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
      if (!fs.existsSync(this.cacheFile)) {
        return null;
      }

      const content = fs.readFileSync(this.cacheFile, "utf-8");
      const entry: CacheEntry = JSON.parse(content);

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
      if (fs.existsSync(this.cacheFile)) {
        fs.unlinkSync(this.cacheFile);
        console.log("✓ Token cache cleared");
      }
    } catch (error: any) {
      console.warn(`⚠️ Failed to clear token cache: ${error.message}`);
    }
  }

  /**
   * Check if token cache exists and is valid
   */
  hasCachedToken(email: string): boolean {
    try {
      if (!fs.existsSync(this.cacheFile)) {
        return false;
      }

      const content = fs.readFileSync(this.cacheFile, "utf-8");
      const entry: CacheEntry = JSON.parse(content);

      if (entry.email !== email) {
        return false;
      }

      const age = Date.now() - entry.timestamp;
      return age <= this.CACHE_DURATION_MS;
    } catch {
      return false;
    }
  }
}

export default TokenCache;
