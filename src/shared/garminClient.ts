import { GarminConnect } from "@flow-js/garmin-connect";
import TokenCache from "./tokenCache";

/**
 * Shared Garmin client initialization and authentication
 */
export class GarminClient {
  private email: string;
  private password: string;
  private client: GarminConnect;
  private mockMode: boolean;
  private tokenCache: TokenCache;

  constructor(email: string, password: string, mockMode: boolean = false) {
    this.email = email;
    this.password = password;
    this.mockMode = mockMode;
    this.tokenCache = new TokenCache();
    this.client = new GarminConnect({
      username: email,
      password: password,
    });
  }

  /**
   * Get the underlying Garmin client (for internal use)
   */
  getClient(): GarminConnect {
    return this.client;
  }

  /**
   * Get the underlying client as any type (for accessing non-typed methods)
   */
  getClientAny(): any {
    return this.client as any;
  }

  /**
   * Check if in mock mode
   */
  isMockMode(): boolean {
    return this.mockMode;
  }

  /**
   * Authenticate with Garmin Connect
   */
  async authenticate(): Promise<boolean> {
    if (this.mockMode) {
      console.log("🔓 Mock mode: Skipping authentication");
      return true;
    }

    try {
      // Try to restore from cache first
      const cached = this.tokenCache.loadToken(this.email);
      if (cached) {
        try {
          // Restore OAuth tokens directly into the client
          (this.client as any).loadToken(cached.oauth1Token, cached.oauth2Token);

          // Verify the session is still valid
          const userProfile = await this.client.getUserProfile();
          console.log(
            `✅ Authenticated with cached token as: ${userProfile.userName}`
          );
          return true;
        } catch (error: any) {
          console.log(
            `ℹ️ Cached token invalid or expired: ${error.message}`
          );
          // Fall through to fresh login
        }
      }

      // Perform fresh login
      console.log("🔐 Authenticating with Garmin Connect (fresh login)...");
      await this.client.login();

      // Verify authentication by getting user profile
      const userProfile = await this.client.getUserProfile();
      console.log(`✅ Successfully authenticated as: ${userProfile.userName}`);

      // Save OAuth tokens to cache using the library's public exportToken() API
      try {
        const { oauth1, oauth2 } = (this.client as any).exportToken();
        this.tokenCache.saveToken(this.email, oauth1, oauth2);
      } catch {
        console.warn("⚠️ Warning: OAuth tokens not available for caching");
      }

      return true;
    } catch (error: any) {
      console.error("❌ Authentication error:", error.message);
      // Clear cache on authentication failure
      this.tokenCache.clearToken();
      return false;
    }
  }

  /**
   * Ensure authenticated (with mock mode support)
   */
  async ensureAuthenticated(): Promise<boolean> {
    if (this.mockMode) {
      console.log("🔓 Mock mode: Skipping authentication");
      return true;
    }

    return this.authenticate();
  }

  /**
   * Fetch per-set exercise data for a strength activity.
   * Uses the undocumented exerciseSets endpoint not exposed by the garmin-connect library.
   */
  async getActivityExerciseSets(activityId: number | string): Promise<any[]> {
    const raw = await (this.client as any).client.get(
      `https://connectapi.garmin.com/activity-service/activity/${activityId}/exerciseSets`
    );
    return raw?.exerciseSets ?? [];
  }

  /**
   * Clear the stored authentication token cache
   * Useful if you want to force a fresh login on next authentication
   */
  clearCache(): void {
    this.tokenCache.clearToken();
  }
}

export default GarminClient;
