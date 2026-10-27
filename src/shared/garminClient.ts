import { GarminConnect } from "@flow-js/garmin-connect";
import TokenCache from "./tokenCache";

/** Single exercise entry within a raw Garmin set (top-ranked classification) */
export interface GarminExerciseEntry {
  category: string;
  name: string | null;
  probability?: number;
}

/** Raw exercise set row from /activity-service/activity/{id}/exerciseSets */
export interface GarminRawSet {
  setType: string;                    // "ACTIVE" | "REST" | "WARMUP" | etc.
  exercises: GarminExerciseEntry[];
  duration: number;
  repetitionCount: number | null;
  weight: number | null;
  startTime: string;
  wktStepIndex: number;
  messageIndex: number;
}

/** How long a fresh login is not tried again after Garmin answered one with HTTP 429. */
export const LOGIN_COOLDOWN_MS = 60_000;

/** The HTTP status in a Garmin client error ("ERROR: (429), Too Many Requests, ..."), when it has one. */
const httpStatus = (error: any): number | null => {
  const status = error?.response?.status ?? /\((\d{3})\)/.exec(String(error?.message ?? ""))?.[1];
  return status ? Number(status) : null;
};

const RATE_LIMITED = "Failed to authenticate with Garmin: it is rate limiting logins (HTTP 429, Too Many Requests)";

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * A failure that says nothing about the session or the credentials: Garmin throttling us, Garmin down, or no network.
 * The cached token is kept for these, and a fresh login (which would hit the same wall) is not tried.
 */
const isTransient = (error: any): boolean => {
  const status = httpStatus(error);
  return status === 429 || (status !== null && status >= 500) || NETWORK_CODES.has(error?.code);
};

/**
 * Shared Garmin client initialization and authentication
 */
export class GarminClient {
  private email: string;
  private password: string;
  private client: GarminConnect;
  private mockMode: boolean;
  private tokenCache: TokenCache;
  /** Why the last authenticate() failed, so callers can tell a throttled login from bad credentials. */
  private lastAuthFailure: string | null = null;
  /** No fresh login before this time (ms since epoch): Garmin answered the last one with 429. */
  private loginBlockedUntil = 0;

  constructor(email: string, password: string, mockMode: boolean = false, dataDir?: string) {
    this.email = email;
    this.password = password;
    this.mockMode = mockMode;
    this.tokenCache = new TokenCache(dataDir || "data");
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

    this.lastAuthFailure = null;
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
          if (isTransient(error)) {
            // Throttled or unreachable says nothing about the token: keep it, and do not log in again on top of it.
            console.log(`ℹ️ Could not check the cached token, keeping it: ${error.message}`);
            return this.failAuth(error);
          }
          console.log(
            `ℹ️ Cached token invalid or expired: ${error.message}`
          );
          // Fall through to fresh login
        }
      }

      // Perform fresh login, unless Garmin has just turned one away
      const wait = this.loginBlockedUntil - Date.now();
      if (wait > 0) {
        const seconds = Math.ceil(wait / 1000);
        console.log(`⏳ Garmin is rate limiting logins: not trying again for ${seconds}s`);
        this.lastAuthFailure = `${RATE_LIMITED}; try again in ${seconds} seconds.`;
        return false;
      }
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
      if (httpStatus(error) === 429) this.loginBlockedUntil = Date.now() + LOGIN_COOLDOWN_MS;
      // Clear the cache only when the session itself was refused, not when Garmin is throttling or unreachable
      if (!isTransient(error)) this.tokenCache.clearToken();
      return this.failAuth(error);
    }
  }

  /** Record why authenticate() failed and return false. */
  private failAuth(error: any): false {
    this.lastAuthFailure = httpStatus(error) === 429 ? `${RATE_LIMITED}; wait a few minutes and try again.` : null;
    return false;
  }

  /** The error to throw when ensureAuthenticated() said no: names a rate limit, so nobody goes hunting for bad credentials. */
  authError(): Error {
    return new Error(this.lastAuthFailure ?? "Failed to authenticate with Garmin (check the profile credentials; 2FA accounts need a cached token).");
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
  async getActivityExerciseSets(activityId: number | string): Promise<GarminRawSet[]> {
    const raw = await (this.client as any).client.get(
      `https://connectapi.garmin.com/activity-service/activity/${activityId}/exerciseSets`
    ) as { exerciseSets?: GarminRawSet[] } | undefined;
    return raw?.exerciseSets ?? [];
  }

  /**
   * The time series and the route of an activity, thinned by Garmin to at most `size` samples.
   * Undocumented endpoint, like exerciseSets; read-only.
   */
  async getActivityDetails(activityId: number | string, size = 300): Promise<any> {
    return (this.client as any).client.get(
      `https://connectapi.garmin.com/activity-service/activity/${activityId}/details?maxChartSize=${size}&maxPolylineSize=${size}`
    );
  }

  /** The laps the watch recorded for an activity. */
  async getActivitySplits(activityId: number | string): Promise<any> {
    return (this.client as any).client.get(`https://connectapi.garmin.com/activity-service/activity/${activityId}/splits`);
  }

  /** Seconds in each heart-rate zone, with each zone's lower bound. */
  async getActivityHrZones(activityId: number | string): Promise<any> {
    return (this.client as any).client.get(`https://connectapi.garmin.com/activity-service/activity/${activityId}/hrTimeInZones`);
  }

  /**
   * Send workouts to a connected device.
   * Uses the undocumented device-message endpoint that the Garmin Connect UI uses for "Send to Device".
   */
  async sendToDevice(
    deviceId: number,
    workouts: { workoutId: number; workoutName: string }[]
  ): Promise<void> {
    const messages = workouts.map((w) => ({
      deviceId,
      messageUrl: `workout-service/workout/FIT/${w.workoutId}`,
      messageType: "workouts",
      messageName: w.workoutName,
      groupName: null,
      priority: 1,
      fileType: "FIT",
      metaDataId: w.workoutId,
    }));

    await (this.client as any).client.post(
      "https://connectapi.garmin.com/device-service/devicemessage/messages",
      messages
    );
  }

  /**
   * Get the user's registered devices.
   */
  async getDevices(): Promise<any[]> {
    return (this.client as any).client.get(
      "https://connectapi.garmin.com/device-service/deviceregistration/devices"
    );
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
